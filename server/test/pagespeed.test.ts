/**
 * Vitesse des pages (PageSpeed Insights) : tâche de fond, mobile puis ordinateur, terrain page / site / absent,
 * page en échec, arrêt, une mesure à la fois, limite horaire, pages hors site refusées, clé jamais divulguée.
 * Faux PageSpeed (fetch simulé) : aucun appel réseau réel.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { plainText, toMeasure } from "../src/google/pagespeed.ts";
import { runTool } from "../src/chat/tools.ts";
import { urlKey } from "../src/crawl/url.ts";
import { insertDoneAudit } from "./helpers/boutique.ts";
import { post, postEmpty, testEnv } from "./helpers/env.ts";

const HOST = "atelier-lune.example";
const KEY = "AIzaTEST-cle-pagespeed-SECRETE-0123456789";

type FieldMode = "page" | "site" | "fallback" | "none";

/** Réponse PageSpeed Insights réduite, à la forme de l'API v5. */
function psi(score: number, field: FieldMode = "page") {
  const exp = (fast: boolean) => ({
    id: "x",
    metrics: {
      LARGEST_CONTENTFUL_PAINT_MS: { percentile: fast ? 1800 : 4200, category: fast ? "FAST" : "SLOW" },
      INTERACTION_TO_NEXT_PAINT: { percentile: 250, category: "AVERAGE" },
      CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 5, category: "FAST" },
      FIRST_CONTENTFUL_PAINT_MS: { percentile: 900, category: "FAST" },
    },
    overall_category: "AVERAGE",
  });
  return {
    id: "https://x/",
    ...(field === "page" ? { loadingExperience: exp(true), originLoadingExperience: exp(false) } : {}),
    ...(field === "site" ? { loadingExperience: { id: "x", initial_url: "x" }, originLoadingExperience: exp(false) } : {}),
    ...(field === "fallback" ? { loadingExperience: { ...exp(false), origin_fallback: true }, originLoadingExperience: exp(false) } : {}),
    lighthouseResult: {
      categories: { performance: { score } },
      audits: {
        "largest-contentful-paint": { score: 0.42, numericValue: 4123.6, scoreDisplayMode: "numeric" },
        "cumulative-layout-shift": { score: 0.95, numericValue: 0.04321, scoreDisplayMode: "numeric" },
        "total-blocking-time": { score: 0.6, numericValue: 310.2, scoreDisplayMode: "numeric" },
        "first-contentful-paint": { score: 0.91, numericValue: 1500, scoreDisplayMode: "numeric" },
        "render-blocking-resources": {
          score: 0.3, scoreDisplayMode: "metricSavings", title: "Éliminez les `ressources` bloquantes",
          description: "Les ressources bloquent le premier affichage. [En savoir plus](https://developer.chrome.com/x).",
          details: { type: "opportunity", overallSavingsMs: 870.4 },
        },
        "unused-javascript": { score: 0.5, scoreDisplayMode: "metricSavings", title: "Réduisez le JavaScript inutilisé", description: "Texte.", details: { type: "opportunity", overallSavingsMs: 1200 } },
        "uses-text-compression": { score: 1, scoreDisplayMode: "metricSavings", title: "Déjà correct", details: { type: "opportunity", overallSavingsMs: 0 } },
        "long-tasks": { score: null, scoreDisplayMode: "informative", title: "Tâches longues", details: { type: "table" } },
        "font-display-insight": { score: 0, scoreDisplayMode: "metricSavings", title: "Affichage des polices", metricSavings: { FCP: 50, LCP: 0, CLS: 0.2 } },
      },
    },
  };
}

interface FakeOpts {
  /** Réponse par chemin de page : nombre (score), "fail" (500), "bad" (400 page non chargée), "hang" (ne répond jamais). */
  pages?: Record<string, number | "fail" | "bad" | "hang" | "keyInvalid" | "throw" | "mobileFail" | "big">;
  field?: Record<string, FieldMode>;
}

