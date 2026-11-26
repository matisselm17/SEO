/**
 * MODE DÉMONSTRATION — développement uniquement (VITE_DEMO=1 avec `vite`).
 * Faux serveur qui répond aux routes de docs/format-echange.md avec des Response réelles,
 * y compris les flux SSE (analyse en cours, réponse de l'assistant).
 * Ce module n'est jamais inclus dans le build de production (voir lib/transport.ts).
 *
 * Scénarios, choisis avec ?demo=… dans l'adresse (mémorisé pour l'onglet) :
 *   complet (défaut) · vide · sans-gsc · sans-config · analyse · analyse-figee · erreurs · lent
 * Saisies spéciales à l'ajout d'un site : une adresse contenant « injoignable » renvoie site_unreachable.
 */
import examples from "../../../docs/exemples/exemples.json";
import type {
  ApiError, AuditStatus, ChatMessage, CompetitorsData, ErrorCode, Overview, SearchConsoleData, Settings, SiteEvent, SiteSummary,
} from "../lib/types";
import {
  LUNE, LUNE_QUERIES, ORLUX, attachOrganic, buildCompetitors, buildPages, buildSearchConsole, categoriesOf, issuesOf,
  recommendationsOf, siteScore, strengthsOf, toIssue, type DemoPage, type SiteProfile,
} from "./data";

type Scenario = "complet" | "vide" | "sans-gsc" | "sans-config" | "analyse" | "analyse-figee" | "erreurs" | "lent";
const SCENARIOS: Scenario[] = ["complet", "vide", "sans-gsc", "sans-config", "analyse", "analyse-figee", "erreurs", "lent"];

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

const settings: Settings = {
  ...exSettings,
  integrations: {
    chat: scenario === "sans-config" ? { configured: false, model: null } : exSettings.integrations.chat,
    competitors: { configured: scenario !== "sans-config" },
  },
};

// ───────── État en mémoire

