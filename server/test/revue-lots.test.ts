/**
 * Corrections de la revue QA et sécurité des lots et de l'automatisation : écritures simultanées (B1), lots de
 * l'assistant jamais automatiques (I1a), filtre de contenu (I1b), caractères invisibles (I1c), verrous revérifiés
 * après l'attente de cadence (I2), arrêt d'un lot (I3), limites de débit et lectures cadencées (I7), marque
 * « automatique » par ligne (mineur 1), réponse de l'IA après abandon (mineur 2).
 * Faux Shopify et client Claude simulé : aucune écriture réelle, aucun appel à l'API Claude.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AutomationPolicy } from "../../shared/api.ts";
import { autoGate, contentViolation, DEFAULT_POLICY, setPolicy } from "../src/automation/policy.ts";
import { normalizeValue } from "../src/shopify/service.ts";
import type { ChatClient } from "../src/chat/assistant.ts";
import { del, JSON_HEADERS, post, postEmpty } from "./helpers/env.ts";
import { defaultState } from "./helpers/fake-shopify.ts";
import { mockClaude, type Turn } from "./helpers/mock-claude.ts";
import { json, shop, type ShopSetup } from "./helpers/boutique.ts";

const put = (body: unknown) => ({ method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(body) });
const patch = (body: unknown) => ({ method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(body) });
const DESC_RING = "Bague en or 18 carats, finition polie, livrée dans son écrin : un bijou à offrir ou à s'offrir.";
const DESC_COLLECTION = "Toutes nos bagues en or et en argent, fabriquées en France, à porter seules ou accumulées.";
const DESC_EARRINGS = "Boucles d'oreilles en or 18 carats, légères et faciles à porter au quotidien.";
const answer = (valeur: string): Turn => ({ text: [JSON.stringify({ valeur, justification: "La page n'a pas de description." })] });
const isMutation = (init: RequestInit | undefined) => typeof init?.body === "string" && /^\s*\{"query":"mutation/.test(init.body);

type Ctx = Awaited<ReturnType<typeof shop>>;

async function setup(o: ShopSetup & { policy?: Partial<AutomationPolicy>; turns?: Turn[] } = {}) {
  const client = mockClaude(o.turns ?? []);
  const ctx = await shop({ chatClient: client, ...o });
  if (o.policy) {
    const r = await ctx.app.request(`${ctx.base}/automation`, put({ policy: { ...DEFAULT_POLICY, ...o.policy } }));
    assert.equal(r.status, 200, await r.clone().text());
  }
  return { ...ctx, client };
}

async function draft(ctx: Ctx, items: unknown[]) {
  const r = await json(await ctx.app.request(`${ctx.base}/shopify/batches`, post({ title: "Lot", items })));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.batch;
}
const ringLine = (ctx: Ctx) => ({ resourceId: ctx.byPath["/products/bague-or"].id, field: "seo_description", value: DESC_RING });
const collLine = (ctx: Ctx) => ({ resourceId: ctx.byPath["/collections/bagues"].id, field: "seo_description", value: DESC_COLLECTION });
const getBatch = async (ctx: Ctx, id: string) => ((await (await ctx.app.request(`${ctx.base}/shopify/batches/${id}`)).json()) as any).batch;

async function optimize(ctx: Awaited<ReturnType<typeof setup>>, body: Record<string, unknown>) {
  const r = await json(await ctx.app.request(`${ctx.base}/shopify/optimize`, post(body)));
  assert.equal(r.status, 202, JSON.stringify(r.body));
  await ctx.optimizer.wait(ctx.site.id);
  await ctx.batches.wait(ctx.site.id);
  return getBatch(ctx, r.body.batch.id);
}

/** Deux produits sans description : la bague (page en défaut, proposée d'abord) puis les boucles d'oreilles. */
function twoProducts() {
  const state = defaultState();
  state.products.push({ id: "gid://shopify/Product/3", handle: "boucles", title: "Boucles d'oreilles", meta: {}, media: [] });
  return state;
}

/** Bloque la n-ième mutation jusqu'à `release()`. */
function blocker(nth = 1) {
  let release: () => void = () => {};
  let blocked = false;
  let mutations = 0;
  const wrapFetch = (impl: typeof fetch) =>
    (async (url: string, init: RequestInit) => {
      if (isMutation(init)) {
        mutations++;
        if (mutations === nth) {
          blocked = true;
          await new Promise<void>((r) => (release = r));
        }
      }
      return impl(url, init);
    }) as unknown as typeof fetch;
  return {
    wrapFetch,
    release: () => release(),
    whenBlocked: async () => {
      while (!blocked) await new Promise((r) => setTimeout(r, 5));
    },
    count: () => mutations,
  };
}
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

