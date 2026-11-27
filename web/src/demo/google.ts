/**
 * MODE DÉMONSTRATION (développement uniquement) — Google Analytics et vitesse des pages (PageSpeed Insights).
 * Répond aux routes /analytics, /analytics/sync, /pagespeed, /pagespeed/cancel du format d'échange, et fournit
 * PageDetail.visits et PageDetail.speed. Jamais inclus dans le build de production (voir lib/transport.ts).
 *
 * États, choisis dans l'adresse (mémorisés pour l'onglet) — voir web/README.md :
 *   ?ga=lu (défaut) | tronque | ca-masque | jamais-lu | non-configure | sans-acces | autre-site | indispo
 *   ?vitesse=mesure (défaut) | jamais | non-configure | en-cours | erreur | indispo | rafale
 */
import type {
  AnalyticsData, ApiError, ErrorCode, LandingPage, PageSpeedState, PageVisits, SiteEvent, SpeedMeasure, SpeedMetric, SpeedPage, SpeedRating,
  VisitTotals,
} from "../lib/types";
import { rng, type DemoPage } from "./data";

type GaMode = "lu" | "tronque" | "ca-masque" | "jamais-lu" | "non-configure" | "sans-acces" | "autre-site" | "indispo";
type SpeedMode = "mesure" | "jamais" | "non-configure" | "en-cours" | "erreur" | "indispo" | "rafale";

function readMode<T extends string>(param: string, all: readonly T[], fallback: T): T {
  const fromUrl = new URLSearchParams(location.search).get(param) as T | null;
  const key = `demo-${param}`;
  if (fromUrl && all.includes(fromUrl)) {
    sessionStorage.setItem(key, fromUrl);
    return fromUrl;
  }
  const saved = sessionStorage.getItem(key) as T | null;
  return saved && all.includes(saved) ? saved : fallback;
}

const gaMode = readMode<GaMode>("ga", ["lu", "tronque", "ca-masque", "jamais-lu", "non-configure", "sans-acces", "autre-site", "indispo"], "lu");
const speedMode = readMode<SpeedMode>("vitesse", ["mesure", "jamais", "non-configure", "en-cours", "erreur", "indispo", "rafale"], "mesure");

export const analyticsConfiguredDemo = gaMode !== "non-configure";
export const pageSpeedConfiguredDemo = speedMode !== "non-configure";

export interface GoogleCtx {
  siteId: string;
  host: string;
  seed: number;
  /** Pages de l'analyse affichée. */
  pages: DemoPage[];
  /** Le site mesure-t-il ses ventes dans Google Analytics ? (Atelier Lune : oui ; Maison Orlux : non) */
  revenue: boolean;
  configured: { analytics: boolean; pageSpeed: boolean };
  json: (body: unknown, status?: number) => Response;
  apiError: (status: number, code: ErrorCode, message: string, action: string | null, details?: ApiError["error"]["details"]) => Response;
  delay: (ms: number) => Promise<void>;
  emit: (e: SiteEvent) => void;
}

interface GoogleState {
  analytics: AnalyticsData;
  lastSync: number;
  speed: PageSpeedState;
  /** Heure de chaque page demandée, pour la limite de 30 pages mesurées par heure et par site. */
  speedRequests: number[];
  timer: ReturnType<typeof setTimeout> | null;
  queue: DemoPage[];
}

const states = new Map<string, GoogleState>();
const SERVICE_ACCOUNT = "chat-seo-lecture@chat-seo-demo.iam.gserviceaccount.com";

// ───────── Google Analytics

const DAY = 86400000;

function totalsOf(sessions: number, r: () => number, engagement: number, revenuePerSession: number | null): VisitTotals {
  const keyEvents = Math.round(sessions * (0.02 + r() * 0.03));
  return {
    sessions,
    users: Math.round(sessions * (0.78 + r() * 0.1)),
    engagementRate: Math.min(0.95, Math.max(0.2, engagement + (r() - 0.5) * 0.08)),
    keyEvents,
    revenue: revenuePerSession === null ? null : Math.round(sessions * revenuePerSession * (0.7 + r() * 0.6) * 100) / 100,
  };
}

