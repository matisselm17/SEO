/**
 * Chargement d'une adresse externe, avec garde-fous :
 * - seulement http(s), hôte public vérifié avant la requête puis à la connexion (résolution DNS) ;
 * - redirections suivies à la main, chacune revérifiée ;
 * - délai d'expiration, taille maximale, User-Agent identifiable.
 * Le contenu reçu est une donnée non fiable : il n'est jamais exécuté.
 */
import dns from "node:dns";
import type { LookupAddress } from "node:dns";
import { Agent, request } from "undici";
import { isInternalHostname, isPrivateIp } from "./address.ts";

export const USER_AGENT = "Mozilla/5.0 (compatible; ChatSEOBot/0.1; audit SEO a la demande)";
export const ROBOTS_TOKEN = "chatseobot";

let allowPrivate = false;
/** Réservé au développement (ALLOW_PRIVATE_HOSTS=1) : autorise localhost et les plages privées. */
export function setAllowPrivateHosts(value: boolean): void {
  allowPrivate = value;
}
export function privateHostsAllowed(): boolean {
  return allowPrivate;
}

/** Réservé aux tests automatisés : noms d'hôte locaux traités comme publics (jamais lu depuis l'environnement). */
let trustedForTests = new Set<string>();
export function __setTrustedHostsForTests(hosts: string[]): void {
  trustedForTests = new Set(hosts.map((h) => h.toLowerCase()));
}
const bypass = (hostname: string) => allowPrivate || trustedForTests.has(hostname.toLowerCase());

export class FetchError extends Error {
  constructor(
    public kind: "blocked" | "invalid" | "timeout" | "network" | "too_large" | "too_many_redirects" | "aborted",
    message: string,
  ) {
    super(message);
  }
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** Résolution DNS qui refuse toute adresse interne : appliquée à chaque connexion. */
export function guardedLookup(hostname: string, options: dns.LookupOptions, callback: LookupCb): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    const list = addresses as LookupAddress[];
    if (!bypass(hostname) && list.some((a) => isPrivateIp(a.address))) {
      const e: NodeJS.ErrnoException = new Error("Adresse interne refusée");
      e.code = "EPRIVATEADDR";
      return callback(e, "", 0);
    }
    if (options.all) return callback(null, list);
    const first = list[0];
    if (!first) {
      const e: NodeJS.ErrnoException = new Error("Aucune adresse");
      e.code = "ENOTFOUND";
      return callback(e, "", 0);
    }
    callback(null, first.address, first.family);
  });
}

const agent = new Agent({
  connect: { lookup: guardedLookup as never, timeout: 10_000 },
  headersTimeout: 15_000,
  bodyTimeout: 15_000,
  keepAliveTimeout: 4_000,
  connections: 8,
});

/** Vérifie qu'une adresse peut être chargée ; renvoie l'objet URL ou lève FetchError. */
export function assertFetchable(raw: string | URL): URL {
  let url: URL;
  try {
    url = typeof raw === "string" ? new URL(raw) : raw;
  } catch {
    throw new FetchError("invalid", "Adresse mal formée");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new FetchError("invalid", "Seules les adresses http et https sont acceptées");
  if (url.username || url.password) throw new FetchError("invalid", "Les identifiants dans l'adresse ne sont pas acceptés");
  if (!bypass(url.hostname) && isInternalHostname(url.hostname)) throw new FetchError("blocked", "Adresse interne refusée");
  return url;
}

export interface FetchResult {
  status: number;
  /** Adresse finale, après redirections. */
  url: string;
  contentType: string;
  headers: Record<string, string>;
  body: Buffer;
  redirects: number;
}

export interface FetchOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  accept?: string;
  /** Appelé avant de suivre une redirection : renvoyer false pour s'arrêter (ex. page déjà connue). */
  shouldFollow?: (next: URL) => boolean;
  /** Appelé avant de lire le corps : renvoyer false pour ne pas le télécharger (ex. type non HTML). */
  acceptBody?: (status: number, contentType: string) => boolean;
}

