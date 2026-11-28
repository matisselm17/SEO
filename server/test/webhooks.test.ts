/**
 * Lot C, mode intégré : appels signés de Shopify (désinstallation, vie privée), effacement d'une boutique,
 * réinstallation (docs/format-echange.md, « Appels de Shopify : désinstallation et vie privée (mode intégré) »).
 * Faux Shopify : aucun appel réseau réel.
 */
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openDb, type DB } from "../src/db.ts";
import { PURGE_PLAN, purgeShop } from "../src/shopify/redact.ts";
import { ShopifyAuth, ShopifyError, type TokenPair, type TokenStore } from "../src/shopify/auth.ts";
import { bodyMatchesTopic, REDACTION_DEADLINE_MS, REDACTION_RETRY_MS, UNINSTALL_CHECK_TTL_MS, verifyWebhookSignature, WEBHOOK_BODY_LIMIT, WEBHOOK_MAX_CONCURRENT_READS, WEBHOOK_TOPICS, type WebhookTimers } from "../src/shopify/webhooks.ts";
import { dumpDb, embeddedShops, HOST_A, HOST_B, multiShopify, SHOP_A, SHOP_B, shopState, twoShops, withToken } from "./helpers/boutiques.ts";
import { FAKE_CREDS, fakeShopify } from "./helpers/fake-shopify.ts";
import { JSON_HEADERS, post, postEmpty, readSse, testEnv } from "./helpers/env.ts";

// ───────── Aides

const sign = (body: string | Buffer, secret = FAKE_CREDS.clientSecret) => createHmac("sha256", secret).update(body).digest("base64");

let seq = 0;
const newId = () => `b5c1e0de-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

interface HookOpts {
  id?: string | null;
  shopHeader?: string | null;
  hmac?: string | null;
  /** Corps envoyé, s'il diffère de celui qui est signé. */
  sentBody?: string;
  /** En-têtes ajoutés (par exemple `x-shopify-triggered-at`). */
  headers?: Record<string, string>;
}

function hook(app: { request: (p: string, init: RequestInit) => Response | Promise<Response> }, topic: string, body: unknown, o: HookOpts = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const headers: Record<string, string> = { "content-type": "application/json", "x-shopify-topic": topic, "x-shopify-api-version": "2026-07" };
  const hmac = o.hmac === undefined ? sign(text) : o.hmac;
  if (hmac !== null) headers["x-shopify-hmac-sha256"] = hmac;
  const id = o.id === undefined ? newId() : o.id;
  if (id !== null) headers["x-shopify-webhook-id"] = id;
  const shopHeader = o.shopHeader === undefined ? shopOf(body) : o.shopHeader;
  if (shopHeader) headers["x-shopify-shop-domain"] = shopHeader;
  headers["x-shopify-event-id"] = `evt-${seq}`;
  Object.assign(headers, o.headers ?? {});
  return app.request("/webhooks/shopify", { method: "POST", headers, body: o.sentBody ?? text });
}

function shopOf(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  return typeof o.myshopify_domain === "string" ? o.myshopify_domain : typeof o.shop_domain === "string" ? o.shop_domain : null;
}

const uninstallBody = (shop: string, host: string) => ({ id: 548380009, name: "Boutique", email: "marchand@example.com", domain: host, myshopify_domain: shop, plan_name: "basic" });
const redactBody = (shop: string) => ({ shop_id: 954889, shop_domain: shop });
const customerRedactBody = (shop: string) => ({ shop_id: 954889, shop_domain: shop, customer: { id: 191167, email: "client.final@example.com", phone: "+33600000000" }, orders_to_redact: [299938, 280263] });
const dataRequestBody = (shop: string) => ({ shop_id: 954889, shop_domain: shop, orders_requested: [299938], customer: { id: 191167, email: "client.final@example.com", phone: "+33600000000" }, data_request: { id: 9999 } });

/** Faux Shopify à deux boutiques, avec de quoi retenir les écritures et refuser les jetons d'une boutique. */
function controlledMulti() {
  const multi = multiShopify([
    { domain: SHOP_A, state: shopState(HOST_A, "Boutique A", 0) },
    { domain: SHOP_B, state: shopState(HOST_B, "Boutique B", 500) },
  ]);
  const inner = multi.impl;
  const ctl = {
    /** Boutiques dont Shopify refuse les jetons (application désinstallée chez Shopify). */
    refuse: new Set<string>(),
    /** Écritures retenues jusqu'à `release()`. */
    gate: null as Promise<void> | null,
    release: () => {},
    mutationsSeen: 0,
    onMutation: null as (() => void) | null,
    /** Réponse imposée (null : comportement normal). */
    override: null as ((domain: string, url: string, init: RequestInit) => Response | null) | null,
  };
  multi.impl = (async (url: string, init: RequestInit) => {
    const domain = new URL(url).hostname;
    const forced = ctl.override?.(domain, url, init);
    if (forced) return forced;
    if (ctl.refuse.has(domain) && !multi.ctl.down.has(domain)) {
      const b = String(init.body ?? "");
      if (url.endsWith("/admin/oauth/access_token") && !b.includes("token-exchange")) return Response.json({ error: "invalid_request" }, { status: 401 });
      if (url.endsWith("/graphql.json")) return new Response("refusé", { status: 401 });
    }
    if (url.endsWith("/graphql.json") && String(init.body ?? "").includes("mutation")) {
      ctl.mutationsSeen++;
      ctl.onMutation?.();
      if (ctl.gate) await ctl.gate;
    }
    return inner(url, init);
  }) as unknown as typeof fetch;
  const hold = () => {
    ctl.gate = new Promise<void>((r) => (ctl.release = r));
  };
  return { multi, ctl, hold };
}

/** Minuterie d'essai : la reprise horaire n'avance que par `fire()`. */
function fakeTimers() {
  const handles: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const timers: WebhookTimers = {
    setInterval: (fn, ms) => {
      const h = { fn, ms, cleared: false };
      handles.push(h);
      return h;
    },
    clearInterval: (h) => {
      (h as { cleared: boolean }).cleared = true;
    },
  };
  return { timers, handles, fire: () => handles.filter((h) => !h.cleared).forEach((h) => h.fn()) };
}

/** Journaux capturés (et rendus silencieux) pendant `fn`. */
async function captureLogs<T>(fn: () => Promise<T>): Promise<{ out: T; logs: string }> {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  const logs: string[] = [];
  const keep = (...a: unknown[]) => void logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  console.log = keep;
  console.warn = keep;
  console.error = keep;
  try {
    return { out: await fn(), logs: logs.join("\n") };
  } finally {
    Object.assign(console, saved);
  }
}

const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([p, new Promise<T>((_r, rej) => setTimeout(() => rej(new Error(`délai dépassé : ${what}`)), ms).unref())]);

/** Lignes de la base qui appartiennent à une boutique, table par table, d'après PURGE_PLAN. */
function shopRows(db: DB, who: { shop: string; siteId: string; host: string; auditIds: string[] }): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  const all = (sql: string, ...p: Array<string>) => db.prepare(sql).all(...p) as unknown[];
  for (const [t, d] of Object.entries(PURGE_PLAN)) {
    if (d === "not_concerned") continue;
    if (d === "site") out[t] = all(`SELECT * FROM sites WHERE id = ? OR shop_domain = ? ORDER BY rowid`, who.siteId, who.shop);
    else if (d === "site_id") out[t] = all(`SELECT * FROM "${t}" WHERE site_id = ? ORDER BY rowid`, who.siteId);
    else if (d === "audit_id") out[t] = who.auditIds.length ? all(`SELECT * FROM "${t}" WHERE audit_id IN (${who.auditIds.map(() => "?").join(",")}) ORDER BY rowid`, ...who.auditIds) : [];
    else if (d === "site_host") out[t] = all(`SELECT * FROM "${t}" WHERE site_host = ? ORDER BY rowid`, who.host);
    else if (d === "batch_of_site_host") out[t] = all(`SELECT * FROM "${t}" WHERE batch_id IN (SELECT id FROM shopify_batches WHERE site_host = ?) ORDER BY rowid`, who.host);
    else if (d === "shop") out[t] = all(`SELECT * FROM shops WHERE domain = ?`, who.shop);
    else if (d === "shop_domain") out[t] = all(`SELECT * FROM "${t}" WHERE shop_domain = ? ORDER BY rowid`, who.shop);
  }
  return out;
}

const auditIdsOf = (db: DB, siteId: string) => (db.prepare("SELECT id FROM audits WHERE site_id = ?").all(siteId) as Array<{ id: string }>).map((r) => r.id);

/** Complète les tables que la préparation ne remplit pas, pour que l'effacement soit éprouvé sur chacune. */
function fillAll(db: DB, siteId: string, host: string) {
  const audit = auditIdsOf(db, siteId)[0];
  const at = new Date().toISOString();
  const run = (sql: string, ...p: Array<string | number>) => db.prepare(sql).run(...p);
  run("INSERT OR IGNORE INTO search_console (site_id, imported_at, data_json) VALUES (?, ?, '{}')", siteId, at);
  run("INSERT INTO chat_messages (id, site_id, seq, role, content, created_at, sources_json) VALUES (?, ?, 1, 'user', 'Bonjour', ?, '[]')", `msg_${siteId}`, siteId, at);
  run("INSERT OR IGNORE INTO competitors (site_id, checked_at, data_json) VALUES (?, ?, '{}')", siteId, at);
  run("INSERT OR IGNORE INTO automation_policies (site_id, policy_json, updated_at) VALUES (?, '{}', ?)", siteId, at);
  run("INSERT OR IGNORE INTO analytics (site_id, synced_at, data_json) VALUES (?, ?, '{}')", siteId, at);
  run("INSERT OR IGNORE INTO pagespeed_pages (site_id, path_key, url, path, updated_at) VALUES (?, '/', ?, '/', ?)", siteId, `https://${host}/`, at);
  run("INSERT OR IGNORE INTO pagespeed_status (site_id) VALUES (?)", siteId);
  run("INSERT INTO page_failures (audit_id, url, reason) VALUES (?, ?, 'timeout')", audit, `https://${host}/lent`);
  run("INSERT OR IGNORE INTO audit_catalogue (audit_id, read_at, data_json) VALUES (?, ?, '[]')", audit, at);
  run("INSERT OR IGNORE INTO automation_usage (site_host, day, auto_changes) VALUES (?, '2026-11-28', 1)", host);
  const change = db.prepare("SELECT id FROM shopify_changes WHERE site_host = ? LIMIT 1").get(host) as { id: string };
  run("INSERT INTO shopify_verifications (id, change_id, site_host, checked_at, outcome, reason, message) VALUES (?, ?, ?, ?, 'verified', 'displayed', 'ok')", `ver_${siteId}`, change.id, host, at);
}

const shopRow = (db: DB, shop: string) => db.prepare("SELECT * FROM shops WHERE domain = ?").get(shop) as Record<string, string | number | null> | undefined;
const redactions = (db: DB) => db.prepare("SELECT * FROM shop_redactions ORDER BY id").all() as Array<Record<string, string | number | null>>;

/**
 * Deux boutiques préparées, faux Shopify contrôlable, minuterie d'essai. L'horloge des appels de Shopify suit l'heure
 * réelle plus `clock.offset` ; `t.fire()` avance l'horloge d'une heure puis déclenche la reprise horaire.
 */
async function setup(opts: { dataDir?: string } = {}) {
  const { multi, ctl, hold } = controlledMulti();
  const t0 = fakeTimers();
  const clock = { offset: 0 };
  const ctx = await twoShops({ multi, dataDir: opts.dataDir, webhooks: { timers: t0.timers, now: () => Date.now() + clock.offset } });
  const t = { ...t0, fire: () => {
    clock.offset += REDACTION_RETRY_MS;
    t0.fire();
  } };
  return { ...ctx, ctl, hold, t, clock, hooks: ctx.webhooks! };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

/** Désinstallation réelle : Shopify refuse définitivement les jetons de la boutique le temps de la vérification. */
async function uninstall(ctx: Ctx, shop = SHOP_A, host = HOST_A, o: HookOpts = {}, body?: unknown) {
  ctx.ctl.refuse.add(shop);
  try {
    const res = await hook(ctx.app, "app/uninstalled", body ?? uninstallBody(shop, host), o);
    assert.equal(res.status, 200);
    await ctx.hooks.idle();
  } finally {
    ctx.ctl.refuse.delete(shop);
  }
}

// ───────── Signature, taille, sujet, boutique

test("signature : valide acceptée ; absente, fausse ou calculée sur un autre corps → 401 vide, rien d'enregistré", async () => {
  const ctx = await setup();
  const body = uninstallBody(SHOP_A, HOST_A);
  const before = dumpDb(ctx);
  for (const o of [{ hmac: null }, { hmac: sign(JSON.stringify(body), "autre-secret") }, { hmac: "pas-du-base64!!" }, { sentBody: JSON.stringify({ ...body, myshopify_domain: SHOP_B }) }] as HookOpts[]) {
    const res = await hook(ctx.app, "app/uninstalled", body, o);
    assert.equal(res.status, 401);
    assert.equal(await res.text(), "");
  }
  // Signature d'un corps légèrement différent (un espace) : refusée aussi.
  const text = JSON.stringify(body);
  const res = await ctx.app.request("/webhooks/shopify", { method: "POST", headers: { "x-shopify-topic": "app/uninstalled", "x-shopify-hmac-sha256": sign(text), "x-shopify-webhook-id": newId() }, body: text + " " });
  assert.equal(res.status, 401);
  await ctx.hooks.idle();
  assert.equal(dumpDb(ctx), before, "rien d'enregistré");
  assert.ok(shopRow(ctx.store.db, SHOP_A)!.access_token, "jetons intacts");
  // Valide : acceptée et traitée (Shopify confirme la désinstallation).
  ctx.ctl.refuse.add(SHOP_A);
  const ok = await hook(ctx.app, "app/uninstalled", body);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "");
  await ctx.hooks.idle();
  assert.ok(shopRow(ctx.store.db, SHOP_A)!.uninstalled_at);
});