function buildAnalytics(ctx: GoogleCtx, days: number): Extract<AnalyticsData, { available: true }> {
  const r = rng(ctx.seed * 7 + days);
  const end = new Date(Date.UTC(2026, 10, 26));
  const series: Array<{ date: string; sessions: number; organicSessions: number }> = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end.getTime() - i * DAY);
    const dow = d.getUTCDay();
    const weekly = dow === 0 || dow === 6 ? 0.78 : 1.05;
    const trend = 0.85 + (0.3 * (days - i)) / days;
    const sessions = Math.round(62 * weekly * trend * (0.82 + r() * 0.36));
    const organicSessions = Math.round(sessions * (0.36 + r() * 0.1));
    series.push({ date: d.toISOString().slice(0, 10), sessions, organicSessions });
  }
  const total = series.reduce((s, p) => s + p.sessions, 0);
  const organicTotal = series.reduce((s, p) => s + p.organicSessions, 0);
  // « ca-masque » : le compte de service n'a pas le droit de voir le chiffre d'affaires (revenue null partout).
  const restricted = gaMode === "ca-masque";
  const rev = ctx.revenue && !restricted ? 1.9 : null;
  const organic = totalsOf(organicTotal, r, 0.62, rev);
  // Les autres origines se partagent le reste, dans l'ordre de Google (libellés en anglais, comme l'API).
  const rest = total - organicTotal;
  const shares: Array<[string, number, number]> = [
    ["Direct", 0.44, 0.55], ["Organic Social", 0.22, 0.41], ["Referral", 0.13, 0.58], ["Email", 0.09, 0.71], ["Paid Search", 0.07, 0.49], ["Unassigned", 0.05, 0.12],
  ];
  const channels = [
    { channel: "Organic Search", ...organic },
    ...shares.map(([channel, share, eng]) => ({ channel, ...totalsOf(Math.round(rest * share), r, eng, rev === null ? null : rev * 0.8) })),
  ].sort((a, b) => b.sessions - a.sessions);
  const sum = (k: "users" | "keyEvents") => channels.reduce((s, c) => s + c[k], 0);
  const totals: VisitTotals = {
    sessions: channels.reduce((s, c) => s + c.sessions, 0),
    users: sum("users"),
    engagementRate: channels.reduce((s, c) => s + c.engagementRate * c.sessions, 0) / Math.max(1, channels.reduce((s, c) => s + c.sessions, 0)),
    keyEvents: sum("keyEvents"),
    revenue: rev === null ? null : Math.round(channels.reduce((s, c) => s + (c.revenue ?? 0), 0) * 100) / 100,
  };

  // Pages d'arrivée : l'accueil et les pages courtes reçoivent le plus de visites ; deux pages non analysées.
  const ranked = [...ctx.pages].sort((a, b) => a.summary.path.length - b.summary.path.length).slice(0, 40);
  const landing: LandingPage[] = ranked.map((p, i) => {
    const sessions = Math.max(2, Math.round((total * 0.3) / (i + 1.2) * (0.6 + r() * 0.6)));
    const organicSessions = Math.round(sessions * (0.25 + r() * 0.5));
    return { path: p.summary.path, pageId: p.summary.id, score: p.summary.score, organicSessions, ...totalsOf(sessions, r, 0.58, rev) };
  });
  for (const path of ["/pages/ancienne-collection", "/cart"]) {
    const sessions = 20 + Math.round(r() * 60);
    landing.push({ path, pageId: null, score: null, organicSessions: path === "/cart" ? 0 : Math.round(sessions * 0.6), ...totalsOf(sessions, r, 0.4, rev) });
  }
  landing.sort((a, b) => b.organicSessions - a.organicSessions);
  // « tronque » : le site a plus de pages d'arrivée que la liste rendue (le serveur en garde 200 ; ici 12, pour
  // que des pages analysées en soient absentes sans être pour autant sans visite).
  const truncated = gaMode === "tronque";
  const kept = truncated ? landing.slice(0, 12) : landing.slice(0, 200);

  return {
    available: true,
    syncedAt: new Date().toISOString(),
    period: { start: series[0].date, end: series[series.length - 1].date },
    currency: ctx.revenue ? "EUR" : null,
    totals, organic, channels, series, landingPages: kept,
    landingPagesTruncated: truncated || landing.length > 200,
    revenueStatus: restricted ? "restricted" : rev === null ? "not_measured" : "measured",
  };
}

