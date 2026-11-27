import assert from "node:assert/strict";
import { test } from "node:test";
import { brandTokens, countryFor, FirecrawlSearch, FIRECRAWL_SEARCH_URL, isBrandQuery, pickQueries } from "../src/competitors/competitors.ts";
import { HttpError } from "../src/errors.ts";
import { EventHub } from "../src/events.ts";

test("Firecrawl : requête POST /v2/search, Bearer, lecture de data.web", async () => {
  let call: { url: string; init: RequestInit } | null = null;
  const fake = (async (url: string, init: RequestInit) => {
    call = { url, init };
    return new Response(JSON.stringify({ success: true, data: { web: [{ url: "https://a.example/x", title: "A", description: "d" }, { url: "javascript:x", title: "bad" }] } }), { status: 200 });
  }) as unknown as typeof fetch;
  const fc = new FirecrawlSearch("fc-KEY", fake);
  const res = await fc.search("poterie nantes", { country: "FR" });
  assert.deepEqual(res, [{ url: "https://a.example/x", title: "A" }]);
  assert.equal(call!.url, FIRECRAWL_SEARCH_URL);
  assert.equal((call!.init.headers as Record<string, string>).authorization, "Bearer fc-KEY");
  assert.deepEqual(JSON.parse(call!.init.body as string), { query: "poterie nantes", limit: 10, sources: ["web"], country: "FR" });
});

test("Firecrawl : erreurs traduites sans exposer la clé", async () => {
  const fake = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(new FirecrawlSearch("fc-SECRET", fake).search("x", { country: "FR" }), (e: unknown) => e instanceof HttpError && !e.message.includes("SECRET") && e.status === 502);
});

test("requêtes : hors marque d'abord (Search Console), sinon titres des pages principales", () => {
  const brands = brandTokens("atelier-lune.fr", "Atelier Lune");
  assert.ok(isBrandQuery("atelier lune horaires", brands));
  assert.ok(isBrandQuery("atelierlune", brands));
  assert.ok(!isBrandQuery("cours poterie nantes", brands));
  const q = pickQueries({
    host: "atelier-lune.fr",
    siteName: "Atelier Lune",
    gscQueries: [
      { query: "atelier lune", impressions: 5000 },
      { query: "cours poterie nantes", impressions: 3000 },
      { query: "bol grès", impressions: 4000 },
    ],
    pages: [],
  });
  assert.deepEqual(q, ["bol grès", "cours poterie nantes"]);
  const fromTitles = pickQueries({
    host: "atelier-lune.fr",
    siteName: "Atelier Lune",
    gscQueries: null,
    pages: [
      { path: "/", title: "Atelier Lune | Poterie artisanale à Nantes" },
      { path: "/cours", title: "Cours de poterie à Nantes - Atelier Lune" },
      { path: "/a/b/c", title: "Profond" },
    ],
  });
  assert.deepEqual(fromTitles, ["Poterie artisanale à Nantes", "Cours de poterie à Nantes", "Profond"]);
  assert.equal(countryFor("fr-BE"), "BE");
  assert.equal(countryFor("fr"), "FR");
  assert.equal(countryFor(null), "FR");
});

test("flux : au plus un message audit par 250 ms, le dernier état est toujours envoyé", async () => {
  const hub = new EventHub();
  const got: Array<{ t: number; n: number }> = [];
  hub.subscribe("s", (ev) => ev.type === "audit" && got.push({ t: Date.now(), n: ev.audit.pagesDone }));
  let n = 0;
  const build = () => ({ type: "audit" as const, score: null, audit: { id: "a", state: "running" as const, startedAt: "", finishedAt: null, maxPages: 10, pagesDone: n, pagesFailed: 0, pagesQueued: 0, currentUrl: null, pausedUntil: null, error: null } });
  for (let i = 0; i < 50; i++) {
    n = i;
    hub.emitAudit("s", build);
    await new Promise((r) => setTimeout(r, 10));
  }
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(got.length <= 4, `${got.length} messages`);
  assert.equal(got[got.length - 1].n, 49);
  for (let i = 1; i < got.length; i++) assert.ok(got[i].t - got[i - 1].t >= 240);
});
