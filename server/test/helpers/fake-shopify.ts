/**
 * Faux Shopify pour les tests : répond aux requêtes GraphQL du logiciel à partir d'un état en mémoire,
 * applique les mutations sur cet état et enregistre chaque appel. Aucun appel réseau réel.
 */
import { createHash } from "node:crypto";

export const FAKE_CREDS = { storeDomain: "boutique-essai.myshopify.com", clientId: "ID-PUBLIC-ESSAI", clientSecret: "SECRET-ESSAI-XYZ" };
export const SHOP_HOST = "boutique-essai.example";

export interface Meta {
  id: string;
  value: string;
  type: string;
}
export interface FakeState {
  scopes: string[];
  shop: { name: string; host: string };
  locales: Array<{ locale: string; primary: boolean; published: boolean }>;
  /** Titre et description pour Google : metafields global.title_tag / global.description_tag, comme chez Shopify. */
  products: Array<{ id: string; handle: string; title: string; meta: Record<string, Meta | undefined>; media: Array<{ id: string; alt: string | null; url: string }> }>;
  collections: Array<{ id: string; handle: string; title: string; meta: Record<string, Meta | undefined>; image: { id: string; altText: string | null; url: string } | null }>;
  pages: Array<{ id: string; handle: string; title: string; meta: Record<string, Meta | undefined> }>;
  articles: Array<{ id: string; handle: string; title: string; blog: string; image: { altText: string | null; url: string } | null; meta: Record<string, Meta | undefined> }>;
  /** gid → langue → clé → traduction. */
  translations: Record<string, Record<string, Record<string, { value: string; outdated: boolean }>>>;
}

export const ALL_SCOPES = [
  "read_products", "write_products", "read_content", "write_content", "read_files", "write_files",
  "read_translations", "write_translations", "read_locales",
];

