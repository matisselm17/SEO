/**
 * Lot B, mode intégré à plusieurs boutiques (docs/format-echange.md, « Plusieurs boutiques (mode intégré) ») :
 * séparation stricte des sites, création automatique du site de chaque boutique, jetons chiffrés en base,
 * migrations, en-têtes, mode local inchangé, configuration. Faux Shopify : aucun appel réseau réel.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ConfigError, loadConfig } from "../src/config.ts";
import { open, parseEncryptionKey, seal, SecretboxKeyError } from "../src/crypto/secretbox.ts";
import { MIGRATIONS, openDb, runMigrations } from "../src/db.ts";
import { appFrameAncestors } from "../src/http.ts";
import { dbTokenStore } from "../src/shopify/shops.ts";
import { Store } from "../src/store.ts";
import { insertDoneAudit, PAGES } from "./helpers/boutique.ts";
import { dumpDb, embeddedShops, HOST_A, HOST_B, multiShopify, SHOP_A, SHOP_B, shopState, twoShops, withToken } from "./helpers/boutiques.ts";
import { fakeShopify, FAKE_CREDS } from "./helpers/fake-shopify.ts";
import { JSON_HEADERS, post, readSse, testEnv } from "./helpers/env.ts";

const read = async (res: Response) => {
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as any) : null, headers: res.headers };
};

/** Journal d'avertissements capturé (et rendu silencieux) pendant `fn`. */
async function captureWarnings<T>(fn: () => Promise<T>): Promise<{ out: T; logs: string }> {
  const warn = console.warn;
  const error = console.error;
  const logs: string[] = [];
  console.warn = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  try {
    return { out: await fn(), logs: logs.join("\n") };
  } finally {
    console.warn = warn;
    console.error = error;
  }
}

// ───────── 1. Isolation croisée : toutes les routes /api/sites/:siteId/…

/** Requête vers une route, avec le corps qu'elle attend (jamais de quoi passer les contrôles de propriété). */
function requestFor(method: string, pathName: string, shop: string): RequestInit {
  if (method === "GET") return withToken(shop);
  if (/\/search-console$/.test(pathName) && method === "POST") {
    const form = new FormData();
    form.set("file", new File(["Requêtes principales,Clics\nbague,3\n"], "export.csv", { type: "text/csv" }));
    return withToken(shop, { method, body: form });
  }
  return withToken(shop, { method, headers: JSON_HEADERS, body: method === "DELETE" ? undefined : JSON.stringify({}) });
}

test("isolation : avec le jeton de B, chaque route du site de A répond 404 not_found, sans rien écrire", async () => {
  const ctx = await twoShops();
  const { A } = ctx;
  const routes = ctx.app.routes
    .filter((r) => r.path.startsWith("/api/sites/:siteId") && r.method !== "ALL")
    .map((r) => ({ method: r.method, path: r.path }));
  // La liste vient de l'application elle-même : toute route ajoutée y entre d'office.
  assert.ok(routes.length >= 45, `routes trouvées : ${routes.length}`);
  for (const must of ["/api/sites/:siteId/events", "/api/sites/:siteId/chat", "/api/sites/:siteId/shopify/changes/:changeId/verify", "/api/sites/:siteId/shopify/batches/:batchId/items/:itemId"]) {
    assert.ok(routes.some((r) => r.path === must), `route ${must} couverte`);
  }
  const fill = (p: string) =>
    p
      .replace(":siteId", A.site.id)
      .replace(":issueId", A.issueId)
      .replace(":pageId", A.pageIds["/"])
      .replace(":resourceId", A.resourceId)
      .replace(":changeId", A.changeId)
      .replace(":batchId", A.batchId)
      .replace(":itemId", A.itemId);
  const before = dumpDb(ctx);
  const mutations = ctx.multi.mutations();
  const graphql = ctx.multi.log.graphql.length;
  const covered: string[] = [];
  for (const r of routes) {
    const url = fill(r.path);
    assert.ok(!url.includes("/:"), `paramètre non rempli : ${r.path}`);
    const label = `${r.method} ${r.path}`;
    const rawRes = await ctx.app.request(url, requestFor(r.method, url, SHOP_B));
    if ((rawRes.headers.get("content-type") ?? "").includes("text/event-stream")) {
      // Un flux ouvert ne se lit pas jusqu'au bout : on le ferme et on échoue tout de suite.
      await rawRes.body?.cancel();
      assert.fail(`${label} : flux ouvert pour une autre boutique (${rawRes.status})`);
    }
    const res = await read(rawRes);
    if (r.method === "DELETE" && r.path === "/api/sites/:siteId") {
      // Action absente du mode intégré : refusée avant même de regarder le site.
      assert.equal(res.status, 403, label);
      assert.equal(res.body.error.code, "not_in_embedded_mode", label);
    } else {
      assert.equal(res.status, 404, `${label} → ${res.status} ${JSON.stringify(res.body)}`);
      assert.equal(res.body.error.code, "not_found", label);
      assert.equal(res.body.error.message, "Ce site est introuvable. Il a peut-être été supprimé.", `${label} : même réponse qu'un site inexistant`);
    }
    // Rien de A dans la réponse.
    const raw = JSON.stringify(res.body);
    for (const leak of [HOST_A, A.site.id, "Boutique A", SHOP_A]) assert.ok(!raw.includes(leak), `${label} : ${leak}`);
    covered.push(label);
  }
  assert.equal(dumpDb(ctx), before, "aucune écriture en base");
  assert.equal(ctx.multi.mutations(), mutations, "aucune écriture chez Shopify");
  assert.equal(ctx.multi.log.graphql.length, graphql, "aucun appel à Shopify");
  assert.deepEqual(ctx.multi.log.violations, []);
  // Pour le compte rendu : la liste exacte des routes couvertes.
  if (process.env.LISTE_ROUTES) console.log(covered.join("\n"));
  // Un site inexistant répond exactement pareil.
  const ghost = await read(await ctx.app.request("/api/sites/site_inexistant/overview", withToken(SHOP_B)));
  assert.equal(ghost.status, 404);
  const mine = await read(await ctx.app.request(`/api/sites/${A.site.id}/overview`, withToken(SHOP_B)));
  assert.deepEqual(mine.body, ghost.body);
});

