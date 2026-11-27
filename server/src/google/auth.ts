/**
 * Authentification Google par compte de service, commune à la Search Console et à Google Analytics.
 *
 * - Jeton OAuth 2.0 obtenu par assertion JWT signée RS256 avec `node:crypto` (aucune dépendance), un jeton par
 *   portée (`webmasters.readonly`, `analytics.readonly`), valable une heure, gardé en mémoire, renouvelé avant
 *   expiration ou après un refus 401, une seule demande à la fois par portée.
 * - Le fichier du compte de service est un secret : jamais journalisé ni renvoyé ; seule l'adresse e-mail du
 *   compte (`client_email`) peut apparaître dans une erreur (`details.account`).
 * - Le jeton est demandé à oauth2.googleapis.com uniquement (le `token_uri` du fichier est ignoré).
 * - Les erreurs sont neutres (`GoogleAuthError`) : chaque service les traduit dans ses propres codes.
 */
import { createSign } from "node:crypto";
import { accessSync, constants, readFileSync, statSync } from "node:fs";

export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const SCOPES = {
  searchConsole: "https://www.googleapis.com/auth/webmasters.readonly",
  analytics: "https://www.googleapis.com/auth/analytics.readonly",
} as const;
export type GoogleScope = (typeof SCOPES)[keyof typeof SCOPES];

const RENEW_MARGIN_MS = 5 * 60 * 1000;
export const GOOGLE_TIMEOUT_MS = 30_000;

/**
 * Erreur d'authentification ou de transport, sans aucune partie du fichier ni du corps de réponse.
 * - `not_configured` : fichier absent ou illisible ;
 * - `bad_file` : JSON invalide, champ manquant, clé privée inutilisable ;
 * - `refused` : Google refuse l'assertion (clé révoquée…) ;
 * - `unreachable` : Google ne répond pas (délai, réseau) ;
 * - `unexpected` : réponse inattendue ou statut d'erreur ;
 * - `blocked` : adresse non permise.
 */
export class GoogleAuthError extends Error {
  constructor(
    public kind: "not_configured" | "bad_file" | "refused" | "unreachable" | "unexpected" | "blocked",
    message: string,
    public retryable: boolean,
  ) {
    super(message);
  }
}

export interface ServiceAccount {
  clientEmail: string;
  privateKey: string;
}

/** Le fichier existe et est lisible. */
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
  if (!serviceAccountReadable(file)) throw new GoogleAuthError("not_configured", "Le fichier du compte de service Google est introuvable.", false);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new GoogleAuthError("bad_file", "Le fichier du compte de service Google est illisible (JSON attendu).", false);
  }
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const clientEmail = typeof o.client_email === "string" && /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(o.client_email) ? o.client_email : null;
  const privateKey = typeof o.private_key === "string" && o.private_key.includes("PRIVATE KEY") ? o.private_key : null;
  if (!clientEmail || !privateKey) throw new GoogleAuthError("bad_file", "Le fichier du compte de service Google est incomplet (client_email ou private_key manquant).", false);
  return { clientEmail, privateKey };
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** Assertion JWT signée RS256 pour l'échange contre un jeton d'accès de la portée demandée. */
export function signAssertion(sa: ServiceAccount, nowMs: number, scope: GoogleScope): string {
  const iat = Math.floor(nowMs / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: sa.clientEmail, scope, aud: TOKEN_URL, iat, exp: iat + 3600 }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  let sig: Buffer;
  try {
    sig = signer.sign(sa.privateKey);
  } catch {
    throw new GoogleAuthError("bad_file", "La clé privée du compte de service Google est invalide.", false);
  }
  return `${header}.${claims}.${b64url(sig)}`;
}

/**
 * Appel sortant vers Google : https, hôte de la liste, sans redirection, délai borné. Une erreur réseau devient
 * `unreachable`, sans recopier le message d'origine (qui pourrait contenir l'adresse appelée).
 */
export async function googleFetch(fetchImpl: typeof fetch, url: string, init: RequestInit, allowedHosts: ReadonlySet<string>, timeoutMs = GOOGLE_TIMEOUT_MS, signal?: AbortSignal): Promise<Response> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new GoogleAuthError("blocked", "Adresse Google inattendue : appel refusé.", false);
  }
  if (u.protocol !== "https:" || !allowedHosts.has(u.hostname)) throw new GoogleAuthError("blocked", "Adresse Google inattendue : appel refusé.", false);
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    return await fetchImpl(url, { ...init, redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  } catch {
    if (signal?.aborted) throw new GoogleAuthError("unreachable", "Appel à Google interrompu.", false);
    throw new GoogleAuthError("unreachable", timeout.aborted ? "Google n'a pas répondu à temps." : "Google ne répond pas pour le moment.", true);
  }
}