// ───────── Vitesse

const THRESHOLDS = { lcp: [2500, 4000], fcp: [1800, 3000], tbt: [200, 600], cls: [0.1, 0.25], inp: [200, 500] } as const;
function metric(kind: keyof typeof THRESHOLDS, value: number): SpeedMetric {
  const [good, poor] = THRESHOLDS[kind];
  const rating: SpeedRating = value <= good ? "good" : value <= poor ? "average" : "poor";
  return { value: kind === "cls" ? Math.round(value * 100) / 100 : Math.round(value), rating };
}

const OPPORTUNITIES = [
  { title: "Diffuser des images aux formats nouvelle génération", detail: "Les formats WebP et AVIF offrent souvent une meilleure compression que PNG ou JPEG : les images se téléchargent plus vite et consomment moins de données." },
  { title: "Éliminer les ressources qui bloquent le rendu", detail: "Des feuilles de style et des balises <script> empêchent le premier affichage de la page. Chargez en différé ce qui n'est pas indispensable." },
  { title: "Réduire le code JavaScript inutilisé", detail: "Une partie du code JavaScript téléchargé n'est pas utilisée sur cette page, notamment celui d'applications tierces." },
  { title: "Dimensionner correctement les images", detail: "Diffusez des images de la taille où elles s'affichent, pour économiser des données et accélérer le chargement." },
  { title: "Réduire le temps de réponse initial du serveur", detail: null },
  { title: "Différer le chargement des images hors écran", detail: "Les images placées plus bas dans la page peuvent être chargées une fois les éléments essentiels affichés." },
];

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function measure(page: DemoPage, device: "mobile" | "desktop", at: string, fieldKind: "page" | "site" | null): SpeedMeasure {
  const r = rng(hash(page.summary.path + device));
  // Démonstration : une note plausible, puis des mesures cohérentes avec elle (Google mesure, puis note).
  const base = rng(hash(page.summary.path))();
  const mobileScore = Math.round(26 + base * 62);
  const score = device === "mobile" ? mobileScore : Math.min(99, Math.round(mobileScore + 18 + r() * 14));
  const lcp = 1300 + (100 - score) * 48 * (0.85 + r() * 0.3);
  const fcp = lcp * (0.42 + r() * 0.18);
  const tbt = 30 + (100 - score) * 9 * (0.6 + r() * 0.8);
  const cls = r() < 0.6 ? r() * 0.08 : 0.08 + r() * 0.3;
  const field = fieldKind === null ? null : {
    scope: fieldKind,
    lcp: metric("lcp", lcp * (0.7 + r() * 0.3)),
    inp: fieldKind === "site" && device === "desktop" ? null : metric("inp", 120 + r() * 380),
    cls: metric("cls", cls * 0.8),
  };
  const opps = [...OPPORTUNITIES].sort(() => r() - 0.5).slice(0, score > 85 ? 1 : 2 + Math.floor(r() * 3));
  return {
    measuredAt: at,
    score,
    lab: { lcp: metric("lcp", lcp), cls: metric("cls", cls), tbt: metric("tbt", tbt), fcp: metric("fcp", fcp) },
    field,
    opportunities: opps.map((o, i) => ({ ...o, savingsMs: i === 0 || r() < 0.5 ? Math.round((200 + r() * 2400) / 10) * 10 : null })),
  };
}

