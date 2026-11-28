/**
 * Protection et transport HTTP : origine des requêtes qui modifient, type de contenu, taille du corps
 * limitée au fil de la lecture, en-têtes de sécurité, compression, limites par minute.
 */
import { brotliCompressSync, constants as zc, gzipSync } from "node:zlib";
import type { Context, MiddlewareHandler } from "hono";
import { HttpError } from "./errors.ts";
import { parseShopDomain } from "./shopify/auth.ts";
import { verifySessionToken } from "./shopify/session.ts";

export const JSON_LIMIT = 64 * 1024;
export const UPLOAD_LIMIT = 21 * 1024 * 1024;

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export const CSP = [
  "default-src 'self'",
  // Polices et petites images intégrées en data: dans la feuille de style compilée.
  // Seules les vignettes de la boutique Shopify viennent d'ailleurs ; l'interface n'affiche que cet hôte.
  "img-src 'self' data: https://cdn.shopify.com",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** Domaine de l'administration Shopify, qui affiche l'application intégrée dans un cadre. */
export const SHOPIFY_ADMIN_ORIGIN = "https://admin.shopify.com";
/** Script App Bridge, chargé par index.html en mode intégré. */
export const APP_BRIDGE_SRC = "https://cdn.shopify.com/shopifycloud/app-bridge.js";

/**
 * Politique de sécurité du mode intégré : App Bridge depuis cdn.shopify.com. `frameAncestors` : liste de la directive
 * `frame-ancestors` (`'none'` pour tout ce qui n'est pas la page de l'application).
 */
export function embeddedCsp(frameAncestors: string): string {
  return CSP.split("; ")
    .map((d) => (d === "frame-ancestors 'none'" ? `frame-ancestors ${frameAncestors}` : d))
    .concat("script-src 'self' https://cdn.shopify.com")
    .join("; ");
}

/**
 * Mode intégré : `frame-ancestors` de la page de l'application. La boutique vient du paramètre `shop` de l'adresse
 * s'il a la forme `xxx.myshopify.com` (il ne sert qu'à cet en-tête, jamais à identifier la requête) ; sinon
 * l'administration Shopify seule.
 */
export function appFrameAncestors(url: string): string {
  let shop: string | null = null;
  try {
    const raw = new URL(url).searchParams.get("shop");
    // Forme exacte seulement : ni majuscules, ni schéma, ni espace (la valeur va telle quelle dans un en-tête).
    shop = raw !== null && parseShopDomain(raw) === raw ? raw : null;
  } catch {
    shop = null;
  }
  return shop ? `https://${shop} ${SHOPIFY_ADMIN_ORIGIN}` : SHOPIFY_ADMIN_ORIGIN;
}

/** Page de l'application (index.html servi pour une route de l'interface) : hors /api et de type HTML. */
function isAppPage(c: Context): boolean {
  const p = c.req.path;
  if (p === "/api" || p.startsWith("/api/")) return false;
  return (c.res.headers.get("content-type") ?? "").toLowerCase().startsWith("text/html");
}

/**
 * En-têtes de sécurité sur toutes les réponses. Mode local : aucun cadre permis (`frame-ancestors 'none'`,
 * `X-Frame-Options: DENY`). Mode intégré : pas de `X-Frame-Options` (qui ne sait pas exprimer une liste) ; la page de
 * l'application peut s'afficher dans l'administration Shopify et la boutique qui l'ouvre, tout le reste
 * (`/api`, fichiers) a `frame-ancestors 'none'`.
 */
export function securityHeadersFor(embedded: boolean): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const h = c.res.headers;
    h.set("Content-Security-Policy", embedded ? embeddedCsp(isAppPage(c) ? appFrameAncestors(c.req.url) : "'none'") : CSP);
    h.set("Referrer-Policy", "no-referrer");
    h.set("X-Content-Type-Options", "nosniff");
    if (embedded) {
      h.delete("X-Frame-Options");
      // Mode intégré (servi en HTTPS derrière Shopify) : le navigateur n'emploie plus jamais HTTP pour ce domaine.
      h.set("Strict-Transport-Security", HSTS);
    } else h.set("X-Frame-Options", "DENY");
  };
}

