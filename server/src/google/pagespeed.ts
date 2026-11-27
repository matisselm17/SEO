/**
 * PageSpeed Insights v5 (docs/format-echange.md, « Vitesse des pages ») :
 * `GET https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=…&strategy=mobile|desktop&category=performance&locale=fr`.
 *
 * - La clé (GOOGLE_PAGESPEED_API_KEY) part dans l'en-tête `x-goog-api-key`, accepté par toutes les API Google,
 *   et non dans l'adresse : elle ne peut donc se retrouver ni dans une adresse journalisée ni dans une trace
 *   d'erreur réseau. Aucun message d'erreur ne reprend un texte d'origine (corps de réponse, exception).
 * - Un seul hôte appelé (www.googleapis.com), sans redirection, 60 s au plus par mesure.
 * - Forme de la réponse (référence pagespeedapi.runpagespeed) : `lighthouseResult.categories.performance.score`
 *   (0 à 1), `lighthouseResult.audits[id]` (`score`, `numericValue`, `scoreDisplayMode`, `details.overallSavingsMs`,
 *   `metricSavings`), `loadingExperience` / `originLoadingExperience` (`metrics.<NOM>.percentile` et `.category`
 *   FAST / AVERAGE / SLOW, `origin_fallback`).
 * - Verdicts : ceux de Google. Laboratoire : score de l'audit ≥ 0,9 bon, ≥ 0,5 à améliorer, sinon lent.
 *   Terrain : catégorie FAST / AVERAGE / SLOW.
 */
import type { SpeedMeasure, SpeedMetric, SpeedRating } from "../../../shared/api.ts";
import { HttpError } from "../errors.ts";
import { GOOGLE_BODY_LIMITS, GoogleAuthError, googleErrorReasons, googleFetch, readJsonBounded } from "./auth.ts";

export const PSI_URL = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
const PSI_HOSTS = new Set(["www.googleapis.com"]);
export const PSI_TIMEOUT_MS = 60_000;
export type Strategy = "mobile" | "desktop";

/** Erreur d'une mesure. `fatal` : inutile de mesurer les pages suivantes (clé refusée, quota épuisé). */
export class PageSpeedError extends HttpError {
  constructor(message: string, retryable: boolean, public fatal = false) {
    super(502, "pagespeed_unavailable", message, retryable ? "Réessayez dans un instant." : fatal ? "Vérifiez la clé GOOGLE_PAGESPEED_API_KEY et l'API « PageSpeed Insights API » dans Google Cloud, puis relancez la mesure." : "Vérifiez que la page s'ouvre normalement dans un navigateur, puis relancez la mesure.", { retryable });
  }
}

export const pagespeedErrors = {
  notConfigured: () =>
    new HttpError(
      503,
      "pagespeed_not_configured",
      "La mesure de vitesse n'est pas configurée sur ce serveur.",
      "La personne qui gère l'installation peut créer une clé d'API Google restreinte à « PageSpeed Insights API », la renseigner dans GOOGLE_PAGESPEED_API_KEY, puis redémarrer le serveur.",
    ),
};

const LAB = { lcp: "largest-contentful-paint", cls: "cumulative-layout-shift", tbt: "total-blocking-time", fcp: "first-contentful-paint" } as const;
const LAB_IDS = new Set<string>([...Object.values(LAB), "speed-index", "interactive", "max-potential-fid"]);
const NOT_ACTIONABLE = new Set(["notApplicable", "informative", "manual", "error"]);

