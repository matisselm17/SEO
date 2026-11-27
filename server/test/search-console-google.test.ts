/**
 * Search Console en lecture directe : jeton (JWT RS256 signé avec node:crypto), propriété, conversion, requêtes
 * par page. Faux Google (fetch simulé) et clé RSA générée dans le test : aucun appel réseau réel.
 */
import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { periodFor, SearchConsoleClient, toImport } from "../src/gsc/google.ts";
import { insertDoneAudit } from "./helpers/boutique.ts";
import { post, testEnv } from "./helpers/env.ts";

const dir = mkdtempSync(path.join(os.tmpdir(), "gsc-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const EMAIL = "lecture-seo@projet-essai.iam.gserviceaccount.com";
const FILE = path.join(dir, "compte.json");
writeFileSync(FILE, JSON.stringify({ type: "service_account", client_email: EMAIL, private_key: PRIVATE_PEM, private_key_id: "cle-secrete-123", token_uri: "https://ailleurs.example/token" }));
const HOST = "atelier-lune.example";

interface FakeOpts {
  sites?: Array<{ siteUrl: string; permissionLevel: string }>;
  rows?: Record<string, Array<{ keys: string[]; clicks: number; impressions: number; ctr: number; position: number }>>;
  rejectFirstApiCall?: boolean;
}

function fakeGoogle(o: FakeOpts = {}) {
  const calls = { token: 0, urls: [] as string[], queries: [] as any[], assertions: [] as any[] };
  let rejected = false;
  const impl = (async (url: string, init: RequestInit) => {
    calls.urls.push(url);
    if (url === "https://oauth2.googleapis.com/token") {
      calls.token++;
      const form = new URLSearchParams(String(init.body));
      assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
      const [h, c, s] = form.get("assertion")!.split(".");
      const v = createVerify("RSA-SHA256");
      v.update(`${h}.${c}`);
      if (!v.verify(publicKey, Buffer.from(s, "base64url"))) return new Response("{}", { status: 400 });
      const claims = JSON.parse(Buffer.from(c, "base64url").toString());
      calls.assertions.push({ header: JSON.parse(Buffer.from(h, "base64url").toString()), claims });
      return Response.json({ access_token: `jeton-google-${calls.token}`, expires_in: 3599, token_type: "Bearer" });
    }
    const auth = (init.headers as Record<string, string>).authorization;
    if (!auth?.startsWith("Bearer jeton-google-")) return new Response("{}", { status: 401 });
    if (o.rejectFirstApiCall && !rejected) {
      rejected = true;
      return new Response("{}", { status: 401 });
    }
    if (url === "https://www.googleapis.com/webmasters/v3/sites") return Response.json({ siteEntry: o.sites ?? [{ siteUrl: `sc-domain:${HOST}`, permissionLevel: "siteRestrictedUser" }] });
    const m = /\/sites\/([^/]+)\/searchAnalytics\/query$/.exec(url);
    if (m) {
      const body = JSON.parse(String(init.body));
      calls.queries.push({ property: decodeURIComponent(m[1]), ...body });
      const all = o.rows?.[body.dimensions.join(",")] ?? [];
      return Response.json({ rows: all.slice(body.startRow, body.startRow + body.rowLimit) });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const ROWS: FakeOpts["rows"] = {
  date: [
    { keys: ["2026-11-02"], clicks: 4, impressions: 100, ctr: 0.04, position: 10 },
    { keys: ["2026-11-01"], clicks: 6, impressions: 300, ctr: 0.02, position: 6 },
  ],
  query: [
    { keys: ["poterie nantes"], clicks: 3, impressions: 150, ctr: 0.02, position: 8.24 },
    { keys: ["atelier lune"], clicks: 7, impressions: 70, ctr: 0.1, position: 1.2 },
  ],
  page: [
    { keys: [`https://${HOST}/boutique`], clicks: 8, impressions: 200, ctr: 0.04, position: 5 },
    { keys: ["https://autre-site.example/x"], clicks: 99, impressions: 999, ctr: 0.1, position: 1 },
  ],
  "page,query": [
    { keys: [`https://${HOST}/boutique`, "poterie nantes"], clicks: 2, impressions: 90, ctr: 0.022, position: 7 },
    { keys: [`https://${HOST}/boutique`, "atelier lune"], clicks: 6, impressions: 60, ctr: 0.1, position: 1 },
    { keys: ["https://autre-site.example/x", "intrus"], clicks: 5, impressions: 5, ctr: 1, position: 1 },
  ],
};

function env(o: FakeOpts & { property?: string | null; file?: string } = {}) {
  const google = fakeGoogle(o);
  const e = testEnv({ google: { file: o.file ?? FILE, fetchImpl: google.impl, property: o.property ?? null } });
  const site = e.store.insertSite(`https://${HOST}/`, HOST, null);
  const { ids } = insertDoneAudit(e.store, site.id, HOST, ["/", "/boutique"]);
  return { ...e, google, site, ids, base: `/api/sites/${site.id}` };
}

test("jeton : assertion JWT RS256 vérifiable, portée lecture seule, gardé en mémoire et renouvelé après un 401", async () => {
  const e = env({ rows: ROWS });
  await e.searchConsole.read(HOST, 28);
  await e.searchConsole.read(HOST, 28);
  assert.equal(e.google.calls.token, 1, "un seul jeton pour deux lectures");
  const a = e.google.calls.assertions[0];
  assert.deepEqual(a.header, { alg: "RS256", typ: "JWT" });
  assert.equal(a.claims.iss, EMAIL);
  assert.equal(a.claims.scope, "https://www.googleapis.com/auth/webmasters.readonly");
  assert.equal(a.claims.aud, "https://oauth2.googleapis.com/token", "le token_uri du fichier est ignoré");
  assert.equal(a.claims.exp - a.claims.iat, 3600);
  // Seuls les deux hôtes de Google sont appelés.
  assert.ok(e.google.calls.urls.every((u) => u.startsWith("https://oauth2.googleapis.com/") || u.startsWith("https://www.googleapis.com/")));
  // Jeton révoqué plus tôt : un nouveau est demandé, l'appel rejoué une fois.
  const r = env({ rows: ROWS, rejectFirstApiCall: true });
  await r.searchConsole.read(HOST, 28);
  assert.equal(r.google.calls.token, 2);
});

test("lecture directe : quatre lectures paginées, conversion, source « google », requêtes par page", async () => {
  const e = env({ rows: ROWS });
  const res = await e.app.request(`${e.base}/search-console/sync`, post({ days: 90 }));
  const text = await res.text();
  assert.equal(res.status, 200, text);
  assert.ok(!text.includes("PRIVATE KEY") && !text.includes("cle-secrete-123") && !text.includes("jeton-google"));
  const data = JSON.parse(text);
  assert.equal(data.source, "google");
  assert.deepEqual(data.series, [{ date: "2026-11-01", clicks: 6, impressions: 300 }, { date: "2026-11-02", clicks: 4, impressions: 100 }]);
  assert.deepEqual(data.period, { start: "2026-11-01", end: "2026-11-02" });
  assert.deepEqual(data.totals, { clicks: 10, impressions: 400, ctr: 0.025, position: 7 });
  assert.deepEqual(data.queries.map((q: any) => q.query), ["atelier lune", "poterie nantes"]);
  assert.equal(data.queries[1].position, 8.2);
  assert.deepEqual(data.pages.map((p: any) => p.path), ["/boutique"], "pages d'un autre site écartées");
  assert.deepEqual(data.matching, { matched: 1, total: 1 });
  const dims = e.google.calls.queries.map((q) => q.dimensions.join(","));
  assert.deepEqual(dims, ["date", "query", "page", "page,query"]);
  assert.ok(e.google.calls.queries.every((q) => q.property === `sc-domain:${HOST}` && q.rowLimit === 25000 && q.startRow === 0));
  const { start, end } = periodFor(90, Date.now());
  assert.equal(e.google.calls.queries[0].startDate, start);
  assert.equal(e.google.calls.queries[0].endDate, end);
  // PageDetail.queries : renseigné par page + requête ; [] pour une page sans requête.
  const page = ((await (await e.app.request(`${e.base}/pages/${e.ids["/boutique"]}`)).json()) as any).page;
  assert.deepEqual(page.queries.map((q: any) => [q.query, q.clicks]), [["atelier lune", 6], ["poterie nantes", 2]]);
  assert.deepEqual(page.organic, { clicks: 8, impressions: 200, position: 5 });
  const home = ((await (await e.app.request(`${e.base}/pages/${e.ids["/"]}`)).json()) as any).page;
  assert.deepEqual(home.queries, []);
  // Une lecture par minute.
  const again = await e.app.request(`${e.base}/search-console/sync`, post({ days: 28 }));
  assert.equal(again.status, 429);
  // Paramètres et période.
  assert.equal(((await (await e.app.request("/api/settings")).json()) as any).integrations.searchConsole.configured, true);
  assert.equal((await e.app.request(`${e.base}/search-console/sync`, post({ days: 7 }))).status, 400);
});

test("pagination : au-delà de 25 000 lignes, les pages suivantes sont lues", async () => {
  const many = Array.from({ length: 25_001 }, (_, i) => ({ keys: [`requete ${i}`], clicks: 0, impressions: 1, ctr: 0, position: 50 }));
  const e = env({ rows: { ...ROWS, query: many } });
  const { data } = await e.searchConsole.read(HOST, 28);
  assert.equal(data.queries!.length, 25_001);
  assert.deepEqual(e.google.calls.queries.filter((q) => q.dimensions[0] === "query" && q.dimensions.length === 1).map((q) => q.startRow), [0, 25_000]);
});

test("propriété introuvable : search_console_no_access, avec l'adresse du compte de service et la marche à suivre", async () => {
  const e = env({ sites: [{ siteUrl: "sc-domain:autre-site.example", permissionLevel: "siteOwner" }, { siteUrl: `https://${HOST}/`, permissionLevel: "siteUnverifiedUser" }] });
  const res = await e.app.request(`${e.base}/search-console/sync`, post({}));
  const text = await res.text();
  assert.equal(res.status, 403);
  const err = JSON.parse(text).error;
  assert.equal(err.code, "search_console_no_access");
  assert.equal(err.details.account, EMAIL);
  assert.match(err.action, /Utilisateurs et autorisations/);
  assert.ok(text.includes(EMAIL) && !text.includes("PRIVATE KEY") && !text.includes("cle-secrete"));
  assert.equal(e.google.calls.queries.length, 0);
  // Variantes : https://www.hôte/ trouvé ; GSC_PROPERTY utilisé s'il correspond à l'hôte.
  const www = env({ rows: ROWS, sites: [{ siteUrl: `https://www.${HOST}/`, permissionLevel: "siteFullUser" }] });
  assert.equal((await www.searchConsole.read(HOST, 28)).property, `https://www.${HOST}/`);
  const fixed = env({ rows: ROWS, property: `https://${HOST}/` });
  assert.equal((await fixed.searchConsole.read(HOST, 28)).property, `https://${HOST}/`);
  assert.ok(!fixed.google.calls.urls.some((u) => u.endsWith("/webmasters/v3/sites")), "pas de recherche quand GSC_PROPERTY correspond");
});

test("non configurée : search_console_not_configured, sans appel à Google ; clé refusée : search_console_unavailable", async () => {
  const e = env({ file: path.join(dir, "absent.json") });
  const res = await e.app.request(`${e.base}/search-console/sync`, post({ days: 28 }));
  assert.equal(res.status, 503);
  assert.equal(((await res.json()) as any).error.code, "search_console_not_configured");
  assert.equal(e.google.calls.urls.length, 0);
  assert.equal(((await (await e.app.request("/api/settings")).json()) as any).integrations.searchConsole.configured, false);
  // Fichier présent mais clé qui ne correspond pas : Google refuse l'assertion.
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const wrong = path.join(dir, "autre.json");
  writeFileSync(wrong, JSON.stringify({ client_email: EMAIL, private_key: other }));
  const w = env({ file: wrong });
  const r = await w.app.request(`${w.base}/search-console/sync`, post({ days: 28 }));
  const body = (await r.json()) as any;
  assert.equal(r.status, 502);
  assert.equal(body.error.code, "search_console_unavailable");
  assert.equal(body.error.details.retryable, false);
});

test("conversion : textes bornés, dates invalides écartées, totaux pondérés", () => {
  const data = toImport(
    {
      dates: [{ keys: ["pas une date"], clicks: 1, impressions: 1 }, { keys: ["2026-10-01"], clicks: 1, impressions: 10, position: 3 }],
      queries: [{ keys: ["a\u0000b"], clicks: 1, impressions: 2, ctr: 0.5, position: 1 }],
      pages: [],
      pairs: [],
    },
    `www.${HOST}`,
    { start: "2026-09-01", end: "2026-10-01" },
  );
  assert.equal(data.series!.length, 1);
  assert.equal(data.seriesPosition, 3);
  assert.equal(data.queries![0].query, "a b");
  assert.deepEqual(data.pageQueries, {});
  const empty = toImport({ dates: [], queries: [], pages: [], pairs: [] }, HOST, { start: "2026-09-01", end: "2026-10-01" });
  assert.deepEqual(empty.period, { start: "2026-09-01", end: "2026-10-01" });
  assert.equal(empty.series, null);
  assert.ok(new SearchConsoleClient({ file: FILE, property: null }).configured);
});
