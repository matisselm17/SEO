/**
 * Démarrage du serveur Chat SEO.
 */
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { createClient } from "./chat/assistant.ts";
import { FirecrawlSearch } from "./competitors/competitors.ts";
import { loadConfig } from "./config.ts";
import { Crawler } from "./crawl/crawler.ts";
import { openDb } from "./db.ts";
import { EventHub } from "./events.ts";
import { setAllowPrivateHosts } from "./net/fetch.ts";
import { Store } from "./store.ts";

const config = loadConfig();
setAllowPrivateHosts(config.allowPrivateHosts);

const store = new Store(openDb(config.dataDir));
const hub = new EventHub();
const crawler = new Crawler(store, hub);

// Une analyse interrompue par un arrêt du serveur ne reprendra pas : on le dit clairement.
for (const a of store.runningAudits()) {
  store.updateAudit(a.id, {
    state: "failed",
    finished_at: new Date().toISOString(),
    current_url: null,
    pages_queued: 0,
    error_json: JSON.stringify({
      code: "internal",
      message: "L'analyse a été interrompue par un redémarrage du serveur. Les pages déjà notées sont conservées.",
      action: "Relancez l'analyse.",
    }),
  });
}

const app = createApp({
  config,
  store,
  hub,
  crawler,
  chatClient: config.anthropicApiKey ? createClient(config.anthropicApiKey) : null,
  searchProvider: config.firecrawlApiKey ? new FirecrawlSearch(config.firecrawlApiKey) : null,
});

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[serveur] Chat SEO ${config.version} à l'écoute sur http://localhost:${info.port}`);
  console.log(`[serveur] Données : ${config.dataDir}`);
  console.log(`[serveur] Assistant : ${config.anthropicApiKey ? `activé (${config.anthropicModel})` : "désactivé (pas de clé ANTHROPIC_API_KEY)"}`);
  console.log(`[serveur] Concurrents : ${config.firecrawlApiKey ? "activé" : "désactivé (pas de clé FIRECRAWL_API_KEY)"}`);
  if (config.allowPrivateHosts) {
    console.warn("[serveur] ATTENTION : ALLOW_PRIVATE_HOSTS=1 autorise le chargement d'adresses internes. Réservé au développement et aux tests.");
  }
});

let stopping = false;
function shutdown(): void {
  if (stopping) return;
  stopping = true;
  crawler.cancelAll();
  void crawler.waitAll().finally(() => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
