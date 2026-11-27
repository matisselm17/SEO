/**
 * Google Analytics 4 en lecture seule (docs/format-echange.md, « Google Analytics »), par l'API Data v1beta :
 * `POST https://analyticsdata.googleapis.com/v1beta/properties/{id}:runReport`, portée `analytics.readonly`,
 * même compte de service que la Search Console (server/src/google/auth.ts).
 *
 * Noms de l'API (https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema) :
 * dimensions `sessionDefaultChannelGroup`, `landingPage`, `hostName`, `date` (AAAAMMJJ) ; métriques `sessions`,
 * `totalUsers`, `engagementRate` (fraction entre 0 et 1), `keyEvents`, `purchaseRevenue` ; devise dans
 * `metadata.currencyCode` de la réponse.
 *
 * Quatre rapports, tous limités à l'hôte du site (`hostName`, avec et sans www) :
 *  1. par origine (avec le total exact calculé par Google, `metricAggregations: TOTAL`) ;
 *  2. série quotidienne par origine (visites) ;
 *  3. pages d'arrivée (toutes origines) ;
 *  4. pages d'arrivée, origine « Organic Search » seulement (visites).
 * Si le rapport 1 ne trouve aucune visite sur l'hôte, un seul rapport non filtré, sans dimension (une ligne au
 * plus), dit si la propriété a des visites ailleurs (`analytics_other_site`) ou aucune (site neuf : lecture à zéro).
 *
 * Google omet les lignes à zéro : la série est complétée côté serveur, un jour par jour de la période. Les pages
 * d'arrivée de même clé de chemin (casse, slash final, paramètres) sont additionnées avant d'être tronquées.
 * Le corps des réponses de Google n'est jamais recopié dans une erreur ; tout texte venu de Google est une
 * donnée non fiable, gardée comme texte brut borné.
 */
import type { AnalyticsData, LandingPage, VisitTotals } from "../../../shared/api.ts";
import { bareHost } from "../crawl/url.ts";
import { pathKey } from "../shopify/repo.ts";
import { HttpError } from "../errors.ts";
import { GOOGLE_BODY_LIMITS, GoogleAuthError, googleErrorReasons, googleFetch, GoogleServiceAuth, readJsonBounded, SCOPES, serviceDisabled } from "./auth.ts";

export const ANALYTICS_BASE = "https://analyticsdata.googleapis.com/v1beta";
const API_HOSTS = new Set(["analyticsdata.googleapis.com"]);
export const ANALYTICS_DAYS = [28, 90] as const;
export const ORGANIC_CHANNEL = "Organic Search";
const METRICS = ["sessions", "totalUsers", "engagementRate", "keyEvents", "purchaseRevenue"] as const;
export const MAX_LANDING_PAGES = 200;
/** Lignes demandées pour les rapports de pages d'arrivée. */
export const LANDING_ROW_LIMIT = 2000;

export const analyticsErrors = {
  notConfigured: () =>
    new HttpError(
      503,
      "analytics_not_configured",
      "La lecture de Google Analytics n'est pas configurée sur ce serveur.",
      "La personne qui gère l'installation peut renseigner GA4_PROPERTY_ID (identifiant numérique de la propriété) et le fichier du compte de service Google (GOOGLE_APPLICATION_CREDENTIALS), puis redémarrer le serveur.",
    ),
  noAccess: (account: string) =>
    new HttpError(
      403,
      "analytics_no_access",
      "Le compte de service n'a pas accès à cette propriété Google Analytics.",
      `Dans Google Analytics : Administration → Gestion des accès à la propriété → Ajouter des utilisateurs, saisissez ${account} avec le rôle « Lecteur », puis réessayez.`,
      { account },
    ),
  otherSite: (host: string) =>
    new HttpError(
      409,
      "analytics_other_site",
      `La propriété Google Analytics configurée ne reçoit aucune visite sur ${host} pendant cette période.`,
      "Vérifiez que GA4_PROPERTY_ID désigne bien la propriété de ce site (Administration → Détails de la propriété), puis réessayez.",
    ),
  unavailable: (message: string, retryable: boolean) =>
    new HttpError(502, "analytics_unavailable", message, retryable ? "Réessayez dans un instant." : "Vérifiez le compte de service et l'API « Google Analytics Data API » dans Google Cloud, puis réessayez.", { retryable }),
};

function fromAuth(err: unknown): unknown {
  if (!(err instanceof GoogleAuthError)) return err;
  if (err.kind === "not_configured") return analyticsErrors.notConfigured();
  return analyticsErrors.unavailable(err.message, err.retryable);
}