test("signature : fonction pure, comparaison stricte", () => {
  const raw = Buffer.from('{"a":1}');
  const good = sign(raw);
  assert.equal(verifyWebhookSignature(raw, good, FAKE_CREDS.clientSecret), true);
  assert.equal(verifyWebhookSignature(raw, good, ""), false);
  assert.equal(verifyWebhookSignature(raw, null, FAKE_CREDS.clientSecret), false);
  assert.equal(verifyWebhookSignature(raw, good.replace(/=+$/, ""), FAKE_CREDS.clientSecret), false, "base64 non canonique");
  assert.equal(verifyWebhookSignature(Buffer.from('{"a":2}'), good, FAKE_CREDS.clientSecret), false);
  assert.equal(verifyWebhookSignature(raw, Buffer.from(createHmac("sha256", FAKE_CREDS.clientSecret).update(raw).digest("hex")).toString(), FAKE_CREDS.clientSecret), false, "hexadécimal refusé");
});

test("taille : corps de plus de 256 Ko → 413, rien d'enregistré (lu au fil de l'eau, avec ou sans longueur annoncée)", async () => {
  const ctx = await setup();
  const before = dumpDb(ctx);
  const big = JSON.stringify({ ...redactBody(SHOP_A), pad: "x".repeat(WEBHOOK_BODY_LIMIT) });
  const r1 = await hook(ctx.app, "shop/redact", big, { shopHeader: SHOP_A });
  assert.equal(r1.status, 413);
  const r2 = await ctx.app.request("/webhooks/shopify", {
    method: "POST",
    headers: { "x-shopify-topic": "shop/redact", "x-shopify-hmac-sha256": sign(big), "content-length": String(Buffer.byteLength(big)) },
    body: big,
  });
  assert.equal(r2.status, 413);
  // Corps en flux sans longueur annoncée.
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < 40; i++) c.enqueue(new Uint8Array(8 * 1024).fill(32));
      c.close();
    },
  });
  const r3 = await ctx.app.request("/webhooks/shopify", { method: "POST", headers: { "x-shopify-topic": "shop/redact", "x-shopify-hmac-sha256": "x" }, body: stream, duplex: "half" } as RequestInit);
  assert.equal(r3.status, 413);
  await ctx.hooks.idle();
  assert.equal(dumpDb(ctx), before);
});

test("mode local : la route n'existe pas (404) ; mode intégré : autre méthode ou adresse → 404, jamais l'interface", async () => {
  const local = testEnv({ shopify: { fetchImpl: fakeShopify().impl } });
  const body = redactBody(SHOP_A);
  const res = await hook(local.app, "shop/redact", body);
  assert.equal(res.status, 404);
  assert.equal(local.webhooks, null);
  assert.equal((await local.app.request("/webhooks/shopify")).status, 404);
  const ctx = embeddedShops();
  assert.equal((await ctx.app.request("/webhooks/shopify")).status, 404);
  assert.equal((await ctx.app.request("/webhooks/autre", { method: "POST", body: "{}" })).status, 404);
  assert.equal((await ctx.app.request("/webhooks", { method: "POST", body: "{}" })).status, 404);
});

test("sujet inconnu → 200 sans effet ; corps illisible ou champ absent → 200 sans effet", async () => {
  const ctx = await setup();
  const before = dumpDb(ctx);
  for (const topic of ["orders/create", "APP/UNINSTALLED", ""]) {
    const res = await hook(ctx.app, topic, uninstallBody(SHOP_A, HOST_A));
    assert.equal(res.status, 200);
  }
  assert.equal((await hook(ctx.app, "shop/redact", "pas du json", { shopHeader: SHOP_A })).status, 200);
  assert.equal((await hook(ctx.app, "shop/redact", { shop_id: 1 })).status, 200);
  assert.equal((await hook(ctx.app, "shop/redact", { shop_domain: "https://boutique-a.myshopify.com" })).status, 200);
  assert.equal((await hook(ctx.app, "shop/redact", { shop_domain: "BOUTIQUE-A.myshopify.com" })).status, 200);
  assert.equal((await hook(ctx.app, "shop/redact", { shop_domain: "evil.example" })).status, 200);
  await ctx.hooks.idle();
  assert.equal(dumpDb(ctx), before);
});

test("rejeu : corps de app/uninstalled sous shop/redact, et l'inverse → 200 sans effet", async () => {
  const ctx = await setup();
  const before = dumpDb(ctx);
  const r1 = await hook(ctx.app, "shop/redact", uninstallBody(SHOP_A, HOST_A));
  assert.equal(r1.status, 200);
  const r2 = await hook(ctx.app, "app/uninstalled", redactBody(SHOP_A));
  assert.equal(r2.status, 200);
  // Corps de vie privée d'un client sous app/uninstalled : sans effet non plus.
  const r3 = await hook(ctx.app, "app/uninstalled", customerRedactBody(SHOP_A));
  assert.equal(r3.status, 200);
  await ctx.hooks.idle();
  assert.equal(dumpDb(ctx), before);
  assert.equal(redactions(ctx.store.db).length, 0);
  assert.equal(shopRow(ctx.store.db, SHOP_A)!.uninstalled_at, null);
});

test("en-tête de boutique discordant avec le corps signé → 200 sans effet", async () => {
  const ctx = await setup();
  const before = dumpDb(ctx);
  assert.equal((await hook(ctx.app, "app/uninstalled", uninstallBody(SHOP_A, HOST_A), { shopHeader: SHOP_B })).status, 200);
  assert.equal((await hook(ctx.app, "shop/redact", redactBody(SHOP_A), { shopHeader: SHOP_B })).status, 200);
  await ctx.hooks.idle();
  assert.equal(dumpDb(ctx), before);
  // Sans en-tête : la boutique du corps signé fait foi.
  ctx.ctl.refuse.add(SHOP_A);
  assert.equal((await hook(ctx.app, "app/uninstalled", uninstallBody(SHOP_A, HOST_A), { shopHeader: null })).status, 200);
  await ctx.hooks.idle();
  assert.ok(shopRow(ctx.store.db, SHOP_A)!.uninstalled_at);
  assert.equal(shopRow(ctx.store.db, SHOP_B)!.uninstalled_at, null);
});

test("doublon : même identifiant reçu deux fois → un seul traitement", async () => {
  const ctx = await setup();
  const id = newId();
  await uninstall(ctx, SHOP_A, HOST_A, { id });
  assert.equal(shopRow(ctx.store.db, SHOP_A)!.access_token, null);
  // Réinstallation : de nouveaux jetons.
  const sites = await ctx.app.request("/api/sites", withToken(SHOP_A));
  assert.equal(sites.status, 200);
  assert.ok(shopRow(ctx.store.db, SHOP_A)!.access_token);
  // Le même avis rejoué par Shopify : pas retraité (les jetons neufs restent).
  assert.equal((await hook(ctx.app, "app/uninstalled", uninstallBody(SHOP_A, HOST_A), { id })).status, 200);
  await ctx.hooks.idle();
  assert.ok(shopRow(ctx.store.db, SHOP_A)!.access_token);
  assert.equal(shopRow(ctx.store.db, SHOP_A)!.uninstalled_at, null);
  const events = ctx.store.db.prepare("SELECT * FROM webhook_events").all() as any[];
  assert.equal(events.length, 1);
  assert.deepEqual(Object.keys(events[0]).sort(), ["received_at", "topic", "webhook_id"]);
  // Deux demandes d'effacement (identifiants distincts) : une seule en attente pour la boutique.
  ctx.multi.ctl.down.add(SHOP_A);
  await hook(ctx.app, "shop/redact", redactBody(SHOP_A));
  await hook(ctx.app, "shop/redact", redactBody(SHOP_A));
  await ctx.hooks.idle();
  assert.equal(redactions(ctx.store.db).filter((r) => r.state === "pending").length, 1);
});

// ───────── Désinstallation

test("désinstallation : jetons effacés en base et en mémoire, flux fermé, lot en cours arrêté, données gardées, B intacte", async () => {
  const ctx = await setup();
  const { A, B } = ctx;
  const whoB = { shop: SHOP_B, siteId: B.site.id, host: HOST_B, auditIds: auditIdsOf(ctx.store.db, B.site.id) };
  const bBefore = shopRows(ctx.store.db, whoB);
  const pagesA = (ctx.store.db.prepare("SELECT COUNT(*) AS n FROM pages WHERE site_id = ?").get(A.site.id) as any).n;
  const changesA = (ctx.store.db.prepare("SELECT COUNT(*) AS n FROM shopify_changes WHERE site_host = ?").get(HOST_A) as any).n;
  assert.ok(pagesA > 0 && changesA > 0);

  // Un lot de deux lignes en cours d'écriture, retenu sur sa première écriture.
  const lot = await ctx.app.request(
    `${A.base}/shopify/batches`,
    withToken(SHOP_A, post({ title: "Descriptions", items: [
      { resourceId: A.byPath["/pages/contact"].id, field: "seo_description", value: "Contactez-nous pour toute question sur nos bijoux." },
      { resourceId: A.byPath["/products/bague-or"].id, field: "seo_description", value: "Bague en or massif, fabriquée à la main en France." },
    ] })),
  );
  assert.equal(lot.status, 201, await lot.clone().text());
  const lotId = ((await lot.json()) as any).batch.id;
  ctx.hold();
  const firstWrite = new Promise<void>((r) => (ctx.ctl.onMutation = r));
  const applied = await ctx.app.request(`${A.base}/shopify/batches/${lotId}/apply`, withToken(SHOP_A, postEmpty()));
  assert.equal(applied.status, 202);
  await withTimeout(firstWrite, 5000, "première écriture");

  // Flux /events ouvert sur le site de A.
  const sse = await ctx.app.request(`${A.base}/events`, withToken(SHOP_A));
  assert.equal(sse.status, 200);
  const streamDone = readSse(sse);

  const bundleA = ctx.shopifyRegistry.peek(SHOP_A)!;
  assert.ok(bundleA);
  const graphqlA = () => ctx.multi.log.graphql.filter((g) => g.domain === SHOP_A).length;

  ctx.ctl.refuse.add(SHOP_A);
  const { logs } = await captureLogs(async () => {
    const res = await hook(ctx.app, "app/uninstalled", uninstallBody(SHOP_A, HOST_A));
    assert.equal(res.status, 200);
    // Rien n'est fait avant la réponse : l'avis est d'abord vérifié auprès de Shopify.
    assert.equal(shopRow(ctx.store.db, SHOP_A)!.uninstalled_at, null);
    // Désinstallation confirmée par Shopify : jetons oubliés en base et en mémoire.
    for (let i = 0; i < 500 && !shopRow(ctx.store.db, SHOP_A)!.uninstalled_at; i++) await sleep(5);
    const row = shopRow(ctx.store.db, SHOP_A)!;
    assert.ok(row.uninstalled_at);
    assert.equal(row.access_token, null);
    assert.equal(row.refresh_token, null);
    assert.equal(row.access_expires_at, null);
    assert.equal(await bundleA.shopify.installationCheck(), "no_tokens", "plus aucun jeton en mémoire");
    ctx.ctl.release();
    await ctx.hooks.idle();
  });
  ctx.ctl.refuse.delete(SHOP_A);
  // Flux fermé.
  await withTimeout(streamDone, 5000, "fermeture du flux");
  // Lot arrêté proprement après sa ligne en cours, sans reprise.
  await ctx.batches.wait(A.site.id);
  await bundleA.batches.wait(A.site.id);
  const batch = ctx.store.db.prepare("SELECT state FROM shopify_batches WHERE id = ?").get(lotId) as any;
  assert.equal(batch.state, "partial");
  const items = ctx.store.db.prepare("SELECT state FROM shopify_batch_items WHERE batch_id = ? ORDER BY seq").all(lotId) as any[];
  assert.ok(items.some((i) => i.state === "pending"), `les lignes restantes ne sont pas écrites : ${JSON.stringify(items)} ${JSON.stringify(ctx.store.db.prepare("SELECT error_json FROM shopify_batches WHERE id = ?").get(lotId))}`);
  assert.deepEqual(items.map((i) => i.state), ["applied", "pending"], `une seule ligne écrite (${ctx.ctl.mutationsSeen} mutations)`);
  // Jeu de services libéré ; aucun appel à Shopify pour A depuis.
  assert.equal(ctx.shopifyRegistry.peek(SHOP_A), null);
  const n = graphqlA();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(graphqlA(), n);
  // Données gardées.
  assert.ok(ctx.store.getSite(A.site.id));
  assert.equal((ctx.store.db.prepare("SELECT COUNT(*) AS n FROM pages WHERE site_id = ?").get(A.site.id) as any).n, pagesA);
  assert.ok((ctx.store.db.prepare("SELECT COUNT(*) AS n FROM shopify_changes WHERE site_host = ?").get(HOST_A) as any).n >= changesA);
  // Boutique B strictement intacte, jetons compris.
  assert.deepEqual(shopRows(ctx.store.db, whoB), bBefore);
  assert.ok(ctx.shopifyRegistry.peek(SHOP_B));
  assert.ok(!logs.includes(SHOP_A) && !logs.includes(FAKE_CREDS.clientSecret));
  assert.deepEqual(ctx.multi.log.violations, []);
});