function speedPage(page: DemoPage, idx: number, at: string): SpeedPage {
  // L'accueil a assez de visites pour le vécu réel de la page ; les autres pages, celui de tout le site ou rien.
  const fieldKind: "page" | "site" | null = page.summary.pageType === "home" ? "page" : idx % 3 === 1 ? null : "site";
  return {
    pageId: page.summary.id, url: page.summary.url, path: page.summary.path, pageType: page.summary.pageType,
    mobile: measure(page, "mobile", at, fieldKind), desktop: measure(page, "desktop", at, fieldKind),
  };
}

/** Pages choisies par le serveur : l'accueil puis une page par type (10 au plus). */
function defaultTargets(pages: DemoPage[]): DemoPage[] {
  const out: DemoPage[] = [];
  const seen = new Set<string>();
  for (const p of pages) {
    if (seen.has(p.summary.pageType)) continue;
    seen.add(p.summary.pageType);
    out.push(p);
  }
  return out.sort((a, b) => (a.summary.pageType === "home" ? -1 : b.summary.pageType === "home" ? 1 : 0)).slice(0, 10);
}

const sortPages = (list: SpeedPage[]) => [...list].sort((a, b) => (a.mobile?.score ?? 101) - (b.mobile?.score ?? 101));

function initialState(ctx: GoogleCtx): GoogleState {
  const ago = new Date(Date.now() - 3 * DAY).toISOString();
  const analytics: AnalyticsData = !ctx.configured.analytics
    ? { available: false, reason: "not_configured" }
    : gaMode === "lu" || gaMode === "tronque" || gaMode === "ca-masque" ? { ...buildAnalytics(ctx, 28), syncedAt: new Date(Date.now() - 2 * DAY).toISOString() } : { available: false, reason: "not_run" };
  const targets = defaultTargets(ctx.pages);
  const measured = speedMode === "mesure" || speedMode === "erreur" || speedMode === "indispo" || speedMode === "rafale"
    ? targets.slice(0, 6).map((p, i) => speedPage(p, i, ago))
    : speedMode === "en-cours" ? targets.slice(0, 2).map((p, i) => speedPage(p, i, new Date().toISOString())) : [];
  // Dernière demande (mode « mesure ») : une page déjà mesurée auparavant a échoué sur ordinateur (sa note
  // précédente reste affichée), une autre n'a pu être mesurée sur aucun appareil.
  const failures: PageSpeedState["failures"] = speedMode === "mesure" && targets.length > 6
    ? [
        { path: targets[1].summary.path, device: "desktop", message: "Google n'a pas pu charger la page en moins de 60 secondes. Elle est peut-être trop lourde, ou le site répondait lentement à ce moment-là." },
        { path: targets[6].summary.path, device: "mobile", message: "La page a répondu par une erreur (code 503) : Google ne mesure que les pages qui s'affichent normalement." },
        { path: targets[6].summary.path, device: "desktop", message: "La page a répondu par une erreur (code 503) : Google ne mesure que les pages qui s'affichent normalement." },
      ]
    : [];
  const speed: PageSpeedState = {
    configured: ctx.configured.pageSpeed,
    running: null,
    pages: sortPages(measured),
    // « erreur » : ce qui arrête toute la demande (quota de la clé épuisé), pas l'échec d'une page.
    lastError: speedMode === "erreur"
      ? { code: "pagespeed_unavailable", message: "Le quota quotidien de la clé PageSpeed Insights est épuisé : la mesure s'est arrêtée après 6 pages.", action: "Relancez la mesure demain, ou demandez à la personne qui gère l'installation d'augmenter le quota de la clé.", details: { retryable: false } }
      : null,
    failures,
  };
  const st: GoogleState = { analytics, lastSync: 0, speed, speedRequests: [], timer: null, queue: [] };
  if (speedMode === "en-cours" && ctx.configured.pageSpeed) {
    st.queue = targets.slice(2);
    st.speed.running = { done: 2, total: targets.length, currentUrl: st.queue[0]?.summary.url ?? null };
  }
  return st;
}

