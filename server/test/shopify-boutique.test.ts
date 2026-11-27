/**
 * Boutique Shopify : connexion, lecture, rapprochement avec l'analyse, écritures et historique.
 * Tout passe par un faux Shopify (fetch simulé) : aucun appel réseau réel, aucune écriture réelle.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { analysePage } from "../src/analyse/grille.ts";
import { runTool } from "../src/chat/tools.ts";
import { urlKey } from "../src/crawl/url.ts";
import { containsMutation, ShopifyAuth, ShopifyError, shopifyGraphql, shopifyMutate, ShopifyWritesDisabledError } from "../src/shopify/auth.ts";
import { insertPending, pathKey } from "../src/shopify/repo.ts";
import { hostAllowed } from "../src/http.ts";
import type { Store } from "../src/store.ts";
import { post, postEmpty, testEnv } from "./helpers/env.ts";
import { defaultState, FAKE_CREDS, fakeShopify, SHOP_HOST } from "./helpers/fake-shopify.ts";

// ───────── Préparation

function insertDoneAudit(store: Store, siteId: string, host: string, paths: string[]) {
  const audit = store.insertAudit(siteId, 20);
  const ids: Record<string, string> = {};
  for (const p of paths) {
    const url = `https://${host}${p}`;
    // Pas de description, une image sans texte alternatif : des problèmes à relier à la boutique.
    const a = analysePage(`<!doctype html><html lang="fr"><head><title>Page ${p} de la boutique d'essai</title></head><body><h1>Titre</h1><img src="/a.jpg"><p>Texte.</p></body></html>`, url);
    const row = store.insertPage({
      audit_id: audit.id,
      site_id: siteId,
      url,
      url_key: urlKey(url)!,
      path: p,
      title: a.facts.title,
      http_status: 200,
      score: a.score,
      issues: a.checks.filter((c) => c.status !== "pass").length,
      words: a.facts.words,
      analyzed_at: new Date().toISOString(),
      checks_json: JSON.stringify(a.checks),
      facts_json: JSON.stringify(a.facts),
      categories_json: JSON.stringify(a.categories),
      page_type: null,
    });
    ids[p] = row.id;
  }
  store.updateAudit(audit.id, { state: "done", finished_at: new Date().toISOString(), pages_done: paths.length, pages_queued: 0 });
  return { audit, ids };
}

const PAGES = ["/", "/products/bague-or", "/collections/bagues/products/collier", "/Blogs/Conseils/Entretenir-Ses-Bijoux", "/pages/contact"];

function setup(opts: { writesEnabled?: boolean; state?: ReturnType<typeof defaultState>; fake?: Parameters<typeof fakeShopify>[1]; host?: string } = {}) {
  const fake = fakeShopify(opts.state ?? defaultState(), opts.fake);
  const env = testEnv({ shopify: { fetchImpl: fake.impl, writesEnabled: opts.writesEnabled ?? false } });
  const host = opts.host ?? SHOP_HOST;
  const site = env.store.insertSite(`https://${host}/`, host, "Boutique Essai");
  const { ids } = insertDoneAudit(env.store, site.id, host, PAGES);
  const events: string[] = [];
  env.hub.subscribe(site.id, (ev) => events.push(ev.type));
  const base = `/api/sites/${site.id}/shopify`;
  return { ...env, fake, site, ids, events, base };
}

async function synced(opts: Parameters<typeof setup>[0] = {}) {
  const ctx = setup({ writesEnabled: true, ...opts });
  const res = await ctx.app.request(`${ctx.base}/sync`, postEmpty());
  assert.equal(res.status, 200, await res.clone().text());
  const list = (await (await ctx.app.request(`${ctx.base}/resources?limit=200`)).json()) as any;
  const byPath = Object.fromEntries(list.resources.map((r: any) => [r.path, r]));
  return { ...ctx, byPath };
}

const noSecrets = (text: string) => {
  assert.ok(!text.includes("myshopify"), "domaine myshopify.com renvoyé");
  assert.ok(!text.includes(FAKE_CREDS.clientSecret) && !text.includes(FAKE_CREDS.clientId), "identifiants renvoyés");
  assert.ok(!text.includes("jeton-secret"), "jeton renvoyé");
  assert.ok(!text.includes("gid://"), "identifiant Shopify renvoyé");
};

async function change(ctx: { app: any; base: string }, body: Record<string, unknown>) {
  const res = await ctx.app.request(`${ctx.base}/changes`, post(body));
  return { status: res.status, body: (await res.json()) as any };
}

// ───────── Séparation lecture / écriture

test("shopifyGraphql refuse toute mutation avant le moindre appel réseau ; shopifyMutate exige l'activation", async () => {
  const fake = fakeShopify();
  const auth = new ShopifyAuth(FAKE_CREDS, fake.impl);
  for (const doc of ["mutation { productUpdate(product: {}) { userErrors { message } } }", "  mutation X($a: ID!) { a }", "query A { a } mutation B { b }", "{a}\nmutation{b}"]) {
    await assert.rejects(shopifyGraphql(auth, doc, undefined, fake.impl), (e: unknown) => e instanceof ShopifyError, doc);
  }
  assert.equal(fake.calls.all, 0, "aucun appel réseau");
  // Le mot dans une chaîne, un commentaire ou un nom de champ n'est pas une mutation.
  assert.equal(containsMutation('{ products(query: "mutation") { nodes { id } } }'), false);
  assert.equal(containsMutation("# mutation\n{ shop { name } }"), false);
  assert.equal(containsMutation("{ __schema { mutationType { name } } }"), false);
  await assert.rejects(shopifyMutate(auth, false, "mutation { a }", {}, fake.impl), (e: unknown) => e instanceof ShopifyWritesDisabledError);
  await assert.rejects(shopifyMutate(auth, true, "{ shop { name } }", {}, fake.impl), (e: unknown) => e instanceof ShopifyError);
  assert.equal(fake.calls.all, 0);
});

// ───────── Connexion

test("boutique non configurée : état not_configured, les autres routes répondent shopify_not_configured", async () => {
  const env = testEnv();
  const site = env.store.insertSite(`https://${SHOP_HOST}/`, SHOP_HOST, null);
  const st = (await (await env.app.request(`/api/sites/${site.id}/shopify`)).json()) as any;
  assert.equal(st.connection.state, "not_configured");
  assert.equal(st.connection.writesEnabled, false);
  assert.equal(st.sync, null);
  for (const [path, init] of [["/resources", undefined], ["/changes", undefined], ["/sync", postEmpty()], ["/changes", post({})]] as const) {
    const res = await env.app.request(`/api/sites/${site.id}/shopify${path}`, init);
    assert.equal(res.status, 503, path);
    assert.equal(((await res.json()) as any).error.code, "shopify_not_configured");
  }
  const settings = (await (await env.app.request("/api/settings")).json()) as any;
  assert.deepEqual(settings.integrations.shopify, { configured: false, writesEnabled: false });
});

test("boutique d'un autre site : other_shop, aucune route ne donne accès à la boutique", async () => {
  const ctx = setup({ host: "autre-site.example" });
  const res = await ctx.app.request(ctx.base);
  const text = await res.text();
  noSecrets(text);
  const st = JSON.parse(text);
  assert.equal(st.connection.state, "other_shop");
  assert.equal(st.connection.shopName, "Boutique Essai");
  assert.equal(st.connection.shopHost, SHOP_HOST);
  assert.deepEqual(st.connection.scopes, []);
  for (const [path, init] of [["/sync", postEmpty()], ["/resources", undefined], ["/changes", undefined], ["/resources/shr_abcdef123456", undefined]] as const) {
    const r = await ctx.app.request(`${ctx.base}${path}`, init);
    assert.equal(r.status, 409, path);
    const body = await r.text();
    noSecrets(body);
    assert.equal(JSON.parse(body).error.code, "shopify_other_shop");
  }
  assert.equal(ctx.fake.calls.queries.filter((q) => q.includes("products(")).length, 0, "la boutique n'est pas lue");
});

test("connexion : permissions, langues, sans secret ; vérification gardée 60 s", async () => {
  let now = 1_000_000;
  const fake = fakeShopify();
  const env = testEnv({ shopify: { fetchImpl: fake.impl, now: () => now } });
  const site = env.store.insertSite(`https://${SHOP_HOST}/`, SHOP_HOST, null);
  const res = await env.app.request(`/api/sites/${site.id}/shopify`);
  const text = await res.text();
  noSecrets(text);
  const st = JSON.parse(text);
  assert.equal(st.connection.state, "connected");
  assert.equal(st.connection.shopHost, SHOP_HOST);
  assert.equal(st.connection.primaryLocale, "fr");
  assert.deepEqual(st.connection.otherLocales, ["en"], "langue non publiée écartée");
  assert.deepEqual(st.connection.missingScopes, []);
  assert.equal(st.connection.writesEnabled, false);
  assert.equal(st.sync, null);
  const before = fake.calls.queries.length;
  await env.app.request(`/api/sites/${site.id}/shopify`);
  assert.equal(fake.calls.queries.length, before, "gardée en mémoire");
  now += 61_000;
  await env.app.request(`/api/sites/${site.id}/shopify`);
  assert.ok(fake.calls.queries.length > before, "revérifiée après 60 s");
});

test("permissions manquantes : listées avec ce qu'elles empêchent, editable en découle, écriture refusée", async () => {
  const state = defaultState();
  state.scopes = state.scopes.filter((s) => s !== "write_files" && s !== "write_translations");
  const ctx = await synced({ state });
  const st = (await (await ctx.app.request(ctx.base)).json()) as any;
  assert.deepEqual(st.connection.missingScopes.map((m: any) => m.scope), ["write_files", "write_translations"]);
  assert.match(st.connection.missingScopes[0].blocks, /texte alternatif des images des produits/);
  const ring = ctx.byPath["/products/bague-or"];
  const detail = (await (await ctx.app.request(`${ctx.base}/resources/${ring.id}`)).json()) as any;
  assert.deepEqual(detail.resource.editable, { seo_title: true, seo_description: true, image_alt: false, translations: false });
  assert.ok(detail.resource.translations.every((t: any) => !t.editable && /write_translations/.test(t.reason)));
  const img = detail.resource.imageList[1];
  const before = ctx.fake.calls.mutations.length;
  const r = await change(ctx, { resourceId: ring.id, field: "image_alt", imageId: img.id, value: "Bague vue de côté", expectedBefore: null });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, "shopify_missing_scope");
  assert.equal(r.body.error.details.scope, "write_files");
  const t = await change(ctx, { resourceId: ring.id, field: "seo_title", locale: "en", value: "Gold ring", expectedBefore: "18k gold ring" });
  assert.equal(t.body.error.code, "shopify_missing_scope");
  assert.equal(ctx.fake.calls.mutations.length, before, "aucune écriture");
});

// ───────── Lecture et rapprochement

test("sync : tous les éléments, résumé, rapprochement avec l'analyse affichée, liens dans les pages et les preuves", async () => {
  const ctx = setup();
  const notSynced = await ctx.app.request(`${ctx.base}/resources`);
  assert.equal(((await notSynced.json()) as any).error.code, "shopify_not_synced");
  const res = await ctx.app.request(`${ctx.base}/sync`, postEmpty());
  const text = await res.text();
  noSecrets(text);
  const st = JSON.parse(text);
  assert.deepEqual(st.sync.counts, { product: 2, collection: 1, page: 1, article: 1 });
  assert.deepEqual(st.sync.missing, { seoTitle: 3, seoDescription: 4, imagesWithoutAlt: 3, images: 4 });
  assert.deepEqual(ctx.events, ["shopify"]);
  assert.equal(ctx.fake.calls.mutations.length, 0, "lecture seule");

  const listRes = await ctx.app.request(`${ctx.base}/resources`);
  assert.ok(listRes.headers.get("etag"));
  const list = (await listRes.json()) as any;
  assert.equal(list.total, 5);
  const byPath = Object.fromEntries(list.resources.map((r: any) => [r.path, r]));
  assert.deepEqual(Object.keys(byPath).sort(), ["/blogs/conseils/entretenir-ses-bijoux", "/collections/bagues", "/pages/contact", "/products/bague-or", "/products/collier"]);
  const ring = byPath["/products/bague-or"];
  assert.deepEqual(Object.keys(ring).sort(), ["audit", "changes", "id", "images", "imagesWithoutAlt", "pageId", "pageScore", "path", "seoDescription", "seoTitle", "title", "type"]);
  assert.match(ring.id, /^shr_[0-9a-f]{12}$/);
  assert.equal(ring.pageId, ctx.ids["/products/bague-or"]);
  assert.equal(typeof ring.pageScore, "number");
  assert.equal(ring.images, 2);
  assert.equal(ring.imagesWithoutAlt, 1);
  assert.equal(byPath["/products/collier"].pageId, ctx.ids["/collections/bagues/products/collier"], "produit vu depuis une collection");
  assert.equal(byPath["/blogs/conseils/entretenir-ses-bijoux"].pageId, ctx.ids["/Blogs/Conseils/Entretenir-Ses-Bijoux"], "chemin sans tenir compte de la casse");
  assert.equal(byPath["/pages/contact"].pageId, ctx.ids["/pages/contact"]);
  assert.equal(byPath["/collections/bagues"].pageId, null);
  assert.equal(byPath["/collections/bagues"].pageScore, null);

  // Filtres.
  const q = async (s: string): Promise<any> => (await ctx.app.request(`${ctx.base}/resources?${s}`)).json();
  assert.equal((await q("missing=seo_title")).total, 3);
  assert.equal((await q("missing=image_alt")).total, 3);
  assert.equal((await q("type=product")).total, 2);
  assert.equal((await q("q=collier")).total, 1);
  assert.equal((await q("type=product&limit=1&offset=1")).resources.length, 1);
  assert.equal(((await q("type=autre")) as any).error.code, "bad_request");

  // Identifiants stables d'une lecture à l'autre.
  await ctx.shopify.sync(ctx.site);
  assert.equal((await q("q=bague-or")).resources[0].id, ring.id);
  // Une lecture complète par minute au plus.
  const again = await ctx.app.request(`${ctx.base}/sync`, postEmpty());
  assert.equal(again.status, 429);
  const againBody = (await again.json()) as any;
  assert.equal(againBody.error.code, "rate_limited");
  assert.equal(typeof againBody.error.details.retryAfterSeconds, "number");

  // Page analysée → élément de la boutique.
  const page = (await (await ctx.app.request(`/api/sites/${ctx.site.id}/pages/${ctx.ids["/products/bague-or"]}`)).json()) as any;
  assert.equal(page.page.shopifyResourceId, ring.id);
  const home = (await (await ctx.app.request(`/api/sites/${ctx.site.id}/pages/${ctx.ids["/"]}`)).json()) as any;
  assert.equal(home.page.shopifyResourceId, null);

  // Preuves et champ qui corrige le problème.
  const issue = (await (await ctx.app.request(`/api/sites/${ctx.site.id}/issues/meta_description`)).json()) as any;
  assert.equal(issue.issue.shopifyField, "seo_description");
  const ev = Object.fromEntries(issue.issue.evidence.map((e: any) => [e.path, e.shopifyResourceId]));
  assert.equal(ev["/products/bague-or"], ring.id);
  assert.equal(ev["/collections/bagues/products/collier"], byPath["/products/collier"].id);
  assert.equal(ev["/"], null);
  const alt = (await (await ctx.app.request(`/api/sites/${ctx.site.id}/issues/image_alt`)).json()) as any;
  assert.equal(alt.issue.shopifyField, "image_alt");
  const h1 = (await (await ctx.app.request(`/api/sites/${ctx.site.id}/issues`)).json()) as any;
  assert.ok(h1.issues.every((i: any) => !("shopifyField" in i)), "la liste garde la forme Issue");

  // Nouvelle analyse : le rapprochement suit l'analyse affichée, jamais une ancienne.
  const { ids: ids2 } = insertDoneAudit(ctx.store, ctx.site.id, SHOP_HOST, ["/products/bague-or"]);
  const after = Object.fromEntries(((await q("limit=200")) as any).resources.map((r: any) => [r.path, r]));
  assert.equal(after["/products/bague-or"].pageId, ids2["/products/bague-or"]);
  assert.notEqual(after["/products/bague-or"].pageId, ring.pageId);
  assert.equal(after["/products/collier"].pageId, null);
  assert.equal(after["/pages/contact"].pageId, null);
});

test("outil de l'assistant boutique_shopify : lecture des données stockées, champs vides, par chemin", async () => {
  const ctx = await synced();
  const out = runTool(ctx.store, ctx.site, "boutique_shopify", { champ_vide: "seo_title" }, ctx.shopify);
  const data = JSON.parse(out.content);
  assert.equal(data.totaux.produits, 2);
  assert.equal(data.totaux.titre_google_vide, 3);
  assert.equal(data.elements_trouves, 3);
  assert.match(data.note, /non fiable|donnee_non_fiable/);
  const one = JSON.parse(runTool(ctx.store, ctx.site, "boutique_shopify", { chemin: "/products/bague" }, ctx.shopify).content);
  assert.equal(one.elements.length, 1);
  assert.equal(one.elements[0].titre_google_donnee_non_fiable, "Bague en or 18 carats");
  noSecrets(out.content);
  const none = JSON.parse(runTool(ctx.store, ctx.site, "boutique_shopify", {}, null).content);
  assert.equal(none.disponible, false);
});

// ───────── Écritures

test("écritures non activées : shopify_writes_disabled (403) avant tout appel à Shopify", async () => {
  const fake = fakeShopify();
  const env = testEnv({ shopify: { fetchImpl: fake.impl, writesEnabled: false } });
  const site = env.store.insertSite(`https://${SHOP_HOST}/`, SHOP_HOST, null);
  const r1 = await env.app.request(`/api/sites/${site.id}/shopify/changes`, post({ resourceId: "shr_abcdef123456", field: "seo_title", value: "x", expectedBefore: null }));
  assert.equal(r1.status, 403);
  const body = (await r1.json()) as any;
  assert.equal(body.error.code, "shopify_writes_disabled");
  assert.match(body.error.action, /SHOPIFY_WRITES_ENABLED=1/);
  const r2 = await env.app.request(`/api/sites/${site.id}/shopify/changes/chg_abc/restore`, postEmpty());
  assert.equal(((await r2.json()) as any).error.code, "shopify_writes_disabled");
  assert.equal(fake.calls.all, 0, "aucun appel réseau, pas même la demande de jeton");
  assert.deepEqual(((await (await env.app.request("/api/settings")).json()) as any).integrations.shopify, { configured: true, writesEnabled: false });
});

test("écriture de chaque champ sur chaque type, avec la bonne mutation ; relecture, historique, événement", async () => {
  const ctx = await synced();
  assert.deepEqual(((await (await ctx.app.request("/api/settings")).json()) as any).integrations.shopify, { configured: true, writesEnabled: true });
  const id = (p: string) => ctx.byPath[p].id;
  const detail = async (p: string) => ((await (await ctx.app.request(`${ctx.base}/resources/${id(p)}`)).json()) as any).resource;

  const SHA = /^[0-9a-f]{64}$/;
  const meta = (owner: string, key: string, value: string, type: string, digest: "sha" | null) => (v: Record<string, any>) => {
    assert.equal(v.metafields.length, 1, "une seule clé par écriture");
    const { compareDigest, ...rest } = v.metafields[0];
    assert.deepEqual(rest, { ownerId: owner, namespace: "global", key, value, type });
    if (digest) assert.match(compareDigest, SHA, "écriture conditionnelle");
    else assert.equal(compareDigest, null, "le metafield ne doit pas exister");
  };
  const cases: Array<{ path: string; field: string; before: string | null; value: string; root: string; image?: number; check: (v: Record<string, any>) => void }> = [
    // Titre et description, pour les quatre types : metafieldsSet sur une seule clé, avec digest.
    { path: "/products/bague-or", field: "seo_title", before: "Bague en or 18 carats", value: "Bague en or 18 carats faite main", root: "metafieldsSet", check: meta("gid://shopify/Product/1", "title_tag", "Bague en or 18 carats faite main", "string", "sha") },
    { path: "/products/bague-or", field: "seo_description", before: null, value: "Une bague en or.", root: "metafieldsSet", check: meta("gid://shopify/Product/1", "description_tag", "Une bague en or.", "single_line_text_field", null) },
    { path: "/collections/bagues", field: "seo_title", before: null, value: "Bagues en or", root: "metafieldsSet", check: meta("gid://shopify/Collection/5", "title_tag", "Bagues en or", "single_line_text_field", null) },
    { path: "/collections/bagues", field: "seo_description", before: null, value: "Toutes nos bagues.", root: "metafieldsSet", check: meta("gid://shopify/Collection/5", "description_tag", "Toutes nos bagues.", "single_line_text_field", null) },
    { path: "/pages/contact", field: "seo_title", before: null, value: "Contactez-nous", root: "metafieldsSet", check: meta("gid://shopify/Page/7", "title_tag", "Contactez-nous", "single_line_text_field", null) },
    { path: "/pages/contact", field: "seo_description", before: null, value: "Écrivez-nous.", root: "metafieldsSet", check: meta("gid://shopify/Page/7", "description_tag", "Écrivez-nous.", "single_line_text_field", null) },
    { path: "/blogs/conseils/entretenir-ses-bijoux", field: "seo_title", before: "Entretenir ses bijoux en or", value: "Entretenir ses bijoux", root: "metafieldsSet", check: meta("gid://shopify/Article/9", "title_tag", "Entretenir ses bijoux", "string", "sha") },
    { path: "/blogs/conseils/entretenir-ses-bijoux", field: "seo_description", before: null, value: "Nos conseils.", root: "metafieldsSet", check: meta("gid://shopify/Article/9", "description_tag", "Nos conseils.", "single_line_text_field", null) },
    // Texte alternatif : images de produit seulement.
    { path: "/products/bague-or", field: "image_alt", image: 1, before: null, value: "Bague vue de côté", root: "fileUpdate", check: (v) => assert.deepEqual(v, { files: [{ id: "gid://shopify/MediaImage/12", alt: "Bague vue de côté" }] }) },
  ];
  for (const c of cases) {
    const d = await detail(c.path);
    const imageId = c.image !== undefined ? d.imageList[c.image].id : undefined;
    const n = ctx.fake.calls.mutations.length;
    ctx.events.length = 0;
    const r = await change(ctx, { resourceId: id(c.path), field: c.field, ...(imageId ? { imageId } : {}), value: c.value, expectedBefore: c.before });
    assert.equal(r.status, 201, `${c.path} ${c.field} : ${JSON.stringify(r.body)}`);
    assert.equal(ctx.fake.calls.mutations.length, n + 1, "une seule mutation");
    const m = ctx.fake.calls.mutations[n];
    assert.match(m.query, new RegExp(`\\b${c.root}\\(`), `${c.path} ${c.field}`);
    c.check(m.variables);
    assert.equal(r.body.change.before, c.before);
    assert.equal(r.body.change.after, c.value);
    assert.equal(r.body.change.afterVerified, true);
    assert.equal(r.body.change.kind, "edit");
    assert.equal(r.body.change.restorable, true);
    assert.equal(r.body.change.locale, null);
    if (imageId) assert.deepEqual(r.body.change.image, { id: imageId, url: d.imageList[c.image!].url });
    else assert.equal(r.body.change.image, null);
    const after = c.field === "image_alt" ? r.body.resource.imageList[c.image!].alt : c.field === "seo_title" ? r.body.resource.seoTitle : r.body.resource.seoDescription;
    assert.equal(after, c.value, "valeur relue dans Shopify");
    assert.equal(r.body.resource.history[0].id, r.body.change.id);
    assert.deepEqual(ctx.events, ["shopify"]);
    noSecrets(JSON.stringify(r.body));
  }
  // Une page n'a pas d'image.
  const pageImg = await change(ctx, { resourceId: id("/pages/contact"), field: "image_alt", imageId: "img_abcdef123456", value: "x", expectedBefore: null });
  assert.equal(pageImg.status, 400);

  // L'autre moitié n'est jamais touchée : le titre du produit est resté en place après l'écriture de sa description.
  assert.equal(ctx.fake.state.products[0].meta.title_tag?.value, "Bague en or 18 carats faite main");
  // Historique et résumé à jour.
  const hist = (await (await ctx.app.request(`${ctx.base}/changes`)).json()) as any;
  assert.equal(hist.total, cases.length);
  assert.equal(hist.changes[0].field, "image_alt");
  const list = (await (await ctx.app.request(`${ctx.base}/resources?q=bague-or`)).json()) as any;
  assert.equal(list.resources[0].changes, 3);
  assert.equal(list.resources[0].imagesWithoutAlt, 0);
  assert.equal(list.resources[0].seoDescription, "Une bague en or.");
});

test("valeurs : espaces normalisés, jamais transformées ; chevrons, caractères de contrôle et longueur refusés (shopify_invalid_value)", async () => {
  const ctx = await synced();
  const ring = ctx.byPath["/products/collier"].id;
  const r = await change(ctx, { resourceId: ring, field: "seo_title", value: "  Collier\n  fin \t  en or ", expectedBefore: null });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(ctx.fake.calls.mutations.at(-1)!.variables.metafields[0].value, "Collier fin en or");
  const n = ctx.fake.calls.mutations.length;
  const invalid = async (body: Record<string, unknown>, re: RegExp) => {
    const res = await change(ctx, { resourceId: ring, expectedBefore: "Collier fin en or", ...body });
    assert.equal(res.status, 422, JSON.stringify(res.body));
    assert.equal(res.body.error.code, "shopify_invalid_value");
    assert.match(res.body.error.message, re);
    assert.ok(res.body.error.action);
  };
  // Autrefois « Prix < 20 € et > 10 € » devenait « Prix 10 € » : désormais refusé tel quel.
  await invalid({ field: "seo_title", value: "Prix < 20 € et > 10 €" }, /« < » ou « > »/);
  await invalid({ field: "seo_title", value: "<b>Collier</b>" }, /« < » ou « > »/);
  await invalid({ field: "seo_title", value: "Collier\u0007 fin" }, /caractère invisible/);
  await invalid({ field: "seo_title", value: "x".repeat(256) }, /256 caractères ; 255 au plus/);
  await invalid({ field: "seo_description", value: "y".repeat(501), expectedBefore: "Un collier fin." }, /501 caractères ; 500 au plus/);
  // Longueur en points de code : 255 émojis passent, 256 non.
  await invalid({ field: "seo_title", value: "💎".repeat(256) }, /256 caractères/);
  const emojis = await change(ctx, { resourceId: ring, field: "seo_title", value: "💎".repeat(255), expectedBefore: "Collier fin en or" });
  assert.equal(emojis.status, 201);
  const n2 = ctx.fake.calls.mutations.length;
  assert.equal(n2, n + 1);
  const same = await change(ctx, { resourceId: ring, field: "seo_title", value: "💎".repeat(255) + "  ", expectedBefore: "💎".repeat(255) });
  assert.equal(same.status, 400);
  assert.match(same.body.error.message, /déjà en place/);
  for (const bad of [
    { field: "seo_title", value: "x", expectedBefore: null },
    { resourceId: ring, field: "title", value: "x", expectedBefore: null },
    { resourceId: ring, field: "image_alt", value: "x", expectedBefore: null },
    { resourceId: ring, field: "seo_title", value: "x" },
    { resourceId: ring, field: "image_alt", imageId: "img_abcdef123456", locale: "en", value: "x", expectedBefore: null },
    { resourceId: ring, field: "seo_title", locale: "it", value: "x", expectedBefore: null },
  ]) {
    const res = await change(ctx, bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal(res.body.error.code, "bad_request");
  }
  assert.equal(ctx.fake.calls.mutations.length, n2, "aucune écriture");
  assert.equal(((await (await ctx.app.request(`${ctx.base}/changes`)).json()) as any).total, 2);
});

test("texte alternatif d'une collection, d'un article ou d'une page : affiché, non modifiable, refusé sans appel d'écriture", async () => {
  const ctx = await synced();
  for (const path of ["/collections/bagues", "/blogs/conseils/entretenir-ses-bijoux"]) {
    const d = ((await (await ctx.app.request(`${ctx.base}/resources/${ctx.byPath[path].id}`)).json()) as any).resource;
    assert.equal(d.imageList.length, 1, "image listée");
    assert.equal(d.editable.image_alt, false);
    assert.match(d.readOnlyReasons.image_alt, /remplacer ou retirer l'image/);
    assert.equal(d.editable.seo_title, true);
    assert.equal(d.readOnlyReasons.seo_title, undefined);
    const n = ctx.fake.calls.mutations.length;
    const r = await change(ctx, { resourceId: ctx.byPath[path].id, field: "image_alt", imageId: d.imageList[0].id, value: "Une image", expectedBefore: null });
    assert.equal(r.status, 400, path);
    assert.match(r.body.error.message, /administration Shopify/);
    assert.equal(ctx.fake.calls.mutations.length, n, "aucun appel d'écriture");
  }
  const page = ((await (await ctx.app.request(`${ctx.base}/resources/${ctx.byPath["/pages/contact"].id}`)).json()) as any).resource;
  assert.equal(page.editable.image_alt, false);
  assert.match(page.readOnlyReasons.image_alt, /thème/);
  assert.equal(ctx.fake.calls.mutations.length, 0);
});

test("conflit : la valeur a changé dans Shopify → shopify_conflict avec la valeur actuelle, rien n'est écrit", async () => {
  const ctx = await synced();
  const ring = ctx.byPath["/products/bague-or"].id;
  const n = ctx.fake.calls.mutations.length;
  const r = await change(ctx, { resourceId: ring, field: "seo_title", value: "Nouveau titre", expectedBefore: "Ancien titre affiché" });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, "shopify_conflict");
  assert.equal(r.body.error.details.current, "Bague en or 18 carats");
  assert.equal(ctx.fake.calls.mutations.length, n);
  // Modification faite ailleurs entre la relecture et l'écriture (metafield) : Shopify refuse (compareDigest).
  const ctx2 = await synced({
    fake: {
      beforeMutation: (s) => {
        s.articles[0].meta.title_tag = { id: "gid://shopify/Metafield/91", value: "Modifié ailleurs", type: "string" };
      },
    },
  });
  const art = ctx2.byPath["/blogs/conseils/entretenir-ses-bijoux"].id;
  const r2 = await change(ctx2, { resourceId: art, field: "seo_title", value: "Mon titre", expectedBefore: "Entretenir ses bijoux en or" });
  assert.equal(r2.status, 409);
  assert.equal(r2.body.error.details.current, "Modifié ailleurs");
  assert.equal(((await (await ctx2.app.request(`${ctx2.base}/changes`)).json()) as any).total, 0, "rien d'enregistré");
});

test("userErrors de Shopify : erreur claire, rien n'est enregistré", async () => {
  const ctx = await synced({ fake: { userErrorOn: "metafieldsSet" } });
  const r = await change(ctx, { resourceId: ctx.byPath["/products/bague-or"].id, field: "seo_title", value: "Nouveau", expectedBefore: "Bague en or 18 carats" });
  assert.equal(r.status, 422);
  assert.match(r.body.error.message, /Shopify a refusé la modification : Valeur refusée par la boutique/);
  assert.equal(((await (await ctx.app.request(`${ctx.base}/changes`)).json()) as any).total, 0);
  assert.equal(ctx.events.filter((e) => e === "shopify").length, 1, "seulement la lecture");
});

test("traductions : modifier, retirer par restauration, non modifiable sans texte d'origine", async () => {
  const ctx = await synced();
  const ring = ctx.byPath["/products/bague-or"].id;
  const collier = ctx.byPath["/products/collier"].id;
  const d = ((await (await ctx.app.request(`${ctx.base}/resources/${ring}`)).json()) as any).resource;
  assert.deepEqual(d.translations, [
    { locale: "en", field: "seo_title", value: "18k gold ring", outdated: false, editable: true, reason: null },
    { locale: "en", field: "seo_description", value: null, outdated: false, editable: false, reason: "La description pour Google est vide en français : renseignez-la d'abord." },
  ]);
  const r = await change(ctx, { resourceId: ring, field: "seo_title", locale: "en", value: "Handmade 18k gold ring", expectedBefore: "18k gold ring" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const m = ctx.fake.calls.mutations.at(-1)!;
  assert.match(m.query, /translationsRegister\(/);
  assert.equal(m.variables.resourceId, "gid://shopify/Product/1");
  assert.equal(m.variables.translations[0].key, "meta_title");
  assert.equal(m.variables.translations[0].locale, "en");
  assert.match(m.variables.translations[0].translatableContentDigest, /^[0-9a-f]{64}$/);
  assert.equal(r.body.change.locale, "en");
  assert.equal(r.body.change.after, "Handmade 18k gold ring");
  assert.equal(r.body.resource.translations[0].value, "Handmade 18k gold ring");
  // Pas de texte d'origine : refusé sans écrire.
  const n = ctx.fake.calls.mutations.length;
  const none = await change(ctx, { resourceId: collier, field: "seo_title", locale: "en", value: "Necklace", expectedBefore: null });
  assert.equal(none.status, 400);
  assert.equal(ctx.fake.calls.mutations.length, n);
  // Traduction absente → ajoutée, puis restaurée = retirée.
  const add = await change(ctx, { resourceId: collier, field: "seo_description", locale: "en", value: "A fine necklace.", expectedBefore: null });
  assert.equal(add.status, 201);
  assert.equal(add.body.change.before, null);
  const back = await ctx.app.request(`${ctx.base}/changes/${add.body.change.id}/restore`, postEmpty());
  const b = (await back.json()) as any;
  assert.equal(back.status, 201, JSON.stringify(b));
  const rm = ctx.fake.calls.mutations.at(-1)!;
  assert.match(rm.query, /translationsRemove\(/);
  assert.deepEqual(rm.variables, { resourceId: "gid://shopify/Product/2", translationKeys: ["meta_description"], locales: ["en"] });
  assert.equal(b.change.after, null);
  assert.equal(b.change.kind, "restore");
  assert.equal(ctx.fake.state.translations["gid://shopify/Product/2"]?.en?.meta_description, undefined);
});

test("restauration : valeur d'avant remise, vers une valeur vide (metafield supprimé), annulation d'une annulation, seule la dernière", async () => {
  const ctx = await synced();
  const page = ctx.byPath["/pages/contact"].id;
  // Une valeur vide remplie, puis restaurée : le metafield est supprimé.
  const first = await change(ctx, { resourceId: page, field: "seo_title", value: "Contact", expectedBefore: null });
  assert.equal(first.status, 201);
  const r1 = (await (await ctx.app.request(`${ctx.base}/changes/${first.body.change.id}/restore`, postEmpty())).json()) as any;
  assert.ok(r1.change, JSON.stringify(r1));
  assert.equal(r1.change.kind, "restore");
  assert.equal(r1.change.restoresChangeId, first.body.change.id);
  assert.equal(r1.change.before, "Contact");
  assert.equal(r1.change.after, null, "retour au champ vide");
  const del = ctx.fake.calls.mutations.at(-1)!;
  assert.match(del.query, /metafieldsDelete\(/);
  assert.deepEqual(del.variables, { metafields: [{ ownerId: "gid://shopify/Page/7", namespace: "global", key: "title_tag" }] });
  assert.equal(ctx.fake.state.pages[0].meta.title_tag, undefined);
  assert.equal(r1.resource.seoTitle, null);
  // Annuler l'annulation rétablit la valeur.
  const r2 = (await (await ctx.app.request(`${ctx.base}/changes/${r1.change.id}/restore`, postEmpty())).json()) as any;
  assert.equal(r2.change.after, "Contact");
  assert.equal((ctx.fake.state.pages[0].meta as Record<string, { value: string } | undefined>).title_tag?.value, "Contact");
  // Déjà annulée.
  assert.equal((await ctx.app.request(`${ctx.base}/changes/${r1.change.id}/restore`, postEmpty())).status, 400);

  // Seule la dernière modification d'un champ est annulable.
  const second = await change(ctx, { resourceId: page, field: "seo_title", value: "Nous contacter", expectedBefore: "Contact" });
  assert.equal(second.status, 201);
  const old = await ctx.app.request(`${ctx.base}/changes/${r2.change.id}/restore`, postEmpty());
  assert.equal(old.status, 400);
  assert.match(((await old.json()) as any).error.message, /dernière modification/);
  const r3 = (await (await ctx.app.request(`${ctx.base}/changes/${second.body.change.id}/restore`, postEmpty())).json()) as any;
  assert.equal(r3.change.before, "Nous contacter");
  assert.equal(r3.change.after, "Contact");
  assert.equal(ctx.fake.calls.mutations.at(-1)!.variables.metafields[0].value, "Contact");
  const all = (await (await ctx.app.request(`${ctx.base}/changes`)).json()) as any;
  const byId = Object.fromEntries(all.changes.map((c: any) => [c.id, c]));
  assert.equal(byId[first.body.change.id].restoredByChangeId, r1.change.id);
  assert.equal(byId[r1.change.id].restoredByChangeId, r2.change.id);
  assert.equal(byId[second.body.change.id].restoredByChangeId, r3.change.id);
  assert.deepEqual(all.changes.filter((c: any) => c.restorable).map((c: any) => c.id), [r3.change.id]);

  // Restauration en conflit : la valeur a changé dans Shopify depuis la modification.
  const ring = ctx.byPath["/products/bague-or"].id;
  const e = await change(ctx, { resourceId: ring, field: "seo_title", value: "Titre écrit", expectedBefore: "Bague en or 18 carats" });
  ctx.fake.state.products[0].meta.title_tag = { id: "gid://shopify/Metafield/81", value: "Changé dans l'administration", type: "string" };
  const n = ctx.fake.calls.mutations.length;
  const conflict = await ctx.app.request(`${ctx.base}/changes/${e.body.change.id}/restore`, postEmpty());
  assert.equal(conflict.status, 409);
  assert.equal(((await conflict.json()) as any).error.details.current, "Changé dans l'administration");
  assert.equal(ctx.fake.calls.mutations.length, n);
});

test("historique : lignes intouchables, conservées après la suppression du site", async () => {
  const ctx = await synced();
  const r = await change(ctx, { resourceId: ctx.byPath["/products/collier"].id, field: "seo_title", value: "Collier fin", expectedBefore: null });
  assert.equal(r.status, 201);
  const db = ctx.store.db;
  assert.throws(() => db.prepare("UPDATE shopify_changes SET after_value = 'x'").run(), /interdite/);
  assert.throws(() => db.prepare("DELETE FROM shopify_changes").run(), /interdite/);
  assert.equal((await ctx.app.request(`/api/sites/${ctx.site.id}`, { method: "DELETE", headers: { "content-type": "application/json" } })).status, 204);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM shopify_changes").get() as any).n, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM shopify_resources").get() as any).n, 0);
  // Le site ajouté de nouveau retrouve son historique (rattaché à son hôte).
  const again = ctx.store.insertSite(`https://${SHOP_HOST}/`, SHOP_HOST, null);
  const hist = (await (await ctx.app.request(`/api/sites/${again.id}/shopify/changes`)).json()) as any;
  assert.equal(hist.total, 1);
  assert.equal(hist.changes[0].after, "Collier fin");
});

test("limite : 30 écritures par minute au plus", async () => {
  const ctx = await synced();
  let last = 0;
  for (let i = 0; i < 31; i++) last = (await ctx.app.request(`${ctx.base}/changes`, post({}))).status;
  assert.equal(last, 429);
});

test("clé de chemin : décodée, sans paramètres, sans slash final, sans casse", () => {
  assert.equal(pathKey("/Products/Bague-Or/?variant=1#x"), "/products/bague-or");
  assert.equal(pathKey("/collections/caf%C3%A9"), "/collections/café");
  assert.equal(pathKey("/"), "/");
});

// ───────── Corrections de la revue QA et sécurité

test("rebond DNS : un Host qui n'est pas localhost ni déclaré est refusé, en lecture comme en écriture", async () => {
  const { app } = testEnv();
  const evil = "rebond.attaquant.example:8787";
  const get = await app.request("http://rebond.attaquant.example:8787/api/sites", { headers: { host: evil } });
  assert.equal(get.status, 403);
  assert.equal(((await get.json()) as any).error.code, "bad_request");
  // Origin et Host identiques (c'est le cas d'un rebond DNS) : refusé quand même.
  const write = await app.request("http://rebond.attaquant.example:8787/api/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json", host: evil, origin: `http://${evil}` },
    body: JSON.stringify({ maxPagesDefault: 10 }),
  });
  assert.equal(write.status, 403);
  const shop = await app.request("http://rebond.attaquant.example:8787/api/sites/x/shopify/changes", { method: "POST", headers: { "content-type": "application/json", host: evil, origin: `http://${evil}` }, body: "{}" });
  assert.equal(shop.status, 403);
  for (const ok of ["localhost:8787", "127.0.0.1:8787", "[::1]:8787", "localhost:5173", "localhost"]) {
    assert.equal((await app.request("http://localhost/api/health", { headers: { host: ok } })).status, 200, ok);
  }
  for (const bad of ["127.0.0.1:9999", "localhost.attaquant.example", "10.0.0.5:8787", "localhost:8787@evil", ""]) {
    assert.equal(hostAllowed(bad, 8787, []), false, bad);
  }
  assert.equal(hostAllowed("seo.exemple.fr", 8787, ["seo.exemple.fr"]), true);
  assert.equal(hostAllowed("seo.exemple.fr:443", 8787, ["seo.exemple.fr"]), true);
  assert.equal(hostAllowed("seo.exemple.fr:8443", 8787, ["seo.exemple.fr:443"]), false);
});

test("journal avant écriture : mutation acceptée puis relecture en échec → succès, afterVerified false, annulable", async () => {
  const ctx = await synced({ fake: { failReadsAfterMutation: true } });
  const ring = ctx.byPath["/products/bague-or"].id;
  const r = await change(ctx, { resourceId: ring, field: "seo_title", value: "Bague en or faite main", expectedBefore: "Bague en or 18 carats" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(ctx.fake.calls.mutations.length, 1);
  assert.equal(r.body.change.before, "Bague en or 18 carats");
  assert.equal(r.body.change.after, "Bague en or faite main");
  assert.equal(r.body.change.afterVerified, false);
  assert.equal(r.body.change.restorable, true);
  assert.equal(r.body.resource.seoTitle, "Bague en or faite main");
  const hist = (await (await ctx.app.request(`${ctx.base}/changes`)).json()) as any;
  assert.equal(hist.total, 1);
  assert.equal(hist.changes[0].afterVerified, false);
  assert.deepEqual(ctx.events.slice(-1), ["shopify"]);
});

test("journal avant écriture : réponse perdue mais écriture faite → relue et enregistrée ; refus → ligne en échec, hors historique", async () => {
  const lost = await synced({ fake: { loseMutationResponse: true } });
  const r = await change(lost, { resourceId: lost.byPath["/products/collier"].id, field: "seo_title", value: "Collier fin", expectedBefore: null });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.change.afterVerified, true);
  assert.equal(r.body.change.after, "Collier fin");

  const refused = await synced({ fake: { userErrorOn: "metafieldsSet" } });
  const x = await change(refused, { resourceId: refused.byPath["/products/collier"].id, field: "seo_title", value: "Collier fin", expectedBefore: null });
  assert.equal(x.status, 422);
  const rows = refused.store.db.prepare("SELECT status, before_value, requested_value FROM shopify_changes").all() as any[];
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ status: "failed", before_value: null, requested_value: "Collier fin" }], "enregistrée avant l'appel, marquée en échec");
  assert.equal(((await (await refused.app.request(`${refused.base}/changes`)).json()) as any).total, 0);
  assert.throws(() => refused.store.db.prepare("UPDATE shopify_changes SET status = 'applied'").run(), /interdite/, "une ligne en échec ne change plus");
  assert.throws(() => refused.store.db.prepare("DELETE FROM shopify_changes").run(), /interdite/);
});

test("journal avant écriture : une ligne restée en attente (arrêt brutal) est visible, puis tranchée par la relecture", async () => {
  const ctx = await synced();
  const ring = ctx.byPath["/products/bague-or"];
  const base = {
    site_host: SHOP_HOST, resource_id: ring.id, resource_gid: "gid://shopify/Product/1", resource_type: "product" as const, resource_title: "Bague en or", path: ring.path,
    field: "seo_title" as const, image_id: null, image_gid: null, image_url: null, locale: null, applied_at: new Date().toISOString(), kind: "edit" as const, restores_change_id: null,
  };
  // L'écriture a eu lieu chez Shopify avant l'arrêt.
  const done = insertPending(ctx.store.db, { ...base, before_value: "Ancien titre", requested_value: "Bague en or 18 carats" });
  // Une autre n'a jamais atteint Shopify.
  const never = insertPending(ctx.store.db, { ...base, field: "seo_description", before_value: null, requested_value: "Jamais écrite" });
  let hist = (await (await ctx.app.request(`${ctx.base}/changes`)).json()) as any;
  assert.equal(hist.total, 2, "visibles, non perdues");
  assert.ok(hist.changes.every((c: any) => c.afterVerified === false));
  await ctx.app.request(`${ctx.base}/resources/${ring.id}`); // relecture en direct : tranche
  hist = (await (await ctx.app.request(`${ctx.base}/changes`)).json()) as any;
  assert.deepEqual(hist.changes.map((c: any) => [c.id, c.afterVerified]), [[done.id, true]]);
  assert.equal((ctx.store.db.prepare("SELECT status FROM shopify_changes WHERE id = ?").get(never.id) as any).status, "failed");
});

test("liens « corriger dans Shopify » seulement où le champ est modifiable ; PageDetail garde la correspondance", async () => {
  const ctx = await synced();
  const alt = ((await (await ctx.app.request(`/api/sites/${ctx.site.id}/issues/image_alt`)).json()) as any).issue;
  const ev = Object.fromEntries(alt.evidence.map((e: any) => [e.path, e.shopifyResourceId]));
  assert.equal(ev["/products/bague-or"], ctx.byPath["/products/bague-or"].id, "produit avec une image sans texte alternatif");
  assert.equal(ev["/collections/bagues/products/collier"], null, "produit sans image à corriger");
  assert.equal(ev["/pages/contact"], null, "jamais sur une page");
  assert.equal(ev["/Blogs/Conseils/Entretenir-Ses-Bijoux"], null, "jamais sur un article");
  const desc = ((await (await ctx.app.request(`/api/sites/${ctx.site.id}/issues/meta_description`)).json()) as any).issue;
  const dev = Object.fromEntries(desc.evidence.map((e: any) => [e.path, e.shopifyResourceId]));
  assert.equal(dev["/Blogs/Conseils/Entretenir-Ses-Bijoux"], ctx.byPath["/blogs/conseils/entretenir-ses-bijoux"].id);
  assert.equal(dev["/pages/contact"], ctx.byPath["/pages/contact"].id);
  const h1 = ((await (await ctx.app.request(`/api/sites/${ctx.site.id}/issues/h1`)).json()) as any).issue;
  if (h1?.evidence) assert.ok(h1.evidence.every((e: any) => e.shopifyResourceId === null), "aucun champ Shopify pour ce problème");
  const page = ((await (await ctx.app.request(`/api/sites/${ctx.site.id}/pages/${ctx.ids["/pages/contact"]}`)).json()) as any).page;
  assert.equal(page.shopifyResourceId, ctx.byPath["/pages/contact"].id);
});

test("hôte myshopify.com jamais renvoyé ; valeur trop longue pour être annulée fidèlement : non modifiable", async () => {
  const state = defaultState();
  state.shop.host = "boutique-essai.myshopify.com";
  const other = setup({ state });
  const st = (await (await other.app.request(other.base)).json()) as any;
  assert.equal(st.connection.state, "other_shop");
  assert.equal(st.connection.shopHost, null);
  const err = (await (await other.app.request(`${other.base}/resources`)).json()) as any;
  assert.equal(err.error.details.shopHost, null);

  const s2 = defaultState();
  s2.pages[0].meta.title_tag = { id: "gid://shopify/Metafield/99", value: "a".repeat(6000), type: "single_line_text_field" };
  const ctx = await synced({ state: s2 });
  const d = ((await (await ctx.app.request(`${ctx.base}/resources/${ctx.byPath["/pages/contact"].id}`)).json()) as any).resource;
  assert.equal(d.editable.seo_title, false);
  assert.match(d.readOnlyReasons.seo_title, /5 000 caractères/);
  const r = await change(ctx, { resourceId: ctx.byPath["/pages/contact"].id, field: "seo_title", value: "Contact", expectedBefore: d.seoTitle });
  assert.equal(r.status, 400);
  assert.equal(ctx.fake.calls.mutations.length, 0);
});

test("historique et liste des éléments consultables quand Shopify ne répond pas", async () => {
  let now = 1_000_000;
  const fake = fakeShopify();
  const env = testEnv({ shopify: { fetchImpl: fake.impl, writesEnabled: true, now: () => now } });
  const site = env.store.insertSite(`https://${SHOP_HOST}/`, SHOP_HOST, null);
  const base = `/api/sites/${site.id}/shopify`;
  assert.equal((await env.app.request(`${base}/sync`, postEmpty())).status, 200);
  const list = (await (await env.app.request(`${base}/resources`)).json()) as any;
  assert.equal((await change({ app: env.app, base }, { resourceId: list.resources[1].id, field: "seo_title", value: "Collier fin", expectedBefore: null })).status, 201);
  fake.control.down = true;
  now += 120_000; // la vérification de connexion gardée en mémoire a expiré
  const res = await env.app.request(`${base}/resources`);
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as any).total, 5);
  const ch = await env.app.request(`${base}/changes`);
  assert.equal(ch.status, 200);
  assert.equal(((await ch.json()) as any).total, 1);
  const st = (await (await env.app.request(base)).json()) as any;
  assert.equal(st.connection.state, "error");
  assert.equal(st.connection.error.code, "shopify_unavailable");
});
