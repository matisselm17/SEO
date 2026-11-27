/**
 * Search Console en lecture directe, par un compte de service Google (docs/integration-search-console.md).
 *
 * - Authentification commune (server/src/google/auth.ts) : jeton de portée `webmasters.readonly`, gardé en
 *   mémoire et renouvelé avant expiration ou après un refus 401.
 * - Le fichier du compte de service est un secret : jamais journalisé ni renvoyé ; seule l'adresse e-mail du
 *   compte (`client_email`) peut apparaître dans une erreur (`details.account`), pour dire qui ajouter à la propriété.
 * - Les appels ne partent que vers oauth2.googleapis.com et www.googleapis.com (le `token_uri` du fichier est ignoré).
 * - Le résultat est converti dans la structure de l'import de fichier (`GscImport`) et enregistré par le même chemin.
 */
import type { OrganicPoint, OrganicQuery } from "../../../shared/api.ts";
import { bareHost, urlKey } from "../crawl/url.ts";
import { HttpError } from "../errors.ts";
import { GOOGLE_BODY_LIMITS, GoogleAuthError, googleErrorReasons, googleFetch, GoogleServiceAuth, readJsonBounded, SCOPES, serviceDisabled } from "../google/auth.ts";
import type { GscImport, ImportedPage } from "./import.ts";

export const API_BASE = "https://www.googleapis.com/webmasters/v3";
export const SCOPE = SCOPES.searchConsole;
const API_HOSTS = new Set(["www.googleapis.com"]);
const ROW_LIMIT = 25_000;
/** Lignes au plus par dimension (pages × requêtes peut être très long sur 16 mois). */
const MAX_ROWS: Record<string, number> = { date: 25_000, query: 50_000, page: 50_000, "page,query": 100_000 };
export const ALLOWED_DAYS = [28, 90, 480] as const;

// ───────── Erreurs

export const gscErrors = {
  notConfigured: () =>
    new HttpError(
      503,
      "search_console_not_configured",
      "La lecture directe de la Search Console n'est pas configurée sur ce serveur.",
      "La personne qui gère l'installation peut déposer le fichier JSON d'un compte de service Google (GOOGLE_APPLICATION_CREDENTIALS), puis redémarrer le serveur. En attendant, déposez l'export « Performances ».",
    ),
  noAccess: (host: string, account: string) =>
    new HttpError(
      403,
      "search_console_no_access",
      `Le compte de service n'a accès à aucune propriété Search Console de ${host}.`,
      `Dans la Search Console de ${host} : Paramètres → Utilisateurs et autorisations → Ajouter un utilisateur, saisissez ${account} avec l'autorisation « Limité » (lecture seule), puis réessayez.`,
      { account },
    ),
  unavailable: (message: string, retryable: boolean) =>
    new HttpError(502, "search_console_unavailable", message, retryable ? "Réessayez dans un instant." : "Vérifiez le compte de service et l'API « Google Search Console API » dans Google Cloud, puis réessayez.", { retryable }),
};

/** Traduit une erreur d'authentification neutre en erreur de la Search Console. */
function fromAuth(err: unknown): unknown {
  if (!(err instanceof GoogleAuthError)) return err;
  if (err.kind === "not_configured") return gscErrors.notConfigured();
  return gscErrors.unavailable(err.message, err.retryable);
}

// ───────── Client

export interface GoogleOptions {
  file: string;
  property: string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Authentification partagée avec Google Analytics ; construite depuis `file` si absente. */
  auth?: GoogleServiceAuth;
}

interface Row {
  keys?: string[];
  clicks?: number;
  impressions?: number;
  ctr?: number;
  position?: number;
}

export class SearchConsoleClient {
  readonly auth: GoogleServiceAuth;

  constructor(private opts: GoogleOptions) {
    this.auth = opts.auth ?? new GoogleServiceAuth({ file: opts.file, fetchImpl: opts.fetchImpl, now: opts.now });
  }