function fakePsi(o: FakeOpts = {}) {
  const calls: Array<{ url: string; page: string; strategy: string; key: string | undefined; full: string }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    assert.equal(u.origin + u.pathname, "https://www.googleapis.com/pagespeedonline/v5/runPagespeed");
    assert.equal(init.redirect, "error");
    const page = u.searchParams.get("url")!;
    const p = new URL(page).pathname;
    calls.push({ url, page, strategy: u.searchParams.get("strategy")!, key: (init.headers as Record<string, string>)["x-goog-api-key"], full: url });
    assert.equal(u.searchParams.get("category"), "performance");
    assert.equal(u.searchParams.get("locale"), "fr");
    const mode = o.pages?.[p] ?? 80;
    if (mode === "hang") {
      return new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error(`aborted ${url} key=${KEY}`))));
    }
    if (mode === "mobileFail" && u.searchParams.get("strategy") === "mobile") return Response.json({ error: { code: 500 } }, { status: 500 });
    if (mode === "big") {
      // Réponse sans fin annoncée, plus grosse que la borne : 1 Mio par morceau.
      const piece = new Uint8Array(1024 * 1024).fill(0x20);
      bigPulled.n = 0;
      return new Response(new ReadableStream<Uint8Array>({ pull: (c) => (bigPulled.n++ < 64 ? c.enqueue(piece) : c.close()) }));
    }
    if (mode === "throw") throw new TypeError(`fetch failed for ${url}&key=${KEY}`);
    if (mode === "fail") return Response.json({ error: { code: 500, message: `Lighthouse error for ${page} key=${KEY}` } }, { status: 500 });
    if (mode === "bad") return Response.json({ error: { code: 400, message: `Lighthouse returned error: FAILED_DOCUMENT_REQUEST ${KEY}`, status: "INVALID_ARGUMENT" } }, { status: 400 });
    if (mode === "keyInvalid") return Response.json({ error: { code: 400, message: `API key not valid ${KEY}`, status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] } }, { status: 400 });
    const n = typeof mode === "number" ? mode : 80;
    const score = u.searchParams.get("strategy") === "desktop" ? Math.min(1, n / 100 + 0.15) : n / 100;
    return Response.json(psi(score, o.field?.[p] ?? "page"));
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const bigPulled = { n: 0 };
const PATHS = ["/", "/products/bague-or", "/products/collier", "/collections/bagues", "/blogs/news/entretien", "/pages/contact"];

function env(o: FakeOpts & { apiKey?: string | null; timeoutMs?: number; now?: () => number } = {}) {
  const fake = fakePsi(o);
  const e = testEnv({ pagespeed: { apiKey: o.apiKey === undefined ? KEY : o.apiKey, fetchImpl: fake.impl, timeoutMs: o.timeoutMs, now: o.now } });
  const site = e.store.insertSite(`https://${HOST}/`, HOST, null);
  const { ids, audit } = insertDoneAudit(e.store, site.id, HOST, PATHS);
  return { ...e, fake, site, ids, audit, base: `/api/sites/${site.id}` };
}

/** Capture les journaux pendant `fn`. */
async function captureLogs(fn: () => Promise<void>): Promise<string> {
  const out: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(orig) as Array<keyof typeof orig>) console[k] = (...a: unknown[]) => out.push(a.map(String).join(" "));
  try {
    await fn();
  } finally {
    Object.assign(console, orig);
  }
  return out.join("\n");
}

