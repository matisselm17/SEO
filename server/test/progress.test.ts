/**
 * Lot E (docs/format-echange.md, « Évolution et rapport ») : GET …/progress (analyses, comparaison à périmètre égal,
 * corrections par statut, séparation des boutiques, cohérence avec la Vue d'ensemble), boutique protégée par un mot
 * de passe (`storefront_locked`). Sites d'essai servis en local, faux Shopify : aucun appel réseau réel.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import type { CheckStatus, PageCheck } from "../../shared/api.ts";
import { analysePage } from "../src/analyse/grille.ts";
import { urlKey } from "../src/crawl/url.ts";
import { setAllowPrivateHosts } from "../src/net/fetch.ts";
import { insertVerification } from "../src/shopify/repo.ts";
import type { Store } from "../src/store.ts";
import { insertDoneAudit, PAGES, shop } from "./helpers/boutique.ts";
import { SHOP_A, SHOP_B, twoShops, withToken } from "./helpers/boutiques.ts";
import { testEnv } from "./helpers/env.ts";

before(() => setAllowPrivateHosts(true));
after(() => setAllowPrivateHosts(false));

const read = async (res: Response) => {
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as any) : null };
};
const ZERO = { verified: 0, applied: 0, failed: 0, cancelled: 0, resourcesOptimized: 0, firstAt: null, lastAt: null };

// ───────── Jeu de données construit à la main

const HTML = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Bague en or de la boutique d'essai</title><meta name="description" content="Une description."></head><body><h1>Bague</h1><p>Texte.</p></body></html>`;
const BASE = analysePage(HTML, "https://site.example/");

/** Critères de la grille : tous validés, sauf ceux de `st`. */
function checks(st: Record<string, CheckStatus>): PageCheck[] {
  return BASE.checks.map((c) => {
    const status = st[c.id] ?? "pass";
    return { ...c, status, points: status === "pass" ? c.max : status === "fail" ? 0 : Math.floor(c.max / 2) };
  });
}

function addAudit(store: Store, siteId: string, pages: Array<{ path: string; score: number; st: Record<string, CheckStatus> }>, state: "done" | "failed" = "done", maxPages = 20) {
  const audit = store.insertAudit(siteId, maxPages);
  for (const p of pages) {
    const url = `https://site.example${p.path}`;
    const cs = checks(p.st);
    store.insertPage({
      audit_id: audit.id,
      site_id: siteId,
      url,
      url_key: urlKey(url)!,
      path: p.path,
      title: "Titre",
      http_status: 200,
      score: p.score,
      issues: cs.filter((c) => c.status !== "pass").length,
      words: 100,
      analyzed_at: new Date().toISOString(),
      checks_json: JSON.stringify(cs),
      facts_json: JSON.stringify(BASE.facts),
      categories_json: JSON.stringify(BASE.categories),
      page_type: null,
    });
  }
  store.updateAudit(audit.id, { state, finished_at: new Date().toISOString(), pages_done: pages.length, pages_queued: 0 });
  return audit;
}

function siteEnv() {
  const env = testEnv();
  const site = env.store.insertSite("https://site.example/", "site.example", "Site");
  return { ...env, site, base: `/api/sites/${site.id}` };
}

// ───────── Analyses

test("progress : aucune analyse terminée → available false, tout vide, corrections à 0", async () => {
  const env = siteEnv();
  addAudit(env.store, env.site.id, [], "failed");
  const r = await read(await env.app.request(`${env.base}/progress`));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { progress: { available: false, initial: null, current: null, timeline: [], comparison: null, corrections: ZERO } });
});

test("progress : une seule analyse → initial = current, comparaison null ; note et compteurs = Vue d'ensemble", async () => {
  const env = siteEnv();
  const { audit } = insertDoneAudit(env.store, env.site.id, "site.example", PAGES);
  const p = (await read(await env.app.request(`${env.base}/progress`))).body.progress;
  const ov = (await read(await env.app.request(`${env.base}/overview`))).body;
  assert.equal(p.available, true);
  assert.deepEqual(p.initial, p.current);
  assert.equal(p.timeline.length, 1);
  assert.equal(p.comparison, null);
  assert.equal(p.current.auditId, audit.id);
  assert.equal(p.current.score, ov.score.value);
  assert.deepEqual(p.current.issues, ov.counts.issues);
  assert.equal(p.current.pagesAnalyzed, ov.site.pagesAnalyzed);
  assert.equal(p.current.maxPages, 20);
  assert.equal(typeof p.current.finishedAt, "string");
});

