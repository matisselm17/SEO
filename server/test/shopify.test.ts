import assert from "node:assert/strict";
import { test } from "node:test";
import { parseShopDomain, RENEW_MARGIN_MS, ShopifyAuth, ShopifyError, shopifyGraphql } from "../src/shopify/auth.ts";

const CREDS = { storeDomain: "boutique-essai.myshopify.com", clientId: "ID-PUBLIC", clientSecret: "SECRET-XYZ" };

/** Faux Shopify : compte les demandes de jeton et délivre jeton-1, jeton-2… valables `expiresIn` secondes. */
function fakeShopify(opts: { expiresIn?: number; tokenStatus?: number; reject?: Set<string>; delayMs?: number } = {}) {
  const calls = { token: 0, graphql: [] as string[], bodies: [] as string[] };
  const impl = (async (url: string, init: RequestInit) => {
    if (url.endsWith("/admin/oauth/access_token")) {
      calls.token++;
      calls.bodies.push(String(init.body));
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.tokenStatus) return new Response(JSON.stringify({ error: "invalid_client", client_id: CREDS.clientId }), { status: opts.tokenStatus });
      return Response.json({ access_token: `jeton-${calls.token}`, scope: "read_products,write_products", expires_in: opts.expiresIn ?? 86399 });
    }
    const token = (init.headers as Record<string, string>)["x-shopify-access-token"];
    calls.graphql.push(token);
    if (opts.reject?.has(token)) return new Response("{}", { status: 401 });
    return Response.json({ data: { shop: { name: "Essai" } } });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

test("domaine Shopify : seul un domaine myshopify.com est accepté", () => {
  assert.equal(parseShopDomain("https://Ma-Boutique.myshopify.com/"), "ma-boutique.myshopify.com");
  for (const bad of ["", "exemple.com", "ma-boutique.myshopify.com.evil.com", "evil.com/x.myshopify.com", "a b.myshopify.com", "localhost"]) {
    assert.equal(parseShopDomain(bad), null, bad);
  }
  assert.throws(() => new ShopifyAuth({ ...CREDS, storeDomain: "exemple.com" }));
});

test("jeton : demandé une fois, gardé en mémoire, avec ses permissions", async () => {
  const { calls, impl } = fakeShopify();
  const auth = new ShopifyAuth(CREDS, impl, () => 1_000_000);
  assert.equal(auth.info(), null);
  assert.equal(await auth.getToken(), "jeton-1");
  assert.equal(await auth.getToken(), "jeton-1");
  assert.equal(calls.token, 1);
  const body = new URLSearchParams(calls.bodies[0]);
  assert.equal(body.get("grant_type"), "client_credentials");
  assert.equal(body.get("client_id"), CREDS.clientId);
  assert.deepEqual(auth.info()!.scopes, ["read_products", "write_products"]);
  assert.equal(auth.info()!.expiresAt.getTime(), 1_000_000 + 86399 * 1000);
});

test("jeton : renouvelé tout seul quand il approche de son expiration", async () => {
  const { calls, impl } = fakeShopify({ expiresIn: 3600 });
  let now = 0;
  const auth = new ShopifyAuth(CREDS, impl, () => now);
  assert.equal(await auth.getToken(), "jeton-1");
  now = 3600 * 1000 - RENEW_MARGIN_MS - 1;
  assert.equal(await auth.getToken(), "jeton-1");
  now = 3600 * 1000 - RENEW_MARGIN_MS;
  assert.equal(await auth.getToken(), "jeton-2");
  assert.equal(calls.token, 2);
});

test("jeton : des appels simultanés partagent une seule demande", async () => {
  const { calls, impl } = fakeShopify({ delayMs: 20 });
  const auth = new ShopifyAuth(CREDS, impl);
  const tokens = await Promise.all([auth.getToken(), auth.getToken(), auth.getToken()]);
  assert.deepEqual(tokens, ["jeton-1", "jeton-1", "jeton-1"]);
  assert.equal(calls.token, 1);
});

test("jeton : un refus est signalé sans exposer l'identifiant ni le secret, et n'est pas mis en mémoire", async () => {
  const { calls, impl } = fakeShopify({ tokenStatus: 401 });
  const auth = new ShopifyAuth(CREDS, impl);
  const check = (e: unknown) => e instanceof ShopifyError && e.code === "auth_refused" && !e.message.includes(CREDS.clientSecret) && !e.message.includes(CREDS.clientId);
  await assert.rejects(auth.getToken(), check);
  await assert.rejects(auth.getToken(), check);
  assert.equal(calls.token, 2);
  assert.equal(auth.info(), null);
});

test("GraphQL : un refus 401 fait redemander un jeton et rejouer l'appel une fois", async () => {
  const { calls, impl } = fakeShopify({ reject: new Set(["jeton-1"]) });
  const auth = new ShopifyAuth(CREDS, impl);
  const data = await shopifyGraphql<{ shop: { name: string } }>(auth, "{ shop { name } }", undefined, impl);
  assert.equal(data.shop.name, "Essai");
  assert.deepEqual(calls.graphql, ["jeton-1", "jeton-2"]);
  assert.equal(calls.token, 2);
});

test("GraphQL : deux refus 401 de suite s'arrêtent sur une erreur claire, sans le jeton", async () => {
  const { calls, impl } = fakeShopify({ reject: new Set(["jeton-1", "jeton-2"]) });
  const auth = new ShopifyAuth(CREDS, impl);
  await assert.rejects(shopifyGraphql(auth, "{ shop { name } }", undefined, impl), (e: unknown) => e instanceof ShopifyError && e.code === "auth_refused" && !e.message.includes("jeton-"));
  assert.equal(calls.graphql.length, 2);
});

test("GraphQL : les erreurs de requête de Shopify sont remontées", async () => {
  const impl = (async (url: string) =>
    url.endsWith("access_token")
      ? Response.json({ access_token: "j", scope: "", expires_in: 100 })
      : Response.json({ errors: [{ message: "Access denied for themes field." }] })) as unknown as typeof fetch;
  await assert.rejects(shopifyGraphql(new ShopifyAuth(CREDS, impl), "{ x }", undefined, impl), (e: unknown) => e instanceof ShopifyError && e.code === "graphql" && e.message.includes("Access denied"));
});
