/**
 * Mode intégré (SHOPIFY_APP_MODE=embedded) : jeton de session sur /api, échange et renouvellement du jeton d'accès,
 * en-têtes de sécurité, page de l'application. Faux Shopify injecté : aucun appel réseau réel.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ConfigError, loadConfig, parseAppMode } from "../src/config.ts";
import { verifySessionToken } from "../src/shopify/session.ts";
import { FAKE_CREDS, SHOP_HOST, fakeShopify } from "./helpers/fake-shopify.ts";
import { post, readSse, testEnv } from "./helpers/env.ts";

const SHOP = FAKE_CREDS.storeDomain;
const RETRY = "x-shopify-retry-invalid-session-request";
const TOKEN_EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange";

const b64 = (s: string) => Buffer.from(s).toString("base64url");

function sign(claims: Record<string, unknown>, opts: { secret?: string; header?: Record<string, unknown> } = {}): string {
  const h = b64(JSON.stringify(opts.header ?? { alg: "HS256", typ: "JWT" }));
  const p = b64(JSON.stringify(claims));
  const s = createHmac("sha256", opts.secret ?? FAKE_CREDS.clientSecret).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${s}`;
}

function claims(over: Record<string, unknown> = {}): Record<string, unknown> {
  const t = Math.floor(Date.now() / 1000);
  return { iss: `https://${SHOP}/admin`, dest: `https://${SHOP}`, aud: FAKE_CREDS.clientId, sub: "42", exp: t + 60, nbf: t - 5, iat: t - 5, jti: "jti-1", sid: "sid-1", ...over };
}

const good = () => sign(claims());
const bearer = (token: string, init: RequestInit = {}): RequestInit => ({ ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` } });

const pair = (n: number) =>
  Response.json({ access_token: `acces-secret-${n}`, scope: "read_products,write_products", expires_in: 3600, refresh_token: `renouv-secret-${n}`, refresh_token_expires_in: 7776000 });

type Reply = (n: number, body: URLSearchParams) => Response | Promise<Response>;

/** Faux Shopify du mode intégré : échange et renouvellement scriptés, GraphQL confié au faux Shopify commun. */
function embeddedEnv(opts: { exchange?: Reply; refresh?: Reply; webDist?: string } = {}) {
  const fake = fakeShopify();
  const log = { exchange: 0, refresh: 0, bodies: [] as URLSearchParams[], graphqlTokens: [] as string[] };
  const ctl = { exchange: opts.exchange ?? ((n: number) => pair(n)), refresh: opts.refresh ?? ((n: number) => pair(100 + n)), revoked: new Set<string>() };
  const clock = { t: Date.now() };
  const impl = (async (url: string, init: RequestInit) => {
    assert.ok(url.startsWith(`https://${SHOP}/`), "adresse inattendue");
    if (url.endsWith("/admin/oauth/access_token")) {
      const b = new URLSearchParams(String(init.body));
      log.bodies.push(b);
      if (b.get("grant_type") === TOKEN_EXCHANGE) return ctl.exchange(++log.exchange, b);
      if (b.get("grant_type") === "refresh_token") return ctl.refresh(++log.refresh, b);
      throw new Error("demande de jeton inattendue : " + b.get("grant_type"));
    }
    const token = (init.headers as Record<string, string>)["x-shopify-access-token"];
    log.graphqlTokens.push(token);
    if (ctl.revoked.has(token)) return new Response("révoqué", { status: 401 });
    return fake.impl(url, init);
  }) as unknown as typeof fetch;
  const env = testEnv({ shopify: { fetchImpl: impl, embedded: true, now: () => clock.t, webDist: opts.webDist } });
  // Lot B : le site appartient à la boutique d'essai (sinon il répond 404 à ses requêtes).
  const site = env.store.insertSite(`https://${SHOP_HOST}/`, SHOP_HOST, "Boutique Essai", SHOP);
  return { ...env, log, ctl, clock, site, fake };
}

async function expect401(res: Response) {
  assert.equal(res.status, 401);
  assert.equal(res.headers.get(RETRY), "1");
  const body = (await res.json()) as any;
  assert.equal(body.error.code, "unauthorized");
  return body;
}

