/**
 * Lectures GraphQL de la boutique (jamais d'écriture ici : `shopifyGraphql` refuse toute mutation).
 * Tout texte venu de Shopify est une donnée non fiable : il est gardé comme texte brut, borné, sans
 * caractères de contrôle, et n'est jamais interprété.
 */
import type { ShopifyResourceType } from "../../../shared/api.ts";
import { shopifyGraphql, type ShopifyAuth } from "./auth.ts";
import { imageIdOf, type ResourceInput } from "./repo.ts";

export type Gql = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;

export function readerFor(auth: ShopifyAuth, fetchImpl: typeof fetch): Gql {
  return <T>(query: string, variables?: Record<string, unknown>) => shopifyGraphql<T>(auth, query, variables, fetchImpl);
}

/** Texte brut borné, sans caractères de contrôle (les retours à la ligne sont gardés). */
export function cleanText(v: unknown, max = 5000): string | null {
  if (typeof v !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, max);
  return s.trim() ? s : null;
}

/** Longueur au-delà de laquelle une valeur lue n'est pas gardée en entier (le champ devient non modifiable). */
export const LIVE_MAX = 5000;

/**
 * Valeur EXACTE lue dans Shopify (aucune transformation), pour pouvoir la remettre telle quelle à l'annulation.
 * Chaîne vide : null. Au-delà de LIVE_MAX : coupée pour l'affichage et marquée incomplète.
 */
export function exact(v: unknown): { value: string | null; complete: boolean } {
  if (typeof v !== "string" || v === "") return { value: null, complete: true };
  return v.length > LIVE_MAX ? { value: v.slice(0, LIVE_MAX), complete: false } : { value: v, complete: true };
}

const HANDLE_RE = /^[\p{L}\p{N}][\p{L}\p{N}._~%-]{0,254}$/u;
const handleOf = (v: unknown): string => {
  const h = typeof v === "string" ? v.trim() : "";
  return HANDLE_RE.test(h) ? h : encodeURIComponent(h.slice(0, 255));
};

export function pathFor(type: ShopifyResourceType, handle: string, blogHandle?: string | null): string {
  switch (type) {
    case "product":
      return `/products/${handle}`;
    case "collection":
      return `/collections/${handle}`;
    case "page":
      return `/pages/${handle}`;
    case "article":
      return `/blogs/${blogHandle ?? ""}/${handle}`;
  }
}

const httpsUrl = (v: unknown): string | null => (typeof v === "string" && /^https:\/\//i.test(v) && v.length < 2048 ? v : null);

// ───────── Connexion

export interface ShopInfo {
  name: string | null;
  /** Domaine public, sans « www. ». */
  host: string | null;
  scopes: string[];
}

export async function readShopInfo(gql: Gql): Promise<ShopInfo> {
  const d = await gql<{ currentAppInstallation: { accessScopes: Array<{ handle: string }> } | null; shop: { name: string; primaryDomain: { host: string } | null } }>(
    "{ currentAppInstallation { accessScopes { handle } } shop { name primaryDomain { host } } }",
  );
  const host = typeof d.shop?.primaryDomain?.host === "string" ? d.shop.primaryDomain.host.toLowerCase().replace(/\.$/, "").replace(/^www\./, "") : null;
  return {
    name: cleanText(d.shop?.name, 200),
    // Le domaine technique *.myshopify.com n'est jamais exposé : sans domaine public, l'hôte est inconnu.
    host: host && /^[a-z0-9.-]+$/.test(host) && !host.endsWith(".myshopify.com") ? host : null,
    scopes: (d.currentAppInstallation?.accessScopes ?? []).map((s) => s.handle).filter((s): s is string => typeof s === "string" && /^[a-z_]+$/.test(s)),
  };
}

export async function readLocales(gql: Gql): Promise<{ primary: string | null; others: string[] }> {
  const d = await gql<{ shopLocales: Array<{ locale: string; primary: boolean; published: boolean }> }>("{ shopLocales { locale primary published } }");
  const ok = (l: unknown): l is string => typeof l === "string" && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(l);
  const list = (d.shopLocales ?? []).filter((l) => ok(l.locale));
  return {
    primary: list.find((l) => l.primary)?.locale ?? null,
    others: list.filter((l) => !l.primary && l.published).map((l) => l.locale).sort(),
  };
}

// ───────── Lecture complète (sync)

type Page<T> = { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: T[] };
const MAX_PAGES = 200;

async function paginate<T>(gql: Gql, query: string, root: string): Promise<T[]> {
  const out: T[] = [];
  let after: string | null = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const d: Record<string, Page<T>> = await gql<Record<string, Page<T>>>(query, { after });
    const conn: Page<T> = d[root];
    out.push(...(conn?.nodes ?? []));
    if (!conn?.pageInfo?.hasNextPage || !conn.pageInfo.endCursor) break;
    after = conn.pageInfo.endCursor;
  }
  return out;
}