test("progress : deux analyses, pages communes et non communes → compteurs exacts (corrigés, restants, nouveaux)", async () => {
  const env = siteEnv();
  const a1 = addAudit(env.store, env.site.id, [
    { path: "/", score: 60, st: { title: "pass", meta_description: "fail", h1: "warn" } },
    { path: "/a", score: 40, st: { title: "fail", meta_description: "fail" } },
    { path: "/ancienne", score: 10, st: { title: "fail" } },
  ]);
  // Analyse échouée entre les deux : elle ne compte pas.
  addAudit(env.store, env.site.id, [{ path: "/", score: 5, st: { title: "fail" } }], "failed");
  const a2 = addAudit(env.store, env.site.id, [
    { path: "/", score: 80, st: { h1: "warn" } },
    // Même page, chemin écrit autrement (majuscule, barre finale) : reconnue par son chemin normalisé.
    { path: "/A/", score: 45, st: { meta_description: "fail", h1: "fail" } },
    { path: "/nouvelle", score: 90, st: {} },
  ]);
  const p = (await read(await env.app.request(`${env.base}/progress`))).body.progress;
  assert.equal(p.initial.auditId, a1.id);
  assert.equal(p.current.auditId, a2.id);
  assert.deepEqual(p.timeline.map((x: any) => x.auditId), [a1.id, a2.id]);
  // « / » : description corrigée, H1 restant. « /a » : titre corrigé, description restante, H1 nouveau.
  assert.deepEqual(p.comparison, {
    pagesInCommon: 2,
    pagesOnlyInitial: 1,
    pagesOnlyCurrent: 1,
    scoreInitial: 50,
    scoreCurrent: 63,
    issuesFixed: 2,
    issuesRemaining: 2,
    issuesNew: 1,
  });
  // Notes de chaque analyse sur toutes ses pages, comme la Vue d'ensemble les calculait.
  assert.equal(p.initial.score, Math.round((60 + 40 + 10) / 3));
  assert.equal(p.current.score, Math.round((80 + 45 + 90) / 3));
  const ov = (await read(await env.app.request(`${env.base}/overview`))).body;
  assert.equal(p.current.score, ov.score.value);
  assert.deepEqual(p.current.issues, ov.counts.issues);
});

test("progress : aucune page commune → comparaison null ; timeline limitée aux 50 plus récentes", async () => {
  const env = siteEnv();
  const first = addAudit(env.store, env.site.id, [{ path: "/x", score: 50, st: {} }]);
  for (let i = 0; i < 51; i++) addAudit(env.store, env.site.id, [{ path: `/p${i}`, score: i, st: {} }]);
  const p = (await read(await env.app.request(`${env.base}/progress`))).body.progress;
  assert.equal(p.initial.auditId, first.id);
  assert.equal(p.timeline.length, 50);
  assert.equal(p.timeline.at(-1).auditId, p.current.auditId);
  assert.notEqual(p.timeline[0].auditId, first.id);
  assert.equal(p.comparison, null);
});

// ───────── Corrections

function insertChange(store: Store, o: { id: string; host: string; resource: string; field?: string; appliedAt: string; kind?: string; status?: string; restores?: string | null }) {
  store.db
    .prepare(
      `INSERT INTO shopify_changes (id, site_host, resource_id, resource_gid, resource_type, resource_title, path, field, image_id, image_gid, image_url, locale,
        before_value, after_value, applied_at, kind, restores_change_id, restored_by_change_id, status, requested_value, after_verified)
       VALUES (?, ?, ?, 'gid://shopify/Product/1', 'product', 'Bague', '/products/bague-or', ?, NULL, NULL, NULL, NULL, NULL, 'Nouveau', ?, ?, ?, NULL, ?, 'Nouveau', 1)`,
    )
    .run(o.id, o.host, o.resource, o.field ?? "seo_title", o.appliedAt, o.kind ?? "edit", o.restores ?? null, o.status ?? "applied");
}
const verify = (store: Store, changeId: string, host: string, outcome: "verified" | "failed" | "inconclusive") =>
  insertVerification(store.db, { change_id: changeId, site_host: host, checked_at: new Date().toISOString(), outcome, reason: outcome === "verified" ? "ok" : outcome === "failed" ? "not_displayed" : "page_unavailable", message: "m", url: null, displayed: null, rendered: null, criterion_id: null, criterion_before: null, criterion_after: null, criterion_points: null, criterion_max: null, criterion_message: null, page_score_before: null, page_score_after: null });