// ───────── Vérification du jeton (fonction pure)

test("verifySessionToken : jeton valide → boutique de dest", () => {
  const r = verifySessionToken(good(), { secret: FAKE_CREDS.clientSecret, clientId: FAKE_CREDS.clientId });
  assert.deepEqual(r, { ok: true, shop: SHOP });
});

test("verifySessionToken : formes et types refusés", () => {
  const v = (t: string) => verifySessionToken(t, { secret: FAKE_CREDS.clientSecret, clientId: FAKE_CREDS.clientId }).ok;
  const [h, p, s] = good().split(".");
  assert.equal(v(`${h}.${p}`), false, "2 segments");
  assert.equal(v(`${h}.${p}.${s}.${s}`), false, "4 segments");
  assert.equal(v(""), false);
  // JSON invalide, signé correctement.
  const badJson = b64("{pas du json");
  const sig = createHmac("sha256", FAKE_CREDS.clientSecret).update(`${h}.${badJson}`).digest("base64url");
  assert.equal(v(`${h}.${badJson}.${sig}`), false, "JSON invalide");
  assert.equal(v(sign(claims({ exp: String(Math.floor(Date.now() / 1000) + 60) }))), false, "exp texte");
  assert.equal(v(sign(claims({ nbf: null }))), false, "nbf non numérique");
  assert.equal(v(sign(claims({ aud: [FAKE_CREDS.clientId] }))), false, "aud tableau");
  assert.equal(v(sign(claims({ aud: 1 }))), false, "aud nombre");
  assert.equal(v(sign(claims(), { header: { alg: "HS512" } })), false, "HS512");
  assert.equal(v(sign(claims(), { header: { alg: "hs256" } })), false, "casse");
  assert.equal(v(sign(claims({ iss: `http://${SHOP}/admin`, dest: `http://${SHOP}` }))), false, "http");
  assert.equal(v(sign(claims({ iss: `https://${SHOP}:444/admin`, dest: `https://${SHOP}:444` }))), false, "port");
});

test("verifySessionToken : tolérance d'horloge de 10 secondes", () => {
  const t = Math.floor(Date.now() / 1000);
  const v = (c: Record<string, unknown>) => verifySessionToken(sign(claims(c)), { secret: FAKE_CREDS.clientSecret, clientId: FAKE_CREDS.clientId }).ok;
  assert.equal(v({ exp: t - 5 }), true, "expiré depuis 5 s : toléré");
  assert.equal(v({ exp: t - 15 }), false);
  assert.equal(v({ nbf: t + 5 }), true, "nbf dans 5 s : toléré");
  assert.equal(v({ nbf: t + 15 }), false);
});

// ───────── Identification des requêtes /api

test("intégré : jeton valide accepté", async () => {
  const env = embeddedEnv();
  const res = await env.app.request("/api/health", bearer(good()));
  assert.equal(res.status, 200);
});

const refusals: Array<[string, () => string]> = [
  ["alg none", () => {
    const h = b64(JSON.stringify({ alg: "none", typ: "JWT" }));
    return `${h}.${b64(JSON.stringify(claims()))}.`;
  }],
  ["alg none signé", () => sign(claims(), { header: { alg: "none" } })],
  ["signature fausse", () => sign(claims(), { secret: "autre-secret" })],
  ["expiré", () => sign(claims({ exp: Math.floor(Date.now() / 1000) - 60 }))],
  ["nbf futur", () => sign(claims({ nbf: Math.floor(Date.now() / 1000) + 60 }))],
  ["aud faux", () => sign(claims({ aud: "AUTRE-APPLICATION" }))],
  ["iss différent de dest", () => sign(claims({ iss: "https://autre-boutique.myshopify.com/admin" }))],
  ["hôte non myshopify", () => sign(claims({ iss: "https://boutique-essai.example.com/admin", dest: "https://boutique-essai.example.com" }))],
  ["mal formé", () => "pas-un-jeton"],
];
for (const [name, make] of refusals) {
  test(`intégré : refus ${name} → 401 avec en-tête de relance`, async () => {
    const env = embeddedEnv();
    const body = await expect401(await env.app.request("/api/health", bearer(make())));
    assert.equal(env.log.exchange, 0, "aucun échange pour un jeton refusé");
    // Le message ne dit pas quelle vérification a échoué ni ne recopie le secret.
    assert.equal(body.error.message, "Votre session Shopify n'est pas valide ou a expiré.");
  });
}

