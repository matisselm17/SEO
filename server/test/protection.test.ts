/**
 * Corrections après revue QA : analyse affichée, fin d'analyse, protection des requêtes, limites,
 * assistant (question non conservée, arrêt sur coupure), concurrents, import Search Console.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { strToU8, zipSync } from "fflate";
import Anthropic from "@anthropic-ai/sdk";
import { setAllowPrivateHosts } from "../src/net/fetch.ts";
import { startFixtureSite, type FixtureSite } from "./helpers/fixture-site.ts";
import { del, JSON_HEADERS, post, postEmpty, readSse, testEnv } from "./helpers/env.ts";
import { mockClaude } from "./helpers/mock-claude.ts";
import type { SearchProvider } from "../src/competitors/competitors.ts";
import { HttpError } from "../src/errors.ts";

let site: FixtureSite;
let slow: FixtureSite;
before(async () => {
  setAllowPrivateHosts(true);
  site = await startFixtureSite();
  slow = await startFixtureSite(0, { slowMs: 150 });
});
after(async () => {
  setAllowPrivateHosts(false);
  await site.close();
  await slow.close();
});

async function created(env: ReturnType<typeof testEnv>, origin: string, maxPages = 10): Promise<string> {
  const res = await env.app.request("/api/sites", post({ url: origin, maxPages }));
  assert.equal(res.status, 201, await res.clone().text());
  return ((await res.json()) as any).site.id;
}

test("relance puis arrêt : les résultats de l'analyse terminée restent affichés", async () => {
  const env = testEnv();
  const id = await created(env, slow.origin, 20);
  await env.crawler.waitAll();
  const first = (await (await env.app.request(`/api/sites/${id}`)).json()) as any;
  assert.equal(first.site.results.state, "done");
  const firstScore = first.site.score;

  const relance = await env.app.request(`/api/sites/${id}/audits`, post({ maxPages: 20 }));
  const newAudit = ((await relance.json()) as any).audit;
  // On attend que la nouvelle analyse ait noté au moins une page, puis on l'arrête.
  const ev = await env.app.request(`/api/sites/${id}/events`);
  await readSse(ev, (e) => e.event === "page");
  const pendant = (await (await env.app.request(`/api/sites/${id}/overview`)).json()) as any;
  assert.equal(pendant.site.audit.id, newAudit.id);
  assert.equal(pendant.site.results.auditId, first.site.results.auditId, "pendant la relance, results reste l'analyse précédente");
  assert.equal(pendant.score.value, firstScore);

  const cancel = (await (await env.app.request(`/api/sites/${id}/audits/cancel`, postEmpty())).json()) as any;
  assert.equal(cancel.audit.state, "cancelled");
  assert.ok(cancel.audit.pagesDone >= 1);
  const apres = (await (await env.app.request(`/api/sites/${id}/overview`)).json()) as any;
  assert.equal(apres.site.results.auditId, first.site.results.auditId);
  assert.equal(apres.site.score, firstScore);
  assert.equal(apres.counts.pages, 6);
  assert.equal(apres.score.previous, null);

  // Une nouvelle analyse terminée devient l'analyse affichée ; previous = la note de la précédente terminée.
  await env.app.request(`/api/sites/${id}/audits`, post({ maxPages: 20 }));
  await env.crawler.waitAll();
  const third = (await (await env.app.request(`/api/sites/${id}/overview`)).json()) as any;
  assert.notEqual(third.site.results.auditId, first.site.results.auditId);
  assert.equal(third.score.previous, firstScore);
});

test("fin d'analyse : arrêt du serveur → failed avec message ; arrêt par l'utilisateur → cancelled, même sans page", async () => {
  const env = testEnv();
  const id = await created(env, slow.origin, 20);
  const ev = await env.app.request(`/api/sites/${id}/events`);
  await readSse(ev, (e) => e.event === "page");
  env.crawler.stopAllForShutdown();
  await env.crawler.waitAll();
  const s = ((await (await env.app.request(`/api/sites/${id}`)).json()) as any).site;
  assert.equal(s.audit.state, "failed");
  assert.match(s.audit.error.message, /interrompue par un redémarrage du serveur/);
  assert.equal(s.audit.error.action, "Relancez l'analyse.");
  assert.ok(s.audit.pagesDone >= 1);
  // Sans analyse terminée, results désigne l'analyse qui a des pages.
  assert.equal(s.results.auditId, s.audit.id);

  // Arrêt demandé par l'utilisateur avant la première page : cancelled, sans message d'échec.
  const id2 = await created(env, `http://127.0.0.1:${new URL(slow.origin).port}`, 5);
  const c = (await (await env.app.request(`/api/sites/${id2}/audits/cancel`, postEmpty())).json()) as any;
  assert.equal(c.audit.state, "cancelled");
  assert.equal(c.audit.error, null);
  assert.equal(c.audit.pagesDone, 0);
});

test("site injoignable pendant l'analyse : message en minuscule après les deux-points", async () => {
  const env = testEnv();
  const tmp = await startFixtureSite();
  const id = await created(env, tmp.origin, 3);
  await tmp.close();
  await env.crawler.waitAll();
  const s = ((await (await env.app.request(`/api/sites/${id}`)).json()) as any).site;
  // Le serveur d'essai a pu servir la première page avant d'être fermé ; sinon, message attendu.
  if (s.audit.state === "failed") assert.match(s.audit.error.message, /^Le site n'a pas pu être chargé : [a-zà-ü]/);
});

test("requêtes : Origin étranger refusé, JSON exigé, corps limité au fil de la lecture", async () => {
  const { app } = testEnv();
  const foreign = await app.request("http://localhost:8787/api/sites", { method: "POST", headers: { ...JSON_HEADERS, origin: "https://evil.example", host: "localhost:8787" }, body: JSON.stringify({ url: site.origin }) });
  assert.equal(foreign.status, 403);
  assert.equal(((await foreign.json()) as any).error.code, "bad_request");
  const nullOrigin = await app.request("http://localhost:8787/api/settings", { method: "PATCH", headers: { ...JSON_HEADERS, origin: "null", host: "localhost:8787" }, body: "{}" });
  assert.equal(nullOrigin.status, 403);
  const same = await app.request("http://localhost:8787/api/settings", { method: "PATCH", headers: { ...JSON_HEADERS, origin: "http://localhost:8787", host: "localhost:8787" }, body: "{}" });
  assert.equal(same.status, 200);
  // Formulaire HTML classique (CSRF) : refusé.
  const form = await app.request("/api/sites", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "url=x" });
  assert.equal(form.status, 415);
  const noType = await app.request("/api/sites/x", { method: "DELETE" });
  assert.equal(noType.status, 415);
  // Dépôt de fichier : multipart exigé, et l'Origin est vérifié aussi.
  const upJson = await app.request("/api/sites/x/search-console", post({}));
  assert.equal(upJson.status, 415);
  const fd = new FormData();
  fd.append("file", new Blob(["a"]), "a.csv");
  const upForeign = await app.request("http://localhost:8787/api/sites/x/search-console", { method: "POST", body: fd, headers: { origin: "https://evil.example", host: "localhost:8787" } });
  assert.equal(upForeign.status, 403);
  // JSON de plus de 64 Ko.
  const big = await app.request("/api/sites", post({ url: "x".repeat(70 * 1024) }));
  assert.equal(big.status, 413);
  // Corps « chunked » sans longueur annoncée : refusé dès 64 Ko, la lecture s'arrête.
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      pulled += 16 * 1024;
      if (pulled > 100 * 1024 * 1024) return ctrl.close();
      ctrl.enqueue(new Uint8Array(16 * 1024).fill(32));
    },
  });
  const chunked = await app.request("/api/sites", { method: "POST", headers: JSON_HEADERS, body: stream, duplex: "half" } as RequestInit);
  assert.equal(chunked.status, 413);
  assert.ok(pulled < 1024 * 1024, `lecture arrêtée tôt (${pulled} octets lus)`);
});

test("en-têtes de sécurité et compression, sans compresser les flux SSE", async () => {
  const env = testEnv();
  const id = await created(env, site.origin, 10);
  await env.crawler.waitAll();
  const r = await env.app.request(`/api/sites/${id}/issues`, { headers: { "accept-encoding": "br, gzip" } });
  assert.equal(r.headers.get("content-encoding"), "br");
  assert.match(r.headers.get("content-security-policy")!, /default-src 'self'.*frame-ancestors 'none'/);
  assert.equal(r.headers.get("referrer-policy"), "no-referrer");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  const g = await env.app.request(`/api/sites/${id}/issues`, { headers: { "accept-encoding": "gzip" } });
  assert.equal(g.headers.get("content-encoding"), "gzip");
  const sse = await env.app.request(`/api/sites/${id}/events`, { headers: { "accept-encoding": "br, gzip" } });
  assert.equal(sse.headers.get("content-encoding"), null);
  assert.equal(sse.headers.get("content-type"), "text/event-stream");
  await sse.body!.cancel();
});

test("limites : nombre de sites, analyses simultanées en file d'attente", async () => {
  const env = testEnv({ limits: { maxSites: 2, maxConcurrentAudits: 1 } });
  const a = await created(env, site.origin, 5);
  const b = await created(env, `http://127.0.0.1:${new URL(slow.origin).port}`, 5);
  const sb = ((await (await env.app.request(`/api/sites/${b}`)).json()) as any).site;
  const sa = ((await (await env.app.request(`/api/sites/${a}`)).json()) as any).site;
  assert.ok(sa.audit.state === "running" || sa.audit.state === "done");
  if (sa.audit.state === "running") assert.equal(sb.audit.state, "queued");
  const third = await env.app.request("/api/sites", post({ url: "http://[::1]:1/" }));
  assert.equal(third.status, 409);
  const body = (await third.json()) as any;
  assert.equal(body.error.code, "limit_reached");
  await env.crawler.waitAll();
  for (const id of [a, b]) assert.equal(((await (await env.app.request(`/api/sites/${id}`)).json()) as any).site.audit.state, "done");
});

test("assistant : limite par minute, une réponse à la fois, question non conservée sur échec", async () => {
  const env = testEnv({ chatClient: mockClaude([{ text: ["Réponse lente"] }, { text: ["ok"] }], { delayMs: 150 }), limits: { chatPerMinute: 2 } });
  const id = await created(env, site.origin, 3);
  await env.crawler.waitAll();
  const first = env.app.request(`/api/sites/${id}/chat`, post({ message: "Un" }));
  await new Promise((r) => setTimeout(r, 30));
  const busy = await env.app.request(`/api/sites/${id}/chat`, post({ message: "Deux" }));
  assert.equal(busy.status, 409);
  assert.equal(((await busy.json()) as any).error.code, "limit_reached");
  await readSse(await first);
  await readSse(await env.app.request(`/api/sites/${id}/chat`, post({ message: "Trois" })));
  const limited = await env.app.request(`/api/sites/${id}/chat`, post({ message: "Quatre" }));
  assert.equal(limited.status, 429);
  const lb = (await limited.json()) as any;
  assert.equal(lb.error.code, "rate_limited");
  assert.ok(lb.error.details.retryAfterSeconds >= 1 && lb.error.details.retryAfterSeconds <= 60);
  assert.equal(limited.headers.get("retry-after"), String(lb.error.details.retryAfterSeconds));

  const apiErr = new Anthropic.APIError(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, "Overloaded", new Headers());
  const env2 = testEnv({ chatClient: mockClaude([{ error: apiErr }]) });
  const id2 = await created(env2, site.origin, 3);
  await env2.crawler.waitAll();
  const evs = await readSse(await env2.app.request(`/api/sites/${id2}/chat`, post({ message: "Bonjour" })));
  assert.deepEqual(evs.map((e) => e.event), ["start", "error"]);
  const st = (await (await env2.app.request(`/api/sites/${id2}/chat`)).json()) as any;
  assert.equal(st.messages.length, 0, "la question n'est pas conservée quand l'API échoue avant toute réponse");
});

test("assistant : la coupure du flux arrête la génération ; consignes avec l'hôte seulement", async () => {
  const client = mockClaude([{ text: Array.from({ length: 40 }, (_, i) => `mot${i} `) }], { delayMs: 20 });
  const env = testEnv({ chatClient: client });
  const id = await created(env, site.origin, 3);
  await env.crawler.waitAll();
  const res = await env.app.request(`/api/sites/${id}/chat`, post({ message: "Longue réponse" }));
  await readSse(res, (e) => e.event === "delta");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(client.aborted[0], true, "le flux vers l'API est interrompu");
  assert.ok(client.eventsSent < 40, `génération arrêtée (${client.eventsSent} événements)`);
  const system = client.requests[0].system as string;
  assert.match(system, /site localhost à améliorer/);
  assert.ok(!system.includes("Atelier Lune"), "le nom du site (venu de la page) n'entre pas dans les consignes");
});

test("concurrents : service en panne → competitors_unavailable ; limite par minute", async () => {
  const failing: SearchProvider = {
    async search() {
      throw new HttpError(502, "competitors_unavailable", "Le service de recherche ne répond pas.", "Réessayez dans quelques minutes.");
    },
  };
  const env = testEnv({ searchProvider: failing, limits: { competitorsPerMinute: 1 } });
  const id = await created(env, site.origin, 3);
  await env.crawler.waitAll();
  const r = await env.app.request(`/api/sites/${id}/competitors`, postEmpty());
  assert.equal(r.status, 502);
  assert.equal(((await r.json()) as any).error.code, "competitors_unavailable");
  const r2 = await env.app.request(`/api/sites/${id}/competitors`, postEmpty());
  assert.equal(r2.status, 429);
  assert.equal(((await r2.json()) as any).error.code, "rate_limited");
});

test("Search Console : autre site refusé sans remplacer l'import, adresses étrangères écartées, rapprochement", async () => {
  const env = testEnv();
  const id = await created(env, site.origin, 10);
  await env.crawler.waitAll();
  const upload = async (files: Record<string, string>) => {
    const fd = new FormData();
    fd.append("file", new Blob([zipSync(Object.fromEntries(Object.entries(files).map(([n, t]) => [n, strToU8(t)])))]), "export.zip");
    return env.app.request(`/api/sites/${id}/search-console`, { method: "POST", body: fd });
  };
  const H = "Pages les plus populaires,Clics,Impressions,CTR,Position\n";
  const ok = await upload({
    "Pages.csv": `${H}${site.origin}/?utm_source=news,5,50,"10 %","3"\n${site.origin}/a-propos,2,20,"10 %","4"\nhttps://autre.example/x,99,999,"10 %","1"\n`,
  });
  assert.equal(ok.status, 200);
  const data = (await ok.json()) as any;
  assert.equal(data.pages.length, 2, "adresse d'un autre site écartée");
  assert.deepEqual(data.matching, { matched: 2, total: 2 }, "rapprochement avec la même normalisation que le parcours (paramètres de suivi)");

  const foreign = await upload({ "Pages.csv": `${H}https://autre.example/,10,100,"10 %","2"\nhttps://autre.example/b,1,10,"10 %","5"\n` });
  assert.equal(foreign.status, 422);
  const fb = (await foreign.json()) as any;
  assert.equal(fb.error.code, "invalid_file");
  assert.match(fb.error.message, /semble venir d'un autre site \(autre\.example\)/);
  const still = (await (await env.app.request(`/api/sites/${id}/search-console`)).json()) as any;
  assert.equal(still.importedAt, data.importedAt, "un import refusé ne remplace pas le précédent");

  const noNumbers = await upload({ "Requêtes.csv": "Requêtes les plus fréquentes,Clics,Impressions,CTR,Position\nbol,abc,def,x,y\n" });
  assert.equal(noNumbers.status, 422);
  assert.match(((await noNumbers.json()) as any).error.message, /aucun chiffre de clics ni d'impressions/);
  assert.equal(((await (await env.app.request(`/api/sites/${id}/search-console`)).json()) as any).importedAt, data.importedAt);
  assert.equal((await env.app.request(`/api/sites/${id}/search-console`, del())).status, 204);
});