test("isolation : le flux /events du site de A est refusé à B (404), et s'ouvre pour A", async () => {
  const ctx = await twoShops();
  const res = await ctx.app.request(`/api/sites/${ctx.A.site.id}/events`, withToken(SHOP_B));
  assert.equal(res.status, 404);
  assert.equal(((await res.json()) as any).error.code, "not_found");
  const ok = await ctx.app.request(`/api/sites/${ctx.A.site.id}/events`, withToken(SHOP_A));
  assert.equal(ok.status, 200);
  const evs = await readSse(ok, (e) => e.event === "site");
  assert.equal(evs[0].data.site.id, ctx.A.site.id);
});

test("isolation : sans boutique (site d'avant le mode intégré, jamais rattaché), un site répond 404 à toute boutique", async () => {
  const ctx = await twoShops();
  const orphan = ctx.store.insertSite("https://orphelin.example/", "orphelin.example", "Orphelin");
  for (const shop of [SHOP_A, SHOP_B]) {
    assert.equal((await ctx.app.request(`/api/sites/${orphan.id}`, withToken(shop))).status, 404);
    assert.equal((await ctx.app.request(`/api/sites/${orphan.id}/events`, withToken(shop))).status, 404);
  }
});

// ───────── 2. Identifiants croisés

test("identifiants croisés : site de B dans l'adresse + identifiant de A → 404, rien d'écrit chez A ni chez Shopify", async () => {
  // La mesure de vitesse est une section facultative (lot D) : ouverte ici pour éprouver son contrôle de propriété.
  const ctx = await twoShops({ config: { embeddedFeatures: ["pagespeed"] } });
  const { A, B } = ctx;
  const before = dumpDb(ctx);
  const mutations = ctx.multi.mutations();
  const as = (init: RequestInit = {}) => withToken(SHOP_B, init);
  const cases: Array<[string, string, RequestInit]> = [
    ["page", `${B.base}/pages/${A.pageIds["/"]}`, as()],
    ["élément", `${B.base}/shopify/resources/${A.resourceId}`, as()],
    ["annulation d'une modification", `${B.base}/shopify/changes/${A.changeId}/restore`, as({ method: "POST", headers: JSON_HEADERS })],
    ["vérification d'une modification", `${B.base}/shopify/changes/${A.changeId}/verify`, as({ method: "POST", headers: JSON_HEADERS })],
    ["lot", `${B.base}/shopify/batches/${A.batchId}`, as()],
    ["écriture d'un lot", `${B.base}/shopify/batches/${A.batchId}/apply`, as({ method: "POST", headers: JSON_HEADERS })],
    ["annulation d'un lot", `${B.base}/shopify/batches/${A.batchId}/restore`, as({ method: "POST", headers: JSON_HEADERS })],
    ["arrêt d'un lot", `${B.base}/shopify/batches/${A.batchId}/stop`, as({ method: "POST", headers: JSON_HEADERS })],
    ["abandon d'un lot", `${B.base}/shopify/batches/${A.batchId}`, as({ method: "DELETE", headers: JSON_HEADERS })],
    ["ligne de A dans un lot de A", `${B.base}/shopify/batches/${A.batchId}/items/${A.itemId}`, as({ method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ selected: false }) })],
    ["ligne de A dans un lot de B", `${B.base}/shopify/batches/${B.batchId}/items/${A.itemId}`, as({ method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ selected: false }) })],
    // Ressources désignées dans le corps.
    ["élément de A dans une modification", `${B.base}/shopify/changes`, as(post({ resourceId: A.resourceId, field: "seo_title", value: "Piratage", expectedBefore: null }))],
    ["page de A dans une mesure de vitesse", `${B.base}/pagespeed`, as(post({ pageIds: [A.pageIds["/"]] }))],
  ];
  for (const [what, url, init] of cases) {
    const res = await read(await ctx.app.request(url, init));
    assert.equal(res.status, 404, `${what} → ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error.code, "not_found", what);
    assert.ok(!JSON.stringify(res.body).includes(HOST_A), what);
  }
  // Élément de A dans un lot de B : la ligne est refusée (introuvable), aucun lot créé.
  const lot = await read(await ctx.app.request(`${B.base}/shopify/batches`, as(post({ items: [{ resourceId: A.resourceId, field: "seo_title", value: "Piratage" }] }))));
  assert.equal(lot.status, 404, `lot → ${lot.status}`);
  assert.equal(lot.body.error.code, "not_found");
  assert.ok(!JSON.stringify(lot.body).includes(HOST_A));
  assert.equal(dumpDb(ctx), before, "aucune écriture en base");
  assert.equal(ctx.multi.mutations(), mutations, "aucune écriture chez Shopify");
  assert.deepEqual(ctx.multi.log.violations, []);
  // Le problème est un type de constat calculé pour le site de l'adresse : jamais les données de A.
  const issue = await read(await ctx.app.request(`${B.base}/issues/${A.issueId}`, as()));
  assert.ok(!JSON.stringify(issue.body).includes(HOST_A));
});

// ───────── 3. GET /api/sites et création automatique

test("GET /api/sites : seulement le site de la boutique du jeton", async () => {
  const ctx = await twoShops();
  for (const [shop, own] of [[SHOP_A, ctx.A], [SHOP_B, ctx.B]] as const) {
    const r = await read(await ctx.app.request("/api/sites", withToken(shop)));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.sites.map((s: any) => s.id), [own.site.id]);
    assert.ok(!JSON.stringify(r.body).includes("myshopify"), "jamais le domaine myshopify");
  }
});

test("création : un seul site sous requêtes simultanées, rattaché à la boutique, première analyse lancée", async () => {
  const env = embeddedShops();
  let release!: () => void;
  env.multi.ctl.delay.set(SHOP_A, new Promise<void>((r) => (release = r)));
  const reqs = Array.from({ length: 6 }, () => env.app.request("/api/sites", withToken(SHOP_A)));
  await new Promise((r) => setTimeout(r, 20));
  release();
  const res = await Promise.all(reqs.map(async (r) => read(await r)));
  assert.deepEqual(res.map((r) => r.status), [200, 200, 200, 200, 200, 200]);
  const ids = new Set(res.map((r) => r.body.sites[0].id));
  assert.equal(ids.size, 1);
  const site = env.store.getSite([...ids][0])!;
  assert.equal(site.shop_domain, SHOP_A);
  assert.equal(site.host, HOST_A);
  assert.equal(site.url, `https://${HOST_A}/`);
  assert.equal(site.name, "Boutique A");
  assert.equal(env.store.countSites(), 1);
  assert.deepEqual(env.started, [site.id], "première analyse lancée une fois");
  assert.equal(env.multi.log.exchanges.get(SHOP_A), 1);
  // La limite globale du nombre de sites ne s'applique pas.
  const capped = embeddedShops();
  capped.config.limits.maxSites = 0;
  assert.equal((await capped.app.request("/api/sites", withToken(SHOP_B))).status, 200);
});