test("réinstallation avant l'effacement : données retrouvées, uninstalled_at remis à vide", async () => {
  const ctx = await setup();
  const { A } = ctx;
  await uninstall(ctx);
  assert.ok(shopRow(ctx.store.db, SHOP_A)!.uninstalled_at);
  const exchanges = ctx.multi.log.exchanges.get(SHOP_A) ?? 0;
  const res = await ctx.app.request("/api/sites", withToken(SHOP_A));
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.sites.length, 1);
  assert.equal(body.sites[0].id, A.site.id, "même site, mêmes données");
  assert.equal(ctx.multi.log.exchanges.get(SHOP_A), exchanges + 1, "un nouvel échange");
  const row = shopRow(ctx.store.db, SHOP_A)!;
  assert.equal(row.uninstalled_at, null);
  assert.ok(row.access_token);
  const issues = await ctx.app.request(`${A.base}/issues`, withToken(SHOP_A));
  assert.equal(issues.status, 200);
  assert.ok(((await issues.json()) as any).issues.length > 0);
});

// ───────── Effacement

test("effacement : toutes les tables vidées pour A, B strictement intacte, puis réouverture de A → site neuf", async () => {
  const ctx = await setup();
  const { A, B } = ctx;
  fillAll(ctx.store.db, A.site.id, HOST_A);
  fillAll(ctx.store.db, B.site.id, HOST_B);
  const whoA = { shop: SHOP_A, siteId: A.site.id, host: HOST_A, auditIds: auditIdsOf(ctx.store.db, A.site.id) };
  const whoB = { shop: SHOP_B, siteId: B.site.id, host: HOST_B, auditIds: auditIdsOf(ctx.store.db, B.site.id) };
  // Chaque table concernée a des lignes de A avant l'effacement (sinon le test ne prouverait rien).
  // (La file des avis de désinstallation est vide hors attente : son effacement est éprouvé à part.)
  for (const [t, rows] of Object.entries(shopRows(ctx.store.db, whoA))) if (t !== "uninstall_checks") assert.ok(rows.length > 0, `table ${t} vide pour A avant l'effacement`);

  await uninstall(ctx);
  assert.ok(shopRow(ctx.store.db, SHOP_A)!.uninstalled_at, "désinstallation confirmée");
  const bBefore = JSON.stringify(shopRows(ctx.store.db, whoB));
  const { logs } = await captureLogs(async () => {
    const res = await hook(ctx.app, "shop/redact", redactBody(SHOP_A));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "");
    await ctx.hooks.idle();
  });
  for (const [t, rows] of Object.entries(shopRows(ctx.store.db, whoA))) assert.equal(rows.length, 0, `table ${t} encore remplie pour A`);
  // Nulle part dans la base : ni le domaine, ni l'adresse, ni l'identifiant du site de A.
  const all = dumpDb(ctx);
  assert.ok(!all.includes(SHOP_A), "domaine de A encore en base");
  assert.ok(!all.includes(HOST_A), "adresse de A encore en base");
  assert.ok(!all.includes(A.site.id), "site de A encore en base");
  assert.equal(JSON.stringify(shopRows(ctx.store.db, whoB)), bBefore, "B modifiée");
  assert.equal((ctx.store.db.prepare("SELECT COUNT(*) AS n FROM history_delete_grant").get() as any).n, 0);
  const [r] = redactions(ctx.store.db);
  assert.equal(r.state, "closed");
  assert.equal(r.outcome, "erased");
  assert.equal(r.shop_domain, null);
  assert.ok(!logs.includes(SHOP_A));
  // Flux /events de l'ancien site : 404.
  assert.equal((await ctx.app.request(`${A.base}/events`, withToken(SHOP_A))).status, 404);

  // Réouverture de A : état neuf (nouveau site, première analyse).
  const started = ctx.started.length;
  const res = await ctx.app.request("/api/sites", withToken(SHOP_A));
  assert.equal(res.status, 200);
  const site = ((await res.json()) as any).sites[0];
  assert.notEqual(site.id, A.site.id);
  assert.equal(ctx.store.getSite(site.id)!.host, HOST_A);
  assert.equal(ctx.started.length, started + 1, "première analyse lancée");
  assert.equal((ctx.store.db.prepare("SELECT COUNT(*) AS n FROM shopify_changes WHERE site_host = ?").get(HOST_A) as any).n, 0);
  assert.equal(JSON.stringify(shopRows(ctx.store.db, whoB)), bBefore);
  assert.deepEqual(ctx.multi.log.violations, []);
});

test("effacement refusé si Shopify accepte encore les jetons (application réinstallée) : rien d'effacé", async () => {
  const ctx = await setup();
  await uninstall(ctx);
  assert.equal((await ctx.app.request("/api/sites", withToken(SHOP_A))).status, 200);
  const before = dumpDb(ctx);
  const { logs } = await captureLogs(async () => {
    await hook(ctx.app, "shop/redact", redactBody(SHOP_A));
    await ctx.hooks.idle();
  });
  const [r] = redactions(ctx.store.db);
  assert.equal(r.state, "closed");
  assert.equal(r.outcome, "reinstalled");
  assert.equal(r.shop_domain, null);
  assert.ok(ctx.store.getSite(ctx.A.site.id));
  // Seules la file et le journal des appels ont changé.
  const strip = (s: string) => (JSON.parse(s) as Array<[string, unknown]>).filter(([t]) => t !== "shop_redactions" && t !== "webhook_events");
  assert.deepEqual(strip(dumpDb(ctx)), strip(before));
  assert.match(logs, /de nouveau installée/);
  assert.ok(!logs.includes(SHOP_A));
});

test("Shopify injoignable : demande en attente, puis reprise par la minuterie horaire → effacement", async () => {
  const ctx = await setup();
  // Avis de désinstallation jamais reçu : la boutique a encore ses jetons.
  ctx.multi.ctl.down.add(SHOP_A);
  await captureLogs(async () => {
    assert.equal((await hook(ctx.app, "shop/redact", redactBody(SHOP_A))).status, 200);
    await ctx.hooks.idle();
  });
  let [r] = redactions(ctx.store.db);
  assert.equal(r.state, "pending");
  assert.equal(r.attempts, 1);
  assert.equal(r.shop_domain, SHOP_A);
  assert.ok(ctx.store.getSite(ctx.A.site.id), "rien d'effacé tant que Shopify ne répond pas");
  // Shopify répond de nouveau et refuse les jetons (application désinstallée chez lui).
  ctx.multi.ctl.down.delete(SHOP_A);
  ctx.ctl.refuse.add(SHOP_A);
  ctx.hooks.start();
  const hourly = ctx.t.handles.find((h) => !h.cleared)!;
  assert.equal(hourly.ms, REDACTION_RETRY_MS);
  await captureLogs(async () => {
    await ctx.hooks.idle(); // reprise au démarrage
  });
  [r] = redactions(ctx.store.db);
  assert.equal(r.state, "closed");
  assert.equal(r.outcome, "erased");
  assert.equal(ctx.store.getSite(ctx.A.site.id), null);
  assert.ok(ctx.store.getSite(ctx.B.site.id));
  ctx.hooks.stop();
  assert.ok(hourly.cleared, "minuterie arrêtée");
});

test("Shopify injoignable puis reprise horaire ; reprise au démarrage d'un nouveau serveur sur la même base", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "chat-seo-webhooks-"));
  const ctx = await setup({ dataDir });
  ctx.multi.ctl.down.add(SHOP_A);
  ctx.multi.ctl.down.add(SHOP_B);
  await captureLogs(async () => {
    await hook(ctx.app, "shop/redact", redactBody(SHOP_A));
    await hook(ctx.app, "shop/redact", redactBody(SHOP_B));
    await ctx.hooks.idle();
    ctx.hooks.start();
    await ctx.hooks.idle();
    ctx.t.fire(); // une heure plus tard : toujours injoignable
    await ctx.hooks.idle();
  });
  // Chaque demande est tentée à son arrivée, au démarrage, puis à chaque reprise horaire.
  assert.deepEqual(redactions(ctx.store.db).map((r) => r.state), ["pending", "pending"]);
  assert.ok(redactions(ctx.store.db).every((r) => Number(r.attempts) >= 3));
  ctx.hooks.stop();
  // Nouveau serveur sur la même base : A refusée par Shopify (effacée), B toujours injoignable (en attente).
  const { multi, ctl } = controlledMulti();
  ctl.refuse.add(SHOP_A);
  multi.ctl.down.add(SHOP_B);
  const t2 = fakeTimers();
  const env2 = embeddedShops({ multi, dataDir, webhooks: { timers: t2.timers } });
  await captureLogs(async () => {
    env2.webhooks!.start();
    await env2.webhooks!.idle();
  });
  const rows = redactions(env2.store.db);
  assert.equal(rows[0].outcome, "erased");
  assert.equal(rows[1].state, "pending");
  assert.equal(env2.store.siteByShop(SHOP_A), null);
  assert.ok(env2.store.siteByShop(SHOP_B));
  env2.webhooks!.stop();
});

test("délai de 25 jours dépassé, boutique sans aucun jeton ni requête depuis : la demande est close (effacement)", async () => {
  let now = Date.now();
  const { multi } = controlledMulti();
  const t = fakeTimers();
  const ctx = await twoShops({ multi, webhooks: { timers: t.timers, now: () => now } });
  // La demande arrive après les dernières requêtes identifiées de la préparation. A n'a plus aucun jeton enregistré
  // (jamais marquée désinstallée) : aucune preuve, seule la règle des 25 jours peut s'appliquer.
  now = Date.now() + 1000;
  ctx.store.db.prepare("UPDATE shops SET access_token = NULL, refresh_token = NULL, access_expires_at = NULL, refresh_expires_at = NULL WHERE domain = ?").run(SHOP_A);
  multi.ctl.down.add(SHOP_A);
  await captureLogs(async () => {
    await hook(ctx.app, "shop/redact", redactBody(SHOP_A));
    await ctx.webhooks!.idle();
  });
  assert.equal(redactions(ctx.store.db)[0].state, "pending");
  assert.equal(REDACTION_DEADLINE_MS, 25 * 24 * 60 * 60 * 1000);
  // 24 jours : toujours en attente.
  now += 24 * 24 * 60 * 60 * 1000;
  await captureLogs(async () => {
    await ctx.webhooks!.runPending();
  });
  assert.equal(redactions(ctx.store.db)[0].state, "pending");
  now += 24 * 60 * 60 * 1000;
  const { logs } = await captureLogs(async () => {
    await ctx.webhooks!.runPending();
  });
  assert.equal(redactions(ctx.store.db)[0].outcome, "erased");
  assert.match(logs, /25 jours/);
  assert.ok(ctx.store.siteByShop(SHOP_B));
});