test("mesure par défaut : accueil puis une page par type, mobile puis ordinateur, avancement réel et événements", async () => {
  const e = env({ pages: { "/": 92, "/products/bague-or": 35, "/collections/bagues": 60 }, field: { "/products/bague-or": "site", "/collections/bagues": "fallback", "/blogs/news/entretien": "none" } });
  // Visites Search Console : le collier est le produit le plus visité.
  e.store.setGsc(e.site.id, { period: { start: "2026-10-01", end: "2026-10-28" }, series: null, queries: null, pages: [{ url: `https://${HOST}/products/collier`, clicks: 9, impressions: 90, ctr: 0.1, position: 3 }], seriesPosition: null, files: [] } as any);
  const events: string[] = [];
  e.hub.subscribe(e.site.id, (ev) => events.push(ev.type));
  const res = await e.app.request(`${e.base}/pagespeed`, postEmpty());
  assert.equal(res.status, 202);
  const started = (await res.json()) as any;
  assert.equal(started.configured, true);
  assert.deepEqual(started.running, { done: 0, total: 5, currentUrl: `https://${HOST}/` }, "la première page est déjà en cours");
  await e.pagespeed.wait(e.site.id);
  // Départ, puis pour chaque page « en cours » et « terminée », puis fin.
  assert.equal(events.filter((x) => x === "pagespeed").length, 1 + 5 * 2 + 1);
  // Pages choisies : l'accueil, puis par type la plus visitée (collier), à défaut la première analysée.
  const measured = [...new Set(e.fake.calls.map((c) => new URL(c.page).pathname))];
  assert.deepEqual(measured, ["/", "/products/collier", "/collections/bagues", "/blogs/news/entretien", "/pages/contact"]);
  assert.deepEqual(e.fake.calls.slice(0, 2).map((c) => c.strategy), ["mobile", "desktop"]);
  // La clé part dans l'en-tête, jamais dans l'adresse ; l'adresse mesurée est celle de la base.
  assert.ok(e.fake.calls.every((c) => c.key === KEY && !c.full.includes(KEY) && !c.full.includes("key=")));
  assert.equal(e.fake.calls[0].page, `https://${HOST}/`);

  const state = (await (await e.app.request(`${e.base}/pagespeed`)).json()) as any;
  assert.equal(state.running, null);
  assert.equal(state.lastError, null);
  assert.equal(state.pages.length, 5);
  assert.deepEqual(state.pages.map((p: any) => p.mobile.score), [60, 80, 80, 80, 92], "la plus lente sur mobile d'abord");
  const home = state.pages.find((p: any) => p.path === "/");
  assert.equal(home.pageId, e.ids["/"]);
  assert.equal(home.pageType, "home");
  assert.equal(home.mobile.score, 92);
  assert.equal(home.desktop.score, 100);
  // Laboratoire : verdicts de Google (score de l'audit).
  assert.deepEqual(home.mobile.lab, { lcp: { value: 4124, rating: "poor" }, cls: { value: 0.043, rating: "good" }, tbt: { value: 310, rating: "average" }, fcp: { value: 1500, rating: "good" } });
  // Terrain : page ; site (seule l'origine) ; site (repli de Google sur l'origine) ; absent.
  assert.deepEqual(home.mobile.field, { scope: "page", lcp: { value: 1800, rating: "good" }, inp: { value: 250, rating: "average" }, cls: { value: 0.05, rating: "good" } });
  assert.equal(state.pages.find((p: any) => p.path === "/collections/bagues").mobile.field.scope, "site");
  assert.equal(state.pages.find((p: any) => p.path === "/collections/bagues").mobile.field.lcp.rating, "poor");
  assert.equal(state.pages.find((p: any) => p.path === "/blogs/news/entretien").mobile.field, null);
  // Améliorations : textes de Google en texte brut, triées par gain, sans les audits réussis ni informatifs.
  assert.deepEqual(home.mobile.opportunities, [
    { title: "Réduisez le JavaScript inutilisé", detail: "Texte.", savingsMs: 1200 },
    { title: "Éliminez les ressources bloquantes", detail: "Les ressources bloquent le premier affichage. En savoir plus.", savingsMs: 870 },
    { title: "Affichage des polices", detail: null, savingsMs: 50 },
  ]);
  // PageDetail.speed ; null pour une page jamais mesurée.
  const pd = ((await (await e.app.request(`${e.base}/pages/${e.ids["/"]}`)).json()) as any).page;
  assert.equal(pd.speed.mobile.score, 92);
  assert.equal(pd.speed.desktop.score, 100);
  const never = ((await (await e.app.request(`${e.base}/pages/${e.ids["/products/bague-or"]}`)).json()) as any).page;
  assert.equal(never.speed, null);
  assert.equal(((await (await e.app.request("/api/settings")).json()) as any).integrations.pageSpeed.configured, true);
});

test("terrain : site seulement quand loadingExperience est vide, page sinon, absent sans données", () => {
  assert.equal(toMeasure(psi(0.5, "page"), "t").field!.scope, "page");
  assert.equal(toMeasure(psi(0.5, "site"), "t").field!.scope, "site");
  assert.equal(toMeasure(psi(0.5, "fallback"), "t").field!.scope, "site");
  assert.equal(toMeasure(psi(0.5, "none"), "t").field, null);
  // Liens et code Markdown retirés ; les chevrons restent (texte affiché échappé, jamais interprété).
  assert.equal(plainText("Voir [la doc](https://x.example/a) et `code` <b>gras</b>", 100), "Voir la doc et code <b>gras</b>");
  assert.equal(
    plainText("Les balises `<script>` et `<link rel=preload>` bloquent le premier affichage.", 200),
    "Les balises <script> et <link rel=preload> bloquent le premier affichage.",
  );
  assert.equal(plainText("a".repeat(50), 10), "aaaaaaaaa…");
  assert.throws(() => toMeasure({ lighthouseResult: { categories: { performance: { score: null } } } }, "t"), /pas pu charger/);
});