test("création : un site de même hôte sans boutique est rattaché, sans nouvelle analyse", async () => {
  const env = embeddedShops();
  const old = env.store.insertSite(`https://${HOST_A}/`, HOST_A, "Ancien");
  insertDoneAudit(env.store, old.id, HOST_A, PAGES);
  const r = await read(await env.app.request("/api/sites", withToken(SHOP_A)));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.sites.map((s: any) => s.id), [old.id]);
  assert.equal(env.store.getSite(old.id)!.shop_domain, SHOP_A);
  assert.deepEqual(env.started, [], "pas de nouvelle analyse");
  assert.equal(r.body.sites[0].results.pagesDone, PAGES.length, "données gardées");
});

test("création : un site de même hôte d'une autre boutique → 409 site_exists sans details, rien de créé", async () => {
  const env = embeddedShops();
  // L'hôte public de A est déjà le site de B (situation anormale : domaine transféré).
  const taken = env.store.insertSite(`https://${HOST_A}/`, HOST_A, "Pris", SHOP_B);
  const r = await read(await env.app.request("/api/sites", withToken(SHOP_A)));
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, "site_exists");
  assert.equal(r.body.error.details, undefined);
  assert.ok(!JSON.stringify(r.body).includes(taken.id));
  assert.equal(env.store.countSites(), 1);
  assert.equal(env.store.getSite(taken.id)!.shop_domain, SHOP_B);
  assert.deepEqual(env.started, []);
});