// ───────── B1 : une seule écriture à la fois

test("B1 — deux « apply » simultanés du même lot : un 202, un limit_reached ; chaque ligne écrite une fois, état juste", async () => {
  const ctx = await shop();
  const b = await draft(ctx, [ringLine(ctx), collLine(ctx)]);
  const url = `${ctx.base}/shopify/batches/${b.id}/apply`;
  const [r1, r2] = await Promise.all([ctx.app.request(url, postEmpty()), ctx.app.request(url, postEmpty())].map(async (p) => json(await p)));
  assert.deepEqual([r1.status, r2.status].sort(), [202, 409]);
  assert.equal((r1.status === 409 ? r1 : r2).body.error.code, "limit_reached");
  await ctx.batches.wait(ctx.site.id);
  const done = await getBatch(ctx, b.id);
  assert.equal(done.state, "applied");
  assert.deepEqual(done.items.map((i: any) => [i.state, i.error]), [["applied", null], ["applied", null]]);
  assert.equal(ctx.fake.calls.mutations.length, 2, "une écriture par ligne, pas deux");
  const history = (await (await ctx.app.request(`${ctx.base}/shopify/changes`)).json()) as any;
  assert.equal(history.total, 2);
});

test("B1 — deux lots différents du même site lancés ensemble : le second attend (limit_reached), rien n'est écrit pour lui", async () => {
  const ctx = await shop();
  const a = await draft(ctx, [ringLine(ctx)]);
  const b = await draft(ctx, [collLine(ctx)]);
  const res = await Promise.all([a, b].map(async (x) => json(await ctx.app.request(`${ctx.base}/shopify/batches/${x.id}/apply`, postEmpty()))));
  assert.deepEqual(res.map((r) => r.status).sort(), [202, 409]);
  const loser = res[0].status === 409 ? a : b;
  assert.equal(res.find((r) => r.status === 409)!.body.error.code, "limit_reached");
  await ctx.batches.wait(ctx.site.id);
  assert.equal(ctx.fake.calls.mutations.length, 1);
  const l = await getBatch(ctx, loser.id);
  assert.equal(l.state, "draft", "le lot refusé reste un brouillon");
  assert.equal(l.items[0].state, "pending");
});

test("B1 — deux « restore » simultanés : un seul passe ; lignes annulées sans erreur contradictoire", async () => {
  const ctx = await shop();
  const b = await draft(ctx, [ringLine(ctx), collLine(ctx)]);
  await ctx.app.request(`${ctx.base}/shopify/batches/${b.id}/apply`, postEmpty());
  await ctx.batches.wait(ctx.site.id);
  const url = `${ctx.base}/shopify/batches/${b.id}/restore`;
  const res = await Promise.all([ctx.app.request(url, postEmpty()), ctx.app.request(url, postEmpty())].map(async (p) => json(await p)));
  assert.deepEqual(res.map((r) => r.status).sort(), [202, 409]);
  assert.equal(res.find((r) => r.status === 409)!.body.error.code, "limit_reached");
  await ctx.batches.wait(ctx.site.id);
  const done = await getBatch(ctx, b.id);
  assert.equal(done.state, "restored");
  assert.deepEqual(done.items.map((i: any) => [i.state, i.error]), [["restored", null], ["restored", null]]);
  assert.equal(ctx.fake.calls.mutations.length, 4, "deux écritures, deux annulations");
});

test("B1 — Shopify injoignable au moment d'« apply » : la place est libérée, le lot redevient brouillon", async () => {
  let down = false;
  const ctx = await shop({ wrapFetch: (impl) => (async (url: string, init: RequestInit) => (down ? Promise.reject(new Error("réseau coupé")) : impl(url, init))) as unknown as typeof fetch });
  const b = await draft(ctx, [ringLine(ctx)]);
  (ctx.shopify as any).cache = null; // la connexion est revérifiée
  down = true;
  const r = await json(await ctx.app.request(`${ctx.base}/shopify/batches/${b.id}/apply`, postEmpty()));
  assert.equal(r.status, 502, JSON.stringify(r.body));
  assert.equal((await getBatch(ctx, b.id)).state, "draft");
  down = false;
  (ctx.shopify as any).cache = null;
  const again = await json(await ctx.app.request(`${ctx.base}/shopify/batches/${b.id}/apply`, postEmpty()));
  assert.equal(again.status, 202, JSON.stringify(again.body));
  await ctx.batches.wait(ctx.site.id);
  assert.equal((await getBatch(ctx, b.id)).state, "applied");
});