function stateOf(ctx: GoogleCtx): GoogleState {
  let st = states.get(ctx.siteId);
  if (!st) {
    st = initialState(ctx);
    states.set(ctx.siteId, st);
    if (st.speed.running) schedule(ctx, st);
  }
  return st;
}

/** Une page toutes les 6 s en démonstration (Google prend 10 à 40 s par page et par appareil). */
function schedule(ctx: GoogleCtx, st: GoogleState) {
  if (st.timer) clearTimeout(st.timer);
  st.timer = setTimeout(() => {
    st.timer = null;
    const run = st.speed.running;
    const page = st.queue.shift();
    if (!run || !page) return;
    const sp = speedPage(page, run.done, new Date().toISOString());
    // Démonstration : la 4ᵉ page de chaque demande échoue sur ordinateur ; la mesure continue.
    if (run.done === 3) {
      const previous = st.speed.pages.find((p) => p.path === sp.path);
      sp.desktop = previous?.desktop ?? null;
      st.speed.failures = [...st.speed.failures, { path: sp.path, device: "desktop", message: "Google n'a pas pu charger la page en moins de 60 secondes. Elle est peut-être trop lourde, ou le site répondait lentement à ce moment-là." }];
    }
    st.speed.pages = sortPages([...st.speed.pages.filter((p) => p.path !== sp.path), sp]);
    const done = run.done + 1;
    st.speed.running = done >= run.total ? null : { done, total: run.total, currentUrl: st.queue[0]?.summary.url ?? null };
    if (!st.speed.running) st.speed.lastError = null;
    else schedule(ctx, st);
    ctx.emit({ type: "pagespeed" });
  }, 6000);
}

// ───────── Routes

export async function handleAnalytics(ctx: GoogleCtx, sub: string | undefined, method: string, body: { days?: number }): Promise<Response> {
  const st = stateOf(ctx);
  if (sub === "sync" && method === "POST") {
    if (!ctx.configured.analytics) return ctx.apiError(503, "analytics_not_configured", "La lecture de Google Analytics n'est pas configurée sur ce serveur.", "La personne qui gère l'installation doit ajouter le compte de service Google et l'identifiant de la propriété.");
    if (![28, 90].includes(body.days ?? 0)) return ctx.apiError(400, "bad_request", "Période inconnue : 28 ou 90 jours.", null);
    const wait = 60 - Math.floor((Date.now() - st.lastSync) / 1000);
    if (wait > 0) return ctx.apiError(429, "rate_limited", "Une lecture de Google Analytics par minute au plus.", "Patientez un instant, puis relancez la lecture.", { retryAfterSeconds: wait });
    st.lastSync = Date.now();
    await ctx.delay(1800);
    if (gaMode === "sans-acces") return ctx.apiError(403, "analytics_no_access", "Le compte de service n'a pas accès à cette propriété Google Analytics.", "Ajoutez son adresse comme Lecteur de la propriété, puis relancez la lecture.", { account: SERVICE_ACCOUNT });
    if (gaMode === "autre-site") return ctx.apiError(409, "analytics_other_site", `La propriété Google Analytics configurée ne reçoit aucune visite sur ${ctx.host}.`, "Vérifiez le numéro de propriété configuré sur le serveur : il désigne peut-être un autre site.");
    if (gaMode === "indispo") return ctx.apiError(502, "analytics_unavailable", "Google Analytics n'a pas répondu.", "Réessayez dans quelques minutes.", { retryable: true });
    st.analytics = buildAnalytics(ctx, body.days!);
    ctx.emit({ type: "analytics" });
    return ctx.json(st.analytics);
  }
  if (sub) return ctx.apiError(404, "not_found", "Cette ressource n'existe pas.", null);
  return ctx.json(st.analytics);
}