test("création : Shopify indisponible → shopify_unavailable, rien de créé, puis création quand il revient", async () => {
  const env = embeddedShops();
  env.multi.ctl.down.add(SHOP_A);
  const { out: r, logs } = await captureWarnings(async () => read(await env.app.request("/api/sites", withToken(SHOP_A))));
  assert.equal(r.status, 502);
  assert.equal(r.body.error.code, "shopify_unavailable");
  assert.equal(env.store.countSites(), 0);
  assert.ok(!logs.includes(SHOP_A) && !logs.includes(FAKE_CREDS.clientSecret));
  env.multi.ctl.down.delete(SHOP_A);
  // Après le répit de 30 s de l'échange (horloge réelle ici) : on vérifie seulement qu'aucun site n'est inventé entre-temps.
  assert.equal((await read(await env.app.request("/api/sites", withToken(SHOP_A)))).status, 502);
  assert.equal(env.store.countSites(), 0);
});

test("création : boutique sans domaine public (boutique d'essai) → son site a pour hôte son domaine myshopify", async () => {
  const st = shopState(HOST_A, "Boutique A", 0);
  st.shop.host = SHOP_A;
  const env = embeddedShops({ multi: multiShopify([{ domain: SHOP_A, state: st }]) });
  const r = await read(await env.app.request("/api/sites", withToken(SHOP_A)));
  assert.equal(r.status, 200);
  assert.equal(env.store.countSites(), 1);
  assert.equal(env.store.siteByShop(SHOP_A)?.host, SHOP_A);
});

// ───────── 4. Actions absentes du mode intégré

test("intégré : POST /api/sites, DELETE /api/sites/:id et PATCH /api/settings → 403 not_in_embedded_mode", async () => {
  const ctx = await twoShops();
  const before = dumpDb(ctx);
  const cases: Array<[string, RequestInit]> = [
    ["/api/sites", withToken(SHOP_A, post({ url: "https://exemple.fr" }))],
    [`/api/sites/${ctx.A.site.id}`, withToken(SHOP_A, { method: "DELETE", headers: JSON_HEADERS })],
    ["/api/settings", withToken(SHOP_A, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ maxPagesDefault: 10 }) })],
  ];
  for (const [url, init] of cases) {
    const r = await read(await ctx.app.request(url, init));
    assert.equal(r.status, 403, url);
    assert.equal(r.body.error.code, "not_in_embedded_mode", url);
    assert.ok(r.body.error.message && r.body.error.action);
  }
  assert.equal(dumpDb(ctx), before);
  // La lecture des réglages reste possible.
  assert.equal((await ctx.app.request("/api/settings", withToken(SHOP_A))).status, 200);
});

// ───────── 5. Jetons chiffrés en base

function tempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "multi-boutiques-"));
}
function filesText(dir: string): string {
  return readdirSync(dir)
    .map((f) => readFileSync(path.join(dir, f)).toString("latin1"))
    .join("\n");
}

test("jetons : enregistrés chiffrés (aucun jeton en clair dans la base), relus après redémarrage sans nouvel échange", async () => {
  const dir = tempDir();
  const ctx = await twoShops({ dataDir: dir });
  assert.ok(ctx.multi.issued.length >= 4);
  // Colonnes : format versionné, jamais la valeur.
  const rows = ctx.store.db.prepare("SELECT domain, access_token, refresh_token, installed_at, last_seen_at, uninstalled_at FROM shops ORDER BY domain").all() as any[];
  assert.deepEqual(rows.map((r) => r.domain), [SHOP_A, SHOP_B]);
  for (const r of rows) {
    assert.match(r.access_token, /^v1\./);
    assert.match(r.refresh_token, /^v1\./);
    assert.ok(r.installed_at && r.last_seen_at);
    assert.equal(r.uninstalled_at, null);
  }
  // Fichiers de la base (WAL compris) : aucun jeton délivré en clair.
  const text = filesText(dir);
  for (const t of ctx.multi.issued) assert.ok(!text.includes(t), `jeton en clair dans la base : ${t.slice(0, 8)}…`);
  // « Redémarrage » : nouveau registre sur la même base, même faux Shopify.
  const exchanges = { a: ctx.multi.log.exchanges.get(SHOP_A), b: ctx.multi.log.exchanges.get(SHOP_B) };
  const again = embeddedShops({ dataDir: dir, multi: ctx.multi });
  const s = await read(await again.app.request(`/api/sites/${ctx.A.site.id}/shopify`, withToken(SHOP_A)));
  assert.equal(s.status, 200);
  assert.equal(s.body.connection.state, "connected");
  assert.equal(ctx.multi.log.exchanges.get(SHOP_A), exchanges.a, "aucun nouvel échange pour A");
  // Tâche de fond (sans requête identifiée) après redémarrage : les jetons relus suffisent.
  const bg = await again.shopifyRegistry.forShop(SHOP_B).shopify.state(ctx.B.site);
  assert.equal(bg.connection.state, "connected");
  assert.equal(ctx.multi.log.exchanges.get(SHOP_B), exchanges.b);
  assert.deepEqual(ctx.multi.log.violations, []);
});