test("page en échec : listée dans failures (page, appareil, raison), les autres mesurées, lastError reste vide", async () => {
  const e = env({ pages: { "/products/bague-or": "fail", "/pages/contact": "bad" } });
  const res = await e.app.request(`${e.base}/pagespeed`, post({ pageIds: [e.ids["/"], e.ids["/products/bague-or"], e.ids["/pages/contact"]] }));
  assert.equal(res.status, 202);
  assert.deepEqual(((await res.json()) as any).failures, []);
  await e.pagespeed.wait(e.site.id);
  const state = (await (await e.app.request(`${e.base}/pagespeed`)).json()) as any;
  assert.deepEqual(state.pages.map((p: any) => p.path), ["/"]);
  assert.equal(state.lastError, null, "aucune erreur n'a arrêté la demande");
  assert.deepEqual(state.failures, [
    { path: "/products/bague-or", device: "mobile", message: "PageSpeed Insights a répondu 500." },
    { path: "/products/bague-or", device: "desktop", message: "PageSpeed Insights a répondu 500." },
    { path: "/pages/contact", device: "mobile", message: "Google n'a pas pu charger cette page pour la mesurer." },
    { path: "/pages/contact", device: "desktop", message: "Google n'a pas pu charger cette page pour la mesurer." },
  ]);
  assert.equal(e.fake.calls.length, 6, "chaque page tentée sur mobile et ordinateur");
  // Enregistré en base, comme le reste de l'état.
  const row = e.store.db.prepare("SELECT failures_json FROM pagespeed_status WHERE site_id = ?").get(e.site.id) as any;
  assert.equal(JSON.parse(row.failures_json).length, 4);
});

test("failures : une réussite après un échec ne l'efface pas (autre page, ou ordinateur après téléphone) ; remis à zéro à la demande suivante", async () => {
  const e = env({ pages: { "/products/bague-or": "fail", "/pages/contact": "mobileFail" } });
  await e.app.request(`${e.base}/pagespeed`, post({ pageIds: [e.ids["/products/bague-or"], e.ids["/"], e.ids["/pages/contact"]] }));
  await e.pagespeed.wait(e.site.id);
  const state = (await (await e.app.request(`${e.base}/pagespeed`)).json()) as any;
  assert.deepEqual(state.pages.map((p: any) => p.path).sort(), ["/", "/pages/contact"]);
  const contact = state.pages.find((p: any) => p.path === "/pages/contact");
  assert.equal(contact.mobile, null);
  assert.equal(contact.desktop.score, 95);
  assert.equal(state.lastError, null);
  assert.deepEqual(state.failures.map((f: any) => `${f.path} ${f.device}`), ["/products/bague-or mobile", "/products/bague-or desktop", "/pages/contact mobile"]);
  // Nouvelle demande : la liste repart de zéro dès le début (avant toute mesure), et une dernière erreur aussi.
  e.store.db.prepare("UPDATE pagespeed_status SET last_error_json = ? WHERE site_id = ?").run(JSON.stringify({ code: "pagespeed_unavailable", message: "x", action: null }), e.site.id);
  const again = (await (await e.app.request(`${e.base}/pagespeed`, post({ pageIds: [e.ids["/"]] }))).json()) as any;
  assert.deepEqual(again.failures, []);
  assert.equal(again.lastError, null);
  await e.pagespeed.wait(e.site.id);
  const after = (await (await e.app.request(`${e.base}/pagespeed`)).json()) as any;
  assert.deepEqual(after.failures, []);
  assert.equal(after.lastError, null);
});

test("réponse PageSpeed bornée à 24 Mio : lecture arrêtée, page listée dans failures", async () => {
  const e = env({ pages: { "/": "big" } });
  await e.app.request(`${e.base}/pagespeed`, post({ pageIds: [e.ids["/"], e.ids["/pages/contact"]] }));
  await e.pagespeed.wait(e.site.id);
  const state = (await (await e.app.request(`${e.base}/pagespeed`)).json()) as any;
  assert.ok(bigPulled.n <= 26, `lecture arrêtée vers 24 Mio (${bigPulled.n} Mio lus)`);
  assert.deepEqual(state.failures.map((f: any) => [f.path, f.device]), [["/", "mobile"], ["/", "desktop"]]);
  assert.match(state.failures[0].message, /trop volumineuse/);
  assert.deepEqual(state.pages.map((p: any) => p.path), ["/pages/contact"], "la page suivante est mesurée");
});