/** Valeur de Strict-Transport-Security en mode intégré (docs/format-echange.md, « Exploitation », « Transport »). */
export const HSTS = "max-age=31536000";

/** En-têtes de sécurité du mode local. */
export const securityHeaders: MiddlewareHandler = securityHeadersFor(false);

/**
 * Mode intégré, sur /api : une réponse d'une boutique n'est jamais resservie à une autre depuis un cache
 * (`Cache-Control: private, no-cache`, `Vary: Authorization`). Les flux SSE gardent `no-cache` (pas de mise en tampon
 * par un cache) ; ni compression ni corps ne sont touchés.
 */
export const privateApiCache: MiddlewareHandler = async (c, next) => {
  await next();
  const h = c.res.headers;
  h.set("Cache-Control", "private, no-cache");
  const vary = (h.get("vary") ?? "").split(",").map((v) => v.trim().toLowerCase());
  if (!vary.includes("authorization")) h.append("Vary", "Authorization");
};

/** En-tête qui demande à App Bridge un jeton de session neuf et de rejouer la requête une fois. */
export const RETRY_SESSION_HEADER = "X-Shopify-Retry-Invalid-Session-Request";

/** Refus d'identification : jamais la vérification qui a échoué, jamais le jeton ni le secret. */
export const sessionErrors = {
  unauthorized: () =>
    new HttpError(401, "unauthorized", "Votre session Shopify n'est pas valide ou a expiré.", "Rechargez l'application depuis votre administration Shopify."),
  /** Réservé à la désinstallation (lot C) : non émis pour l'instant. */
  shopNotAllowed: () =>
    new HttpError(403, "shop_not_allowed", "Cette application n'est pas ouverte depuis la boutique qu'elle sert.", "Ouvrez l'application depuis l'administration de la boutique concernée."),
};

/** Variables de contexte déposées par les gardes : `shop`, boutique du jeton de session vérifié (mode intégré). */
export type AppEnv = { Variables: { shop?: string } };

export interface SessionGuardOptions {
  clientId: string;
  secret: string;
  now?: () => number;
  /**
   * Appelé après une vérification réussie, avec la boutique du jeton ; `rejected` (Shopify refuse le jeton à
   * l'échange) donne un 401.
   */
  onSession?: (shop: string, token: string) => Promise<"ok" | "rejected">;
}

const BEARER = /^Bearer ([A-Za-z0-9_.-]{1,4096})$/;

/**
 * Mode intégré : jeton de session Shopify obligatoire sur toutes les routes où ce garde est monté (/api/*, flux SSE
 * et routes inconnues comprises). Seul l'en-tête `Authorization: Bearer` est lu : jamais un paramètre d'adresse.
 */
export function guardSession(opts: SessionGuardOptions): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const m = BEARER.exec(c.req.header("authorization") ?? "");
    if (!m) throw sessionErrors.unauthorized();
    const token = m[1];
    const check = verifySessionToken(token, { secret: opts.secret, clientId: opts.clientId, now: opts.now });
    if (!check.ok) throw sessionErrors.unauthorized();
    // La boutique de la requête : celle du jeton vérifié, et rien d'autre (adresse, corps, en-tête).
    if (opts.onSession && (await opts.onSession(check.shop, token)) === "rejected") throw sessionErrors.unauthorized();
    c.set("shop", check.shop);
    return next();
  };
}

/** Port de l'interface de développement (Vite), qui relaie /api en gardant l'en-tête Host d'origine. */
export const DEV_UI_PORT = "5173";

/**
 * Protection contre le rebond DNS : une page tierce qui fait pointer son propre nom vers 127.0.0.1 envoie
 * toujours son nom dans l'en-tête Host. Seuls sont acceptés :
 * - localhost, 127.0.0.1 et [::1], sans port, sur le port du serveur, ou sur le port de l'interface de
 *   développement (5173 : le relais de Vite transmet le Host du navigateur, `changeOrigin: false`) ;
 * - les hôtes déclarés dans ALLOWED_HOSTS (avec ou sans port ; sans port, tout port est accepté).
 * S'applique à toutes les méthodes, lectures comprises.
 */
