/**
 * Lots de corrections : création, brouillon, écriture ligne par ligne par le chemin commun, conflit, abandon,
 * annulation, arrêt du serveur, cadence. Tout passe par un faux Shopify : aucune écriture réelle.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { RateLimiter } from "../src/http.ts";
import { recoverInterruptedBatches } from "../src/shopify/batches.ts";
import { openDb } from "../src/db.ts";
import { del, JSON_HEADERS, post, postEmpty } from "./helpers/env.ts";
import { json, shop } from "./helpers/boutique.ts";

const patch = (body: unknown) => ({ method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(body) });
const DESC_RING = "Bague en or 18 carats, finition polie, livrée dans son écrin : un bijou à offrir ou à s'offrir.";
const DESC_COLLECTION = "Toutes nos bagues en or et en argent, fabriquées en France, à porter seules ou accumulées.";

async function draft(ctx: Awaited<ReturnType<typeof shop>>, items?: unknown[]) {
  const ring = ctx.byPath["/products/bague-or"];
  const coll = ctx.byPath["/collections/bagues"];
  const r = await json(
    await ctx.app.request(
      `${ctx.base}/shopify/batches`,
      post({ title: "Descriptions", items: items ?? [{ resourceId: ring.id, field: "seo_description", value: DESC_RING }, { resourceId: coll.id, field: "seo_description", value: DESC_COLLECTION }] }),
    ),
  );
  return r;
}

test("lot composé : brouillon avec les valeurs relues dans Shopify, rien n'est écrit ; validations ligne par ligne", async () => {
  const ctx = await shop();
  const r = await draft(ctx);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const b = r.body.batch;
  assert.equal(b.state, "draft");
  assert.equal(b.origin, "manual");
  assert.equal(b.autoApplied, false);
  assert.deepEqual(b.counts, { total: 2, selected: 2, applied: 0, conflict: 0, failed: 0, restored: 0 });
  assert.equal(b.items[0].before, null);
  assert.equal(b.items[0].proposed, DESC_RING);
  assert.equal(b.items[0].state, "pending");
  assert.equal(ctx.fake.calls.mutations.length, 0, "aucune écriture à la création");
  assert.ok(!JSON.stringify(r.body).includes("gid://"));

  const ring = ctx.byPath["/products/bague-or"];
  const collier = ctx.byPath["/products/collier"];
  const coll = ctx.byPath["/collections/bagues"];
  // Valeur invalide : refusée, avec le numéro de ligne.
  let bad = await draft(ctx, [{ resourceId: ring.id, field: "seo_title", value: "ok titre" }, { resourceId: coll.id, field: "seo_title", value: "<b>gras</b>" }]);
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error.code, "shopify_invalid_value");
  assert.equal(bad.body.error.details.line, 2);
  // Valeur déjà en place.
  bad = await draft(ctx, [{ resourceId: collier.id, field: "seo_description", value: "Un collier fin." }]);
  assert.equal(bad.status, 400);
  assert.match(bad.body.error.message, /déjà en place/);
  // Deux lignes sur le même champ.
  bad = await draft(ctx, [{ resourceId: ring.id, field: "seo_description", value: DESC_RING }, { resourceId: ring.id, field: "seo_description", value: DESC_RING + " !" }]);
  assert.equal(bad.status, 400);
  assert.match(bad.body.error.message, /même champ/);
  // Champ non modifiable sur cet élément (image d'une collection) : même raison que readOnlyReasons.
  bad = await draft(ctx, [{ resourceId: coll.id, field: "image_alt", imageId: "img_abcdef123456", value: "Bagues" }]);
  assert.equal(bad.status, 400);
  assert.match(bad.body.error.message, /collection/);
  // Plafond de 50 lignes.
  bad = await draft(ctx, Array.from({ length: 51 }, () => ({ resourceId: ring.id, field: "seo_description", value: DESC_RING })));
  assert.equal(bad.status, 400);
  assert.match(bad.body.error.message, /50 lignes/);
  assert.equal(ctx.fake.calls.mutations.length, 0);
  // Les lots se listent, le plus récent d'abord.
  const list = (await (await ctx.app.request(`${ctx.base}/shopify/batches`)).json()) as any;
  assert.equal(list.batches.length, 1);
  assert.ok(!("items" in list.batches[0]));
});

test("brouillon : corriger et écarter une ligne ; plus rien après l'écriture (batch_not_editable)", async () => {
  const ctx = await shop();
  const b = (await draft(ctx)).body.batch;
  const url = `${ctx.base}/shopify/batches/${b.id}/items`;
  let r = await json(await ctx.app.request(`${url}/${b.items[0].id}`, patch({ proposed: "  Bague   en or 18 carats, finition polie et écrin offert.  " })));
  assert.equal(r.status, 200);
  assert.equal(r.body.batch.items[0].proposed, "Bague en or 18 carats, finition polie et écrin offert.");
  r = await json(await ctx.app.request(`${url}/${b.items[1].id}`, patch({ selected: false })));
  assert.equal(r.body.batch.counts.selected, 1);
  r = await json(await ctx.app.request(`${url}/${b.items[0].id}`, patch({ proposed: "x".repeat(501) })));
  assert.equal(r.body.error.code, "shopify_invalid_value");
  r = await json(await ctx.app.request(`${url}/${b.items[0].id}`, patch({ before: "triche" })));
  assert.equal(r.status, 400);
  const applied = await json(await ctx.app.request(`${ctx.base}/shopify/batches/${b.id}/apply`, postEmpty()));
  assert.equal(applied.status, 202);
  await ctx.batches.wait(ctx.site.id);
  r = await json(await ctx.app.request(`${url}/${b.items[0].id}`, patch({ proposed: "Autre texte pour la bague en or." })));
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, "batch_not_editable");
  const done = (await (await ctx.app.request(`${ctx.base}/shopify/batches/${b.id}`)).json()) as any;
  assert.equal(done.batch.items[1].state, "skipped", "ligne écartée : jamais écrite");
  assert.equal(ctx.fake.calls.mutations.length, 1);
});

test("écriture d'un lot : 202, une ligne à la fois par le chemin commun, historique avec batchId, événement à chaque ligne", async () => {
  const ctx = await shop();
  const b = (await draft(ctx)).body.batch;
  // Préparé avant : la création d'un lot relit les éléments à un rythme cadencé.
  const second = (await draft(ctx, [{ resourceId: ctx.byPath["/pages/contact"].id, field: "seo_description", value: "Contactez notre atelier pour toute question sur vos bijoux et vos commandes." }])).body.batch;
  ctx.events.length = 0;
  const r = await json(await ctx.app.request(`${ctx.base}/shopify/batches/${b.id}/apply`, postEmpty()));
  assert.equal(r.status, 202);
  assert.equal(r.body.batch.state, "applying");
  // Un seul lot en écriture par site.
  const busy = await json(await ctx.app.request(`${ctx.base}/shopify/batches/${second.id}/apply`, postEmpty()));
  assert.equal(busy.status, 409);
  assert.equal(busy.body.error.code, "limit_reached");
  await ctx.batches.wait(ctx.site.id);
  const done = (await (await ctx.app.request(`${ctx.base}/shopify/batches/${b.id}`)).json()) as any;
  assert.equal(done.batch.state, "applied");
  assert.ok(done.batch.finishedAt);
  assert.deepEqual(done.batch.counts, { total: 2, selected: 2, applied: 2, conflict: 0, failed: 0, restored: 0 });
  // Chemin commun : relecture puis metafieldsSet conditionnel, une mutation par ligne.
  assert.equal(ctx.fake.calls.mutations.length, 2);
  assert.ok(ctx.fake.calls.mutations.every((m) => m.query.includes("metafieldsSet") && m.variables.metafields[0].key === "description_tag"));
  assert.equal(ctx.fake.state.products[0].meta.description_tag?.value, DESC_RING);
  const history = (await (await ctx.app.request(`${ctx.base}/shopify/changes`)).json()) as any;
  assert.equal(history.total, 2);
  assert.ok(history.changes.every((c: any) => c.batchId === b.id && c.kind === "edit" && c.restorable));
  assert.equal(done.batch.items[0].changeId, history.changes.find((c: any) => c.resourceId === done.batch.items[0].resourceId).id);
  assert.ok(ctx.events.filter((e) => e === "shopify").length >= 3, "un événement par ligne, plus le début et la fin");
});

test("conflit sur une ligne : rien n'est écrit pour elle, le lot continue et finit « partial »", async () => {
  const ctx = await shop();
  const b = (await draft(ctx)).body.batch;
  // Modifiée ailleurs entre la préparation et l'écriture.
  ctx.fake.state.collections[0].meta.description_tag = { id: "gid://shopify/Metafield/999", value: "Écrit dans l'administration.", type: "string" };
  await ctx.app.request(`${ctx.base}/shopify/batches/${b.id}/apply`, postEmpty());
  await ctx.batches.wait(ctx.site.id);
  const done = (await (await ctx.app.request(`${ctx.base}/shopify/batches/${b.id}`)).json()) as any;
  assert.equal(done.batch.state, "partial");
  assert.equal(done.batch.items[0].state, "applied");
  assert.equal(done.batch.items[1].state, "conflict");
  assert.match(done.batch.items[1].error, /a changé/);
  assert.equal(ctx.fake.state.collections[0].meta.description_tag?.value, "Écrit dans l'administration.", "valeur de l'administration intacte");
  assert.equal(ctx.fake.calls.mutations.length, 1);
});

test("abandon d'un brouillon : « cancelled », consultable, plus rien ne s'écrit", async () => {
  const ctx = await shop();
  const b = (await draft(ctx)).body.batch;
  const r = await json(await ctx.app.request(`${ctx.base}/shopify/batches/${b.id}`, del()));
  assert.equal(r.status, 200);
  assert.equal(r.body.batch.state, "cancelled");
  assert.ok(r.body.batch.items.every((i: any) => i.state === "skipped"));
  const again = await json(await ctx.app.request(`${ctx.base}/shopify/batches/${b.id}/apply`, postEmpty()));
  assert.equal(again.body.error.code, "batch_not_editable");
  assert.equal((await json(await ctx.app.request(`${ctx.base}/shopify/batches/${b.id}`, del()))).body.error.code, "batch_not_editable");
  assert.equal(((await (await ctx.app.request(`${ctx.base}/shopify/batches`)).json()) as any).batches.length, 1);
  assert.equal(ctx.fake.calls.mutations.length, 0);
  // Un lot n'est jamais supprimé, même directement en base.
  assert.throws(() => ctx.store.db.prepare("DELETE FROM shopify_batches").run(), /suppression interdite/);
});

test("écriture refusée sans SHOPIFY_WRITES_ENABLED, avant tout appel à Shopify", async () => {
  const ctx = await shop({ writesEnabled: false });
  const b = (await draft(ctx)).body.batch;
  assert.equal(b.state, "draft", "composer un lot reste possible en lecture seule");
  const before = ctx.fake.calls.all;
  for (const action of ["apply", "restore"]) {
    const r = await json(await ctx.app.request(`${ctx.base}/shopify/batches/${b.id}/${action}`, postEmpty()));
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, "shopify_writes_disabled");
  }
  assert.equal(ctx.fake.calls.all, before);
  assert.equal(ctx.fake.calls.mutations.length, 0);
});

test("annulation d'un lot : chaque ligne écrite remise à sa valeur d'avant, une ligne modifiée depuis reste et le dit", async () => {
  const ctx = await shop();
  const b = (await draft(ctx)).body.batch;
  await ctx.app.request(`${ctx.base}/shopify/batches/${b.id}/apply`, postEmpty());
  await ctx.batches.wait(ctx.site.id);
  // La collection est modifiée dans l'administration après l'écriture du lot.
  ctx.fake.state.collections[0].meta.description_tag!.value = "Changée à la main.";
  const r = await json(await ctx.app.request(`${ctx.base}/shopify/batches/${b.id}/restore`, postEmpty()));
  assert.equal(r.status, 202);
  await ctx.batches.wait(ctx.site.id);
  const done = (await (await ctx.app.request(`${ctx.base}/shopify/batches/${b.id}`)).json()) as any;
  assert.equal(done.batch.items[0].state, "restored");
  assert.equal(done.batch.items[1].state, "applied");
  assert.match(done.batch.items[1].error, /a changé/);
  assert.equal(done.batch.state, "partial");
  assert.equal(ctx.fake.state.products[0].meta.description_tag, undefined, "valeur d'avant (vide) remise");
  assert.equal(ctx.fake.state.collections[0].meta.description_tag?.value, "Changée à la main.");
  const history = (await (await ctx.app.request(`${ctx.base}/shopify/changes`)).json()) as any;
  const restore = history.changes.find((c: any) => c.kind === "restore");
  assert.equal(restore.batchId, b.id);
  // Annulation complète quand plus rien ne bloque.
  ctx.fake.state.collections[0].meta.description_tag!.value = DESC_COLLECTION;
  await ctx.app.request(`${ctx.base}/shopify/batches/${b.id}/restore`, postEmpty());
  await ctx.batches.wait(ctx.site.id);
  const all = (await (await ctx.app.request(`${ctx.base}/shopify/batches/${b.id}`)).json()) as any;
  assert.equal(all.batch.state, "restored");
  assert.equal(all.batch.counts.restored, 2);
});

test("arrêt du serveur pendant un lot : la ligne en cours se termine, le lot passe « partial », sans reprise au redémarrage", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lots-"));
  try {
    let release: () => void = () => {};
    let blocked = false;
    let mutations = 0;
    const ctx = await shop({
      dataDir: dir,
      wrapFetch: (impl) =>
        (async (url: string, init: RequestInit) => {
          if (typeof init?.body === "string" && /^\s*\{"query":"mutation/.test(init.body)) {
            mutations++;
            if (mutations === 1) {
              blocked = true;
              await new Promise<void>((r) => (release = r));
            }
          }
          return impl(url, init);
        }) as unknown as typeof fetch,
    });
    const b = (await draft(ctx)).body.batch;
    await ctx.app.request(`${ctx.base}/shopify/batches/${b.id}/apply`, postEmpty());
    while (!blocked) await new Promise((r) => setTimeout(r, 5));
    const stopping = ctx.batches.stopAll();
    release();
    await stopping;
    const after = (await (await ctx.app.request(`${ctx.base}/shopify/batches/${b.id}`)).json()) as any;
    assert.equal(after.batch.state, "partial");
    assert.deepEqual(after.batch.items.map((i: any) => i.state), ["applied", "pending"]);
    assert.match(after.batch.error.message, /arrêté/);
    assert.equal(mutations, 1, "la deuxième ligne n'est jamais partie");

    // Arrêt brutal (le processus disparaît en pleine écriture) : au redémarrage, « applying » → « partial ».
    ctx.store.db.prepare("UPDATE shopify_batches SET state = 'applying', finished_at = NULL, error_json = NULL WHERE id = ?").run(b.id);
    const db2 = openDb(dir);
    assert.equal(recoverInterruptedBatches(db2), 1);
    const row = db2.prepare("SELECT state, error_json FROM shopify_batches WHERE id = ?").get(b.id) as any;
    assert.equal(row.state, "partial");
    assert.match(row.error_json, /arrêté/);
    assert.deepEqual((db2.prepare("SELECT state FROM shopify_batch_items WHERE batch_id = ? ORDER BY seq").all(b.id) as any[]).map((r) => r.state), ["applied", "pending"]);
    assert.equal((db2.prepare("SELECT COUNT(*) AS n FROM shopify_changes WHERE batch_id = ? AND status = 'applied'").get(b.id) as any).n, 1, "ligne écrite dans l'historique");
    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cadence : 30 écritures par minute partagées ; un lot attend son tour au lieu d'être refusé", async () => {
  // Limiteur seul, horloge simulée.
  let now = 0;
  const lim = new RateLimiter(30, () => now);
  const sleep = async (ms: number) => {
    now += ms;
  };
  for (let i = 0; i < 30; i++) assert.equal(await lim.acquire("k", undefined, sleep), true);
  assert.equal(now, 0);
  assert.equal(await lim.acquire("k", undefined, sleep), true);
  assert.ok(now >= 60_000, `la 31e attend la minute (${now} ms)`);
  // Un lot après 30 modifications isolées : il attend, il n'échoue pas.
  let clock = 1_000_000;
  const ctx = await shop({ now: () => clock, sleep: async (ms) => void (clock += ms) });
  for (let i = 0; i < 30; i++) ctx.shopify.writeLimiter.take("shopify", "test");
  const single = await json(await ctx.app.request(`${ctx.base}/shopify/changes`, post({ resourceId: ctx.byPath["/pages/contact"].id, field: "seo_title", value: "Contact", expectedBefore: null })));
  assert.equal(single.status, 429, "une modification isolée est refusée (rate_limited)");
  const b = (await draft(ctx)).body.batch;
  await ctx.app.request(`${ctx.base}/shopify/batches/${b.id}/apply`, postEmpty());
  await ctx.batches.wait(ctx.site.id);
  const done = (await (await ctx.app.request(`${ctx.base}/shopify/batches/${b.id}`)).json()) as any;
  assert.equal(done.batch.state, "applied");
  assert.ok(clock - 1_000_000 >= 60_000, "le lot a attendu qu'une place se libère");
});