// ───────── I1b : filtre de contenu des écritures automatiques

const HELD: Array<[string, string, RegExp]> = [
  ["adresse web", "Bague en or 18 carats, à découvrir sur https://bijoux-promo.example/bague dès aujourd'hui.", /adresse web/],
  ["nom de domaine", "Bague en or 18 carats, commandez-la sur bijoux-promo.fr avec la livraison offerte.", /nom de domaine/],
  ["adresse e-mail", "Bague en or 18 carats : écrivez à contact@bijoux-promo.fr pour la réserver dès aujourd'hui.", /adresse e-mail/],
  ["téléphone", "Bague en or 18 carats, réservez-la au 06 12 34 56 78 avant la fin de la semaine.", /téléphone/],
  ["texte sans rapport", "Promotion exceptionnelle sur tout le site : profitez-en vite avant la fin de la semaine.", /aucun mot du nom/],
];

test("I1b — filtre de contenu : URL, domaine, e-mail, téléphone, texte sans rapport ; un texte correct passe", () => {
  for (const [what, value, re] of HELD) assert.match(contentViolation(value, "Bague en or") ?? "", re, what);
  assert.equal(contentViolation(DESC_RING, "Bague en or"), null);
  assert.equal(contentViolation(DESC_EARRINGS, "Boucles d'oreilles"), null);
  assert.equal(contentViolation("Nos bagues en or et argent, faites main.", "Bagues"), null, "pluriel et accents tolérés");
  assert.match(contentViolation("Visitez www . bijoux . fr", "Bague en or")!, /adresse web/);
  const line = { type: "product" as const, field: "seo_description" as const, locale: null, before: null, audit: null, resourceTitle: "Bague en or" };
  const usage = { day: "2026-11-27", autoChanges: 0, aiTokens: 0, resetsAt: "2026-11-28T00:00:00.000Z" };
  const d = autoGate({ writesEnabled: true, autoAllowed: true, policy: { ...DEFAULT_POLICY, mode: "auto" }, origin: "automation", line: { ...line, proposed: HELD[0][1] }, usage }) as any;
  assert.equal(d.ok, false);
  assert.equal(d.lock, 4);
  assert.equal(d.content, true);
});

for (const [what, value, re] of HELD) {
  test(`I1b — lot automatique, proposition avec ${what} : pas écrite, ligne en attente avec l'erreur, lot en brouillon`, async () => {
    const ctx = await setup({ writesEnabled: true, autoApply: true, policy: { mode: "auto" }, turns: [answer(value)] });
    const b = await optimize(ctx, { field: "seo_description", resourceType: "product", limit: 1 });
    assert.equal(b.counts.total, 1, "la proposition est valide comme saisie : elle entre dans le lot");
    assert.equal(b.state, "draft");
    assert.equal(b.error.code, "automation_not_allowed");
    assert.equal(b.items[0].state, "pending");
    assert.match(b.items[0].error, re);
    assert.match(b.items[0].error, /Pas écrite automatiquement/);
    assert.equal(b.autoApplied, false);
    assert.equal(ctx.fake.calls.mutations.length, 0);
  });
}