export function hostAllowed(hostHeader: string | undefined, serverPort: number, allowed: string[]): boolean {
  if (!hostHeader) return false;
  const raw = hostHeader.trim().toLowerCase();
  let hostname: string;
  let port: string;
  try {
    const u = new URL(`http://${raw}`);
    if (u.host !== raw && `${u.hostname}:80` !== raw) return false; // rien d'autre qu'un hôte et un port
    hostname = u.hostname;
    port = u.port || (raw.endsWith(":80") ? "80" : "");
  } catch {
    return false;
  }
  if (["localhost", "127.0.0.1", "[::1]"].includes(hostname)) {
    return port === "" || port === String(serverPort) || port === DEV_UI_PORT;
  }
  return allowed.some((a) => a === raw || a === hostname);
}

export function guardHost(serverPort: number, allowed: string[]): MiddlewareHandler {
  return async (c, next) => {
    if (!hostAllowed(c.req.header("host") ?? new URL(c.req.url).host, serverPort, allowed)) {
      throw new HttpError(
        403,
        "bad_request",
        "Cette adresse n'est pas autorisée à joindre le serveur.",
        "Ouvrez l'application depuis son adresse habituelle. Pour un hébergement, déclarez son nom dans ALLOWED_HOSTS.",
      );
    }
    return next();
  };
}

/**
 * Requêtes qui modifient : l'en-tête Origin, s'il est présent, doit être celui du serveur
 * (même hôte que la requête) ; le type de contenu doit être JSON, ou multipart pour le dépôt de fichier.
 */
export function guardMutations(isUpload: (path: string, method: string) => boolean): MiddlewareHandler {
  return async (c, next) => {
    const method = c.req.method;
    if (!MUTATING.has(method)) return next();
    const origin = c.req.header("origin");
    if (origin !== undefined) {
      let originHost: string | null = null;
      try {
        originHost = origin === "null" ? null : new URL(origin).host.toLowerCase();
      } catch {
        originHost = null;
      }
      const hosts = [c.req.header("host"), c.req.header("x-forwarded-host")]
        .filter((h): h is string => !!h)
        .flatMap((h) => h.split(","))
        .map((h) => h.trim().toLowerCase());
      if (!originHost || !hosts.includes(originHost)) {
        throw new HttpError(403, "bad_request", "Cette demande vient d'un autre site et a été refusée.", "Utilisez l'application depuis sa propre adresse.");
      }
    }
    const type = (c.req.header("content-type") ?? "").toLowerCase();
    const upload = isUpload(c.req.path, method);
    const ok = upload ? type.startsWith("multipart/form-data") : type.startsWith("application/json");
    if (!ok) {
      throw new HttpError(
        415,
        "bad_request",
        upload ? "Le fichier doit être envoyé dans un formulaire (multipart/form-data, champ « file »)." : "La requête doit être envoyée en JSON (content-type: application/json).",
        null,
      );
    }
    return next();
  };
}

/**
 * Limite la taille du corps au fil de la lecture : rien n'est gardé au-delà de la limite,
 * et la lecture s'arrête dès qu'elle est dépassée (corps « chunked » compris).
 */
export function limitBody(limitFor: (path: string) => number): MiddlewareHandler {
  return async (c, next) => {
    const raw = c.req.raw;
    if (!raw.body || !MUTATING.has(c.req.method)) return next();
    const max = limitFor(c.req.path);
    const tooLarge = () =>
      max > JSON_LIMIT
        ? new HttpError(413, "file_too_large", "Ce fichier dépasse 20 Mo.", "Exportez une période plus courte, ou déposez seulement le .zip de l'onglet « Performances ».")
        : new HttpError(413, "bad_request", "La requête est trop volumineuse.", null);
    const declared = raw.headers.get("content-length");
    if (declared !== null && !raw.headers.has("transfer-encoding") && Number(declared) > max) {
      void raw.body.cancel().catch(() => undefined);
      c.header("connection", "close");
      throw tooLarge();
    }
    const reader = raw.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        void reader.cancel().catch(() => undefined);
        chunks.length = 0;
        c.header("connection", "close");
        throw tooLarge();
      }
      chunks.push(value);
    }
    const body = new Uint8Array(size);
    let off = 0;
    for (const ch of chunks) {
      body.set(ch, off);
      off += ch.byteLength;
    }
    c.req.raw = new Request(raw.url, { method: raw.method, headers: raw.headers, body, signal: raw.signal });
    return next();
  };
}