test("boutique inconnue : demande close sans rien faire", async () => {
  const ctx = await setup();
  const before = dumpDb(ctx);
  await captureLogs(async () => {
    assert.equal((await hook(ctx.app, "shop/redact", redactBody("inconnue.myshopify.com"))).status, 200);
    assert.equal((await hook(ctx.app, "app/uninstalled", uninstallBody("inconnue.myshopify.com", "inconnue.example"))).status, 200);
    await ctx.hooks.idle();
  });
  const [r] = redactions(ctx.store.db);
  assert.equal(r.state, "closed");
  assert.equal(r.outcome, "unknown_shop");
  assert.equal(r.shop_domain, null);
  assert.equal(shopRow(ctx.store.db, "inconnue.myshopify.com"), undefined, "aucune boutique créée");
  const strip = (s: string) => (JSON.parse(s) as Array<[string, unknown]>).filter(([t]) => t !== "shop_redactions" && t !== "webhook_events" && t !== "uninstall_checks");
  assert.deepEqual(strip(dumpDb(ctx)), strip(before));
});

// ───────── Protection de l'historique et exhaustivité

test("historique : suppression directe toujours refusée dans les quatre tables, avant et après un effacement", async () => {
  const ctx = await setup();
  const db = ctx.store.db;
  fillAll(db, ctx.A.site.id, HOST_A);
  fillAll(db, ctx.B.site.id, HOST_B);
  const attempts = (host: string) => [
    () => db.prepare("DELETE FROM shopify_changes WHERE site_host = ?").run(host),
    () => db.prepare("DELETE FROM shopify_verifications WHERE site_host = ?").run(host),
    () => db.prepare("DELETE FROM shopify_batch_items WHERE batch_id IN (SELECT id FROM shopify_batches WHERE site_host = ?)").run(host),
    () => db.prepare("DELETE FROM shopify_batches WHERE site_host = ?").run(host),
  ];
  for (const host of [HOST_A, HOST_B]) for (const f of attempts(host)) assert.throws(f, /suppression interdite/);
  ctx.ctl.refuse.add(SHOP_A);
  await hook(ctx.app, "app/uninstalled", uninstallBody(SHOP_A, HOST_A));
  await hook(ctx.app, "shop/redact", redactBody(SHOP_A));
  await captureLogs(() => ctx.hooks.idle());
  assert.equal(ctx.store.getSite(ctx.A.site.id), null);
  for (const f of attempts(HOST_B)) assert.throws(f, /suppression interdite/);
  // Les modifications restent figées (déclencheur des mises à jour inchangé).
  assert.throws(() => db.prepare("UPDATE shopify_changes SET after_value = 'x' WHERE site_host = ?").run(HOST_B), /modification interdite/);
  // L'autorisation ne vaut que pour une adresse et une ligne.
  assert.throws(() => db.prepare("INSERT INTO history_delete_grant (id, site_host) VALUES (2, 'x')").run());
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM history_delete_grant").get() as any).n, 0);
  // Un effacement annulé (levée dans la transaction) ne laisse ni autorisation ni suppression.
  const bCount = (db.prepare("SELECT COUNT(*) AS n FROM shopify_changes WHERE site_host = ?").get(HOST_B) as any).n;
  assert.throws(() => purgeShop(db, SHOP_B, () => {
    throw new Error("annulé");
  }));
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM shopify_changes WHERE site_host = ?").get(HOST_B) as any).n, bCount);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM history_delete_grant").get() as any).n, 0);
  for (const f of attempts(HOST_B)) assert.throws(f, /suppression interdite/);
});

test("exhaustivité : chaque table de la base a une décision d'effacement cohérente avec ses colonnes", () => {
  const db = openDb(":memory:");
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((t) => t.name);
  const missing = tables.filter((t) => !(t in PURGE_PLAN));
  assert.deepEqual(missing, [], `tables sans décision d'effacement : ${missing.join(", ")}`);
  assert.deepEqual(Object.keys(PURGE_PLAN).filter((t) => !tables.includes(t)), [], "décision pour une table qui n'existe pas");
  /** Tables « non concernées » qui portent pourtant un domaine : justifiées une à une. */
  const allowed: Record<string, string> = {
    shop_redactions: "file des demandes : domaine effacé à la clôture",
    history_delete_grant: "autorisation vide hors de la transaction d'effacement",
  };
  for (const t of tables) {
    const cols = (db.prepare(`PRAGMA table_info("${t}")`).all() as Array<{ name: string }>).map((c) => c.name);
    const d = PURGE_PLAN[t];
    const shopish = cols.filter((c) => ["site_id", "site_host", "shop_domain"].includes(c));
    if (d === "not_concerned") assert.ok(!shopish.length || t in allowed, `${t} porte ${shopish.join(", ")} mais n'est pas effacée`);
    if (d === "site_id") assert.ok(cols.includes("site_id"), t);
    if (d === "site_host") assert.ok(cols.includes("site_host"), t);
    if (d === "audit_id") assert.ok(cols.includes("audit_id"), t);
    if (d === "batch_of_site_host") assert.ok(cols.includes("batch_id"), t);
    if (d === "site") assert.ok(cols.includes("shop_domain"), t);
    if (d === "shop") assert.ok(cols.includes("domain"), t);
    if (d === "shop_domain") assert.ok(cols.includes("shop_domain"), t);
  }
});

// ───────── Vie privée des clients et journaux

test("vie privée des clients : 200, rien du corps enregistré ni journalisé ; journaux sans secret, jeton ni domaine", async () => {
  const ctx = await setup();
  const before = dumpDb(ctx);
  const { logs } = await captureLogs(async () => {
    for (const [topic, body] of [["customers/redact", customerRedactBody(SHOP_A)], ["customers/data_request", dataRequestBody(SHOP_B)]] as const) {
      const res = await hook(ctx.app, topic, body);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), "");
    }
    await ctx.hooks.idle();
    // Toute la vie d'une boutique : désinstallation puis effacement.
    ctx.ctl.refuse.add(SHOP_A);
    await hook(ctx.app, "app/uninstalled", uninstallBody(SHOP_A, HOST_A));
    await hook(ctx.app, "shop/redact", redactBody(SHOP_A));
    await hook(ctx.app, "shop/redact", { shop_domain: "mal formé" });
    await hook(ctx.app, "orders/create", { shop_domain: SHOP_B });
    await ctx.hooks.idle();
  });
  const events = ctx.store.db.prepare("SELECT * FROM webhook_events ORDER BY received_at").all() as any[];
  assert.deepEqual(events.slice(0, 2).map((e) => e.topic), ["customers/redact", "customers/data_request"]);
  const after = dumpDb(ctx);
  for (const s of ["client.final@example.com", "+33600000000", "191167", "299938", "marchand@example.com"]) {
    assert.ok(!after.includes(s), `donnée du corps enregistrée : ${s}`);
    assert.ok(!logs.includes(s), `donnée du corps journalisée : ${s}`);
  }
  assert.notEqual(after, before);
  for (const secret of [FAKE_CREDS.clientSecret, SHOP_A, SHOP_B, ...ctx.multi.issued]) assert.ok(!logs.includes(secret), "valeur sensible journalisée");
  assert.match(logs, /vie privée/);
});

test("réponse rapide : 200 avant la fin du travail long", async () => {
  const ctx = await setup();
  // Le lot de A ne s'arrête qu'après sa ligne en cours : retenue, la réponse part quand même.
  const lot = await ctx.app.request(`${ctx.A.base}/shopify/batches`, withToken(SHOP_A, post({ title: "L", items: [{ resourceId: ctx.A.byPath["/pages/contact"].id, field: "seo_description", value: "Une description de contact suffisamment longue." }, { resourceId: ctx.A.byPath["/products/bague-or"].id, field: "seo_description", value: "Une description de bague suffisamment longue." }] })));
  const lotId = ((await lot.json()) as any).batch.id;
  ctx.hold();
  const firstWrite = new Promise<void>((r) => (ctx.ctl.onMutation = r));
  await ctx.app.request(`${ctx.A.base}/shopify/batches/${lotId}/apply`, withToken(SHOP_A, { method: "POST", headers: JSON_HEADERS }));
  await withTimeout(firstWrite, 5000, "première écriture");
  ctx.ctl.refuse.add(SHOP_A);
  const res = await withTimeout(Promise.resolve(hook(ctx.app, "app/uninstalled", uninstallBody(SHOP_A, HOST_A))), 1000, "réponse");
  assert.equal(res.status, 200);
  ctx.ctl.release();
  await captureLogs(() => ctx.hooks.idle());
});

// ───────── Revue du lot C : rejeux, preuves d'effacement, effacement sûr

const DAY = 24 * 60 * 60 * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pending = (db: DB) => redactions(db).filter((r) => r.state === "pending");

test("forme du corps : chaque corps signé n'est accepté que sous son propre sujet (16 croisements)", async () => {
  const bodies: Record<string, (shop: string) => Record<string, unknown>> = {
    "app/uninstalled": (shop) => uninstallBody(shop, HOST_A),
    "shop/redact": redactBody,
    "customers/redact": customerRedactBody,
    "customers/data_request": dataRequestBody,
  };
  // Fonction pure : seule la diagonale est acceptée.
  for (const topic of WEBHOOK_TOPICS) {
    for (const [bodyTopic, make] of Object.entries(bodies)) {
      assert.equal(bodyMatchesTopic(topic, make(SHOP_A)), topic === bodyTopic, `corps ${bodyTopic} sous ${topic}`);
    }
  }
  assert.equal(bodyMatchesTopic("shop/redact", { shop_id: "954889", shop_domain: SHOP_A }), false, "shop_id texte");
  for (const extra of ["customer", "orders_to_redact", "data_request", "orders_requested", "myshopify_domain"]) {
    assert.equal(bodyMatchesTopic("shop/redact", { ...redactBody(SHOP_A), [extra]: {} }), false, `shop/redact avec ${extra}`);
  }
  assert.equal(bodyMatchesTopic("customers/redact", { ...customerRedactBody(SHOP_A), customer: "x" }), false);
  assert.equal(bodyMatchesTopic("customers/data_request", { ...dataRequestBody(SHOP_A), data_request: null }), false);
  assert.equal(bodyMatchesTopic("app/uninstalled", { ...uninstallBody(SHOP_A, HOST_A), customer: {} }), false);

  // Par la route, sur une boutique désinstallée (la seule à pouvoir être effacée) : aucun croisement n'a d'effet.
  const ctx = await setup();
  await uninstall(ctx);
  const before = dumpDb(ctx);
  await captureLogs(async () => {
    for (const topic of WEBHOOK_TOPICS) {
      for (const [bodyTopic, make] of Object.entries(bodies)) {
        if (bodyTopic === topic) continue;
        const res = await hook(ctx.app, topic, make(SHOP_A), { shopHeader: SHOP_A });
        assert.equal(res.status, 200, `corps ${bodyTopic} sous ${topic}`);
      }
    }
    await ctx.hooks.idle();
  });
  assert.equal(dumpDb(ctx), before, "un corps rejoué sous un autre sujet a eu un effet");
  assert.equal(redactions(ctx.store.db).length, 0);
  assert.ok(ctx.store.getSite(ctx.A.site.id), "la boutique a été effacée par un corps d'un autre sujet");
});

test("rejeu : ancien avis de désinstallation sous un nouvel identifiant ou sans identifiant → ignoré ; ancien shop/redact → boutique réinstallée intacte", async () => {
  const ctx = await setup();
  const old = uninstallBody(SHOP_A, HOST_A);
  await uninstall(ctx, SHOP_A, HOST_A, {}, old);
  assert.ok(shopRow(ctx.store.db, SHOP_A)!.uninstalled_at);
  // Réinstallation.
  assert.equal((await ctx.app.request("/api/sites", withToken(SHOP_A))).status, 200);
  const tokens = shopRow(ctx.store.db, SHOP_A)!.access_token;
  assert.ok(tokens);
  assert.ok(shopRow(ctx.store.db, SHOP_A)!.tokens_saved_at);
  await captureLogs(async () => {
    assert.equal((await hook(ctx.app, "app/uninstalled", old)).status, 200);
    assert.equal((await hook(ctx.app, "app/uninstalled", old, { id: null })).status, 200);
    await ctx.hooks.idle();
  });
  assert.equal(shopRow(ctx.store.db, SHOP_A)!.access_token, tokens, "jetons de la boutique réinstallée effacés par un rejeu");
  assert.equal(shopRow(ctx.store.db, SHOP_A)!.uninstalled_at, null);
  assert.ok(ctx.shopifyRegistry.peek(SHOP_A), "jeu de services libéré par un rejeu");
  // L'ancien shop/redact rejoué : Shopify accepte les jetons, rien n'est effacé.
  await captureLogs(async () => {
    await hook(ctx.app, "shop/redact", redactBody(SHOP_A));
    await ctx.hooks.idle();
  });
  const [r] = redactions(ctx.store.db);
  assert.equal(r.outcome, "reinstalled");
  assert.ok(ctx.store.getSite(ctx.A.site.id));
});

