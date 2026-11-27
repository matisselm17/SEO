/**
 * Sauvegarde en lecture seule de la boutique, avant tout essai d'écriture réel : pour chaque élément, son
 * identifiant Shopify, son type, son chemin, son nom, son titre et sa description pour Google (valeur exacte, type et
 * présence du metafield), chaque image avec son texte alternatif, et les traductions de ces deux champs.
 * Aucune écriture : seul `shopifyGraphql` (qui refuse toute mutation) est utilisé. Aucun secret dans le résultat.
 */
import type { ShopifyResourceType } from "../../../shared/api.ts";
import {
  allMedia,
  paginate,
  pathFor,
  Q_ARTICLES,
  Q_COLLECTIONS,
  Q_PAGES,
  Q_PRODUCTS,
  readLocales,
  readTranslations,
  type ArticleNode,
  type CollectionNode,
  type Gql,
  type MetaNode,
  type PageNode,
  type ProductNode,
} from "./read.ts";

export interface BackupMeta {
  present: boolean;
  /** Valeur exacte, sans aucune transformation ; null si le metafield n'existe pas. */
  value: string | null;
  type: string | null;
  metafieldId: string | null;
}
export interface BackupItem {
  gid: string;
  type: ShopifyResourceType;
  path: string;
  title: string;
  seoTitle: BackupMeta;
  seoDescription: BackupMeta;
  images: Array<{ gid: string | null; url: string | null; alt: string | null }>;
  /** Par langue publiée autre que la principale : traduction exacte (null si absente) et « périmée ». */
  translations: Record<string, { seoTitle: { value: string | null; outdated: boolean } | null; seoDescription: { value: string | null; outdated: boolean } | null }>;
}
export interface Backup {
  format: "chat-seo-sauvegarde-shopify/1";
  createdAt: string;
  shopHost: string | null;
  primaryLocale: string | null;
  otherLocales: string[];
  counts: Record<ShopifyResourceType, number> & { images: number; imagesWithoutAlt: number; seoTitlePresent: number; seoDescriptionPresent: number; translations: number };
  items: BackupItem[];
}

const meta = (m: MetaNode | undefined): BackupMeta =>
  m && typeof m.id === "string"
    ? { present: true, value: typeof m.value === "string" ? m.value : null, type: typeof m.type === "string" ? m.type : null, metafieldId: m.id }
    : { present: false, value: null, type: null, metafieldId: null };
const str = (v: unknown) => (typeof v === "string" ? v : null);

export async function readBackup(gql: Gql, opts: { shopHost: string | null; now?: () => number; onProgress?: (done: number, total: number) => void }): Promise<Backup> {
  let locales = { primary: null as string | null, others: [] as string[] };
  try {
    locales = await readLocales(gql);
  } catch {
    /* sans permission read_locales : pas de traductions */
  }
  const items: BackupItem[] = [];
  for (const p of await paginate<ProductNode>(gql, Q_PRODUCTS, "products")) {
    const media = await allMedia(gql, p);
    items.push({
      gid: p.id, type: "product", path: pathFor("product", p.handle), title: p.title, seoTitle: meta(p.t ?? undefined), seoDescription: meta(p.d ?? undefined),
      images: media.map((m) => ({ gid: str(m.id), url: str(m.image?.url), alt: str(m.image?.altText) })), translations: {},
    });
  }
  for (const c of await paginate<CollectionNode>(gql, Q_COLLECTIONS, "collections")) {
    items.push({
      gid: c.id, type: "collection", path: pathFor("collection", c.handle), title: c.title, seoTitle: meta(c.t ?? undefined), seoDescription: meta(c.d ?? undefined),
      images: c.image ? [{ gid: str(c.image.id), url: str(c.image.url), alt: str(c.image.altText) }] : [], translations: {},
    });
  }
  for (const p of await paginate<PageNode>(gql, Q_PAGES, "pages")) {
    items.push({ gid: p.id, type: "page", path: pathFor("page", p.handle), title: p.title, seoTitle: meta(p.t ?? undefined), seoDescription: meta(p.d ?? undefined), images: [], translations: {} });
  }
  for (const a of await paginate<ArticleNode>(gql, Q_ARTICLES, "articles")) {
    items.push({
      gid: a.id, type: "article", path: pathFor("article", a.handle, a.blog?.handle ?? ""), title: a.title, seoTitle: meta(a.t ?? undefined), seoDescription: meta(a.d ?? undefined),
      images: a.image ? [{ gid: null, url: str(a.image.url), alt: str(a.image.altText) }] : [], translations: {},
    });
  }
  let translations = 0;
  if (locales.others.length) {
    for (const [i, it] of items.entries()) {
      const tr = await readTranslations(gql, it.gid, locales.others);
      for (const l of locales.others) {
        const m = tr.byLocale.get(l);
        const t = m?.get("meta_title");
        const d = m?.get("meta_description");
        it.translations[l] = { seoTitle: t ? { value: t.value, outdated: t.outdated } : null, seoDescription: d ? { value: d.value, outdated: d.outdated } : null };
        translations += (t ? 1 : 0) + (d ? 1 : 0);
      }
      opts.onProgress?.(i + 1, items.length);
    }
  }
  const counts = { product: 0, collection: 0, page: 0, article: 0, images: 0, imagesWithoutAlt: 0, seoTitlePresent: 0, seoDescriptionPresent: 0, translations };
  for (const it of items) {
    counts[it.type]++;
    counts.images += it.images.length;
    counts.imagesWithoutAlt += it.images.filter((im) => !im.alt || !im.alt.trim()).length;
    if (it.seoTitle.present) counts.seoTitlePresent++;
    if (it.seoDescription.present) counts.seoDescriptionPresent++;
  }
  return {
    format: "chat-seo-sauvegarde-shopify/1",
    createdAt: new Date((opts.now ?? Date.now)()).toISOString(),
    shopHost: opts.shopHost,
    primaryLocale: locales.primary,
    otherLocales: locales.others,
    counts,
    items,
  };
}