/** Abandonne un corps de réponse sans lever d'erreur non interceptée. */
function discard(body: NodeJS.ReadableStream & { destroy(): void }): void {
  body.on("error", () => undefined);
  body.destroy();
}

function headerValue(h: Record<string, string | string[] | undefined>, name: string): string {
  const v = h[name];
  return Array.isArray(v) ? v.join(", ") : (v ?? "");
}

export async function safeFetch(rawUrl: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const maxRedirects = opts.maxRedirects ?? 5;
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  let url = assertFetchable(rawUrl);
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

  for (let redirects = 0; ; redirects++) {
    let res;
    try {
      res = await request(url, {
        method: "GET",
        dispatcher: agent,
        signal,
        headers: {
          "user-agent": USER_AGENT,
          accept: opts.accept ?? "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
          "accept-language": "fr,en;q=0.8",
          "accept-encoding": "identity",
        },
      });
    } catch (err) {
      throw translate(err, signal, opts.signal);
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers)) headers[k] = Array.isArray(v) ? v.join(", ") : String(v ?? "");
    const status = res.statusCode;
    if (status >= 300 && status < 400 && headers.location) {
      discard(res.body);
      if (redirects >= maxRedirects) throw new FetchError("too_many_redirects", "Trop de redirections");
      let next: URL;
      try {
        next = new URL(headers.location, url);
      } catch {
        throw new FetchError("invalid", "Redirection vers une adresse mal formée");
      }
      url = assertFetchable(next);
      if (opts.shouldFollow && !opts.shouldFollow(url)) {
        return { status, url: url.href, contentType: "", headers, body: Buffer.alloc(0), redirects: redirects + 1 };
      }
      continue;
    }
    const contentType = headerValue(res.headers, "content-type").toLowerCase();
    if (opts.acceptBody && !opts.acceptBody(status, contentType)) {
      discard(res.body);
      return { status, url: url.href, contentType, headers, body: Buffer.alloc(0), redirects };
    }
    const declared = Number(headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) {
      discard(res.body);
      throw new FetchError("too_large", "Page trop lourde");
    }
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of res.body) {
        const buf = chunk as Buffer;
        size += buf.length;
        if (size > maxBytes) {
          discard(res.body);
          throw new FetchError("too_large", "Page trop lourde");
        }
        chunks.push(buf);
      }
    } catch (err) {
      if (err instanceof FetchError) throw err;
      throw translate(err, signal, opts.signal);
    }
    return { status, url: url.href, contentType, headers, body: Buffer.concat(chunks), redirects };
  }
}

function translate(err: unknown, signal: AbortSignal, userSignal?: AbortSignal): FetchError {
  if (err instanceof FetchError) return err;
  if (userSignal?.aborted) return new FetchError("aborted", "Chargement annulé");
  if (signal.aborted) return new FetchError("timeout", "Délai dépassé");
  const e = err as { code?: string; cause?: { code?: string } };
  const code = e?.code ?? e?.cause?.code;
  if (code === "EPRIVATEADDR") return new FetchError("blocked", "Adresse interne refusée");
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return new FetchError("network", "Nom de domaine introuvable");
  if (code === "ECONNREFUSED") return new FetchError("network", "Connexion refusée");
  if (code === "UND_ERR_CONNECT_TIMEOUT" || code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT")
    return new FetchError("timeout", "Délai dépassé");
  if (code && /CERT/i.test(code)) return new FetchError("network", "Certificat de sécurité invalide");
  if (code && /SSL|TLS/i.test(code)) return new FetchError("network", "Connexion sécurisée impossible");
  return new FetchError("network", "Connexion impossible");
}

/** Décode un corps HTML selon le charset déclaré (en-tête ou balise meta), UTF-8 par défaut. */
export function decodeHtml(body: Buffer, contentType: string): string {
  let charset = /charset=([\w-]+)/i.exec(contentType)?.[1];
  if (!charset) {
    const head = body.subarray(0, 2048).toString("latin1");
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder((charset ?? "utf-8").toLowerCase()).decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}