test("intégré : en-tête absent, ou jeton dans l'adresse (id_token) → 401", async () => {
  const env = embeddedEnv();
  await expect401(await env.app.request("/api/health"));
  await expect401(await env.app.request(`/api/health?id_token=${good()}`));
  await expect401(await env.app.request("/api/health", { headers: { authorization: `Basic ${good()}` } }));
});

test("intégré (lot B) : jeton valide d'une autre boutique → servi, mais le site de la boutique d'essai lui répond 404", async () => {
  const env = embeddedEnv();
  const other = "https://autre-boutique.myshopify.com";
  const token = sign(claims({ iss: `${other}/admin`, dest: other }));
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    // Plusieurs boutiques servies : plus de 403 shop_not_allowed (réservé à la désinstallation, lot C).
    assert.equal((await env.app.request("/api/health", bearer(token))).status, 200);
    const res = await env.app.request(`/api/sites/${env.site.id}`, bearer(token));
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as any).error.code, "not_found");
  } finally {
    console.warn = warn;
  }
  // L'échange de l'autre boutique n'est jamais envoyé au domaine de la boutique d'essai.
  assert.equal(env.log.exchange, 0);
});

test("intégré : flux SSE, route inconnue et POST refusés sans jeton", async () => {
  const env = embeddedEnv();
  await expect401(await env.app.request(`/api/sites/${env.site.id}/events`));
  await expect401(await env.app.request("/api/route-inconnue"));
  await expect401(await env.app.request("/api/sites", post({ url: "https://exemple.fr" })));
  await expect401(await env.app.request("/api/sites"));
  // Avec un jeton, la route inconnue répond 404 et le flux s'ouvre.
  assert.equal((await env.app.request("/api/route-inconnue", bearer(good()))).status, 404);
  const sse = await env.app.request(`/api/sites/${env.site.id}/events`, bearer(good()));
  assert.equal(sse.status, 200);
  const evs = await readSse(sse, (e) => e.event === "site");
  assert.equal(evs[0].event, "site");
});

test("intégré : les gardes d'hôte et d'origine passent avant le jeton", async () => {
  const env = embeddedEnv();
  const res = await env.app.request("http://evil.example/api/health", bearer(good(), { headers: { host: "evil.example" } }));
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as any).error.code, "bad_request");
});

// ───────── En-têtes et page de l'application

function webDist(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "web-dist-embarque-"));
  mkdirSync(path.join(dir, "assets"));
  writeFileSync(path.join(dir, "index.html"), '<!doctype html><html><head><meta charset="utf-8"><script type="module" src="/assets/app.js"></script><title>Chat SEO</title></head><body></body></html>');
  writeFileSync(path.join(dir, "assets", "app.js"), "console.log(1)");
  return dir;
}

