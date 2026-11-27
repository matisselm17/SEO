/**
 * MODE DÉMONSTRATION — développement uniquement (VITE_DEMO=1 avec `vite`).
 * Faux serveur qui répond aux routes de docs/format-echange.md avec des Response réelles,
 * y compris les flux SSE (analyse en cours, réponse de l'assistant).
 * Ce module n'est jamais inclus dans le build de production (voir lib/transport.ts).
 *
 * Il suit la règle « Quelle analyse est affichée » : les résultats (`results`) sont ceux de la dernière
 * analyse terminée ; à défaut, de la plus récente qui a au moins une page notée. Une relance ne les remplace
 * qu'à sa fin.
 *
 * Scénarios, choisis avec ?demo=… dans l'adresse (mémorisé pour l'onglet) : voir web/README.md.
 * Boutique Shopify (site Atelier Lune) : voir src/demo/shopify.ts, état choisi avec ?boutique=….
 * Saisies spéciales :
 *   - ajout d'un site : « injoignable » → site_unreachable, « plafond » → limit_reached, « rafale » → rate_limited ;
 *   - assistant : « clé » → clé refusée (erreur définitive), « panne » → échec avant toute réponse,
 *     « limite » → rate_limited avec délai.
 */
import examples from "../../../docs/exemples/exemples.json";
import type {
  ApiError, AuditStatus, ChatMessage, CompetitorsData, Coverage, CoverageRow, ErrorCode, FailedPage, IssueDetail, Overview, PageType,
  SearchConsoleData, Settings, SiteEvent, SiteSummary,
} from "../lib/types";
import {
  LUNE, LUNE_CATALOGUE, LUNE_QUERIES, ORLUX, attachOrganic, buildCompetitors, buildPages, buildSearchConsole, catalogueIssuesOf, categoriesOf,
  issuesOf, mergeIssues, pageTypeOf, recommendationsOf, siteScore, strengthsOf, toIssue, type DemoPage, type SiteProfile,
} from "./data";
import { handleShopify, resourceIdForPath, shopifyConfigured, shopifyWritesEnabled, type ShopCtx } from "./shopify";

type Scenario =
  | "complet" | "vide" | "sans-gsc" | "sans-config" | "analyse" | "analyse-figee" | "relance" | "relance-figee"
  | "echec" | "coupure" | "erreurs" | "lent" | "liens" | "couverture-complete" | "catalogue-indispo" | "inventaire";
const SCENARIOS: Scenario[] = ["complet", "vide", "sans-gsc", "sans-config", "analyse", "analyse-figee", "relance", "relance-figee", "echec", "coupure", "erreurs", "lent", "liens", "couverture-complete", "catalogue-indispo", "inventaire"];

function readScenario(): Scenario {
  const fromUrl = new URLSearchParams(location.search).get("demo") as Scenario | null;
  if (fromUrl && SCENARIOS.includes(fromUrl)) {
    sessionStorage.setItem("demo-scenario", fromUrl);
    return fromUrl;
  }
  const saved = sessionStorage.getItem("demo-scenario") as Scenario | null;
  return saved && SCENARIOS.includes(saved) ? saved : "complet";
}
const scenario = readScenario();
export const demoScenario = scenario;

const ex = examples as unknown as Record<string, unknown>;
const exSettings = ex["GET /api/settings"] as Settings;
const exChat = ex["GET /api/sites/site_8fk2/chat"] as { messages: ChatMessage[]; suggestions: string[] };
const exFailed = (ex["GET /api/sites/site_8fk2/failed-pages"] as { pages: FailedPage[] }).pages;

const settings: Settings = {
  ...exSettings,
  integrations: {
    chat: scenario === "sans-config" ? { configured: false, model: null } : exSettings.integrations.chat,
    competitors: { configured: scenario !== "sans-config" },
    shopify: { configured: shopifyConfigured, writesEnabled: shopifyWritesEnabled },
  },
};

// ───────── État en mémoire

/** Une analyse : son état, ses pages notées et ses pages non chargées. */
interface Run {
  audit: AuditStatus;
  pages: DemoPage[];
  failed: FailedPage[];
}

interface DemoSite {
  summary: SiteSummary;
  profile: SiteProfile;
  /** Pages trouvées en suivant les liens (analyse de base). */
  truth: DemoPage[];
  /** Inventaire du sitemap (langue principale) : toutes les pages du site, ouvertes ou non. */
  inventory: DemoPage[];
  inventoryMode: "sitemap" | "links";
  platform: "shopify" | null;
  /** Le catalogue public de la boutique répond-il ? (scénario « catalogue-indispo » : non) */
  catalogueOk: boolean;
  otherLocales: string[];
  /** Analyse dont les résultats sont affichés (SiteSummary.results). */
  shown: Run | null;
  /** Dernière analyse lancée (SiteSummary.audit). */
  current: Run | null;
  previousScore: number | null;
  gsc: Extract<SearchConsoleData, { available: true }> | null;
  competitors: CompetitorsData;
  chat: ChatMessage[];
  timer: ReturnType<typeof setInterval> | null;
  listeners: Set<(e: SiteEvent) => void>;
}