type MediaNode = { __typename?: string; id?: string; image?: { altText: string | null; url?: string } | null };
type MetaNode = { id: string; value: string | null; type: string; compareDigest: string } | null;
type ProductNode = { id: string; handle: string; title: string; t: MetaNode; d: MetaNode; media: Page<MediaNode> };
type CollectionNode = { id: string; handle: string; title: string; t: MetaNode; d: MetaNode; image: { id?: string | null; altText: string | null; url: string } | null };
type PageNode = { id: string; handle: string; title: string; t: MetaNode; d: MetaNode };
type ArticleNode = PageNode & { blog: { handle: string } | null; image: { altText: string | null; url: string } | null };

const MEDIA = "media(first: 50) { pageInfo { hasNextPage endCursor } nodes { __typename ... on MediaImage { id image { altText url } } } }";
const META = 't: metafield(namespace: "global", key: "title_tag") { id value type compareDigest } d: metafield(namespace: "global", key: "description_tag") { id value type compareDigest }';

// Titre et description pour Google : lus partout dans global.title_tag / global.description_tag, les champs que le
// logiciel écrit. Vérifié en lecture sur une boutique réelle : identiques à seo { title description } des produits et collections.
const Q_PRODUCTS = `query($after: String) { products(first: 25, after: $after) { pageInfo { hasNextPage endCursor } nodes { id handle title ${META} ${MEDIA} } } }`;
const Q_PRODUCT_MEDIA = "query($id: ID!, $after: String) { product(id: $id) { media(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { __typename ... on MediaImage { id image { altText url } } } } } }";
const Q_COLLECTIONS = `query($after: String) { collections(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { id handle title ${META} image { id altText url } } } }`;
const Q_PAGES = `query($after: String) { pages(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { id handle title ${META} } } }`;
const Q_ARTICLES = `query($after: String) { articles(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { id handle title blog { handle } image { altText url } ${META} } } }`;

const isImage = (m: MediaNode) => m.__typename === "MediaImage" && typeof m.id === "string";
const hasAlt = (alt: unknown) => typeof alt === "string" && alt.trim().length > 0;

/** Toutes les images d'un produit, au-delà des 50 premières si besoin. */
async function allMedia(gql: Gql, p: ProductNode): Promise<MediaNode[]> {
  const nodes = [...(p.media?.nodes ?? [])];
  let info = p.media?.pageInfo;
  for (let i = 0; info?.hasNextPage && info.endCursor && i < 50; i++) {
    const d: { product: { media: Page<MediaNode> } | null } = await gql<{ product: { media: Page<MediaNode> } | null }>(Q_PRODUCT_MEDIA, { id: p.id, after: info.endCursor });
    if (!d.product) break;
    nodes.push(...d.product.media.nodes);
    info = d.product.media.pageInfo;
  }
  return nodes.filter(isImage);
}

