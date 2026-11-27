/**
 * Lecture du catalogue public d'une boutique Shopify (/products.json, paginé).
 * Mêmes protections que le reste du parcours (adresses publiques seulement, taille et délai limités).
 * Le contenu est une donnée non fiable : seuls le nom, le texte de la description (sans balises, jamais
 * interprété), et les textes alternatifs des images en sont tirés.
 */
import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import { FetchError, safeFetch } from "../net/fetch.ts";
import { DEFAULT_RETRY, isTransientStatus, parseRetryAfter, sleep, Throttle } from "./throttle.ts";

/** Un produit tel que lu dans le catalogue, réduit à ce qui sert aux constats. */
export interface CatalogueProduct {
  handle: string;
  url: string;
  path: string;
  title: string;
  /** Début du texte de la description, sans balises (pour les preuves). */
  descExcerpt: string;
  descChars: number;
  descWords: number;
  /** Empreinte du texte complet normalisé ; null si la description est vide. Sert aux doublons. */
  descHash: string | null;
  images: number;
  /** Adresses des images sans texte alternatif (au plus 5). */
  imagesNoAlt: string[];
  imagesNoAltCount: number;
}

export interface RawProduct {
  handle: string;
  title: string;
  descText: string;
  images: Array<{ src: string; alt: string }>;
}

export const CATALOGUE_LIMITS = { pageSize: 250, maxPages: 40, timeoutMs: 20_000, maxBytes: 12 * 1024 * 1024 };

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** Texte lisible d'une description HTML. Le HTML n'est jamais exécuté : seul son texte est extrait. */
export function htmlToText(html: string): string {
  if (!html) return "";
  const $ = cheerio.load(html.slice(0, 200_000));
  $("script,style,noscript,template,iframe").remove();
  // Les blocs séparent des mots : on insère une espace avant d'extraire le texte.
  $("p,div,br,li,h1,h2,h3,h4,h5,h6,tr,td").each((_, el) => {
    $(el).prepend(" ");
    $(el).append(" ");
  });
  return squash($.root().text());
}

const str = (v: unknown, max = 2000) => (typeof v === "string" ? v.slice(0, max) : "");

/** Valide un produit du catalogue ; null s'il est inutilisable. */
export function parseProduct(raw: unknown): RawProduct | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const handle = str(p.handle, 255).trim();
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._~%-]*$/u.test(handle)) return null;
  const images = Array.isArray(p.images)
    ? p.images.slice(0, 250).flatMap((im) => {
        if (!im || typeof im !== "object") return [];
        const o = im as Record<string, unknown>;
        const src = str(o.src, 1000).trim();
        return src ? [{ src, alt: squash(str(o.alt, 1000)) }] : [];
      })
    : [];
  return { handle, title: squash(str(p.title, 500)), descText: htmlToText(str(p.body_html, 200_000)), images };
}

/** Réduit un produit lu à ce qui sert aux constats. `url` et `path` désignent sa page dans la langue principale. */
export function toCatalogueProduct(p: RawProduct, url: string, path: string): CatalogueProduct {
  const words = p.descText ? p.descText.split(" ").filter((w) => /[\p{L}\p{N}]/u.test(w)).length : 0;
  const norm = p.descText.toLowerCase();
  const noAlt = p.images.filter((i) => !i.alt);
  return {
    handle: p.handle,
    url,
    path,
    title: p.title,
    descExcerpt: p.descText.slice(0, 160),
    descChars: p.descText.length,
    descWords: words,
    descHash: norm ? createHash("sha1").update(norm).digest("base64url") : null,
    images: p.images.length,
    imagesNoAlt: noAlt.slice(0, 5).map((i) => i.src),
    imagesNoAltCount: noAlt.length,
  };
}

/** Résultat de la lecture du catalogue. */
export type CatalogueResult =
  | { ok: true; products: RawProduct[]; complete: boolean }
  /** Illisible : `reason` est la cause réelle (statut HTTP ou type d'erreur, jamais le contenu reçu) ; `transient` : refus passager encore présent après les nouvelles tentatives. */
  | { ok: false; reason: string; transient: boolean };

type PageOutcome =
  | { kind: "ok"; list: unknown[] }
  | { kind: "permanent"; reason: string }
  | { kind: "transient"; reason: string; retryAfterMs: number | null };

