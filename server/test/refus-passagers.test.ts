/**
 * Refus passagers du site (429 « trop de demandes », 503) : la page est retentée après une pause, le parcours
 * ralentit, l'échec n'est compté qu'après le nombre maximal de tentatives ; le catalogue Shopify aussi.
 * Délais injectés (quelques millisecondes) : les tests restent rapides.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readShopifyCatalogue } from "../src/crawl/shopify.ts";
import { DEFAULT_RETRY, parseRetryAfter, Throttle } from "../src/crawl/throttle.ts";
import { setAllowPrivateHosts } from "../src/net/fetch.ts";
import { FAST_RETRY, post, testEnv } from "./helpers/env.ts";
import { shopCatalogue, startShopFixture, type RefusalPlan } from "./helpers/fixture-site.ts";

before(() => setAllowPrivateHosts(true));
after(() => setAllowPrivateHosts(false));

/** Premier produit du sitemap : chargé juste après l'accueil (le parcours équilibré commence par les produits). */
const FIRST_PRODUCT = `/products/${shopCatalogue()[0].handle}`;

async function shopAudit(o: { refuse?: RefusalPlan; catalogue?: "password" | "html" | "404"; maxPages?: number; retry?: typeof FAST_RETRY }) {
  const shop = await startShopFixture(0, { refuse: o.refuse, catalogue: o.catalogue });
  const env = testEnv({ delayMs: 0, cataloguePageSize: 8, retry: o.retry });
  const res = await env.app.request("/api/sites", post({ url: shop.origin, maxPages: o.maxPages ?? 12 }));
  if (res.status !== 201) await shop.close();
  assert.equal(res.status, 201);
  const { site } = (await res.json()) as any;
  const get = async (p: string) => (await env.app.request(`/api/sites/${site.id}${p}`)).json() as Promise<any>;
  return { shop, env, siteId: site.id as string, get };
}

const count = (list: string[], pred: (p: string) => boolean) => list.filter(pred).length;

// ───────── Règles du rythme adaptatif

test("Retry-After : secondes ou date HTTP ; absent ou illisible → null", () => {
  assert.equal(parseRetryAfter("7"), 7000);
  assert.equal(parseRetryAfter(" 0 "), 0);
  assert.equal(parseRetryAfter(new Date(10_000 + 5000).toUTCString(), 10_000), 5000);
  assert.equal(parseRetryAfter(undefined), null);
  assert.equal(parseRetryAfter("bientôt"), null);
});

test("rythme adaptatif : ralentit une fois par vague, pauses croissantes et plafonnées, budget d'attente borné", () => {
  let now = 0;
  const t = new Throttle({ ...DEFAULT_RETRY, budgetMs: 30_000 }, 3, 300, () => now);
  // Premier refus : un seul chargement à la fois, 1 s entre deux requêtes, pause de 5 s.
  const epoch0 = t.epoch;
  let d = t.onRefusal({ attempt: 0, retryAfterMs: null, startedEpoch: epoch0, pool: "pages" });
  assert.deepEqual(d, { retry: true, pauseMs: 5000 });
  assert.equal(t.concurrency, 1);
  assert.equal(t.delayMs, 1000);
  // Deux requêtes parties avant le ralentissement, refusées aussi : ni nouveau ralentissement, ni pause allongée.
  d = t.onRefusal({ attempt: 0, retryAfterMs: null, startedEpoch: epoch0, pool: "pages" });
  assert.equal(t.refusals, 1);
  assert.equal(t.pauseLeftMs(), 5000);
  // Nouvelle vague : pause doublée (10 s), délai doublé et plafonné (2 s).
  now = 6000;
  d = t.onRefusal({ attempt: 1, retryAfterMs: null, startedEpoch: t.epoch, pool: "pages" });
  assert.deepEqual(d, { retry: true, pauseMs: 10_000 });
  assert.equal(t.delayMs, 2000);
  // Retry-After respecté (plafonné à 30 s) ; au-delà, la page n'est pas retentée.
  now = 20_000;
  d = t.onRefusal({ attempt: 1, retryAfterMs: 3000, startedEpoch: t.epoch, pool: "pages" });
  assert.deepEqual(d, { retry: true, pauseMs: 3000 });
  d = t.onRefusal({ attempt: 0, retryAfterMs: 120_000, startedEpoch: t.epoch, pool: "pages" });
  assert.deepEqual(d, { retry: false, why: "retry_after_too_long" });
  // Nombre maximal de tentatives atteint.
  d = t.onRefusal({ attempt: 3, retryAfterMs: 0, startedEpoch: t.epoch, pool: "pages" });
  assert.deepEqual(d, { retry: false, why: "max_retries" });
  // Le budget (30 s ici) borne la somme des pauses : 5 + 10 + 3 + 12 (pause de 30 s tronquée) = 30.
  assert.equal(t.waitedMs("pages"), 30_000);
  assert.ok(t.exhausted("pages"));
  now = 100_000;
  d = t.onRefusal({ attempt: 0, retryAfterMs: null, startedEpoch: t.epoch, pool: "pages" });
  assert.deepEqual(d, { retry: false, why: "budget" });
  assert.equal(t.pauseLeftMs(), 0, "budget épuisé : plus de pause");
  // Le catalogue a son propre budget.
  d = t.onRefusal({ attempt: 0, retryAfterMs: null, startedEpoch: t.epoch, pool: "catalogue" });
  assert.equal(d.retry, true);
});