test("I1b — une ligne retenue n'empêche pas les autres : elles sont écrites, puis le lot revient en brouillon ; validation humaine ensuite", async () => {
  const ctx = await setup({ state: twoProducts(), writesEnabled: true, autoApply: true, policy: { mode: "auto" }, turns: [answer(HELD[0][1]), answer(DESC_EARRINGS)] });
  const b = await optimize(ctx, { field: "seo_description", resourceType: "product", limit: 2 });
  assert.deepEqual(b.items.map((i: any) => [i.path, i.state, i.autoApplied]), [["/products/bague-or", "pending", false], ["/products/boucles", "applied", true]]);
  assert.equal(b.state, "draft");
  assert.match(b.error.message, /1 proposition n'a pas été écrite automatiquement/);
  assert.equal(ctx.fake.calls.mutations.length, 1);
  // La personne corrige la ligne retenue (l'erreur disparaît), puis valide.
  const fixed = await json(await ctx.app.request(`${ctx.base}/shopify/batches/${b.id}/items/${b.items[0].id}`, patch({ proposed: DESC_RING })));
  assert.equal(fixed.body.batch.items[0].error, null);
  await ctx.app.request(`${ctx.base}/shopify/batches/${b.id}/apply`, postEmpty());
  await ctx.batches.wait(ctx.site.id);
  const done = await getBatch(ctx, b.id);
  assert.equal(done.state, "applied");
  assert.deepEqual(done.items.map((i: any) => i.autoApplied), [false, true]);
});

// ───────── I1c : caractères invisibles de mise en forme

test("I1c — caractères de la catégorie Cf refusés pour toutes les écritures (shopify_invalid_value)", async () => {
  for (const ch of ["​", "‮", "⁠", "﻿", "­"]) {
    assert.throws(() => normalizeValue(`Bague${ch} en or`, "seo_title"), (e: any) => e.code === "shopify_invalid_value", JSON.stringify(ch));
  }
  const ctx = await shop();
  const ring = ctx.byPath["/products/bague-or"];
  const lot = await json(await ctx.app.request(`${ctx.base}/shopify/batches`, post({ items: [{ resourceId: ring.id, field: "seo_description", value: "Bague en or‮ sproc 18" }] })));
  assert.equal(lot.status, 422);
  assert.equal(lot.body.error.code, "shopify_invalid_value");
  assert.match(lot.body.error.message, /invisible/);
  const single = await json(await ctx.app.request(`${ctx.base}/shopify/changes`, post({ resourceId: ring.id, field: "seo_description", value: "Bague​ en or 18 carats", expectedBefore: null })));
  assert.equal(single.status, 422);
  assert.equal(single.body.error.code, "shopify_invalid_value");
  const b = await draft(ctx, [ringLine(ctx)]);
  const edit = await json(await ctx.app.request(`${ctx.base}/shopify/batches/${b.id}/items/${b.items[0].id}`, patch({ proposed: "Bague⁠ en or 18 carats" })));
  assert.equal(edit.status, 422);
  assert.equal(edit.body.error.code, "shopify_invalid_value");
  assert.equal(ctx.fake.calls.mutations.length, 0);
});

// ───────── I2 : verrous revérifiés après l'attente de cadence

test("I2 — règle passée sur « off » pendant l'attente de cadence : la ligne n'est pas écrite", async () => {
  let clock = 2_000_000;
  let sleeps = 0;
  let onSleep = () => {};
  const ctx = await setup({
    writesEnabled: true,
    autoApply: true,
    policy: { mode: "auto" },
    turns: [answer(DESC_RING)],
    now: () => clock,
    sleep: async (ms) => {
      sleeps++;
      clock += ms;
      onSleep();
    },
  });
  onSleep = () => setPolicy(ctx.store.db, ctx.site.id, { ...DEFAULT_POLICY, mode: "off" }, new Date().toISOString());
  // La limite de 30 écritures par minute est atteinte : la ligne attend son tour.
  for (let i = 0; i < 30; i++) ctx.shopify.writeLimiter.take("shopify", "test");
  const b = await optimize(ctx, { field: "seo_description", resourceType: "product", limit: 1 });
  assert.ok(sleeps > 0, "la ligne a attendu");
  assert.equal(ctx.fake.calls.mutations.length, 0, "rien n'est écrit après le passage sur « off »");
  assert.equal(b.state, "draft");
  assert.equal(b.error.code, "automation_not_allowed");
  assert.match(b.error.message, /mode « auto »/);
  assert.equal(b.items[0].state, "pending");
});

// ───────── I3 : arrêter un lot en cours

test("I3 — arrêt d'une écriture en cours : la ligne en cours se termine, le lot passe « partial », la suite reste en attente", async () => {
  const blk = blocker(1);
  const ctx = await shop({ wrapFetch: blk.wrapFetch });
  const b = await draft(ctx, [ringLine(ctx), collLine(ctx)]);
  const stopUrl = `${ctx.base}/shopify/batches/${b.id}/stop`;
  // Rien à arrêter tant que le lot n'est pas en cours.
  const idle = await json(await ctx.app.request(stopUrl, postEmpty()));
  assert.equal(idle.status, 409);
  assert.equal(idle.body.error.code, "batch_not_editable");
  await ctx.app.request(`${ctx.base}/shopify/batches/${b.id}/apply`, postEmpty());
  await blk.whenBlocked();
  const stopping = ctx.app.request(stopUrl, postEmpty());
  await tick();
  blk.release();
  const r = await json(await stopping);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.batch.state, "partial");
  assert.deepEqual(r.body.batch.items.map((i: any) => i.state), ["applied", "pending"]);
  assert.match(r.body.batch.error.message, /à votre demande/);
  assert.equal(blk.count(), 1, "la deuxième ligne n'est jamais partie");
  // Rien n'est perdu : la suite s'écrit quand on relance.
  const again = await json(await ctx.app.request(`${ctx.base}/shopify/batches/${b.id}/apply`, postEmpty()));
  assert.equal(again.status, 202);
  await ctx.batches.wait(ctx.site.id);
  assert.equal((await getBatch(ctx, b.id)).state, "applied");
  assert.equal((await json(await ctx.app.request(stopUrl, postEmpty()))).status, 409);
});