test("jetons : valeur altérée, clé différente ou ligne copiée d'une boutique à l'autre → absents, nouvel échange, aucune erreur visible", async () => {
  const dir = tempDir();
  const ctx = await twoShops({ dataDir: dir });
  const db = ctx.store.db;
  const count = (shop: string) => ctx.multi.log.exchanges.get(shop) ?? 0;
  const reopen = async (shop: string, site: string, key?: Buffer) => {
    const env = embeddedShops({ dataDir: dir, multi: ctx.multi, encryptionKey: key });
    return captureWarnings(async () => read(await env.app.request(`/api/sites/${site}/shopify`, withToken(shop))));
  };

  // Valeur altérée (un caractère du chiffré).
  const row = db.prepare("SELECT access_token FROM shops WHERE domain = ?").get(SHOP_A) as any;
  const parts = row.access_token.split(".");
  parts[2] = (parts[2][0] === "A" ? "B" : "A") + parts[2].slice(1);
  db.prepare("UPDATE shops SET access_token = ? WHERE domain = ?").run(parts.join("."), SHOP_A);
  let n = count(SHOP_A);
  let { out, logs } = await reopen(SHOP_A, ctx.A.site.id);
  assert.equal(out.status, 200);
  assert.equal(out.body.connection.state, "connected");
  assert.equal(count(SHOP_A), n + 1, "valeur altérée : nouvel échange");
  assert.ok(!ctx.multi.issued.some((t) => logs.includes(t)) && !logs.includes(SHOP_A), "journal sans valeur ni domaine");

  // Clé différente.
  n = count(SHOP_B);
  ({ out, logs } = await reopen(SHOP_B, ctx.B.site.id, randomBytes(32)));
  assert.equal(out.body.connection.state, "connected");
  assert.equal(count(SHOP_B), n + 1, "autre clé : nouvel échange");

  // Ligne copiée : les jetons chiffrés de B posés dans la ligne de A.
  const b = db.prepare("SELECT * FROM shops WHERE domain = ?").get(SHOP_B) as any;
  db.prepare("UPDATE shops SET access_token = ?, refresh_token = ?, access_expires_at = ?, refresh_expires_at = ? WHERE domain = ?").run(b.access_token, b.refresh_token, b.access_expires_at, b.refresh_expires_at, SHOP_A);
  n = count(SHOP_A);
  const before = ctx.multi.log.graphql.length;
  ({ out } = await reopen(SHOP_A, ctx.A.site.id));
  assert.equal(out.body.connection.state, "connected");
  assert.equal(count(SHOP_A), n + 1, "ligne copiée : illisible, nouvel échange");
  // Les appels de A n'ont jamais utilisé le jeton de B.
  for (const call of ctx.multi.log.graphql.slice(before)) assert.equal(call.domain, SHOP_A);
  assert.deepEqual(ctx.multi.log.violations, [], "aucun jeton d'une boutique envoyé à une autre");
});

test("jetons : magasin en base — copie entre champs refusée, effacement, refus définitif du renouvellement", () => {
  const db = openDb(":memory:");
  const key = randomBytes(32);
  const a = dbTokenStore(db, SHOP_A, key);
  assert.equal(a.load(), null);
  const pair = { access: { value: "acces-x", expiresAt: 1_000, scopes: ["read_products"] }, refresh: { value: "renouv-x", expiresAt: 2_000 } };
  a.save(pair);
  assert.deepEqual(a.load(), pair);
  // Le jeton d'accès copié dans la colonne du jeton de renouvellement ne se déchiffre pas.
  db.exec("UPDATE shops SET refresh_token = access_token");
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    assert.equal(a.load(), null);
  } finally {
    console.warn = warn;
  }
  a.save(pair);
  a.clear();
  assert.equal(a.load(), null);
  const r = db.prepare("SELECT access_token, refresh_token FROM shops WHERE domain = ?").get(SHOP_A) as any;
  assert.equal(r.access_token, null);
  assert.equal(r.refresh_token, null);
});

test("jetons : les appels de chaque boutique vont à son domaine avec ses jetons (états séparés)", async () => {
  const ctx = await twoShops();
  for (const call of ctx.multi.log.graphql) assert.ok(call.token.includes(call.domain.split(".")[0]), "jeton du bon domaine");
  assert.ok(ctx.multi.log.graphql.some((c) => c.domain === SHOP_A) && ctx.multi.log.graphql.some((c) => c.domain === SHOP_B));
  assert.notEqual(ctx.shopifyRegistry.forShop(SHOP_A), ctx.shopifyRegistry.forShop(SHOP_B));
  assert.equal(ctx.shopifyRegistry.forShop(SHOP_A), ctx.shopifyRegistry.forShop(SHOP_A), "gardé en mémoire");
  assert.deepEqual(ctx.multi.log.violations, []);
  // Le refus « autre boutique » (shopify_other_shop) protège toujours : B ne peut pas lire le site de A même par son service.
  const st = await ctx.shopifyRegistry.forShop(SHOP_B).shopify.state(ctx.A.site);
  assert.equal(st.connection.state, "other_shop");
});

// ───────── 6. Chiffrement