const sites: DemoSite[] = [];
let seq = 100;
const nextId = (p: string) => `${p}_${(seq++).toString(36)}`;

/** Parcours équilibré dans l'inventaire : l'accueil, puis les types à tour de rôle. */
function balanced(pool: DemoPage[], max: number): DemoPage[] {
  const order: PageType[] = ["home", "product", "collection", "article", "blog", "page", "policy", "other"];
  const byType = order.map((t) => pool.filter((p) => p.summary.pageType === t));
  const out: DemoPage[] = [];
  for (let k = 0; out.length < Math.min(max, pool.length); k++) {
    for (const list of byType) if (list[k] && out.length < max) out.push(list[k]);
  }
  return out;
}

function failedPage(host: string, path: string, httpStatus: number | null, reason: string): FailedPage {
  return { url: `https://${host}${path}`, path, httpStatus, reason };
}

/** Recalcule le résumé du site selon la règle « Quelle analyse est affichée ». */
function sync(site: DemoSite) {
  const cur = site.current;
  if (cur) {
    if (cur.audit.state === "done") {
      if (site.shown && site.shown !== cur && site.shown.audit.state === "done") site.previousScore = siteScore(site.shown.pages);
      site.shown = cur;
    } else if ((!site.shown || site.shown.audit.state !== "done") && cur.pages.length > 0) {
      site.shown = cur;
    }
  }
  const sh = site.shown;
  site.summary = {
    ...site.summary,
    audit: cur ? { ...cur.audit } : null,
    results: sh ? { auditId: sh.audit.id, state: sh.audit.state, finishedAt: sh.audit.finishedAt, pagesDone: sh.audit.pagesDone, pagesFailed: sh.audit.pagesFailed } : null,
    score: sh ? siteScore(sh.pages) : null,
    pagesAnalyzed: sh ? sh.pages.length : 0,
  };
}

function doneRun(truth: DemoPage[], end: string, failed: FailedPage[]): Run {
  return {
    audit: {
      id: nextId("aud"), state: "done", startedAt: new Date(new Date(end).getTime() - 102000).toISOString(), finishedAt: end,
      maxPages: Math.max(100, truth.length), pagesDone: truth.length, pagesFailed: failed.length, pagesQueued: 0, currentUrl: null, error: null,
    },
    pages: truth,
    failed,
  };
}

function makeSite(id: string, name: string, profile: SiteProfile, createdAt: string, opts: {
  gsc: boolean; auditEnd: string; previous: number | null; competitors: CompetitorsData; chat: ChatMessage[]; limit?: number; failed?: FailedPage[];
  extra?: SiteProfile["paths"]; inventoryMode?: "sitemap" | "links"; platform?: "shopify" | null; otherLocales?: string[]; catalogueOk?: boolean;
}): DemoSite {
  const all = buildPages({ ...profile, paths: [...profile.paths, ...(opts.extra ?? [])] }, opts.auditEnd);
  const base = all.slice(0, Math.min(opts.limit ?? Infinity, profile.paths.length));
  const inventory = opts.limit ? base : all;
  // Une analyse ouvre au plus maxPagesLimits.max pages, choisies type par type.
  const truth = base.length > settings.maxPagesLimits.max ? balanced(inventory, settings.maxPagesLimits.max) : base;
  const gsc = opts.gsc
    ? buildSearchConsole(truth, profile.seed + 1, "2026-11-26T14:05:00.000Z", {
        queries: LUNE_QUERIES, host: profile.host, clicksPerDay: 20,
        extraPages: [{ path: "/blog/emaillage", clicks: 12, impressions: 900, position: 22.5 }, { path: "/ancienne-collection", clicks: 3, impressions: 410, position: 31.2 }],
      })
    : null;
  attachOrganic(truth, gsc);
  const failed = opts.failed ?? exFailed.map((f) => ({ ...f, url: f.url.replace("atelier-lune.example", profile.host) }));
  const run = doneRun(truth, opts.auditEnd, failed);
  const site: DemoSite = {
    summary: {
      id, url: `https://${profile.host}/`, host: profile.host, name, createdAt, audit: null, results: null, score: null, pagesAnalyzed: 0,
      searchConsole: { available: !!gsc, importedAt: gsc?.importedAt ?? null },
    },
    profile, truth, inventory, inventoryMode: opts.inventoryMode ?? "sitemap", platform: opts.platform === undefined ? "shopify" : opts.platform,
    catalogueOk: opts.catalogueOk ?? true, otherLocales: opts.otherLocales ?? [],
    shown: run, current: run, previousScore: opts.previous, gsc, competitors: opts.competitors, chat: opts.chat, timer: null, listeners: new Set(),
  };
  sync(site);
  return site;
}