interface DemoSite {
  summary: SiteSummary;
  profile: SiteProfile;
  truth: DemoPage[];
  pages: DemoPage[];
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

function makeSite(id: string, name: string, profile: SiteProfile, createdAt: string, opts: { score?: number | null; gsc: boolean; auditEnd: string; previous: number | null; competitors: CompetitorsData; chat: ChatMessage[] }): DemoSite {
  const truth = buildPages(profile, opts.auditEnd);
  const gsc = opts.gsc
    ? buildSearchConsole(truth, profile.seed + 1, "2026-11-26T14:05:00.000Z", {
        queries: LUNE_QUERIES, host: profile.host, clicksPerDay: 20,
        extraPages: [{ path: "/blog/emaillage", clicks: 12, impressions: 900, position: 22.5 }],
      })
    : null;
  attachOrganic(truth, gsc);
  const audit: AuditStatus = {
    id: nextId("aud"), state: "done", startedAt: new Date(new Date(opts.auditEnd).getTime() - 102000).toISOString(), finishedAt: opts.auditEnd,
    maxPages: Math.max(100, truth.length), pagesDone: truth.length, pagesFailed: 1, pagesQueued: 0, currentUrl: null, error: null,
  };
  return {
    summary: {
      id, url: `https://${profile.host}/`, host: profile.host, name, createdAt, audit, score: siteScore(truth), pagesAnalyzed: truth.length,
      searchConsole: { available: !!gsc, importedAt: gsc?.importedAt ?? null },
    },
    profile, truth, pages: truth, previousScore: opts.previous, gsc, competitors: opts.competitors, chat: opts.chat, timer: null, listeners: new Set(),
  };
}

if (scenario !== "vide") {
  const competitorsLune: CompetitorsData = scenario === "sans-config" ? { available: false, reason: "not_configured" } : buildCompetitors(LUNE.host);
  sites.push(
    makeSite("site_8fk2", "Atelier Lune", LUNE, "2026-11-20T09:12:00.000Z", {
      gsc: scenario !== "sans-gsc", auditEnd: "2026-11-26T14:01:42.000Z", previous: 61, competitors: competitorsLune,
      chat: scenario === "sans-gsc" || scenario === "sans-config" ? [] : exChat.messages,
    }),
    makeSite("site_orlx", "Maison Orlux", ORLUX, "2026-11-12T10:30:00.000Z", {
      gsc: false, auditEnd: "2026-11-24T09:40:00.000Z", previous: null,
      competitors: scenario === "sans-config" ? { available: false, reason: "not_configured" } : { available: false, reason: "not_run" }, chat: [],
    }),
  );
}

// ───────── Réponses

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
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
function maybeFail(key: string): Response | null {
  if (scenario !== "erreurs" || Date.now() - loadedAt > 2000) return null;
  void key;
  return apiError(500, "internal", "Le serveur n'a pas pu lire les résultats de l'analyse.", "Réessayez dans un instant.");
}

// ───────── Calculs

function pagesTotal(site: DemoSite) {
  return site.pages.length;
}

function overviewOf(site: DemoSite): Overview {
  const pages = site.pages;
  const issues = issuesOf(pages);
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
  const truth = site.truth.slice(0, Math.min(maxPages, site.truth.length));
  site.previousScore = site.summary.score;
  site.pages = [];
  const audit: AuditStatus = {
    id: nextId("aud"), state: "running", startedAt: new Date().toISOString(), finishedAt: null, maxPages,
    pagesDone: 0, pagesFailed: 0, pagesQueued: 1, currentUrl: site.summary.url, error: null,
  };
  site.summary = { ...site.summary, audit, score: null, pagesAnalyzed: 0 };
  emit(site, { type: "audit", audit, score: null });
  let i = 0;
  const failAt = new Set([Math.min(13, truth.length - 1)]);
  const interval = truth.length > 100 ? 140 : 420;
  const tick = () => {
    const a = site.summary.audit!;
    if (a.state !== "running") return;
    if (frozenAt !== undefined && a.pagesDone >= frozenAt) return;
    if (i >= truth.length) {
      const done: AuditStatus = { ...a, state: "done", finishedAt: new Date().toISOString(), pagesQueued: 0, currentUrl: null };
      site.summary = { ...site.summary, audit: done, score: siteScore(site.pages), pagesAnalyzed: site.pages.length };
      emit(site, { type: "audit", audit: done, score: site.summary.score });
      clearInterval(site.timer!);
      site.timer = null;
      return;
    }
    let failed = a.pagesFailed;
    if (failAt.has(i) && failed === 0) failed++;
    const page = truth[i++];
    site.pages = [...site.pages, page];
    emit(site, { type: "page", page: page.summary });
    const discovered = Math.min(truth.length, Math.max(i + 1, Math.round(i * 2.4) + 3));
    const next = truth[i];
    const audit2: AuditStatus = { ...a, pagesDone: site.pages.length, pagesFailed: failed, pagesQueued: Math.max(0, discovered - i), currentUrl: next ? next.summary.url : null };
    site.summary = { ...site.summary, audit: audit2, score: siteScore(site.pages), pagesAnalyzed: site.pages.length };
    emit(site, { type: "audit", audit: audit2, score: site.summary.score });
  };
  if (frozenAt !== undefined) for (let k = 0; k < frozenAt; k++) tick();
  site.timer = setInterval(tick, interval);
}

if (scenario === "analyse" || scenario === "analyse-figee") {
  const s = sites[0];
  if (s) startAudit(s, 100, scenario === "analyse-figee" ? 17 : undefined);
}

// ───────── Assistant

function assistantAnswer(site: DemoSite, q: string): { tools: string[]; text: string; sources: string[] } {
  const issues = issuesOf(site.pages);
  const recs = recommendationsOf(issues);
  const low = q.toLowerCase();
  if (/visite|clic|trafic|rapport/.test(low)) {
    if (!site.gsc) {
      return { tools: ["Lecture des données Search Console"], sources: ["Search Console"], text: "Je n'ai pas encore de données de visites pour ce site : aucun export Search Console n'a été déposé.\n\nDéposez-le dans **Mots-clés et trafic organique** et je pourrai vous dire quelles pages vous apportent des visiteurs." };
    }
    const top = (site.gsc.pages ?? []).slice(0, 4);
    return {
      tools: ["Lecture des données Search Console", "Lecture des pages analysées"],
      sources: ["Search Console", "Pages analysées"],
      text: `Sur la période importée, vos pages qui apportent le plus de visites depuis Google sont :\n\n${top.map((p) => `- \`${p.path}\` : **${p.clicks} clics**${p.score !== null ? `, note ${p.score}/100` : ", page non analysée"}`).join("\n")}\n\nCe sont elles qu'il faut soigner en premier : chaque point gagné sur ces pages profite à plus de visiteurs.`,
    };
  }
  if (/description|rédige|écri/.test(low)) {
    return {
      tools: ["Lecture de la page /boutique"],
      sources: ["Page /boutique"],
      text: "Voici une proposition pour la page `/boutique` (148 caractères) :\n\n```\nVaisselle en grès tournée à la main à Nantes : bols, assiettes, tasses et vases. Pièces uniques, livraison soignée offerte dès 60 €.\n```\n\nCollez-la dans le champ **Description** du réglage de référencement de la page. Pensez aussi à allonger le titre « Produits », qui ne dit pas ce que vend la page.",
    };
  }
  const first = recs[0];
  const second = recs[1];
  return {
    tools: ["Lecture des problèmes du site", "Lecture des recommandations"],
    sources: ["Problèmes du site", "Recommandations"],
    text: first
      ? `Je commencerais par **${first.title.toLowerCase()}** : c'est l'action qui rapporte le plus pour l'effort demandé (${first.pointsToGain} points à regagner sur ${first.pagesAffected} pages).\n\n${second ? `Ensuite : ${second.title.toLowerCase()}.\n\n` : ""}Étapes pour la première action :\n\n${first.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`
      : "Votre site ne présente aucun problème détecté par l'analyse. Bravo !",
  };
}

