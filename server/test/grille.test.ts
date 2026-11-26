/**
 * La grille portée côté serveur doit donner exactement les mêmes points que la fonction `analyse`
 * du prototype (reference/sonde-seo.html), exécutée ici dans jsdom sur les mêmes pages.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { analysePage, CATEGORIES, CRITERIA } from "../src/analyse/grille.ts";
import { aggregate, type PageRecord } from "../src/analyse/aggregate.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.join(here, "fixtures/site");

const ID_MAP: Record<string, string> = {
  title: "title", desc: "meta_description", h1: "h1", hier: "heading_hierarchy", canon: "canonical", lang: "lang",
  words: "word_count", align: "title_h1_match", h2: "h2_sections", uniq: "description_distinct",
  viewport: "viewport", https: "https", index: "indexable", charset: "charset", ld: "structured_data", js: "blocking_scripts",
  alt: "image_alt", imgperf: "image_dimensions", inlinks: "internal_links", anchors: "link_text",
  og: "open_graph", tw: "twitter_card", fav: "favicon",
};

type ProtoCheck = { id: string; got: number; max: number };
function loadPrototype(): (html: string, url: string) => { checks: ProtoCheck[]; score: number } {
  const ref = readFileSync(path.join(here, "../../reference/sonde-seo.html"), "utf8");
  const pick = (start: string, end: string) => {
    const a = ref.indexOf(start);
    const b = ref.indexOf(end, a);
    assert.ok(a >= 0 && b > a, `extrait introuvable : ${start}`);
    return ref.slice(a, b);
  };
  const code = [
    pick("const cut =", "\n"),
    pick("const CATS =", "\n"),
    pick("const GENERIC =", "\n"),
    pick("function analyse(html, url){", "/* ---------- Correctifs"),
    "return analyse;",
  ].join("\n");
  const { window } = new JSDOM("");
  return new Function("DOMParser", code)(window.DOMParser);
}

const protoAnalyse = loadPrototype();

const extraPages: Record<string, string> = {
  vide: "<html><head></head><body></body></html>",
  parfaite: `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>Cours de poterie à Nantes pour débutants</title>
<meta name="description" content="Apprenez la poterie à Nantes en petit groupe : tournage, émaillage et cuisson. Cours le mardi soir et le samedi matin.">
<meta name="viewport" content="width=device-width"><link rel="canonical" href="https://x.example/cours"><link rel="icon" href="/f.ico">
<meta property="og:title" content="a"><meta property="og:description" content="b"><meta property="og:image" content="c"><meta name="twitter:card" content="summary">
<script type="application/ld+json">{"@type":"Course"}</script></head><body><h1>Cours de poterie à Nantes</h1><h2>Programme</h2><h2>Tarifs</h2>
<p>${"mot ".repeat(320)}</p><a href="/a">Page A</a><a href="/b">Page B</a><a href="/c">Page C</a><img src="x.jpg" alt="Tour" loading="lazy"></body></html>`,
  http_et_titre_long: `<html><head><title>${"Titre beaucoup trop long ".repeat(4)}</title><meta name="description" content="Court"></head><body><h3>Seul</h3><img src="a"><img src="b" width="1" height="1"><a href="">x</a><a href="https://y.example/">ici</a></body></html>`,
  description_egale_titre: `<html><head><title>Bols en grès</title><meta name="description" content="bols en grès"></head><body><h1>Assiettes</h1><h2>A</h2><h4>B</h4></body></html>`,
};

const cases: Array<{ name: string; html: string; url: string }> = [
  ...readdirSync(SITE)
    .filter((f) => f.endsWith(".html"))
    .map((f) => ({ name: f, html: readFileSync(path.join(SITE, f), "utf8"), url: `https://atelier-lune.example/${f === "index.html" ? "" : f.replace(".html", "")}` })),
  ...Object.entries(extraPages).map(([name, html]) => ({ name, html, url: name.startsWith("http") ? "http://x.example/p" : "https://x.example/p" })),
];

test("la grille compte 23 critères pour 100 points, répartis 30/20/25/15/10", () => {
  assert.equal(CRITERIA.length, 23);
  assert.equal(CRITERIA.reduce((a, c) => a + c.max, 0), 100);
  for (const cat of CATEGORIES) assert.equal(CRITERIA.filter((c) => c.category === cat.id).reduce((a, c) => a + c.max, 0), cat.max);
  assert.equal(new Set(CRITERIA.map((c) => c.id)).size, 23);
});

for (const c of cases) {
  test(`mêmes points que le prototype : ${c.name}`, () => {
    const proto = protoAnalyse(c.html, c.url);
    const mine = analysePage(c.html, c.url);
    assert.equal(mine.checks.length, proto.checks.length);
    for (const pc of proto.checks) {
      const mc = mine.checks.find((k) => k.id === ID_MAP[pc.id]);
      assert.ok(mc, `critère ${pc.id} absent`);
      assert.equal(mc.max, pc.max, `max de ${pc.id}`);
      assert.equal(mc.points, pc.got, `points de ${pc.id} (${mc.found})`);
    }
    assert.equal(mine.score, proto.score);
    assert.equal(mine.categories.reduce((a, k) => a + k.max, 0), 100);
  });
}

test("une page parfaite obtient 100, une page vide presque rien", () => {
  assert.equal(analysePage(extraPages.parfaite, "https://x.example/cours").score, 100);
  const vide = analysePage(extraPages.vide, "https://x.example/");
  // Seuls restent : HTTPS (4), indexable (6), scripts (2), images absentes (6 + 3), liens vagues absents (3).
  assert.equal(vide.score, 24);
});

test("chaque critère porte found, expected, message et un statut cohérent", () => {
  const a = analysePage(readFileSync(path.join(SITE, "services.html"), "utf8"), "https://atelier-lune.example/services");
  for (const k of a.checks) {
    assert.ok(k.expected.length > 0 && k.message.length > 0);
    assert.equal(k.status, k.points === k.max ? "pass" : k.points === 0 ? "fail" : "warn");
  }
  const title = a.checks.find((k) => k.id === "title")!;
  assert.equal(title.found, "« Services » (8 caractères)");
  assert.equal(title.points, 3);
  const h1 = a.checks.find((k) => k.id === "h1")!;
  assert.equal(h1.status, "warn");
  assert.match(h1.found!, /^2 H1/);
});

test("regroupement : gravités, doublons, points positifs, recommandations", () => {
  const pages: PageRecord[] = readdirSync(SITE)
    .filter((f) => f.endsWith(".html") && f !== "mentions-legales.html")
    .map((f, i) => {
      const url = `https://atelier-lune.example/${f === "index.html" ? "" : f.replace(".html", "")}`;
      const a = analysePage(readFileSync(path.join(SITE, f), "utf8"), url);
      return { id: `pg_${i}`, url, path: new URL(url).pathname, score: a.score, checks: a.checks, facts: a.facts, categories: a.categories };
    });
  const agg = aggregate(pages, "Atelier Lune");
  assert.equal(agg.score, Math.round(pages.reduce((a, p) => a + p.score, 0) / pages.length));
  const byId = new Map(agg.issues.map((i) => [i.id, i]));
  assert.equal(byId.get("indexable")?.severity, "critical");
  assert.equal(byId.get("indexable")?.pagesAffected, 1);
  assert.equal(byId.get("favicon")?.severity, "info");
  const dupT = byId.get("duplicate_title")!;
  assert.equal(dupT.pagesAffected, 2);
  assert.equal(dupT.pointsLost, 0);
  assert.equal(dupT.evidence.length, 2);
  assert.match(dupT.evidence[0].found!, /identique sur 2 pages/);
  assert.ok(byId.get("duplicate_description"));
  // Tri par points perdus décroissants.
  for (let i = 1; i < agg.issues.length; i++) assert.ok(agg.issues[i - 1].pointsLost >= agg.issues[i].pointsLost);
  // Une recommandation par problème, rangs 1..n, la page masquée à Google en premier.
  assert.equal(agg.recommendations.length, agg.issues.length);
  assert.deepEqual(agg.recommendations.map((r) => r.rank), agg.recommendations.map((_, i) => i + 1));
  assert.equal(agg.recommendations[0].issueId, "indexable");
  // Points positifs : critères validés sur au moins 90 % des pages.
  for (const s of agg.strengths) assert.ok(s.pagesPassing / s.pagesTotal >= 0.9);
  assert.ok(agg.strengths.some((s) => s.id === "https"));
  // Correctif construit à partir des vraies valeurs de la page.
  const canon = byId.get("canonical")!;
  assert.match(canon.fix.snippet!.code, /<link rel="canonical" href="https:\/\/atelier-lune\.example\//);
  const desc = byId.get("meta_description")!;
  assert.equal(desc.evidence[0].found, "Aucune description");
  assert.ok(desc.fix.snippet && desc.fix.snippet.code.includes('<meta name="description"'));
  // Les catégories sont des moyennes à une décimale.
  for (const c of agg.categories) assert.equal(c.score, Math.round(c.score * 10) / 10);
});
