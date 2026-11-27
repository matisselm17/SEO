/**
 * Sites d'essai servis en local, pour les tests et la vérification de bout en bout.
 * Utilisés uniquement avec ALLOW_PRIVATE_HOSTS / setAllowPrivateHosts(true).
 * - startFixtureSite : petit site vitrine (plusieurs pages avec des défauts variés), avec ou sans sitemap ;
 * - startShopFixture : boutique qui imite Shopify (sitemap index par type et par langue, produits, collections,
 *   blog, pages, politique, versions /en/, /de/…, catalogue /products.json paginé).
 * Lancement manuel : `npx tsx test/helpers/fixture-site.ts 8790 [délai en ms] [vitrine|vitrine-sans-sitemap|boutique]`
 */
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/site");

export interface FixtureSite {
  origin: string;
  requests: string[];
  close(): Promise<void>;
}

export function startFixtureSite(port = 0, opts: { slowMs?: number; listen?: string; noSitemap?: boolean } = {}): Promise<FixtureSite> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    requests.push(url.pathname + url.search);
    const origin = `http://${req.headers.host}`;
    const send = (status: number, type: string, body: string | Buffer, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": type, ...headers });
      res.end(body);
    };
    const go = () => {
      const p = url.pathname;
      if (p === "/old") return send(301, "text/plain", "", { location: "/services" });
      if (p === "/to-internal") return send(302, "text/plain", "", { location: "http://127.0.0.1:9/secret" });
      if (p === "/missing") return send(404, "text/html", "<h1>Introuvable</h1>");
      if (p === "/doc.pdf") return send(200, "application/pdf", "%PDF-1.4");
      if (opts.noSitemap && p === "/sitemap.xml") return send(404, "text/html", "<h1>Introuvable</h1>");
      if (p === "/robots.txt" || p === "/sitemap.xml") {
        let text = readFileSync(path.join(ROOT, p.slice(1)), "utf8").replaceAll("{{ORIGIN}}", origin);
        if (opts.noSitemap) text = text.replace(/^Sitemap:.*$/gim, "");
        return send(200, p.endsWith(".xml") ? "application/xml" : "text/plain", text);
      }
      const name = p === "/" ? "index.html" : p.replace(/\/$/, "").slice(1) + ".html";
      const file = path.resolve(ROOT, name);
      if (file.startsWith(ROOT) && existsSync(file)) return send(200, "text/html; charset=utf-8", readFileSync(file));
      send(404, "text/html", "<h1>Introuvable</h1>");
    };
    if (opts.slowMs) setTimeout(go, opts.slowMs);
    else go();
  });
  return listen(server, port, opts.listen, requests);
}

