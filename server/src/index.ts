/**
 * Démarrage du serveur Chat SEO.
 */
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { createClient } from "./chat/assistant.ts";
import { FirecrawlSearch } from "./competitors/competitors.ts";
import { ConfigError, envNamesMissing, loadConfig, type Config } from "./config.ts";
import { Crawler, DEFAULT_CRAWL, INTERRUPTED } from "./crawl/crawler.ts";
import { openDb } from "./db.ts";
import { EventHub } from "./events.ts";
import { setAllowPrivateHosts } from "./net/fetch.ts";
import { Store } from "./store.ts";
import { ShopifyService } from "./shopify/service.ts";
import { BatchService, recoverInterruptedBatches } from "./shopify/batches.ts";
import { createEmbeddedRegistry, ShopifyRegistry, startIdleSweep } from "./shopify/registry.ts";
import { resumeVerifications } from "./shopify/resume.ts";
import { startBackups } from "./db-backup.ts";
import { Optimizer } from "./automation/optimize.ts";
import { PageSpeedClient } from "./google/pagespeed.ts";
import { PageSpeedService } from "./speed/service.ts";
import { parseGa4PropertyId } from "./config.ts";
import { ShopifyWebhooks } from "./shopify/webhooks.ts";

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  // Le message d'une ConfigError ne contient que des noms de variables, jamais leur valeur.
  console.error(`[serveur] ${err instanceof ConfigError ? err.message : "Configuration illisible : le serveur ne démarre pas."}`);
  process.exit(1);
}
setAllowPrivateHosts(config.allowPrivateHosts);

const store = new Store(openDb(config.dataDir));
const hub = new EventHub();
const crawler = new Crawler(store, hub, DEFAULT_CRAWL, config.limits.maxConcurrentAudits);

const chatClient = config.anthropicApiKey ? createClient(config.anthropicApiKey) : null;
/**
 * Services Shopify : un seul jeu en mode local ; en mode intégré, un jeu par boutique, créé à la première requête
 * identifiée de la boutique (jetons chiffrés dans la table `shops`).
 */
const shopifyRegistry =
  config.shopifyAppMode === "embedded"
    ? createEmbeddedRegistry({
        store,
        hub,
        clientId: config.shopifyApp!.clientId,
        clientSecret: config.shopifyApp!.clientSecret,
        encryptionKey: config.tokenEncryptionKey!,
        writesEnabled: config.shopifyWritesEnabled,
        chatClient,
        model: config.anthropicModel,
        aiTokensMax: config.aiTokensPerDayMax,
      })
    : (() => {
        const shopify = new ShopifyService(store, hub, { creds: config.shopify, writesEnabled: config.shopifyWritesEnabled, appMode: "local" });
        const batches = new BatchService(store, hub, shopify, { autoAllowed: config.shopifyAutoApply });
        const optimizer = new Optimizer({ store, shopify, batches, client: chatClient, model: config.anthropicModel });
        return ShopifyRegistry.local({ shopify, batches, optimizer });
      })();
// L'état « en cours » des mesures de vitesse vit en mémoire : une mesure interrompue par un arrêt n'est pas reprise.
const pagespeed = new PageSpeedService(store, hub, new PageSpeedClient({ apiKey: config.pageSpeedApiKey }));

/** Mode intégré : appels signés de Shopify ; demandes d'effacement reprises au démarrage puis toutes les heures. */
const webhooks =
  config.shopifyAppMode === "embedded"
    ? new ShopifyWebhooks({ store, registry: shopifyRegistry, hub, crawler, pagespeed, secret: config.shopifyApp!.clientSecret })
    : null;

