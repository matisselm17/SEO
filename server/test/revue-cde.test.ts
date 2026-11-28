/**
 * Revue des lots C, D et E côté serveur (docs/format-echange.md, « Exploitation (lot D) », « Évolution et rapport ») :
 * plafond de jetons d'IA qui compte aussi l'assistant (mode intégré), sections masquées (outils de l'assistant et
 * détail d'une page), /healthz par une vraie lecture, sauvegarde datée dans le futur. Client Claude simulé et faux
 * Shopify : aucun appel réseau réel.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { addUsage, DEFAULT_POLICY, getUsage, setPolicy } from "../src/automation/policy.ts";
import { listBackups, startBackups } from "../src/db-backup.ts";
import { openDb } from "../src/db.ts";
import { Store } from "../src/store.ts";
import { insertDoneAudit } from "./helpers/boutique.ts";
import { SHOP_A, SHOP_B, twoShops, withToken } from "./helpers/boutiques.ts";
import { post, readSse, testEnv } from "./helpers/env.ts";
import { mockClaude } from "./helpers/mock-claude.ts";

const read = async (res: Response) => {
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as any) : null };
};
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "chat-seo-revue-cde-"));
const LIMIT = 10_000;
const capAt = (store: Store, siteId: string) => setPolicy(store.db, siteId, { ...structuredClone(DEFAULT_POLICY), aiTokensPerDay: LIMIT }, new Date().toISOString());

// ───────── 7. Plafond de jetons d'IA : l'assistant compte (mode intégré)

test("assistant (intégré) : jetons comptés dans le compteur du jour ; plafond atteint → budget_exceeded avant tout appel à l'IA ; l'autre boutique n'est pas touchée", async () => {
  const client = mockClaude([
    { tools: [{ name: "vue_ensemble", input: {} }], usage: { input_tokens: 3000, output_tokens: 1000 } },
    { text: ["Voici la réponse."], usage: { input_tokens: 2500, output_tokens: 500 } },
  ]);
  const ctx = await twoShops({ config: { embeddedFeatures: ["assistant"] }, chatClient: client });
  capAt(ctx.store, ctx.A.site.id);
  const hostA = ctx.A.site.host;
  const before = getUsage(ctx.store.db, hostA, Date.now()).aiTokens;
  const res = await ctx.app.request(`${ctx.A.base}/chat`, withToken(SHOP_A, post({ message: "Bonjour" })));
  assert.equal(res.status, 200);
  await readSse(res);
  // Entrée et sortie, tous les tours.
  assert.equal(getUsage(ctx.store.db, hostA, Date.now()).aiTokens - before, 7000);
  // Plafond atteint (par l'assistant et la préparation confondus).
  addUsage(ctx.store.db, hostA, Date.now(), { aiTokens: LIMIT });
  const calls = client.requests.length;
  const over = await read(await ctx.app.request(`${ctx.A.base}/chat`, withToken(SHOP_A, post({ message: "Encore" }))));
  assert.equal(over.status, 429);
  assert.equal(over.body.error.code, "budget_exceeded");
  assert.equal(typeof over.body.error.details.resetsAt, "string");
  assert.equal(client.requests.length, calls, "appel à l'IA malgré le plafond");
  // B : son propre compteur.
  const b = await ctx.app.request(`${ctx.B.base}/chat`, withToken(SHOP_B, post({ message: "Bonjour" })));
  assert.equal(b.status, 200);
  await readSse(b);
});

test("assistant (intégré) : plafond franchi pendant la conversation → aucun tour suivant, erreur budget_exceeded dans le flux", async () => {
  const client = mockClaude([
    { tools: [{ name: "vue_ensemble", input: {} }], usage: { input_tokens: 8000, output_tokens: 4000 } },
    { text: ["Jamais demandé."] },
  ]);
  const ctx = await twoShops({ config: { embeddedFeatures: ["assistant"] }, chatClient: client });
  capAt(ctx.store, ctx.A.site.id);
  const before = client.requests.length;
  const res = await ctx.app.request(`${ctx.A.base}/chat`, withToken(SHOP_A, post({ message: "Bonjour" })));
  assert.equal(res.status, 200);
  const events = await readSse(res);
  assert.equal(client.requests.length - before, 1, "second tour demandé au-delà du plafond");
  const text = JSON.stringify(events);
  assert.match(text, /budget_exceeded/);
});

test("assistant (local) : inchangé, jamais plafonné par les jetons du jour", async () => {
  const env = testEnv({ chatClient: mockClaude([{ text: ["Bonjour."] }]) });
  const site = env.store.insertSite("https://local.example/", "local.example", "Local");
  insertDoneAudit(env.store, site.id, "local.example", ["/"]);
  capAt(env.store, site.id);
  addUsage(env.store.db, "local.example", Date.now(), { aiTokens: 10 * LIMIT });
  const res = await env.app.request(`/api/sites/${site.id}/chat`, post({ message: "Bonjour" }));
  assert.equal(res.status, 200);
  await readSse(res);
});

// ───────── 9. Sections masquées : outils de l'assistant et détail d'une page

const toolNames = (client: ReturnType<typeof mockClaude>) => (client.requests.at(-1)?.tools ?? []).map((t: any) => t.name as string);

test("sections masquées (intégré) : l'assistant n'a pas les outils des sections fermées ; un appel forcé ne rend rien", async () => {
  const closed = mockClaude([{ tools: [{ name: "concurrents", input: {} }] }, { text: ["ok"] }]);
  const ctx = await twoShops({ config: { embeddedFeatures: ["assistant"] }, chatClient: closed });
  ctx.store.setCompetitors(ctx.A.site.id, { available: true, checkedAt: new Date().toISOString(), marqueur: "CONCURRENT-SECRET" } as any);
  const res = await ctx.app.request(`${ctx.A.base}/chat`, withToken(SHOP_A, post({ message: "Mes concurrents ?" })));
  await readSse(res);
  for (const n of ["concurrents", "vitesse_des_pages", "visites_google_analytics"]) assert.ok(!toolNames(closed).includes(n), `outil ${n} donné`);
  assert.ok(toolNames(closed).includes("vue_ensemble"));
  assert.ok(!JSON.stringify(closed.requests.at(-1)?.messages).includes("CONCURRENT-SECRET"), "donnée d'une section masquée transmise");

  const open = mockClaude([{ text: ["ok"] }]);
  const ctx2 = await twoShops({ config: { embeddedFeatures: ["assistant", "competitors", "pagespeed"] }, chatClient: open });
  await readSse(await ctx2.app.request(`${ctx2.A.base}/chat`, withToken(SHOP_A, post({ message: "Bonjour" }))));
  assert.ok(toolNames(open).includes("concurrents") && toolNames(open).includes("vitesse_des_pages"));
  assert.ok(!toolNames(open).includes("visites_google_analytics"), "analytics jamais ouverte en mode intégré");
});

/** Visites et vitesse enregistrées pour la page d'accueil du site. */
function seedVisitsAndSpeed(store: Store, siteId: string, host: string) {
  const at = new Date().toISOString();
  const totals = { sessions: 12, users: 10, engagedSessions: 6, conversions: 0, revenue: null };
  store.db
    .prepare("INSERT OR REPLACE INTO analytics (site_id, synced_at, data_json) VALUES (?, ?, ?)")
    .run(siteId, at, JSON.stringify({ period: { start: "2026-10-29", end: "2026-11-27" }, totals, landingPages: [{ path: "/", pageId: null, score: null, ...totals, organicSessions: 4 }] }));
  const measure = JSON.stringify({ score: 0.8, lab: { lcpMs: 1000 }, field: null, opportunities: [], measuredAt: at });
  store.db.prepare("INSERT OR REPLACE INTO pagespeed_pages (site_id, path_key, url, path, updated_at, mobile_json, desktop_json) VALUES (?, '/', ?, '/', ?, ?, ?)").run(siteId, `https://${host}/`, at, measure, measure);
}