test("I3 — arrêt d'une annulation en cours et d'un lot automatique", async () => {
  // Annulation : la première annulation est bloquée (3e mutation : 2 écritures puis 1 annulation).
  const blk = blocker(3);
  const ctx = await shop({ wrapFetch: blk.wrapFetch });
  const b = await draft(ctx, [ringLine(ctx), collLine(ctx)]);
  await ctx.app.request(`${ctx.base}/shopify/batches/${b.id}/apply`, postEmpty());
  await ctx.batches.wait(ctx.site.id);
  await ctx.app.request(`${ctx.base}/shopify/batches/${b.id}/restore`, postEmpty());
  await blk.whenBlocked();
  const stopping = ctx.app.request(`${ctx.base}/shopify/batches/${b.id}/stop`, postEmpty());
  await tick();
  blk.release();
  const r = await json(await stopping);
  assert.equal(r.body.batch.state, "partial");
  assert.deepEqual(r.body.batch.items.map((i: any) => i.state).sort(), ["applied", "restored"]);
  assert.equal(blk.count(), 3);

  // Lot automatique : arrêté après sa première ligne, le reste attend.
  const blk2 = blocker(1);
  const auto = await setup({ state: twoProducts(), writesEnabled: true, autoApply: true, policy: { mode: "auto" }, turns: [answer(DESC_RING), answer(DESC_EARRINGS)], wrapFetch: blk2.wrapFetch });
  const start = await json(await auto.app.request(`${auto.base}/shopify/optimize`, post({ field: "seo_description", resourceType: "product", limit: 2 })));
  await blk2.whenBlocked();
  const stop2 = auto.app.request(`${auto.base}/shopify/batches/${start.body.batch.id}/stop`, postEmpty());
  await tick();
  blk2.release();
  const r2 = await json(await stop2);
  await auto.optimizer.wait(auto.site.id);
  assert.equal(r2.body.batch.state, "partial");
  assert.deepEqual(r2.body.batch.items.map((i: any) => [i.state, i.autoApplied]), [["applied", true], ["pending", false]]);
  assert.equal(blk2.count(), 1);
});

// ───────── I7 : limites de débit et lectures cadencées

test("I7 — 10 créations de lot, 5 préparations par l'IA et 10 enregistrements de règle par minute", async () => {
  const ctx = await setup();
  for (let i = 0; i < 10; i++) assert.equal((await ctx.app.request(`${ctx.base}/shopify/batches`, post({ items: [] }))).status, 400);
  const lots = await json(await ctx.app.request(`${ctx.base}/shopify/batches`, post({ items: [] })));
  assert.equal(lots.status, 429);
  assert.equal(lots.body.error.code, "rate_limited");
  assert.ok(lots.body.error.details.retryAfterSeconds >= 1);
  for (let i = 0; i < 5; i++) assert.equal((await ctx.app.request(`${ctx.base}/shopify/optimize`, post({ field: "inconnu" }))).status, 400);
  const opt = await json(await ctx.app.request(`${ctx.base}/shopify/optimize`, post({ field: "seo_description" })));
  assert.equal(opt.status, 429);
  assert.equal(opt.body.error.code, "rate_limited");
  for (let i = 0; i < 10; i++) assert.equal((await ctx.app.request(`${ctx.base}/automation`, put({ policy: DEFAULT_POLICY }))).status, 200);
  const rule = await json(await ctx.app.request(`${ctx.base}/automation`, put({ policy: DEFAULT_POLICY })));
  assert.equal(rule.status, 429);
  assert.equal(rule.body.error.code, "rate_limited");
  assert.ok(rule.body.error.details.retryAfterSeconds >= 1);
});