export function handlePageSpeed(ctx: GoogleCtx, sub: string | undefined, method: string, body: { pageIds?: string[] }): Response {
  const st = stateOf(ctx);
  if (sub === "cancel" && method === "POST") {
    if (st.timer) clearTimeout(st.timer);
    st.timer = null;
    st.queue = [];
    st.speed.running = null;
    ctx.emit({ type: "pagespeed" });
    return ctx.json(st.speed);
  }
  if (sub) return ctx.apiError(404, "not_found", "Cette ressource n'existe pas.", null);
  if (method !== "POST") return ctx.json(st.speed);

  if (!ctx.configured.pageSpeed) return ctx.apiError(503, "pagespeed_not_configured", "La mesure de vitesse n'est pas configurée sur ce serveur.", "La personne qui gère l'installation doit ajouter une clé PageSpeed Insights.");
  if (st.speed.running) return ctx.apiError(409, "limit_reached", "Une mesure de vitesse est déjà en cours pour ce site.", "Attendez qu'elle se termine, ou arrêtez-la.");
  if (speedMode === "indispo") return ctx.apiError(502, "pagespeed_unavailable", "PageSpeed Insights n'a pas répondu.", "Réessayez dans quelques minutes.", { retryable: true });
  let targets: DemoPage[];
  if (body.pageIds?.length) {
    if (body.pageIds.length > 10) return ctx.apiError(400, "bad_request", "10 pages au plus par mesure.", null);
    targets = body.pageIds.map((id) => ctx.pages.find((p) => p.summary.id === id)).filter((p): p is DemoPage => !!p);
    if (!targets.length) return ctx.apiError(400, "bad_request", "Ces pages ne font pas partie de l'analyse affichée.", null);
  } else {
    targets = defaultTargets(ctx.pages);
  }
  // 30 pages mesurées par heure et par site.
  const hour = Date.now() - 3600_000;
  st.speedRequests = st.speedRequests.filter((t) => t > hour);
  if (speedMode === "rafale" || st.speedRequests.length + targets.length > 30) {
    const freeAt = st.speedRequests[Math.max(0, st.speedRequests.length + targets.length - 31)] ?? Date.now();
    const left = Math.max(0, 30 - st.speedRequests.length);
    return ctx.apiError(429, "rate_limited", speedMode === "rafale" ? "30 pages ont déjà été mesurées dans l'heure pour ce site." : `Cette demande dépasse la limite de 30 pages mesurées par heure : ${left} ${left > 1 ? "pages peuvent" : "page peut"} encore être mesurée${left > 1 ? "s" : ""}.`, "Patientez avant de relancer la mesure.", { retryAfterSeconds: speedMode === "rafale" ? 1260 : Math.max(1, Math.ceil((freeAt - hour) / 1000)) });
  }
  const now = Date.now();
  st.speedRequests.push(...targets.map(() => now));
  // Les échecs repartent de zéro à chaque demande, jamais à une réussite.
  st.speed.failures = [];
  st.speed.lastError = null;
  st.queue = targets;
  st.speed.running = { done: 0, total: targets.length, currentUrl: targets[0].summary.url };
  schedule(ctx, st);
  return ctx.json(st.speed, 202);
}

/** PageDetail.visits : la page d'arrivée correspondante de la dernière lecture. */
export function visitsFor(ctx: GoogleCtx, pageId: string): PageVisits | null {
  const a = stateOf(ctx).analytics;
  if (!a.available) return null;
  const lp = a.landingPages.find((l) => l.pageId === pageId);
  if (!lp) return null;
  const { path: _p, pageId: _i, score: _s, ...visits } = lp;
  void _p; void _i; void _s;
  return visits;
}

/** PageDetail.speed : les dernières mesures de la page. */
export function speedFor(ctx: GoogleCtx, pageId: string): { mobile: SpeedMeasure | null; desktop: SpeedMeasure | null } | null {
  const p = stateOf(ctx).speed.pages.find((x) => x.pageId === pageId);
  return p ? { mobile: p.mobile, desktop: p.desktop } : null;
}
