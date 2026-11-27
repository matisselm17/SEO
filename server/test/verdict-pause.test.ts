/**
 * Verdict de l'analyse sur les éléments de la boutique (audit, toFix, fix=) et date de reprise d'un parcours en
 * pause (pausedUntil). Faux Shopify et site d'essai local : aucun appel réel.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setAllowPrivateHosts } from "../src/net/fetch.ts";
import { post, testEnv } from "./helpers/env.ts";
import { shopCatalogue, startShopFixture } from "./helpers/fixture-site.ts";
import { json, shop } from "./helpers/boutique.ts";

before(() => setAllowPrivateHosts(true));
after(() => setAllowPrivateHosts(false));

const page = (title: string, description?: string) =>
  `<!doctype html><html lang="fr"><head><title>${title}</title>${description ? `<meta name="description" content="${description}">` : ""}</head><body><h1>Titre</h1><p>Texte.</p></body></html>`;

test("audit et toFix : le verdict porte sur ce qui est affiché, pas sur le champ vide dans Shopify ; fix= filtre dessus", async () => {
  const ctx = await shop({
    html: {
      // Titre vide dans Shopify (collier) mais titre affiché correct ; description affichée correcte.
      "/collections/bagues/products/collier": page("Collier fin en or 18 carats | Boutique Essai", "Un collier fin en or 18 carats, chaîne ajustable, livré dans un écrin prêt à offrir."),
      // Titre trop court affiché (warn) et description absente (fail).
      "/products/bague-or": page("Bague en or"),
    },
  });
  const collier = ctx.byPath["/products/collier"];
  const ring = ctx.byPath["/products/bague-or"];
  assert.equal(collier.seoTitle, null, "champ vide dans Shopify…");
  assert.deepEqual(collier.audit, {
    renderedTitle: "Collier fin en or 18 carats | Boutique Essai",
    titleStatus: "pass",
    renderedDescription: "Un collier fin en or 18 carats, chaîne ajustable, livré dans un écrin prêt à offrir.",
    descriptionStatus: "pass",
  }, "… mais rien à corriger : Shopify affiche le nom");
  assert.equal(ring.audit.titleStatus, "warn");
  assert.equal(ring.audit.descriptionStatus, "fail");
  assert.equal(ring.audit.renderedDescription, null);
  assert.equal(ctx.byPath["/collections/bagues"].audit, null, "page non ouverte");
  // toFix : parmi les éléments dont la page a été ouverte (bague, collier, article, page contact = 4).
  // Titres en défaut : la bague (11 caractères) et l'article (titre affiché de 65 caractères).
  const st = (await (await ctx.app.request(`${ctx.base}/shopify`)).json()) as any;
  assert.deepEqual(st.sync.toFix, { audited: 4, title: 2, description: 3 });
  const titles = (await (await ctx.app.request(`${ctx.base}/shopify/resources?fix=seo_title`)).json()) as any;
  assert.deepEqual(titles.resources.map((r: any) => r.path), ["/products/bague-or", "/blogs/conseils/entretenir-ses-bijoux"]);
  const descs = (await (await ctx.app.request(`${ctx.base}/shopify/resources?fix=seo_description`)).json()) as any;
  assert.equal(descs.total, 3);
  assert.ok(!descs.resources.some((r: any) => r.path === "/products/collier"));
  assert.equal((await json(await ctx.app.request(`${ctx.base}/shopify/resources?fix=image_alt`))).status, 400);
  // Recalculé depuis l'analyse affichée : une nouvelle analyse terminée sans ces pages efface le verdict.
  const a2 = ctx.store.insertAudit(ctx.site.id, 5);
  ctx.store.updateAudit(a2.id, { state: "done", finished_at: new Date().toISOString(), pages_done: 0 });
  const st2 = (await (await ctx.app.request(`${ctx.base}/shopify`)).json()) as any;
  assert.deepEqual(st2.sync.toFix, { audited: 4, title: 2, description: 3 }, "une analyse sans page notée ne remplace pas l'analyse affichée");
  // Détail en direct : même verdict.
  const detail = (await (await ctx.app.request(`${ctx.base}/shopify/resources/${ring.id}`)).json()) as any;
  assert.equal(detail.resource.audit.titleStatus, "warn");
});

test("pausedUntil : publié pendant la pause après un 429 (date réelle de reprise), null ensuite", async () => {
  const first = `/products/${shopCatalogue()[0].handle}`;
  const site = await startShopFixture(0, { refuse: { paths: { [first]: 1 } } });
  try {
    const env = testEnv({ delayMs: 0, cataloguePageSize: 8, retry: { maxRetries: 3, firstPauseMs: 800, maxPauseMs: 800, maxRetryAfterMs: 1000, slowDelayMs: 5, maxSlowDelayMs: 10, budgetMs: 5000, catalogueBudgetMs: 1000 } });
    const res = await env.app.request("/api/sites", post({ url: site.origin, maxPages: 6 }));
    assert.equal(res.status, 201);
    const { site: s } = (await res.json()) as any;
    const seen: Array<{ state: string; pausedUntil: string | null; at: number }> = [];
    env.hub.subscribe(s.id, (ev) => {
      if (ev.type === "audit") seen.push({ state: ev.audit.state, pausedUntil: ev.audit.pausedUntil, at: Date.now() });
    });
    await env.crawler.waitAll();
    await new Promise((r) => setTimeout(r, 300));
    const paused = seen.filter((e) => e.pausedUntil);
    assert.ok(paused.length >= 1, "au moins un événement pendant la pause");
    const until = Date.parse(paused[0].pausedUntil!);
    assert.ok(until > paused[0].at && until - paused[0].at <= 800 + 50, "date de reprise réelle, dans la pause de 800 ms");
    assert.ok(paused.every((e) => e.state === "running"));
    const last = seen.at(-1)!;
    assert.equal(last.state, "done");
    assert.equal(last.pausedUntil, null);
    const audit = ((await (await env.app.request(`/api/sites/${s.id}`)).json()) as any).site.audit;
    assert.equal(audit.pausedUntil, null);
  } finally {
    await site.close();
  }
});