test("clé : absente de toute erreur, réponse et journal, même quand Google ou le réseau la renvoient ; clé refusée → arrêt", async () => {
  const e = env({ pages: { "/": "throw", "/products/bague-or": "fail", "/pages/contact": "bad" } });
  let bodies = "";
  const logs = await captureLogs(async () => {
    await e.app.request(`${e.base}/pagespeed`, post({ pageIds: [e.ids["/"], e.ids["/products/bague-or"], e.ids["/pages/contact"]] }));
    await e.pagespeed.wait(e.site.id);
    bodies += await (await e.app.request(`${e.base}/pagespeed`)).text();
    bodies += await (await e.app.request(`${e.base}/pages/${e.ids["/"]}`)).text();
    bodies += await (await e.app.request("/api/settings")).text();
  });
  assert.ok(e.fake.calls.length === 6);
  assert.ok(!bodies.includes(KEY) && !bodies.includes("AIza"), "aucune réponse ne contient la clé");
  assert.ok(!logs.includes(KEY) && !logs.includes("AIza"), "aucun journal ne contient la clé");
  assert.ok(!bodies.includes("Lighthouse") && !bodies.includes("fetch failed"), "aucun texte d'origine recopié");
  // Délai dépassé : erreur au message fixe.
  const slow = env({ pages: { "/": "hang" }, timeoutMs: 30 });
  await slow.app.request(`${slow.base}/pagespeed`, post({ pageIds: [slow.ids["/"]] }));
  await slow.pagespeed.wait(slow.site.id);
  const st = (await (await slow.app.request(`${slow.base}/pagespeed`)).json()) as any;
  assert.equal(st.lastError, null, "un délai dépassé sur une page n'arrête pas la demande");
  assert.deepEqual(st.failures, [{ path: "/", device: "mobile", message: "PageSpeed Insights n'a pas répondu à temps." }, { path: "/", device: "desktop", message: "PageSpeed Insights n'a pas répondu à temps." }]);
  assert.ok(!JSON.stringify(st).includes(KEY));
  // Clé refusée : la mesure s'arrête dès le premier refus.
  const bad = env({ pages: { "/": "keyInvalid" } });
  await bad.app.request(`${bad.base}/pagespeed`, post({ pageIds: [bad.ids["/"], bad.ids["/pages/contact"]] }));
  await bad.pagespeed.wait(bad.site.id);
  assert.equal(bad.fake.calls.length, 1);
  const b = (await (await bad.app.request(`${bad.base}/pagespeed`)).json()) as any;
  assert.match(b.lastError.message, /refuse la clé/);
  assert.equal(b.lastError.code, "pagespeed_unavailable");
  assert.deepEqual(b.failures, [], "une clé refusée arrête la demande : lastError, pas failures");
  assert.ok(!JSON.stringify(b).includes(KEY));
});

test("arrêt : la mesure en cours s'interrompt, les pages déjà mesurées restent ; une seule mesure à la fois", async () => {
  const e = env({ pages: { "/products/bague-or": "hang" } });
  const res = await e.app.request(`${e.base}/pagespeed`, post({ pageIds: [e.ids["/"], e.ids["/products/bague-or"], e.ids["/pages/contact"]] }));
  assert.equal(res.status, 202);
  // Attendre que la deuxième page soit en cours.
  for (let i = 0; i < 100 && !(e.pagespeed.state(e.site).running?.currentUrl ?? "").includes("bague-or"); i++) await new Promise((r) => setTimeout(r, 5));
  const running = (await (await e.app.request(`${e.base}/pagespeed`)).json()) as any;
  assert.deepEqual(running.running, { done: 1, total: 3, currentUrl: `https://${HOST}/products/bague-or` });
  const twice = await e.app.request(`${e.base}/pagespeed`, postEmpty());
  assert.equal(twice.status, 409);
  assert.equal(((await twice.json()) as any).error.code, "limit_reached");
  const cancelled = (await (await e.app.request(`${e.base}/pagespeed/cancel`, postEmpty())).json()) as any;
  assert.equal(cancelled.running, null);
  assert.deepEqual(cancelled.pages.map((p: any) => p.path), ["/"]);
  assert.equal(cancelled.lastError, null, "un arrêt n'est pas une erreur");
  assert.ok(!e.fake.calls.some((c) => c.page.endsWith("/pages/contact")), "les pages suivantes ne sont pas mesurées");
  // Arrêt sans mesure en cours : état inchangé.
  assert.equal((await e.app.request(`${e.base}/pagespeed/cancel`, postEmpty())).status, 200);
});