export function labRating(score: number): SpeedRating {
  return score >= 0.9 ? "good" : score >= 0.5 ? "average" : "poor";
}
function fieldRating(category: unknown): SpeedRating | null {
  return category === "FAST" ? "good" : category === "AVERAGE" ? "average" : category === "SLOW" ? "poor" : null;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Texte venu de Google : sans Markdown de liens ni de code, borné. Les chevrons sont gardés (« la balise <script> ») :
 * le texte est affiché échappé par l'interface, jamais interprété comme du HTML.
 */
export function plainText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`+/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

interface Audit {
  score?: number | null;
  numericValue?: number;
  scoreDisplayMode?: string;
  title?: string;
  description?: string;
  details?: { type?: string; overallSavingsMs?: number };
  metricSavings?: Record<string, number>;
}
interface Experience {
  metrics?: Record<string, { percentile?: number; category?: string }>;
  origin_fallback?: boolean;
}

function labMetric(audits: Record<string, Audit>, id: string, unit: "ms" | "cls"): SpeedMetric {
  const a = audits[id];
  if (!a || !isNum(a.numericValue) || !isNum(a.score)) throw new PageSpeedError("Google a renvoyé une mesure incomplète pour cette page.", true);
  return { value: unit === "cls" ? Math.round(a.numericValue * 1000) / 1000 : Math.round(a.numericValue), rating: labRating(a.score) };
}

function fieldMetric(exp: Experience, key: string, unit: "ms" | "cls"): SpeedMetric | null {
  const m = exp.metrics?.[key];
  const rating = fieldRating(m?.category);
  if (!m || !rating || !isNum(m.percentile)) return null;
  // Pour la stabilité, PageSpeed Insights donne le centile multiplié par 100 (5 = 0,05).
  return { value: unit === "cls" ? Math.round(m.percentile) / 100 : Math.round(m.percentile), rating };
}

const hasMetrics = (e: unknown): e is Experience => !!e && typeof e === "object" && !!(e as Experience).metrics && Object.keys((e as Experience).metrics!).length > 0;

/** Conversion d'une réponse de PageSpeed Insights en `SpeedMeasure`. */
export function toMeasure(json: unknown, measuredAt: string): SpeedMeasure {
  const o = (json && typeof json === "object" ? json : {}) as {
    lighthouseResult?: { categories?: { performance?: { score?: number | null } }; audits?: Record<string, Audit>; runtimeError?: { code?: string } };
    loadingExperience?: unknown;
    originLoadingExperience?: unknown;
  };
  const lr = o.lighthouseResult;
  const score = lr?.categories?.performance?.score;
  if (!lr || !isNum(score)) throw new PageSpeedError("Google n'a pas pu charger cette page pour la mesurer.", true);
  const audits = lr.audits && typeof lr.audits === "object" ? lr.audits : {};
  const lab = { lcp: labMetric(audits, LAB.lcp, "ms"), cls: labMetric(audits, LAB.cls, "cls"), tbt: labMetric(audits, LAB.tbt, "ms"), fcp: labMetric(audits, LAB.fcp, "ms") };

  // Terrain : la page elle-même, sauf si Google s'est replié sur tout le site (origin_fallback).
  let field: SpeedMeasure["field"] = null;
  const page = hasMetrics(o.loadingExperience) && !o.loadingExperience.origin_fallback ? o.loadingExperience : null;
  const site = page ? null : hasMetrics(o.originLoadingExperience) ? o.originLoadingExperience : hasMetrics(o.loadingExperience) ? o.loadingExperience : null;
  const exp = page ?? site;
  if (exp) {
    const f = { scope: page ? ("page" as const) : ("site" as const), lcp: fieldMetric(exp, "LARGEST_CONTENTFUL_PAINT_MS", "ms"), inp: fieldMetric(exp, "INTERACTION_TO_NEXT_PAINT", "ms"), cls: fieldMetric(exp, "CUMULATIVE_LAYOUT_SHIFT_SCORE", "cls") };
    if (f.lcp || f.inp || f.cls) field = f;
  }

  const opportunities: SpeedMeasure["opportunities"] = [];
  for (const [id, a] of Object.entries(audits)) {
    if (!a || typeof a !== "object" || LAB_IDS.has(id)) continue;
    if (NOT_ACTIONABLE.has(a.scoreDisplayMode ?? "") || !isNum(a.score) || a.score >= 0.9) continue;
    const ms = isNum(a.details?.overallSavingsMs) ? a.details!.overallSavingsMs! : 0;
    const fromMetrics = a.metricSavings && typeof a.metricSavings === "object"
      ? Math.max(0, ...["LCP", "FCP", "TBT", "INP"].map((k) => (isNum(a.metricSavings![k]) ? a.metricSavings![k] : 0)))
      : 0;
    // overallSavingsMs peut valoir 0 alors que metricSavings annonce un gain : le plus grand des deux l'emporte.
    const savings = Math.max(ms, fromMetrics);
    if (!(a.details?.type === "opportunity" || a.metricSavings) || !(savings > 0)) continue;
    const title = plainText(a.title, 160);
    if (!title) continue;
    opportunities.push({ title, detail: plainText(a.description, 400), savingsMs: Math.round(savings) });
  }
  opportunities.sort((a, b) => (b.savingsMs ?? 0) - (a.savingsMs ?? 0));

  return { measuredAt, score: Math.round(score * 100), lab, field, opportunities: opportunities.slice(0, 5) };
}

export interface PageSpeedOptions {
  apiKey: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

export class PageSpeedClient {
  private readonly fetchImpl: typeof fetch;
  readonly now: () => number;

  constructor(private opts: PageSpeedOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  get configured(): boolean {
    return !!this.opts.apiKey;
  }

  /** Mesure une page pour un type d'appareil. Toute erreur est une `PageSpeedError` au message fixe. */
  async measure(url: string, strategy: Strategy, signal?: AbortSignal): Promise<SpeedMeasure> {
    const key = this.opts.apiKey;
    if (!key) throw pagespeedErrors.notConfigured();
    const q = new URLSearchParams({ url, strategy, category: "performance", locale: "fr" });
    let res: Response;
    try {
      res = await googleFetch(this.fetchImpl, `${PSI_URL}?${q}`, { method: "GET", headers: { accept: "application/json", "x-goog-api-key": key } }, PSI_HOSTS, this.opts.timeoutMs ?? PSI_TIMEOUT_MS, signal);
    } catch (err) {
      if (err instanceof GoogleAuthError) throw new PageSpeedError(err.message.replace("Google", "PageSpeed Insights"), err.retryable);
      throw new PageSpeedError("PageSpeed Insights ne répond pas pour le moment.", true);
    }
    if (!res.ok) {
      const reasons = await googleErrorReasons(res);
      if (reasons.has("API_KEY_INVALID") || reasons.has("keyInvalid")) throw new PageSpeedError("Google refuse la clé PageSpeed Insights.", false, true);
      if (res.status === 403) throw new PageSpeedError("La clé PageSpeed Insights n'est pas autorisée pour cette API (403).", false, true);
      if (res.status === 429) throw new PageSpeedError("Le quota de PageSpeed Insights est atteint pour le moment.", true, true);
      if (res.status === 400) throw new PageSpeedError("Google n'a pas pu charger cette page pour la mesurer.", false);
      throw new PageSpeedError(`PageSpeed Insights a répondu ${res.status}.`, res.status >= 500);
    }
    const read = await readJsonBounded(res, GOOGLE_BODY_LIMITS.pagespeed);
    if (!read.ok) {
      throw read.reason === "too_large"
        ? new PageSpeedError("Réponse de PageSpeed Insights trop volumineuse pour cette page.", false)
        : new PageSpeedError("Réponse illisible de PageSpeed Insights.", true);
    }
    return toMeasure(read.json, new Date(this.now()).toISOString());
  }
}