const COMPRESSIBLE = /^(text\/(html|css|plain|javascript)|application\/(json|javascript|manifest\+json)|image\/svg\+xml)/;

/** Compression brotli ou gzip des réponses texte. Les flux SSE ne sont jamais compressés ni mis en tampon. */
export const compress: MiddlewareHandler = async (c, next) => {
  await next();
  const res = c.res;
  const type = res.headers.get("content-type") ?? "";
  if (!res.body || res.status === 204 || res.status === 304 || res.headers.has("content-encoding")) return;
  if (type.includes("text/event-stream") || !COMPRESSIBLE.test(type)) return;
  const accept = (c.req.header("accept-encoding") ?? "").toLowerCase();
  const enc = /\bbr\b/.test(accept) ? "br" : /\bgzip\b/.test(accept) ? "gzip" : null;
  if (!enc) return;
  const buf = Buffer.from(await res.arrayBuffer());
  const headers = new Headers(res.headers);
  headers.append("vary", "Accept-Encoding");
  if (buf.length < 1024) {
    c.res = new Response(buf, { status: res.status, headers });
    return;
  }
  const out = enc === "br" ? brotliCompressSync(buf, { params: { [zc.BROTLI_PARAM_QUALITY]: 5 } }) : gzipSync(buf, { level: 6 });
  headers.set("content-encoding", enc);
  headers.delete("content-length");
  c.res = new Response(out, { status: res.status, headers });
};

/** Limite par fenêtre glissante (une minute par défaut ; `windowMs` pour une autre durée, ex. une heure). */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private perMinute: number,
    private now: () => number = Date.now,
    private windowMs = 60_000,
  ) {}

  /** Millisecondes avant qu'une demande de plus soit permise (0 : tout de suite). */
  waitMs(key: string): number {
    const t = this.now();
    const list = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    this.hits.set(key, list);
    return list.length < this.perMinute ? 0 : Math.max(1, list[0] + this.windowMs - t);
  }

  /**
   * Cadence plutôt que refus : attend qu'une place se libère dans la minute, puis compte la demande.
   * Partagé avec `take` : les écritures isolées et celles d'un lot entrent dans la même limite.
   * Renvoie false si `signal` interrompt l'attente (rien n'est compté).
   */
  async acquire(key: string, signal?: AbortSignal, sleep: (ms: number) => Promise<void> = defaultSleep): Promise<boolean> {
    for (;;) {
      if (signal?.aborted) return false;
      const wait = this.waitMs(key);
      if (wait === 0) {
        this.hits.get(key)!.push(this.now());
        return true;
      }
      await sleep(Math.min(wait, 5_000));
    }
  }

  /** Lève rate_limited si la limite est atteinte ; sinon compte la demande. */
  take(key: string, what: string): void {
    const t = this.now();
    const list = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (list.length >= this.perMinute) {
      const retry = Math.max(1, Math.ceil((list[0] + this.windowMs - t) / 1000));
      this.hits.set(key, list);
      throw new HttpError(429, "rate_limited", `Trop de demandes ${what} en peu de temps.`, retry >= 120 ? `Patientez ${Math.ceil(retry / 60)} minutes, puis réessayez.` : `Patientez ${retry} seconde${retry > 1 ? "s" : ""}, puis réessayez.`, {
        retryAfterSeconds: retry,
      });
    }
    list.push(t);
    this.hits.set(key, list);
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
