/**
 * Search Console en lecture directe, par un compte de service Google (docs/integration-search-console.md).
 *
 * - Jeton OAuth 2.0 obtenu par assertion JWT signée RS256 avec `node:crypto` (aucune dépendance), portée
 *   `webmasters.readonly`, valable une heure, gardé en mémoire et renouvelé avant expiration ou après un refus 401,
 *   une seule demande à la fois (comme server/src/shopify/auth.ts).
 * - Le fichier du compte de service est un secret : jamais journalisé ni renvoyé ; seule l'adresse e-mail du
 *   compte (`client_email`) peut apparaître dans une erreur (`details.account`), pour dire qui ajouter à la propriété.
 * - Les appels ne partent que vers oauth2.googleapis.com et www.googleapis.com (le `token_uri` du fichier est ignoré).
 * - Le résultat est converti dans la structure de l'import de fichier (`GscImport`) et enregistré par le même chemin.
 */
import { createSign } from "node:crypto";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import type { OrganicPoint, OrganicQuery } from "../../../shared/api.ts";
import { bareHost, urlKey } from "../crawl/url.ts";
import { HttpError } from "../errors.ts";
import type { GscImport, ImportedPage } from "./import.ts";

export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const API_BASE = "https://www.googleapis.com/webmasters/v3";
export const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const ALLOWED_HOSTS = new Set(["oauth2.googleapis.com", "www.googleapis.com"]);
const RENEW_MARGIN_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 30_000;
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
      "La personne qui gère l'installation peut déposer le fichier JSON d'un compte de service Google (GOOGLE_SERVICE_ACCOUNT_FILE), puis redémarrer le serveur. En attendant, déposez l'export « Performances ».",
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

// ───────── Compte de service

interface ServiceAccount {
  clientEmail: string;
  privateKey: string;
}

/** Le fichier existe et est lisible (Settings.integrations.searchConsole.configured). */
export function serviceAccountReadable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** Lit le fichier du compte de service ; aucune partie de son contenu n'entre dans une erreur. */
export function loadServiceAccount(file: string): ServiceAccount {
  if (!serviceAccountReadable(file)) throw gscErrors.notConfigured();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw gscErrors.unavailable("Le fichier du compte de service Google est illisible (JSON attendu).", false);
  }
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const clientEmail = typeof o.client_email === "string" && /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(o.client_email) ? o.client_email : null;
  const privateKey = typeof o.private_key === "string" && o.private_key.includes("PRIVATE KEY") ? o.private_key : null;
  if (!clientEmail || !privateKey) throw gscErrors.unavailable("Le fichier du compte de service Google est incomplet (client_email ou private_key manquant).", false);
  return { clientEmail, privateKey };
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** Assertion JWT signée RS256 pour l'échange contre un jeton d'accès. */
export function signAssertion(sa: ServiceAccount, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: sa.clientEmail, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  let sig: Buffer;
  try {
    sig = signer.sign(sa.privateKey);
  } catch {
    throw gscErrors.unavailable("La clé privée du compte de service Google est invalide.", false);
  }
  return `${header}.${claims}.${b64url(sig)}`;
}

// ───────── Client

export interface GoogleOptions {
  file: string;
  property: string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface Row {
  keys?: string[];
  clicks?: number;
  impressions?: number;
  ctr?: number;
  position?: number;
}

export class SearchConsoleClient {
  private token: { value: string; expiresAt: number } | null = null;
  private pending: Promise<string> | null = null;
  private account: ServiceAccount | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private opts: GoogleOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  get configured(): boolean {
    return serviceAccountReadable(this.opts.file);
  }

  private sa(): ServiceAccount {
    // Relu tant qu'il n'a pas servi : un fichier déposé après le démarrage est pris en compte.
    this.account ??= loadServiceAccount(this.opts.file);
    return this.account;
  }

  /** Adresse e-mail du compte de service (la seule partie du fichier qui peut être montrée). */
  accountEmail(): string {
    return this.sa().clientEmail;
  }

  /** Tout appel sortant passe ici : seuls les deux hôtes de Google sont permis. */
  private async call(url: string, init: RequestInit): Promise<Response> {
    const u = new URL(url);
    if (u.protocol !== "https:" || !ALLOWED_HOSTS.has(u.hostname)) throw gscErrors.unavailable("Adresse Google inattendue : appel refusé.", false);
    try {
      return await this.fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw gscErrors.unavailable("Google ne répond pas pour le moment.", true);
    }
  }

  async getToken(): Promise<string> {
    if (this.token && this.token.expiresAt - RENEW_MARGIN_MS > this.now()) return this.token.value;
    this.pending ??= this.requestToken().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async requestToken(): Promise<string> {
    const assertion = signAssertion(this.sa(), this.now());
    const res = await this.call(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
    });
    // Le corps n'est jamais recopié dans l'erreur.
    if (res.status === 400 || res.status === 401 || res.status === 403) throw gscErrors.unavailable(`Google a refusé le compte de service (${res.status}). Vérifiez que la clé est active.`, false);
    if (!res.ok) throw gscErrors.unavailable(`Google a répondu ${res.status} à la demande de jeton.`, res.status >= 500 || res.status === 429);
    const o = ((await res.json().catch(() => null)) ?? {}) as Record<string, unknown>;
    const value = typeof o.access_token === "string" ? o.access_token : "";
    const expiresIn = typeof o.expires_in === "number" && o.expires_in > 0 ? o.expires_in : 0;
    if (!value || !expiresIn) throw gscErrors.unavailable("Réponse inattendue de Google à la demande de jeton.", true);
    this.token = { value, expiresAt: this.now() + expiresIn * 1000 };
    return value;
  }

  /** Appel authentifié à l'API Search Console ; un refus 401 fait redemander un jeton une fois. */
  private async api<T>(path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.getToken();
      const res = await this.call(`${API_BASE}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status === 401 && attempt === 0) {
        if (this.token?.value === token) this.token = null;
        continue;
      }
      if (res.status === 403 || res.status === 404) throw new NoAccess();
      if (res.status === 429) throw gscErrors.unavailable("Google demande de patienter : trop de demandes.", true);
      if (!res.ok) throw gscErrors.unavailable(`Google a répondu ${res.status}.`, res.status >= 500);
      try {
        return (await res.json()) as T;
      } catch {
        throw gscErrors.unavailable("Réponse illisible de Google.", true);
      }
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
    const { start, end } = periodFor(days, this.now());
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
