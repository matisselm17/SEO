import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createApp } from "../src/app.ts";
import { DEFAULT_LIMITS } from "../src/config.ts";
import { Crawler } from "../src/crawl/crawler.ts";
import { openDb } from "../src/db.ts";
import { EventHub } from "../src/events.ts";
import { Store } from "../src/store.ts";

test("sert web/dist avec repli sur index.html, sans sortir du dossier", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "web-dist-"));
  mkdirSync(path.join(dir, "assets"));
  writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>Chat SEO</title>");
  writeFileSync(path.join(dir, "assets", "app.js"), "console.log(1)");
  const store = new Store(openDb(":memory:"));
  const hub = new EventHub();
  const app = createApp({
    config: { port: 0, host: "127.0.0.1", limits: DEFAULT_LIMITS, dataDir: ":memory:", anthropicApiKey: null, anthropicModel: "m", firecrawlApiKey: null, shopify: null, shopifyWritesEnabled: false, shopifyAutoApply: false, googleServiceAccountFile: "/nonexistent/compte.json", gscProperty: null, ga4PropertyId: null, pageSpeedApiKey: null, dataForSeo: null, allowedHosts: [], allowPrivateHosts: false, version: "0.1.0", webDist: dir },
    store, hub, crawler: new Crawler(store, hub), chatClient: null, searchProvider: null,
  });
  const home = await app.request("/");
  assert.match(await home.text(), /Chat SEO/);
  const route = await app.request("/sites/site_abc/audit");
  assert.equal(route.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(await route.text(), /Chat SEO/);
  const js = await app.request("/assets/app.js");
  assert.equal(js.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.match(js.headers.get("cache-control")!, /immutable/);
  assert.equal((await app.request("/assets/absent.js")).status, 404);
  // Tentative de sortie du dossier : on reste dans web/dist (repli sur index.html), jamais /etc/passwd.
  const escape = await (await app.request("/..%2f..%2fetc%2fpasswd")).text();
  assert.ok(!escape.includes("root:") && escape.includes("Chat SEO"));
  const api = await app.request("/api/inconnue");
  assert.equal(((await api.json()) as any).error.code, "not_found");
});