test("chiffrement : aller-retour, vecteur différent à chaque fois, donnée authentifiée et clé exigées", () => {
  const key = randomBytes(32);
  const a = seal(key, "jeton-secret", "boutique\naccess_token");
  const b = seal(key, "jeton-secret", "boutique\naccess_token");
  assert.match(a, /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/);
  assert.notEqual(a, b, "vecteur aléatoire");
  assert.notEqual(a.split(".")[1], b.split(".")[1]);
  assert.ok(!a.includes("jeton-secret"));
  assert.equal(open(key, a, "boutique\naccess_token"), "jeton-secret");
  assert.equal(open(key, a, "boutique\nrefresh_token"), null, "autre donnée authentifiée");
  assert.equal(open(key, a, "autre\naccess_token"), null);
  assert.equal(open(randomBytes(32), a, "boutique\naccess_token"), null, "autre clé");
  assert.equal(open(key, a.replace(/^v1/, "v2"), "boutique\naccess_token"), null, "version inconnue");
  assert.equal(open(key, "pas-un-secret", "x"), null);
  assert.equal(open(key, null, "x"), null);
  assert.equal(open(key, "", "x"), null);
  assert.equal(open(key, "v1...", "x"), null);
  assert.equal(seal(key, "", "x").startsWith("v1."), true);
  assert.equal(open(key, seal(key, "", "x"), "x"), "");
  for (const bad of [randomBytes(16), randomBytes(31), randomBytes(33), Buffer.alloc(0)]) {
    assert.throws(() => seal(bad, "x", "y"), SecretboxKeyError);
    assert.throws(() => open(bad, a, "y"), SecretboxKeyError);
  }
  // Clé de configuration : 32 octets en base64, rien d'autre.
  const raw = key.toString("base64");
  assert.ok(parseEncryptionKey(raw)?.equals(key));
  assert.ok(parseEncryptionKey(` ${raw} `)?.equals(key));
  assert.equal(parseEncryptionKey(randomBytes(16).toString("base64")), null);
  assert.equal(parseEncryptionKey(randomBytes(48).toString("base64")), null);
  assert.equal(parseEncryptionKey(key.toString("hex")), null);
  assert.equal(parseEncryptionKey(key.toString("base64url").replace(/[A-Za-z0-9]/, "-")), null);
  assert.equal(parseEncryptionKey(""), null);
  assert.equal(parseEncryptionKey(undefined), null);
});

// ───────── 7. Migrations