test("sections masquées : le détail d'une page rend visits null et speed null en mode intégré ; renseignés en mode local", async () => {
  const ctx = await twoShops();
  seedVisitsAndSpeed(ctx.store, ctx.A.site.id, ctx.A.site.host);
  const home = ctx.store.pageRows(ctx.store.resultsAudit(ctx.A.site.id)!.id).find((p) => p.path === "/")!;
  const page = await read(await ctx.app.request(`${ctx.A.base}/pages/${home.id}`, withToken(SHOP_A)));
  assert.equal(page.status, 200);
  assert.equal(page.body.page.visits, null);
  assert.equal(page.body.page.speed, null);

  const env = testEnv();
  const site = env.store.insertSite("https://local.example/", "local.example", "Local");
  insertDoneAudit(env.store, site.id, "local.example", ["/"]);
  seedVisitsAndSpeed(env.store, site.id, "local.example");
  const row = env.store.pageRows(env.store.resultsAudit(site.id)!.id).find((p) => p.path === "/")!;
  const local = await read(await env.app.request(`/api/sites/${site.id}/pages/${row.id}`));
  assert.equal(local.body.page.visits?.sessions, 12, "visites absentes en mode local");
  assert.ok(local.body.page.speed, "vitesse absente en mode local");
});

// ───────── 10. /healthz et sauvegardes

test("healthz : une base ouverte mais illisible (table des migrations absente) répond 503 {\"ok\":false}", async () => {
  const env = testEnv();
  assert.equal((await env.app.request("/healthz")).status, 200);
  env.store.db.exec("DROP TABLE schema_migrations");
  const res = await env.app.request("/healthz");
  assert.equal(res.status, 503);
  assert.equal(await res.text(), '{"ok":false}');
});

test("sauvegardes : une copie datée dans le futur est ignorée, elle ne bloque pas les suivantes ni la rotation", () => {
  const dir = tmp();
  const store = new Store(openDb(dir));
  mkdirSync(path.join(dir, "backups"), { recursive: true });
  writeFileSync(path.join(dir, "backups", "chat-seo-20300101T000000Z.sqlite"), "");
  let t = Date.parse("2026-11-01T00:00:00Z");
  const b = startBackups({ db: store.db, dataDir: dir, hours: 24, keep: 2, now: () => t, checkEveryMs: 1000, setInterval: () => ({}), clearInterval: () => {} });
  const past = () => listBackups(dir).filter((x) => x.at <= t).map((x) => x.name);
  assert.equal(past().length, 1, "première copie bloquée par la copie du futur");
  t += 25 * 3_600_000;
  assert.equal(b.tick(), true);
  t += 25 * 3_600_000;
  assert.equal(b.tick(), true);
  assert.deepEqual(past(), ["chat-seo-20261103T020000Z.sqlite", "chat-seo-20261102T010000Z.sqlite"], "rotation faussée par la copie du futur");
  b.stop();
  store.db.close();
});