// ───────── Pages

test("page refusée deux fois (429) puis servie : notée, aucun échec, parcours ralenti", async () => {
  const { shop, env, get } = await shopAudit({ refuse: { paths: { [FIRST_PRODUCT]: 2 } } });
  try {
    await env.crawler.waitAll();
    const s = (await get("")).site;
    assert.equal(s.audit.state, "done");
    assert.equal(s.audit.pagesFailed, 0);
    assert.equal(s.audit.pagesDone, 12);
    assert.equal(count(shop.requests, (p) => p === FIRST_PRODUCT), 3, "deux refus, puis la page");
    const pages = (await get("/pages?limit=50")).pages;
    assert.ok(pages.some((p: any) => p.path === FIRST_PRODUCT));
    assert.deepEqual((await get("/failed-pages")).pages, []);
    const { coverage: c } = await get("/coverage");
    assert.equal(c.totals.failed, 0);
    assert.equal(c.totals.analyzed, 12);
  } finally {
    await shop.close();
  }
});

test("503 passager : même conduite que le 429", async () => {
  const { shop, env, get } = await shopAudit({ refuse: { paths: { [FIRST_PRODUCT]: 1 }, status: 503 } });
  try {
    await env.crawler.waitAll();
    const s = (await get("")).site;
    assert.equal(s.audit.pagesFailed, 0);
    assert.equal(count(shop.requests, (p) => p === FIRST_PRODUCT), 2);
  } finally {
    await shop.close();
  }
});

test("page toujours refusée : échec définitif après 3 nouvelles tentatives, raison explicite", async () => {
  const { shop, env, get } = await shopAudit({ refuse: { paths: { [FIRST_PRODUCT]: Infinity } } });
  try {
    await env.crawler.waitAll();
    const s = (await get("")).site;
    assert.equal(s.audit.state, "done");
    assert.equal(s.audit.pagesFailed, 1);
    assert.equal(s.audit.pagesDone, 11);
    assert.equal(count(shop.requests, (p) => p === FIRST_PRODUCT), 1 + FAST_RETRY.maxRetries);
    const failed = (await get("/failed-pages")).pages;
    assert.equal(failed.length, 1);
    assert.equal(failed[0].path, FIRST_PRODUCT);
    assert.equal(failed[0].httpStatus, 429);
    assert.equal(failed[0].reason, "Le site a refusé le chargement : trop de demandes (429), toujours refusé après 3 nouvelles tentatives");
  } finally {
    await shop.close();
  }
});

test("accueil refusé (à la création du site puis au début de l'analyse) : site accepté, accueil retenté, l'analyse continue", async () => {
  // Premier refus : la vérification faite à la création du site ; second : le premier chargement de l'analyse.
  const { shop, env, get } = await shopAudit({ refuse: { paths: { "/": 2 }, retryAfter: "0" } });
  try {
    await env.crawler.waitAll();
    const s = (await get("")).site;
    assert.equal(s.audit.state, "done");
    assert.equal(s.audit.pagesFailed, 0);
    assert.equal(s.audit.pagesDone, 12);
    assert.equal(count(shop.requests, (p) => p === "/"), 3);
  } finally {
    await shop.close();
  }
});