test("intégré : en-têtes de sécurité et index.html avec App Bridge en tête", async () => {
  const env = embeddedEnv({ webDist: webDist() });
  // Lot B : la boutique de frame-ancestors vient du paramètre shop de l'adresse.
  const res = await env.app.request(`/sites/abc?shop=${SHOP}`);
  const csp = res.headers.get("content-security-policy")!;
  assert.match(csp, /script-src 'self' https:\/\/cdn\.shopify\.com/);
  assert.match(csp, new RegExp(`frame-ancestors https://${SHOP.replace(/\./g, "\\.")} https://admin\\.shopify\\.com`));
  assert.doesNotMatch(csp, /frame-ancestors 'none'/);
  assert.equal(res.headers.get("x-frame-options"), null);
  const html = await res.text();
  const meta = `<meta name="shopify-api-key" content="${FAKE_CREDS.clientId}">`;
  const bridge = '<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>';
  assert.ok(html.startsWith(`<!doctype html><html><head>${meta}${bridge}`), html);
  assert.ok(html.indexOf(bridge) < html.indexOf('<script type="module"'));
  assert.ok(!html.includes(FAKE_CREDS.clientSecret));
  // Les en-têtes valent aussi pour /api (sans cadre permis).
  const api = await env.app.request("/api/health", bearer(good()));
  assert.equal(api.headers.get("x-frame-options"), null);
  assert.match(api.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
  // Les autres fichiers ne sont pas modifiés.
  assert.equal(await (await env.app.request("/assets/app.js")).text(), "console.log(1)");
});

test("local : rien ne change (aucun jeton exigé, aucun cadre, index.html intact)", async () => {
  const fake = fakeShopify();
  const env = testEnv({ shopify: { fetchImpl: fake.impl, webDist: webDist() } });
  const health = await env.app.request("/api/health");
  assert.equal(health.status, 200);
  assert.match(health.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
  assert.doesNotMatch(health.headers.get("content-security-policy")!, /cdn\.shopify\.com\/shopifycloud|script-src/);
  assert.equal(health.headers.get("x-frame-options"), "DENY");
  const html = await (await env.app.request("/")).text();
  assert.ok(!html.includes("shopify-api-key") && !html.includes("app-bridge"));
  // Un en-tête Authorization éventuel est ignoré.
  assert.equal((await env.app.request("/api/health", bearer("nimporte-quoi"))).status, 200);
});

// ───────── Échange du jeton de session

test("intégré : un seul échange pour des requêtes simultanées, avec les paramètres du contrat", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const env = embeddedEnv({
    exchange: async (n) => {
      await gate;
      return pair(n);
    },
  });
  const token = good();
  const reqs = Array.from({ length: 5 }, () => env.app.request("/api/health", bearer(token)));
  await new Promise((r) => setTimeout(r, 20));
  release();
  const res = await Promise.all(reqs);
  assert.deepEqual(res.map((r) => r.status), [200, 200, 200, 200, 200]);
  assert.equal(env.log.exchange, 1);
  const b = env.log.bodies[0];
  assert.equal(b.get("client_id"), FAKE_CREDS.clientId);
  assert.equal(b.get("client_secret"), FAKE_CREDS.clientSecret);
  assert.equal(b.get("subject_token"), token);
  assert.equal(b.get("subject_token_type"), "urn:ietf:params:oauth:token-type:id_token");
  assert.equal(b.get("requested_token_type"), "urn:shopify:params:oauth:token-type:offline-access-token");
  assert.equal(b.get("expiring"), "1");
  // Le jeton obtenu sert aux appels GraphQL.
  const state = (await (await env.app.request(`/api/sites/${env.site.id}/shopify`, bearer(good()))).json()) as any;
  assert.equal(state.connection.state, "connected");
  assert.deepEqual([...new Set(env.log.graphqlTokens)], ["acces-secret-1"]);
  assert.equal(env.log.exchange, 1, "pas de nouvel échange tant que le jeton d'accès est valide");
});

test("intégré : Shopify répond 400 à l'échange → 401 avec en-tête de relance, puis nouvel essai", async () => {
  const env = embeddedEnv({ exchange: (n) => (n === 1 ? Response.json({ error: "invalid_subject_token" }, { status: 400 }) : pair(n)) });
  const body = await expect401(await env.app.request("/api/health", bearer(good())));
  assert.ok(!JSON.stringify(body).includes(FAKE_CREDS.clientSecret));
  assert.equal((await env.app.request("/api/health", bearer(good()))).status, 200);
  assert.equal(env.log.exchange, 2);
});

test("intégré : échec passager de l'échange → route sans Shopify normale, route Shopify en shopify_unavailable", async () => {
  const env = embeddedEnv({ exchange: () => new Response("indisponible", { status: 503 }) });
  const warn = console.warn;
  const logs: string[] = [];
  console.warn = (...a: unknown[]) => void logs.push(a.join(" "));
  try {
    assert.equal((await env.app.request("/api/health", bearer(good()))).status, 200);
    const state = (await (await env.app.request(`/api/sites/${env.site.id}/shopify`, bearer(good()))).json()) as any;
    assert.equal(state.connection.state, "error");
    assert.equal(state.connection.error.code, "shopify_unavailable");
    assert.equal(state.connection.error.details.retryable, true);
  } finally {
    console.warn = warn;
  }
  const all = logs.join("\n");
  for (const secret of [FAKE_CREDS.clientSecret, SHOP, "acces-secret", "renouv-secret"]) assert.ok(!all.includes(secret), `journal sans ${secret}`);
});

test("intégré : sans jeton et sans requête identifiée → shopify_unavailable, réessayable, action du contrat", async () => {
  const env = embeddedEnv();
  const state = await env.shopify.state(env.site);
  assert.equal(state.connection.state, "error");
  assert.equal(state.connection.error!.code, "shopify_unavailable");
  assert.equal(state.connection.error!.details?.retryable, true);
  assert.equal(state.connection.error!.action, "Ouvrez l'application depuis votre administration Shopify.");
  assert.equal(env.log.exchange + env.log.refresh, 0);
  // La première requête identifiée rétablit l'accès sans attendre la fin du cache d'erreur.
  const after = (await (await env.app.request(`/api/sites/${env.site.id}/shopify`, bearer(good()))).json()) as any;
  assert.equal(after.connection.state, "connected");
});

// ───────── Renouvellement

test("intégré : renouvellement avant expiration, une seule demande, nouveau couple gardé", async () => {
  const env = embeddedEnv();
  assert.equal((await env.app.request(`/api/sites/${env.site.id}/shopify`, bearer(good()))).status, 200);
  env.clock.t += 56 * 60 * 1000; // moins de 5 minutes avant l'expiration (1 h)
  const reqs = await Promise.all([1, 2, 3].map(() => env.app.request(`/api/sites/${env.site.id}/shopify`, bearer(good()))));
  assert.ok(reqs.every((r) => r.status === 200));
  assert.equal(env.log.refresh, 1);
  assert.equal(env.log.exchange, 1, "pas de nouvel échange : le jeton de renouvellement suffit");
  const r = env.log.bodies.find((b) => b.get("grant_type") === "refresh_token")!;
  assert.equal(r.get("refresh_token"), "renouv-secret-1");
  assert.equal(r.get("client_id"), FAKE_CREDS.clientId);
  assert.equal(env.log.graphqlTokens.at(-1), "acces-secret-101");
  // Le renouvellement suivant utilise le nouveau jeton de renouvellement.
  env.clock.t += 56 * 60 * 1000;
  await env.app.request(`/api/sites/${env.site.id}/shopify`, bearer(good()));
  assert.equal(env.log.bodies.filter((b) => b.get("grant_type") === "refresh_token").at(-1)!.get("refresh_token"), "renouv-secret-101");
});

test("intégré : échec passager du renouvellement → jeton de renouvellement gardé et resservi", async () => {
  const env = embeddedEnv({ refresh: (n) => (n === 1 ? new Response("indisponible", { status: 503 }) : pair(100 + n)) });
  await env.app.request(`/api/sites/${env.site.id}/shopify`, bearer(good()));
  env.clock.t += 61 * 60 * 1000; // jeton d'accès expiré
  const s1 = (await (await env.app.request(`/api/sites/${env.site.id}/shopify`, bearer(good()))).json()) as any;
  assert.equal(s1.connection.state, "error");
  assert.equal(s1.connection.error.details.retryable, true);
  assert.equal(env.log.exchange, 1, "le jeton de renouvellement gardé évite un nouvel échange");
  env.clock.t += 11_000; // fin du cache d'erreur
  const s2 = (await (await env.app.request(`/api/sites/${env.site.id}/shopify`, bearer(good()))).json()) as any;
  assert.equal(s2.connection.state, "connected");
  const refreshes = env.log.bodies.filter((b) => b.get("grant_type") === "refresh_token");
  assert.deepEqual(refreshes.map((b) => b.get("refresh_token")), ["renouv-secret-1", "renouv-secret-1"]);
  assert.equal(env.log.exchange, 1);
});

test("intégré : 401 au renouvellement → tout est oublié, nouvel échange à la requête suivante", async () => {
  const env = embeddedEnv({ refresh: () => Response.json({ error: "invalid_request" }, { status: 401 }) });
  await env.app.request(`/api/sites/${env.site.id}/shopify`, bearer(good()));
  env.clock.t += 61 * 60 * 1000;
  // Tâche de fond (sans requête identifiée) : le renouvellement est refusé.
  const bg = await env.shopify.state(env.site);
  assert.equal(bg.connection.error!.code, "shopify_unavailable");
  assert.equal(bg.connection.error!.action, "Ouvrez l'application depuis votre administration Shopify.");
  assert.equal(env.log.refresh, 1);
  assert.ok(!JSON.stringify(bg).includes("renouv-secret") && !JSON.stringify(bg).includes(FAKE_CREDS.clientSecret));
  // Requête identifiée suivante : nouvel échange, et l'accès revient.
  const s = (await (await env.app.request(`/api/sites/${env.site.id}/shopify`, bearer(good()))).json()) as any;
  assert.equal(env.log.exchange, 2);
  assert.equal(s.connection.state, "connected");
  assert.equal(env.log.refresh, 1, "le jeton de renouvellement refusé n'est plus jamais envoyé");
});

test("intégré : 401 de GraphQL → renouvellement par le jeton de renouvellement, sans nouvel échange", async () => {
  const env = embeddedEnv();
  await env.app.request(`/api/sites/${env.site.id}/shopify`, bearer(good()));
  env.ctl.revoked.add("acces-secret-1");
  env.clock.t += 61_000; // fin du cache de connexion, jeton d'accès encore valide
  const s = (await (await env.app.request(`/api/sites/${env.site.id}/shopify`, bearer(good()))).json()) as any;
  assert.equal(s.connection.state, "connected");
  assert.equal(env.log.refresh, 1);
  assert.equal(env.log.exchange, 1);
  assert.equal(env.log.graphqlTokens.at(-1), "acces-secret-101");
});

test("intégré : aucun secret ni jeton dans les corps d'erreur", async () => {
  const env = embeddedEnv({ exchange: () => Response.json({ error: "x" }, { status: 400 }) });
  const token = good();
  const bodies = [
    await (await env.app.request("/api/health", bearer(token))).text(),
    await (await env.app.request("/api/health", bearer(sign(claims(), { secret: "faux" })))).text(),
    await (await env.app.request("/api/health")).text(),
  ];
  for (const b of bodies) {
    for (const secret of [FAKE_CREDS.clientSecret, token, SHOP]) assert.ok(!b.includes(secret), `corps sans ${secret.slice(0, 12)}`);
  }
});

// ───────── Configuration

test("config : SHOPIFY_APP_MODE inconnu ou variable manquante en mode intégré → refus de démarrer, sans valeur", () => {
  assert.equal(parseAppMode(undefined), "local");
  assert.equal(parseAppMode(""), "local");
  assert.equal(parseAppMode("local"), "local");
  assert.equal(parseAppMode("embedded"), "embedded");
  assert.throws(() => loadConfig({ env: { SHOPIFY_APP_MODE: "Embedded-xyz" } }), (e: unknown) => e instanceof ConfigError && !e.message.includes("Embedded-xyz"));
  // Lot B : SHOPIFY_STORE_DOMAIN n'est plus exigée (ignorée) ; TOKEN_ENCRYPTION_KEY l'est.
  const KEY = Buffer.alloc(32, 3).toString("base64");
  const full = { SHOPIFY_APP_MODE: "embedded", SHOPIFY_CLIENT_ID: "ID-123", SHOPIFY_CLIENT_SECRET: "SECRET-456", TOKEN_ENCRYPTION_KEY: KEY };
  assert.equal(loadConfig({ env: full }).shopifyAppMode, "embedded");
  for (const name of ["SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET", "TOKEN_ENCRYPTION_KEY"] as const) {
    const env = { ...full, [name]: "" };
    assert.throws(
      () => loadConfig({ env }),
      (e: unknown) => e instanceof ConfigError && e.message.includes(name) && !/ID-123|SECRET-456|myshopify/.test(e.message) && !e.message.includes(KEY),
    );
  }
  assert.equal(loadConfig({ env: { ...full, SHOPIFY_STORE_DOMAIN: "exemple.fr" } }).shopifyAppMode, "embedded", "SHOPIFY_STORE_DOMAIN ignorée");
  // Mode local : les variables restent facultatives.
  assert.equal(loadConfig({ env: {} }).shopifyAppMode, "local");
  assert.equal(loadConfig({ env: {} }).shopify, null);
});

// ───────── Ajouts après la revue QA du lot A ─────────

test("intégré : après un échange échoué (503), aucun nouvel échange pendant 30 secondes", async () => {
  const env = embeddedEnv({ exchange: (n) => (n === 1 ? new Response("indisponible", { status: 503 }) : pair(n)) });
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    for (let i = 0; i < 3; i++) assert.equal((await env.app.request("/api/health", bearer(good()))).status, 200);
    assert.equal(env.log.exchange, 1, "les requêtes suivantes ne refont pas d'échange");
    env.clock.t += 31_000;
    assert.equal((await env.app.request("/api/health", bearer(good()))).status, 200);
    assert.equal(env.log.exchange, 2);
  } finally {
    console.warn = warn;
  }
});