test("avis de désinstallation en retard (daté d'avant la réinstallation) puis shop/redact → boutique intacte ; avis confirmé par Shopify → traité", async () => {
  const ctx = await setup();
  const late = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const tokens = shopRow(ctx.store.db, SHOP_A)!.access_token;
  await captureLogs(async () => {
    assert.equal((await hook(ctx.app, "app/uninstalled", uninstallBody(SHOP_A, HOST_A), { headers: { "x-shopify-triggered-at": late } })).status, 200);
    await ctx.hooks.idle();
    await hook(ctx.app, "shop/redact", redactBody(SHOP_A));
    await ctx.hooks.idle();
  });
  assert.equal(shopRow(ctx.store.db, SHOP_A)!.access_token, tokens);
  assert.equal(shopRow(ctx.store.db, SHOP_A)!.uninstalled_at, null);
  assert.equal(redactions(ctx.store.db)[0].outcome, "reinstalled");
  assert.ok(ctx.store.getSite(ctx.A.site.id));
  // Le même avis rejoué sans sa date : Shopify accepte toujours les jetons, ignoré.
  await captureLogs(async () => {
    await hook(ctx.app, "app/uninstalled", uninstallBody(SHOP_A, HOST_A));
    await ctx.hooks.idle();
  });
  assert.equal(shopRow(ctx.store.db, SHOP_A)!.access_token, tokens);
  // Un avis que Shopify confirme (jetons refusés définitivement) est traité, quelle que soit sa date.
  await uninstall(ctx, SHOP_B, HOST_B, { headers: { "x-shopify-triggered-at": late } });
  assert.ok(shopRow(ctx.store.db, SHOP_B)!.uninstalled_at);
});

test("preuves : jamais désinstallée et sans jeton → en attente ; désinstallation confirmée puis requête identifiée sans échange réussi → en attente aussi", async () => {
  const ctx = await setup();
  // B : jetons absents, jamais marquée désinstallée.
  ctx.store.db.prepare("UPDATE shops SET access_token = NULL, refresh_token = NULL, access_expires_at = NULL, refresh_expires_at = NULL WHERE domain = ?").run(SHOP_B);
  // A : désinstallée, puis une requête identifiée (dans la minute qui suit la précédente) dont l'échange échoue.
  await uninstall(ctx);
  await sleep(5);
  ctx.multi.ctl.down.add(SHOP_A);
  await captureLogs(async () => {
    await ctx.app.request("/api/sites", withToken(SHOP_A));
  });
  const row = shopRow(ctx.store.db, SHOP_A)!;
  assert.equal(row.access_token, null, "aucun échange réussi");
  assert.ok(Date.parse(String(row.last_seen_at)) > Date.parse(String(row.uninstalled_at)), "la requête identifiée n'a pas été notée");
  await captureLogs(async () => {
    await hook(ctx.app, "shop/redact", redactBody(SHOP_A));
    await hook(ctx.app, "shop/redact", redactBody(SHOP_B));
    await ctx.hooks.idle();
  });
  // A : une requête identifiée est arrivée après la désinstallation confirmée (réinstallation probable, échange
  // pas encore abouti) : plus de preuve, en attente. B : aucune preuve, en attente.
  assert.deepEqual(pending(ctx.store.db).map((r) => r.shop_domain).sort(), [SHOP_A, SHOP_B].sort());
  assert.ok(ctx.store.getSite(ctx.A.site.id));
  assert.ok(ctx.store.getSite(ctx.B.site.id));
});

test("preuves : jetons présents mais illisibles (clé changée) → en attente", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "chat-seo-webhooks-"));
  const ctx = await setup({ dataDir });
  ctx.hooks.stop();
  const { multi } = controlledMulti();
  const t2 = fakeTimers();
  const env2 = embeddedShops({ multi, dataDir, encryptionKey: randomBytes(32), webhooks: { timers: t2.timers } });
  await captureLogs(async () => {
    await hook(env2.app, "shop/redact", redactBody(SHOP_A));
    await env2.webhooks!.idle();
  });
  assert.equal(pending(env2.store.db).length, 1);
  assert.ok(env2.store.siteByShop(SHOP_A));
  assert.ok(shopRow(env2.store.db, SHOP_A)!.access_token, "jetons gardés");
});

test("preuves : réponse inattendue, erreur GraphQL, 429 ou 5xx de Shopify → en attente ; seul un refus définitif efface", async () => {
  const cases: Array<[string, (url: string) => Response | null]> = [
    ["erreur GraphQL", (url) => (url.endsWith("/graphql.json") ? Response.json({ errors: [{ message: "Internal error" }] }) : null)],
    ["réponse vide", (url) => (url.endsWith("/graphql.json") ? Response.json({}) : null)],
    ["503", (url) => (url.endsWith("/graphql.json") ? new Response("", { status: 503 }) : null)],
    ["401 puis renouvellement 429", (url) => (url.endsWith("/graphql.json") ? new Response("", { status: 401 }) : url.endsWith("/access_token") ? new Response("", { status: 429 }) : null)],
    ["401 puis renouvellement 500", (url) => (url.endsWith("/graphql.json") ? new Response("", { status: 401 }) : url.endsWith("/access_token") ? new Response("", { status: 500 }) : null)],
  ];
  for (const [label, respond] of cases) {
    const ctx = await setup();
    ctx.ctl.override = (domain, url) => (domain === SHOP_A ? respond(url) : null);
    await captureLogs(async () => {
      await hook(ctx.app, "shop/redact", redactBody(SHOP_A));
      await ctx.hooks.idle();
    });
    assert.equal(pending(ctx.store.db).length, 1, label);
    assert.ok(ctx.store.getSite(ctx.A.site.id), `${label} : effacée sans preuve`);
  }
});

test("25 jours : une requête identifiée arrivée depuis la demande la garde en attente, avertissement au plus une fois par jour", async () => {
  let now = Date.now();
  const { multi } = controlledMulti();
  const t = fakeTimers();
  const ctx = await twoShops({ multi, webhooks: { timers: t.timers, now: () => now } });
  now = Date.now() + 1000;
  ctx.store.db.prepare("UPDATE shops SET access_token = NULL, refresh_token = NULL, access_expires_at = NULL, refresh_expires_at = NULL WHERE domain = ?").run(SHOP_A);
  multi.ctl.down.add(SHOP_A);
  await captureLogs(async () => {
    await hook(ctx.app, "shop/redact", redactBody(SHOP_A));
    await ctx.webhooks!.idle();
  });
  // Requête identifiée de A après la demande.
  ctx.store.db.prepare("UPDATE shops SET last_seen_at = ? WHERE domain = ?").run(new Date(now + 60_000).toISOString(), SHOP_A);
  now += 25 * DAY + 1000;
  const warn = /plus de 25 jours/;
  let { logs } = await captureLogs(() => ctx.webhooks!.runPending());
  assert.match(logs, warn);
  assert.equal(pending(ctx.store.db).length, 1);
  now += 60 * 60 * 1000;
  ({ logs } = await captureLogs(() => ctx.webhooks!.runPending()));
  assert.doesNotMatch(logs, warn, "avertissement répété dans la journée");
  now += DAY;
  ({ logs } = await captureLogs(() => ctx.webhooks!.runPending()));
  assert.match(logs, warn);
  assert.equal(pending(ctx.store.db).length, 1);
  assert.ok(ctx.store.siteByShop(SHOP_A));
});

test("effacement sûr : les valeurs effacées ne restent ni dans le fichier de la base ni dans son journal", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "chat-seo-webhooks-"));
  const ctx = await setup({ dataDir });
  const marker = "MARQUEUR-EFFACE-7f3a9c";
  ctx.store.db.prepare("INSERT INTO chat_messages (id, site_id, seq, role, content, created_at, sources_json) VALUES (?, ?, 1, 'user', ?, ?, '[]')").run("msg_marqueur", ctx.A.site.id, marker.repeat(20), new Date().toISOString());
  const file = path.join(dataDir, "chat-seo.sqlite");
  const bytes = () => Buffer.concat([readFileSync(file), existsSync(`${file}-wal`) ? readFileSync(`${file}-wal`) : Buffer.alloc(0)]).toString("latin1");
  assert.ok(bytes().includes(marker), "le marqueur doit être dans les fichiers avant l'effacement");
  ctx.ctl.refuse.add(SHOP_A);
  await captureLogs(async () => {
    await hook(ctx.app, "app/uninstalled", uninstallBody(SHOP_A, HOST_A));
    await hook(ctx.app, "shop/redact", redactBody(SHOP_A));
    await ctx.hooks.idle();
  });
  assert.equal(redactions(ctx.store.db)[0].outcome, "erased");
  const after = bytes();
  assert.ok(!after.includes(marker), "valeur effacée encore présente dans les fichiers de la base");
  assert.ok(!after.includes(HOST_A), "adresse effacée encore présente dans les fichiers de la base");
  assert.ok(after.includes(HOST_B), "B doit rester");
  assert.equal(Number((ctx.store.db.prepare("PRAGMA secure_delete").get() as any).secure_delete), 1);
});

test("réinstallation pendant l'arrêt des travaux précédant la purge : rien d'effacé, demande en attente puis close", async () => {
  const ctx = await setup();
  await uninstall(ctx);
  const original = ctx.pagespeed.cancel.bind(ctx.pagespeed);
  let reinstalled = false;
  ctx.pagespeed.cancel = async (siteId: string) => {
    if (!reinstalled && siteId === ctx.A.site.id) {
      reinstalled = true;
      assert.equal((await ctx.app.request("/api/sites", withToken(SHOP_A))).status, 200);
    }
    return original(siteId);
  };
  await captureLogs(async () => {
    await hook(ctx.app, "shop/redact", redactBody(SHOP_A));
    await ctx.hooks.idle();
  });
  assert.ok(reinstalled, "le chemin d'arrêt des travaux n'a pas été pris");
  assert.equal(pending(ctx.store.db).length, 1);
  assert.ok(ctx.store.getSite(ctx.A.site.id));
  assert.ok(shopRow(ctx.store.db, SHOP_A)!.access_token);
  assert.equal(shopRow(ctx.store.db, SHOP_A)!.uninstalled_at, null);
  assert.equal((ctx.store.db.prepare("SELECT COUNT(*) AS n FROM history_delete_grant").get() as any).n, 0);
  // Reprise une heure plus tard : Shopify accepte les jetons, la demande est close sans rien effacer.
  ctx.clock.offset += REDACTION_RETRY_MS;
  await captureLogs(() => ctx.hooks.runPending());
  assert.equal(redactions(ctx.store.db)[0].outcome, "reinstalled");
  assert.ok(ctx.store.getSite(ctx.A.site.id));
});

test("au plus 20 corps lus en même temps : 503 au-delà, de nouveau accepté ensuite", async () => {
  const ctx = await setup();
  const controllers: Array<ReadableStreamDefaultController<Uint8Array>> = [];
  const inflight: Array<Promise<Response>> = [];
  for (let i = 0; i < WEBHOOK_MAX_CONCURRENT_READS; i++) {
    const body = new ReadableStream<Uint8Array>({ start: (c) => void controllers.push(c) });
    inflight.push(Promise.resolve(ctx.app.request("/webhooks/shopify", { method: "POST", headers: { "x-shopify-topic": "shop/redact", "x-shopify-hmac-sha256": "x" }, body, duplex: "half" } as RequestInit)));
  }
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  const over = await hook(ctx.app, "app/uninstalled", uninstallBody(SHOP_A, HOST_A));
  assert.equal(over.status, 503);
  assert.equal(shopRow(ctx.store.db, SHOP_A)!.uninstalled_at, null, "rien traité au-delà de la limite");
  for (const c of controllers) {
    c.enqueue(new TextEncoder().encode("{}"));
    c.close();
  }
  for (const r of await Promise.all(inflight)) assert.equal(r.status, 401);
  const ok = await hook(ctx.app, "app/uninstalled", uninstallBody(SHOP_A, HOST_A));
  assert.equal(ok.status, 200);
  await captureLogs(() => ctx.hooks.idle());
});

/** Magasin de jetons d'essai : compte les enregistrements. */
function memoryStore(initial: TokenPair | null = null) {
  const st = { pair: initial, saves: 0 };
  const store: TokenStore = {
    load: () => st.pair,
    save: (p) => {
      st.saves++;
      st.pair = p;
    },
    clear: () => {
      st.pair = null;
    },
  };
  return { st, store };
}

const tokenResponse = () => Response.json({ access_token: "acces-neuf", scope: "read_products", expires_in: 3600, refresh_token: "renouv-neuf", refresh_token_expires_in: 7776000 });