test("migrations : base à l'ancien schéma avec des données → ouverte sans perte, migrations notées, seconde ouverture sans effet", () => {
  const dir = tempDir();
  // Base complète, puis ramenée à l'ancien schéma (avant le lot B) : sans shops, schema_migrations ni sites.shop_domain.
  {
    const db = openDb(dir);
    const store = new Store(db);
    const site = store.insertSite("https://ancien.example/", "ancien.example", "Ancien site");
    insertDoneAudit(store, site.id, "ancien.example", ["/", "/contact"]);
    store.setSetting("maxPagesDefault", "42");
    db.exec("DROP INDEX sites_shop_domain; ALTER TABLE sites DROP COLUMN shop_domain; DROP TABLE shops; DROP TABLE schema_migrations;");
    // Lot C : tables des appels de Shopify et déclencheurs d'origine (sans autorisation d'effacement).
    db.exec(`DROP TABLE webhook_events; DROP TABLE shop_redactions;
      DROP TRIGGER shopify_changes_no_delete; DROP TRIGGER shopify_verifications_no_delete; DROP TRIGGER shopify_batches_no_delete; DROP TRIGGER shopify_batch_items_no_delete;
      DROP TABLE history_delete_grant;`);
    db.close();
  }
  {
    const raw = new DatabaseSync(path.join(dir, "chat-seo.sqlite"));
    const cols = (raw.prepare("PRAGMA table_info(sites)").all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(!cols.includes("shop_domain"), "ancien schéma reconstitué");
    raw.close();
  }
  const db = openDb(dir);
  const store = new Store(db);
  const sites = store.listSites();
  assert.equal(sites.length, 1);
  assert.equal(sites[0].name, "Ancien site");
  assert.equal(sites[0].shop_domain, null);
  assert.equal(store.pageRows(store.resultsAudit(sites[0].id)!.id).length, 2);
  assert.equal(store.getSetting("maxPagesDefault"), "42");
  const applied = db.prepare("SELECT version, name, applied_at FROM schema_migrations ORDER BY version").all() as any[];
  assert.deepEqual(applied.map((m) => m.version), MIGRATIONS.map((m) => m.version));
  assert.ok((db.prepare("SELECT name FROM sqlite_master WHERE name = 'shops'").get() as any)?.name);
  db.close();
  // Seconde ouverture : rien de réappliqué.
  const db2 = openDb(dir);
  assert.deepEqual(db2.prepare("SELECT version, name, applied_at FROM schema_migrations ORDER BY version").all(), applied);
  assert.equal(new Store(db2).listSites().length, 1);
  // Index unique partiel : deux sites sans boutique permis, deux sites pour la même boutique refusés.
  const s2 = new Store(db2);
  s2.insertSite("https://autre.example/", "autre.example", null);
  s2.insertSite("https://a.example/", "a.example", null, SHOP_A);
  assert.throws(() => s2.insertSite("https://b.example/", "b.example", null, SHOP_A));
  db2.close();
});

test("migrations : une migration qui échoue est annulée en entier et n'est pas notée", () => {
  const db = openDb(":memory:");
  const failing = [{ version: 999, name: "echec", sql: "CREATE TABLE essai_migration (x INTEGER); INSERT INTO table_absente VALUES (1);" }];
  assert.throws(() => runMigrations(db, failing));
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'essai_migration'").get(), undefined);
  assert.equal(db.prepare("SELECT version FROM schema_migrations WHERE version = 999").get(), undefined);
});

// ───────── 8. En-têtes

test("en-têtes : frame-ancestors selon le paramètre shop (valide, invalide, absent) ; 'none' pour /api et les fichiers", async () => {
  assert.equal(appFrameAncestors(`https://app.example/?shop=${SHOP_A}`), `https://${SHOP_A} https://admin.shopify.com`);
  assert.equal(appFrameAncestors("https://app.example/"), "https://admin.shopify.com");
  for (const bad of ["evil.example", "https://boutique-a.myshopify.com", "BOUTIQUE-A.myshopify.com", "a.myshopify.com.evil.example", "boutique-a.myshopify.com%20https://evil.example", "boutique-a.myshopify.com https://evil.example", "boutique-a.myshopify.com;script-src *"]) {
    assert.equal(appFrameAncestors(`https://app.example/?shop=${encodeURIComponent(bad)}`), "https://admin.shopify.com", bad);
  }
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const dist = tempDir();
  mkdirSync(path.join(dist, "assets"));
  writeFileSync(path.join(dist, "index.html"), "<!doctype html><html><head><title>x</title></head><body></body></html>");
  writeFileSync(path.join(dist, "assets", "app.js"), "1");
  const env = testEnv({ shopify: { fetchImpl: multiShopify([{ domain: SHOP_A, state: shopState(HOST_A, "A", 0) }]).impl, embedded: true, webDist: dist } });
  const fa = async (url: string, init?: RequestInit) => /frame-ancestors ([^;]+)/.exec((await env.app.request(url, init)).headers.get("content-security-policy")!)![1];
  assert.equal(await fa(`/?shop=${SHOP_A}`), `https://${SHOP_A} https://admin.shopify.com`);
  assert.equal(await fa(`/sites/x?shop=${SHOP_B}&host=abc`), `https://${SHOP_B} https://admin.shopify.com`);
  assert.equal(await fa("/?shop=evil.example"), "https://admin.shopify.com");
  assert.equal(await fa("/"), "https://admin.shopify.com");
  assert.equal(await fa(`/assets/app.js?shop=${SHOP_A}`), "'none'");
  assert.equal(await fa(`/api/health?shop=${SHOP_A}`, withToken(SHOP_A)), "'none'");
  assert.equal(await fa(`/api/health?shop=${SHOP_A}`), "'none'", "refus 401 compris");
});

test("en-têtes : Cache-Control private, no-cache et Vary: Authorization sur toutes les réponses /api du mode intégré", async () => {
  const ctx = await twoShops();
  const check = (res: Response, what: string) => {
    assert.equal(res.headers.get("cache-control"), "private, no-cache", what);
    assert.ok((res.headers.get("vary") ?? "").toLowerCase().split(/\s*,\s*/).includes("authorization"), `${what} : Vary`);
  };
  check(await ctx.app.request("/api/sites", withToken(SHOP_A)), "lecture");
  check(await ctx.app.request(`/api/sites/${ctx.A.site.id}/overview`, withToken(SHOP_A, { headers: { "accept-encoding": "gzip" } })), "lecture compressée");
  check(await ctx.app.request(`/api/sites/${ctx.A.site.id}/overview`, withToken(SHOP_B)), "404");
  check(await ctx.app.request("/api/health"), "401");
  check(await ctx.app.request("/api/sites", withToken(SHOP_A, post({ url: "x" }))), "403");
  check(await ctx.app.request(`/api/sites/${ctx.A.site.id}/shopify/batches/${ctx.A.batchId}/items/${ctx.A.itemId}`, withToken(SHOP_A, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ selected: false }) })), "écriture");
  // Lecture conditionnelle (304) aussi.
  const first = await ctx.app.request("/api/sites", withToken(SHOP_A));
  const etag = first.headers.get("etag")!;
  const again = await ctx.app.request("/api/sites", withToken(SHOP_A, { headers: { "if-none-match": etag } }));
  assert.equal(again.status, 304);
  check(again, "304");
  // Flux SSE : toujours un flux, jamais mis en tampon par un cache.
  const sse = await ctx.app.request(`/api/sites/${ctx.A.site.id}/events`, withToken(SHOP_A));
  assert.match(sse.headers.get("content-type")!, /text\/event-stream/);
  check(sse, "flux");
  assert.equal(sse.headers.get("content-encoding"), null);
  await readSse(sse, (e) => e.event === "site");
});

// ───────── 9. Mode local inchangé