/** Ce qui est enregistré : les pages d'arrivée sans rapprochement (refait à l'affichage). */
export type StoredAnalytics = Omit<Extract<AnalyticsData, { available: true }>, "available" | "landingPages"> & {
  landingPages: Array<Omit<LandingPage, "pageId" | "score">>;
};

interface ReportRow {
  dimensionValues?: Array<{ value?: string }>;
  metricValues?: Array<{ value?: string }>;
}
interface Report {
  rows?: ReportRow[];
  /** Nombre total de lignes du rapport chez Google, au-delà de `limit`. */
  rowCount?: number;
  totals?: ReportRow[];
  metadata?: { currencyCode?: string; schemaRestrictionResponse?: { activeMetricRestrictions?: Array<{ restrictedMetricTypes?: string[] }> } };
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10);
/** Période lue : `days` jours se terminant la veille. */
export function analyticsPeriod(days: number, now: number): { start: string; end: string } {
  const endMs = now - 86_400_000;
  return { start: day(endMs - (days - 1) * 86_400_000), end: day(endMs) };
}

const num = (v: unknown) => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : 0;
};
const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;
// eslint-disable-next-line no-control-regex
const clean = (v: unknown, max = 300) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "");

export interface AnalyticsOptions {
  auth: GoogleServiceAuth;
  propertyId: string | null;
}

export class AnalyticsClient {
  constructor(private opts: AnalyticsOptions) {}

  /** Fichier du compte de service lisible et identifiant numérique de propriété présent. */
  get configured(): boolean {
    return !!this.opts.propertyId && /^\d+$/.test(this.opts.propertyId) && this.opts.auth.readable;
  }

  private accountEmail(): string {
    try {
      return this.opts.auth.accountEmail();
    } catch (err) {
      throw fromAuth(err);
    }
  }

  private async runReport(body: unknown): Promise<Report> {
    const id = this.opts.propertyId;
    if (!id || !/^\d+$/.test(id)) throw analyticsErrors.notConfigured();
    const auth = this.opts.auth;
    for (let attempt = 0; ; attempt++) {
      let token: string;
      let res: Response;
      try {
        token = await auth.getToken(SCOPES.analytics);
        res = await googleFetch(auth.fetchImpl, `${ANALYTICS_BASE}/properties/${id}:runReport`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify(body),
        }, API_HOSTS);
      } catch (err) {
        throw fromAuth(err);
      }
      if (res.status === 401 && attempt === 0) {
        auth.dropToken(SCOPES.analytics, token);
        continue;
      }
      if (res.status === 403 || res.status === 404) {
        if (res.status === 403 && serviceDisabled(await googleErrorReasons(res))) {
          throw analyticsErrors.unavailable("L'API « Google Analytics Data API » n'est pas activée dans le projet Google Cloud du compte de service.", false);
        }
        throw analyticsErrors.noAccess(this.accountEmail());
      }
      if (res.status === 429) throw analyticsErrors.unavailable("Google Analytics demande de patienter : trop de demandes.", true);
      if (!res.ok) throw analyticsErrors.unavailable(`Google Analytics a répondu ${res.status}.`, res.status >= 500);
      const read = await readJsonBounded(res, GOOGLE_BODY_LIMITS.analytics);
      if (!read.ok) {
        throw read.reason === "too_large"
          ? analyticsErrors.unavailable("Réponse trop volumineuse de Google Analytics.", false)
          : analyticsErrors.unavailable("Réponse illisible de Google Analytics.", true);
      }
      const o = read.json as Report;
      return o && typeof o === "object" ? o : {};
    }
  }

  /** Lit les visites du site `host` sur `days` jours (se terminant la veille). */
  async read(host: string, days: number, now = this.opts.auth.now()): Promise<Omit<StoredAnalytics, "syncedAt">> {
    if (!this.configured) throw analyticsErrors.notConfigured();
    const own = bareHost(host);
    const period = analyticsPeriod(days, now);
    const dateRanges = [{ startDate: period.start, endDate: period.end }];
    const hostFilter = { filter: { fieldName: "hostName", inListFilter: { values: [own, `www.${own}`], caseSensitive: false } } };
    const organicFilter = {
      andGroup: { expressions: [hostFilter, { filter: { fieldName: "sessionDefaultChannelGroup", stringFilter: { matchType: "EXACT", value: ORGANIC_CHANNEL } } }] },
    };
    const metrics = METRICS.map((name) => ({ name }));
    const bySessions = [{ metric: { metricName: "sessions" }, desc: true }];

    const channels = await this.runReport({
      dateRanges, dimensions: [{ name: "sessionDefaultChannelGroup" }], metrics, dimensionFilter: hostFilter, metricAggregations: ["TOTAL"], orderBys: bySessions, limit: "100",
    });
    if (!channels.rows?.length || (num(channels.totals?.[0]?.metricValues?.[0]?.value) <= 0 && sumSessions(channels.rows) <= 0)) {
      // Aucune visite sur l'hôte : la propriété en a-t-elle ailleurs ? Rapport sans dimension ni filtre, une ligne.
      const all = await this.runReport({ dateRanges, metrics: [{ name: "sessions" }], limit: "1" });
      if (sumSessions(all.rows ?? []) > 0) throw analyticsErrors.otherSite(own);
      // Site neuf : aucune visite du tout, la lecture réussit à zéro.
      return toAnalytics({ channels: { metadata: channels.metadata }, series: {}, landing: {}, landingOrganic: {} }, period);
    }
    const series = await this.runReport({
      dateRanges, dimensions: [{ name: "date" }, { name: "sessionDefaultChannelGroup" }], metrics: [{ name: "sessions" }], dimensionFilter: hostFilter, limit: "10000",
    });
    const landing = await this.runReport({
      dateRanges, dimensions: [{ name: "landingPage" }], metrics, dimensionFilter: hostFilter, orderBys: bySessions, limit: String(LANDING_ROW_LIMIT),
    });
    const landingOrganic = await this.runReport({
      dateRanges, dimensions: [{ name: "landingPage" }], metrics: [{ name: "sessions" }], dimensionFilter: organicFilter, orderBys: bySessions, limit: String(LANDING_ROW_LIMIT),
    });
    return toAnalytics({ channels, series, landing, landingOrganic }, period);
  }
}