test("jeton en vol : une réponse à une demande partie avant la désinstallation n'est jamais enregistrée (échange et renouvellement)", async () => {
  const creds = { storeDomain: SHOP_A, clientId: FAKE_CREDS.clientId, clientSecret: FAKE_CREDS.clientSecret };
  // Échange.
  {
    let answer!: (r: Response) => void;
    const fetchImpl = (() => new Promise<Response>((r) => (answer = r))) as unknown as typeof fetch;
    const { st, store } = memoryStore();
    const auth = new ShopifyAuth(creds, fetchImpl, Date.now, { mode: "embedded", tokenStore: store });
    const exchange = auth.ensureSession("jeton-de-session");
    await new Promise((r) => setImmediate(r));
    auth.forget();
    answer(tokenResponse());
    await assert.rejects(exchange, (e) => e instanceof ShopifyError && e.code === "no_session");
    assert.equal(st.saves, 0);
    assert.equal(st.pair, null);
    assert.equal(auth.hasTokens(), false);
  }
  // Renouvellement.
  {
    let answer!: (r: Response) => void;
    const fetchImpl = (() => new Promise<Response>((r) => (answer = r))) as unknown as typeof fetch;
    const now = Date.now();
    const { st, store } = memoryStore({ access: { value: "acces-perime", expiresAt: now - 1000, scopes: [] }, refresh: { value: "renouv-ancien", expiresAt: now + 30 * DAY } });
    const auth = new ShopifyAuth(creds, fetchImpl, Date.now, { mode: "embedded", tokenStore: store });
    const token = auth.getToken();
    await new Promise((r) => setImmediate(r));
    auth.forget();
    answer(tokenResponse());
    await assert.rejects(token, (e) => e instanceof ShopifyError && e.code === "no_session");
    assert.equal(st.saves, 0);
    assert.equal(st.pair, null);
    assert.equal(auth.hasTokens(), false);
  }
});

test("migrations 3 puis 4 sur une base existante avec de l'historique : historique intact, suppressions ordinaires toujours refusées", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "chat-seo-webhooks-"));
  const ctx = await setup({ dataDir });
  ctx.hooks.stop();
  fillAll(ctx.store.db, ctx.A.site.id, HOST_A);
  fillAll(ctx.store.db, ctx.B.site.id, HOST_B);
  const history = (db: DB | DatabaseSync) =>
    JSON.stringify(["shopify_changes", "shopify_verifications", "shopify_batches", "shopify_batch_items", "automation_usage"].map((t) => db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all()));
  const before = history(ctx.store.db);
  assert.ok(JSON.parse(before).every((rows: unknown[]) => rows.length > 0));
  // Base ramenée à l'état d'avant la migration 3 (déclencheurs d'origine recréés par le schéma de départ).
  const file = path.join(dataDir, "chat-seo.sqlite");
  {
    const raw = new DatabaseSync(file);
    raw.exec(`DROP TABLE webhook_events; DROP TABLE shop_redactions; DROP TABLE uninstall_checks;
      DROP TRIGGER shopify_changes_no_delete; DROP TRIGGER shopify_verifications_no_delete; DROP TRIGGER shopify_batches_no_delete; DROP TRIGGER shopify_batch_items_no_delete;
      DROP TABLE history_delete_grant; ALTER TABLE shops DROP COLUMN tokens_saved_at;
      DELETE FROM schema_migrations WHERE version >= 3;`);
    raw.close();
  }
  const db = openDb(dataDir);
  assert.deepEqual((db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as any[]).map((r) => r.version), [1, 2, 3, 4, 5]);
  assert.equal(history(db), before, "historique modifié par les migrations");
  const cols = (db.prepare("PRAGMA table_info(shops)").all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(cols.includes("tokens_saved_at"));
  // Migration 5 : les empreintes des corps ont disparu, la file des avis à vérifier existe.
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
  assert.ok(!names.includes("uninstall_digests") && names.includes("uninstall_checks"));
  for (const host of [HOST_A, HOST_B]) {
    assert.throws(() => db.prepare("DELETE FROM shopify_changes WHERE site_host = ?").run(host), /suppression interdite/);
    assert.throws(() => db.prepare("DELETE FROM shopify_verifications WHERE site_host = ?").run(host), /suppression interdite/);
    assert.throws(() => db.prepare("DELETE FROM shopify_batch_items WHERE batch_id IN (SELECT id FROM shopify_batches WHERE site_host = ?)").run(host), /suppression interdite/);
    assert.throws(() => db.prepare("DELETE FROM shopify_batches WHERE site_host = ?").run(host), /suppression interdite/);
  }
  assert.equal(history(db), before);
  // Le seul chemin d'effacement fonctionne sur la base migrée, pour A seulement.
  purgeShop(db, SHOP_A);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM shopify_changes WHERE site_host = ?").get(HOST_A) as any).n, 0);
  assert.ok((db.prepare("SELECT COUNT(*) AS n FROM shopify_changes WHERE site_host = ?").get(HOST_B) as any).n > 0);
  assert.throws(() => db.prepare("DELETE FROM shopify_changes WHERE site_host = ?").run(HOST_B), /suppression interdite/);
  db.close();
});

test("reprise sans demande en attente, puis une demande arrive : elle est bien traitée (exécution jamais bloquée)", async () => {
  const ctx = await setup();
  await uninstall(ctx);
  // Reprise au démarrage alors qu'aucune demande n'attend.
  ctx.hooks.start();
  await withTimeout(ctx.hooks.idle(), 2000, "reprise à vide");
  await captureLogs(async () => {
    await hook(ctx.app, "shop/redact", redactBody(SHOP_A));
    await withTimeout(ctx.hooks.idle(), 5000, "effacement");
  });
  assert.equal(redactions(ctx.store.db)[0].outcome, "erased");
  ctx.hooks.stop();
});

// ───────── Revue des lots C à E : un avis de désinstallation n'est jamais cru sur parole

const uninstallChecks = (db: DB) => db.prepare("SELECT * FROM uninstall_checks ORDER BY shop_domain").all() as Array<Record<string, string | number | null>>;

test("(i) boutique installée et active : avis tardifs (avec et sans date, corps neuf et corps déjà vu) puis shop/redact → rien d'effacé, jetons et travaux intacts", async () => {
  const ctx = await setup();
  const { A } = ctx;
  const before = shopRow(ctx.store.db, SHOP_A)!;
  // Un lot de deux lignes en cours d'écriture, retenu sur sa première écriture.
  const lot = await ctx.app.request(`${A.base}/shopify/batches`, withToken(SHOP_A, post({ title: "L", items: [{ resourceId: A.byPath["/pages/contact"].id, field: "seo_description", value: "Une description de contact suffisamment longue." }, { resourceId: A.byPath["/products/bague-or"].id, field: "seo_description", value: "Une description de bague suffisamment longue." }] })));
  const lotId = ((await lot.json()) as any).batch.id;
  ctx.hold();
  const firstWrite = new Promise<void>((r) => (ctx.ctl.onMutation = r));
  await ctx.app.request(`${A.base}/shopify/batches/${lotId}/apply`, withToken(SHOP_A, postEmpty()));
  await withTimeout(firstWrite, 5000, "première écriture");
  const bundleA = ctx.shopifyRegistry.peek(SHOP_A)!;
  const body = uninstallBody(SHOP_A, HOST_A);
  const late = new Date(Date.now() - 3 * DAY).toISOString();
  await captureLogs(async () => {
    // Corps jamais vu, sans date ; puis le même corps (déjà vu) sous un autre identifiant, avec une date ancienne ;
    // puis un autre corps, sans identifiant.
    for (const [b, o] of [[body, {}], [body, { headers: { "x-shopify-triggered-at": late } }], [{ ...body, plan_name: "shopify" }, { id: null }]] as Array<[unknown, HookOpts]>) {
      assert.equal((await hook(ctx.app, "app/uninstalled", b, o)).status, 200);
      await ctx.hooks.idle();
    }
    await hook(ctx.app, "shop/redact", redactBody(SHOP_A));
    await ctx.hooks.idle();
  });
  const row = shopRow(ctx.store.db, SHOP_A)!;
  assert.equal(row.uninstalled_at, null, "boutique marquée désinstallée");
  assert.equal(row.access_token, before.access_token, "jetons effacés");
  assert.equal(row.refresh_token, before.refresh_token);
  assert.equal(ctx.shopifyRegistry.peek(SHOP_A), bundleA, "jeu de services libéré");
  assert.deepEqual(uninstallChecks(ctx.store.db), [], "avis restés en attente");
  assert.equal(redactions(ctx.store.db)[0].outcome, "reinstalled");
  assert.ok(ctx.store.getSite(A.site.id));
  // Le lot n'a pas été arrêté : il va jusqu'au bout.
  ctx.ctl.release();
  await bundleA.batches.wait(A.site.id);
  const items = ctx.store.db.prepare("SELECT state FROM shopify_batch_items WHERE batch_id = ? ORDER BY seq").all(lotId) as any[];
  assert.deepEqual(items.map((i) => i.state), ["applied", "applied"]);
});

test("(ii) désinstallation réelle confirmée par Shopify → marquée ; puis shop/redact → effacée", async () => {
  const ctx = await setup();
  await uninstall(ctx);
  assert.ok(shopRow(ctx.store.db, SHOP_A)!.uninstalled_at);
  assert.equal(shopRow(ctx.store.db, SHOP_A)!.access_token, null);
  await captureLogs(async () => {
    await hook(ctx.app, "shop/redact", redactBody(SHOP_A));
    await ctx.hooks.idle();
  });
  assert.equal(redactions(ctx.store.db)[0].outcome, "erased");
  assert.equal(ctx.store.getSite(ctx.A.site.id), null);
  assert.ok(ctx.store.getSite(ctx.B.site.id));
});

test("(iii) désinstallation, réinstallation, seconde désinstallation réelle au corps identique → traitée", async () => {
  const ctx = await setup();
  const body = uninstallBody(SHOP_A, HOST_A);
  await uninstall(ctx, SHOP_A, HOST_A, {}, body);
  assert.ok(shopRow(ctx.store.db, SHOP_A)!.uninstalled_at);
  assert.equal((await ctx.app.request("/api/sites", withToken(SHOP_A))).status, 200);
  assert.equal(shopRow(ctx.store.db, SHOP_A)!.uninstalled_at, null, "réinstallée");
  assert.ok(shopRow(ctx.store.db, SHOP_A)!.access_token);
  await captureLogs(() => uninstall(ctx, SHOP_A, HOST_A, {}, body));
  const row = shopRow(ctx.store.db, SHOP_A)!;
  assert.ok(row.uninstalled_at, "seconde désinstallation ignorée");
  assert.equal(row.access_token, null);
  assert.equal(ctx.shopifyRegistry.peek(SHOP_A), null);
});

test("(iv) avis reçu pendant que Shopify est injoignable → en attente sans effet, puis confirmé (A) ou ignoré (B) à la reprise", async () => {
  const ctx = await setup();
  ctx.multi.ctl.down.add(SHOP_A);
  ctx.multi.ctl.down.add(SHOP_B);
  const tokensB = shopRow(ctx.store.db, SHOP_B)!.access_token;
  const bundleA = ctx.shopifyRegistry.peek(SHOP_A);
  await captureLogs(async () => {
    await hook(ctx.app, "app/uninstalled", uninstallBody(SHOP_A, HOST_A));
    await hook(ctx.app, "app/uninstalled", uninstallBody(SHOP_B, HOST_B));
    await ctx.hooks.idle();
    ctx.hooks.start();
    await ctx.hooks.idle();
    ctx.t.fire();
    await ctx.hooks.idle();
  });
  const pendingChecks = uninstallChecks(ctx.store.db);
  assert.deepEqual(pendingChecks.map((r) => r.shop_domain), [SHOP_A, SHOP_B]);
  assert.ok(pendingChecks.every((r) => Number(r.attempts) >= 2), "reposé au démarrage puis à l'heure");
  for (const shop of [SHOP_A, SHOP_B]) {
    assert.equal(shopRow(ctx.store.db, shop)!.uninstalled_at, null, "effet sans confirmation");
    assert.ok(shopRow(ctx.store.db, shop)!.access_token, "jetons effacés sans confirmation");
  }
  assert.equal(ctx.shopifyRegistry.peek(SHOP_A), bundleA, "jeu de services libéré sans confirmation");
  // Reprise : Shopify répond. A : jetons refusés définitivement ; B : jetons acceptés.
  ctx.multi.ctl.down.clear();
  ctx.ctl.refuse.add(SHOP_A);
  await captureLogs(async () => {
    ctx.t.fire();
    await ctx.hooks.idle();
  });
  assert.deepEqual(uninstallChecks(ctx.store.db), []);
  assert.ok(shopRow(ctx.store.db, SHOP_A)!.uninstalled_at);
  assert.equal(shopRow(ctx.store.db, SHOP_A)!.access_token, null);
  assert.equal(shopRow(ctx.store.db, SHOP_B)!.uninstalled_at, null);
  assert.equal(shopRow(ctx.store.db, SHOP_B)!.access_token, tokensB);
  ctx.hooks.stop();
});