test("progress : corrections comptées par statut actuel, depuis la création du site, lignes « restore » exclues", async () => {
  const ctx = await shop({ verification: { setTimer: () => {} } });
  const host = ctx.site.host;
  const at = (s: number) => new Date(Date.parse(ctx.site.created_at) + s * 1000).toISOString();
  // Vérifiées : deux sur le même élément (champs différents), une sur un autre → 2 éléments optimisés.
  insertChange(ctx.store, { id: "chg_verifiee1", host, resource: "shr_r1", field: "seo_title", appliedAt: at(10) });
  insertChange(ctx.store, { id: "chg_verifiee2", host, resource: "shr_r1", field: "seo_description", appliedAt: at(20) });
  insertChange(ctx.store, { id: "chg_verifiee3", host, resource: "shr_r2", appliedAt: at(30) });
  for (const id of ["chg_verifiee1", "chg_verifiee2", "chg_verifiee3"]) verify(ctx.store, id, host, "verified");
  // Échec de vérification ; sans conclusion (reste « appliquée ») ; sans relecture ; en cours de vérification.
  insertChange(ctx.store, { id: "chg_echec0001", host, resource: "shr_r3", appliedAt: at(40) });
  verify(ctx.store, "chg_echec0001", host, "failed");
  insertChange(ctx.store, { id: "chg_inconclu1", host, resource: "shr_r4", appliedAt: at(50) });
  verify(ctx.store, "chg_inconclu1", host, "inconclusive");
  insertChange(ctx.store, { id: "chg_appliquee", host, resource: "shr_r5", appliedAt: at(60) });
  insertChange(ctx.store, { id: "chg_encours01", host, resource: "shr_r6", appliedAt: at(70) });
  assert.equal(ctx.shopify.verifier.schedule(ctx.site.id, "chg_encours01"), true);
  // Annulée, et sa ligne d'annulation (exclue) ; la date d'une correction annulée ne compte pas.
  insertChange(ctx.store, { id: "chg_annulee01", host, resource: "shr_r7", appliedAt: at(80) });
  insertChange(ctx.store, { id: "chg_annulation", host, resource: "shr_r7", appliedAt: at(90), kind: "restore", restores: "chg_annulee01" });
  ctx.store.db.prepare("UPDATE shopify_changes SET restored_by_change_id = 'chg_annulation' WHERE id = 'chg_annulee01'").run();
  // Exclues : refusée par Shopify, d'avant la création du site, d'un autre site.
  insertChange(ctx.store, { id: "chg_refusee01", host, resource: "shr_r8", appliedAt: at(100), status: "failed" });
  insertChange(ctx.store, { id: "chg_avant0001", host, resource: "shr_r9", appliedAt: "2020-01-01T00:00:00.000Z" });
  insertChange(ctx.store, { id: "chg_ailleurs1", host: "autre.example", resource: "shr_r1", appliedAt: at(5) });
  const p = (await read(await ctx.app.request(`${ctx.base}/progress`))).body.progress;
  assert.deepEqual(p.corrections, { verified: 3, applied: 3, failed: 1, cancelled: 1, resourcesOptimized: 2, firstAt: at(10), lastAt: at(70) });
});

test("progress : sans boutique reliée, tous les compteurs de corrections valent 0", async () => {
  const env = siteEnv();
  insertChange(env.store, { id: "chg_sansshop1", host: env.site.host, resource: "shr_r1", appliedAt: new Date(Date.now() + 1000).toISOString() });
  verify(env.store, "chg_sansshop1", env.site.host, "verified");
  const p = (await read(await env.app.request(`${env.base}/progress`))).body.progress;
  assert.deepEqual(p.corrections, ZERO);
});

// ───────── Séparation des boutiques

test("progress (intégré) : le site de A répond 404 à B, comme un site inexistant ; 200 à A", async () => {
  const ctx = await twoShops();
  const other = await read(await ctx.app.request(`${ctx.A.base}/progress`, withToken(SHOP_B)));
  assert.equal(other.status, 404);
  assert.equal(other.body.error.code, "not_found");
  assert.ok(!JSON.stringify(other.body).includes(ctx.A.host));
  const mine = await read(await ctx.app.request(`${ctx.A.base}/progress`, withToken(SHOP_A)));
  assert.equal(mine.status, 200);
  assert.equal(mine.body.progress.available, true);
  // La modification faite à la préparation n'a pas encore de relecture : « appliquée ».
  assert.equal(mine.body.progress.corrections.applied + mine.body.progress.corrections.verified, 1);
});

// ───────── Boutique protégée par un mot de passe

function serve(handler: (path: string, res: http.ServerResponse) => void): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => handler(new URL(req.url ?? "/", "http://x").pathname, res));
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ origin: `http://localhost:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    }),
  );
}
const page = (res: http.ServerResponse, body: string) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html lang="fr"><head><title>Page de la boutique d'essai en ligne</title></head><body><h1>Titre</h1>${body}</body></html>`);
};

async function audit(handler: Parameters<typeof serve>[0], shopDomain: string | null = null) {
  const srv = await serve(handler);
  try {
    const env = testEnv();
    const site = env.store.insertSite(`${srv.origin}/`, "localhost", "Essai", shopDomain);
    const a = env.store.insertAudit(site.id, 10);
    await env.crawler.start(site, a);
    return { row: env.store.getAudit(a.id)!, status: env.store.auditStatus(env.store.getAudit(a.id)!) };
  } finally {
    await srv.close();
  }
}

