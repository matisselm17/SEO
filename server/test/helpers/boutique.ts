/** Préparation commune des tests de la boutique : analyse terminée + faux Shopify + lecture faite. */
import assert from "node:assert/strict";
import { analysePage } from "../../src/analyse/grille.ts";
import { urlKey } from "../../src/crawl/url.ts";
import type { Store } from "../../src/store.ts";
import type { ChatClient } from "../../src/chat/assistant.ts";
import type { VerifierOptions } from "../../src/shopify/verification.ts";
import { postEmpty, testEnv } from "./env.ts";
import { defaultState, fakeShopify, SHOP_HOST } from "./fake-shopify.ts";

/** Pages notées : `html` par chemin (par défaut : titre de ~45 caractères, aucune description). */
export function insertDoneAudit(store: Store, siteId: string, host: string, paths: string[], html: Record<string, string> = {}) {
  const audit = store.insertAudit(siteId, 20);
  const ids: Record<string, string> = {};
  for (const p of paths) {
    const url = `https://${host}${p}`;
    const a = analysePage(html[p] ?? `<!doctype html><html lang="fr"><head><title>Page ${p} de la boutique d'essai</title></head><body><h1>Titre</h1><img src="/a.jpg"><p>Texte.</p></body></html>`, url);
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

export const PAGES = ["/", "/products/bague-or", "/collections/bagues/products/collier", "/Blogs/Conseils/Entretenir-Ses-Bijoux", "/pages/contact"];

export interface ShopSetup {
  writesEnabled?: boolean;
  autoApply?: boolean;
  state?: ReturnType<typeof defaultState>;
  fake?: Parameters<typeof fakeShopify>[1];
  chatClient?: ChatClient | null;
  html?: Record<string, string>;
  dataDir?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Remplace le fetch du faux Shopify (pour bloquer ou ralentir une écriture). */
  wrapFetch?: (impl: typeof fetch) => typeof fetch;
  /** Relecture des pages publiques (faux chargement, horloge, minuteries). */
  verification?: VerifierOptions;
}

export async function shop(opts: ShopSetup = {}) {
  const fake = fakeShopify(opts.state ?? defaultState(), opts.fake);
  const fetchImpl = opts.wrapFetch ? opts.wrapFetch(fake.impl) : fake.impl;
  const env = testEnv({
    chatClient: opts.chatClient ?? null,
    dataDir: opts.dataDir,
    shopify: { fetchImpl, writesEnabled: opts.writesEnabled ?? true, autoApply: opts.autoApply ?? false, now: opts.now, sleep: opts.sleep, verification: opts.verification },
  });
  const site = env.store.insertSite(`https://${SHOP_HOST}/`, SHOP_HOST, "Boutique Essai");
  const { ids } = insertDoneAudit(env.store, site.id, SHOP_HOST, PAGES, opts.html);
  const events: string[] = [];
  env.hub.subscribe(site.id, (ev) => events.push(ev.type));
  const base = `/api/sites/${site.id}`;
  const res = await env.app.request(`${base}/shopify/sync`, postEmpty());
  assert.equal(res.status, 200, await res.clone().text());
  const list = (await (await env.app.request(`${base}/shopify/resources?limit=200`)).json()) as any;
  const byPath: Record<string, any> = Object.fromEntries(list.resources.map((r: any) => [r.path, r]));
  return { ...env, fake, site, ids, events, base, byPath };
}

export const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as any });