test("(v) refus du renouvellement autre que 401 invalid_request pendant une demande d'effacement → rien d'effacé, jetons gardés", async () => {
  const refusals: Array<[string, () => Response]> = [
    ["401 invalid_client", () => Response.json({ error: "invalid_client" }, { status: 401 })],
    ["401 invalid_grant", () => Response.json({ error: "invalid_grant" }, { status: 401 })],
    ["401 sans corps", () => new Response("", { status: 401 })],
    ["400 invalid_request", () => Response.json({ error: "invalid_request" }, { status: 400 })],
    ["403 invalid_request", () => Response.json({ error: "invalid_request" }, { status: 403 })],
  ];
  for (const [label, refusal] of refusals) {
    const ctx = await setup();
    const before = shopRow(ctx.store.db, SHOP_A)!;
    ctx.ctl.override = (domain, url) => (domain !== SHOP_A ? null : url.endsWith("/graphql.json") ? new Response("", { status: 401 }) : url.endsWith("/access_token") ? refusal() : null);
    await captureLogs(async () => {
      await hook(ctx.app, "shop/redact", redactBody(SHOP_A));
      await hook(ctx.app, "app/uninstalled", uninstallBody(SHOP_A, HOST_A));
      await ctx.hooks.idle();
      // Une heure plus tard, toujours le même refus : toujours rien.
      await ctx.hooks.runPending();
    });
    assert.equal(pending(ctx.store.db).length, 1, label);
    assert.equal(uninstallChecks(ctx.store.db).length, 1, `${label} : avis non resté en attente`);
    assert.ok(ctx.store.getSite(ctx.A.site.id), `${label} : effacée sans preuve`);
    const row = shopRow(ctx.store.db, SHOP_A)!;
    assert.equal(row.uninstalled_at, null, label);
    assert.equal(row.refresh_token, before.refresh_token, `${label} : jetons oubliés pendant la vérification`);
  }
});

test("(vi) jetons enregistrés illisibles, aucune requête depuis la demande : en attente, puis effacée au 25e jour", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "chat-seo-webhooks-"));
  const ctx = await setup({ dataDir });
  ctx.hooks.stop();
  let now = Date.now() + 1000;
  const { multi } = controlledMulti();
  const env2 = embeddedShops({ multi, dataDir, encryptionKey: randomBytes(32), webhooks: { timers: fakeTimers().timers, now: () => now } });
  await captureLogs(async () => {
    await hook(env2.app, "shop/redact", redactBody(SHOP_A));
    await env2.webhooks!.idle();
  });
  assert.equal(pending(env2.store.db).length, 1);
  now += 24 * DAY;
  await captureLogs(() => env2.webhooks!.runPending());
  assert.equal(pending(env2.store.db).length, 1, "effacée avant 25 jours");
  assert.ok(shopRow(env2.store.db, SHOP_A)!.access_token, "jetons gardés");
  now += DAY;
  const { logs } = await captureLogs(() => env2.webhooks!.runPending());
  assert.match(logs, /25 jours/);
  assert.equal(redactions(env2.store.db)[0].outcome, "erased");
  assert.equal(env2.store.siteByShop(SHOP_A), null);
  assert.ok(env2.store.siteByShop(SHOP_B));
  env2.webhooks!.stop();
});

test("sans jeton lisible : l'avis ne marque rien, n'interroge pas Shopify, reste en attente puis est abandonné à 48 heures", async () => {
  const ctx = await setup();
  ctx.store.db.prepare("UPDATE shops SET access_token = NULL, refresh_token = NULL, access_expires_at = NULL, refresh_expires_at = NULL WHERE domain = ?").run(SHOP_A);
  ctx.shopifyRegistry.release(SHOP_A);
  const calls = ctx.multi.log.graphql.length;
  await captureLogs(async () => {
    await hook(ctx.app, "app/uninstalled", uninstallBody(SHOP_A, HOST_A));
    await ctx.hooks.idle();
  });
  assert.equal(shopRow(ctx.store.db, SHOP_A)!.uninstalled_at, null, "marquée sans preuve");
  assert.equal(ctx.multi.log.graphql.length, calls);
  assert.equal(uninstallChecks(ctx.store.db).length, 1);
  assert.equal(ctx.shopifyRegistry.peek(SHOP_A), null, "jeu de services créé pour la vérification gardé en mémoire");
  assert.equal(UNINSTALL_CHECK_TTL_MS, 48 * 60 * 60 * 1000);
  ctx.clock.offset += UNINSTALL_CHECK_TTL_MS;
  const { logs } = await captureLogs(() => ctx.hooks.runPending());
  assert.deepEqual(uninstallChecks(ctx.store.db), []);
  assert.match(logs, /abandonné/);
  assert.ok(!logs.includes(SHOP_A));
  assert.equal(shopRow(ctx.store.db, SHOP_A)!.uninstalled_at, null);
  assert.ok(ctx.store.getSite(ctx.A.site.id));
});

test("effacement : la file des avis à vérifier de la boutique est effacée avec elle, celle d'une autre boutique gardée", () => {
  const db = openDb(":memory:");
  const at = new Date().toISOString();
  db.prepare("INSERT INTO shops (domain, installed_at, last_seen_at) VALUES (?, ?, ?), (?, ?, ?)").run(SHOP_A, at, at, SHOP_B, at, at);
  db.prepare("INSERT INTO uninstall_checks (shop_domain, received_at) VALUES (?, ?), (?, ?)").run(SHOP_A, at, SHOP_B, at);
  purgeShop(db, SHOP_A);
  assert.deepEqual(uninstallChecks(db).map((r) => r.shop_domain), [SHOP_B]);
  db.close();
});

test("refus définitif : seulement 401 invalid_request pour le jeton de renouvellement encore enregistré ; requête ordinaire : tout refus oublie les jetons", async () => {
  const creds = { storeDomain: SHOP_A, clientId: FAKE_CREDS.clientId, clientSecret: FAKE_CREDS.clientSecret };
  const now = Date.now();
  const pair = (refresh: string): TokenPair => ({ access: { value: "acces-perime", expiresAt: now - 1000, scopes: [] }, refresh: { value: refresh, expiresAt: now + 30 * DAY } });
  const refusing = (status: number, error: string | null) => (() => Promise.resolve(error ? Response.json({ error }, { status }) : new Response("", { status }))) as unknown as typeof fetch;
  // Jeton encore enregistré : preuve.
  {
    const { st, store } = memoryStore(pair("renouv-1"));
    const auth = new ShopifyAuth(creds, refusing(401, "invalid_request"), Date.now, { mode: "embedded", tokenStore: store });
    await assert.rejects(auth.getToken(), (e) => e instanceof ShopifyError && e.code === "no_session" && e.revoked === true);
    assert.equal(st.pair, null);
  }
  // Le jeton enregistré en base a changé entre-temps (réinstallation) : pas une preuve.
  {
    const { st, store } = memoryStore(pair("renouv-1"));
    const auth = new ShopifyAuth(creds, refusing(401, "invalid_request"), Date.now, { mode: "embedded", tokenStore: store });
    st.pair = pair("renouv-neuf");
    await assert.rejects(auth.getToken(), (e) => e instanceof ShopifyError && e.revoked === false);
  }
  // Autres refus : jamais une preuve ; une requête ordinaire oublie quand même les jetons (comportement d'avant).
  for (const [status, error] of [[401, "invalid_client"], [400, "invalid_request"], [403, "invalid_request"], [401, null]] as Array<[number, string | null]>) {
    const { st, store } = memoryStore(pair("renouv-1"));
    const auth = new ShopifyAuth(creds, refusing(status, error), Date.now, { mode: "embedded", tokenStore: store });
    await assert.rejects(auth.getToken(), (e) => e instanceof ShopifyError && e.code === "no_session" && e.revoked === false);
    assert.equal(auth.hasTokens(), false, `${status} ${error}`);
    assert.equal(st.pair, null);
  }
  // Pendant une vérification d'installation, un refus non définitif garde les jetons.
  {
    const { st, store } = memoryStore(pair("renouv-1"));
    const auth = new ShopifyAuth(creds, refusing(401, "invalid_client"), Date.now, { mode: "embedded", tokenStore: store });
    await assert.rejects(auth.verifying(() => auth.getToken()));
    assert.equal(auth.hasTokens(), true);
    assert.ok(st.pair);
  }
});

test("corps qui n'arrive pas en entier en 10 s → 408, la place est rendue", async () => {
  const { multi } = controlledMulti();
  const ctx = await twoShops({ multi, webhooks: { timers: fakeTimers().timers, readTimeoutMs: 30 } });
  assert.equal((await import("../src/shopify/webhooks.ts")).WEBHOOK_READ_TIMEOUT_MS, 10_000);
  const slow = () => {
    const body = new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(new TextEncoder().encode('{"myshopify_domain":')) });
    return Promise.resolve(ctx.app.request("/webhooks/shopify", { method: "POST", headers: { "x-shopify-topic": "app/uninstalled", "x-shopify-hmac-sha256": "x" }, body, duplex: "half" } as RequestInit));
  };
  const all = await withTimeout(Promise.all(Array.from({ length: WEBHOOK_MAX_CONCURRENT_READS }, slow)), 3000, "abandon des lectures lentes");
  for (const r of all) assert.equal(r.status, 408);
  // Toutes les places sont rendues : un appel ordinaire est lu et traité.
  const ok = await hook(ctx.app, "shop/redact", redactBody(SHOP_A));
  assert.equal(ok.status, 200);
  await captureLogs(() => ctx.webhooks!.idle());
});

test("un renouvellement de jeton en cours compte comme un travail : le jeu de services n'est pas libéré", async () => {
  const ctx = await setup();
  const bundle = ctx.shopifyRegistry.peek(SHOP_A)!;
  let answer!: () => void;
  const gate = new Promise<void>((r) => (answer = r));
  ctx.ctl.override = (domain, url) => {
    if (domain !== SHOP_A) return null;
    if (url.endsWith("/graphql.json")) return new Response("", { status: 401 });
    return null;
  };
  // Le renouvellement reste en vol jusqu'à `answer()`.
  const inner = ctx.multi.impl;
  ctx.multi.impl = (async (url: string, init: RequestInit) => {
    if (url.endsWith("/admin/oauth/access_token") && new URL(url).hostname === SHOP_A) await gate;
    return inner(url, init);
  }) as unknown as typeof fetch;
  const check = bundle.shopify.installationCheck();
  for (let i = 0; i < 200 && !bundle.shopify.busy(); i++) await sleep(2);
  assert.equal(bundle.shopify.busy(), true, "renouvellement en cours non compté");
  ctx.shopifyRegistry.releaseIdle(0);
  assert.equal(ctx.shopifyRegistry.peek(SHOP_A), bundle, "jeu de services libéré pendant un renouvellement");
  answer();
  await check;
});

// ───────── Troisième revue : désinstallation et effacement sans preuve (règles des 48 heures et des 25 jours)

const HOUR = 60 * 60 * 1000;

test("(a) boutique inactive depuis plus de 90 jours (jetons expirés) puis désinstallée : avis abandonné à 48 h sans rien marquer, effacée au 25e jour", async () => {
  const ctx = await setup();
  // Jetons lisibles mais expirés (jeton de renouvellement compris), dernière requête il y a 91 jours.
  const past = Date.now() - 91 * DAY;
  ctx.store.db.prepare("UPDATE shops SET access_expires_at = ?, refresh_expires_at = ?, last_seen_at = ? WHERE domain = ?").run(past, past, new Date(past).toISOString(), SHOP_A);
  ctx.shopifyRegistry.release(SHOP_A);
  ctx.ctl.refuse.add(SHOP_A); // désinstallée chez Shopify
  await captureLogs(async () => {
    await hook(ctx.app, "app/uninstalled", uninstallBody(SHOP_A, HOST_A));
    await ctx.hooks.idle();
    await hook(ctx.app, "shop/redact", redactBody(SHOP_A));
    await ctx.hooks.idle();
  });
  assert.equal(shopRow(ctx.store.db, SHOP_A)!.uninstalled_at, null, "marquée sans preuve");
  assert.equal(uninstallChecks(ctx.store.db).length, 1);
  assert.equal(pending(ctx.store.db).length, 1);
  assert.ok(ctx.store.getSite(ctx.A.site.id));
  assert.equal(ctx.shopifyRegistry.peek(SHOP_A), null, "jeu de services créé pour la vérification gardé en mémoire");
  // Reprises horaires pendant 48 heures : toujours rien ; à 48 heures, l'avis est abandonné sans effet.
  await captureLogs(async () => {
    for (let h = 0; h < 48; h++) {
      ctx.clock.offset += HOUR;
      await ctx.hooks.runPending();
    }
  });
  assert.deepEqual(uninstallChecks(ctx.store.db), [], "avis non abandonné à 48 heures");
  assert.equal(shopRow(ctx.store.db, SHOP_A)!.uninstalled_at, null);
  assert.equal(pending(ctx.store.db).length, 1);
  assert.ok(ctx.store.getSite(ctx.A.site.id), "effacée avant 25 jours");
  // 25e jour : aucune requête identifiée depuis la demande → effacée.
  ctx.clock.offset = REDACTION_DEADLINE_MS + 1000;
  const { logs } = await captureLogs(() => ctx.hooks.runPending());
  assert.match(logs, /25 jours/);
  assert.equal(redactions(ctx.store.db)[0].outcome, "erased");
  assert.equal(ctx.store.getSite(ctx.A.site.id), null);
  assert.equal(shopRow(ctx.store.db, SHOP_A), undefined);
  assert.ok(ctx.store.getSite(ctx.B.site.id));
  // Files vides : plus rien n'est repris.
  assert.deepEqual(uninstallChecks(ctx.store.db), []);
  assert.deepEqual(pending(ctx.store.db), []);
  assert.ok(!logs.includes(SHOP_A));
});