export function defaultState(): FakeState {
  return {
    scopes: [...ALL_SCOPES],
    shop: { name: "Boutique Essai", host: `www.${SHOP_HOST}` },
    locales: [
      { locale: "fr", primary: true, published: true },
      { locale: "en", primary: false, published: true },
      { locale: "it", primary: false, published: false },
    ],
    products: [
      {
        id: "gid://shopify/Product/1",
        handle: "bague-or",
        title: "Bague en or",
        meta: { title_tag: { id: "gid://shopify/Metafield/81", value: "Bague en or 18 carats", type: "string" } },
        media: [
          { id: "gid://shopify/MediaImage/11", alt: "Bague vue de face", url: "https://cdn.shopify.com/bague-1.jpg" },
          { id: "gid://shopify/MediaImage/12", alt: null, url: "https://cdn.shopify.com/bague-2.jpg" },
        ],
      },
      { id: "gid://shopify/Product/2", handle: "collier", title: "Collier", meta: { description_tag: { id: "gid://shopify/Metafield/82", value: "Un collier fin.", type: "string" } }, media: [] },
    ],
    collections: [
      { id: "gid://shopify/Collection/5", handle: "bagues", title: "Bagues", meta: {}, image: { id: "gid://shopify/CollectionImage/55", altText: null, url: "https://cdn.shopify.com/bagues.jpg" } },
    ],
    pages: [{ id: "gid://shopify/Page/7", handle: "contact", title: "Contact", meta: {} }],
    articles: [
      {
        id: "gid://shopify/Article/9",
        handle: "entretenir-ses-bijoux",
        title: "Entretenir ses bijoux",
        blog: "conseils",
        image: { altText: null, url: "https://cdn.shopify.com/article.jpg" },
        meta: { title_tag: { id: "gid://shopify/Metafield/91", value: "Entretenir ses bijoux en or", type: "string" } },
      },
    ],
    translations: {
      "gid://shopify/Product/1": { en: { meta_title: { value: "18k gold ring", outdated: false } } },
    },
  };
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const page = <T>(list: T[], after: unknown, size: number) => {
  const start = typeof after === "string" ? Number(after) : 0;
  const nodes = list.slice(start, start + size);
  const next = start + size < list.length;
  return { pageInfo: { hasNextPage: next, endCursor: next ? String(start + size) : null }, nodes };
};
const metaNode = (m: Meta | undefined) => (m ? { id: m.id, value: m.value, type: m.type, compareDigest: sha(m.value) } : null);

export interface FakeOptions {
  /** Mutation (nom de la racine, ex. "productUpdate") qui renvoie des userErrors. */
  userErrorOn?: string;
  /** Appelé juste avant d'appliquer une mutation : simule une modification faite ailleurs entre-temps. */
  beforeMutation?: (s: FakeState) => void;
  /** Après la première mutation acceptée, toute lecture échoue (Shopify injoignable). */
  failReadsAfterMutation?: boolean;
  /** La mutation est appliquée, mais sa réponse se perd (Shopify injoignable). */
  loseMutationResponse?: boolean;
}

export function fakeShopify(state: FakeState = defaultState(), opts: FakeOptions = {}) {
  const calls = { token: 0, queries: [] as string[], mutations: [] as Array<{ query: string; variables: Record<string, any> }>, all: 0 };
  let metaSeq = 1000;
  let mutated = false;
  /** `down` : Shopify ne répond plus du tout. */
  const control = { down: false };

  const product = (p: FakeState["products"][number]) => ({
    id: p.id,
    handle: p.handle,
    title: p.title,
    t: metaNode(p.meta.title_tag),
    d: metaNode(p.meta.description_tag),
    media: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: p.media.map((m) => ({ __typename: "MediaImage", id: m.id, image: { altText: m.alt, url: m.url } })) },
  });
  const collection = (c: FakeState["collections"][number]) => ({ id: c.id, handle: c.handle, title: c.title, t: metaNode(c.meta.title_tag), d: metaNode(c.meta.description_tag), image: c.image });
  const pageNode = (p: FakeState["pages"][number]) => ({ id: p.id, handle: p.handle, title: p.title, t: metaNode(p.meta.title_tag), d: metaNode(p.meta.description_tag) });
  const article = (a: FakeState["articles"][number]) => ({ ...pageNode(a as never), blog: { handle: a.blog }, image: a.image });

  const findAny = (gid: string) =>
    state.products.find((x) => x.id === gid) ?? state.collections.find((x) => x.id === gid) ?? state.pages.find((x) => x.id === gid) ?? state.articles.find((x) => x.id === gid);

  /** Texte d'origine traduisible : comme chez Shopify, une clé n'existe que si son texte existe. */
  const translatable = (gid: string): Record<string, string> => {
    const out: Record<string, string> = {};
    const r = findAny(gid) as any;
    if (!r) return out;
    out.title = r.title;
    const t = r.meta?.title_tag?.value;
    const d = r.meta?.description_tag?.value;
    if (t) out.meta_title = t;
    if (d) out.meta_description = d;
    return out;
  };

  function query(q: string, v: Record<string, any>): unknown {
    if (q.includes("currentAppInstallation")) return { currentAppInstallation: { accessScopes: state.scopes.map((handle) => ({ handle })) }, shop: { name: state.shop.name, primaryDomain: { host: state.shop.host } } };
    if (q.includes("shopLocales")) {
      if (!state.scopes.includes("read_locales")) return { __error: "Access denied for shopLocales field. Required access: `read_locales` access scope." };
      return { shopLocales: state.locales };
    }
    if (q.includes("products(first")) return { products: page(state.products.map(product), v.after, 25) };
    if (q.includes("collections(first")) return { collections: page(state.collections.map(collection), v.after, 100) };
    if (q.includes("pages(first")) return { pages: page(state.pages.map(pageNode), v.after, 100) };
    if (q.includes("articles(first")) return { articles: page(state.articles.map(article), v.after, 100) };
    if (q.includes("node: product(")) {
      const p = state.products.find((x) => x.id === v.id);
      return { node: p ? product(p) : null };
    }
    if (q.includes("node: collection(")) {
      const c = state.collections.find((x) => x.id === v.id);
      return { node: c ? collection(c) : null };
    }
    if (q.includes("node: page(")) {
      const p = state.pages.find((x) => x.id === v.id);
      return { node: p ? pageNode(p) : null };
    }
    if (q.includes("node: article(")) {
      const a = state.articles.find((x) => x.id === v.id);
      return { node: a ? article(a) : null };
    }
    if (q.includes("translatableResource")) {
      const content = translatable(v.id);
      const res: Record<string, unknown> = {
        translatableContent: Object.entries(content).map(([key, value]) => ({ key, value, digest: sha(value) })),
      };
      for (const m of q.matchAll(/t(\d+): translations\(locale: "([^"]+)"\)/g)) {
        const tr = state.translations[v.id]?.[m[2]] ?? {};
        res[`t${m[1]}`] = Object.entries(tr).map(([key, t]) => ({ key, value: t.value, outdated: t.outdated }));
      }
      return { translatableResource: res };
    }
    throw new Error("Requête inconnue du faux Shopify : " + q.slice(0, 80));
  }

  function mutation(q: string, v: Record<string, any>): unknown {
    opts.beforeMutation?.(state);
    const root = /\{\s*(\w+)\(/.exec(q)?.[1] ?? "";
    if (opts.userErrorOn === root) return { [root]: { userErrors: [{ field: ["value"], message: "Valeur refusée par la boutique.", code: "INVALID" }] } };
    const ok = (extra: Record<string, unknown> = {}) => ({ [root]: { ...extra, userErrors: [] } });
    switch (root) {
      case "metafieldsSet": {
        const m = v.metafields[0];
        const owner = findAny(m.ownerId)!;
        const cur = owner.meta[m.key];
        const stale = m.compareDigest === null ? !!cur : cur ? sha(cur.value) !== m.compareDigest : true;
        if (stale) return { [root]: { userErrors: [{ field: ["metafields", "0"], message: "The resource has been updated since it was loaded.", code: "STALE_OBJECT" }] } };
        owner.meta[m.key] = { id: cur?.id ?? `gid://shopify/Metafield/${++metaSeq}`, value: m.value, type: m.type };
        return ok({ metafields: [{ id: owner.meta[m.key]!.id }] });
      }
      case "metafieldsDelete": {
        const m = v.metafields[0];
        const owner = findAny(m.ownerId)!;
        delete owner.meta[m.key];
        return ok({ deletedMetafields: [{ key: m.key }] });
      }
      case "fileUpdate": {
        const f = v.files[0];
        const media = state.products.flatMap((p) => p.media).find((x) => x.id === f.id)!;
        media.alt = f.alt || null;
        return ok({ files: [{ id: f.id }] });
      }
      case "translationsRegister": {
        const t = v.translations[0];
        const content = translatable(v.resourceId);
        if (!content[t.key] || sha(content[t.key]) !== t.translatableContentDigest) {
          return { [root]: { userErrors: [{ field: ["translations"], message: "Translatable content hash is invalid.", code: "INVALID_TRANSLATABLE_CONTENT" }] } };
        }
        ((state.translations[v.resourceId] ??= {})[t.locale] ??= {})[t.key] = { value: t.value, outdated: false };
        return ok({ translations: [{ key: t.key, locale: t.locale }] });
      }
      case "translationsRemove": {
        for (const l of v.locales) for (const k of v.translationKeys) delete state.translations[v.resourceId]?.[l]?.[k];
        return ok({ translations: [] });
      }
    }
    throw new Error("Mutation inconnue du faux Shopify : " + root);
  }

  const impl = (async (url: string, init: RequestInit) => {
    calls.all++;
    if (control.down) throw new TypeError("Shopify injoignable (simulé)");
    if (!url.startsWith(`https://${FAKE_CREDS.storeDomain}/`)) throw new Error("adresse inattendue");
    if (url.endsWith("/admin/oauth/access_token")) {
      calls.token++;
      return Response.json({ access_token: `jeton-secret-${calls.token}`, scope: state.scopes.join(","), expires_in: 86399 });
    }
    const body = JSON.parse(String(init.body)) as { query: string; variables?: Record<string, any> };
    const v = body.variables ?? {};
    if (/^\s*mutation\b/.test(body.query)) {
      calls.mutations.push({ query: body.query, variables: structuredClone(v) });
      const data = mutation(body.query, v);
      mutated = true;
      if (opts.loseMutationResponse) throw new TypeError("connexion coupée");
      return Response.json({ data });
    }
    calls.queries.push(body.query);
    if (opts.failReadsAfterMutation && mutated) return new Response("indisponible", { status: 503 });
    const data = query(body.query, v) as Record<string, unknown>;
    if (data && "__error" in data) return Response.json({ errors: [{ message: data.__error }] });
    return Response.json({ data });
  }) as unknown as typeof fetch;

  return { state, calls, impl, control };
}