test("I7 — lectures en direct d'une création de lot : une seule à la fois, même avec deux créations simultanées", async () => {
  let inflight = 0;
  let max = 0;
  const ctx = await shop({
    wrapFetch: (impl) =>
      (async (url: string, init: RequestInit) => {
        const one = typeof init?.body === "string" && init.body.includes("{ node: ");
        if (!one) return impl(url, init);
        inflight++;
        max = Math.max(max, inflight);
        try {
          await new Promise((r) => setTimeout(r, 15));
          return await impl(url, init);
        } finally {
          inflight--;
        }
      }) as unknown as typeof fetch,
  });
  const contact = { resourceId: ctx.byPath["/pages/contact"].id, field: "seo_description", value: "Contactez notre atelier pour toute question sur vos bijoux et vos commandes." };
  const collier = { resourceId: ctx.byPath["/products/collier"].id, field: "seo_title", value: "Collier fin en or 18 carats" };
  max = 0;
  const res = await Promise.all([
    ctx.app.request(`${ctx.base}/shopify/batches`, post({ items: [ringLine(ctx), collLine(ctx)] })),
    ctx.app.request(`${ctx.base}/shopify/batches`, post({ items: [contact, collier] })),
  ]);
  assert.deepEqual(res.map((r) => r.status), [201, 201]);
  assert.equal(max, 1, "jamais deux lectures en direct en même temps");
});

// ───────── Mineurs

test("mineur 1 — « automatique » par ligne : un lot arrêté par le plafond puis validé à la main ne marque que les lignes écrites seules", async () => {
  const ctx = await setup({ state: twoProducts(), writesEnabled: true, autoApply: true, policy: { mode: "auto", maxAutoChangesPerDay: 1 }, turns: [answer(DESC_RING), answer(DESC_EARRINGS)] });
  const b = await optimize(ctx, { field: "seo_description", resourceType: "product", limit: 2 });
  assert.equal(b.state, "draft");
  assert.deepEqual(b.items.map((i: any) => [i.state, i.autoApplied]), [["applied", true], ["pending", false]]);
  assert.equal(b.autoApplied, true);
  await ctx.app.request(`${ctx.base}/shopify/batches/${b.id}/apply`, postEmpty());
  await ctx.batches.wait(ctx.site.id);
  const done = await getBatch(ctx, b.id);
  assert.equal(done.state, "applied");
  assert.deepEqual(done.items.map((i: any) => [i.state, i.autoApplied]), [["applied", true], ["applied", false]]);
  assert.equal(done.autoApplied, true, "au moins une ligne automatique");
  // Un lot validé entièrement à la main n'est pas automatique.
  const manual = await draft(ctx, [collLine(ctx)]);
  await ctx.app.request(`${ctx.base}/shopify/batches/${manual.id}/apply`, postEmpty());
  await ctx.batches.wait(ctx.site.id);
  const m = await getBatch(ctx, manual.id);
  assert.equal(m.autoApplied, false);
  assert.equal(m.items[0].autoApplied, false);
});

test("mineur 2 — réponse de l'IA arrivée après l'abandon du lot : jamais insérée", async () => {
  const inner = mockClaude([answer(DESC_RING)]);
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const slow = {
    messages: {
      stream(body: any, o: any) {
        const s = inner.messages.stream(body, o) as any;
        return { ...s, finalMessage: async () => (await gate, s.finalMessage()) };
      },
    },
  } as unknown as ChatClient;
  const ctx = await setup({ chatClient: slow });
  const r = await json(await ctx.app.request(`${ctx.base}/shopify/optimize`, post({ field: "seo_description", limit: 1 })));
  assert.equal(r.status, 202);
  while (inner.requests.length === 0) await tick(5);
  const cancelled = await json(await ctx.app.request(`${ctx.base}/shopify/batches/${r.body.batch.id}`, del()));
  assert.equal(cancelled.body.batch.state, "cancelled");
  release();
  await ctx.optimizer.wait(ctx.site.id);
  const b = await getBatch(ctx, r.body.batch.id);
  assert.equal(b.state, "cancelled");
  assert.equal(b.counts.total, 0, "aucune ligne insérée après l'abandon");
  // Ajout direct refusé hors préparation.
  await assert.rejects(
    ctx.batches.addProposals(ctx.site, r.body.batch.id, "automation", [{ resourceId: ctx.byPath["/products/bague-or"].id, field: "seo_description", locale: null, value: DESC_RING, note: null }]),
    (e: any) => e.code === "batch_not_editable",
  );
});
