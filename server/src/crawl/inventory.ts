/**
 * Inventaire d'un site avant son parcours :
 * - lecture complète du sitemap (index, sous-sitemaps, y compris ceux à paramètres « ?from=…&to=… ») ;
 * - classement de chaque adresse par type de page (PageType) d'après son chemin, puis d'après le nom du sitemap ;
 * - repérage des autres versions de langue (préfixes /en/, /de-de/…, sitemaps par langue, balises hreflang),
 *   qui ne sont ni analysées ni comptées ;
 * - détection de Shopify.
 * Tout ce qui est lu ici est une donnée non fiable : seules des adresses et des longueurs en sont tirées.
 */
import { gunzipSync } from "node:zlib";
import * as cheerio from "cheerio";
import type { PageType } from "../../../shared/api.ts";
import { safeFetch } from "../net/fetch.ts";
import { parseSitemapFull } from "./sitemap.ts";
import { normalizeUrl, sameSite, urlKey } from "./url.ts";

/** Ordre d'affichage des types. */
export const PAGE_TYPES: PageType[] = ["home", "product", "collection", "article", "blog", "page", "policy", "other"];

export const PAGE_TYPE_LABELS: Record<PageType, string> = {
  home: "Accueil",
  product: "Produits",
  collection: "Collections",
  article: "Articles de blog",
  blog: "Blogs",
  page: "Pages",
  policy: "Politiques et mentions légales",
  other: "Autres pages",
};

// ───────── Langues

/** Codes de langue ISO 639-1. */
const LANGS = new Set(
  (
    "aa ab af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu " +
    "fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko " +
    "kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi " +
    "pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk " +
    "ur uz ve vi vo wa wo xh yi yo za zh zu"
  ).split(" "),
);
/** Codes qui ressemblent souvent à un mot ou à un identifiant dans une adresse : ils ne comptent comme langue que confirmés. */
const AMBIGUOUS = new Set(["am", "an", "as", "be", "bi", "go", "hi", "ho", "id", "ii", "io", "is", "it", "la", "li", "lo", "me", "my", "na", "ne", "no", "on", "or", "os", "pi", "sa", "se", "so", "ta", "to", "tv", "ty", "us", "za"]);

/**
 * Préfixe de langue d'un chemin (« /en/… » → « en », « /en-gb/… » → « en-gb »), en minuscules ; null sinon.
 * `known` : préfixes déjà confirmés (hreflang, sitemaps par langue), qui lèvent l'ambiguïté des codes courts.
 */
export function localeOf(pathname: string, known: ReadonlySet<string> = new Set()): string | null {
  const seg = pathname.split("/").filter(Boolean)[0];
  if (!seg) return null;
  const s = seg.toLowerCase();
  const m = /^([a-z]{2})(?:[-_]([a-z]{2}|[a-z]{4}|\d{3}))?$/.exec(s);
  if (!m || !LANGS.has(m[1])) return null;
  const code = s.replace("_", "-");
  if (known.has(code)) return code;
  if (m[2]) return code; // « en-gb », « de-de » : forme sans ambiguïté
  return AMBIGUOUS.has(m[1]) ? null : code;
}

// ───────── Types de pages

const POLICY_RE =
  /^(mentions-legales|mentions|legal|legal-notice|imprint|impressum|cgv|cgu|cgvu|conditions-generales(-de-vente|-d-utilisation)?|conditions-d-utilisation|conditions-de-vente|politique-de-confidentialite|politique-de-remboursement|politique-de-retour|politique-d-expedition|politique-des-cookies|politique-cookies|confidentialite|donnees-personnelles|rgpd|gdpr|privacy|privacy-policy|terms|terms-of-service|terms-and-conditions|terms-of-use|cookies?|cookie-policy|refund-policy|return-policy|returns-policy|shipping-policy)$/;
const BLOG_ROOTS = new Set(["blog", "blogs", "actualites", "actualite", "actus", "news", "journal", "magazine", "articles", "conseils", "guides"]);
const ARCHIVES = new Set(["category", "categorie", "categories", "tag", "tags", "author", "auteur", "page", "tagged"]);
const PAGE_SLUGS = new Set([
  "contact", "contactez-nous", "nous-contacter", "a-propos", "about", "about-us", "qui-sommes-nous", "notre-histoire", "histoire",
  "equipe", "team", "faq", "aide", "help", "livraison", "shipping", "presse", "press", "recrutement", "carrieres", "careers",
]);