test("limite : 30 pages mesurées par heure et par site, retryAfterSeconds réel, pages non tentées rendues", async () => {
  let t = Date.parse("2026-11-27T10:00:00Z");
  const e = env({ now: () => t });
  const six = PATHS.map((p) => e.ids[p]);
  // 30 pages en 6 demandes d'une page puis 4 de six : « Mesurer cette page » reste utilisable bien au-delà de 5 fois.
  for (let i = 0; i < 6; i++) {
    assert.equal((await e.app.request(`${e.base}/pagespeed`, post({ pageIds: [e.ids["/"]] }))).status, 202, `demande ${i + 1}`);
    await e.pagespeed.wait(e.site.id);
  }
  t += 20 * 60_000;
  for (let i = 0; i < 4; i++) {
    assert.equal((await e.app.request(`${e.base}/pagespeed`, post({ pageIds: six }))).status, 202);
    await e.pagespeed.wait(e.site.id);
  }
  t += 10 * 60_000;
  const over = await e.app.request(`${e.base}/pagespeed`, post({ pageIds: [e.ids["/"]] }));
  assert.equal(over.status, 429);
  const err = ((await over.json()) as any).error;
  assert.equal(err.code, "rate_limited");
  assert.match(err.message, /30 pages mesurées par heure/);
  // Les 6 premières pages (t0) sortent de la fenêtre dans 30 minutes.
  assert.equal(err.details.retryAfterSeconds, 30 * 60);
  t += 30 * 60_000;
  assert.equal((await e.app.request(`${e.base}/pagespeed`, post({ pageIds: six }))).status, 202, "six pages libérées");
  await e.pagespeed.wait(e.site.id);
  const tooMany = ((await (await e.app.request(`${e.base}/pagespeed`, post({ pageIds: [e.ids["/"]] }))).json()) as any).error;
  assert.equal(tooMany.code, "rate_limited");

  // Demande arrêtée : seules les pages tentées comptent.
  let t2 = Date.parse("2026-11-27T10:00:00Z");
  const c = env({ now: () => t2, pages: { "/products/bague-or": "hang" } });
  const ids = PATHS.map((p) => c.ids[p]);
  for (let i = 0; i < 4; i++) {
    assert.equal((await c.app.request(`${c.base}/pagespeed`, post({ pageIds: [ids[0], ids[2], ids[3], ids[4], ids[5]] }))).status, 202);
    await c.pagespeed.wait(c.site.id);
  }
  // 4 × 5 = 20 pages ; la demande suivante (bague-or en 2e) est arrêtée après 2 pages tentées.
  await c.app.request(`${c.base}/pagespeed`, post({ pageIds: [ids[0], ids[1], ids[2], ids[3], ids[4], ids[5]] }));
  for (let i = 0; i < 200 && !(c.pagespeed.state(c.site).running?.currentUrl ?? "").includes("bague-or"); i++) await new Promise((r) => setTimeout(r, 5));
  await c.app.request(`${c.base}/pagespeed/cancel`, postEmpty());
  // 22 pages comptées (et non 26) : une demande de 5 passe encore (27), la suivante non (il en reste 3).
  assert.equal((await c.app.request(`${c.base}/pagespeed`, post({ pageIds: [ids[0], ids[2], ids[3], ids[4], ids[5]] }))).status, 202);
  await c.pagespeed.wait(c.site.id);
  const left = ((await (await c.app.request(`${c.base}/pagespeed`, post({ pageIds: ids.filter((_, i) => i !== 1) }))).json()) as any).error;
  assert.equal(left.code, "rate_limited");
  assert.match(left.message, /il en reste 3/);
  assert.match(left.action, /mesurez 3 pages au plus/);
});

