/**
 * Démarrage du serveur Chat SEO.
 */
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { createClient } from "./chat/assistant.ts";
import { FirecrawlSearch } from "./competitors/competitors.ts";
import { loadConfig } from "./config.ts";
import { Crawler, DEFAULT_CRAWL, INTERRUPTED } from "./crawl/crawler.ts";
import { openDb } from "./db.ts";
import { EventHub } from "./events.ts";
import { setAllowPrivateHosts } from "./net/fetch.ts";
import { Store } from "./store.ts";

const config = loadConfig();
setAllowPrivateHosts(config.allowPrivateHosts);

const store = new Store(openDb(config.dataDir));
const hub = new EventHub();
const crawler = new Crawler(store, hub, DEFAULT_CRAWL, config.limits.maxConcurrentAudits);

const app = createApp({
  config,
  store,
  hub,
  crawler,
  chatClient: config.anthropicApiKey ? createClient(config.anthropicApiKey) : null,
  searchProvider: config.firecrawlApiKey ? new FirecrawlSearch(config.firecrawlApiKey) : null,
});

/** Une analyse interrompue par un arrêt brutal ne reprendra pas : on le dit clairement. Fait une fois le port obtenu, pour ne pas toucher aux analyses d'une autre instance déjà lancée. */
function markInterruptedAudits(): void {
  for (const a of store.runningAudits()) {
    store.updateAudit(a.id, {
      state: "failed",
      finished_at: new Date().toISOString(),
      current_url: null,
      pages_queued: 0,
      error_json: JSON.stringify(INTERRUPTED),
    });
  }
}

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  markInterruptedAudits();
  console.log(`[serveur] Chat SEO ${config.version} à l'écoute sur http://${config.host}:${info.port}`);
  console.log(`[serveur] Données : ${config.dataDir}`);
  console.log(`[serveur] Assistant : ${config.anthropicApiKey ? `activé (${config.anthropicModel})` : "désactivé (pas de clé ANTHROPIC_API_KEY)"}`);
  console.log(`[serveur] Concurrents : ${config.firecrawlApiKey ? "activé" : "désactivé (pas de clé FIRECRAWL_API_KEY)"}`);
  if (config.allowPrivateHosts) {
    console.warn("[serveur] ATTENTION : ALLOW_PRIVATE_HOSTS=1 autorise le chargement d'adresses internes. Réservé au développement et aux tests.");
  }
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[serveur] Le port ${config.port} est déjà utilisé sur ${config.host}. Arrêtez l'autre programme qui l'occupe, ou choisissez un autre port avec la variable PORT.`);
  } else if (err.code === "EACCES") {
    console.error(`[serveur] Pas le droit d'écouter sur ${config.host}:${config.port}. Choisissez un port au-dessus de 1024 avec la variable PORT.`);
  } else if (err.code === "EADDRNOTAVAIL") {
    console.error(`[serveur] L'adresse ${config.host} n'existe pas sur cette machine. Vérifiez la variable HOST.`);
  } else {
    console.error(`[serveur] Impossible de démarrer : ${err.message}`);
  }
  process.exit(1);
});

let stopping = false;
function shutdown(): void {
  if (stopping) return;
  stopping = true;
  // Arrêt du serveur : les analyses en cours passent en « failed » avec un message qui le dit.
  crawler.stopAllForShutdown();
  void crawler.waitAll().finally(() => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
