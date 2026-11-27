/**
 * Protection et transport HTTP : origine des requêtes qui modifient, type de contenu, taille du corps
 * limitée au fil de la lecture, en-têtes de sécurité, compression, limites par minute.
 */
import { brotliCompressSync, constants as zc, gzipSync } from "node:zlib";
import type { MiddlewareHandler } from "hono";
import { HttpError } from "./errors.ts";

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

/** En-têtes de sécurité sur toutes les réponses. */
export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  const h = c.res.headers;
  h.set("Content-Security-Policy", CSP);
  h.set("Referrer-Policy", "no-referrer");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Frame-Options", "DENY");
};

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

/** Limite par fenêtre glissante d'une minute. */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private perMinute: number,
    private now: () => number = Date.now,
  ) {}

  /** Lève rate_limited si la limite est atteinte ; sinon compte la demande. */
  take(key: string, what: string): void {
    const t = this.now();
    const list = (this.hits.get(key) ?? []).filter((x) => t - x < 60_000);
    if (list.length >= this.perMinute) {
      const retry = Math.max(1, Math.ceil((list[0] + 60_000 - t) / 1000));
      this.hits.set(key, list);
      throw new HttpError(429, "rate_limited", `Trop de demandes ${what} en peu de temps.`, `Patientez ${retry} seconde${retry > 1 ? "s" : ""}, puis réessayez.`, {
        retryAfterSeconds: retry,
      });
    }
    list.push(t);
    this.hits.set(key, list);
  }
}