  get configured(): boolean {
    return this.auth.readable;
  }

  /** Adresse e-mail du compte de service (la seule partie du fichier qui peut être montrée). */
  accountEmail(): string {
    try {
      return this.auth.accountEmail();
    } catch (err) {
      throw fromAuth(err);
    }
  }

  async getToken(): Promise<string> {
    try {
      return await this.auth.getToken(SCOPE);
    } catch (err) {
      throw fromAuth(err);
    }
  }

  /** Appel authentifié à l'API Search Console ; un refus 401 fait redemander un jeton une fois. */
  private async api<T>(path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.getToken();
      let res: Response;
      try {
        res = await googleFetch(this.auth.fetchImpl, `${API_BASE}${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
          body: body === undefined ? undefined : JSON.stringify(body),
        }, API_HOSTS);
      } catch (err) {
        throw fromAuth(err);
      }
      if (res.status === 401 && attempt === 0) {
        this.auth.dropToken(SCOPE, token);
        continue;
      }
      if (res.status === 403 && serviceDisabled(await googleErrorReasons(res))) {
        throw gscErrors.unavailable("L'API « Google Search Console API » n'est pas activée dans le projet Google Cloud du compte de service.", false);
      }
      if (res.status === 403 || res.status === 404) throw new NoAccess();
      if (res.status === 429) throw gscErrors.unavailable("Google demande de patienter : trop de demandes.", true);
      if (!res.ok) throw gscErrors.unavailable(`Google a répondu ${res.status}.`, res.status >= 500);
      const read = await readJsonBounded(res, GOOGLE_BODY_LIMITS.searchConsole);
      if (!read.ok) throw gscErrors.unavailable(read.reason === "too_large" ? "Réponse de Google trop volumineuse." : "Réponse illisible de Google.", read.reason !== "too_large");
      return read.json as T;
    }
  }

  /** Propriété à lire pour cet hôte : GSC_PROPERTY s'il correspond, sinon la première trouvée dans sites.list. */
  async resolveProperty(host: string): Promise<string> {
    const own = bareHost(host);
    const fixed = this.opts.property;
    if (fixed && propertyHost(fixed) === own) return fixed;
    let list: { siteEntry?: Array<{ siteUrl?: string; permissionLevel?: string }> };
    try {
      list = await this.api("/sites");
    } catch (err) {
      if (err instanceof NoAccess) throw gscErrors.noAccess(own, this.accountEmail());
      throw err;
    }
    const usable = new Set((list.siteEntry ?? []).filter((e) => typeof e.siteUrl === "string" && e.permissionLevel !== "siteUnverifiedUser").map((e) => e.siteUrl!));
    for (const candidate of [`sc-domain:${own}`, `https://${own}/`, `https://www.${own}/`, `http://${own}/`, `http://www.${own}/`]) {
      if (usable.has(candidate)) return candidate;
    }
    throw gscErrors.noAccess(own, this.accountEmail());
  }

  private async query(property: string, dims: string[], start: string, end: string): Promise<Row[]> {
    const out: Row[] = [];
    const cap = MAX_ROWS[dims.join(",")] ?? 25_000;
    for (let startRow = 0; startRow < cap; startRow += ROW_LIMIT) {
      let data: { rows?: Row[] };
      try {
        data = await this.api(`/sites/${encodeURIComponent(property)}/searchAnalytics/query`, { startDate: start, endDate: end, dimensions: dims, rowLimit: ROW_LIMIT, startRow, type: "web" });
      } catch (err) {
        if (err instanceof NoAccess) throw gscErrors.noAccess(propertyHost(property) ?? property, this.accountEmail());
        throw err;
      }
      const rows = Array.isArray(data.rows) ? data.rows : [];
      out.push(...rows);
      if (rows.length < ROW_LIMIT) break;
    }
    return out;
  }

  /** Quatre lectures (date ; requête ; page ; page + requête) converties en `GscImport`. */
  async read(host: string, days: number): Promise<{ property: string; data: GscImport }> {
    const property = await this.resolveProperty(host);
    const { start, end } = periodFor(days, this.auth.now());
    const [dates, queries, pages, pairs] = [
      await this.query(property, ["date"], start, end),
      await this.query(property, ["query"], start, end),
      await this.query(property, ["page"], start, end),
      await this.query(property, ["page", "query"], start, end),
    ];
    return { property, data: toImport({ dates, queries, pages, pairs }, host, { start, end }) };
  }
}

class NoAccess extends Error {}

/** Hôte (sans www) d'une propriété « sc-domain:hôte » ou « https://hôte/… » ; null si illisible. */
export function propertyHost(p: string): string | null {
  if (p.startsWith("sc-domain:")) return bareHost(p.slice("sc-domain:".length).trim()) || null;
  try {
    return bareHost(new URL(p).hostname);
  } catch {
    return null;
  }
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Période lue : se termine il y a deux jours (Google publie avec retard), `days` jours en tout. */
export function periodFor(days: number, now: number): { start: string; end: string } {
  const endMs = now - 2 * 86_400_000;
  return { start: day(endMs - (days - 1) * 86_400_000), end: day(endMs) };
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
/** Texte venu de Google : donnée non fiable, gardée comme texte brut borné. */
// eslint-disable-next-line no-control-regex
const clean = (v: unknown, max = 500) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "");
const metrics = (r: Row) => ({ clicks: num(r.clicks), impressions: num(r.impressions), ctr: round4(num(r.ctr)), position: round1(num(r.position)) });
const byClicks = <T extends { clicks: number; impressions: number }>(a: T, b: T) => b.clicks - a.clicks || b.impressions - a.impressions;

/** Conversion des quatre lectures dans la structure que produit l'import de fichier. */
export function toImport(r: { dates: Row[]; queries: Row[]; pages: Row[]; pairs: Row[] }, host: string, period: { start: string; end: string }): GscImport {
  const own = bareHost(host);
  const onSite = (u: string) => {
    try {
      const x = new URL(u);
      return (x.protocol === "https:" || x.protocol === "http:") && bareHost(x.hostname) === own;
    } catch {
      return false;
    }
  };
  const series: OrganicPoint[] = [];
  let posWeighted = 0;
  let impTotal = 0;
  for (const row of r.dates) {
    const date = clean(row.keys?.[0], 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const m = metrics(row);
    series.push({ date, clicks: m.clicks, impressions: m.impressions });
    posWeighted += num(row.position) * m.impressions;
    impTotal += m.impressions;
  }
  series.sort((a, b) => a.date.localeCompare(b.date));
  const queries: OrganicQuery[] = r.queries.map((row) => ({ query: clean(row.keys?.[0]), ...metrics(row) })).filter((q) => q.query).sort(byClicks);
  const pages: ImportedPage[] = r.pages.map((row) => ({ url: clean(row.keys?.[0], 2048), ...metrics(row) })).filter((p) => onSite(p.url)).sort(byClicks);
  const pageQueries: Record<string, OrganicQuery[]> = {};
  for (const row of r.pairs) {
    const url = clean(row.keys?.[0], 2048);
    const query = clean(row.keys?.[1]);
    if (!query || !onSite(url)) continue;
    const key = urlKey(url);
    if (!key) continue;
    (pageQueries[key] ??= []).push({ query, ...metrics(row) });
  }
  for (const k of Object.keys(pageQueries)) pageQueries[k] = pageQueries[k].sort(byClicks).slice(0, 200);
  return {
    period: series.length ? { start: series[0].date, end: series[series.length - 1].date } : period,
    series: series.length ? series : null,
    queries,
    pages,
    seriesPosition: impTotal ? round1(posWeighted / impTotal) : null,
    files: ["Search Console (lecture directe)"],
    pageQueries,
  };
}
