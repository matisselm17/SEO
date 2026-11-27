/**
 * Lecture du catalogue public d'une boutique Shopify (/products.json, paginé).
 * Mêmes protections que le reste du parcours (adresses publiques seulement, taille et délai limités).
 * Le contenu est une donnée non fiable : seuls le nom, le texte de la description (sans balises, jamais
 * interprété), et les textes alternatifs des images en sont tirés.
 */
import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import { safeFetch } from "../net/fetch.ts";

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

/**
 * Lit /products.json page par page jusqu'à une page vide (ou incomplète).
 * Renvoie null si le catalogue n'est pas lisible (désactivé, autre plateforme, erreur dès la première page).
 * `complete` vaut false si la lecture s'est arrêtée avant la fin (plafond, erreur en cours de route).
 */
export async function readShopifyCatalogue(
  origin: string,
  opts: { signal: AbortSignal; pageSize?: number; maxPages?: number; onPage?(url: string): void },
): Promise<{ products: RawProduct[]; complete: boolean } | null> {
  const pageSize = opts.pageSize ?? CATALOGUE_LIMITS.pageSize;
  const maxPages = opts.maxPages ?? CATALOGUE_LIMITS.maxPages;
  const products: RawProduct[] = [];
  const handles = new Set<string>();
  for (let page = 1; page <= maxPages; page++) {
    if (opts.signal.aborted) return page === 1 ? null : { products, complete: false };
    const url = new URL(`/products.json?limit=${pageSize}&page=${page}`, origin).href;
    opts.onPage?.(url);
    let list: unknown[];
    try {
      const res = await safeFetch(url, {
        signal: opts.signal,
        timeoutMs: CATALOGUE_LIMITS.timeoutMs,
        maxBytes: CATALOGUE_LIMITS.maxBytes,
        accept: "application/json",
        // Une redirection (vers la page du mot de passe, par exemple) n'est pas suivie.
        shouldFollow: () => false,
      });
      if (res.status !== 200 || !/json/.test(res.contentType)) throw new Error("not json");
      const data = JSON.parse(res.body.toString("utf8")) as unknown;
      const raw = data && typeof data === "object" ? (data as Record<string, unknown>).products : null;
      if (!Array.isArray(raw)) throw new Error("bad shape");
      list = raw;
    } catch {
      return page === 1 ? null : { products, complete: false };
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
    if (!list.length || list.length < pageSize) return { products, complete: true };
    // Rien de nouveau sur une page pleine : la boutique ignore la pagination, la suite n'est pas lisible.
    if (!added) return { products, complete: false };
  }
  return { products, complete: false };
}