function decodedLower(pathname: string): string {
  let p = pathname;
  try {
    p = decodeURI(p);
  } catch {
    /* laissé encodé */
  }
  return p.toLowerCase();
}

/**
 * Type d'une page d'après son chemin. `prefix` : préfixe de langue de l'adresse de départ, retiré avant le classement.
 * `hint` : type suggéré par le nom du sitemap qui la liste, utilisé quand le chemin ne suffit pas.
 */
export function classifyPath(pathname: string, opts: { prefix?: string | null; hint?: PageType | null } = {}): PageType {
  let p = decodedLower(pathname);
  if (opts.prefix && (p === `/${opts.prefix}` || p.startsWith(`/${opts.prefix}/`))) p = p.slice(opts.prefix.length + 1);
  const segs = p.split("/").filter(Boolean);
  if (!segs.length) return "home";
  const [first] = segs;
  const last = segs[segs.length - 1];
  // Shopify
  if (first === "products" && segs.length >= 2) return "product";
  if (first === "collections") return segs.length >= 3 && segs[2] === "products" ? "product" : "collection";
  if (first === "blogs") return segs.length >= 3 && segs[2] !== "tagged" ? "article" : "blog";
  if (first === "pages" && segs.length >= 2) return POLICY_RE.test(last) ? "policy" : "page";
  if (first === "policies") return "policy";
  // WooCommerce
  if ((first === "product" || first === "produit") && segs.length >= 2) return "product";
  if (first === "product-category" || first === "categorie-produit" || first === "product-tag" || first === "etiquette-produit") return "collection";
  if (segs.length === 1 && (first === "shop" || first === "boutique" || first === "store")) return "collection";
  // Articles datés : /2024/05/titre
  if (/^(19|20)\d{2}$/.test(first) && segs.length >= 3 && /^\d{1,2}$/.test(segs[1])) return "article";
  if (POLICY_RE.test(last)) return "policy";
  if (BLOG_ROOTS.has(first)) return segs.length === 1 || ARCHIVES.has(segs[1]) ? "blog" : "article";
  if (ARCHIVES.has(first) && first !== "page") return "blog";
  if (opts.hint && opts.hint !== "home") return opts.hint;
  if (segs.length === 1 && PAGE_SLUGS.has(first)) return "page";
  return "other";
}

/** Type suggéré par le nom d'un fichier sitemap (Shopify, Yoast, sitemaps natifs de WordPress…). */
export function sitemapHint(sitemapUrl: string): PageType | null {
  let name: string;
  try {
    name = new URL(sitemapUrl).pathname.toLowerCase().split("/").pop() ?? "";
  } catch {
    return null;
  }
  if (/sitemap_collections|product_cat-sitemap|taxonomies-product_cat|collections?-sitemap/.test(name)) return "collection";
  if (/sitemap_products|product-sitemap|posts-product-|products-sitemap/.test(name)) return "product";
  if (/sitemap_articles|post-sitemap|posts-post-|articles?-sitemap|news-sitemap/.test(name)) return "article";
  if (/sitemap_blogs|category-sitemap|post_tag-sitemap|taxonomies-(category|post_tag)|blogs?-sitemap/.test(name)) return "blog";
  if (/sitemap_pages|page-sitemap|posts-page-|pages-sitemap/.test(name)) return "page";
  return null;
}

// ───────── Inventaire par le sitemap

export interface InventoryEntry {
  url: URL;
  key: string;
  type: PageType;
}

export interface Inventory {
  /** Au moins un sitemap a été lu. Sans cela, l'inventaire se limite aux liens suivis. */
  found: boolean;
  /** Adresses de la langue principale, chargeables (même site, ni exclues ni interdites par robots.txt), sans doublon. */
  entries: InventoryEntry[];
  /** Types dont le décompte n'est pas fiable (un sitemap illisible, un plafond atteint) ; "all" si aucun ne l'est. */
  unknown: Set<PageType> | "all";
  /** Préfixes d'autres langues rencontrés (sitemaps, adresses, alternatives hreflang du sitemap). */
  locales: Set<string>;
  /** Le sitemap a la forme de celui de Shopify. */
  shopifyHint: boolean;
}

