/**
 * Plusieurs boutiques en mode intégré, pour les tests : un faux Shopify par domaine, jetons de session signés, et
 * deux boutiques A et B préparées chacune avec son site, ses pages, ses éléments, une modification et un lot.
 * Le faux Shopify vérifie, à chaque appel, que le domaine appelé et le jeton utilisé vont ensemble.
 * Aucun appel réseau réel ; aucune analyse réelle (le parcours des sites est remplacé).
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { insertDoneAudit, PAGES } from "./boutique.ts";
import { post, testEnv } from "./env.ts";
import { defaultState, FAKE_CREDS, fakeShopify, type FakeState } from "./fake-shopify.ts";
import type { VerifierOptions } from "../../src/shopify/verification.ts";

export const SHOP_A = "boutique-a.myshopify.com";
export const SHOP_B = "boutique-b.myshopify.com";
export const HOST_A = "boutique-a.example";
export const HOST_B = "boutique-b.example";

const b64 = (s: string) => Buffer.from(s).toString("base64url");

/** Jeton de session Shopify valide pour `shop` (signé avec le secret de l'application d'essai). */
export function sessionToken(shop: string, over: Record<string, unknown> = {}): string {
  const t = Math.floor(Date.now() / 1000);
  const claims = { iss: `https://${shop}/admin`, dest: `https://${shop}`, aud: FAKE_CREDS.clientId, sub: "42", exp: t + 60, nbf: t - 5, iat: t - 5, jti: `jti-${Math.random()}`, sid: "sid-1", ...over };
  const h = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const p = b64(JSON.stringify(claims));
  const s = createHmac("sha256", FAKE_CREDS.clientSecret).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${s}`;
}

export const withToken = (shop: string, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${sessionToken(shop)}` },
});

/** État d'un faux Shopify : même catalogue que la boutique d'essai, identifiants décalés (`offset`), autre domaine. */
export function shopState(host: string, name: string, offset: number): FakeState {
  const st = JSON.parse(JSON.stringify(defaultState()).replace(/gid:\/\/shopify\/(\w+)\/(\d+)/g, (_m, t: string, n: string) => `gid://shopify/${t}/${Number(n) + offset}`)) as FakeState;
  st.shop = { name, host: `www.${host}` };
  return st;
}

const label = (domain: string) => domain.split(".")[0];

/** Faux Shopify à plusieurs boutiques : routage par domaine, jetons propres à chaque domaine. */
export function multiShopify(defs: Array<{ domain: string; state: FakeState }>) {
  const fakes = new Map(defs.map((d) => [d.domain, fakeShopify(d.state, { domain: d.domain })]));
  /** Jeton (accès ou renouvellement) → domaine qui l'a délivré. */
  const owner = new Map<string, string>();
  const log = {
    exchanges: new Map<string, number>(),
    refreshes: new Map<string, number>(),
    /** Appels GraphQL : domaine appelé et jeton utilisé. */
    graphql: [] as Array<{ domain: string; token: string }>,
    /** Toute incohérence domaine / jeton / jeton de session. Doit rester vide. */
    violations: [] as string[],
  };
  /** `delay` : attente avant de répondre à une demande de jeton de ce domaine (requêtes simultanées). */
  const ctl = { down: new Set<string>(), exchange: new Map<string, (n: number) => Response | Promise<Response>>(), delay: new Map<string, Promise<void>>() };
  const issued: string[] = [];
  const pair = (domain: string, n: number) => {
    const access = `acces-${label(domain)}-${n}`;
    const refresh = `renouv-${label(domain)}-${n}`;
    owner.set(access, domain);
    owner.set(refresh, domain);
    issued.push(access, refresh);
    return Response.json({ access_token: access, scope: defs.find((d) => d.domain === domain)!.state.scopes.join(","), expires_in: 3600, refresh_token: refresh, refresh_token_expires_in: 7776000 });
  };
  const inc = (m: Map<string, number>, k: string) => {
    const n = (m.get(k) ?? 0) + 1;
    m.set(k, n);
    return n;
  };
  const impl = (async (url: string, init: RequestInit) => {
    const domain = new URL(url).hostname;
    const fake = fakes.get(domain);
    if (!fake) {
      log.violations.push(`domaine inattendu`);
      throw new Error("adresse inattendue");
    }
    if (ctl.down.has(domain)) throw new TypeError("Shopify injoignable (simulé)");
    if (url.endsWith("/admin/oauth/access_token")) {
      await ctl.delay.get(domain);
      const b = new URLSearchParams(String(init.body));
      if (b.get("client_id") !== FAKE_CREDS.clientId || b.get("client_secret") !== FAKE_CREDS.clientSecret) log.violations.push("identifiants de l'application");
      if (b.get("grant_type") === "urn:ietf:params:oauth:grant-type:token-exchange") {
        const dest = JSON.parse(Buffer.from(String(b.get("subject_token")).split(".")[1], "base64url").toString()).dest;
        if (dest !== `https://${domain}`) log.violations.push(`jeton de session d'une autre boutique envoyé à ${label(domain)}`);
        const n = inc(log.exchanges, domain);
        const custom = ctl.exchange.get(domain);
        return custom ? custom(n) : pair(domain, n);
      }
      if (b.get("grant_type") === "refresh_token") {
        const n = inc(log.refreshes, domain);
        if (owner.get(String(b.get("refresh_token"))) !== domain) {
          log.violations.push(`jeton de renouvellement d'une autre boutique envoyé à ${label(domain)}`);
          return Response.json({ error: "invalid_request" }, { status: 401 });
        }
        return pair(domain, 100 + n);
      }
      log.violations.push("demande de jeton inattendue");
      throw new Error("demande de jeton inattendue");
    }
    const token = (init.headers as Record<string, string>)["x-shopify-access-token"];
    log.graphql.push({ domain, token });
    if (owner.get(token) !== domain) {
      log.violations.push(`jeton d'accès d'une autre boutique envoyé à ${label(domain)}`);
      return new Response("refusé", { status: 401 });
    }
    return fake.impl(url, init);
  }) as unknown as typeof fetch;
  const mutations = () => [...fakes.values()].reduce((n, f) => n + f.calls.mutations.length, 0);
  return { impl, fakes, log, ctl, issued, mutations };
}