test("intégré : échange refusé en 401 par Shopify → la requête continue, pas de boucle d'échanges", async () => {
  const env = embeddedEnv({ exchange: () => new Response("refus", { status: 401 }) });
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    assert.equal((await env.app.request("/api/health", bearer(good()))).status, 200);
    assert.equal((await env.app.request("/api/health", bearer(good()))).status, 200);
    assert.equal(env.log.exchange, 1);
  } finally {
    console.warn = warn;
  }
});

test("intégré : renouvellement mal formé alors que le jeton d'accès est encore valide → il sert encore", async () => {
  const env = embeddedEnv({ refresh: () => Response.json({ access_token: "incomplet" }) });
  await env.app.request(`/api/sites/${env.site.id}/shopify`, bearer(good()));
  env.clock.t += 57 * 60 * 1000 + 11_000; // dans la marge des 5 minutes, pas encore expiré
  const s = (await (await env.app.request(`/api/sites/${env.site.id}/shopify`, bearer(good()))).json()) as any;
  assert.equal(s.connection.state, "connected");
  assert.ok(env.log.refresh >= 1);
});

test("intégré : HEAD, OPTIONS et /api sans barre finale refusés sans jeton", async () => {
  const env = embeddedEnv();
  assert.equal((await env.app.request("/api/health", { method: "HEAD" })).status, 401);
  assert.equal((await env.app.request("/api/health", { method: "OPTIONS" })).status, 401);
  assert.equal((await env.app.request("/api")).status, 401);
});

test("verifySessionToken : iss/dest en http, champ crit et signature non canonique refusés", () => {
  const v = (t: string) => verifySessionToken(t, { secret: FAKE_CREDS.clientSecret, clientId: FAKE_CREDS.clientId }).ok;
  assert.equal(v(sign(claims({ iss: `http://${SHOP}/admin`, dest: `http://${SHOP}` }))), false);
  assert.equal(v(sign(claims(), { header: { alg: "HS256", typ: "JWT", crit: ["x"] } })), false);
  const t = good();
  const last = t.slice(-1);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  // Variantes du dernier caractère qui décodent vers les mêmes octets : aucune n'est acceptée.
  const variants = [...alphabet].filter((c) => c !== last && Buffer.from(t.split(".")[2].slice(0, -1) + c, "base64url").equals(Buffer.from(t.split(".")[2], "base64url")));
  assert.ok(variants.length > 0);
  for (const c of variants) assert.equal(v(t.slice(0, -1) + c), false);
  assert.equal(v(t), true);
});