export interface InventoryOptions {
  signal: AbortSignal;
  start: URL;
  /** Préfixe de langue de l'adresse de départ (langue principale), null s'il n'y en a pas. */
  startPrefix: string | null;
  prefer: { host: string; protocol: string };
  /** Une adresse du site peut-elle être chargée (exclusions, robots.txt) ? */
  accept(u: URL): boolean;
  maxFiles?: number;
  maxUrls?: number;
  budgetMs?: number;
  /** Appelé avant la lecture de chaque fichier : progression réelle. */
  onFile?(url: string): void;
}

export const INVENTORY_LIMITS = { maxFiles: 60, maxUrls: 50_000, budgetMs: 90_000 };

export async function buildInventory(starts: string[], opts: InventoryOptions): Promise<Inventory> {
  const maxFiles = opts.maxFiles ?? INVENTORY_LIMITS.maxFiles;
  const maxUrls = opts.maxUrls ?? INVENTORY_LIMITS.maxUrls;
  const budget = AbortSignal.timeout(opts.budgetMs ?? INVENTORY_LIMITS.budgetMs);
  const signal = AbortSignal.any([opts.signal, budget]);
  const inv: Inventory = { found: false, entries: [], unknown: new Set(), locales: new Set(), shopifyHint: false };
  const markUnknown = (hint: PageType | null) => {
    if (inv.unknown === "all") return;
    if (hint) inv.unknown.add(hint);
    else inv.unknown = "all";
  };
  const keys = new Set<string>();
  const known = new Set<string>();
  const isOther = (pathname: string): string | null => {
    const loc = localeOf(pathname, known);
    return loc && loc !== opts.startPrefix ? loc : null;
  };

  type Item = { url: string; hint: PageType | null; root: boolean };
  const queue: Item[] = [...new Set(starts)].map((url) => ({ url, hint: null, root: true }));
  const seenFiles = new Set<string>();
  let rootsOk = 0;
  let rootsFailed = 0;
  let files = 0;

  while (queue.length) {
    if (signal.aborted || files >= maxFiles || inv.entries.length >= maxUrls) {
      // Ce qui n'a pas pu être lu rend incertain le décompte des types concernés.
      for (const rest of queue) if (!rest.root || rootsOk) markUnknown(rest.hint);
      if (!opts.signal.aborted && inv.entries.length >= maxUrls) markUnknown(null);
      break;
    }
    const item = queue.shift()!;
    if (seenFiles.has(item.url)) continue;
    seenFiles.add(item.url);
    let fileUrl: URL;
    try {
      fileUrl = new URL(item.url);
    } catch {
      if (!item.root) markUnknown(item.hint);
      continue;
    }
    // Sitemap d'une autre langue : signalé, jamais lu.
    if (sameSite(fileUrl, opts.start.hostname) && fileUrl.pathname.split("/").filter(Boolean).length >= 2) {
      // Un sitemap rangé dans un dossier de langue (« /de/sitemap_products_1.xml ») confirme cette langue.
      const loc = langSegment(fileUrl.pathname);
      if (loc && loc !== opts.startPrefix) {
        inv.locales.add(loc);
        known.add(loc);
        continue;
      }
    }
    if (/sitemap_products_\d/i.test(fileUrl.pathname)) inv.shopifyHint = true;
    files++;
    opts.onFile?.(fileUrl.href);
    let text: string;
    try {
      const res = await safeFetch(fileUrl.href, {
        signal,
        timeoutMs: 20_000,
        maxBytes: 15 * 1024 * 1024,
        accept: "application/xml,text/xml;q=0.9,*/*;q=0.5",
      });
      if (res.status >= 400) throw new Error("http");
      let body = res.body;
      if (body[0] === 0x1f && body[1] === 0x8b) body = gunzipSync(body, { maxOutputLength: 50 * 1024 * 1024 });
      text = body.toString("utf8");
      if (!/<(urlset|sitemapindex)\b/i.test(text)) throw new Error("not xml");
    } catch {
      if (opts.signal.aborted) break;
      if (item.root) rootsFailed++;
      else markUnknown(item.hint);
      continue;
    }
    if (item.root) rootsOk++;
    inv.found = true;
    const parsed = parseSitemapFull(text);
    const hint = sitemapHint(fileUrl.href) ?? item.hint;
    for (const s of parsed.sitemaps) queue.push({ url: s, hint: sitemapHint(s) ?? hint, root: false });
    for (const page of parsed.pages) {
      for (const alt of page.alternates) {
        const a = normalizeUrl(alt, undefined, opts.prefer);
        if (!a || !sameSite(a, opts.start.hostname)) continue;
        const loc = langSegment(a.pathname);
        if (loc && loc !== opts.startPrefix) {
          inv.locales.add(loc);
          known.add(loc);
        }
      }
      if (inv.entries.length >= maxUrls) break;
      const u = normalizeUrl(page.loc, undefined, opts.prefer);
      if (!u || !sameSite(u, opts.start.hostname)) continue;
      const other = isOther(u.pathname);
      if (other) {
        inv.locales.add(other);
        continue;
      }
      if (!opts.accept(u)) continue;
      const key = urlKey(u);
      if (!key || keys.has(key)) continue;
      keys.add(key);
      inv.entries.push({ url: u, key, type: classifyPath(u.pathname, { prefix: opts.startPrefix, hint }) });
    }
  }
  // Un sitemap déclaré illisible alors qu'un autre a été lu : on ne sait pas ce qu'il contenait.
  if (rootsOk && rootsFailed) markUnknown(null);
  return inv;
}