if (scenario !== "vide") {
  const competitorsLune: CompetitorsData = scenario === "sans-config" ? { available: false, reason: "not_configured" } : buildCompetitors(LUNE.host);
  sites.push(
    // Couverture partielle : 42 pages ouvertes en entier, les autres produits lus dans le catalogue, version anglaise signalée,
    // « Analyser les N pages » proposé (inventaire sous le plafond).
    // « liens » : pas de sitemap, inventaire inconnu. « couverture-complete » : tout est ouvert, une page non chargée.
    // « catalogue-indispo » : boutique dont le catalogue ne répond pas.
    makeSite("site_8fk2", "Atelier Lune", LUNE, "2026-11-20T09:12:00.000Z", {
      gsc: scenario !== "sans-gsc", auditEnd: "2026-11-26T14:01:42.000Z", previous: 61, competitors: competitorsLune,
      chat: scenario === "sans-gsc" || scenario === "sans-config" ? [] : exChat.messages,
      extra: scenario === "liens" || scenario === "couverture-complete" ? [] : LUNE_CATALOGUE,
      inventoryMode: scenario === "liens" ? "links" : "sitemap",
      platform: scenario === "liens" ? null : "shopify",
      otherLocales: scenario === "liens" ? [] : ["en"],
      catalogueOk: scenario !== "catalogue-indispo",
    }),
    makeSite("site_orlx", "Maison Orlux", ORLUX, "2026-11-12T10:30:00.000Z", {
      gsc: false, auditEnd: "2026-11-24T09:40:00.000Z", previous: null,
      competitors: scenario === "sans-config" ? { available: false, reason: "not_configured" } : { available: false, reason: "not_run" }, chat: [],
    }),
  );
}

if (scenario === "echec") {
  // 1. Première analyse en échec : aucune page notée, results null.
  const sable: SiteProfile = { ...LUNE, host: "boutique-sable.example", seed: 31 };
  const s1 = makeSite("site_sabl", "boutique-sable.example", sable, "2026-11-26T08:00:00.000Z", { gsc: false, auditEnd: "2026-11-26T08:01:00.000Z", previous: null, competitors: { available: false, reason: "no_audit" }, chat: [] });
  s1.shown = null;
  s1.current = {
    audit: {
      id: nextId("aud"), state: "failed", startedAt: "2026-11-26T15:20:00.000Z", finishedAt: "2026-11-26T15:20:09.000Z", maxPages: 100,
      pagesDone: 0, pagesFailed: 1, pagesQueued: 0, currentUrl: null,
      error: { code: "site_unreachable", message: "Le site n'a pas pu être chargé : connexion impossible.", action: "Vérifiez que le site est en ligne et accessible, puis relancez l'analyse." },
    },
    pages: [],
    failed: [failedPage(sable.host, "/", null, "Connexion impossible : le serveur du site ne répond pas.")],
  };
  sync(s1);
  sites.unshift(s1);

  // 2. Relance interrompue par un redémarrage du serveur : les résultats précédents restent affichés.
  const lune = sites.find((s) => s.summary.id === "site_8fk2")!;
  lune.current = {
    audit: {
      id: nextId("aud"), state: "failed", startedAt: "2026-11-26T15:02:00.000Z", finishedAt: "2026-11-26T15:02:40.000Z", maxPages: 100,
      pagesDone: 12, pagesFailed: 0, pagesQueued: 0, currentUrl: null,
      error: { code: "internal", message: "L'analyse a été interrompue par un redémarrage du serveur.", action: "Relancez l'analyse. Les résultats précédents restent affichés en attendant." },
    },
    pages: lune.truth.slice(0, 12),
    failed: [],
  };
  sync(lune);

  // 3. Plus de pages en échec que de pages notées : note peu fiable.
  const orlux = sites.find((s) => s.summary.id === "site_orlx")!;
  const orluxFailed = [
    ["/collections/bagues", 403, "Accès refusé par le site (403)"],
    ["/collections/colliers", 403, "Accès refusé par le site (403)"],
    ["/collections/bracelets", 403, "Accès refusé par le site (403)"],
    ["/collections/boucles-d-oreilles", 403, "Accès refusé par le site (403)"],
    ["/collections/piercings", 503, "Le site est temporairement indisponible (503)"],
    ["/collections/chevilleres", 503, "Le site est temporairement indisponible (503)"],
    ["/pages/livraison", 404, "Page introuvable (404)"],
    ["/pages/guide-des-tailles-bagues-et-bracelets-en-or-18-carats-et-argent-925", null, "Délai dépassé : la page n'a pas répondu en 15 secondes"],
    ["/blogs/journal", 500, "Erreur du serveur du site (500)"],
  ] as const;
  const keep = orlux.truth.slice(0, 4);
  const run = doneRun(keep, "2026-11-24T09:40:00.000Z", orluxFailed.map(([p, st, r]) => failedPage(ORLUX.host, p, st, r)));
  orlux.truth = keep;
  orlux.shown = run;
  orlux.current = run;
  sync(orlux);
}

// ───────── Réponses

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// Scénario « lent » : la liste des sites arrive, les écrans restent en chargement (skeletons).
const latency = (path: string) => (scenario === "lent" && path !== "/sites" && path !== "/settings" ? 600_000 : 120 + Math.random() * 220);