test("le site refuse tout au-delà du temps d'attente maximal : le parcours s'arrête au lieu de s'acharner", async () => {
  const retry = { ...FAST_RETRY, firstPauseMs: 20, maxPauseMs: 40, budgetMs: 50, maxRetries: 10 };
  const { shop, env, get } = await shopAudit({ refuse: { prefix: { start: "/products/", times: Infinity } }, maxPages: 30, retry });
  try {
    const t0 = Date.now();
    await env.crawler.waitAll();
    assert.ok(Date.now() - t0 < 3000);
    const s = (await get("")).site;
    assert.equal(s.audit.state, "done");
    assert.ok(s.audit.pagesFailed >= 1);
    // Quelques requêtes vers les produits, pas 30 × 11.
    assert.ok(count(shop.requests, (p) => p.startsWith("/products/")) <= 10, `${count(shop.requests, (p) => p.startsWith("/products/"))} requêtes`);
    const failed = (await get("/failed-pages")).pages;
    assert.ok(failed.every((f: any) => f.httpStatus === 429 && /temps d'attente maximal atteint/.test(f.reason)));
  } finally {
    await shop.close();
  }
});

test("pendant une pause : progression vraie (page en file, aucune adresse en cours), arrêt immédiat", async () => {
  const retry = { ...FAST_RETRY, firstPauseMs: 10_000, maxPauseMs: 10_000 };
  const { shop, env, siteId, get } = await shopAudit({ refuse: { paths: { [FIRST_PRODUCT]: Infinity } }, retry });
  try {
    const deadline = Date.now() + 3000;
    while (!shop.requests.includes(FIRST_PRODUCT) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    // Les chargements partis en même temps se terminent, puis la pause commence.
    await new Promise((r) => setTimeout(r, 300));
    const before = shop.requests.length;
    const a = (await get("")).site.audit;
    assert.equal(a.state, "running");
    assert.equal(a.currentUrl, null, "aucune page en cours de lecture pendant la pause");
    assert.ok(a.pagesQueued >= 1, "la page refusée est en file");
    const done = a.pagesDone;
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(shop.requests.length, before, "aucune requête pendant la pause");
    assert.equal((await get("")).site.audit.pagesDone, done);
    const t0 = Date.now();
    assert.ok(env.crawler.cancel(siteId));
    await env.crawler.wait(siteId);
    assert.ok(Date.now() - t0 < 500, "l'arrêt n'attend pas la fin de la pause");
    assert.equal((await get("")).site.audit.state, "cancelled");
  } finally {
    await shop.close();
  }
});

// ───────── Catalogue

test("catalogue refusé une fois (429 sans Retry-After) : lu après une pause, « read »", async () => {
  const { shop, env, get } = await shopAudit({ refuse: { paths: { "/products.json": 1 } } });
  try {
    await env.crawler.waitAll();
    const { coverage: c } = await get("/coverage");
    assert.equal(c.catalogue, "read");
    assert.equal(c.totals.viaCatalogue, 17);
    assert.deepEqual(
      shop.requests.filter((p) => p.startsWith("/products.json")),
      ["/products.json?limit=8&page=1", "/products.json?limit=8&page=1", "/products.json?limit=8&page=2", "/products.json?limit=8&page=3"],
    );
  } finally {
    await shop.close();
  }
});

test("catalogue toujours refusé : « unavailable » après les nouvelles tentatives", async () => {
  const { shop, env, get } = await shopAudit({ refuse: { paths: { "/products.json": Infinity } } });
  try {
    await env.crawler.waitAll();
    const { coverage: c } = await get("/coverage");
    assert.equal(c.catalogue, "unavailable");
    assert.equal(c.totals.viaCatalogue, 0);
    assert.equal(count(shop.requests, (p) => p.startsWith("/products.json")), 1 + FAST_RETRY.maxRetries);
  } finally {
    await shop.close();
  }
});

test("catalogue réellement illisible (404, page du mot de passe, HTML) : « unavailable » sans nouvelle tentative", async () => {
  for (const mode of ["404", "password", "html"] as const) {
    const { shop, env, get } = await shopAudit({ catalogue: mode });
    try {
      await env.crawler.waitAll();
      const { coverage: c } = await get("/coverage");
      assert.equal(c.catalogue, "unavailable", mode);
      assert.equal(count(shop.requests, (p) => p.startsWith("/products.json")), 1, mode);
    } finally {
      await shop.close();
    }
  }
});

test("lecture du catalogue seule : raison de l'échec distinguée (définitif ou passager)", async () => {
  const signal = new AbortController().signal;
  const throttle = () => new Throttle(FAST_RETRY, 1, 0);
  for (const [mode, reason] of [["404", "HTTP 404"], ["password", "redirection HTTP 302 vers la page du mot de passe"], ["html", "réponse qui n'est pas du JSON"]] as const) {
    const shop = await startShopFixture(0, { catalogue: mode });
    try {
      assert.deepEqual(await readShopifyCatalogue(shop.origin, { signal, throttle: throttle() }), { ok: false, reason, transient: false }, mode);
    } finally {
      await shop.close();
    }
  }
  const shop = await startShopFixture(0, { refuse: { paths: { "/products.json": Infinity }, retryAfter: "0" } });
  try {
    assert.deepEqual(await readShopifyCatalogue(shop.origin, { signal, throttle: throttle() }), { ok: false, reason: "HTTP 429", transient: true });
  } finally {
    await shop.close();
  }
  const ok = await startShopFixture(0, { refuse: { paths: { "/products.json": 2 }, retryAfter: "0" } });
  try {
    const r = await readShopifyCatalogue(ok.origin, { signal, throttle: throttle() });
    assert.ok(r.ok && r.complete && r.products.length === shopCatalogue().length);
  } finally {
    await ok.close();
  }
});