const sumSessions = (rows: ReportRow[]) => rows.reduce((a, r) => a + num(r.metricValues?.[0]?.value), 0);

/** Valeurs d'une ligne dans l'ordre de METRICS ; `revenue` null si les ventes ne sont pas mesurées. */
function totalsOf(r: ReportRow | undefined, revenueMeasured: boolean): VisitTotals {
  const v = (i: number) => num(r?.metricValues?.[i]?.value);
  return {
    sessions: Math.round(v(0)),
    users: Math.round(v(1)),
    engagementRate: round(Math.min(1, Math.max(0, v(2))), 4),
    keyEvents: round(v(3), 2),
    revenue: revenueMeasured ? round(v(4), 2) : null,
  };
}

/**
 * Conversion des quatre rapports. `revenue` vaut null partout quand aucune vente n'est mesurée : chiffre
 * d'affaires d'achat (`purchaseRevenue`) nul sur tout le site pendant la période, ou métrique de revenu masquée
 * au compte de service (restriction REVENUE_DATA). Google renvoie 0 dans ces deux cas ; 0 ne prouverait pas
 * qu'aucune vente n'a eu lieu, seulement qu'aucune n'est mesurée.
 */
export function toAnalytics(r: { channels: Report; series: Report; landing: Report; landingOrganic: Report }, period: { start: string; end: string }): Omit<StoredAnalytics, "syncedAt"> {
  const restricted = (r.channels.metadata?.schemaRestrictionResponse?.activeMetricRestrictions ?? []).some((m) => (m.restrictedMetricTypes ?? []).includes("REVENUE_DATA"));
  const channelRows = r.channels.rows ?? [];
  const totalRow = r.channels.totals?.[0];
  const revenueTotal = totalRow ? num(totalRow.metricValues?.[4]?.value) : channelRows.reduce((a, x) => a + num(x.metricValues?.[4]?.value), 0);
  const revenueMeasured = !restricted && revenueTotal > 0;
  const revenueStatus: StoredAnalytics["revenueStatus"] = restricted ? "restricted" : revenueMeasured ? "measured" : "not_measured";
  const currencyRaw = r.channels.metadata?.currencyCode;
  const currency = typeof currencyRaw === "string" && /^[A-Z]{3}$/.test(currencyRaw) ? currencyRaw : null;

  const channels = channelRows
    .map((row) => ({ channel: clean(row.dimensionValues?.[0]?.value, 80) || "(not set)", ...totalsOf(row, revenueMeasured) }))
    .filter((c) => c.sessions > 0 || c.users > 0)
    .sort((a, b) => b.sessions - a.sessions);
  const totals: VisitTotals = totalRow ? totalsOf(totalRow, revenueMeasured) : totalsOf(undefined, revenueMeasured);
  if (!totalRow) totals.sessions = channels.reduce((a, c) => a + c.sessions, 0);
  const organicChannel = channels.find((c) => c.channel === ORGANIC_CHANNEL);
  const organic: VisitTotals = organicChannel
    ? { sessions: organicChannel.sessions, users: organicChannel.users, engagementRate: organicChannel.engagementRate, keyEvents: organicChannel.keyEvents, revenue: organicChannel.revenue }
    : totalsOf(undefined, revenueMeasured);

  // Série : un point par jour de la période, à 0 les jours que Google omet (aucune visite).
  const byDate = new Map<string, { sessions: number; organicSessions: number }>();
  for (const date of daysOf(period)) byDate.set(date, { sessions: 0, organicSessions: 0 });
  for (const row of r.series.rows ?? []) {
    const raw = clean(row.dimensionValues?.[0]?.value, 8);
    if (!/^\d{8}$/.test(raw)) continue;
    const cur = byDate.get(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`);
    if (!cur) continue; // hors de la période demandée
    const s = Math.round(num(row.metricValues?.[0]?.value));
    cur.sessions += s;
    if (clean(row.dimensionValues?.[1]?.value, 80) === ORGANIC_CHANNEL) cur.organicSessions += s;
  }
  const series = [...byDate.entries()].map(([date, v]) => ({ date, ...v }));

  const organicByKey = new Map<string, number>();
  for (const row of r.landingOrganic.rows ?? []) {
    const path = clean(row.dimensionValues?.[0]?.value, 2048);
    if (!path.startsWith("/")) continue;
    const key = pathKey(path);
    organicByKey.set(key, (organicByKey.get(key) ?? 0) + Math.round(num(row.metricValues?.[0]?.value)));
  }
  // Seuls les chemins sont gardés : « (not set) » et autres valeurs sans chemin ne désignent aucune page.
  const rawPages = (r.landing.rows ?? [])
    .map((row) => ({ path: clean(row.dimensionValues?.[0]?.value, 2048), ...totalsOf(row, revenueMeasured), organicSessions: 0 }))
    .filter((p) => p.path.startsWith("/"));
  const merged = mergeLandingPages(rawPages).map((p) => ({ ...p, organicSessions: organicByKey.get(pathKey(p.path)) ?? 0 }));
  const all = merged.filter((p) => p.sessions > 0).sort((a, b) => b.organicSessions - a.organicSessions || b.sessions - a.sessions);
  const limitHit = (rep: Report) => {
    const n = rep.rows?.length ?? 0;
    return n >= LANDING_ROW_LIMIT || (typeof rep.rowCount === "number" && rep.rowCount > n);
  };
  const landingPagesTruncated = all.length > MAX_LANDING_PAGES || limitHit(r.landing) || limitHit(r.landingOrganic);
  const landingPages = all.slice(0, MAX_LANDING_PAGES);

  return { period, currency, totals, organic, channels, series, landingPages, landingPagesTruncated, revenueStatus };
}

/** Jours de `start` à `end` inclus (AAAA-MM-JJ, UTC). */
export function daysOf(period: { start: string; end: string }): string[] {
  const out: string[] = [];
  const end = Date.parse(`${period.end}T00:00:00Z`);
  for (let t = Date.parse(`${period.start}T00:00:00Z`); Number.isFinite(t) && t <= end && out.length < 1000; t += 86_400_000) out.push(day(t));
  return out;
}

type StoredLanding = StoredAnalytics["landingPages"][number];

/**
 * Additionne les pages d'arrivée de même clé de chemin (casse, slash final, paramètres, comme le rapprochement
 * avec l'analyse). Le chemin gardé est celui de la ligne la plus visitée. Visites, visiteurs, événements clés,
 * chiffre d'affaires et visites organiques s'additionnent ; le taux d'engagement est pondéré par les visites.
 * Les visiteurs sont une somme de lignes : un même visiteur arrivé par deux variantes du chemin compte deux fois.
 */
export function mergeLandingPages<T extends StoredLanding>(pages: T[]): T[] {
  const byKey = new Map<string, { main: T; sum: T; engaged: number; topSessions: number }>();
  for (const p of pages) {
    const key = pathKey(p.path);
    const cur = byKey.get(key);
    if (!cur) {
      byKey.set(key, { main: p, sum: { ...p }, engaged: p.engagementRate * p.sessions, topSessions: p.sessions });
      continue;
    }
    const s = cur.sum;
    s.sessions += p.sessions;
    s.users += p.users;
    s.keyEvents = round(s.keyEvents + p.keyEvents, 2);
    s.revenue = s.revenue === null || p.revenue === null ? (s.revenue ?? p.revenue) : round(s.revenue + p.revenue, 2);
    s.organicSessions += p.organicSessions;
    cur.engaged += p.engagementRate * p.sessions;
    if (p.sessions > cur.topSessions) {
      cur.topSessions = p.sessions;
      cur.main = p;
    }
  }
  return [...byKey.values()].map(({ main, sum, engaged }) => ({
    ...sum,
    path: main.path,
    engagementRate: sum.sessions > 0 ? round(Math.min(1, Math.max(0, engaged / sum.sessions)), 4) : sum.engagementRate,
  }));
}
