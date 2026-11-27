/**
 * Bout en bout par l'API : création d'un site (site d'essai local), analyse suivie par le flux SSE,
 * forme de chaque réponse, import Search Console, annulation, erreurs.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { strToU8, zipSync } from "fflate";
import Anthropic from "@anthropic-ai/sdk";
import { setAllowPrivateHosts } from "../src/net/fetch.ts";
import { startFixtureSite, type FixtureSite } from "./helpers/fixture-site.ts";
import { del, post, postEmpty, readSse, testEnv } from "./helpers/env.ts";
import { mockClaude } from "./helpers/mock-claude.ts";
import type { SearchProvider } from "../src/competitors/competitors.ts";

let site: FixtureSite;
before(async () => {
  setAllowPrivateHosts(true);
  site = await startFixtureSite();
});
after(async () => {
  setAllowPrivateHosts(false);
  await site.close();
});


function keysOf(o: object) {
  return Object.keys(o).sort();
}

test("audit complet du site d'essai, flux SSE et forme des réponses", async () => {
  const { app, crawler } = testEnv();
  const created = await app.request("/api/sites", post({ url: site.origin.replace("http://", "http://"), maxPages: 20 }));
  assert.equal(created.status, 201);
  const { site: s } = (await created.json()) as any;
  assert.deepEqual(keysOf(s), ["audit", "createdAt", "host", "id", "name", "pagesAnalyzed", "results", "score", "searchConsole", "url"]);
  assert.equal(s.host, "localhost");
  assert.ok(["queued", "running"].includes(s.audit.state));

  const evRes = await app.request(`/api/sites/${s.id}/events`);
  assert.equal(evRes.headers.get("content-type"), "text/event-stream");
  const arrivals: number[] = [];
  const events = await readSse(evRes, (ev) => {
    if (ev.event === "audit") arrivals.push(Date.now());
    return ev.event === "audit" && ["done", "failed", "cancelled"].includes(ev.data.audit.state);
  });
  await crawler.waitAll();
  assert.equal(events[0].event, "site");
  const final = events[events.length - 1].data;
  assert.equal(final.audit.state, "done", JSON.stringify(final.audit.error));
  assert.equal(final.audit.pagesDone, 6);
  assert.equal(final.audit.pagesFailed, 1); // /missing (404)
  assert.equal(final.audit.pagesQueued, 0);
  assert.equal(final.audit.currentUrl, null);
  assert.equal(typeof final.score, "number");
  const pagesEv = events.filter((e) => e.event === "page");
  assert.equal(pagesEv.length, 6);
  assert.deepEqual(keysOf(pagesEv[0].data.page), ["httpStatus", "id", "issues", "organic", "pageType", "path", "score", "title", "url", "words"]);
  assert.equal(pagesEv[0].data.page.pageType, "home");
  for (let i = 1; i < arrivals.length; i++) assert.ok(arrivals[i] - arrivals[i - 1] >= 200, "au plus 4 messages audit par seconde");

  // Politesse et exclusions.
  const asked = site.requests;
  for (const forbidden of ["/private/secret", "/panier", "/doc.pdf", "/recherche?q=bol"]) assert.ok(!asked.includes(forbidden), `ne doit pas charger ${forbidden}`);
  assert.ok(asked.includes("/robots.txt") && asked.includes("/sitemap.xml"));
  assert.equal(asked.filter((p) => p === "/services" || p === "/services/").length, 1, "dédoublonnage de /services");

  // Vue d'ensemble.
  const ov = (await (await app.request(`/api/sites/${s.id}/overview`)).json()) as any;
  assert.deepEqual(keysOf(ov), ["actions", "counts", "coverage", "organic", "score", "site", "strengths", "topIssues"]);
  // Site vitrine avec sitemap : inventaire par le sitemap, pas de plateforme reconnue.
  assert.equal(ov.coverage.inventory, "sitemap");
  assert.equal(ov.coverage.catalogue, null);
  assert.equal(ov.coverage.platform, null);
  assert.equal(ov.coverage.mainLocale, "fr");
  assert.equal(ov.coverage.totals.analyzed, 6);
  assert.equal(ov.coverage.totals.viaCatalogue, 0);
  assert.equal(ov.coverage.complete, true);
  assert.equal(ov.coverage.fullAuditMaxPages, null);
  assert.deepEqual(await (await app.request(`/api/sites/${s.id}/coverage`)).json(), { coverage: ov.coverage });
  assert.equal(ov.site.name, "Atelier Lune");
  assert.equal(ov.score.value, final.score);
  assert.equal(ov.score.previous, null);
  assert.equal(ov.score.categories.length, 5);
  assert.equal(ov.counts.pages, 6);
  assert.ok(ov.topIssues.length <= 5 && ov.actions.length <= 5 && ov.strengths.length <= 5);
  assert.equal(ov.organic, null);

  // Problèmes.
  const iss = (await (await app.request(`/api/sites/${s.id}/issues`)).json()) as any;
  assert.deepEqual(keysOf(iss), ["categories", "issues", "strengths"]);
  assert.deepEqual(keysOf(iss.issues[0]), ["basis", "category", "id", "pagesAffected", "pagesTotal", "pointsLost", "scoreImpact", "severity", "summary", "title"]);
  assert.ok(iss.issues.every((i: any) => i.basis === "pages"));
  const detail = (await (await app.request(`/api/sites/${s.id}/issues/meta_description`)).json()) as any;
  assert.deepEqual(keysOf(detail.issue), ["basis", "category", "evidence", "fix", "id", "pagesAffected", "pagesTotal", "pointsLost", "scoreImpact", "severity", "shopifyField", "summary", "title", "why"]);
  assert.deepEqual(keysOf(detail.issue.evidence[0]), ["expected", "found", "pageId", "path", "shopifyResourceId", "url"]);
  assert.ok(Array.isArray(detail.issue.fix.steps));
  const dup = await app.request(`/api/sites/${s.id}/issues/duplicate_title`);
  assert.equal(dup.status, 200);
  const missing = await app.request(`/api/sites/${s.id}/issues/nope`);
  assert.equal(missing.status, 404);
  assert.equal(((await missing.json()) as any).error.code, "not_found");

  // Pages.
  const pages = (await (await app.request(`/api/sites/${s.id}/pages?sort=score_desc&limit=2`)).json()) as any;
  assert.deepEqual(keysOf(pages), ["limit", "offset", "pages", "total"]);
  assert.equal(pages.total, 6);
  assert.equal(pages.pages.length, 2);
  assert.ok(pages.pages[0].score >= pages.pages[1].score);
  const filtered = (await (await app.request(`/api/sites/${s.id}/pages?q=propos`)).json()) as any;
  assert.equal(filtered.total, 1);
  assert.equal((await app.request(`/api/sites/${s.id}/pages?sort=bad`)).status, 400);
  const pd = (await (await app.request(`/api/sites/${s.id}/pages/${filtered.pages[0].id}`)).json()) as any;
  assert.deepEqual(keysOf(pd.page), ["analyzedAt", "canonical", "checks", "description", "h1", "httpStatus", "id", "issues", "lang", "organic", "pageType", "path", "queries", "score", "serpPreview", "shopifyResourceId", "title", "url", "words"]);
  assert.equal(pd.page.pageType, "page");
  assert.equal(pd.page.checks.length, 23);
  assert.equal(pd.page.path, "/a-propos");

  // Recommandations.
  const recs = (await (await app.request(`/api/sites/${s.id}/recommendations`)).json()) as any;
  assert.equal(recs.recommendations[0].rank, 1);
  assert.deepEqual(keysOf(recs.recommendations[0]), ["effort", "id", "impact", "issueId", "pagesAffected", "pointsToGain", "rank", "scoreGain", "steps", "title"]);

  // ETag.
  const r1 = await app.request(`/api/sites/${s.id}/overview`);
  const etag = r1.headers.get("etag")!;
  assert.ok(etag);
  const r2 = await app.request(`/api/sites/${s.id}/overview`, { headers: { "if-none-match": etag } });
  assert.equal(r2.status, 304);

  // Doublon de site.
  const again = await app.request("/api/sites", post({ url: site.origin + "/services" }));
  assert.equal(again.status, 409);
  const againBody = (await again.json()) as any;
  assert.equal(againBody.error.code, "site_exists");
  assert.equal(againBody.error.details.siteId, s.id);

  // Search Console : import d'un zip dont les adresses correspondent aux pages analysées.
  const zip = zipSync({
    "Pages.csv": strToU8(`Pages les plus populaires,Clics,Impressions,CTR,Position\n${site.origin}/,40,"1 000","4 %","5,5"\n${site.origin}/services/,10,500,"2 %","9"\n${site.origin}/inconnue,1,10,"10 %","30"\n`),
    "Requêtes.csv": strToU8(`Requêtes les plus fréquentes,Clics,Impressions,CTR,Position\natelier lune,30,300,"10 %","1,5"\npoterie nantes,20,"1 200","1,67 %","9,1"\n`),
  });
  const fd = new FormData();
  fd.append("file", new Blob([zip], { type: "application/zip" }), "export.zip");
  const up = await app.request(`/api/sites/${s.id}/search-console`, { method: "POST", body: fd });
  assert.equal(up.status, 200);
  const gsc = (await up.json()) as any;
  assert.equal(gsc.available, true);
  assert.deepEqual(keysOf(gsc), ["available", "importedAt", "matching", "pages", "period", "queries", "series", "source", "totals"]);
  assert.equal(gsc.source, "file");
  assert.equal(gsc.series, null);
  assert.deepEqual(gsc.matching, { matched: 2, total: 3 });
  assert.equal(gsc.pages.find((p: any) => p.path === "/services/").pageId !== null, true);
  assert.equal(gsc.pages.find((p: any) => p.path === "/inconnue").pageId, null);
  const withOrganic = (await (await app.request(`/api/sites/${s.id}/pages?sort=clicks_desc`)).json()) as any;
  assert.deepEqual(withOrganic.pages[0].organic, { clicks: 40, impressions: 1000, position: 5.5 });
  const ov2 = (await (await app.request(`/api/sites/${s.id}/overview`)).json()) as any;
  assert.equal(ov2.organic.totals.clicks, 50);
  const bad = new FormData();
  bad.append("file", new Blob(["nom,prenom\nx,y\n"]), "x.csv");
  const badRes = await app.request(`/api/sites/${s.id}/search-console`, { method: "POST", body: bad });
  assert.equal(badRes.status, 422);
  assert.equal(((await badRes.json()) as any).error.code, "invalid_file");
  assert.equal((await app.request(`/api/sites/${s.id}/search-console`, del())).status, 204);
  assert.deepEqual(await (await app.request(`/api/sites/${s.id}/search-console`)).json(), { available: false });

  // Sans clés : assistant et concurrents désactivés.
  assert.deepEqual(await (await app.request(`/api/sites/${s.id}/competitors`)).json(), { available: false, reason: "not_configured" });
  const comp = await app.request(`/api/sites/${s.id}/competitors`, postEmpty());
  assert.equal(comp.status, 503);
  assert.equal(((await comp.json()) as any).error.code, "competitors_not_configured");
  const chat = (await (await app.request(`/api/sites/${s.id}/chat`)).json()) as any;
  assert.equal(chat.available, false);
  assert.ok(chat.suggestions.length > 0 && chat.suggestions.length <= 4);
  const chatPost = await app.request(`/api/sites/${s.id}/chat`, post({ message: "Bonjour" }));
  assert.equal(chatPost.status, 503);
  assert.equal(((await chatPost.json()) as any).error.code, "chat_not_configured");

  // Relance, puis annulation.
  const relance = await app.request(`/api/sites/${s.id}/audits`, post({ maxPages: 3 }));
  assert.equal(relance.status, 202);
  const running = await app.request(`/api/sites/${s.id}/audits`, post({}));
  assert.equal(running.status, 409);
  assert.equal(((await running.json()) as any).error.code, "audit_running");
  const cancel = await app.request(`/api/sites/${s.id}/audits/cancel`, postEmpty());
  const cancelled = (await cancel.json()) as any;
  // Arrêtée avant ou après sa première page : « failed » (aucune page) ou « cancelled ».
  assert.ok(["cancelled", "failed", "done"].includes(cancelled.audit.state));
  // Les résultats affichés restent ceux de l'analyse terminée.
  const ov3 = (await (await app.request(`/api/sites/${s.id}/overview`)).json()) as any;
  assert.equal(ov3.site.results.auditId, final.audit.id);
  assert.equal(ov3.site.results.state, "done");
  assert.equal(ov3.site.audit.id, cancelled.audit.id);
  assert.equal(ov3.score.value, final.score);
  assert.equal(ov3.counts.pages, 6);
  const fp = (await (await app.request(`/api/sites/${s.id}/failed-pages`)).json()) as any;
  assert.deepEqual(fp, { pages: [{ url: `${site.origin}/missing`, path: "/missing", httpStatus: 404, reason: "Page introuvable (404)" }] });

  // Suppression.
  assert.equal((await app.request(`/api/sites/${s.id}`, del())).status, 204);
  assert.equal((await app.request(`/api/sites/${s.id}`)).status, 404);
});

test("erreurs de création : adresse invalide, non publique, injoignable", async () => {
  const { app } = testEnv();
  const empty = await app.request("/api/sites", post({ url: "  " }));
  assert.equal(empty.status, 400);
  assert.equal(((await empty.json()) as any).error.code, "invalid_url");
  const bad = await app.request("/api/sites", post({ url: "pas une adresse" }));
  assert.equal(((await bad.json()) as any).error.code, "invalid_url");
  const unreachable = await app.request("/api/sites", post({ url: "http://127.0.0.1:9/" }));
  assert.equal(unreachable.status, 422);
  const body = (await unreachable.json()) as any;
  assert.equal(body.error.code, "site_unreachable");
  assert.equal(typeof body.error.action, "string");
  setAllowPrivateHosts(false);
  try {
    const priv = await app.request("/api/sites", post({ url: "http://192.168.1.1/" }));
    assert.equal(priv.status, 400);
    assert.equal(((await priv.json()) as any).error.code, "invalid_url");
    const local = await app.request("/api/sites", post({ url: site.origin }));
    assert.equal(((await local.json()) as any).error.code, "invalid_url");
  } finally {
    setAllowPrivateHosts(true);
  }
  const maxBad = await app.request("/api/sites", post({ url: site.origin, maxPages: 9999 }));
  assert.equal(((await maxBad.json()) as any).error.code, "bad_request");
  const unknown = await app.request("/api/nope");
  assert.equal(((await unknown.json()) as any).error.code, "not_found");
  const notJson = await app.request("/api/sites", { method: "POST", body: "{", headers: { "content-type": "application/json" } });
  assert.equal(((await notJson.json()) as any).error.code, "bad_request");
});

test("santé et paramètres", async () => {
  const { app } = testEnv();
  assert.deepEqual(await (await app.request("/api/health")).json(), { ok: true, version: "0.1.0" });
  const st = (await (await app.request("/api/settings")).json()) as any;
  assert.deepEqual(st, { maxPagesDefault: 100, maxPagesLimits: { min: 1, max: 100 }, integrations: { chat: { configured: false, model: null }, competitors: { configured: false }, shopify: { configured: false, writesEnabled: false }, searchConsole: { configured: false }, dataForSeo: { configured: false } }, version: "0.1.0" });
  const patched = await app.request("/api/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ maxPagesDefault: 40 }) });
  assert.equal(((await patched.json()) as any).maxPagesDefault, 40);
  const wrong = await app.request("/api/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ maxPagesDefault: 0 }) });
  assert.equal(wrong.status, 400);
  const sites = (await (await app.request("/api/sites")).json()) as any;
  assert.deepEqual(sites, { sites: [] });
});

async function auditedEnv(opts: Parameters<typeof testEnv>[0]) {
  const env = testEnv(opts);
  const res = await env.app.request("/api/sites", post({ url: site.origin, maxPages: 10 }));
  const { site: s } = (await res.json()) as any;
  await env.crawler.waitAll();
  return { ...env, siteId: s.id as string };
}

test("assistant (client simulé) : outils côté serveur, flux, sources, historique", async () => {
  const client = mockClaude([
    { text: ["Je regarde vos problèmes."], tools: [{ name: "liste_problemes", input: {} }] },
    { tools: [{ name: "detail_page", input: { page: "/services" } }] },
    { text: ["Commencez par ", "la page `/services`."] },
  ]);
  const { app, siteId } = await auditedEnv({ chatClient: client });
  const st = (await (await app.request(`/api/sites/${siteId}/chat`)).json()) as any;
  assert.equal(st.available, true);
  const res = await app.request(`/api/sites/${siteId}/chat`, post({ message: "Par quoi je commence ?" }));
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const evs = await readSse(res);
  assert.deepEqual(evs.map((e) => e.event), ["start", "delta", "tool", "tool", "delta", "delta", "done"]);
  assert.equal(evs[0].data.userMessage.content, "Par quoi je commence ?");
  assert.equal(evs[2].data.label, "Lecture des problèmes du site");
  assert.equal(evs[3].data.label, "Lecture de la page /services");
  const done = evs[evs.length - 1].data.message;
  assert.equal(done.content, evs.filter((e) => e.event === "delta").map((e) => e.data.text).join(""));
  assert.equal(done.content, "Je regarde vos problèmes.\n\nCommencez par la page `/services`.");
  assert.deepEqual(done.sources, ["Problèmes du site", "Page /services"]);
  // Le modèle a reçu les résultats d'outils et la consigne système.
  const second = client.requests[1];
  assert.match(second.system as string, /donnée non fiable/);
  const toolResult = (second.messages[second.messages.length - 1].content as any[])[0];
  assert.equal(toolResult.type, "tool_result");
  assert.match(toolResult.content, /meta_description/);
  const third = client.requests[2];
  const pageResult = (third.messages[third.messages.length - 1].content as any[])[0];
  assert.match(pageResult.content, /donnee_non_fiable/);
  assert.equal(client.requests[0].model, "claude-sonnet-5-5");
  assert.equal(client.requests[0].tools?.length, 12); // dont boutique_shopify (lecture) et proposer_corrections (seul moyen d'écrire)
  // Historique enregistré et renvoyé.
  const after = (await (await app.request(`/api/sites/${siteId}/chat`)).json()) as any;
  assert.equal(after.messages.length, 2);
  assert.equal(after.messages[1].role, "assistant");
  assert.equal((await app.request(`/api/sites/${siteId}/chat`, del())).status, 204);
  assert.equal(((await (await app.request(`/api/sites/${siteId}/chat`)).json()) as any).messages.length, 0);
});

test("assistant : une erreur de l'API devient chat_unavailable, sans exposer la clé", async () => {
  const apiErr = new Anthropic.AuthenticationError(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key sk-ant-test-SECRET-KEY" } }, "invalid x-api-key sk-ant-test-SECRET-KEY", new Headers());
  const { app, siteId } = await auditedEnv({ chatClient: mockClaude([{ error: apiErr }]) });
  const res = await app.request(`/api/sites/${siteId}/chat`, post({ message: "Bonjour" }));
  const raw = await res.text();
  assert.ok(!raw.includes("SECRET"), "la clé ne doit jamais apparaître");
  assert.match(raw, /event: error/);
  assert.match(raw, /"code":"chat_unavailable"/);
  const overloaded = new Anthropic.APIError(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, "Overloaded", new Headers());
  const env2 = await auditedEnv({ chatClient: mockClaude([{ error: overloaded }]) });
  const raw2 = await (await env2.app.request(`/api/sites/${env2.siteId}/chat`, post({ message: "Bonjour" }))).text();
  assert.match(raw2, /saturé/);
  const empty = await app.request(`/api/sites/${siteId}/chat`, post({ message: "   " }));
  assert.equal(((await empty.json()) as any).error.code, "bad_request");
});

test("concurrents (fournisseur simulé) : relevé réel, preuves, site lui-même exclu", async () => {
  const seen: Array<{ q: string; country: string }> = [];
  const provider: SearchProvider = {
    async search(query, { country }) {
      seen.push({ q: query, country });
      return [
        { url: `${site.origin}/`, title: "Nous-mêmes" },
        { url: "https://terre-et-feu.example/cours", title: "Cours de poterie — Terre et Feu" },
        { url: "https://www.argile.example/", title: "Argile" },
      ];
    },
  };
  const { app, siteId } = await auditedEnv({ searchProvider: provider });
  assert.deepEqual(await (await app.request(`/api/sites/${siteId}/competitors`)).json(), { available: false, reason: "not_run" });
  const res = await app.request(`/api/sites/${siteId}/competitors`, postEmpty());
  assert.equal(res.status, 200);
  const data = (await res.json()) as any;
  assert.equal(data.available, true);
  assert.ok(data.queries.length > 0);
  assert.ok(seen.every((s) => s.country === "FR"));
  assert.ok(!data.queries.some((q: string) => /atelier lune/i.test(q)), "requêtes hors marque");
  assert.equal(data.competitors.length, 2);
  assert.deepEqual(keysOf(data.competitors[0]), ["bestPosition", "example", "host", "queriesMatched"]);
  assert.equal(data.competitors[0].host, "terre-et-feu.example");
  assert.equal(data.competitors[0].bestPosition, 2);
  assert.equal(data.competitors[0].queriesMatched, data.queries.length);
  assert.equal(data.competitors[1].host, "argile.example");
  const stored = (await (await app.request(`/api/sites/${siteId}/competitors`)).json()) as any;
  assert.equal(stored.checkedAt, data.checkedAt);
});