test("(b) clé changée (jetons illisibles), avis et shop/redact rejoués, requête identifiée après la demande : rien de marqué ni d'effacé, même après 25 jours", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "chat-seo-webhooks-"));
  const ctx = await setup({ dataDir });
  ctx.hooks.stop();
  let now = Date.now();
  const { multi } = controlledMulti();
  const env2 = embeddedShops({ multi, dataDir, encryptionKey: randomBytes(32), webhooks: { timers: fakeTimers().timers, now: () => now } });
  const tokensBefore = shopRow(env2.store.db, SHOP_A)!.access_token;
  // Une première requête identifiée (échange impossible : Shopify injoignable), puis les deux appels rejoués.
  multi.ctl.down.add(SHOP_A);
  await captureLogs(async () => {
    await env2.app.request("/api/sites", withToken(SHOP_A));
  });
  await sleep(5);
  now = Date.now();
  await captureLogs(async () => {
    assert.equal((await hook(env2.app, "app/uninstalled", uninstallBody(SHOP_A, HOST_A))).status, 200);
    assert.equal((await hook(env2.app, "shop/redact", redactBody(SHOP_A))).status, 200);
    await env2.webhooks!.idle();
  });
  await sleep(5);
  // La boutique utilise l'application après la demande (moins d'une minute après sa requête précédente).
  await captureLogs(async () => {
    await env2.app.request("/api/sites", withToken(SHOP_A));
  });
  const received = Date.parse(String(redactions(env2.store.db)[0].received_at));
  assert.ok(Date.parse(String(shopRow(env2.store.db, SHOP_A)!.last_seen_at)) > received, "requête identifiée après la demande non notée");
  assert.equal(shopRow(env2.store.db, SHOP_A)!.uninstalled_at, null, "marquée sans preuve");
  now += 25 * DAY + 1000;
  const { logs } = await captureLogs(() => env2.webhooks!.runPending());
  assert.match(logs, /plus de 25 jours/);
  const row = shopRow(env2.store.db, SHOP_A)!;
  assert.equal(row.uninstalled_at, null);
  assert.equal(row.access_token, tokensBefore, "jetons effacés sans preuve");
  assert.equal(pending(env2.store.db).length, 1);
  assert.ok(env2.store.siteByShop(SHOP_A), "effacée sans preuve");
  assert.deepEqual(uninstallChecks(env2.store.db), [], "avis non abandonné après 48 heures");
  env2.webhooks!.stop();
});

test("(c) jetons oubliés par un refus non définitif (invalid_client), avis tardif, shop/redact, puis nouvel échange réussi : close « réinstallée », rien d'effacé", async () => {
  const ctx = await setup();
  // Une requête du marchand : le renouvellement reçoit 401 invalid_client, les jetons sont oubliés (requête ordinaire).
  ctx.ctl.override = (domain, url, init) => {
    if (domain !== SHOP_A) return null;
    if (url.endsWith("/graphql.json")) return new Response("", { status: 401 });
    if (url.endsWith("/admin/oauth/access_token") && !String(init.body ?? "").includes("token-exchange")) return Response.json({ error: "invalid_client" }, { status: 401 });
    return null;
  };
  // (Chemin d'une requête ordinaire : jeton d'accès à renouveler, hors de toute vérification d'installation.)
  const auth = (ctx.shopifyRegistry.peek(SHOP_A)!.shopify as unknown as { auth: ShopifyAuth }).auth;
  auth.invalidate();
  await assert.rejects(auth.getToken(), (e) => e instanceof ShopifyError && e.code === "no_session" && e.revoked === false);
  assert.equal(shopRow(ctx.store.db, SHOP_A)!.access_token, null, "jetons non oubliés");
  ctx.ctl.override = null;
  await captureLogs(async () => {
    await hook(ctx.app, "app/uninstalled", uninstallBody(SHOP_A, HOST_A));
    await ctx.hooks.idle();
    await hook(ctx.app, "shop/redact", redactBody(SHOP_A));
    await ctx.hooks.idle();
  });
  assert.equal(shopRow(ctx.store.db, SHOP_A)!.uninstalled_at, null, "marquée sans preuve");
  assert.equal(pending(ctx.store.db).length, 1);
  assert.ok(ctx.store.getSite(ctx.A.site.id), "effacée sans preuve");
  // Requête identifiée : nouvel échange réussi.
  assert.equal((await ctx.app.request("/api/sites", withToken(SHOP_A))).status, 200);
  assert.ok(shopRow(ctx.store.db, SHOP_A)!.access_token);
  ctx.clock.offset += HOUR;
  await captureLogs(() => ctx.hooks.runPending());
  assert.equal(redactions(ctx.store.db)[0].outcome, "reinstalled");
  assert.deepEqual(uninstallChecks(ctx.store.db), []);
  assert.equal(shopRow(ctx.store.db, SHOP_A)!.uninstalled_at, null);
  assert.ok(ctx.store.getSite(ctx.A.site.id));
});

test("(e) boutique réellement désinstallée, Shopify répond toujours 400 invalid_grant : jamais une preuve, effacée au 25e jour", async () => {
  const ctx = await setup();
  ctx.ctl.override = (domain, url) => (domain !== SHOP_A ? null : url.endsWith("/graphql.json") ? new Response("", { status: 401 }) : url.endsWith("/access_token") ? Response.json({ error: "invalid_grant" }, { status: 400 }) : null);
  const before = shopRow(ctx.store.db, SHOP_A)!;
  await captureLogs(async () => {
    await hook(ctx.app, "app/uninstalled", uninstallBody(SHOP_A, HOST_A));
    await hook(ctx.app, "shop/redact", redactBody(SHOP_A));
    await ctx.hooks.idle();
  });
  assert.equal(shopRow(ctx.store.db, SHOP_A)!.uninstalled_at, null);
  assert.equal(shopRow(ctx.store.db, SHOP_A)!.refresh_token, before.refresh_token, "jetons oubliés pendant la vérification");
  ctx.clock.offset = 24 * DAY;
  await captureLogs(() => ctx.hooks.runPending());
  assert.deepEqual(uninstallChecks(ctx.store.db), [], "avis non abandonné");
  assert.equal(pending(ctx.store.db).length, 1);
  assert.ok(ctx.store.getSite(ctx.A.site.id), "effacée avant 25 jours");
  ctx.clock.offset = REDACTION_DEADLINE_MS + 1000;
  await captureLogs(() => ctx.hooks.runPending());
  assert.equal(redactions(ctx.store.db)[0].outcome, "erased");
  assert.equal(ctx.store.getSite(ctx.A.site.id), null);
  assert.ok(ctx.store.getSite(ctx.B.site.id));
});

test("(f) cadence : une ligne tentée il y a moins d'une heure n'est pas retentée par l'arrivée d'un autre appel ; reprise forcée au démarrage ; jamais de boucle sans fin", async () => {
  const ctx = await setup();
  ctx.multi.ctl.down.add(SHOP_A);
  ctx.multi.ctl.down.add(SHOP_B);
  const attempts = () => ({
    redactions: redactions(ctx.store.db).map((r) => Number(r.attempts)),
    checks: uninstallChecks(ctx.store.db).map((r) => Number(r.attempts)),
  });
  const shopifyCalls = () => ctx.multi.log.graphql.length;
  await captureLogs(async () => {
    await hook(ctx.app, "shop/redact", redactBody(SHOP_A));
    await withTimeout(ctx.hooks.idle(), 2000, "première demande");
    await hook(ctx.app, "app/uninstalled", uninstallBody(SHOP_A, HOST_A));
    await withTimeout(ctx.hooks.idle(), 2000, "avis");
    await hook(ctx.app, "shop/redact", redactBody(SHOP_B));
    await withTimeout(ctx.hooks.idle(), 2000, "seconde demande");
  });
  // Chaque ligne a été tentée une seule fois, à son arrivée.
  assert.deepEqual(attempts(), { redactions: [1, 1], checks: [1] });
  // 59 minutes plus tard : rien n'est retenté, aucun appel à Shopify.
  const calls = shopifyCalls();
  ctx.clock.offset += 59 * 60 * 1000;
  await captureLogs(() => withTimeout(ctx.hooks.runPending(), 2000, "reprise trop tôt"));
  assert.deepEqual(attempts(), { redactions: [1, 1], checks: [1] });
  assert.equal(shopifyCalls(), calls);
  // Une heure après : chaque ligne est retentée une fois.
  ctx.clock.offset += 60 * 1000;
  await captureLogs(() => withTimeout(ctx.hooks.runPending(), 2000, "reprise horaire"));
  assert.deepEqual(attempts(), { redactions: [2, 2], checks: [2] });
  // Démarrage : tout est repris, même tenté il y a moins d'une heure ; puis la reprise horaire suivante.
  await captureLogs(async () => {
    ctx.hooks.start();
    await withTimeout(ctx.hooks.idle(), 2000, "démarrage");
  });
  assert.deepEqual(attempts(), { redactions: [3, 3], checks: [3] });
  await captureLogs(async () => {
    ctx.t.fire();
    await withTimeout(ctx.hooks.idle(), 2000, "reprise horaire");
  });
  assert.deepEqual(attempts(), { redactions: [4, 4], checks: [4] });
  ctx.hooks.stop();
  assert.equal(HOUR, REDACTION_RETRY_MS);
});

test("avis ignoré (jetons acceptés) : le jeu de services créé pour la vérification est libéré", async () => {
  const ctx = await setup();
  ctx.shopifyRegistry.release(SHOP_A);
  const tokens = shopRow(ctx.store.db, SHOP_A)!.access_token;
  await captureLogs(async () => {
    await hook(ctx.app, "app/uninstalled", uninstallBody(SHOP_A, HOST_A));
    await ctx.hooks.idle();
  });
  assert.deepEqual(uninstallChecks(ctx.store.db), []);
  assert.equal(shopRow(ctx.store.db, SHOP_A)!.access_token, tokens);
  assert.equal(shopRow(ctx.store.db, SHOP_A)!.uninstalled_at, null);
  assert.equal(ctx.shopifyRegistry.peek(SHOP_A), null, "jeu de services resté en mémoire");
});

// ───────── Ajout après la quatrième revue QA

test("refus définitif constaté alors que la boutique a été utilisée depuis la demande → rien n'est effacé", async () => {
  const ctx = await setup();
  await captureLogs(async () => {
    // Demande d'effacement (rejouée ou tardive) sur une boutique installée, pendant que Shopify ne répond pas.
    ctx.multi.ctl.down.add(SHOP_A);
    await hook(ctx.app, "shop/redact", redactBody(SHOP_A));
    await ctx.hooks.idle();
    ctx.hooks.start();
    await ctx.hooks.idle();
    assert.equal(pending(ctx.store.db).length, 1);
    // Le marchand utilise l'application après la demande.
    await sleep(5);
    await ctx.app.request(`/api/sites/${ctx.A.site.id}`, withToken(SHOP_A));
    // Shopify revient et refuse définitivement le jeton (rotation dont la réponse s'était perdue).
    ctx.multi.ctl.down.delete(SHOP_A);
    ctx.ctl.refuse.add(SHOP_A);
    ctx.t.fire();
    await ctx.hooks.idle();
  });
  assert.equal(pending(ctx.store.db).length, 1, "la demande attend");
  assert.ok(Number(redactions(ctx.store.db)[0].attempts) >= 3, "la reprise horaire a bien eu lieu");
  assert.ok(ctx.store.getSite(ctx.A.site.id), "le site est intact");
});
