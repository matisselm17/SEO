/**
 * Google Analytics 4 (lecture seule) : jeton de portée analytics.readonly, filtre sur l'hôte, conversion,
 * rapprochement des pages d'arrivée, revenue null, erreurs. Faux Google (fetch simulé), clé RSA générée ici.
 */
import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { parseGa4PropertyId } from "../src/config.ts";
import { analyticsPeriod, toAnalytics } from "../src/google/analytics.ts";
import { GOOGLE_BODY_LIMITS, readJsonBounded } from "../src/google/auth.ts";
import { runTool } from "../src/chat/tools.ts";
import { insertDoneAudit } from "./helpers/boutique.ts";
import { post, testEnv } from "./helpers/env.ts";

const dir = mkdtempSync(path.join(os.tmpdir(), "ga4-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const EMAIL = "lecture-seo@projet-essai.iam.gserviceaccount.com";
const FILE = path.join(dir, "compte.json");
writeFileSync(FILE, JSON.stringify({ type: "service_account", client_email: EMAIL, private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), private_key_id: "cle-secrete-ga" }));
const HOST = "atelier-lune.example";
const PROPERTY = "123456789";
/** Instant fixe : la période lue (et donc la série complétée) ne dépend pas de la date du jour. */
const NOW = Date.parse("2026-11-27T10:00:00Z");

type Row = { dimensionValues: Array<{ value: string }>; metricValues: Array<{ value: string }> };
const row = (dims: string[], metrics: Array<number | string>): Row => ({ dimensionValues: dims.map((value) => ({ value })), metricValues: metrics.map((m) => ({ value: String(m) })) });

interface FakeOpts {
  status?: number;
  reason?: string;
  /** Aucune visite sur l'hôte du site, mais des visites ailleurs dans la propriété. */
  noVisits?: boolean;
  /** Propriété sans aucune visite (site neuf). */
  emptyProperty?: boolean;
  revenue?: boolean;
  restricted?: boolean;
}

/** Réponses du faux Google Analytics, selon les dimensions demandées. */
function reports(o: FakeOpts) {
  const rev = (n: number) => (o.revenue === false ? 0 : n);
  return {
    channels: o.noVisits || o.emptyProperty
      ? { rows: [], rowCount: 0, metadata: { currencyCode: "EUR" } }
      : {
          rows: [row(["Direct"], [40, 35, 0.5, 2, rev(100)]), row(["Organic Search"], [60, 50, 0.7, 3, rev(250.5)])],
          totals: [row(["RESERVED_TOTAL"], [100, 80, 0.62, 5, rev(350.5)])],
          metadata: { currencyCode: "EUR", ...(o.restricted ? { schemaRestrictionResponse: { activeMetricRestrictions: [{ metricName: "purchaseRevenue", restrictedMetricTypes: ["REVENUE_DATA"] }] } } : {}) },
        },
    series: { rows: [row(["20261102", "Organic Search"], [30]), row(["20261101", "Direct"], [40]), row(["20261101", "Organic Search"], [30])] },
    landing: {
      rows: [
        row(["/Products/Bague-Or/"], [50, 45, 0.8, 3, rev(250.5)]),
        row(["/"], [45, 40, 0.5, 2, rev(100)]),
        row(["(not set)"], [5, 5, 0, 0, 0]),
        row(["/pages/inconnue"], [3, 3, 1, 0, 0]),
      ],
    },
    landingOrganic: { rows: [row(["/"], [10]), row(["/Products/Bague-Or/"], [40])] },
    /** Rapport sans dimension ni filtre : toute la propriété. */
    property: o.emptyProperty ? { rowCount: 0 } : { rows: [row([], [12])], rowCount: 1 },
  };
}

function fakeGoogle(o: FakeOpts = {}) {
  const calls = { urls: [] as string[], bodies: [] as any[], scopes: [] as string[] };
  let token = 0;
  const impl = (async (url: string, init: RequestInit) => {
    calls.urls.push(url);
    if (url === "https://oauth2.googleapis.com/token") {
      const [h, c, s] = new URLSearchParams(String(init.body)).get("assertion")!.split(".");
      const v = createVerify("RSA-SHA256");
      v.update(`${h}.${c}`);
      if (!v.verify(publicKey, Buffer.from(s, "base64url"))) return new Response("{}", { status: 400 });
      calls.scopes.push(JSON.parse(Buffer.from(c, "base64url").toString()).scope);
      return Response.json({ access_token: `jeton-${++token}`, expires_in: 3599 });
    }
    if (!(init.headers as Record<string, string>).authorization?.startsWith("Bearer jeton-")) return new Response("{}", { status: 401 });
    if (url === `https://analyticsdata.googleapis.com/v1beta/properties/${PROPERTY}:runReport`) {
      if (o.status) return Response.json({ error: { code: o.status, status: "PERMISSION_DENIED", message: `refus détaillé ${EMAIL} cle-secrete-ga`, details: o.reason ? [{ reason: o.reason }] : [] } }, { status: o.status });
      const body = JSON.parse(String(init.body));
      calls.bodies.push(body);
      const r = reports(o);
      const dims = (body.dimensions ?? []).map((d: any) => d.name).join(",");
      if (dims === "" && !body.dimensionFilter) return Response.json(r.property);
      if (dims === "sessionDefaultChannelGroup") return Response.json(r.channels);
      if (dims === "date,sessionDefaultChannelGroup") return Response.json(r.series);
      if (dims === "landingPage") return Response.json(body.dimensionFilter.andGroup ? r.landingOrganic : r.landing);
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function env(o: FakeOpts & { property?: string | null; file?: string } = {}) {
  const google = fakeGoogle(o);
  const e = testEnv({ google: { file: o.file ?? FILE, fetchImpl: google.impl, now: () => NOW, ga4PropertyId: o.property === undefined ? PROPERTY : o.property } });
  const site = e.store.insertSite(`https://${HOST}/`, HOST, null);
  const { ids } = insertDoneAudit(e.store, site.id, HOST, ["/", "/products/bague-or", "/pages/contact"]);
  return { ...e, google, site, ids, base: `/api/sites/${site.id}` };
}

test("GA4 : jeton de portée analytics.readonly, filtre sur l'hôte, conversion et rapprochement des pages", async () => {
  const e = env();
  const events: string[] = [];
  e.hub.subscribe(e.site.id, (ev) => events.push(ev.type));
  assert.deepEqual(await (await e.app.request(`${e.base}/analytics`)).json(), { available: false, reason: "not_run" });
  const res = await e.app.request(`${e.base}/analytics/sync`, post({ days: 90 }));
  const text = await res.text();
  assert.equal(res.status, 200, text);
  assert.ok(!text.includes("PRIVATE KEY") && !text.includes("cle-secrete-ga") && !text.includes("jeton-"));
  // Jeton : portée lecture seule de Google Analytics ; seuls les deux hôtes de Google sont appelés.
  assert.deepEqual(e.google.calls.scopes, ["https://www.googleapis.com/auth/analytics.readonly"]);
  assert.ok(e.google.calls.urls.every((u) => u === "https://oauth2.googleapis.com/token" || u.startsWith("https://analyticsdata.googleapis.com/")));
  // Chaque rapport est limité à l'hôte du site, avec et sans www, sur la période demandée.
  const period = analyticsPeriod(90, NOW);
  for (const b of e.google.calls.bodies) {
    const host = b.dimensionFilter.filter ?? b.dimensionFilter.andGroup.expressions[0].filter;
    assert.deepEqual(host, { fieldName: "hostName", inListFilter: { values: [HOST, `www.${HOST}`], caseSensitive: false } });
    assert.deepEqual(b.dateRanges, [{ startDate: period.start, endDate: period.end }]);
  }
  assert.deepEqual(e.google.calls.bodies[0].metrics.map((m: any) => m.name), ["sessions", "totalUsers", "engagementRate", "keyEvents", "purchaseRevenue"]);
  assert.deepEqual(e.google.calls.bodies[0].metricAggregations, ["TOTAL"]);
  const organicFilter = e.google.calls.bodies[3].dimensionFilter.andGroup.expressions[1].filter;
  assert.deepEqual(organicFilter, { fieldName: "sessionDefaultChannelGroup", stringFilter: { matchType: "EXACT", value: "Organic Search" } });

  const data = JSON.parse(text);
  assert.equal(data.available, true);
  assert.deepEqual(data.period, period);
  assert.equal(data.currency, "EUR");
  assert.deepEqual(data.totals, { sessions: 100, users: 80, engagementRate: 0.62, keyEvents: 5, revenue: 350.5 });
  assert.deepEqual(data.organic, { sessions: 60, users: 50, engagementRate: 0.7, keyEvents: 3, revenue: 250.5 });
  assert.deepEqual(data.channels.map((c: any) => [c.channel, c.sessions]), [["Organic Search", 60], ["Direct", 40]]);
  // Série : tous les jours de la période, à 0 les jours que Google omet.
  assert.equal(data.series.length, 90);
  assert.equal(data.series[0].date, period.start);
  assert.equal(data.series[89].date, period.end);
  assert.deepEqual(data.series.filter((p: any) => p.sessions > 0), [{ date: "2026-11-01", sessions: 70, organicSessions: 30 }, { date: "2026-11-02", sessions: 30, organicSessions: 30 }]);
  assert.equal(data.landingPagesTruncated, false);
  assert.equal(data.revenueStatus, "measured");
  // Pages d'arrivée : triées par visites organiques ; « (not set) » écarté ; rapprochement par chemin normalisé.
  assert.deepEqual(data.landingPages.map((p: any) => [p.path, p.organicSessions, p.pageId]), [
    ["/Products/Bague-Or/", 40, e.ids["/products/bague-or"]],
    ["/", 10, e.ids["/"]],
    ["/pages/inconnue", 0, null],
  ]);
  assert.equal(typeof data.landingPages[0].score, "number");
  assert.equal(data.landingPages[2].score, null);
  assert.ok(events.includes("analytics"));
  // PageDetail.visits ; null pour une page absente des pages d'arrivée.
  const page = ((await (await e.app.request(`${e.base}/pages/${e.ids["/products/bague-or"]}`)).json()) as any).page;
  assert.deepEqual(page.visits, { sessions: 50, users: 45, engagementRate: 0.8, keyEvents: 3, revenue: 250.5, organicSessions: 40 });
  const contact = ((await (await e.app.request(`${e.base}/pages/${e.ids["/pages/contact"]}`)).json()) as any).page;
  assert.equal(contact.visits, null);
  // Lecture stockée et relue ; rapprochement refait à l'affichage (nouvelle analyse sans la page → null).
  assert.equal(((await (await e.app.request(`${e.base}/analytics`)).json()) as any).totals.sessions, 100);
  insertDoneAudit(e.store, e.site.id, HOST, ["/"]);
  const again = (await (await e.app.request(`${e.base}/analytics`)).json()) as any;
  assert.equal(again.landingPages[0].pageId, null);
  assert.notEqual(again.landingPages[1].pageId, null);
  // Une lecture par minute ; périodes permises 28 ou 90.
  assert.equal((await e.app.request(`${e.base}/analytics/sync`, post({ days: 28 }))).status, 429);
  assert.equal((await e.app.request(`${e.base}/analytics/sync`, post({ days: 480 }))).status, 400);
  assert.equal((await e.app.request(`${e.base}/analytics/sync`, post({ days: 28, x: 1 }))).status, 400);
  assert.equal(((await (await e.app.request("/api/settings")).json()) as any).integrations.analytics.configured, true);
});

test("GA4 : revenue null quand aucune vente n'est mesurée (0 partout, ou métrique masquée)", async () => {
  for (const o of [{ revenue: false }, { restricted: true }]) {
    const e = env(o);
    const res = await e.app.request(`${e.base}/analytics/sync`, post({}));
    const data = (await res.json()) as any;
    assert.equal(res.status, 200);
    assert.equal(data.totals.revenue, null);
    assert.equal(data.organic.revenue, null);
    assert.ok(data.channels.every((c: any) => c.revenue === null));
    assert.ok(data.landingPages.every((p: any) => p.revenue === null));
    assert.equal(data.totals.sessions, 100, "les autres chiffres restent");
    assert.equal(data.revenueStatus, "restricted" in o ? "restricted" : "not_measured");
  }
});

test("GA4 : revenueStatus « restricted » même si un montant est renvoyé, « measured » sinon", () => {
  const r = reports({ restricted: true });
  const empty = { rows: [] };
  assert.equal(toAnalytics({ channels: r.channels, series: empty, landing: empty, landingOrganic: empty }, { start: "2026-11-01", end: "2026-11-02" }).revenueStatus, "restricted");
  const m = reports({});
  assert.equal(toAnalytics({ channels: m.channels, series: empty, landing: empty, landingOrganic: empty }, { start: "2026-11-01", end: "2026-11-02" }).revenueStatus, "measured");
});

test("GA4 : série quotidienne complète, à 0 les jours sans visite (Google les omet)", async () => {
  const e = env();
  const data = (await (await e.app.request(`${e.base}/analytics/sync`, post({ days: 28 }))).json()) as any;
  const period = analyticsPeriod(28, NOW);
  assert.deepEqual(data.period, period);
  assert.equal(data.series.length, 28);
  for (let i = 1; i < data.series.length; i++) {
    assert.equal(Date.parse(data.series[i].date) - Date.parse(data.series[i - 1].date), 86_400_000, "un point par jour, sans trou");
  }
  assert.deepEqual(data.series.find((p: any) => p.date === "2026-11-03"), { date: "2026-11-03", sessions: 0, organicSessions: 0 });
  assert.deepEqual(data.series.find((p: any) => p.date === "2026-11-01"), { date: "2026-11-01", sessions: 70, organicSessions: 30 });
  // Une ligne hors de la période (ne devrait pas arriver) n'ajoute pas de jour.
  const out = toAnalytics({ channels: reports({}).channels, series: { rows: [row(["20250101", "Direct"], [5])] }, landing: {}, landingOrganic: {} }, { start: "2026-11-01", end: "2026-11-03" });
  assert.deepEqual(out.series.map((p) => [p.date, p.sessions]), [["2026-11-01", 0], ["2026-11-02", 0], ["2026-11-03", 0]]);
});

test("GA4 : site neuf (aucune visite dans toute la propriété) → lecture réussie à zéro", async () => {
  const e = env({ emptyProperty: true });
  const res = await e.app.request(`${e.base}/analytics/sync`, post({ days: 28 }));
  const data = (await res.json()) as any;
  assert.equal(res.status, 200);
  assert.equal(data.available, true);
  assert.deepEqual(data.totals, { sessions: 0, users: 0, engagementRate: 0, keyEvents: 0, revenue: null });
  assert.equal(data.organic.sessions, 0);
  assert.deepEqual(data.channels, []);
  assert.equal(data.series.length, 28);
  assert.ok(data.series.every((p: any) => p.sessions === 0 && p.organicSessions === 0));
  assert.deepEqual(data.landingPages, []);
  assert.equal(data.landingPagesTruncated, false);
  assert.equal(data.revenueStatus, "not_measured");
  assert.equal(e.google.calls.bodies.length, 2, "rapport par origine, puis un seul rapport sur toute la propriété");
  assert.equal(((await (await e.app.request(`${e.base}/analytics`)).json()) as any).available, true, "lecture enregistrée");
});

test("GA4 : pages d'arrivée de même chemin additionnées avant la troncature ; visites de la page = la liste", async () => {
  const e = env();
  const period = { start: "2026-11-01", end: "2026-11-02" };
  const landing = {
    rows: [
      row(["/products/bague-or"], [30, 20, 0.5, 1, 100]),
      row(["/"], [25, 20, 0.4, 0, 0]),
      row(["/Products/Bague-Or/"], [10, 8, 1, 2, 50.5]),
      row(["/products/bague-or?utm_source=x"], [10, 9, 0, 0, 0]),
    ],
  };
  const landingOrganic = { rows: [row(["/products/bague-or"], [12]), row(["/products/bague-or/"], [3]), row(["/"], [20])] };
  const stored = toAnalytics({ channels: reports({}).channels, series: {}, landing, landingOrganic }, period);
  assert.equal(stored.landingPages.length, 2);
  const bague = stored.landingPages.find((p) => p.path === "/products/bague-or")!;
  assert.deepEqual(bague, { path: "/products/bague-or", sessions: 50, users: 37, engagementRate: 0.5, keyEvents: 3, revenue: 150.5, organicSessions: 15 });
  assert.deepEqual(stored.landingPages.map((p) => p.path), ["/", "/products/bague-or"], "tri sur les visites organiques additionnées");
  e.store.setAnalytics(e.site.id, stored);
  const list = ((await (await e.app.request(`${e.base}/analytics`)).json()) as any).landingPages;
  const page = ((await (await e.app.request(`${e.base}/pages/${e.ids["/products/bague-or"]}`)).json()) as any).page;
  const inList = list.find((p: any) => p.pageId === e.ids["/products/bague-or"]);
  assert.equal(page.visits.sessions, 50);
  assert.deepEqual(page.visits, { sessions: inList.sessions, users: inList.users, engagementRate: inList.engagementRate, keyEvents: inList.keyEvents, revenue: inList.revenue, organicSessions: inList.organicSessions });

  // Lecture enregistrée avant l'addition (doublons en base) : la liste et la page donnent la même somme.
  e.store.db.prepare("UPDATE analytics SET data_json = ? WHERE site_id = ?").run(JSON.stringify({
    ...stored,
    landingPagesTruncated: undefined,
    revenueStatus: undefined,
    landingPages: [
      { path: "/products/bague-or", sessions: 4, users: 4, engagementRate: 0.5, keyEvents: 0, revenue: null, organicSessions: 1 },
      { path: "/Products/Bague-Or/", sessions: 6, users: 6, engagementRate: 1, keyEvents: 1, revenue: null, organicSessions: 5 },
    ],
  }), e.site.id);
  const old = (await (await e.app.request(`${e.base}/analytics`)).json()) as any;
  assert.equal(old.landingPages.length, 1);
  assert.equal(old.landingPages[0].sessions, 10);
  assert.equal(old.landingPages[0].engagementRate, 0.8);
  assert.equal(old.landingPagesTruncated, false);
  assert.equal(old.revenueStatus, "measured");
  const oldPage = ((await (await e.app.request(`${e.base}/pages/${e.ids["/products/bague-or"]}`)).json()) as any).page;
  assert.equal(oldPage.visits.sessions, 10);
  assert.equal(oldPage.visits.organicSessions, 6);
});

test("GA4 : landingPagesTruncated au-delà de 200 pages ou quand la limite de lignes de Google est atteinte", () => {
  const period = { start: "2026-11-01", end: "2026-11-02" };
  const channels = reports({}).channels;
  const many = { rows: Array.from({ length: 250 }, (_, i) => row([`/p/${i}`], [250 - i, 1, 0.5, 0, 0])) };
  const a = toAnalytics({ channels, series: {}, landing: many, landingOrganic: {} }, period);
  assert.equal(a.landingPages.length, 200);
  assert.equal(a.landingPagesTruncated, true);
  // 250 lignes qui se réduisent à 150 chemins : pas de troncature.
  const dup = { rows: Array.from({ length: 250 }, (_, i) => row([i < 150 ? `/q/${i}` : `/Q/${i - 100}/`], [5, 1, 0.5, 0, 0])) };
  const b = toAnalytics({ channels, series: {}, landing: dup, landingOrganic: {} }, period);
  assert.equal(b.landingPages.length, 150);
  assert.equal(b.landingPagesTruncated, false);
  // Peu de lignes renvoyées, mais Google en compte davantage (rowCount) : la liste est incomplète.
  const c = toAnalytics({ channels, series: {}, landing: { rows: [row(["/"], [5, 1, 0.5, 0, 0])], rowCount: 5000 }, landingOrganic: {} }, period);
  assert.equal(c.landingPagesTruncated, true);
  const d = toAnalytics({ channels, series: {}, landing: { rows: [row(["/"], [5, 1, 0.5, 0, 0])], rowCount: 1 }, landingOrganic: {} }, period);
  assert.equal(d.landingPagesTruncated, false);
});

/** Corps en flux de `chunks` morceaux de 1 Mio, sans longueur annoncée ; `pulled` compte les morceaux lus. */
function bigStream(chunks: number) {
  const piece = new Uint8Array(1024 * 1024).fill(0x20);
  const state = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (state.pulled >= chunks) return c.close();
      state.pulled++;
      c.enqueue(piece);
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { body, state };
}

test("réponses de Google bornées : longueur annoncée ou flux trop long → arrêt sans tout lire", async () => {
  const declared = new Response("{}", { headers: { "content-length": String(10 * 1024 * 1024) } });
  assert.deepEqual(await readJsonBounded(declared, 1024), { ok: false, reason: "too_large" });
  const s = bigStream(50);
  assert.deepEqual(await readJsonBounded(new Response(s.body), 3 * 1024 * 1024), { ok: false, reason: "too_large" });
  assert.ok(s.state.pulled <= 5 && s.state.cancelled, "lecture arrêtée à la borne");
  assert.deepEqual(await readJsonBounded(new Response('{"a":1}'), 1024), { ok: true, json: { a: 1 } });
  assert.deepEqual(await readJsonBounded(new Response("pas du json"), 1024), { ok: false, reason: "invalid" });
  assert.equal(GOOGLE_BODY_LIMITS.analytics, 16 * 1024 * 1024);

  // Google Analytics : une réponse au-delà de 16 Mio donne analytics_unavailable, rien d'enregistré.
  const big = bigStream(40);
  const base = fakeGoogle();
  const impl = (async (url: string, init: RequestInit) => (url.includes(":runReport") ? new Response(big.body, { status: 200 }) : base.impl(url, init))) as unknown as typeof fetch;
  const e = testEnv({ google: { file: FILE, fetchImpl: impl, now: () => NOW, ga4PropertyId: PROPERTY } });
  const site = e.store.insertSite(`https://${HOST}/`, HOST, null);
  const res = await e.app.request(`/api/sites/${site.id}/analytics/sync`, post({}));
  const err = ((await res.json()) as any).error;
  assert.equal(res.status, 502);
  assert.equal(err.code, "analytics_unavailable");
  assert.match(err.message, /trop volumineuse/);
  assert.ok(big.state.pulled <= 18, `lecture arrêtée vers 16 Mio (${big.state.pulled} Mio lus)`);
  assert.equal(e.store.getAnalytics(site.id), null);
});

test("GA4 : 403 → analytics_no_access avec l'adresse du compte, API non activée → analytics_unavailable, rien d'enregistré", async () => {
  const e = env({ status: 403 });
  const res = await e.app.request(`${e.base}/analytics/sync`, post({ days: 28 }));
  const text = await res.text();
  assert.equal(res.status, 403);
  const err = JSON.parse(text).error;
  assert.equal(err.code, "analytics_no_access");
  assert.equal(err.details.account, EMAIL);
  assert.match(err.action, /Lecteur/);
  assert.ok(!text.includes("refus détaillé") && !text.includes("cle-secrete-ga"), "le corps de Google n'est pas recopié");
  assert.equal(e.store.getAnalytics(e.site.id), null);
  const d = env({ status: 403, reason: "SERVICE_DISABLED" });
  const r2 = await d.app.request(`${d.base}/analytics/sync`, post({}));
  const b2 = (await r2.json()) as any;
  assert.equal(r2.status, 502);
  assert.equal(b2.error.code, "analytics_unavailable");
  assert.equal(b2.error.details.retryable, false);
  const u = env({ status: 503 });
  const b3 = (await (await u.app.request(`${u.base}/analytics/sync`, post({}))).json()) as any;
  assert.equal(b3.error.code, "analytics_unavailable");
  assert.equal(b3.error.details.retryable, true);
});

test("GA4 : aucune visite sur l'hôte du site → analytics_other_site (409), rien d'enregistré", async () => {
  const e = env({ noVisits: true });
  const res = await e.app.request(`${e.base}/analytics/sync`, post({}));
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as any).error.code, "analytics_other_site");
  assert.equal(e.google.calls.bodies.length, 2, "un seul rapport en plus, sur toute la propriété");
  assert.equal(e.google.calls.bodies[1].dimensionFilter, undefined);
  assert.equal(e.google.calls.bodies[1].dimensions, undefined);
  assert.equal(e.google.calls.bodies[1].limit, "1");
  assert.deepEqual(await (await e.app.request(`${e.base}/analytics`)).json(), { available: false, reason: "not_run" });
});

test("GA4 : non configuré sans identifiant numérique ou sans fichier ; GA4_PROPERTY_ID purement numérique", async () => {
  assert.equal(parseGa4PropertyId(" 123456 "), "123456");
  assert.equal(parseGa4PropertyId("properties/123"), null);
  assert.equal(parseGa4PropertyId("G-ABC123"), null);
  assert.equal(parseGa4PropertyId(""), null);
  for (const e of [env({ property: null }), env({ file: path.join(dir, "absent.json") })]) {
    const res = await e.app.request(`${e.base}/analytics/sync`, post({}));
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as any).error.code, "analytics_not_configured");
    assert.equal(e.google.calls.urls.length, 0);
    assert.equal(((await (await e.app.request("/api/settings")).json()) as any).integrations.analytics.configured, false);
    assert.deepEqual(await (await e.app.request(`${e.base}/analytics`)).json(), { available: false, reason: "not_configured" });
  }
});

test("GA4 et Search Console : un jeton par portée avec le même compte de service", async () => {
  const e = env();
  await e.app.request(`${e.base}/analytics/sync`, post({}));
  await e.searchConsole.getToken();
  assert.deepEqual(e.google.calls.scopes, ["https://www.googleapis.com/auth/analytics.readonly", "https://www.googleapis.com/auth/webmasters.readonly"]);
});

test("assistant : outil de lecture des visites, chemins marqués comme données non fiables", async () => {
  const e = env();
  const none = runTool(e.store, e.site, "visites_google_analytics", {});
  assert.match(none.content, /"disponible":false/);
  await e.app.request(`${e.base}/analytics/sync`, post({}));
  const outcome = runTool(e.store, e.site, "visites_google_analytics", { chemin: "bague" });
  const data = JSON.parse(outcome.content);
  assert.equal(data.toutes_les_visites.sessions, 100);
  assert.equal(data.pages_d_arrivee.length, 1);
  assert.equal(data.pages_d_arrivee[0].chemin_donnee_non_fiable, "/Products/Bague-Or/");
  assert.equal(data.pages_d_arrivee[0].page_analysee, e.ids["/products/bague-or"]);
  assert.match(data.note, /donnee_non_fiable/);
  const detail = JSON.parse(runTool(e.store, e.site, "detail_page", { page: "/products/bague-or" }).content);
  assert.equal(detail.visites_google_analytics.organicSessions, 40);
});