export type Multi = ReturnType<typeof multiShopify>;

/** Application en mode intégré servant A et B ; le parcours des sites est remplacé (aucune analyse réelle). */
export function embeddedShops(opts: { multi?: Multi; dataDir?: string; encryptionKey?: Buffer; writesEnabled?: boolean; webhooks?: NonNullable<Parameters<typeof testEnv>[0]>["webhooks"]; sleep?: (ms: number) => Promise<void>; config?: NonNullable<Parameters<typeof testEnv>[0]>["config"]; chatClient?: NonNullable<Parameters<typeof testEnv>[0]>["chatClient"]; verification?: VerifierOptions; now?: () => number } = {}) {
  const multi = opts.multi ?? multiShopify([
    { domain: SHOP_A, state: shopState(HOST_A, "Boutique A", 0) },
    { domain: SHOP_B, state: shopState(HOST_B, "Boutique B", 500) },
  ]);
  const env = testEnv({ dataDir: opts.dataDir, webhooks: opts.webhooks, config: opts.config, chatClient: opts.chatClient, shopify: { fetchImpl: multi.impl, embedded: true, writesEnabled: opts.writesEnabled ?? true, encryptionKey: opts.encryptionKey, sleep: opts.sleep, verification: opts.verification, now: opts.now } });
  /** Analyses lancées (site par site) : remplace le parcours réel. */
  const started: string[] = [];
  env.crawler.start = async (s, audit) => {
    started.push(s.id);
    env.store.updateAudit(audit.id, { state: "done", finished_at: new Date().toISOString(), pages_done: 0, pages_queued: 0 });
  };
  return { ...env, multi, started };
}

const body = async (res: Response) => {
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as any) : null };
};

/** Prépare une boutique : site créé par GET /api/sites, analyse terminée, lecture de la boutique, une modification, un lot. */
async function prepare(env: ReturnType<typeof embeddedShops>, shop: string, host: string) {
  const sites = await body(await env.app.request("/api/sites", withToken(shop)));
  assert.equal(sites.status, 200, JSON.stringify(sites.body));
  assert.equal(sites.body.sites.length, 1);
  const site = env.store.getSite(sites.body.sites[0].id)!;
  assert.equal(site.host, host);
  const { ids } = insertDoneAudit(env.store, site.id, host, PAGES);
  const base = `/api/sites/${site.id}`;
  // La limite « une lecture complète de la boutique par minute » reste commune au serveur (contrat, lot D) : la
  // lecture passe ici directement par le service de la boutique.
  const synced = await env.shopifyRegistry.forShop(shop).shopify.sync(site);
  assert.equal(synced.connection.state, "connected");
  const list = await body(await env.app.request(`${base}/shopify/resources?limit=200`, withToken(shop)));
  const byPath: Record<string, any> = Object.fromEntries(list.body.resources.map((r: any) => [r.path, r]));
  const change = await body(await env.app.request(`${base}/shopify/changes`, withToken(shop, post({ resourceId: byPath["/pages/contact"].id, field: "seo_title", value: `Contact ${host}`, expectedBefore: null }))));
  assert.equal(change.status, 201, JSON.stringify(change.body));
  const batch = await body(await env.app.request(`${base}/shopify/batches`, withToken(shop, post({ title: "Lot", items: [{ resourceId: byPath["/products/collier"].id, field: "seo_title", value: `Collier ${host}` }] }))));
  assert.equal(batch.status, 201, JSON.stringify(batch.body));
  const issues = await body(await env.app.request(`${base}/issues`, withToken(shop)));
  assert.ok(issues.body.issues.length > 0);
  return {
    shop,
    host,
    site,
    base,
    pageIds: ids,
    byPath,
    resourceId: byPath["/products/bague-or"].id as string,
    changeId: change.body.change.id as string,
    batchId: batch.body.batch.id as string,
    itemId: batch.body.batch.items[0].id as string,
    issueId: issues.body.issues[0].id as string,
  };
}

/** Deux boutiques prêtes (A et B) dans la même application. */
export async function twoShops(opts: Parameters<typeof embeddedShops>[0] = {}) {
  const env = embeddedShops(opts);
  const A = await prepare(env, SHOP_A, HOST_A);
  const B = await prepare(env, SHOP_B, HOST_B);
  return { ...env, A, B };
}

/** Contenu de toutes les tables (pour vérifier que rien n'a été écrit). */
export function dumpDb(env: { store: { db: { prepare(sql: string): { all(): unknown[] } } } }): string {
  const tables = (env.store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((t) => t.name);
  return JSON.stringify(tables.map((t) => [t, env.store.db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all()]));
}