/** Premier segment du chemin s'il a la forme d'un code de langue, sans le filtre des codes ambigus (le contexte confirme la langue). */
function langSegment(pathname: string): string | null {
  const seg = pathname.split("/").filter(Boolean)[0]?.toLowerCase();
  if (!seg) return null;
  const m = /^([a-z]{2})(?:[-_]([a-z]{2}|[a-z]{4}|\d{3}))?$/.exec(seg);
  if (!m || !LANGS.has(m[1])) return null;
  return seg.replace("_", "-");
}

// ───────── Accueil : plateforme et versions de langue

/** La page d'accueil (contenu ou en-têtes) est-elle servie par Shopify ? */
export function detectShopify(html: string, headers: Record<string, string>): boolean {
  if (headers["x-shopid"] || headers["x-shopify-stage"] || /shopify/i.test(headers["powered-by"] ?? "")) return true;
  return /cdn\.shopify\.com|\.myshopify\.com|window\.Shopify\b|\bShopify\.(shop|theme)\b|shopify-section/i.test(html.slice(0, 2_000_000));
}

/** Alternatives de langue déclarées par la page (balises link hreflang). */
export function hreflangAlternates(html: string, base: string): Array<{ code: string; href: URL | null }> {
  const $ = cheerio.load(html);
  const out: Array<{ code: string; href: URL | null }> = [];
  $('link[rel~="alternate" i][hreflang]').each((_, el) => {
    const code = ($(el).attr("hreflang") ?? "").trim().toLowerCase().replace("_", "-");
    if (!code || code.length > 12 || !/^[a-z]{2,3}(-[a-z0-9]{2,4})?$|^x-default$/.test(code)) return;
    let href: URL | null = null;
    try {
      href = new URL(($(el).attr("href") ?? "").trim(), base);
    } catch {
      href = null;
    }
    out.push({ code, href });
  });
  return out.slice(0, 200);
}

/** Langue principale : celle déclarée par l'accueil (« fr-FR » → « fr »), à défaut le préfixe de l'adresse de départ. */
export function mainLocaleFrom(lang: string, startPrefix: string | null): string | null {
  const primary = /^([a-z]{2,3})\b/i.exec(lang.trim())?.[1]?.toLowerCase();
  if (primary && LANGS.has(primary)) return primary;
  return startPrefix ? startPrefix.split("-")[0] : null;
}

/**
 * Autres versions de langue d'après les balises hreflang de l'accueil :
 * sur le même site, le préfixe de l'adresse ; sur un autre domaine, le code de langue.
 */
export function localesFromHreflang(
  alts: Array<{ code: string; href: URL | null }>,
  ctx: { host: string; startPrefix: string | null; mainLocale: string | null },
): string[] {
  const out = new Set<string>();
  for (const { code, href } of alts) {
    if (code === "x-default" || !href) continue;
    if (sameSite(href, ctx.host)) {
      // Sur le même site, seule une adresse rangée sous un préfixe de langue est une autre version.
      const loc = langSegment(href.pathname);
      if (loc && loc !== ctx.startPrefix) out.add(loc);
      continue;
    }
    // Sur un autre domaine : une autre version, désignée par son code (sauf la langue principale elle-même).
    if (code !== ctx.mainLocale) out.add(code);
  }
  return [...out];
}