function listen(server: http.Server, port: number, host: string | undefined, requests: string[]): Promise<FixtureSite> {
  return new Promise((resolve) => {
    server.listen(port, host ?? "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        origin: `http://localhost:${addr.port}`,
        requests,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}

// ───────── Boutique d'essai (imite Shopify)

interface ShopProduct {
  handle: string;
  title: string;
  body_html: string;
  product_type: string;
  images: Array<{ src: string; alt: string | null }>;
}

const SHOP_LOCALES = ["de", "en", "de-de", "en-gb"];
export const SHOP = {
  collections: [
    { handle: "bagues", title: "Bagues en argent et en or", products: ["bague-ondine-argent", "bague-luna", "bague-solitaire-zircon", "bague-jonc-fine-or", "bague-chevaliere-ovale"] },
    { handle: "colliers", title: "Colliers et pendentifs", products: ["collier-perle-de-lune-argent", "pendentif-etoile-du-berger", "collier-medaille-soleil", "collier-ras-de-cou-perles", "collier-trefle-nacre"] },
    { handle: "bracelets", title: "Bracelets et chaînes de cheville", products: ["bracelet-maille-figaro", "bracelet-jonc-dore", "chaine-cheville-perles-or", "chaine-cheville-perles-argent", "bracelet-cordon-rouge"] },
    { handle: "piercings", title: "Piercings en titane", products: ["piercing-nombril-coeur", "piercing-nombril-lune", "piercing-helix-etoile", "boucles-creoles-argent", "boucles-puces-lune"] },
  ],
  articles: [
    { handle: "entretenir-son-argent", title: "Comment entretenir ses bijoux en argent" },
    { handle: "choisir-sa-taille-de-bague", title: "Choisir sa taille de bague sans se tromper" },
    { handle: "pierre-de-lune-signification", title: "La pierre de lune : origine et signification" },
    { handle: "piercing-premiers-soins", title: "Piercing : les premiers soins à connaître" },
  ],
  pages: [
    { handle: "a-propos", title: "À propos de l'atelier Orlux" },
    { handle: "contact", title: "Contact" },
    { handle: "faq", title: "Questions fréquentes sur nos bijoux" },
  ],
};

export function shopCatalogue(): ShopProduct[] {
  const file = path.resolve(path.dirname(ROOT), "boutique", "catalogue.json");
  return (JSON.parse(readFileSync(file, "utf8")) as { products: ShopProduct[] }).products;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const LOREM =
  "Nos bijoux sont dessinés et fabriqués à Lyon dans un atelier de quatre personnes. Nous travaillons l'argent recyclé, le vermeil et le titane de grade implantaire, sans nickel. Chaque commande est préparée à la main et expédiée sous quarante-huit heures en lettre suivie, dans un écrin en coton recyclé. Les retours sont gratuits pendant trente jours et la garantie couvre la finition comme les fermoirs pendant deux ans.";

function shopPage(o: { origin: string; path: string; title: string; description?: string; h1: string; body: string; lang?: string; extraHead?: string }): string {
  const nav = SHOP.collections.map((c) => `<a href="/collections/${c.handle}">${esc(c.title)}</a>`).join(" ");
  return `<!DOCTYPE html>
<html lang="${o.lang ?? "fr"}">
<head>
<meta charset="utf-8">
<title>${esc(o.title)}</title>
${o.description ? `<meta name="description" content="${esc(o.description)}">` : ""}
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="canonical" href="${o.origin}${o.path}">
<link rel="icon" href="//cdn.shopify.com/s/files/favicon.png">
<link rel="preconnect" href="https://cdn.shopify.com">
<meta property="og:site_name" content="Orlux">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.description ?? o.title)}">
<meta property="og:image" content="https://cdn.shopify.com/s/files/og.jpg">
<meta name="twitter:card" content="summary_large_image">
${o.extraHead ?? ""}
<script>window.Shopify = window.Shopify || {}; Shopify.shop = "orlux-essai.myshopify.com";</script>
</head>
<body>
<header><a href="/">Orlux</a> <nav>${nav} <a href="/blogs/journal">Journal</a> <a href="/cart">Panier</a></nav></header>
<main>
<h1>${esc(o.h1)}</h1>
${o.body}
</main>
<footer><a href="/pages/a-propos">L'atelier</a> <a href="/pages/contact">Nous écrire</a> <a href="/pages/faq">Questions fréquentes</a> <a href="/policies/refund-policy">Remboursements</a>
<a href="/en">English</a> <a href="/de">Deutsch</a></footer>
</body>
</html>`;
}

/**
 * Refus passagers simulés : `paths` associe un chemin (ou "/products.json" pour le catalogue) au nombre de refus
 * avant de servir normalement (Infinity : toujours refusé). `prefix` : tous les chemins qui commencent ainsi.
 */
export interface RefusalPlan {
  paths?: Record<string, number>;
  prefix?: { start: string; times: number };
  status?: 429 | 503;
  retryAfter?: string;
}

/**
 * `catalogue` : comportement de /products.json — servi normalement, absent (404), vide, interdit par robots.txt,
 * redirigé vers la page du mot de passe, ou une page HTML au lieu du JSON.
 */
export function startShopFixture(
  port = 0,
  opts: { listen?: string; slowMs?: number; catalogue?: "ok" | "404" | "empty" | "disallowed" | "password" | "html"; refuse?: RefusalPlan } = {},
): Promise<FixtureSite> {
  const requests: string[] = [];
  const refusedSoFar = new Map<string, number>();
  /** Vrai si cette requête doit être refusée passagèrement (et la compte). */
  const shouldRefuse = (p: string): boolean => {
    const plan = opts.refuse;
    if (!plan) return false;
    const times = plan.paths?.[p] ?? (plan.prefix && p.startsWith(plan.prefix.start) ? plan.prefix.times : 0);
    const n = refusedSoFar.get(p) ?? 0;
    if (n >= times) return false;
    refusedSoFar.set(p, n + 1);
    return true;
  };
  const products = shopCatalogue();
  const byHandle = new Map(products.map((p) => [p.handle, p]));
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    requests.push(url.pathname + url.search);
    const origin = `http://${req.headers.host}`;
    const send = (status: number, type: string, body: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": type, ...headers });
      res.end(body);
    };
    const html = (body: string) => send(200, "text/html; charset=utf-8", body);
    const xml = (body: string) => send(200, "application/xml; charset=utf-8", `<?xml version="1.0" encoding="UTF-8"?>\n${body}`);
    const urlset = (paths: string[]) =>
      xml(
        `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n` +
          paths
            .map(
              (p) =>
                `  <url><loc>${origin}${p}</loc>` +
                SHOP_LOCALES.map((l) => `<xhtml:link rel="alternate" hreflang="${l}" href="${origin}/${l}${p === "/" ? "" : p}"/>`).join("") +
                `</url>`,
            )
            .join("\n") +
          `\n</urlset>`,
      );
    const go = () => {
      const p = url.pathname.replace(/\/+$/, "") || "/";
      if (shouldRefuse(p)) {
        const status = opts.refuse?.status ?? 429;
        return send(status, "text/html", "<h1>Too many requests</h1>", opts.refuse?.retryAfter !== undefined ? { "retry-after": opts.refuse.retryAfter } : {});
      }
      const loc = /^\/(de|en|de-de|en-gb)(\/|$)/.exec(p)?.[1];
      if (p === "/robots.txt")
        return send(
          200,
          "text/plain",
          `User-agent: *\nDisallow: /cart\nDisallow: /checkout\nDisallow: /collections/*sort_by*\n${opts.catalogue === "disallowed" ? "Disallow: /products.json\n" : ""}\nSitemap: ${origin}/sitemap.xml\n`,
        );
      if (p === "/sitemap.xml") {
        const kinds = ["sitemap_products_1.xml?from=1&to=99999999", "sitemap_pages_1.xml?from=1&to=99999999", "sitemap_collections_1.xml?from=1&to=99999999", "sitemap_blogs_1.xml", "sitemap_articles_1.xml"];
        const entries = ["", ...SHOP_LOCALES.map((l) => `/${l}`)].flatMap((prefix) => kinds.map((k) => `${origin}${prefix}/${k}`));
        return xml(`<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.map((e) => `  <sitemap><loc>${esc(e)}</loc></sitemap>`).join("\n")}\n</sitemapindex>`);
      }
      if (p === "/sitemap_products_1.xml") return urlset(products.map((x) => `/products/${x.handle}`));
      if (p === "/sitemap_pages_1.xml") return urlset(["/", ...SHOP.pages.map((x) => `/pages/${x.handle}`)]);
      if (p === "/sitemap_collections_1.xml") return urlset(SHOP.collections.map((c) => `/collections/${c.handle}`));
      if (p === "/sitemap_blogs_1.xml") return urlset(["/blogs/journal"]);
      if (p === "/sitemap_articles_1.xml") return urlset(SHOP.articles.map((a) => `/blogs/journal/${a.handle}`));
      if (p === "/products.json") {
        if (opts.catalogue === "404") return send(404, "text/html", "<h1>Introuvable</h1>");
        if (opts.catalogue === "password") return send(302, "text/html", "", { location: "/password" });
        if (opts.catalogue === "html") return send(200, "text/html; charset=utf-8", "<html><body>Boutique</body></html>");
        if (opts.catalogue === "empty") return send(200, "application/json; charset=utf-8", JSON.stringify({ products: [] }));
        const limit = Math.min(250, Math.max(1, Number(url.searchParams.get("limit") ?? 30)));
        const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
        const slice = products.slice((page - 1) * limit, page * limit).map((x, i) => ({
          id: 7000000000 + (page - 1) * limit + i,
          title: x.title,
          handle: x.handle,
          body_html: x.body_html,
          published_at: "2026-01-10T10:00:00+01:00",
          created_at: "2026-01-10T10:00:00+01:00",
          updated_at: "2026-11-01T10:00:00+01:00",
          vendor: "Orlux",
          product_type: x.product_type,
          tags: [],
          variants: [{ id: 1, title: "Default Title", price: "39.00", available: true }],
          images: x.images.map((im, k) => ({ id: k + 1, src: im.src, alt: im.alt, position: k + 1, width: 1200, height: 1200 })),
          options: [{ name: "Title", position: 1, values: ["Default Title"] }],
        }));
        return send(200, "application/json; charset=utf-8", JSON.stringify({ products: slice }));
      }
      if (loc) {
        // Versions de langue : servies (comme sur une vraie boutique), mais l'analyse ne doit jamais les charger.
        return html(shopPage({ origin, path: p, title: `Orlux (${loc})`, h1: `Orlux ${loc}`, body: "<p>Other language.</p>", lang: loc }));
      }
      const alternates =
        `<link rel="alternate" hreflang="fr" href="${origin}/">` +
        SHOP_LOCALES.map((l) => `<link rel="alternate" hreflang="${l.replace(/-(\w+)$/, (_m, r: string) => "-" + r.toUpperCase())}" href="${origin}/${l}">`).join("") +
        `<link rel="alternate" hreflang="x-default" href="${origin}/">`;
      if (p === "/") {
        const featured = products.slice(0, 6).map((x) => `<li><a href="/collections/bagues/products/${x.handle}">${esc(x.title)}</a></li>`).join("");
        return html(
          shopPage({
            origin,
            path: "/",
            title: "Orlux | Bijoux en argent faits main à Lyon",
            description: "Bagues, colliers, bracelets et piercings en argent recyclé et titane, fabriqués à la main à Lyon. Livraison offerte dès 50 €.",
            h1: "Bijoux en argent faits main à Lyon",
            body: `<h2>Nos nouveautés</h2><ul>${featured}</ul><h2>L'atelier</h2><p>${LOREM}</p><p>${LOREM}</p><p>${LOREM}</p>`,
            extraHead: alternates,
          }),
        );
      }
      let m = /^\/products\/([^/]+)$/.exec(p);
      if (m && byHandle.has(m[1])) {
        const x = byHandle.get(m[1])!;
        const imgs = x.images.map((im) => (im.alt ? `<img src="${esc(im.src)}" alt="${esc(im.alt)}" width="800" height="800">` : `<img src="${esc(im.src)}" width="800" height="800">`)).join("");
        return html(
          shopPage({
            origin,
            path: p,
            title: `${x.title} – Orlux`,
            description: x.body_html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 155) || undefined,
            h1: x.title,
            body: `${imgs}<h2>Description</h2>${x.body_html}<h2>Livraison et retours</h2><p>${LOREM}</p>`,
          }),
        );
      }
      m = /^\/collections\/([^/]+)$/.exec(p);
      const col = m && SHOP.collections.find((c) => c.handle === m![1]);
      if (col) {
        const items = col.products.map((h) => `<li><a href="/collections/${col.handle}/products/${h}">${esc(byHandle.get(h)?.title ?? h)}</a></li>`).join("");
        return html(shopPage({ origin, path: p, title: `${col.title} – Orlux`, description: `${col.title} fabriqués à la main à Lyon : découvrez toute la sélection Orlux.`, h1: col.title, body: `<ul>${items}</ul><p>${LOREM}</p>` }));
      }
      if (p === "/blogs/journal") {
        const items = SHOP.articles.map((a) => `<li><a href="/blogs/journal/${a.handle}">${esc(a.title)}</a></li>`).join("");
        return html(shopPage({ origin, path: p, title: "Le journal de l'atelier – Orlux", h1: "Le journal", body: `<ul>${items}</ul>` }));
      }
      m = /^\/blogs\/journal\/([^/]+)$/.exec(p);
      const art = m && SHOP.articles.find((a) => a.handle === m![1]);
      if (art) return html(shopPage({ origin, path: p, title: `${art.title} – Orlux`, description: `${art.title} : les conseils de l'atelier Orlux, pas à pas.`, h1: art.title, body: `<h2>En bref</h2><p>${LOREM}</p><h2>Le détail</h2><p>${LOREM}</p><p>${LOREM}</p>` }));
      m = /^\/pages\/([^/]+)$/.exec(p);
      const pg = m && SHOP.pages.find((x) => x.handle === m![1]);
      if (pg) return html(shopPage({ origin, path: p, title: pg.title, h1: pg.title, body: `<p>${LOREM}</p>` }));
      if (p === "/policies/refund-policy") return html(shopPage({ origin, path: p, title: "Politique de remboursement", h1: "Politique de remboursement", body: `<p>${LOREM}</p>` }));
      send(404, "text/html", "<h1>Introuvable</h1>");
    };
    if (opts.slowMs) setTimeout(go, opts.slowMs);
    else go();
  });
  return listen(server, port, opts.listen, requests);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? 8790);
  const slowMs = Number(process.argv[3] ?? 0);
  const kind = process.argv[4] ?? "vitrine";
  const started =
    kind === "boutique"
      ? startShopFixture(port, { slowMs, listen: "0.0.0.0" })
      : startFixtureSite(port, { slowMs, listen: "0.0.0.0", noSitemap: kind === "vitrine-sans-sitemap" });
  void started.then((s) => console.log(`Site d'essai (${kind}) sur ${s.origin}`));
}