test("pages refusées : hors du site, d'un autre site, inconnues, trop nombreuses ; non configuré ; sans analyse", async () => {
  const e = env();
  // Une page enregistrée sur un autre hôte (ne devrait jamais arriver) n'est pas mesurée.
  const evil = e.store.insertPage({
    audit_id: e.audit.id, site_id: e.site.id, url: "https://autre-site.example/piege", url_key: urlKey("https://autre-site.example/piege")!, path: "/piege",
    title: null, http_status: 200, score: 50, issues: 0, words: 0, analyzed_at: new Date().toISOString(), checks_json: "[]", facts_json: "{}", categories_json: "[]", page_type: null,
  });
  const offSite = await e.app.request(`${e.base}/pagespeed`, post({ pageIds: [evil.id] }));
  assert.equal(offSite.status, 400);
  assert.match(((await offSite.json()) as any).error.message, /pas sur l'adresse de ce site/);
  const other = e.store.insertSite("https://autre.example/", "autre.example", null);
  const { ids: otherIds } = insertDoneAudit(e.store, other.id, "autre.example", ["/"]);
  assert.equal((await e.app.request(`${e.base}/pagespeed`, post({ pageIds: [otherIds["/"]] }))).status, 400);
  assert.equal((await e.app.request(`${e.base}/pagespeed`, post({ pageIds: ["pg_inconnue"] }))).status, 400);
  assert.equal((await e.app.request(`${e.base}/pagespeed`, post({ pageIds: [] }))).status, 400);
  assert.equal((await e.app.request(`${e.base}/pagespeed`, post({ pageIds: Array.from({ length: 11 }, (_, i) => `pg_${i}`) }))).status, 400);
  assert.equal((await e.app.request(`${e.base}/pagespeed`, post({ url: "https://autre-site.example/" }))).status, 400, "aucune adresse acceptée du client");
  assert.equal(e.fake.calls.length, 0);
  // Le choix par défaut écarte aussi la page hors site.
  await e.app.request(`${e.base}/pagespeed`, postEmpty());
  await e.pagespeed.wait(e.site.id);
  assert.ok(e.fake.calls.every((c) => new URL(c.page).hostname === HOST));
  // Non configuré : 503, aucun appel.
  const off = env({ apiKey: null });
  const r = await off.app.request(`${off.base}/pagespeed`, postEmpty());
  assert.equal(r.status, 503);
  assert.equal(((await r.json()) as any).error.code, "pagespeed_not_configured");
  assert.equal(((await (await off.app.request(`${off.base}/pagespeed`)).json()) as any).configured, false);
  assert.equal(((await (await off.app.request("/api/settings")).json()) as any).integrations.pageSpeed.configured, false);
  // Sans analyse : no_audit.
  const bare = testEnv({ pagespeed: { apiKey: KEY, fetchImpl: fakePsi().impl } });
  const s = bare.store.insertSite("https://vide.example/", "vide.example", null);
  assert.equal(((await (await bare.app.request(`/api/sites/${s.id}/pagespeed`, postEmpty())).json()) as any).error.code, "no_audit");
});

test("site supprimé pendant une mesure : la mesure s'arrête sans erreur", async () => {
  const e = env({ pages: { "/": "hang" } });
  await e.app.request(`${e.base}/pagespeed`, post({ pageIds: [e.ids["/"]] }));
  const del = await e.app.request(e.base, { method: "DELETE", headers: { "content-type": "application/json" } });
  assert.equal(del.status, 204);
  assert.equal(e.pagespeed.isRunning(e.site.id), false);
});

test("assistant : outil de lecture de la vitesse, textes de Google marqués comme données non fiables", async () => {
  const e = env();
  assert.match(runTool(e.store, e.site, "vitesse_des_pages", {}).content, /"disponible":false/);
  await e.app.request(`${e.base}/pagespeed`, post({ pageIds: [e.ids["/"]] }));
  await e.pagespeed.wait(e.site.id);
  const data = JSON.parse(runTool(e.store, e.site, "vitesse_des_pages", {}).content);
  assert.equal(data.pages[0].telephone.score, 80);
  assert.ok(Array.isArray(data.pages[0].telephone.ameliorations_donnee_non_fiable));
  assert.match(data.note, /n'entre pas dans la note SEO/);
  const detail = JSON.parse(runTool(e.store, e.site, "detail_page", { page: "/" }).content);
  assert.equal(detail.vitesse.ordinateur.score, 95);
});

test("amélioration : overallSavingsMs à 0 mais gain positif dans metricSavings → gardée avec ce gain", () => {
  const r = psi(0.5) as any;
  r.lighthouseResult.audits["lcp-discovery-insight"] = {
    score: 0, scoreDisplayMode: "metricSavings", title: "Découverte de l'image principale", description: "Chargez `<img>` plus tôt.",
    details: { type: "opportunity", overallSavingsMs: 0 }, metricSavings: { LCP: 640, FCP: 0, CLS: 0 },
  };
  r.lighthouseResult.audits["vide"] = { score: 0, scoreDisplayMode: "metricSavings", title: "Sans gain", details: { type: "opportunity", overallSavingsMs: 0 }, metricSavings: { LCP: 0 } };
  const m = toMeasure(r, "t");
  const hit = m.opportunities.find((o) => o.title === "Découverte de l'image principale");
  assert.deepEqual(hit, { title: "Découverte de l'image principale", detail: "Chargez <img> plus tôt.", savingsMs: 640 });
  assert.ok(!m.opportunities.some((o) => o.title === "Sans gain"), "aucun gain : écartée");
});

test("mesure enregistrée corrompue : ignorée et journalisée sans contenu, le reste de l'état se lit", async () => {
  const e = env();
  await e.app.request(`${e.base}/pagespeed`, post({ pageIds: [e.ids["/"], e.ids["/pages/contact"]] }));
  await e.pagespeed.wait(e.site.id);
  const SECRET = "CONTENU-CORROMPU-A-NE-PAS-JOURNALISER";
  e.store.db.prepare("UPDATE pagespeed_pages SET mobile_json = ? WHERE site_id = ? AND path_key = '/'").run(`{"score": ${SECRET}`, e.site.id);
  e.store.db.prepare("UPDATE pagespeed_pages SET mobile_json = ?, desktop_json = ? WHERE site_id = ? AND path_key = '/pages/contact'").run(`[${SECRET}`, "null", e.site.id);
  e.store.db.prepare("UPDATE pagespeed_status SET failures_json = ? WHERE site_id = ?").run(`{${SECRET}`, e.site.id);
  let state: any;
  let page: any;
  let tool: any;
  const logs = await captureLogs(async () => {
    const res = await e.app.request(`${e.base}/pagespeed`);
    assert.equal(res.status, 200);
    state = await res.json();
    const pd = await e.app.request(`${e.base}/pages/${e.ids["/"]}`);
    assert.equal(pd.status, 200);
    page = ((await pd.json()) as any).page;
    tool = JSON.parse(runTool(e.store, e.site, "vitesse_des_pages", {}).content);
  });
  assert.deepEqual(state.pages.map((p: any) => p.path), ["/"], "la page sans aucune mesure lisible est écartée");
  assert.equal(state.pages[0].mobile, null);
  assert.equal(state.pages[0].desktop.score, 95);
  assert.deepEqual(state.failures, []);
  assert.equal(page.speed.mobile, null);
  assert.equal(page.speed.desktop.score, 95);
  assert.equal(tool.pages.length, 1);
  assert.equal(tool.pages[0].telephone, null);
  assert.match(logs, /illisible/);
  assert.ok(!logs.includes(SECRET), "le contenu de la ligne n'est pas journalisé");
});

test("assistant : vitesse — adresse marquée non fiable, terrain décrit comme 75e centile ; consigne cite les sources Google", async () => {
  const e = env();
  await e.app.request(`${e.base}/pagespeed`, post({ pageIds: [e.ids["/"]] }));
  await e.pagespeed.wait(e.site.id);
  const data = JSON.parse(runTool(e.store, e.site, "vitesse_des_pages", {}).content);
  assert.equal(data.pages[0].adresse_donnee_non_fiable, `https://${HOST}/`);
  assert.equal(data.pages[0].adresse, undefined);
  assert.match(data.note, /75e centile/);
  assert.doesNotMatch(data.note, /moyenne de tout le site/);
  const { systemPrompt } = await import("../src/chat/assistant.ts");
  assert.match(systemPrompt(e.site), /donnée non fiable/);
  assert.match(systemPrompt(e.site), /réponses de Google \(Search Console, Google Analytics, PageSpeed Insights\)/);
});