const app = createApp({
  config,
  store,
  hub,
  crawler,
  shopifyRegistry,
  pagespeed,
  chatClient,
  searchProvider: config.firecrawlApiKey ? new FirecrawlSearch(config.firecrawlApiKey) : null,
  ...(webhooks ? { webhooks } : {}),
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

let stopSweep = () => {};
let stopBackups = () => {};

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  markInterruptedAudits();
  // Un lot resté « en cours d'écriture » ne reprend jamais tout seul : il passe « partial ».
  const recovered = recoverInterruptedBatches(store.db);
  if (recovered) console.warn(`[serveur] ${recovered} lot(s) de corrections interrompu(s) par un arrêt : marqué(s) « partial » ou remis en brouillon, sans reprise automatique.`);
  // Après le marquage des travaux interrompus : reprise des demandes d'effacement en attente.
  webhooks?.start();
  // Vérifications perdues par l'arrêt (moins de 24 h, jamais relues) : remises en file, cadence ordinaire.
  const resumed = resumeVerifications(store, shopifyRegistry);
  if (resumed) console.log(`[serveur] ${resumed} vérification(s) de correction reprise(s) après le redémarrage.`);
  // Mode intégré : services des boutiques inactives depuis 30 minutes libérés (jamais pendant une analyse du site).
  stopSweep = startIdleSweep(shopifyRegistry, (domain) => {
    const s = store.siteByShop(domain);
    return !!s && crawler.isRunning(s.id);
  });
  // Sauvegardes de la base (DB_BACKUP_HOURS, 0 = jamais).
  stopBackups = startBackups({ db: store.db, dataDir: config.dataDir, hours: config.dbBackupHours ?? 0, keep: config.dbBackupKeep ?? 7 }).stop;
  if (config.dbBackupHours) console.log(`[serveur] Sauvegardes de la base : toutes les ${config.dbBackupHours} h, ${config.dbBackupKeep ?? 7} gardées.`);
  console.log(`[serveur] Chat SEO ${config.version} à l'écoute sur http://${config.host}:${info.port}`);
  console.log(`[serveur] Données : ${config.dataDir}`);
  console.log(`[serveur] Assistant : ${config.anthropicApiKey ? `activé (${config.anthropicModel})` : "désactivé (pas de clé ANTHROPIC_API_KEY)"}`);
  // Le domaine myshopify.com n'est jamais journalisé.
  const writes = config.shopifyWritesEnabled ? "écritures ACTIVÉES (SHOPIFY_WRITES_ENABLED=1)" : "lecture seule";
  console.log(
    `[serveur] Shopify : ${
      config.shopifyAppMode === "embedded"
        ? `application configurée (plusieurs boutiques, jetons chiffrés), ${writes}`
        : config.shopify
          ? `configuré, ${writes}`
          : "non configuré (SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET)"
    }`,
  );
  // Ni le domaine, ni l'identifiant de l'application, ni un jeton.
  console.log(`[serveur] Mode Shopify : ${config.shopifyAppMode === "embedded" ? "intégré (SHOPIFY_APP_MODE=embedded, jeton de session exigé sur /api)" : "local"}`);
  console.log(`[serveur] Écritures automatiques (SHOPIFY_AUTO_APPLY) : ${config.shopifyAutoApply ? "autorisées par le serveur" : "non autorisées"}`);
  // Ni le chemin du compte de service, ni l'identifiant de propriété, ni la clé ne sont journalisés.
  const gaRaw = process.env.GA4_PROPERTY_ID?.trim();
  console.log(`[serveur] Google Analytics : ${config.ga4PropertyId ? "identifiant de propriété présent" : gaRaw && !parseGa4PropertyId(gaRaw) ? "GA4_PROPERTY_ID ignoré (identifiant numérique attendu)" : "non configuré (GA4_PROPERTY_ID)"}`);
  console.log(`[serveur] Vitesse des pages : ${config.pageSpeedApiKey ? "clé présente" : "non configurée (GOOGLE_PAGESPEED_API_KEY)"}`);
  console.log(`[serveur] Concurrents : ${config.firecrawlApiKey ? "activé" : "désactivé (pas de clé FIRECRAWL_API_KEY)"}`);
  const missing = envNamesMissing();
  if (missing.length) {
    console.warn(`[serveur] ATTENTION : ${missing.length} variable(s) de .env.example sont absentes de .env (${missing.join(", ")}). Si vous ne les avez pas retirées vous-même, le fichier a peut-être été écrasé par une ancienne version : une copie datée se trouve dans secrets/sauvegardes-env/.`);
  }
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
  webhooks?.stop();
  stopSweep();
  stopBackups();
  void Promise.all([crawler.waitAll(), shopifyRegistry.stopAll(), pagespeed.stopAll()]).finally(() => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