/** Une page du catalogue, sans nouvelle tentative. */
async function fetchCataloguePage(url: string, signal: AbortSignal): Promise<PageOutcome> {
  let res;
  try {
    res = await safeFetch(url, {
      signal,
      timeoutMs: CATALOGUE_LIMITS.timeoutMs,
      maxBytes: CATALOGUE_LIMITS.maxBytes,
      accept: "application/json",
      // Une redirection (vers la page du mot de passe, par exemple) n'est pas suivie.
      shouldFollow: () => false,
      // Le corps d'une erreur n'est jamais lu.
      acceptBody: (status) => status === 200,
    });
  } catch (err) {
    const kind = err instanceof FetchError ? err.kind : "network";
    // Délai dépassé ou coupure réseau : passager. Adresse refusée, trop lourde… : définitif.
    if (kind === "timeout" || kind === "network") return { kind: "transient", reason: `erreur ${kind}`, retryAfterMs: null };
    return { kind: "permanent", reason: `erreur ${kind}` };
  }
  if (isTransientStatus(res.status)) return { kind: "transient", reason: `HTTP ${res.status}`, retryAfterMs: parseRetryAfter(res.headers["retry-after"]) };
  if (res.status >= 300 && res.status < 400) return { kind: "permanent", reason: `redirection HTTP ${res.status}${/\/password(\/|$|\?)/.test(new URL(res.url).pathname) ? " vers la page du mot de passe" : ""}` };
  if (res.status !== 200) return { kind: "permanent", reason: `HTTP ${res.status}` };
  if (!/json/.test(res.contentType)) return { kind: "permanent", reason: "réponse qui n'est pas du JSON" };
  let data: unknown;
  try {
    data = JSON.parse(res.body.toString("utf8"));
  } catch {
    return { kind: "permanent", reason: "JSON illisible" };
  }
  const raw = data && typeof data === "object" ? (data as Record<string, unknown>).products : null;
  if (!Array.isArray(raw)) return { kind: "permanent", reason: "JSON sans liste de produits" };
  return { kind: "ok", list: raw };
}

/**
 * Lit /products.json page par page jusqu'à une page vide (ou incomplète).
 * Un refus passager (429, 503, délai dépassé) est retenté après une pause, selon le rythme adaptatif de l'analyse.
 * `ok: false` si la première page n'est pas lisible ; `complete` vaut false si la lecture s'est arrêtée avant la fin
 * (plafond, erreur en cours de route). Chaque échec est journalisé côté serveur avec sa cause (jamais le contenu).
 */
export async function readShopifyCatalogue(
  origin: string,
  opts: { signal: AbortSignal; pageSize?: number; maxPages?: number; onPage?(url: string): void; throttle?: Throttle },
): Promise<CatalogueResult> {
  const pageSize = opts.pageSize ?? CATALOGUE_LIMITS.pageSize;
  const maxPages = opts.maxPages ?? CATALOGUE_LIMITS.maxPages;
  const throttle = opts.throttle ?? new Throttle(DEFAULT_RETRY, 1, 0);
  const host = new URL(origin).host;
  const products: RawProduct[] = [];
  const handles = new Set<string>();
  for (let page = 1; page <= maxPages; page++) {
    const url = new URL(`/products.json?limit=${pageSize}&page=${page}`, origin).href;
    let list: unknown[] | null = null;
    for (let attempt = 0; ; attempt++) {
      await throttle.waitPause(opts.signal);
      if (opts.signal.aborted) return page === 1 ? { ok: false, reason: "analyse arrêtée", transient: false } : { ok: true, products, complete: false };
      opts.onPage?.(url);
      const epoch = throttle.epoch;
      const out = await fetchCataloguePage(url, opts.signal);
      if (opts.signal.aborted) return page === 1 ? { ok: false, reason: "analyse arrêtée", transient: false } : { ok: true, products, complete: false };
      if (out.kind === "ok") {
        if (attempt > 0) console.info(`[catalogue] ${host} page ${page} lue après ${attempt} nouvelle(s) tentative(s)`);
        list = out.list;
        break;
      }
      if (out.kind === "permanent") {
        console.warn(`[catalogue] ${host} page ${page} illisible : ${out.reason}`);
        return page === 1 ? { ok: false, reason: out.reason, transient: false } : { ok: true, products, complete: false };
      }
      const d = throttle.onRefusal({ attempt, retryAfterMs: out.retryAfterMs, startedEpoch: epoch, pool: "catalogue" });
      if (!d.retry) {
        console.warn(`[catalogue] ${host} page ${page} refusée (${out.reason}), abandon après ${attempt} nouvelle(s) tentative(s) : ${d.why}`);
        return page === 1 ? { ok: false, reason: out.reason, transient: true } : { ok: true, products, complete: false };
      }
      console.info(`[catalogue] ${host} page ${page} refusée (${out.reason}), nouvelle tentative dans ${Math.round(d.pauseMs / 100) / 10} s`);
      // Pas de pause commune (refus d'une requête partie avant) : on attend au moins le délai courant.
      if (throttle.pauseLeftMs() <= 0) await sleep(d.pauseMs, opts.signal);
    }
    let added = 0;
    for (const r of list.slice(0, pageSize)) {
      const p = parseProduct(r);
      if (!p || handles.has(p.handle)) continue;
      handles.add(p.handle);
      products.push(p);
      added++;
    }
    // Page vide ou incomplète : fin du catalogue.
    if (!list.length || list.length < pageSize) return { ok: true, products, complete: true };
    // Rien de nouveau sur une page pleine : la boutique ignore la pagination, la suite n'est pas lisible.
    if (!added) return { ok: true, products, complete: false };
    // Entre deux pages du catalogue : le délai courant de l'analyse.
    await sleep(throttle.delayMs, opts.signal);
  }
  return { ok: true, products, complete: false };
}
