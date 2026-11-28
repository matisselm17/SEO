/**
 * Vérification d'une correction : relecture de la page publique après une écriture, avec la grille de l'analyse.
 * Faux Shopify et faux chargement de page : aucun appel réseau, aucune écriture réelle, aucun site réel chargé.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FetchResult } from "../src/net/fetch.ts";
import { insertPending, markApplied } from "../src/shopify/repo.ts";
import { imageStem, publicUrl } from "../src/shopify/verification.ts";
import { post, postEmpty, testEnv } from "./helpers/env.ts";
import { insertDoneAudit, json, PAGES, shop } from "./helpers/boutique.ts";
import { defaultState, fakeShopify, SHOP_HOST } from "./helpers/fake-shopify.ts";

const ORIGIN = `https://${SHOP_HOST}`;
const RING = `${ORIGIN}/products/bague-or`;

function pageRes(html: string, o: { status?: number; url?: string; ct?: string } = {}): FetchResult {
  return { status: o.status ?? 200, url: o.url ?? RING, contentType: o.ct ?? "text/html; charset=utf-8", headers: {}, body: Buffer.from(html, "utf8"), redirects: 0 };
}

/** Page produit : titre, description, adresse canonique et images au choix. */
function productHtml(o: { title?: string; description?: string; canonical?: string | null; imgs?: string } = {}): string {
  const canonical = o.canonical === undefined ? RING : o.canonical;
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${o.title ?? "Bague en or 18 carats"}</title>
${o.description !== undefined ? `<meta name="description" content="${o.description}">` : ""}
${canonical ? `<link rel="canonical" href="${canonical}">` : ""}</head>
<body><h1>Bague en or</h1>${o.imgs ?? ""}<p>Une bague.</p></body></html>`;
}

/** Boutique d'essai avec des minuteries capturées et un faux chargement qui sert `serve()`. */
async function setup(opts: { maxQueue?: number; writesEnabled?: boolean } = {}) {
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const loads: string[] = [];
  let serve: (url: string) => FetchResult | Promise<FetchResult> = () => {
    throw new Error("aucune page prévue");
  };
  const ctx = await shop({
    writesEnabled: opts.writesEnabled,
    verification: {
      fetchPage: async (url) => {
        loads.push(url);
        return serve(url);
      },
      setTimer: (fn, ms) => timers.push({ fn, ms }),
      gapMs: 0,
      maxQueue: opts.maxQueue,
    },
  });
  const sh = `${ctx.base}/shopify`;
  const ring = ctx.byPath["/products/bague-or"];
  const write = async (body: Record<string, unknown>) => json(await ctx.app.request(`${sh}/changes`, post({ resourceId: ring.id, ...body })));
  /** Déclenche la prochaine relecture programmée et attend la fin de la file. */
  const fire = async () => {
    const t = timers.shift();
    assert.ok(t, "aucune relecture programmée");
    t.fn();
    await ctx.shopify.verifier.idle();
    return t.ms;
  };
  const history = async () => ((await (await ctx.app.request(`${sh}/changes`)).json()) as any).changes as any[];
  const find = async (id: string) => (await history()).find((c) => c.id === id);
  return { ...ctx, sh, ring, timers, loads, setServe: (f: typeof serve) => (serve = f), write, fire, history, find };
}

test("titre vérifié : le titre affiché contient la valeur (suffixe de la boutique), critère validé", async () => {
  const ctx = await setup();
  const value = "Bague en or 18 carats fait main à Lyon";
  ctx.setServe(() => pageRes(productHtml({ title: `${value} – Boutique Essai` })));
  const r = await ctx.write({ field: "seo_title", value, expectedBefore: "Bague en or 18 carats" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.change.correctionStatus, "verifying", "jamais vérifiée d'office");
  assert.equal(r.body.change.verification, null);
  assert.equal(ctx.loads.length, 0, "rien chargé pendant l'écriture");
  ctx.events.length = 0;
  assert.equal(await ctx.fire(), 15_000);
  assert.deepEqual(ctx.loads, [RING]);
  const c = await ctx.find(r.body.change.id);
  assert.equal(c.correctionStatus, "verified");
  const v = c.verification;
  assert.equal(v.outcome, "verified");
  assert.equal(v.reason, "ok");
  assert.equal(v.displayed, true);
  assert.equal(v.url, RING);
  assert.equal(v.rendered, `${value} – Boutique Essai`);
  assert.equal(v.criterion.id, "title");
  assert.equal(v.criterion.label, "Titre de la page");
  assert.equal(v.criterion.before, "pass");
  assert.equal(v.criterion.after, "pass");
  assert.equal(typeof v.pageScore.before, "number");
  assert.equal(typeof v.pageScore.after, "number");
  assert.ok(ctx.events.includes("shopify"));
  assert.equal(ctx.timers.length, 0, "pas de seconde relecture");
  // L'analyse affichée n'a pas changé.
  const pages = ctx.store.db.prepare("SELECT COUNT(*) AS n FROM pages").get() as any;
  assert.equal(pages.n, PAGES.length);
  // Le détail de l'élément porte aussi le statut.
  const d = (await (await ctx.app.request(`${ctx.sh}/resources/${ctx.ring.id}`)).json()) as any;
  assert.equal(d.resource.history[0].correctionStatus, "verified");
});

test("description affichée mais critère non validé : failed / criterion_failing", async () => {
  const ctx = await setup();
  ctx.setServe(() => pageRes(productHtml({ description: "Bague  fine." })));
  const r = await ctx.write({ field: "seo_description", value: "Bague fine.", expectedBefore: null });
  assert.equal(r.status, 201);
  await ctx.fire();
  const c = await ctx.find(r.body.change.id);
  assert.equal(c.correctionStatus, "failed");
  assert.equal(c.verification.reason, "criterion_failing");
  assert.equal(c.verification.displayed, true, "espaces réduits des deux côtés");
  assert.equal(c.verification.criterion.id, "meta_description");
  assert.equal(c.verification.criterion.before, "fail");
  assert.equal(c.verification.criterion.after, "warn");
  assert.match(c.verification.message, /n'est pas encore validé/);
  assert.equal(ctx.timers.length, 0);
});

test("valeur pas encore affichée : not_displayed, seconde relecture deux minutes plus tard, « verifying » entre les deux", async () => {
  const ctx = await setup();
  const value = "Bague en or 18 carats fait main à Lyon";
  ctx.setServe(() => pageRes(productHtml({ title: "Bague en or 18 carats" })));
  const r = await ctx.write({ field: "seo_title", value, expectedBefore: "Bague en or 18 carats" });
  await ctx.fire();
  assert.equal(ctx.timers.length, 1);
  assert.equal(ctx.timers[0].ms, 120_000);
  let c = await ctx.find(r.body.change.id);
  assert.equal(c.correctionStatus, "verifying");
  assert.equal(c.verification.reason, "not_displayed");
  assert.equal(c.verification.displayed, false);
  assert.equal(c.verification.rendered, "Bague en or 18 carats");
  // La boutique a fini de se mettre à jour.
  ctx.setServe(() => pageRes(productHtml({ title: value })));
  assert.equal(await ctx.fire(), 120_000);
  c = await ctx.find(r.body.change.id);
  assert.equal(c.correctionStatus, "verified");
  assert.equal(ctx.timers.length, 0, "pas de troisième relecture");
  const rows = ctx.store.db.prepare("SELECT COUNT(*) AS n FROM shopify_verifications WHERE change_id = ?").get(r.body.change.id) as any;
  assert.equal(rows.n, 2, "chaque relecture est conservée");
});

test("page de contrôle anti-robot (200, sans canonique) et autre page : inconclusive / page_unavailable, reste « applied »", async () => {
  const ctx = await setup();
  ctx.setServe(() => pageRes(`<!doctype html><html><head><title>Vérification en cours</title></head><body>Un instant…</body></html>`));
  const r = await ctx.write({ field: "seo_title", value: "Bague en or 18 carats fait main", expectedBefore: "Bague en or 18 carats" });
  await ctx.fire();
  let c = await ctx.find(r.body.change.id);
  assert.equal(c.correctionStatus, "applied");
  assert.equal(c.verification.outcome, "inconclusive");
  assert.equal(c.verification.reason, "page_unavailable");
  assert.equal(c.verification.criterion, null);
  assert.equal(c.verification.pageScore, null);
  assert.equal(ctx.timers.length, 0);
  // Canonique vers une autre page (redirection vers l'accueil, par exemple).
  ctx.setServe(() => pageRes(productHtml({ title: "Bague en or 18 carats fait main", canonical: `${ORIGIN}/` })));
  const v = await json(await ctx.app.request(`${ctx.sh}/changes/${r.body.change.id}/verify`, postEmpty()));
  assert.equal(v.status, 200);
  assert.equal(v.body.change.verification.reason, "page_unavailable");
  // Contenu non HTML.
  ctx.setServe(() => pageRes("{}", { ct: "application/json" }));
  c = (await json(await ctx.app.request(`${ctx.sh}/changes/${r.body.change.id}/verify`, postEmpty()))).body.change;
  assert.equal(c.verification.reason, "page_unavailable");
});

test("429 : page_unavailable, un seul chargement, aucune nouvelle tentative", async () => {
  const ctx = await setup();
  ctx.setServe(() => pageRes("trop de demandes", { status: 429, ct: "text/plain" }));
  const r = await ctx.write({ field: "seo_title", value: "Bague en or 18 carats fait main", expectedBefore: "Bague en or 18 carats" });
  await ctx.fire();
  assert.equal(ctx.loads.length, 1);
  const c = await ctx.find(r.body.change.id);
  assert.equal(c.verification.reason, "page_unavailable");
  assert.match(c.verification.message, /patienter/);
  assert.equal(c.correctionStatus, "applied");
  assert.equal(ctx.timers.length, 0);
  // Chargement impossible (erreur réseau) : même conclusion.
  ctx.setServe(() => {
    throw new Error("ECONNRESET boutique-essai.myshopify.com");
  });
  const v = (await json(await ctx.app.request(`${ctx.sh}/changes/${r.body.change.id}/verify`, postEmpty()))).body.change.verification;
  assert.equal(v.reason, "page_unavailable");
  assert.ok(!JSON.stringify(v).includes("myshopify"));
});

test("texte alternatif : image retrouvée par son nom de fichier (taille Shopify, srcset) ; image absente : image_not_found", async () => {
  const ctx = await setup();
  const d = (await (await ctx.app.request(`${ctx.sh}/resources/${ctx.ring.id}`)).json()) as any;
  const img = d.resource.imageList[1];
  assert.match(img.url, /bague-2\.jpg$/);
  ctx.setServe(() =>
    pageRes(
      productHtml({
        imgs: `<img src="//cdn.shopify.com/s/files/1/bague-1_800x.jpg?v=1" alt="Bague vue de face">
<img data-src="//cdn.shopify.com/s/files/1/autre.jpg" srcset="//cdn.shopify.com/bague-2_400x.jpg?v=9 400w, //cdn.shopify.com/bague-2_800x.jpg?v=9 800w" alt="Bague  vue de côté">`,
      }),
    ),
  );
  const r = await ctx.write({ field: "image_alt", imageId: img.id, value: "Bague vue de côté", expectedBefore: null });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await ctx.fire();
  let c = await ctx.find(r.body.change.id);
  assert.equal(c.correctionStatus, "verified");
  assert.equal(c.verification.displayed, true);
  assert.equal(c.verification.rendered, "Bague vue de côté");
  assert.equal(c.verification.criterion.id, "image_alt");
  // L'image n'est plus dans la page.
  ctx.setServe(() => pageRes(productHtml({ imgs: `<img src="//cdn.shopify.com/s/files/1/bague-1.jpg" alt="Bague vue de face">` })));
  c = (await json(await ctx.app.request(`${ctx.sh}/changes/${r.body.change.id}/verify`, postEmpty()))).body.change;
  assert.equal(c.verification.outcome, "inconclusive");
  assert.equal(c.verification.reason, "image_not_found");
  assert.equal(c.correctionStatus, "applied");
});

test("nom de fichier d'image : sans requête, sans suffixe de taille", () => {
  assert.equal(imageStem("https://cdn.shopify.com/s/files/1/bague-2.jpg?v=12"), "1/bague-2");
  assert.equal(imageStem("//cdn.shopify.com/s/files/1/bague-2_800x.jpg?v=12"), "1/bague-2");
  assert.equal(imageStem("//cdn.shopify.com/s/files/1/bague-2_800x600_crop_center@2x.webp"), "1/bague-2");
  assert.equal(imageStem("/files/bague-2_x600.png"), "files/bague-2");
  assert.notEqual(imageStem("/files/bague-22.jpg"), "files/bague-2");
  // Le dossier compte : une image de même nom rangée ailleurs n'est pas la même image.
  assert.notEqual(imageStem("/cdn/shop/products/photo.jpg"), imageStem("/cdn/shop/files/photo.jpg"));
  assert.equal(imageStem("https://cdn.shopify.com/s/files/1/0001/0002/files/photo.jpg?v=3"), imageStem("//boutique.example/cdn/shop/files/photo_600x.jpg"));
});

test("traduction : not_supported, sans charger de page", async () => {
  const ctx = await setup();
  const r = await ctx.write({ field: "seo_title", locale: "en", value: "18k gold ring handmade", expectedBefore: "18k gold ring" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(await ctx.fire(), 0);
  const c = await ctx.find(r.body.change.id);
  assert.equal(c.verification.outcome, "inconclusive");
  assert.equal(c.verification.reason, "not_supported");
  assert.equal(c.verification.url, null);
  assert.equal(c.correctionStatus, "applied");
  assert.equal(ctx.loads.length, 0);
});

test("modification annulée ou remplacée : refus ; ligne restore : ni statut ni vérification", async () => {
  const ctx = await setup();
  ctx.setServe(() => pageRes(productHtml({ title: "Titre deux de la bague en or fine" })));
  const a = await ctx.write({ field: "seo_title", value: "Titre un de la bague en or fine", expectedBefore: "Bague en or 18 carats" });
  const b = await ctx.write({ field: "seo_title", value: "Titre deux de la bague en or fine", expectedBefore: "Titre un de la bague en or fine" });
  const replaced = await json(await ctx.app.request(`${ctx.sh}/changes/${a.body.change.id}/verify`, postEmpty()));
  assert.equal(replaced.status, 400);
  assert.equal(replaced.body.error.code, "bad_request");
  // La relecture automatique de la modification remplacée ne charge rien.
  ctx.loads.length = 0;
  await ctx.fire();
  assert.equal(ctx.loads.length, 0);
  assert.equal((await ctx.find(a.body.change.id)).correctionStatus, "applied");
  // Annulation de la dernière.
  const undo = await json(await ctx.app.request(`${ctx.sh}/changes/${b.body.change.id}/restore`, postEmpty()));
  assert.equal(undo.status, 201, JSON.stringify(undo.body));
  assert.equal(undo.body.change.kind, "restore");
  assert.equal(undo.body.change.correctionStatus, null);
  assert.equal(undo.body.change.verification, null);
  assert.equal(ctx.timers.length, 1, "rien n'est programmé après une annulation");
  await ctx.fire(); // relecture automatique de b, annulée entre-temps
  assert.equal(ctx.loads.length, 0);
  const cancelled = await ctx.find(b.body.change.id);
  assert.equal(cancelled.correctionStatus, "cancelled");
  for (const id of [b.body.change.id, undo.body.change.id]) {
    const res = await json(await ctx.app.request(`${ctx.sh}/changes/${id}/verify`, postEmpty()));
    assert.equal(res.status, 400, id);
  }
  assert.equal(ctx.loads.length, 0);
});

test("chemin malveillant : aucun chargement", async () => {
  assert.equal(publicUrl({ url: `${ORIGIN}/`, host: SHOP_HOST }, "/products/bague-or"), RING);
  for (const p of ["//evil.example/x", "/\\evil.example", "/\\/evil", "products/x", "https://evil.example/x", "/a b", "/x\n"]) {
    assert.equal(publicUrl({ url: `${ORIGIN}/`, host: SHOP_HOST }, p), null, p);
  }
  const ctx = await setup();
  ctx.setServe(() => pageRes(productHtml()));
  for (const path of ["//evil.example/x", "/\\evil"]) {
    const row = insertPending(ctx.store.db, {
      site_host: SHOP_HOST, resource_id: ctx.ring.id, resource_gid: "gid://shopify/Product/1", resource_type: "product", resource_title: "Bague", path,
      field: "seo_description", image_id: null, image_gid: null, image_url: null, locale: null, before_value: null, requested_value: "Une bague.",
      applied_at: new Date().toISOString(), kind: "edit", restores_change_id: null,
    });
    markApplied(ctx.store.db, row.id, "Une bague.", true, new Date().toISOString());
    const v = await json(await ctx.app.request(`${ctx.sh}/changes/${row.id}/verify`, postEmpty()));
    assert.equal(v.status, 200);
    assert.equal(v.body.change.verification.reason, "page_unavailable");
    assert.equal(v.body.change.verification.url, null);
  }
  assert.equal(ctx.loads.length, 0);
});

test("journal des vérifications : ni modifiable ni supprimable", async () => {
  const ctx = await setup();
  ctx.setServe(() => pageRes(productHtml({ title: "Bague en or 18 carats fait main" })));
  await ctx.write({ field: "seo_title", value: "Bague en or 18 carats fait main", expectedBefore: "Bague en or 18 carats" });
  await ctx.fire();
  assert.throws(() => ctx.store.db.exec("UPDATE shopify_verifications SET outcome = 'verified'"), /modification interdite/);
  assert.throws(() => ctx.store.db.exec("DELETE FROM shopify_verifications"), /suppression interdite/);
  assert.equal((ctx.store.db.prepare("SELECT COUNT(*) AS n FROM shopify_verifications").get() as any).n, 1);
});

test("l'écriture réussit même si la mise en file échoue ; file pleine : la modification reste « applied »", async () => {
  const ctx = await setup({ maxQueue: 1 });
  const real = ctx.shopify.verifier.schedule.bind(ctx.shopify.verifier);
  ctx.shopify.verifier.schedule = () => {
    throw new Error("file indisponible");
  };
  const r = await ctx.write({ field: "seo_title", value: "Bague en or 18 carats fait main", expectedBefore: "Bague en or 18 carats" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.change.correctionStatus, "applied");
  ctx.shopify.verifier.schedule = real;
  const a = await ctx.write({ field: "seo_description", value: "Une bague en or 18 carats, polie à la main dans notre atelier.", expectedBefore: null });
  assert.equal(a.body.change.correctionStatus, "verifying");
  const b = await ctx.write({ field: "seo_title", value: "Bague en or 18 carats fine", expectedBefore: "Bague en or 18 carats fait main" });
  assert.equal(b.status, 201);
  assert.equal(b.body.change.correctionStatus, "applied", "au-delà du plafond");
  assert.equal(ctx.timers.length, 1);
});

test("route verify : 200 sans écritures activées, 400 identifiant invalide, 404 introuvable ou autre site, limite de 10 par minute", async () => {
  const loads: string[] = [];
  const fake = fakeShopify(defaultState());
  const env = testEnv({
    shopify: {
      fetchImpl: fake.impl,
      writesEnabled: false,
      verification: { fetchPage: async (url) => (loads.push(url), pageRes(productHtml({ description: "Une bague en or 18 carats, polie à la main dans notre atelier lyonnais." }))), setTimer: () => undefined, gapMs: 0 },
    },
  });
  const site = env.store.insertSite(`${ORIGIN}/`, SHOP_HOST, "Boutique Essai");
  insertDoneAudit(env.store, site.id, SHOP_HOST, PAGES);
  const other = env.store.insertSite("https://autre-boutique.example/", "autre-boutique.example", "Autre");
  const row = insertPending(env.store.db, {
    site_host: SHOP_HOST, resource_id: "shr_abcdef123456", resource_gid: "gid://shopify/Product/1", resource_type: "product", resource_title: "Bague", path: "/products/bague-or",
    field: "seo_description", image_id: null, image_gid: null, image_url: null, locale: null, before_value: null,
    requested_value: "Une bague en or 18 carats, polie à la main dans notre atelier lyonnais.", applied_at: new Date().toISOString(), kind: "edit", restores_change_id: null,
  });
  markApplied(env.store.db, row.id, "Une bague en or 18 carats, polie à la main dans notre atelier lyonnais.", true, new Date().toISOString());
  const url = (s: string, id: string) => `/api/sites/${s}/shopify/changes/${id}/verify`;

  const ok = await json(await env.app.request(url(site.id, row.id), postEmpty()));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.change.correctionStatus, "verified");
  assert.equal(ok.body.change.verification.criterion.before, "fail");
  assert.equal(ok.body.change.verification.criterion.after, "pass");
  assert.equal(fake.calls.all, 0, "aucun appel à Shopify");

  const bad2 = await json(await env.app.request(url(site.id, "CHG_ABC"), postEmpty()));
  assert.equal(bad2.status, 400);
  assert.equal(bad2.body.error.code, "bad_request");
  const missing = await json(await env.app.request(url(site.id, "chg_aaaaaaaa"), postEmpty()));
  assert.equal(missing.status, 404);
  const foreign = await json(await env.app.request(url(other.id, row.id), postEmpty()));
  assert.equal(foreign.status, 404);
  assert.equal(loads.length, 1);

  // Les refus (introuvable, autre site) ne comptent pas : 1 demande comptée, 9 de plus, puis refus.
  for (let i = 0; i < 9; i++) assert.equal((await env.app.request(url(site.id, row.id), postEmpty())).status, 200);
  const limited = await json(await env.app.request(url(site.id, row.id), postEmpty()));
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, "rate_limited");
  assert.equal(loads.length, 10);
});

test("une page à la fois pour tout le serveur, au moins 2 secondes entre deux chargements", async () => {
  let clock = 1_000_000;
  const sleeps: number[] = [];
  let running = 0;
  let maxRunning = 0;
  const fake = fakeShopify(defaultState());
  const env = testEnv({
    shopify: {
      fetchImpl: fake.impl,
      verification: {
        now: () => clock,
        sleep: async (ms) => {
          sleeps.push(ms);
          clock += ms;
        },
        setTimer: () => undefined,
        fetchPage: async () => {
          running++;
          maxRunning = Math.max(maxRunning, running);
          await new Promise((r) => setTimeout(r, 5));
          clock += 100;
          running--;
          return pageRes(productHtml());
        },
      },
    },
  });
  const site = env.store.insertSite(`${ORIGIN}/`, SHOP_HOST, "Boutique Essai");
  const ids = ["seo_title", "seo_description"].map((field) => {
    const row = insertPending(env.store.db, {
      site_host: SHOP_HOST, resource_id: "shr_abcdef123456", resource_gid: "gid://shopify/Product/1", resource_type: "product", resource_title: "Bague", path: "/products/bague-or",
      field: field as "seo_title", image_id: null, image_gid: null, image_url: null, locale: null, before_value: null, requested_value: "Bague en or",
      applied_at: new Date().toISOString(), kind: "edit", restores_change_id: null,
    });
    markApplied(env.store.db, row.id, "Bague en or", true, new Date().toISOString());
    return row.id;
  });
  const [a, b] = await Promise.all(ids.map((id) => env.app.request(`/api/sites/${site.id}/shopify/changes/${id}/verify`, postEmpty())));
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(maxRunning, 1);
  assert.deepEqual(sleeps, [2000]);
});

// ───────── Défauts relevés par la revue QA : chacun de ces tests échouait avant correction

test("titre raccourci : tant que l'ancien titre est affiché, not_displayed (ni vérifiée, ni critère en cause)", async () => {
  const ctx = await setup();
  const old = "Bague en or 18 carats";
  // Le nouveau titre est le début de l'ancien : l'ancien titre « contient » le nouveau.
  ctx.setServe(() => pageRes(productHtml({ title: `${old} – Boutique Essai` })));
  const r = await ctx.write({ field: "seo_title", value: "Bague en or", expectedBefore: old });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await ctx.fire();
  let c = await ctx.find(r.body.change.id);
  assert.equal(c.verification.reason, "not_displayed");
  assert.equal(c.verification.displayed, false);
  assert.equal(c.correctionStatus, "verifying", "une seconde relecture est programmée");
  assert.equal(ctx.timers[0].ms, 120_000);
  // La page se met à jour : le nouveau titre seul.
  ctx.setServe(() => pageRes(productHtml({ title: "Bague en or – Boutique Essai" })));
  await ctx.fire();
  c = await ctx.find(r.body.change.id);
  assert.equal(c.verification.displayed, true);
  assert.notEqual(c.verification.reason, "not_displayed");
});

test("titre allongé : l'ancien titre contenu dans le nouveau ne bloque pas la vérification", async () => {
  const ctx = await setup();
  const value = "Bague en or 18 carats, faite main à Lyon";
  ctx.setServe(() => pageRes(productHtml({ title: value })));
  const r = await ctx.write({ field: "seo_title", value, expectedBefore: "Bague en or 18 carats" });
  await ctx.fire();
  const c = await ctx.find(r.body.change.id);
  assert.equal(c.correctionStatus, "verified");
});

test("champ vidé : jamais vérifié tant que la page affiche encore l'ancienne valeur", async () => {
  const ctx = await setup();
  const old = "Une bague en or 18 carats, polie à la main dans notre atelier lyonnais, livrée en 48 heures.";
  const set = await ctx.write({ field: "seo_description", value: old, expectedBefore: null });
  assert.equal(set.status, 201, JSON.stringify(set.body));
  ctx.timers.length = 0;
  const r = await ctx.write({ field: "seo_description", value: null, expectedBefore: old });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  // La page n'a pas encore changé : l'ancienne description valide le critère, mais ne prouve rien.
  ctx.setServe(() => pageRes(productHtml({ description: old })));
  await ctx.fire();
  let c = await ctx.find(r.body.change.id);
  assert.equal(c.verification.reason, "not_displayed");
  assert.equal(c.verification.outcome, "inconclusive", "ni vérifiée ni échouée : rien n'est prouvé");
  assert.equal(c.verification.displayed, null);
  // Une fois l'ancienne valeur disparue, le critère décide.
  ctx.setServe(() => pageRes(productHtml({ description: "Un autre texte, repris du début de la fiche produit par le thème de la boutique, assez long." })));
  await ctx.fire();
  c = await ctx.find(r.body.change.id);
  assert.notEqual(c.verification.reason, "not_displayed");
});

test("texte alternatif : une image de même nom dans un autre dossier ne vaut pas preuve", async () => {
  const ctx = await setup();
  const d = (await (await ctx.app.request(`${ctx.sh}/resources/${ctx.ring.id}`)).json()) as any;
  const img = d.resource.imageList[1];
  // L'image modifiée n'a pas de texte ; une homonyme rangée ailleurs porte déjà le texte voulu.
  ctx.setServe(() => pageRes(productHtml({ imgs: `<img src="//cdn.shopify.com/bague-2.jpg" alt=""><img src="//cdn.shopify.com/files/bague-2.jpg" alt="Bague vue de côté">` })));
  const r = await ctx.write({ field: "image_alt", imageId: img.id, value: "Bague vue de côté", expectedBefore: null });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await ctx.fire();
  const c = await ctx.find(r.body.change.id);
  assert.equal(c.verification.reason, "not_displayed");
  assert.notEqual(c.verification.outcome, "verified");
});

test("demande manuelle refusée quand trop de relectures attendent ; modification remplacée pendant le chargement : rien d'enregistré", async () => {
  const ctx = await setup();
  const r = await ctx.write({ field: "seo_title", value: "Bague en or 18 carats, faite main à Lyon", expectedBefore: "Bague en or 18 carats" });
  ctx.timers.length = 0;
  const count = () => (ctx.store.db.prepare("SELECT COUNT(*) AS n FROM shopify_verifications").get() as any).n as number;
  // Le chargement reste suspendu : la file se remplit.
  let release: (v: FetchResult) => void = () => undefined;
  ctx.setServe(() => new Promise<FetchResult>((res) => (release = res)));
  const url = `${ctx.sh}/changes/${r.body.change.id}/verify`;
  const waiting = Array.from({ length: 6 }, () => ctx.app.request(url, postEmpty()));
  await new Promise((res) => setTimeout(res, 10));
  const refused = await json(await ctx.app.request(url, postEmpty()));
  assert.equal(refused.status, 429);
  assert.equal(refused.body.error.code, "rate_limited");
  // Pendant le premier chargement, une nouvelle modification remplace celle-ci.
  const next = await ctx.write({ field: "seo_title", value: "Bague en or jaune 18 carats, faite main à Lyon", expectedBefore: "Bague en or 18 carats, faite main à Lyon" });
  assert.equal(next.status, 201, JSON.stringify(next.body));
  ctx.setServe(() => pageRes(productHtml({ title: "Bague en or 18 carats, faite main à Lyon" })));
  release(pageRes(productHtml({ title: "Bague en or 18 carats, faite main à Lyon" })));
  const done = await Promise.all(waiting);
  assert.ok(done.every((x) => x.status === 400), done.map((x) => x.status).join(","));
  assert.equal(count(), 0, "aucune relecture enregistrée pour une modification remplacée");
  assert.equal((await ctx.find(r.body.change.id)).verification, null);
});

test("redirection non suivie : page_unavailable avec un message de redirection, pas d'« erreur »", async () => {
  const ctx = await setup();
  ctx.setServe(() => pageRes("", { status: 302 }));
  const r = await ctx.write({ field: "seo_title", value: "Bague en or 18 carats, faite main à Lyon", expectedBefore: "Bague en or 18 carats" });
  await ctx.fire();
  const c = await ctx.find(r.body.change.id);
  assert.equal(c.verification.reason, "page_unavailable");
  assert.match(c.verification.message, /renvoie vers une autre adresse/);
  assert.doesNotMatch(c.verification.message, /erreur/);
});

test("nom de l'élément retrouvé dans le nom de la boutique : pas de faux « échouée » durable", async () => {
  const ctx = await setup();
  const name = ctx.ring.title as string;
  const value = "Alliance fine en or 18 carats, faite main";
  const d = (await (await ctx.app.request(`${ctx.sh}/resources/${ctx.ring.id}`)).json()) as any;
  // L'ancienne valeur (ou, à défaut, le nom de l'élément) se retrouve dans le suffixe, pas au début du titre.
  const old = (d.resource.seoTitle ?? name) as string;
  ctx.setServe(() => pageRes(productHtml({ title: `${value} – ${old} & Co` })));
  const r = await ctx.write({ field: "seo_title", value, expectedBefore: d.resource.seoTitle });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await ctx.fire();
  const c = await ctx.find(r.body.change.id);
  assert.equal(c.verification.displayed, true);
  assert.notEqual(c.verification.reason, "not_displayed");
});

test("écriture non confirmée par Shopify (« pending ») : aucun statut de correction", async () => {
  const ctx = await setup();
  const row = insertPending(ctx.store.db, {
    site_host: SHOP_HOST, resource_id: ctx.ring.id, resource_gid: "gid://shopify/Product/1", resource_type: "product", resource_title: "Bague", path: "/products/bague-or",
    field: "seo_description", image_id: null, image_gid: null, image_url: null, locale: null, before_value: null,
    requested_value: "Texte", applied_at: new Date().toISOString(), kind: "edit", restores_change_id: null,
  });
  const c = await ctx.find(row.id);
  if (c) assert.equal(c.correctionStatus, null);
});