export async function readAllResources(gql: Gql, opts: { products: boolean; content: boolean }): Promise<ResourceInput[]> {
  const out: ResourceInput[] = [];
  if (opts.products) {
    for (const p of await paginate<ProductNode>(gql, Q_PRODUCTS, "products")) {
      const media = await allMedia(gql, p);
      out.push({
        gid: p.id,
        type: "product",
        path: pathFor("product", handleOf(p.handle)),
        title: cleanText(p.title, 500) ?? "",
        seo_title: cleanText(p.t?.value, 1000),
        seo_description: cleanText(p.d?.value, 2000),
        images: media.length,
        images_without_alt: media.filter((m) => !hasAlt(m.image?.altText)).length,
      });
    }
    for (const c of await paginate<CollectionNode>(gql, Q_COLLECTIONS, "collections")) {
      out.push({
        gid: c.id,
        type: "collection",
        path: pathFor("collection", handleOf(c.handle)),
        title: cleanText(c.title, 500) ?? "",
        seo_title: cleanText(c.t?.value, 1000),
        seo_description: cleanText(c.d?.value, 2000),
        images: c.image ? 1 : 0,
        images_without_alt: c.image && !hasAlt(c.image.altText) ? 1 : 0,
      });
    }
  }
  if (opts.content) {
    for (const p of await paginate<PageNode>(gql, Q_PAGES, "pages")) {
      out.push({
        gid: p.id,
        type: "page",
        path: pathFor("page", handleOf(p.handle)),
        title: cleanText(p.title, 500) ?? "",
        seo_title: cleanText(p.t?.value, 1000),
        seo_description: cleanText(p.d?.value, 2000),
        images: 0,
        images_without_alt: 0,
      });
    }
    for (const a of await paginate<ArticleNode>(gql, Q_ARTICLES, "articles")) {
      out.push({
        gid: a.id,
        type: "article",
        path: pathFor("article", handleOf(a.handle), handleOf(a.blog?.handle)),
        title: cleanText(a.title, 500) ?? "",
        seo_title: cleanText(a.t?.value, 1000),
        seo_description: cleanText(a.d?.value, 2000),
        images: a.image ? 1 : 0,
        images_without_alt: a.image && !hasAlt(a.image.altText) ? 1 : 0,
      });
    }
  }
  return out;
}

// ───────── Lecture en direct d'un élément

export interface LiveImage {
  /** Identifiant interne (img_…). */
  id: string;
  /** Identifiant Shopify du média (produit) ou de l'image (collection) ; null si Shopify n'en donne pas. Jamais renvoyé au navigateur. */
  gid: string | null;
  url: string;
  /** Valeur exacte. */
  alt: string | null;
  /** false : texte trop long pour être gardé en entier. */
  complete: boolean;
}

export interface LiveMeta {
  id: string;
  /** Valeur exacte. */
  value: string | null;
  complete: boolean;
  type: string;
  compareDigest: string;
}

export interface LiveResource {
  gid: string;
  type: ShopifyResourceType;
  path: string;
  title: string;
  seoTitle: string | null;
  seoDescription: string | null;
  /** Les metafields global.title_tag / global.description_tag tels que lus (null : absent). */
  meta: { title: LiveMeta | null; description: LiveMeta | null };
  /** Au plus 50, dans l'ordre de la boutique. */
  imageList: LiveImage[];
  images: number;
  imagesWithoutAlt: number;
}

const Q_ONE: Record<ShopifyResourceType, string> = {
  product: `query($id: ID!) { node: product(id: $id) { id handle title ${META} ${MEDIA} } }`,
  collection: `query($id: ID!) { node: collection(id: $id) { id handle title ${META} image { id altText url } } }`,
  page: `query($id: ID!) { node: page(id: $id) { id handle title ${META} } }`,
  article: `query($id: ID!) { node: article(id: $id) { id handle title blog { handle } image { altText url } ${META} } }`,
};

const meta = (m: MetaNode): LiveMeta | null => {
  if (!m || typeof m.id !== "string") return null;
  const v = exact(m.value);
  return { id: m.id, value: v.value, complete: v.complete, type: typeof m.type === "string" ? m.type : "", compareDigest: typeof m.compareDigest === "string" ? m.compareDigest : "" };
};

const liveImage = (id: string, gid: string | null, url: string, alt: unknown): LiveImage => {
  const a = exact(alt);
  return { id, gid, url, alt: a.value, complete: a.complete };
};