function json(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function apiError(status: number, code: ErrorCode, message: string, action: string | null, details?: ApiError["error"]["details"]): Response {
  return json({ error: { code, message, action, ...(details ? { details } : {}) } } satisfies ApiError, status);
}
const notFound = () => apiError(404, "not_found", "Cette ressource n'existe pas ou a été supprimée.", "Revenez à la liste de vos sites.");

// Scénario « erreurs » : toute lecture échoue pendant les 2 premières secondes après le chargement
// (couvre les relances automatiques au montage des écrans) ; une relance manuelle ensuite réussit.
const loadedAt = Date.now();
function maybeFail(): Response | null {
  if (scenario !== "erreurs" || Date.now() - loadedAt > 2000) return null;
  return apiError(500, "internal", "Le serveur n'a pas pu lire les résultats de l'analyse.", "Réessayez dans un instant.");
}

// ───────── Calculs

function shownPages(site: DemoSite): DemoPage[] {
  return site.shown?.pages ?? [];
}

const TYPE_ORDER: PageType[] = ["home", "product", "collection", "article", "blog", "page", "policy", "other"];
const TYPE_LABEL: Record<PageType, string> = {
  home: "Accueil", product: "Produits", collection: "Collections", article: "Articles de blog", blog: "Blog",
  page: "Pages", policy: "Politiques et mentions", other: "Autres",
};

/** Produits de l'inventaire dont la page n'a pas été ouverte : lus dans le catalogue (boutique Shopify). */
function catalogueProducts(site: DemoSite): DemoPage[] {
  if (site.platform !== "shopify" || site.inventoryMode !== "sitemap" || !site.catalogueOk || !site.shown) return [];
  const opened = new Set(site.shown.pages.map((p) => p.summary.id));
  return site.inventory.filter((p) => p.summary.pageType === "product" && !opened.has(p.summary.id));
}

function coverageOf(site: DemoSite): Coverage | null {
  const run = site.shown;
  if (!run || !run.pages.length) return null;
  const links = site.inventoryMode === "links";
  const catalogue = catalogueProducts(site);
  const rows: CoverageRow[] = [];
  for (const type of TYPE_ORDER) {
    const onSite = links ? null : site.inventory.filter((p) => p.summary.pageType === type).length;
    const opened = run.pages.filter((p) => p.summary.pageType === type);
    const failed = run.failed.filter((f) => pageTypeOf(f.path) === type).length;
    const via = catalogue.filter((p) => p.summary.pageType === type).length;
    if (!opened.length && !via && !failed && !onSite) continue;
    rows.push({ type, label: TYPE_LABEL[type], onSite, analyzed: opened.length, viaCatalogue: via, failed, score: siteScore(opened) });
  }
  const analyzed = run.pages.length;
  const onSite = links ? null : site.inventory.length;
  // Complet : toutes les pages inventoriées ont été tentées (ouvertes ou non chargées).
  const complete = !links && analyzed + run.failed.length >= site.inventory.length;
  const productsLeft = site.inventory.filter((p) => p.summary.pageType === "product").length - run.pages.filter((p) => p.summary.pageType === "product").length;
  return {
    platform: site.platform,
    catalogue: site.platform !== "shopify" || links ? null : !site.catalogueOk ? "unavailable" : catalogue.length > 0 ? "read" : productsLeft > 0 ? "read" : "not_needed",
    inventory: site.inventoryMode,
    rows,
    totals: { onSite, analyzed, viaCatalogue: catalogue.length, failed: run.failed.length },
    complete,
    mainLocale: "fr",
    otherLocales: site.otherLocales,
    fullAuditMaxPages: complete || onSite === null || onSite > settings.maxPagesLimits.max ? null : onSite,
  };
}

function issuesFor(site: DemoSite): IssueDetail[] {
  const issues = mergeIssues(issuesOf(shownPages(site)), catalogueIssuesOf(catalogueProducts(site)));
  // Après une lecture de la boutique, chaque preuve est rattachée à son élément Shopify.
  return issues.map((i) => ({ ...i, evidence: i.evidence.map((e) => ({ ...e, shopifyResourceId: i.shopifyField ? resourceIdForPath(shopCtx(site), e.path, i.shopifyField) : null })) }));
}

function shopCtx(site: DemoSite): ShopCtx {
  return {
    host: site.summary.host, inventory: site.inventory, shown: shownPages(site), json, apiError, delay,
    emit: () => emit(site, { type: "shopify" }),
  };
}

function overviewOf(site: DemoSite): Overview {
  const pages = shownPages(site);
  const issues = issuesFor(site);
  const score = siteScore(pages);
  const counts = { critical: 0, warning: 0, info: 0 };
  issues.forEach((i) => counts[i.severity]++);
  return {
    site: site.summary,
    score: score === null ? null : { value: score, previous: site.previousScore, categories: categoriesOf(pages) },
    counts: { pages: pages.length, issues: counts },
    topIssues: issues.slice(0, 5).map(toIssue),
    strengths: strengthsOf(pages).slice(0, 5),
    actions: recommendationsOf(issues).slice(0, 5),
    coverage: coverageOf(site),
    organic: site.gsc ? { period: site.gsc.period, totals: site.gsc.totals, series: site.gsc.series } : null,
  };
}

// ───────── Flux

function emit(site: DemoSite, e: SiteEvent) {
  site.listeners.forEach((l) => l(e));
}

function sseResponse(start: (push: (event: string, data: unknown) => void, close: () => void) => () => void, signal?: AbortSignal | null): Response {
  const enc = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const push = (event: string, data: unknown) => {
        if (!closed) controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const close = () => {
        if (closed) return;
        closed = true;
        cleanup();
        controller.close();
      };
      cleanup = start(push, close);
      signal?.addEventListener("abort", close);
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function startAudit(site: DemoSite, maxPages: number, frozenAt?: number) {
  if (site.timer) clearInterval(site.timer);
  const truth = balanced(site.inventoryMode === "sitemap" ? site.inventory : site.truth, maxPages);
  const run: Run = {
    audit: {
      id: nextId("aud"), state: "running", startedAt: new Date().toISOString(), finishedAt: null, maxPages,
      pagesDone: 0, pagesFailed: 0, pagesQueued: 1, currentUrl: site.summary.url, error: null,
    },
    pages: [],
    failed: [],
  };
  site.current = run;
  sync(site);
  emit(site, { type: "audit", audit: run.audit, score: site.summary.score });
  let i = 0;
  const failAt = Math.min(13, truth.length - 1);
  const interval = truth.length > 100 ? 140 : 420;
  const tick = () => {
    const a = run.audit;
    if (a.state !== "running") return;
    if (frozenAt !== undefined && a.pagesDone >= frozenAt) return;
    if (i >= truth.length) {
      run.audit = { ...a, state: "done", finishedAt: new Date().toISOString(), pagesQueued: 0, currentUrl: null };
      sync(site);
      emit(site, { type: "audit", audit: run.audit, score: site.summary.score });
      clearInterval(site.timer!);
      site.timer = null;
      return;
    }
    if (i === failAt && run.failed.length === 0) run.failed.push(failedPage(site.profile.host, "/ancienne-page", 404, "Page introuvable (404)"));
    const page = truth[i++];
    run.pages.push(page);
    const discovered = Math.min(truth.length, Math.max(i + 1, Math.round(i * 2.4) + 3));
    const next = truth[i];
    run.audit = { ...a, pagesDone: run.pages.length, pagesFailed: run.failed.length, pagesQueued: Math.max(0, discovered - i), currentUrl: next ? next.summary.url : a.currentUrl };
    sync(site);
    emit(site, { type: "page", page: page.summary });
    emit(site, { type: "audit", audit: run.audit, score: site.summary.score });
  };
  if (frozenAt !== undefined) for (let k = 0; k < frozenAt; k++) tick();
  site.timer = setInterval(tick, interval);
}

if (scenario === "analyse" || scenario === "analyse-figee") {
  // Première analyse : aucun résultat avant la première page notée.
  const s = sites[0];
  if (s) {
    s.shown = null;
    s.current = null;
    s.previousScore = null;
    startAudit(s, 100, scenario === "analyse-figee" ? 17 : undefined);
  }
}
if (scenario === "inventaire") {
  // Première analyse, encore à l'inventaire : l'adresse lue est un sitemap, aucune page notée.
  const s = sites[0];
  if (s) {
    s.shown = null;
    s.current = {
      audit: {
        id: nextId("aud"), state: "running", startedAt: new Date().toISOString(), finishedAt: null, maxPages: settings.maxPagesDefault,
        pagesDone: 0, pagesFailed: 0, pagesQueued: 0, currentUrl: `https://${s.profile.host}/sitemap_products_1.xml?from=1&to=250`, error: null,
      },
      pages: [],
      failed: [],
    };
    sync(s);
  }
}
if (scenario === "relance" || scenario === "relance-figee") {
  // Relance : les résultats de l'analyse terminée restent affichés jusqu'à la fin de la nouvelle.
  const s = sites[0];
  if (s) startAudit(s, 100, scenario === "relance-figee" ? 9 : undefined);
}

// ───────── Assistant

function assistantAnswer(site: DemoSite, q: string): { tools: string[]; text: string; sources: string[] } {
  const recs = recommendationsOf(issuesFor(site));
  const low = q.toLowerCase();
  if (/visite|clic|trafic|rapport/.test(low)) {
    if (!site.gsc) {
      return { tools: ["Lecture des données Search Console"], sources: ["Search Console"], text: "Je n'ai pas encore de données de visites pour ce site : aucun export Search Console n'a été déposé.\n\nDéposez-le dans **Mots-clés et trafic organique** et je pourrai vous dire quelles pages vous apportent des visiteurs." };
    }
    const top = (site.gsc.pages ?? []).slice(0, 4);
    return {
      tools: ["Lecture des données Search Console", "Lecture des pages analysées"],
      sources: ["Search Console", "Pages analysées"],
      text: `Sur la période importée, vos pages qui apportent le plus de visites depuis Google sont :\n\n${top.map((p) => `- [${p.path}](${p.url}) : **${p.clicks} clics**${p.score !== null ? `, note ${p.score}/100` : ", page non analysée"}`).join("\n")}\n\nCe sont elles qu'il faut soigner en premier. Pour aller plus loin, le guide de Google sur les [extraits de résultats](https://developers.google.com/search/docs/appearance/snippet) explique comment il choisit le texte affiché.\n\n![capture](https://exemple.invalid/capture.png)`,
    };
  }
  if (/description|rédige|écri/.test(low)) {
    return {
      tools: ["Lecture de la page /collections"],
      sources: ["Page /collections"],
      text: "Voici une proposition pour la page `/collections` (148 caractères) :\n\n```\nVaisselle en grès tournée à la main à Nantes : bols, assiettes, tasses et vases. Pièces uniques, livraison soignée offerte dès 60 €.\n```\n\nCollez-la dans le champ **Description** du réglage de référencement de la page. Le nom de champ `meta__description` de certains thèmes n'a rien à voir avec du gras. Pensez aussi à allonger le titre « Produits », qui ne dit pas ce que vend la page.",
    };
  }
  const first = recs[0];
  const second = recs[1];
  const gain = first && first.scoreGain > 0 ? ` (environ ${String(first.scoreGain).replace(".", ",")} points de plus sur la note du site)` : "";
  return {
    tools: ["Lecture des problèmes du site", "Lecture des recommandations"],
    sources: ["Problèmes du site", "Recommandations"],
    text: first
      ? `Je commencerais par **${first.title.toLowerCase()}** : c'est l'action qui rapporte le plus pour l'effort demandé${gain}.\n\n${second ? `Ensuite : ${second.title.toLowerCase()}.\n\n` : ""}Étapes pour la première action :\n\n${first.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`
      : "Votre site ne présente aucun problème détecté par l'analyse.",
  };
}

// ───────── Routeur

let eventsConnections = 0;

export async function demoFetch(input: string, init?: RequestInit): Promise<Response> {
  const url = new URL(input, location.origin);
  const method = (init?.method ?? "GET").toUpperCase();
  const path = url.pathname.replace(/^\/api/, "");
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);

  const isStream = parts[2] === "events" || (parts[2] === "chat" && method === "POST");
  if (!isStream) await delay(latency(path));
  if (init?.signal?.aborted) throw new DOMException("Abandon", "AbortError");

  if (path === "/health") return json({ ok: true, version: "0.1.0" });
  if (path === "/settings") {
    if (method === "PATCH") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { maxPagesDefault?: number };
      const v = body.maxPagesDefault;
      if (typeof v !== "number" || v < settings.maxPagesLimits.min || v > settings.maxPagesLimits.max || !Number.isInteger(v)) {
        return apiError(400, "bad_request", `Le plafond doit être un nombre entier entre ${settings.maxPagesLimits.min} et ${settings.maxPagesLimits.max}.`, null);
      }
      settings.maxPagesDefault = v;
    }
    return json(settings);
  }
  if (path === "/sites") {
    if (method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { url?: string; maxPages?: number };
      const raw = (body.url ?? "").trim();
      let u: URL;
      try {
        u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
        if (!u.hostname.includes(".") || /^(localhost|127\.|10\.|192\.168\.)/.test(u.hostname)) throw new Error();
      } catch {
        return apiError(400, "invalid_url", "Cette adresse n'est pas valide.", "Saisissez l'adresse publique de votre site, par exemple monsite.fr.", { url: raw });
      }
      await delay(900);
      const host = u.hostname.replace(/^www\./, "");
      if (host.includes("plafond")) return apiError(409, "limit_reached", "Vous suivez déjà 10 sites, le maximum de cette installation.", "Supprimez un site dans ses paramètres pour en ajouter un autre.", { limit: 10 });
      if (host.includes("rafale")) return apiError(429, "rate_limited", "Trop d'ajouts de sites en peu de temps.", "Patientez un instant, puis réessayez.", { retryAfterSeconds: 20 });
      const existing = sites.find((s) => s.summary.host === host);
      if (existing) return apiError(409, "site_exists", "Ce site est déjà suivi.", "Ouvrez-le depuis la liste de vos sites.", { siteId: existing.summary.id });
      if (host.includes("injoignable")) return apiError(422, "site_unreachable", "Ce site ne répond pas.", "Vérifiez l'adresse, puis réessayez.", { url: u.href });
      const profile: SiteProfile = { ...LUNE, host, seed: host.length * 13 };
      const site = makeSite(nextId("site"), host, profile, new Date().toISOString(), {
        gsc: false, auditEnd: new Date().toISOString(), previous: null, competitors: settings.integrations.competitors.configured ? { available: false, reason: "not_run" } : { available: false, reason: "not_configured" }, chat: [],
      });
      site.shown = null;
      site.current = null;
      sites.unshift(site);
      startAudit(site, body.maxPages ?? settings.maxPagesDefault);
      return json({ site: site.summary }, 201);
    }
    return json({ sites: sites.map((s) => s.summary) });
  }
  if (parts[0] !== "sites" || !parts[1]) return notFound();
  const site = sites.find((s) => s.summary.id === parts[1]);
  if (!site) return notFound();
  const sub = parts[2] ?? "";

  if (!sub) {
    if (method === "DELETE") {
      if (site.timer) clearInterval(site.timer);
      sites.splice(sites.indexOf(site), 1);
      site.listeners.clear();
      return json(null, 204);
    }
    return json({ site: site.summary });
  }

  if (sub === "events") {
    // Scénario « coupure » : la première connexion se coupe après 2,5 s, les suivantes échouent (serveur injoignable).
    if (scenario === "coupure" && eventsConnections++ > 0) {
      await delay(300);
      throw new TypeError("Failed to fetch");
    }
    return sseResponse((push, close) => {
      push("site", { type: "site", site: site.summary });
      const l = (e: SiteEvent) => push(e.type, e);
      site.listeners.add(l);
      const t = scenario === "coupure" ? setTimeout(close, 2500) : undefined;
      return () => {
        site.listeners.delete(l);
        if (t) clearTimeout(t);
      };
    }, init?.signal);
  }

  if (sub === "audits") {
    if (parts[3] === "cancel") {
      const run = site.current;
      if (!run || (run.audit.state !== "running" && run.audit.state !== "queued")) return apiError(409, "no_audit", "Aucune analyse n'est en cours.", null);
      if (site.timer) clearInterval(site.timer);
      site.timer = null;
      run.audit = { ...run.audit, state: "cancelled", finishedAt: new Date().toISOString(), currentUrl: null, pagesQueued: 0 };
      sync(site);
      emit(site, { type: "audit", audit: run.audit, score: site.summary.score });
      return json({ audit: run.audit });
    }
    if (site.current?.audit.state === "running") return apiError(409, "audit_running", "Une analyse est déjà en cours pour ce site.", "Attendez la fin de l'analyse ou arrêtez-la.");
    const body = JSON.parse(String(init?.body ?? "{}")) as { maxPages?: number };
    startAudit(site, body.maxPages ?? settings.maxPagesDefault);
    return json({ audit: site.summary.audit }, 202);
  }

  const failure = method === "GET" ? maybeFail() : null;
  if (failure) return failure;

  const pages = shownPages(site);
  switch (sub) {
    case "overview":
      return json(overviewOf(site));
    case "coverage":
      return json({ coverage: coverageOf(site) });
    case "issues": {
      const issues = issuesFor(site);
      if (parts[3]) {
        const d = issues.find((i) => i.id === parts[3]);
        return d ? json({ issue: d }) : notFound();
      }
      return json({ issues: issues.map(toIssue), strengths: strengthsOf(pages), categories: pages.length ? categoriesOf(pages) : [] });
    }
    case "failed-pages":
      return json({ pages: site.shown?.failed ?? [] });
    case "pages": {
      if (parts[3]) {
        const p = pages.find((x) => x.summary.id === parts[3]) ?? site.truth.find((x) => x.summary.id === parts[3]);
        return p ? json({ page: { ...p.detail, shopifyResourceId: resourceIdForPath(shopCtx(site), p.detail.path) } }) : notFound();
      }
      const sort = url.searchParams.get("sort") ?? "score_asc";
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Math.min(200, Number(url.searchParams.get("limit") ?? 50));
      let list = pages.map((p) => p.summary);
      if (q) list = list.filter((p) => p.path.toLowerCase().includes(q) || (p.title ?? "").toLowerCase().includes(q));
      const cmp: Record<string, (a: (typeof list)[0], b: (typeof list)[0]) => number> = {
        score_asc: (a, b) => a.score - b.score, score_desc: (a, b) => b.score - a.score, issues_desc: (a, b) => b.issues - a.issues,
        clicks_desc: (a, b) => (b.organic?.clicks ?? -1) - (a.organic?.clicks ?? -1), path_asc: (a, b) => a.path.localeCompare(b.path),
      };
      list = [...list].sort(cmp[sort] ?? cmp.score_asc);
      return json({ pages: list.slice(offset, offset + limit), total: list.length, offset, limit });
    }
    case "recommendations":
      return json({ recommendations: recommendationsOf(issuesFor(site)) });
    case "shopify": {
      const body = method === "GET" ? url.searchParams : init?.body ? JSON.parse(String(init.body)) : {};
      return handleShopify(shopCtx(site), parts.slice(3), method, body);
    }
    case "search-console": {
      if (method === "DELETE") {
        site.gsc = null;
        attachOrganic(site.truth, null);
        site.summary = { ...site.summary, searchConsole: { available: false, importedAt: null } };
        emit(site, { type: "search_console", available: false });
        return json(null, 204);
      }
      if (method === "POST") {
        const form = init?.body as FormData;
        const file = form?.get("file") as File | null;
        await delay(1200);
        if (!file) return apiError(400, "bad_request", "Aucun fichier reçu.", "Choisissez le fichier exporté depuis la Search Console.");
        if (file.size > 20 * 1024 * 1024) return apiError(413, "file_too_large", "Ce fichier dépasse 20 Mo.", "Exportez une période plus courte, puis réessayez.");
        if (!/\.(zip|csv)$/i.test(file.name) || /pas-un-export/.test(file.name)) return apiError(422, "invalid_file", "Ce fichier n'est pas un export Search Console lisible.", "Déposez le fichier .zip téléchargé depuis « Performances » de la Search Console.");
        site.gsc = buildSearchConsole(site.truth, site.profile.seed + 1, new Date().toISOString(), {
          queries: LUNE_QUERIES, host: site.profile.host, clicksPerDay: site.truth.length > 100 ? 90 : 20,
          extraPages: [{ path: "/ancienne-collection", clicks: 3, impressions: 410, position: 31.2 }],
        });
        attachOrganic(site.truth, site.gsc);
        site.summary = { ...site.summary, searchConsole: { available: true, importedAt: site.gsc.importedAt } };
        emit(site, { type: "search_console", available: true });
        return json(site.gsc);
      }
      return json(site.gsc ?? { available: false });
    }
    case "competitors": {
      if (method === "POST") {
        if (!settings.integrations.competitors.configured) return apiError(503, "competitors_not_configured", "Le relevé des concurrents n'est pas configuré sur le serveur.", "Ajoutez une clé de recherche côté serveur pour l'activer.");
        await delay(1800);
        if (scenario === "erreurs") return apiError(503, "competitors_unavailable", "Le service de recherche ne répond pas pour le moment.", "Réessayez dans quelques minutes.");
        site.competitors = buildCompetitors(site.summary.host);
        return json(site.competitors);
      }
      if (!site.summary.results) return json({ available: false, reason: "no_audit" });
      return json(site.competitors);
    }
    case "chat": {
      if (method === "DELETE") {
        site.chat = [];
        return json(null, 204);
      }
      if (method === "POST") {
        if (!settings.integrations.chat.configured) return apiError(503, "chat_not_configured", "L'assistant n'est pas configuré sur ce serveur.", "Ajoutez la clé d'API Claude côté serveur pour l'activer.");
        const { message } = JSON.parse(String(init?.body ?? "{}")) as { message: string };
        const low = message.toLowerCase();
        if (low.includes("limite")) return apiError(429, "rate_limited", "Vous avez posé beaucoup de questions en peu de temps.", "Patientez un peu, puis renvoyez votre question.", { retryAfterSeconds: 45 });
        const userMessage: ChatMessage = { id: nextId("msg"), role: "user", content: message, createdAt: new Date().toISOString(), sources: [] };
        site.chat = [...site.chat, userMessage];
        const answer = assistantAnswer(site, message);
        // Échec avant toute réponse : la question n'est pas conservée (comme le serveur).
        const failEarly = low.includes("clé") || low.includes("panne");
        return sseResponse((push, close) => {
          let cancelled = false;
          (async () => {
            push("start", { type: "start", userMessage });
            if (failEarly) {
              await delay(700);
              site.chat = site.chat.filter((m) => m.id !== userMessage.id);
              push("error", {
                type: "error",
                error: low.includes("clé")
                  ? { code: "chat_not_configured", message: "La clé de l'API Claude configurée sur le serveur est refusée.", action: "Vérifiez la clé ANTHROPIC_API_KEY du serveur, puis redémarrez-le." }
                  : { code: "chat_unavailable", message: "L'assistant est momentanément saturé.", action: "Réessayez dans quelques instants." },
              });
              close();
              return;
            }
            for (const t of answer.tools) {
              await delay(500);
              if (cancelled) return;
              push("tool", { type: "tool", label: t });
            }
            await delay(400);
            if (scenario === "erreurs") {
              push("delta", { type: "delta", text: "Je regarde vos pages les moins bien notées" });
              await delay(500);
              push("error", { type: "error", error: { code: "chat_unavailable", message: "L'assistant est momentanément saturé.", action: "Réessayez dans une minute." } });
              close();
              return;
            }
            const chunks = answer.text.match(/[\s\S]{1,14}/g) ?? [];
            let sent = "";
            for (const c of chunks) {
              if (cancelled) {
                // Flux coupé par le navigateur : la génération s'arrête, la réponse partielle est enregistrée.
                if (sent) site.chat = [...site.chat, { id: nextId("msg"), role: "assistant", content: `${sent}…`, createdAt: new Date().toISOString(), sources: answer.sources }];
                return;
              }
              push("delta", { type: "delta", text: c });
              sent += c;
              await delay(28);
            }
            const msg: ChatMessage = { id: nextId("msg"), role: "assistant", content: answer.text, createdAt: new Date().toISOString(), sources: answer.sources };
            site.chat = [...site.chat, msg];
            push("done", { type: "done", message: msg });
            close();
          })();
          return () => {
            cancelled = true;
          };
        }, init?.signal);
      }
      const suggestions = pages.length ? [...exChat.suggestions] : [];
      return json({ available: settings.integrations.chat.configured, messages: site.chat, suggestions });
    }
  }
  return notFound();
}