test("storefront_locked : la page de départ d'un site reconnu comme Shopify redirige vers /password → analyse « failed » avec l'erreur et les textes exacts du contrat", async () => {
  const { status } = await audit((p, res) => {
    if (p === "/") {
      res.writeHead(302, { location: "/password" });
      return res.end();
    }
    if (p === "/password") return page(res, `<link rel="stylesheet" href="https://cdn.shopify.com/s/files/theme.css"><form><input type=password></form>`);
    res.writeHead(404);
    res.end();
  });
  assert.equal(status.state, "failed");
  assert.deepEqual(status.error, {
    code: "storefront_locked",
    message: "Votre boutique en ligne est protégée par un mot de passe : ses pages publiques ne peuvent pas être analysées.",
    action:
      "Retirez le mot de passe (Boutique en ligne > Préférences), puis relancez l'analyse. En attendant, les titres, descriptions et textes d'images lus dans Shopify restent disponibles dans la section Boutique Shopify.",
  });
  assert.equal(status.pagesDone, 0);
});

test("storefront_locked : un site ordinaire avec une page /password (liée, non redirigée) ou une redirection ailleurs est analysé normalement", async () => {
  const linked = await audit((p, res) => {
    if (p === "/") return page(res, `<a href="/password">Espace membre</a>`);
    if (p === "/password") return page(res, "<p>Mot de passe oublié</p>");
    res.writeHead(404);
    res.end();
  });
  assert.equal(linked.status.state, "done");
  assert.equal(linked.status.error, null);
  assert.equal(linked.status.pagesDone, 1, "la page d'accueil est notée (/password est hors parcours, comme toute page de compte)");
  const elsewhere = await audit((p, res) => {
    if (p === "/") {
      res.writeHead(302, { location: "/accueil" });
      return res.end();
    }
    if (p === "/accueil") return page(res, "<p>Bienvenue</p>");
    res.writeHead(404);
    res.end();
  });
  assert.equal(elsewhere.status.state, "done");
  assert.equal(elsewhere.status.error, null);
});

const toPassword = (body: string) => (p: string, res: http.ServerResponse) => {
  if (p === "/") {
    res.writeHead(302, { location: "/password" });
    return res.end();
  }
  if (p === "/password") return page(res, body);
  res.writeHead(404);
  res.end();
};

test("storefront_locked : site rattaché à une boutique, page du mot de passe sans marque de Shopify → storefront_locked", async () => {
  const { status } = await audit(toPassword("<form><input type=password></form>"), SHOP_A);
  assert.equal(status.state, "failed");
  assert.equal(status.error?.code, "storefront_locked");
});

test("storefront_locked : site ordinaire (ni rattaché ni reconnu comme Shopify) redirigé vers /password → jamais storefront_locked, chemin ordinaire", async () => {
  const { status } = await audit(toPassword("<form><input type=password></form>"));
  assert.notEqual(status.error?.code, "storefront_locked");
  // Comme avant le lot E : la page reçue après la redirection est analysée comme la page de départ.
  assert.equal(status.state, "done");
  assert.equal(status.error, null);
});

test("coût : la frise d'un site de nombreuses analyses ne garde pas le détail de leurs pages ; caches bornés", async () => {
  const { AUDIT_CACHE_MAX, SUMMARY_CACHE_MAX } = await import("../src/store.ts");
  const env = siteEnv();
  for (let i = 0; i < 60; i++) addAudit(env.store, env.site.id, [{ path: "/", score: 40 + (i % 50), st: i % 2 ? { title: "fail" } : {} }, { path: `/p${i}`, score: 70, st: {} }]);
  const res = await read(await env.app.request(`${env.base}/progress`));
  assert.equal(res.status, 200);
  assert.equal(res.body.progress.timeline.length, 50);
  const sizes = env.store.cacheSizes();
  assert.ok(sizes.records <= AUDIT_CACHE_MAX, `enregistrements des pages en mémoire pour ${sizes.records} analyses`);
  assert.ok(sizes.aggregates <= AUDIT_CACHE_MAX, `agrégats en mémoire pour ${sizes.aggregates} analyses`);
  assert.ok(sizes.records <= 2, `la frise a gardé le détail des pages de ${sizes.records} analyses`);
  assert.ok(sizes.summaries <= SUMMARY_CACHE_MAX);
  // Même résultat chiffré qu'un agrégat complet, pour chaque point de la frise.
  for (const pt of res.body.progress.timeline) assert.equal(pt.score, env.store.aggregate(pt.auditId, "Site").score);
  assert.ok(env.store.cacheSizes().aggregates <= AUDIT_CACHE_MAX, "cache des agrégats non borné");
});