/** Relit un élément dans Shopify ; null s'il n'existe plus. */
export async function readResource(gql: Gql, type: ShopifyResourceType, gid: string): Promise<LiveResource | null> {
  const d = await gql<{ node: Record<string, unknown> | null }>(Q_ONE[type], { id: gid });
  const n = d.node;
  if (!n) return null;
  const title = cleanText(n.title, 500) ?? "";
  const t = meta(n.t as MetaNode);
  const dsc = meta(n.d as MetaNode);
  const base = { type, title, seoTitle: t?.value ?? null, seoDescription: dsc?.value ?? null, meta: { title: t, description: dsc } };
  if (type === "product") {
    const p = n as unknown as ProductNode;
    const media = await allMedia(gql, p);
    const imageList: LiveImage[] = media.slice(0, 50).flatMap((m) => {
      const url = httpsUrl(m.image?.url);
      return url ? [liveImage(imageIdOf(m.id!), m.id!, url, m.image?.altText)] : [];
    });
    return { ...base, gid: p.id, path: pathFor(type, handleOf(p.handle)), imageList, images: media.length, imagesWithoutAlt: media.filter((m) => !hasAlt(m.image?.altText)).length };
  }
  if (type === "collection") {
    const c = n as unknown as CollectionNode;
    const url = httpsUrl(c.image?.url);
    const imageList: LiveImage[] = c.image && url ? [liveImage(imageIdOf(`${c.id}#image`), typeof c.image.id === "string" ? c.image.id : null, url, c.image.altText)] : [];
    return { ...base, gid: c.id, path: pathFor(type, handleOf(c.handle)), imageList, images: c.image ? 1 : 0, imagesWithoutAlt: c.image && !hasAlt(c.image.altText) ? 1 : 0 };
  }
  const p = n as unknown as ArticleNode;
  const img = type === "article" ? p.image : null;
  const url = httpsUrl(img?.url);
  return {
    ...base,
    gid: p.id,
    path: type === "article" ? pathFor(type, handleOf(p.handle), handleOf(p.blog?.handle)) : pathFor(type, handleOf(p.handle)),
    imageList: img && url ? [liveImage(imageIdOf(`${p.id}#image`), null, url, img.altText)] : [],
    images: img ? 1 : 0,
    imagesWithoutAlt: img && !hasAlt(img.altText) ? 1 : 0,
  };
}

export function toResourceInput(r: LiveResource): ResourceInput {
  return {
    gid: r.gid,
    type: r.type,
    path: r.path,
    title: r.title,
    seo_title: cleanText(r.seoTitle, 1000),
    seo_description: cleanText(r.seoDescription, 2000),
    images: r.images,
    images_without_alt: r.imagesWithoutAlt,
  };
}

// ───────── Traductions

export interface LiveTranslations {
  /** Texte d'origine traduisible, par clé (meta_title, meta_description…). */
  content: Map<string, { value: string | null; digest: string }>;
  /** Traductions par langue puis par clé. */
  byLocale: Map<string, Map<string, { value: string | null; complete: boolean; outdated: boolean }>>;
}

export async function readTranslations(gql: Gql, gid: string, locales: string[]): Promise<LiveTranslations> {
  // Les codes de langue viennent de shopLocales et sont validés (lettres, chiffres, tiret) avant d'être placés dans la requête.
  const safe = locales.filter((l) => /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(l));
  const aliases = safe.map((l, i) => `t${i}: translations(locale: "${l}") { key value outdated }`).join(" ");
  const d = await gql<{ translatableResource: (Record<string, unknown> & { translatableContent: Array<{ key: string; value: string | null; digest: string | null }> }) | null }>(
    `query($id: ID!) { translatableResource(resourceId: $id) { translatableContent { key value digest } ${aliases} } }`,
    { id: gid },
  );
  const content = new Map<string, { value: string | null; digest: string }>();
  const byLocale = new Map<string, Map<string, { value: string | null; complete: boolean; outdated: boolean }>>();
  const tr = d.translatableResource;
  for (const c of tr?.translatableContent ?? []) {
    if (typeof c.key === "string" && typeof c.digest === "string" && c.digest) content.set(c.key, { value: cleanText(c.value, 5000), digest: c.digest });
  }
  safe.forEach((l, i) => {
    const map = new Map<string, { value: string | null; complete: boolean; outdated: boolean }>();
    for (const t of (tr?.[`t${i}`] as Array<{ key: string; value: string | null; outdated: boolean }> | undefined) ?? []) {
      if (typeof t.key === "string") map.set(t.key, { ...exact(t.value), outdated: t.outdated === true });
    }
    byLocale.set(l, map);
  });
  return { content, byLocale };
}
