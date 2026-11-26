import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRobots } from "../src/crawl/robots.ts";
import { parseSitemap } from "../src/crawl/sitemap.ts";
import { siteNameFrom } from "../src/crawl/crawler.ts";
import { bareHost, displayPath, exclusionReason, normalizeUrl, parseUserUrl, urlKey } from "../src/crawl/url.ts";

test("saisie utilisateur : sans https://, avec chemin, refus des formes invalides", () => {
  assert.equal(parseUserUrl("monsite.fr")?.href, "https://monsite.fr/");
  assert.equal(parseUserUrl("  https://www.monsite.fr/boutique#top ")?.href, "https://www.monsite.fr/boutique");
  assert.equal(parseUserUrl("http://monsite.fr")?.protocol, "http:");
  assert.equal(parseUserUrl(""), null);
  assert.equal(parseUserUrl("mon site.fr"), null);
  assert.equal(parseUserUrl("javascript:alert(1)"), null);
  assert.equal(parseUserUrl("ftp://monsite.fr"), null);
  assert.equal(parseUserUrl("https://user:pass@monsite.fr"), null);
});

test("normalisation : fragments, suivi, pagination, slash final, www, port, tri des paramètres", () => {
  const prefer = { host: "www.monsite.fr", protocol: "https:" };
  const n = (u: string) => normalizeUrl(u, "https://www.monsite.fr/", prefer)?.href;
  assert.equal(n("/boutique/#avis"), "https://www.monsite.fr/boutique");
  assert.equal(n("/boutique?utm_source=x&utm_medium=y&gclid=1&fbclid=2"), "https://www.monsite.fr/boutique");
  assert.equal(n("/blog?page=3"), "https://www.monsite.fr/blog");
  assert.equal(n("/blog/page/4/"), "https://www.monsite.fr/blog");
  assert.equal(n("http://monsite.fr:80/a/"), "https://www.monsite.fr/a");
  assert.equal(n("https://MONSITE.fr/a?b=2&a=1"), "https://www.monsite.fr/a?a=1&b=2");
  assert.equal(n("/index.html"), "https://www.monsite.fr/");
  assert.equal(n("//autre.fr/x"), "https://autre.fr/x");
  assert.equal(n("mailto:a@b.fr"), undefined);
});

test("clé de dédoublonnage : même page = même clé", () => {
  const k = urlKey("https://www.monsite.fr/Boutique/?utm_campaign=n#x");
  assert.equal(k, urlKey("http://monsite.fr/boutique"));
  assert.equal(urlKey("https://monsite.fr/caf%C3%A9"), urlKey("https://monsite.fr/café"));
  assert.notEqual(urlKey("https://monsite.fr/a?couleur=bleu"), urlKey("https://monsite.fr/a?couleur=rouge"));
  assert.equal(bareHost("WWW.Monsite.fr."), "monsite.fr");
  assert.equal(displayPath("https://monsite.fr/caf%C3%A9?x=1"), "/café?x=1");
});

test("exclusions : panier, compte, recherche, fichiers", () => {
  const ex = (u: string) => exclusionReason(new URL(u));
  assert.equal(ex("https://s.fr/panier"), "panier, compte ou recherche");
  assert.equal(ex("https://s.fr/cart"), "panier, compte ou recherche");
  assert.equal(ex("https://s.fr/mon-compte/commandes"), "panier, compte ou recherche");
  assert.equal(ex("https://s.fr/?s=bol"), "recherche ou filtre");
  assert.equal(ex("https://s.fr/catalogue?q=bol"), "recherche ou filtre");
  assert.equal(ex("https://s.fr/doc.PDF"), "fichier");
  assert.equal(ex("https://s.fr/image.jpg"), "fichier");
  assert.equal(ex("https://s.fr/services"), null);
  assert.equal(ex("https://s.fr/blog/article-sur-le-panier-ideal"), null);
});

test("robots.txt : groupe le plus précis, règle la plus longue, Allow à égalité, jokers", () => {
  const r = parseRobots(
    `User-agent: *\nDisallow: /private\nDisallow: /*.php$\nAllow: /private/public\nCrawl-delay: 2\n\nUser-agent: Googlebot\nDisallow: /\n\nSitemap: https://s.fr/sitemap.xml`,
    "chatseobot",
  );
  assert.equal(r.isAllowed("/"), true);
  assert.equal(r.isAllowed("/private/x"), false);
  assert.equal(r.isAllowed("/private/public/a"), true);
  assert.equal(r.isAllowed("/index.php"), false);
  assert.equal(r.isAllowed("/index.php?x=1"), true);
  assert.equal(r.crawlDelay, 2);
  assert.deepEqual(r.sitemaps, ["https://s.fr/sitemap.xml"]);
  const own = parseRobots("User-agent: ChatSEOBot\nDisallow: /\n\nUser-agent: *\nAllow: /", "chatseobot");
  assert.equal(own.isAllowed("/page"), false);
  assert.equal(parseRobots("User-agent: *\nDisallow:", "chatseobot").isAllowed("/x"), true);
});

test("sitemap : pages et index", () => {
  const s = parseSitemap(`<urlset><url><loc> https://s.fr/a?x=1&amp;y=2 </loc></url><url><loc><![CDATA[https://s.fr/b]]></loc></url></urlset>`);
  assert.deepEqual(s.pages, ["https://s.fr/a?x=1&y=2", "https://s.fr/b"]);
  const idx = parseSitemap(`<sitemapindex><sitemap><loc>https://s.fr/s1.xml</loc></sitemap></sitemapindex>`);
  assert.deepEqual(idx.sitemaps, ["https://s.fr/s1.xml"]);
});

test("nom du site : og:site_name, sinon la partie du titre qui ressemble à la marque", () => {
  assert.equal(siteNameFrom("Accueil", "Atelier Lune", "atelier-lune.fr"), "Atelier Lune");
  assert.equal(siteNameFrom("Poterie artisanale à Nantes | Atelier Lune", "", "atelier-lune.fr"), "Atelier Lune");
  assert.equal(siteNameFrom("", "", "atelier-lune.fr"), "atelier-lune.fr");
});