/**
 * Bornes de taille des réponses de Google lues par le serveur. Au-delà, la lecture s'arrête (flux annulé) :
 * - jeton et corps d'erreur : 64 Kio (quelques centaines d'octets en pratique) ;
 * - rapport Google Analytics : 16 Mio (2 000 lignes de pages d'arrivée tiennent dans quelques centaines de Kio) ;
 * - Search Console : 32 Mio (25 000 lignes par page de résultats) ;
 * - PageSpeed Insights : 24 Mio (une réponse Lighthouse complète, avec ses captures d'écran en base64, fait
 *   couramment 1 à 8 Mio).
 */
export const GOOGLE_BODY_LIMITS = {
  small: 64 * 1024,
  analytics: 16 * 1024 * 1024,
  searchConsole: 32 * 1024 * 1024,
  pagespeed: 24 * 1024 * 1024,
} as const;

/** Lecture bornée d'un corps JSON : `too_large` au-delà de `maxBytes` (sans tout lire), `invalid` s'il est illisible. */
export async function readJsonBounded(res: Response, maxBytes: number): Promise<{ ok: true; json: unknown } | { ok: false; reason: "too_large" | "invalid" }> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, reason: "too_large" };
  }
  if (!res.body) return { ok: false, reason: "invalid" };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "invalid" };
  }
  try {
    return { ok: true, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

/**
 * Motifs d'un refus de Google (`error.status`, `error.errors[].reason`, `error.details[].reason`), pour distinguer
 * « API non activée » de « pas d'accès ». Seuls des mots-clés courts sont gardés ; le corps n'est jamais recopié.
 */
export async function googleErrorReasons(res: Response): Promise<Set<string>> {
  const out = new Set<string>();
  const read = await readJsonBounded(res, GOOGLE_BODY_LIMITS.small);
  const o = (read.ok ? read.json : null) as { error?: { status?: unknown; errors?: unknown; details?: unknown } } | null;
  const keep = (v: unknown) => {
    if (typeof v === "string" && /^[A-Za-z_]{1,64}$/.test(v)) out.add(v);
  };
  const e = o && typeof o === "object" ? o.error : undefined;
  if (e && typeof e === "object") {
    keep(e.status);
    for (const list of [e.errors, e.details]) if (Array.isArray(list)) for (const x of list.slice(0, 20)) if (x && typeof x === "object") keep((x as { reason?: unknown }).reason);
  }
  return out;
}

/** L'API demandée n'est pas activée dans le projet Google Cloud du compte de service. */
export const serviceDisabled = (reasons: Set<string>) => reasons.has("SERVICE_DISABLED") || reasons.has("accessNotConfigured");

export interface GoogleAuthOptions {
  file: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const TOKEN_HOSTS = new Set(["oauth2.googleapis.com"]);

/** Jetons d'accès du compte de service, un par portée. */
export class GoogleServiceAuth {
  private tokens = new Map<GoogleScope, { value: string; expiresAt: number }>();
  private pending = new Map<GoogleScope, Promise<string>>();
  private account: ServiceAccount | null = null;
  readonly fetchImpl: typeof fetch;
  readonly now: () => number;

  constructor(private opts: GoogleAuthOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  /** Fichier présent et lisible. */
  get readable(): boolean {
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

  async getToken(scope: GoogleScope): Promise<string> {
    const t = this.tokens.get(scope);
    if (t && t.expiresAt - RENEW_MARGIN_MS > this.now()) return t.value;
    let p = this.pending.get(scope);
    if (!p) {
      p = this.requestToken(scope).finally(() => this.pending.delete(scope));
      this.pending.set(scope, p);
    }
    return p;
  }

  /** Oublie ce jeton s'il est toujours le jeton courant (après un refus 401). */
  dropToken(scope: GoogleScope, value: string): void {
    if (this.tokens.get(scope)?.value === value) this.tokens.delete(scope);
  }

  private async requestToken(scope: GoogleScope): Promise<string> {
    const assertion = signAssertion(this.sa(), this.now(), scope);
    const res = await googleFetch(
      this.fetchImpl,
      TOKEN_URL,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
      },
      TOKEN_HOSTS,
    );
    // Le corps n'est jamais recopié dans l'erreur.
    if (res.status === 400 || res.status === 401 || res.status === 403) throw new GoogleAuthError("refused", `Google a refusé le compte de service (${res.status}). Vérifiez que la clé est active.`, false);
    if (!res.ok) throw new GoogleAuthError("unexpected", `Google a répondu ${res.status} à la demande de jeton.`, res.status >= 500 || res.status === 429);
    const read = await readJsonBounded(res, GOOGLE_BODY_LIMITS.small);
    const o = ((read.ok && read.json && typeof read.json === "object" ? read.json : null) ?? {}) as Record<string, unknown>;
    const value = typeof o.access_token === "string" ? o.access_token : "";
    const expiresIn = typeof o.expires_in === "number" && o.expires_in > 0 ? o.expires_in : 0;
    if (!value || !expiresIn) throw new GoogleAuthError("unexpected", "Réponse inattendue de Google à la demande de jeton.", true);
    this.tokens.set(scope, { value, expiresAt: this.now() + expiresIn * 1000 });
    return value;
  }
}