test("local : aucun filtre par boutique, POST /api/sites actif, aucun en-tête nouveau", async () => {
  const fake = fakeShopify();
  const env = testEnv({ shopify: { fetchImpl: fake.impl } });
  const s1 = env.store.insertSite(`https://${HOST_A}/`, HOST_A, "A");
  const s2 = env.store.insertSite(`https://${HOST_B}/`, HOST_B, "B");
  const list = await read(await env.app.request("/api/sites"));
  assert.deepEqual(list.body.sites.map((s: any) => s.id).sort(), [s1.id, s2.id].sort());
  assert.equal(list.headers.get("cache-control"), "no-cache");
  assert.ok(!(list.headers.get("vary") ?? "").toLowerCase().includes("authorization"));
  assert.match(list.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
  assert.equal(list.headers.get("x-frame-options"), "DENY");
  for (const s of [s1, s2]) assert.equal((await env.app.request(`/api/sites/${s.id}/overview`)).status, 200);
  // POST /api/sites traite la demande (ici une adresse invalide) au lieu de la refuser.
  const created = await read(await env.app.request("/api/sites", post({ url: "pas une adresse" })));
  assert.equal(created.status, 400);
  assert.equal(created.body.error.code, "invalid_url");
  assert.equal((await env.app.request("/api/settings", { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ maxPagesDefault: 10 }) })).status, 200);
  assert.equal((await env.app.request(`/api/sites/${s2.id}`, { method: "DELETE", headers: JSON_HEADERS })).status, 204);
  // Aucune table de boutique utilisée en mode local.
  assert.equal((env.store.db.prepare("SELECT COUNT(*) AS n FROM shops").get() as any).n, 0);
  assert.equal(env.store.getSite(s1.id)!.shop_domain, null);
});

// ───────── 10. Configuration

test("config : TOKEN_ENCRYPTION_KEY absente ou mal formée en mode intégré → refus de démarrer sans valeur ; SHOPIFY_STORE_DOMAIN ignorée", () => {
  const key = randomBytes(32).toString("base64");
  const base = { SHOPIFY_APP_MODE: "embedded", SHOPIFY_CLIENT_ID: "ID-123", SHOPIFY_CLIENT_SECRET: "SECRET-456" };
  const bads = [undefined, "", "   ", randomBytes(16).toString("base64"), randomBytes(33).toString("base64"), randomBytes(32).toString("hex"), "pas-une-cle-du-tout-mais-assez-longue-pour-tromper=="];
  for (const bad of bads) {
    assert.throws(
      () => loadConfig({ env: { ...base, ...(bad === undefined ? {} : { TOKEN_ENCRYPTION_KEY: bad }) } }),
      (e: unknown) => e instanceof ConfigError && e.message.includes("TOKEN_ENCRYPTION_KEY") && (!bad || !bad.trim() || !e.message.includes(bad.trim())) && !/ID-123|SECRET-456/.test(e.message),
      String(bad),
    );
  }
  const ok = loadConfig({ env: { ...base, TOKEN_ENCRYPTION_KEY: key, SHOPIFY_STORE_DOMAIN: SHOP_A } });
  assert.equal(ok.shopifyAppMode, "embedded");
  assert.ok(ok.tokenEncryptionKey?.equals(Buffer.from(key, "base64")));
  assert.equal(ok.shopify, null, "SHOPIFY_STORE_DOMAIN ignorée en mode intégré");
  assert.deepEqual(ok.shopifyApp, { clientId: "ID-123", clientSecret: "SECRET-456" });
  // Mode local : la clé n'est ni exigée ni lue, même mal formée.
  const local = loadConfig({ env: { TOKEN_ENCRYPTION_KEY: "mauvaise", SHOPIFY_STORE_DOMAIN: SHOP_A, SHOPIFY_CLIENT_ID: "ID", SHOPIFY_CLIENT_SECRET: "S" } });
  assert.equal(local.shopifyAppMode, "local");
  assert.equal(local.tokenEncryptionKey, null);
  assert.equal(local.shopify?.storeDomain, SHOP_A);
});

// ───────── Ajout après la revue QA du lot B

test("intégré : la boutique garde l'accès à son site quand son domaine principal a changé depuis la création", async () => {
  const env = embeddedShops({ multi: multiShopify([{ domain: SHOP_A, state: shopState(HOST_A, "Boutique A", 0) }, { domain: SHOP_B, state: shopState(HOST_B, "Boutique B", 100) }]) });
  // Site créé quand la boutique n'avait que son domaine technique ; Shopify annonce maintenant HOST_A.
  const site = env.store.insertSite(`https://${SHOP_A}/`, SHOP_A, "Boutique A", SHOP_A);
  const a = await read(await env.app.request(`/api/sites/${site.id}/shopify`, withToken(SHOP_A)));
  assert.equal(a.status, 200);
  assert.equal(a.body.connection.state, "connected");
  // L'autre boutique n'y gagne rien.
  assert.equal((await read(await env.app.request(`/api/sites/${site.id}/shopify`, withToken(SHOP_B)))).status, 404);
});