// ───────── Routeur

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
      const existing = sites.find((s) => s.summary.host === host);
      if (existing) return apiError(409, "site_exists", "Ce site est déjà suivi.", "Ouvrez-le depuis la liste de vos sites.", { siteId: existing.summary.id });
      if (host.includes("injoignable")) return apiError(422, "site_unreachable", "Ce site ne répond pas.", "Vérifiez l'adresse, puis réessayez.", { url: u.href });
      const profile: SiteProfile = { ...LUNE, host, seed: host.length * 13 };
      const site = makeSite(nextId("site"), host, profile, new Date().toISOString(), {
        gsc: false, auditEnd: new Date().toISOString(), previous: null, competitors: settings.integrations.competitors.configured ? { available: false, reason: "not_run" } : { available: false, reason: "not_configured" }, chat: [],
      });
      site.summary.score = null;
      sites.unshift(site);
      startAudit(site, body.maxPages ?? settings.maxPagesDefault);
      site.previousScore = null;
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
      return json(null, 204);
    }
    return json({ site: site.summary });
  }

  if (sub === "events") {
    return sseResponse((push) => {
      push("site", { type: "site", site: site.summary });
      const l = (e: SiteEvent) => push(e.type, e);
      site.listeners.add(l);
      return () => site.listeners.delete(l);
    }, init?.signal);
  }

  if (sub === "audits") {
    if (parts[3] === "cancel") {
      const a = site.summary.audit;
      if (!a || a.state !== "running") return apiError(409, "no_audit", "Aucune analyse n'est en cours.", null);
      if (site.timer) clearInterval(site.timer);
      site.timer = null;
      const cancelled: AuditStatus = { ...a, state: "cancelled", finishedAt: new Date().toISOString(), currentUrl: null, pagesQueued: 0 };
      site.summary = { ...site.summary, audit: cancelled };
      emit(site, { type: "audit", audit: cancelled, score: site.summary.score });
      return json({ audit: cancelled });
    }
    if (site.summary.audit?.state === "running") return apiError(409, "audit_running", "Une analyse est déjà en cours pour ce site.", "Attendez la fin de l'analyse ou arrêtez-la.");
    const body = JSON.parse(String(init?.body ?? "{}")) as { maxPages?: number };
    startAudit(site, body.maxPages ?? settings.maxPagesDefault);
    return json({ audit: site.summary.audit }, 202);
  }

  const failure = method === "GET" ? maybeFail(path) : null;
  if (failure) return failure;

  switch (sub) {
    case "overview":
      return json(overviewOf(site));
    case "issues": {
      const issues = issuesOf(site.pages);
      if (parts[3]) {
        const d = issues.find((i) => i.id === parts[3]);
        return d ? json({ issue: d }) : notFound();
      }
      return json({ issues: issues.map(toIssue), strengths: strengthsOf(site.pages), categories: categoriesOf(site.pages) });
    }
    case "pages": {
      if (parts[3]) {
        const p = site.pages.find((x) => x.summary.id === parts[3]) ?? site.truth.find((x) => x.summary.id === parts[3]);
        return p ? json({ page: p.detail }) : notFound();
      }
      const sort = url.searchParams.get("sort") ?? "score_asc";
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Math.min(200, Number(url.searchParams.get("limit") ?? 50));
      let list = site.pages.map((p) => p.summary);
      if (q) list = list.filter((p) => p.path.toLowerCase().includes(q) || (p.title ?? "").toLowerCase().includes(q));
      const cmp: Record<string, (a: (typeof list)[0], b: (typeof list)[0]) => number> = {
        score_asc: (a, b) => a.score - b.score, score_desc: (a, b) => b.score - a.score, issues_desc: (a, b) => b.issues - a.issues,
        clicks_desc: (a, b) => (b.organic?.clicks ?? -1) - (a.organic?.clicks ?? -1), path_asc: (a, b) => a.path.localeCompare(b.path),
      };
      list = [...list].sort(cmp[sort] ?? cmp.score_asc);
      return json({ pages: list.slice(offset, offset + limit), total: list.length, offset, limit });
    }
    case "recommendations":
      return json({ recommendations: recommendationsOf(issuesOf(site.pages)) });
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
        if (!/\.(zip|csv)$/i.test(file.name)) return apiError(422, "invalid_file", "Ce fichier n'est pas un export Search Console lisible.", "Déposez le fichier .zip téléchargé depuis « Performances » de la Search Console.");
        site.gsc = buildSearchConsole(site.truth, site.profile.seed + 1, new Date().toISOString(), {
          queries: LUNE_QUERIES, host: site.profile.host, clicksPerDay: site.truth.length > 100 ? 90 : 20, extraPages: [],
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
        site.competitors = buildCompetitors(site.summary.host);
        return json(site.competitors);
      }
      if (!site.summary.audit) return json({ available: false, reason: "no_audit" });
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
        const userMessage: ChatMessage = { id: nextId("msg"), role: "user", content: message, createdAt: new Date().toISOString(), sources: [] };
        site.chat = [...site.chat, userMessage];
        const answer = assistantAnswer(site, message);
        return sseResponse((push, close) => {
          let cancelled = false;
          (async () => {
            push("start", { type: "start", userMessage });
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
            for (const c of chunks) {
              if (cancelled) return;
              push("delta", { type: "delta", text: c });
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
      const suggestions = site.pages.length ? exChat.suggestions : [];
      return json({ available: settings.integrations.chat.configured, messages: site.chat, suggestions });
    }
  }
  void pagesTotal;
  return notFound();
}
