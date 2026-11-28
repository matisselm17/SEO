/**
 * Routes HTTP de docs/format-echange.md. Toutes sous /api ; erreurs au format ApiError ;
 * ETag sur les GET ; deux flux SSE (événements d'un site, réponse de l'assistant).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import type {
  AutomationState,
  ChatEvent,
  ChatRequest,
  CreateBatchRequest,
  MeasureSpeedRequest,
  OptimizeRequest,
  ShopifyBatchesResponse,
  ShopifyBatchResponse,
  UpdateAutomationRequest,
  UpdateBatchItemRequest,
  ChatState,
  CompetitorsData,
  CoverageResponse,
  CreateSiteRequest,
  ApiError,
  FailedPagesResponse,
  HealthResponse,
  IssueResponse,
  PageResponse,
  ProgressResponse,
  Settings,
  SiteEvent,
  ShopifyChangeRequest,
  ShopifyResourceResponse,
  ShopifyVerifyResponse,
  ShopifyResourceType,
  SiteResponse,
  SitesResponse,
  StartAuditRequest,
  UpdateSettingsRequest,
} from "../../shared/api.ts";
import { chatBudgetExceeded, chatNotConfigured, runChat, suggestions, type ChatClient } from "./chat/assistant.ts";
import {
  competitorsNotConfigured,
  countryFor,
  pickQueries,
  runCompetitorSurvey,
  type SearchProvider,
} from "./competitors/competitors.ts";
import { DEFAULT_MAX_PAGES, MAX_PAGES_LIMITS, type Config } from "./config.ts";
import type { Crawler } from "./crawl/crawler.ts";
import { isTransientStatus } from "./crawl/throttle.ts";
import { bareHost, normalizeUrl, parseUserUrl } from "./crawl/url.ts";
import { errors, HttpError, toHttpError } from "./errors.ts";
import type { EventHub } from "./events.ts";
import { importFile, MAX_UPLOAD_BYTES } from "./gsc/import.ts";
import { assertFetchable, FetchError, safeFetch } from "./net/fetch.ts";
import { APP_BRIDGE_SRC, compress, guardHost, guardMutations, guardSession, JSON_LIMIT, limitBody, privateApiCache, RateLimiter, RETRY_SESSION_HEADER, securityHeadersFor, UPLOAD_LIMIT, type AppEnv } from "./http.ts";
import { displayPath } from "./crawl/url.ts";
import type { PageFacts } from "./analyse/grille.ts";
import type { SiteRow, Store } from "./store.ts";
import { coverage, isPageSort, issues, listPages, overview, progress, recommendations } from "./views.ts";
import { ShopifyService, type ResourceQuery } from "./shopify/service.ts";
import { BatchService } from "./shopify/batches.ts";
import { Optimizer } from "./automation/optimize.ts";
import { createEmbeddedRegistry, ShopifyRegistry, type ShopBundle } from "./shopify/registry.ts";
import { recordShopSeen } from "./shopify/shops.ts";
import { ShopifyWebhooks, WEBHOOK_PATH } from "./shopify/webhooks.ts";
import { addUsage, getPolicy, getUsage, parsePolicy, policyLimits, setPolicy, type PolicyBounds } from "./automation/policy.ts";
import { ALLOWED_DAYS, SearchConsoleClient, gscErrors } from "./gsc/google.ts";
import { ANALYTICS_DAYS, AnalyticsClient, analyticsErrors } from "./google/analytics.ts";
import { PageSpeedClient } from "./google/pagespeed.ts";
import { PageSpeedService } from "./speed/service.ts";

export interface AppDeps {
  config: Config;
  store: Store;
  hub: EventHub;
  crawler: Crawler;
  /** Client de l'API Claude ; null sans clé. */
  chatClient: ChatClient | null;
  /** Fournisseur de recherche pour les concurrents ; null sans clé. */
  searchProvider: SearchProvider | null;
  /** Boutique Shopify ; construite depuis `config` si absente (les tests y passent un faux Shopify). */
  shopify?: ShopifyService;
  /** Lots de corrections ; construits depuis `config` si absents. */
  batches?: BatchService;
  /** Optimisation par l'IA ; construite si absente. */
  optimizer?: Optimizer;
  /**
   * Registre des services Shopify par boutique. Mode local : construit à partir de `shopify`, `batches` et `optimizer`.
   * Mode intégré : construit depuis `config` (jetons chiffrés en base) si absent ; les tests y passent un faux Shopify.
   */
  shopifyRegistry?: ShopifyRegistry;
  /** Search Console en lecture directe ; construite depuis `config` si absente (les tests y passent un faux Google). */
  searchConsole?: SearchConsoleClient;
  /** Google Analytics ; construit depuis `config` (même compte de service que la Search Console) si absent. */
  analytics?: AnalyticsClient;
  /** Mesures de vitesse ; construites depuis `config` si absentes (les tests y passent un faux PageSpeed). */
  pagespeed?: PageSpeedService;
  /**
   * Mode intégré : appels signés de Shopify (désinstallation, vie privée). Construits si absents ; la reprise des
   * demandes d'effacement (`start`) est lancée par le démarrage du serveur, pas ici.
   */
  webhooks?: ShopifyWebhooks;
}

const SHOPIFY_TYPES: ShopifyResourceType[] = ["product", "collection", "page", "article"];
const SHOPIFY_MISSING = ["seo_title", "seo_description", "image_alt"] as const;
const SHOPIFY_FIX = ["seo_title", "seo_description"] as const;

export { MAX_PAGES_LIMITS };
const PING_MS = 20_000;

/** Réponse JSON d'un GET avec ETag ; 304 si l'interface a déjà cette version. */
function getJson(c: Context, data: unknown): Response {
  const body = JSON.stringify(data);
  const etag = `W/"${createHash("sha1").update(body).digest("base64url")}"`;
  const inm = c.req.header("if-none-match");
  if (inm && inm.split(",").map((s) => s.trim()).includes(etag)) {
    return new Response(null, { status: 304, headers: { etag, "cache-control": "no-cache" } });
  }
  return new Response(body, { status: 200, headers: { "content-type": "application/json; charset=utf-8", etag, "cache-control": "no-cache" } });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

async function readJson<T>(c: Context, optional = false): Promise<Partial<T>> {
  const raw = await c.req.text();
  if (raw.length > 64 * 1024) throw errors.badRequest("La requête est trop volumineuse.");
  if (!raw.trim()) {
    if (optional) return {};
    throw errors.badRequest("La requête est vide.");
  }
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v as Partial<T>;
  } catch {
    throw errors.badRequest("La requête n'est pas un JSON valide.");
  }
}

/** Mode intégré : actions qui n'existent pas (un site par boutique, réglages du serveur). */
const notInEmbeddedMode = () =>
  new HttpError(403, "not_in_embedded_mode", "Cette action n'est pas disponible dans l'application Shopify.", "Votre site est créé et suivi automatiquement à partir de votre boutique.");

/** Mode intégré : section masquée (Settings.features à false) ; même code, lectures comprises. */
const sectionHidden = () =>
  new HttpError(403, "not_in_embedded_mode", "Cette section n'est pas disponible dans l'application Shopify.", "Utilisez les autres sections de l'application.");

/** Mode intégré : le mode « auto » n'existe pas (docs/format-echange.md, « Exploitation (lot D) »). */
const autoNotInEmbeddedMode = () =>
  new HttpError(
    403,
    "automation_not_allowed",
    "Les corrections appliquées sans validation ne sont pas disponibles dans l'application Shopify : chaque lot attend votre validation.",
    "Choisissez « L'IA propose, je valide », puis validez les lots depuis la section Boutique Shopify.",
  );

/**
 * Sections facultatives présentes (Settings.features). Mode local : toutes. Mode intégré : celles d'EMBEDDED_FEATURES
 * seulement ; `analytics` et `searchConsoleSync` jamais (elles liraient le compte Google de l'exploitant).
 */
export function featuresFor(config: Config): Settings["features"] {
  if (config.shopifyAppMode !== "embedded") return { competitors: true, analytics: true, pageSpeed: true, assistant: true, searchConsoleSync: true };
  const open = new Set(config.embeddedFeatures ?? []);
  return { competitors: open.has("competitors"), analytics: false, pageSpeed: open.has("pagespeed"), assistant: open.has("assistant"), searchConsoleSync: false };
}

/** Plafond commun à tout le serveur des demandes à l'IA (assistant et préparation), mode intégré. */
export const AI_REQUESTS_PER_MINUTE = 60;
/** Analyses lancées par heure et par site, mode intégré. */
export const AUDITS_PER_HOUR = 6;

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const { config, store, hub, crawler } = deps;
  const embedded = config.shopifyAppMode === "embedded";
  // Mode intégré : la configuration a déjà refusé de démarrer sans ces variables ; on le revérifie ici (refus fermé).
  if (embedded && (!config.shopifyApp || (!config.tokenEncryptionKey && !deps.shopifyRegistry))) throw new Error("Mode intégré sans application Shopify ni clé de chiffrement configurées.");
  let registry: ShopifyRegistry;
  if (deps.shopifyRegistry) {
    registry = deps.shopifyRegistry;
  } else if (embedded) {
    registry = createEmbeddedRegistry({
      store,
      hub,
      clientId: config.shopifyApp!.clientId,
      clientSecret: config.shopifyApp!.clientSecret,
      encryptionKey: config.tokenEncryptionKey!,
      writesEnabled: config.shopifyWritesEnabled,
      chatClient: deps.chatClient,
      model: config.anthropicModel,
      aiTokensMax: config.aiTokensPerDayMax,
    });
  } else {
    const shopify = deps.shopify ?? new ShopifyService(store, hub, { creds: config.shopify, writesEnabled: config.shopifyWritesEnabled, appMode: "local" });
    const batches = deps.batches ?? new BatchService(store, hub, shopify, { autoAllowed: config.shopifyAutoApply });
    const optimizer = deps.optimizer ?? new Optimizer({ store, shopify, batches, client: deps.chatClient, model: config.anthropicModel });
    registry = ShopifyRegistry.local({ shopify, batches, optimizer });
  }
  if (registry.mode !== (embedded ? "embedded" : "local")) throw new Error("Registre Shopify d'un autre mode que le serveur.");
  /** Mode local : l'unique jeu de services Shopify (configuré ou non). */
  const localBundle = embedded ? null : registry.forSite({ shop_domain: null });
  /**
   * Services Shopify de la boutique propriétaire du site. En mode intégré, un site sans boutique n'en a aucun : refus
   * fermé, comme un site inexistant (le résolveur `site(c)` l'a déjà écarté).
   */
  const bundleOf = (s: SiteRow): ShopBundle => {
    const b = registry.forSite(s);
    if (!b) throw errors.siteNotFound();
    return b;
  };
  const gsc = deps.searchConsole ?? new SearchConsoleClient({ file: config.googleServiceAccountFile, property: config.gscProperty });
  // Un seul compte de service : la Search Console et Google Analytics partagent l'authentification (un jeton par portée).
  const ga = deps.analytics ?? new AnalyticsClient({ auth: gsc.auth, propertyId: config.ga4PropertyId });
  const speed = deps.pagespeed ?? new PageSpeedService(store, hub, new PageSpeedClient({ apiKey: config.pageSpeedApiKey }));
  const app = new Hono<AppEnv>();
  const features = featuresFor(config);
  /** Sections masquées : leurs données ne sortent par aucune autre route, et l'assistant n'a pas leurs outils. */
  const hidden = { competitors: !features.competitors, analytics: !features.analytics, pageSpeed: !features.pageSpeed };
  /** Refus fermé d'une section masquée : appelé après le résolveur de site (un site d'une autre boutique reste un 404). */
  const requireFeature = (f: keyof Settings["features"]) => {
    if (features[f] !== true) throw sectionHidden();
  };
  /** Bornes du serveur sur la règle d'automatisation (mode intégré : plafond de jetons, pas de mode « auto »). */
  const policyBounds: PolicyBounds = embedded ? { aiTokensMax: config.aiTokensPerDayMax, noAuto: true } : {};
  /**
   * Clé d'une limite par minute : mode local, une seule pour tout le serveur (comme avant) ; mode intégré, une par
   * site, pour que deux boutiques ne se gênent jamais.
   */
  const limitKey = (base: string, s: SiteRow) => (embedded ? `${base}:${s.id}` : base);
  /** Mode intégré : plafond commun des demandes à l'IA (assistant et préparation). */
  const aiLimiter = embedded ? new RateLimiter(AI_REQUESTS_PER_MINUTE) : null;
  /** Mode intégré : analyses lancées par heure et par site. */
  const auditLimiter = embedded ? new RateLimiter(AUDITS_PER_HOUR, Date.now, 3_600_000) : null;
  /** Demande à l'IA : limite du site puis plafond commun ; rien n'est compté si l'une des deux refuse. */
  const takeAi = (limiter: RateLimiter, key: string, what: string) => {
    if (aiLimiter && limiter.waitMs(key) === 0 && aiLimiter.waitMs("ai") > 0) aiLimiter.take("ai", "à l'IA");
    limiter.take(key, what);
    aiLimiter?.take("ai", "à l'IA");
  };
  /** Une lecture de la Search Console chez Google par minute et par site. */
  const gscSyncLimiter = new RateLimiter(1);
  /** Une lecture de Google Analytics par minute et par site. */
  const analyticsSyncLimiter = new RateLimiter(1);
  /** Une lecture complète de la boutique par minute au plus. */
  const shopifySyncLimiter = new RateLimiter(1);
  const chatLimiter = new RateLimiter(config.limits.chatPerMinute);
  const competitorsLimiter = new RateLimiter(config.limits.competitorsPerMinute);
  /** Créations de lot (chacune relit jusqu'à 50 éléments chez Shopify), préparations par l'IA, enregistrements de règle. */
  const batchCreateLimiter = new RateLimiter(10);
  const optimizeLimiter = new RateLimiter(5);
  const automationLimiter = new RateLimiter(10);
  /** Relectures de la page publique demandées (vérification d'une correction). */
  const verifyLimiter = new RateLimiter(10);
  /** Une seule réponse de l'assistant en cours par site. */
  const chatBusy = new Set<string>();
  const isUpload = (p: string, method: string) => method === "POST" && /^\/api\/sites\/[^/]+\/search-console$/.test(p);

  app.use("*", securityHeadersFor(embedded));
  app.use("*", compress);

  // Appels signés de Shopify (mode intégré seulement) : hors de /api, sans jeton de session ni garde d'origine ; leur
  // seule preuve est la signature du corps brut, que rien ne lit avant cette route (aucun middleware sur ce chemin
  // ne touche au corps). Toute autre méthode ou adresse sous /webhooks répond 404, jamais l'interface.
  if (embedded) {
    const hooks =
      deps.webhooks ?? new ShopifyWebhooks({ store, registry, hub, crawler, pagespeed: speed, secret: config.shopifyApp!.clientSecret });
    app.post(WEBHOOK_PATH, (c) => hooks.handle(c.req.raw));
  }
  // Surveillance : hors de /api (ni garde d'hôte, ni jeton), avant l'interface compilée. Rien d'autre que l'état.
  app.get("/healthz", () => {
    let ok = false;
    try {
      // Une vraie lecture d'une table : une base ouverte mais illisible (fichier abîmé, schéma absent) répond 503.
      store.db.prepare("SELECT 1 AS x FROM schema_migrations LIMIT 1").get();
      ok = true;
    } catch {
      ok = false;
    }
    return new Response(ok ? '{"ok":true}' : '{"ok":false}', { status: ok ? 200 : 503, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  });
  app.all("/webhooks/*", (c) => c.body(null, 404));
  app.all("/webhooks", (c) => c.body(null, 404));
  if (embedded) app.use("/api/*", privateApiCache);
  app.use("/api/*", guardHost(config.port, config.allowedHosts));
  app.use("/api/*", guardMutations(isUpload));
  /** Dernier enregistrement de chaque boutique (`last_seen_at` mis à jour une fois par minute au plus, toujours si désinstallée). */
  const seenAt = new Map<string, number>();
  const recordShop = (shop: string) => {
    try {
      recordShopSeen(store.db, shop, seenAt);
    } catch {
      console.warn("[shopify] Enregistrement d'une boutique impossible pour le moment.");
    }
  };
  if (embedded) {
    // Après les gardes d'hôte et d'origine, avant la lecture du corps et toute route (routes inconnues comprises).
    const { clientId, clientSecret } = config.shopifyApp!;
    app.use(
      "/api/*",
      guardSession({
        clientId,
        secret: clientSecret,
        onSession: (shop, token) => {
          recordShop(shop);
          return registry.forShop(shop).shopify.ensureSession(token);
        },
      }),
    );
    // Requête en cours : le jeu de services de la boutique n'est pas libéré pendant ce temps.
    app.use("/api/*", async (c, next) => {
      const shop = c.get("shop");
      if (!shop) return next();
      registry.enter(shop);
      try {
        await next();
      } finally {
        registry.leave(shop);
      }
    });
  }
  app.use("/api/*", limitBody((p) => (isUpload(p, "POST") ? UPLOAD_LIMIT : JSON_LIMIT)));

  const settings = (): Settings => ({
    maxPagesDefault: Number(store.getSetting("maxPagesDefault") ?? DEFAULT_MAX_PAGES),
    maxPagesLimits: MAX_PAGES_LIMITS,
    integrations: {
      chat: { configured: !!deps.chatClient, model: deps.chatClient ? config.anthropicModel : null },
      competitors: { configured: !!deps.searchProvider },
      shopify: localBundle
        ? { configured: localBundle.shopify.configured, writesEnabled: localBundle.shopify.writesEnabled }
        : { configured: true, writesEnabled: config.shopifyWritesEnabled },
      searchConsole: { configured: gsc.configured },
      dataForSeo: { configured: !!config.dataForSeo },
      analytics: { configured: ga.configured },
      pageSpeed: { configured: speed.configured },
    },
    features,
    version: config.version,
  });

  /**
   * Site de l'adresse. Mode intégré : il doit appartenir à la boutique du jeton de session, sinon 404 `not_found`,
   * exactement comme un site inexistant (refus fermé : sans boutique connue, aucun site).
   */
  const site = (c: Context<AppEnv>): SiteRow => {
    const s = store.getSite(c.req.param("siteId") ?? "");
    if (!s) throw errors.siteNotFound();
    if (embedded) {
      const shop = c.get("shop");
      if (!shop || s.shop_domain !== shop) throw errors.siteNotFound();
    }
    return s;
  };

  const maxPagesFrom = (v: unknown): number => {
    if (v === undefined || v === null) return settings().maxPagesDefault;
    if (typeof v !== "number" || !Number.isInteger(v) || v < MAX_PAGES_LIMITS.min || v > MAX_PAGES_LIMITS.max) {
      throw errors.badRequest(
        `Le nombre de pages doit être un entier entre ${MAX_PAGES_LIMITS.min} et ${MAX_PAGES_LIMITS.max}.`,
        "Choisissez une valeur dans cette fourchette.",
      );
    }
    return v;
  };

  const startAudit = (s: SiteRow, maxPages: number) => {
    const audit = store.insertAudit(s.id, maxPages);
    void crawler.start(s, audit);
    hub.emitAudit(s.id, () => {
      const a = store.getAudit(audit.id);
      return a ? { type: "audit", audit: store.auditStatus(a), score: store.auditScore(audit.id) } : null;
    });
    return audit;
  };

  app.onError((err, c) => {
    const e = toHttpError(err);
    if (!(err instanceof HttpError)) console.error(`[api] ${c.req.method} ${new URL(c.req.url).pathname} :`, err instanceof Error ? err.message : "erreur");
    const res = json(e.toBody(), e.status);
    const retry = e.details?.retryAfterSeconds;
    if (typeof retry === "number") res.headers.set("retry-after", String(retry));
    if (e.status === 413) res.headers.set("connection", "close");
    if (e.code === "unauthorized") res.headers.set(RETRY_SESSION_HEADER, "1");
    return res;
  });

  // ───────── Santé et paramètres

  app.get("/api/health", (c) => getJson(c, { ok: true, version: config.version } satisfies HealthResponse));
  app.get("/api/settings", (c) => getJson(c, settings()));
  app.patch("/api/settings", async (c) => {
    if (embedded) throw notInEmbeddedMode();
    const body = await readJson<UpdateSettingsRequest>(c);
    if (body.maxPagesDefault !== undefined) store.setSetting("maxPagesDefault", String(maxPagesFrom(body.maxPagesDefault)));
    return json(settings());
  });

  // ───────── Sites

  /** Créations de site en cours, par boutique (une seule à la fois, même pour des requêtes simultanées). */
  const creating = new Map<string, Promise<SiteRow>>();

  /**
   * Mode intégré, « Une boutique, un site » : le site de la boutique, créé à la première demande à partir du nom et
   * du domaine principal lus chez Shopify (première analyse lancée), ou rattaché s'il existe sans boutique.
   */
  const shopSite = (shop: string): Promise<SiteRow> => {
    const existing = store.siteByShop(shop);
    if (existing) return Promise.resolve(existing);
    let p = creating.get(shop);
    if (!p) {
      p = (async () => {
        const identity = await registry.forShop(shop).shopify.shopIdentity();
        // Shopify n'annonce aucun domaine principal lisible : aucun site à créer.
        if (!identity.host) {
          throw new HttpError(502, "shopify_unavailable", "Shopify n'a pas indiqué l'adresse de votre boutique : aucun site ne peut être analysé pour l'instant.", "Vérifiez le domaine principal de votre boutique dans l'administration Shopify, puis rouvrez l'application.", { retryable: false });
        }
        // Rien d'asynchrone entre ces relectures et l'écriture : pas de double création.
        const again = store.siteByShop(shop);
        if (again) return again;
        const host = bareHost(identity.host);
        const sameHost = store.siteByHost(host);
        if (sameHost) {
          if (!sameHost.shop_domain && store.attachSiteToShop(sameHost.id, shop)) return store.getSite(sameHost.id)!;
          // Un site de même hôte appartient à une autre boutique : rien n'est créé, rien n'est dit de lui.
          throw new HttpError(409, "site_exists", "L'adresse de votre boutique est déjà suivie par une autre boutique.", "Contactez le support de l'application.");
        }
        const row = store.insertSite(`https://${host}/`, host, identity.name, shop);
        try {
          startAudit(row, settings().maxPagesDefault);
          // Comptée dans les analyses de l'heure du site.
          auditLimiter?.take(row.id, "d'analyse");
        } catch (err) {
          // Un échec du lancement n'empêche pas la création.
          console.error("[sites] Première analyse non lancée :", err instanceof Error ? err.constructor.name : "erreur");
        }
        // Première lecture de la boutique, sans attendre : la section Boutique Shopify est utile même sans analyse
        // (boutique protégée par un mot de passe). Un échec ne bloque rien ; elle compte dans la limite de lecture.
        try {
          shopifySyncLimiter.take(limitKey("shopify-sync", row), "de lecture de la boutique");
          void registry
            .forShop(shop)
            .shopify.sync(row)
            .catch((err) => console.warn(`[shopify] Première lecture de la boutique non faite (${err instanceof HttpError ? err.code : "erreur"}).`));
        } catch {
          /* limite atteinte : la lecture se fera à la demande */
        }
        return row;
      })().finally(() => creating.delete(shop));
      creating.set(shop, p);
    }
    return p;
  };

  app.get("/api/sites", async (c) => {
    if (embedded) {
      const shop = c.get("shop");
      if (!shop) throw errors.siteNotFound();
      const s = await shopSite(shop);
      return getJson(c, { sites: [store.siteSummary(store.getSite(s.id) ?? s)] } satisfies SitesResponse);
    }
    return getJson(c, { sites: store.listSites().map((s) => store.siteSummary(s)) } satisfies SitesResponse);
  });

  app.post("/api/sites", async (c) => {
    if (embedded) throw notInEmbeddedMode();
    const body = await readJson<CreateSiteRequest>(c);
    const raw = typeof body.url === "string" ? body.url : "";
    if (!raw.trim()) throw errors.invalidUrl("Indiquez l'adresse de votre site.");
    const parsed = parseUserUrl(raw);
    if (!parsed) throw errors.invalidUrl("Cette adresse n'est pas valide.", raw.slice(0, 200));
    try {
      assertFetchable(parsed);
    } catch {
      throw errors.invalidUrl("Cette adresse n'est pas publique : seuls les sites accessibles sur Internet peuvent être analysés.", parsed.href);
    }
    const maxPages = maxPagesFrom(body.maxPages);
    const existing = store.siteByHost(bareHost(parsed.hostname));
    if (existing) throw errors.siteExists(existing.id);
    if (store.countSites() >= config.limits.maxSites) {
      throw new HttpError(409, "limit_reached", `Vous suivez déjà ${config.limits.maxSites} sites, le maximum.`, "Supprimez un site que vous ne suivez plus, puis réessayez.", {
        limit: config.limits.maxSites,
      });
    }

    // Le site doit répondre avant d'être créé.
    let finalUrl: URL;
    const probe = (u: string) => safeFetch(u, { timeoutMs: 15_000, maxBytes: 5 * 1024 * 1024, acceptBody: () => false });
    const typedScheme = /^https?:\/\//i.test(raw.trim());
    try {
      let res;
      try {
        res = await probe(parsed.href);
      } catch (err) {
        // Adresse saisie sans « https:// » : si le HTTPS échoue, on essaie en HTTP.
        if (typedScheme || !(err instanceof FetchError) || err.kind === "blocked" || err.kind === "invalid" || parsed.protocol !== "https:") throw err;
        const httpUrl = new URL(parsed.href);
        httpUrl.protocol = "http:";
        try {
          res = await probe(httpUrl.href);
        } catch {
          throw err;
        }
      }
      // Un refus passager (429, 503) prouve que le site répond : l'analyse saura attendre et réessayer.
      if (res.status >= 400 && !isTransientStatus(res.status)) throw errors.unreachable(parsed.href, `il renvoie une erreur ${res.status}.`);
      finalUrl = new URL(res.url);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (err instanceof FetchError && (err.kind === "blocked" || err.kind === "invalid"))
        throw errors.invalidUrl("Cette adresse mène à une adresse non publique et ne peut pas être analysée.", parsed.href);
      const reason =
        err instanceof FetchError
          ? err.kind === "timeout"
            ? "il met trop de temps à répondre."
            : err.message === "Nom de domaine introuvable"
              ? "ce nom de domaine est introuvable."
              : err.message === "Certificat de sécurité invalide"
                ? "son certificat de sécurité est invalide."
                : undefined
          : undefined;
      throw errors.unreachable(parsed.href, reason);
    }
    // Une redirection vers un autre domaine (ex. ancien nom) : on suit le site final.
    const start = normalizeUrl(finalUrl) ?? normalizeUrl(parsed)!;
    const host = bareHost(start.hostname);
    const dup = store.siteByHost(host);
    if (dup) throw errors.siteExists(dup.id);
    let row: SiteRow;
    try {
      row = store.insertSite(start.href, host, null);
    } catch {
      const again = store.siteByHost(host);
      if (again) throw errors.siteExists(again.id);
      throw errors.internal();
    }
    startAudit(row, maxPages);
    return json({ site: store.siteSummary(row) } satisfies SiteResponse, 201);
  });

  app.get("/api/sites/:siteId", (c) => getJson(c, { site: store.siteSummary(site(c)) } satisfies SiteResponse));

  app.delete("/api/sites/:siteId", async (c) => {
    if (embedded) throw notInEmbeddedMode();
    const s = site(c);
    if (crawler.cancel(s.id)) await crawler.wait(s.id);
    await speed.cancel(s.id);
    hub.forget(s.id);
    store.deleteSite(s.id);
    hub.close(s.id);
    return new Response(null, { status: 204 });
  });

  // ───────── Analyses

  app.post("/api/sites/:siteId/audits", async (c) => {
    const s = site(c);
    const body = await readJson<StartAuditRequest>(c, true);
    const latest = store.latestAudit(s.id);
    if (crawler.isRunning(s.id) || latest?.state === "running" || latest?.state === "queued") throw errors.auditRunning();
    const maxPages = maxPagesFrom(body.maxPages);
    auditLimiter?.take(s.id, "d'analyse");
    const audit = startAudit(s, maxPages);
    return json({ audit: store.auditStatus(store.getAudit(audit.id)!) }, 202);
  });

  app.post("/api/sites/:siteId/audits/cancel", async (c) => {
    const s = site(c);
    if (crawler.cancel(s.id)) await crawler.wait(s.id);
    const latest = store.latestAudit(s.id);
    if (!latest) throw errors.noAudit();
    return json({ audit: store.auditStatus(latest) });
  });

  app.get("/api/sites/:siteId/events", (c) => {
    const s = site(c);
    return streamSSE(c, async (stream) => {
      let chain: Promise<void> = Promise.resolve();
      const send = (ev: SiteEvent) => {
        chain = chain.then(() => stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) })).catch(() => undefined);
        return chain;
      };
      const current = store.getSite(s.id);
      if (current) await send({ type: "site", site: store.siteSummary(current) });
      const unsubscribe = hub.subscribe(s.id, (ev) => void send(ev));
      const ping = setInterval(() => {
        chain = chain.then(() => stream.write(": ping\n\n")).then(() => undefined).catch(() => undefined);
      }, PING_MS);
      let offClose = () => {};
      await new Promise<void>((resolve) => {
        stream.onAbort(() => resolve());
        c.req.raw.signal.addEventListener("abort", () => resolve(), { once: true });
        offClose = hub.onClose(s.id, () => resolve());
      });
      offClose();
      clearInterval(ping);
      unsubscribe();
    });
  });

  // ───────── Résultats

  app.get("/api/sites/:siteId/overview", (c) => getJson(c, overview(store, site(c))));
  app.get("/api/sites/:siteId/issues", (c) => getJson(c, issues(store, site(c))));
  app.get("/api/sites/:siteId/issues/:issueId", (c) => {
    const s = site(c);
    const audit = store.resultsAudit(s.id);
    if (!audit) throw errors.noAudit();
    const issue = store.aggregate(audit.id, s.name || s.host).issues.find((i) => i.id === c.req.param("issueId"));
    if (!issue) throw errors.notFound("Ce problème");
    return getJson(c, { issue: bundleOf(s).shopify.linkIssue(s.id, issue) } satisfies IssueResponse);
  });
  app.get("/api/sites/:siteId/pages", (c) => {
    const s = site(c);
    const sort = c.req.query("sort") ?? "score_asc";
    if (!isPageSort(sort)) throw errors.badRequest("Ce tri n'existe pas.", "Utilisez score_asc, score_desc, issues_desc, clicks_desc ou path_asc.");
    const offset = Math.max(0, Number.parseInt(c.req.query("offset") ?? "0", 10) || 0);
    const limitRaw = Number.parseInt(c.req.query("limit") ?? "50", 10);
    const limit = Math.min(200, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 50));
    return getJson(c, listPages(store, s.id, { sort, q: (c.req.query("q") ?? "").slice(0, 200), offset, limit }));
  });
  app.get("/api/sites/:siteId/pages/:pageId", (c) => {
    const s = site(c);
    const row = store.getPage(c.req.param("pageId"));
    if (!row || row.site_id !== s.id) throw errors.notFound("Cette page");
    const page = store.pageDetail(row, store.gscIndex(s.id), hidden);
    page.shopifyResourceId = bundleOf(s).shopify.resourceIdForPage(s.id, row.path);
    return getJson(c, { page } satisfies PageResponse);
  });
  app.get("/api/sites/:siteId/coverage", (c) => getJson(c, { coverage: coverage(store, site(c).id) } satisfies CoverageResponse));
  app.get("/api/sites/:siteId/failed-pages", (c) => {
    const s = site(c);
    const audit = store.resultsAudit(s.id);
    const pages = audit
      ? store.failures(audit.id).map((f) => ({ url: f.url, path: displayPath(f.url), httpStatus: f.http_status, reason: f.reason }))
      : [];
    return getJson(c, { pages } satisfies FailedPagesResponse);
  });
  app.get("/api/sites/:siteId/recommendations", (c) => getJson(c, recommendations(store, site(c))));

  // ───────── Search Console

  app.get("/api/sites/:siteId/search-console", (c) => getJson(c, store.searchConsole(site(c).id)));
  app.post("/api/sites/:siteId/search-console", async (c) => {
    const s = site(c);
    const tooLarge = () =>
      new HttpError(413, "file_too_large", "Ce fichier dépasse 20 Mo.", "Exportez une période plus courte, ou déposez seulement le .zip de l'onglet « Performances ».");
    let form: FormData;
    try {
      form = await c.req.raw.formData();
    } catch {
      throw errors.badRequest("Le fichier n'a pas pu être lu.", "Réessayez de déposer le fichier.");
    }
    const file = form.get("file");
    if (!file || typeof file === "string") throw errors.badRequest("Aucun fichier reçu.", "Déposez le .zip ou le .csv exporté depuis la Search Console.");
    if (file.size > MAX_UPLOAD_BYTES) throw tooLarge();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const data = importFile(file.name || "export.csv", bytes, s.host);
    store.setGsc(s.id, data);
    hub.emit(s.id, { type: "search_console", available: true });
    return json(store.searchConsole(s.id));
  });
  app.post("/api/sites/:siteId/search-console/sync", async (c) => {
    const s = site(c);
    requireFeature("searchConsoleSync");
    const body = await readJson<{ days: number }>(c, true);
    const extra = Object.keys(body).filter((k) => k !== "days");
    if (extra.length) throw errors.badRequest("Paramètre inconnu.", "Seul « days » est accepté.");
    const days = body.days === undefined ? 28 : body.days;
    if (!(ALLOWED_DAYS as readonly unknown[]).includes(days)) throw errors.badRequest("La période doit être de 28, 90 ou 480 jours.", "Choisissez 28, 90 ou 480.");
    if (!gsc.configured) throw gscErrors.notConfigured();
    gscSyncLimiter.take(`gsc:${s.id}`, "de lecture de la Search Console");
    const { data } = await gsc.read(s.host, days as number);
    if (!store.getSite(s.id)) throw errors.siteNotFound();
    store.setGsc(s.id, data, "google");
    hub.emit(s.id, { type: "search_console", available: true });
    return json(store.searchConsole(s.id));
  });
  app.delete("/api/sites/:siteId/search-console", (c) => {
    const s = site(c);
    store.deleteGsc(s.id);
    hub.emit(s.id, { type: "search_console", available: false });
    return new Response(null, { status: 204 });
  });

  // ───────── Google Analytics

  app.get("/api/sites/:siteId/analytics", (c) => {
    const s = site(c);
    requireFeature("analytics");
    return getJson(c, store.analytics(s.id, ga.configured));
  });
  app.post("/api/sites/:siteId/analytics/sync", async (c) => {
    const s = site(c);
    requireFeature("analytics");
    const body = await readJson<{ days: number }>(c, true);
    const extra = Object.keys(body).filter((k) => k !== "days");
    if (extra.length) throw errors.badRequest("Paramètre inconnu.", "Seul « days » est accepté.");
    const days = body.days === undefined ? 28 : body.days;
    if (!(ANALYTICS_DAYS as readonly unknown[]).includes(days)) throw errors.badRequest("La période doit être de 28 ou 90 jours.", "Choisissez 28 ou 90.");
    if (!ga.configured) throw analyticsErrors.notConfigured();
    analyticsSyncLimiter.take(`analytics:${s.id}`, "de lecture de Google Analytics");
    const data = await ga.read(s.host, days as number);
    if (!store.getSite(s.id)) throw errors.siteNotFound();
    store.setAnalytics(s.id, data);
    hub.emit(s.id, { type: "analytics" });
    return json(store.analytics(s.id, ga.configured));
  });

  // ───────── Vitesse des pages

  app.get("/api/sites/:siteId/pagespeed", (c) => {
    const s = site(c);
    requireFeature("pageSpeed");
    return getJson(c, speed.state(s));
  });
  app.post("/api/sites/:siteId/pagespeed", async (c) => {
    const s = site(c);
    requireFeature("pageSpeed");
    const body = await readJson<MeasureSpeedRequest>(c, true);
    const extra = Object.keys(body).filter((k) => k !== "pageIds");
    if (extra.length) throw errors.badRequest("Paramètre inconnu.", "Seul « pageIds » est accepté.");
    // Mode intégré : une page désignée dans le corps doit appartenir à ce site, sinon 404 (contrat « Séparation »).
    if (embedded && Array.isArray(body.pageIds)) {
      for (const id of body.pageIds) {
        if (typeof id !== "string") continue;
        const row = store.getPage(id);
        if (row && row.site_id !== s.id) throw errors.notFound("Cette page");
      }
    }
    return json(speed.start(s, body), 202);
  });
  app.post("/api/sites/:siteId/pagespeed/cancel", async (c) => {
    const s = site(c);
    requireFeature("pageSpeed");
    await speed.cancel(s.id);
    return json(speed.state(s));
  });

  // ───────── Concurrents

  app.get("/api/sites/:siteId/competitors", (c) => {
    const s = site(c);
    requireFeature("competitors");
    const stored = store.getCompetitors(s.id);
    let data: CompetitorsData;
    if (stored) data = stored;
    else if (!deps.searchProvider) data = { available: false, reason: "not_configured" };
    else if (!store.resultsAudit(s.id)) data = { available: false, reason: "no_audit" };
    else data = { available: false, reason: "not_run" };
    return getJson(c, data);
  });
  app.post("/api/sites/:siteId/competitors", async (c) => {
    const s = site(c);
    requireFeature("competitors");
    if (!deps.searchProvider) throw competitorsNotConfigured();
    const audit = store.resultsAudit(s.id);
    if (!audit) throw errors.noAudit();
    competitorsLimiter.take(limitKey("competitors", s), "de relevé des concurrents");
    const rows = store.pageRows(audit.id);
    const gsc = store.getGsc(s.id);
    const queries = pickQueries({
      host: s.host,
      siteName: s.name || s.host,
      gscQueries: gsc?.data.queries ?? null,
      pages: rows.map((r) => ({ path: r.path, title: r.title })),
    });
    if (!queries.length)
      throw errors.badRequest(
        "Aucune requête exploitable n'a été trouvée pour rechercher vos concurrents.",
        "Importez votre export Search Console, ou donnez un titre à vos pages principales, puis réessayez.",
      );
    const home = rows.find((r) => r.path === "/") ?? rows[0];
    const lang = home ? (JSON.parse(home.facts_json) as PageFacts).lang : null;
    const data = await runCompetitorSurvey({
      provider: deps.searchProvider,
      queries,
      ownHost: s.host,
      country: countryFor(lang),
      signal: c.req.raw.signal,
    });
    store.setCompetitors(s.id, data);
    return json(data);
  });

  // ───────── Assistant

  app.get("/api/sites/:siteId/chat", (c) => {
    const s = site(c);
    requireFeature("assistant");
    return getJson(c, { available: !!deps.chatClient, messages: store.chatMessages(s.id), suggestions: suggestions(store, s) } satisfies ChatState);
  });
  app.post("/api/sites/:siteId/chat", async (c) => {
    const s = site(c);
    requireFeature("assistant");
    if (!deps.chatClient) throw chatNotConfigured();
    const body = await readJson<ChatRequest>(c);
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) throw errors.badRequest("Votre message est vide.", "Écrivez une question, puis envoyez-la.");
    if (message.length > 4000) throw errors.badRequest("Votre message est trop long (4 000 caractères au plus).", "Raccourcissez-le, puis réessayez.");
    if (chatBusy.has(s.id)) {
      throw new HttpError(409, "limit_reached", "L'assistant est déjà en train de répondre sur ce site.", "Attendez la fin de la réponse en cours, puis posez votre question.");
    }
    // Mode intégré : la conversation compte dans le plafond de jetons d'IA du jour du site (refus avant l'appel).
    const budget = embedded
      ? {
          exceeded: (): ApiError["error"] | null => {
            const usage = getUsage(store.db, s.host, Date.now());
            return usage.aiTokens >= getPolicy(store.db, s.id, policyBounds).aiTokensPerDay ? chatBudgetExceeded(usage.resetsAt).toErrorObject() : null;
          },
          charge: (tokens: number) => addUsage(store.db, s.host, Date.now(), { aiTokens: tokens }),
        }
      : undefined;
    const over = budget?.exceeded();
    if (over) throw chatBudgetExceeded(String(over.details?.resetsAt ?? ""));
    takeAi(chatLimiter, limitKey("chat", s), "à l'assistant");
    const client = deps.chatClient;
    const bundle = bundleOf(s);
    chatBusy.add(s.id);
    return streamSSE(c, async (stream) => {
      const controller = new AbortController();
      stream.onAbort(() => controller.abort());
      c.req.raw.signal.addEventListener("abort", () => controller.abort(), { once: true });
      // Les écritures sont enchaînées et attendues avant de fermer le flux, pour que « done » ou « error » arrive toujours.
      let chain: Promise<void> = Promise.resolve();
      const send = (ev: ChatEvent) => {
        chain = chain.then(() => stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) })).catch(() => undefined);
      };
      try {
        await runChat({ client, model: config.anthropicModel, store, site: s, message, send, signal: controller.signal, shopify: bundle.shopify, batches: bundle.batches, hidden, budget });
        await chain;
      } finally {
        chatBusy.delete(s.id);
      }
    });
  });
  app.delete("/api/sites/:siteId/chat", (c) => {
    const s = site(c);
    requireFeature("assistant");
    store.clearChat(s.id);
    return new Response(null, { status: 204 });
  });

  // ───────── Boutique Shopify (docs/format-echange.md, « Boutique Shopify »)

  const pageParams = (c: Context) => {
    const offset = Math.max(0, Number.parseInt(c.req.query("offset") ?? "0", 10) || 0);
    const limitRaw = Number.parseInt(c.req.query("limit") ?? "50", 10);
    return { offset, limit: Math.min(200, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 50)) };
  };

  app.get("/api/sites/:siteId/shopify", async (c) => {
    const s = site(c);
    return getJson(c, await bundleOf(s).shopify.state(s));
  });
  app.post("/api/sites/:siteId/shopify/sync", async (c) => {
    const s = site(c);
    const { shopify } = bundleOf(s);
    shopify.assertConfigured();
    shopifySyncLimiter.take(limitKey("shopify-sync", s), "de lecture de la boutique");
    return json(await shopify.sync(s));
  });
  app.get("/api/sites/:siteId/shopify/resources", async (c) => {
    const s = site(c);
    const { shopify } = bundleOf(s);
    const type = c.req.query("type") || null;
    if (type !== null && !(SHOPIFY_TYPES as string[]).includes(type)) throw errors.badRequest("Ce type d'élément n'existe pas.", "Utilisez product, collection, page ou article.");
    const missing = c.req.query("missing") || null;
    if (missing !== null && !(SHOPIFY_MISSING as readonly string[]).includes(missing)) throw errors.badRequest("Ce filtre n'existe pas.", "Utilisez seo_title, seo_description ou image_alt.");
    const fix = c.req.query("fix") || null;
    if (fix !== null && !(SHOPIFY_FIX as readonly string[]).includes(fix)) throw errors.badRequest("Ce filtre n'existe pas.", "Utilisez fix=seo_title ou fix=seo_description.");
    const q: ResourceQuery = { type: type as ShopifyResourceType | null, missing: missing as ResourceQuery["missing"], fix: fix as ResourceQuery["fix"], q: (c.req.query("q") ?? "").slice(0, 200), ...pageParams(c) };
    return getJson(c, await shopify.resources(s, q));
  });
  app.get("/api/sites/:siteId/shopify/resources/:resourceId", async (c) => {
    const s = site(c);
    const { shopify } = bundleOf(s);
    return getJson(c, { resource: await shopify.resource(s, c.req.param("resourceId")) } satisfies ShopifyResourceResponse);
  });
  app.post("/api/sites/:siteId/shopify/changes", async (c) => {
    const s = site(c);
    const { shopify } = bundleOf(s);
    // Garde-fou n° 1 avant tout appel à Shopify : écritures activées côté serveur.
    shopify.assertWritable();
    shopify.writeLimiter.take("shopify", "de modification de la boutique");
    const body = await readJson<ShopifyChangeRequest>(c);
    return json(await shopify.change(s, body), 201);
  });
  app.get("/api/sites/:siteId/shopify/changes", async (c) => {
    const s = site(c);
    const { shopify } = bundleOf(s);
    const { offset, limit } = pageParams(c);
    return getJson(c, await shopify.changes(s, offset, limit));
  });
  app.post("/api/sites/:siteId/shopify/changes/:changeId/restore", async (c) => {
    const s = site(c);
    const { shopify } = bundleOf(s);
    shopify.assertWritable();
    shopify.writeLimiter.take("shopify", "de modification de la boutique");
    return json(await shopify.restore(s, c.req.param("changeId")), 201);
  });

  app.post("/api/sites/:siteId/shopify/changes/:changeId/verify", async (c) => {
    const changeId = c.req.param("changeId") ?? "";
    if (!/^chg_[a-z0-9]{6,40}$/.test(changeId)) throw errors.badRequest("Cette modification n'est pas valide.", "Rechargez l'historique, puis réessayez.");
    const s = site(c);
    const { shopify } = bundleOf(s);
    // Aucune écriture dans la boutique : SHOPIFY_WRITES_ENABLED n'est pas demandé.
    shopify.assertConfigured();
    // Les refus (introuvable, annulée, remplacée) ne comptent pas dans la limite.
    shopify.assertVerifiable(s, changeId);
    verifyLimiter.take(limitKey("shopify-verify", s), "de vérification");
    return json({ change: await shopify.verify(s, changeId) } satisfies ShopifyVerifyResponse);
  });

  // ───────── Lots de corrections (docs/format-echange.md, « Lots de corrections »)

  const batchesBase = "/api/sites/:siteId/shopify/batches";
  app.get(batchesBase, async (c) => {
    const s = site(c);
    const { shopify, batches } = bundleOf(s);
    shopify.assertConfigured();
    await shopify.connectedInfo(s).catch((err) => {
      // Comme l'historique : les lots stockés restent consultables quand Shopify ne répond pas.
      if (!(err instanceof HttpError && err.code === "shopify_unavailable")) throw err;
    });
    return getJson(c, { batches: batches.list(s) } satisfies ShopifyBatchesResponse);
  });
  app.post(batchesBase, async (c) => {
    const s = site(c);
    const { batches } = bundleOf(s);
    const body = await readJson<CreateBatchRequest>(c);
    batchCreateLimiter.take(limitKey("batches", s), "de création de lots");
    return json({ batch: await batches.createManual(s, body) } satisfies ShopifyBatchResponse, 201);
  });
  app.get(`${batchesBase}/:batchId`, async (c) => {
    const s = site(c);
    const { shopify, batches } = bundleOf(s);
    shopify.assertConfigured();
    return getJson(c, { batch: batches.get(s, c.req.param("batchId")) } satisfies ShopifyBatchResponse);
  });
  app.patch(`${batchesBase}/:batchId/items/:itemId`, async (c) => {
    const s = site(c);
    const { shopify, batches } = bundleOf(s);
    shopify.assertConfigured();
    const body = await readJson<UpdateBatchItemRequest>(c);
    return json({ batch: await batches.updateItem(s, c.req.param("batchId"), c.req.param("itemId"), body) } satisfies ShopifyBatchResponse);
  });
  app.post(`${batchesBase}/:batchId/apply`, async (c) => {
    const s = site(c);
    const { shopify, batches } = bundleOf(s);
    // Garde-fou n° 1 avant tout appel à Shopify : écritures activées côté serveur.
    shopify.assertWritable();
    return json({ batch: await batches.apply(s, c.req.param("batchId")) } satisfies ShopifyBatchResponse, 202);
  });
  app.post(`${batchesBase}/:batchId/restore`, async (c) => {
    const s = site(c);
    const { shopify, batches } = bundleOf(s);
    shopify.assertWritable();
    return json({ batch: await batches.restore(s, c.req.param("batchId")) } satisfies ShopifyBatchResponse, 202);
  });
  app.post(`${batchesBase}/:batchId/stop`, async (c) => {
    const s = site(c);
    const { shopify, batches } = bundleOf(s);
    shopify.assertConfigured();
    return json({ batch: await batches.stop(s, c.req.param("batchId")) } satisfies ShopifyBatchResponse);
  });
  app.delete(`${batchesBase}/:batchId`, async (c) => {
    const s = site(c);
    const { shopify, batches } = bundleOf(s);
    shopify.assertConfigured();
    return json({ batch: batches.cancel(s, c.req.param("batchId")) } satisfies ShopifyBatchResponse);
  });
  app.post("/api/sites/:siteId/shopify/optimize", async (c) => {
    const s = site(c);
    const { optimizer } = bundleOf(s);
    const body = await readJson<OptimizeRequest>(c);
    takeAi(optimizeLimiter, limitKey("optimize", s), "de préparation par l'IA");
    return json({ batch: await optimizer.start(s, body, chatNotConfigured) } satisfies ShopifyBatchResponse, 202);
  });

  // ───────── Automatisation

  const automationState = (s: SiteRow): AutomationState => ({
    policy: getPolicy(store.db, s.id, policyBounds),
    limits: policyLimits(policyBounds),
    // Mode intégré : toujours false, quel que soit le registre fourni (refus fermé).
    autoAllowed: embedded ? false : bundleOf(s).batches.autoAllowed,
    writesEnabled: bundleOf(s).shopify.writesEnabled,
    aiConfigured: !!deps.chatClient,
    usage: getUsage(store.db, s.host, Date.now()),
  });
  app.get("/api/sites/:siteId/automation", (c) => getJson(c, automationState(site(c))));
  app.put("/api/sites/:siteId/automation", async (c) => {
    const s = site(c);
    const body = await readJson<UpdateAutomationRequest>(c);
    const extra = Object.keys(body).filter((k) => k !== "policy");
    if (extra.length) throw errors.badRequest(`Réglage inconnu : ${extra[0].slice(0, 40)}.`, "Envoyez { policy: { … } }.");
    const policy = parsePolicy(body.policy, policyLimits(policyBounds));
    // Mode intégré : refus fermé du mode « auto », avant toute écriture et sans compter dans la limite.
    if (policyBounds.noAuto && policy.mode === "auto") throw autoNotInEmbeddedMode();
    automationLimiter.take(limitKey("automation", s), "d'enregistrement de la règle d'automatisation");
    setPolicy(store.db, s.id, policy, new Date().toISOString());
    return json(automationState(s));
  });

  // ───────── Évolution (docs/format-echange.md, « Évolution et rapport »)

  app.get("/api/sites/:siteId/progress", (c) => {
    const s = site(c);
    return getJson(c, { progress: progress(store, s, bundleOf(s).shopify.correctionCounts(s)) } satisfies ProgressResponse);
  });

  // ───────── Routes inconnues et interface compilée

  app.all("/api/*", () => {
    throw errors.notFound("Cette adresse de l'API");
  });

  if (existsSync(config.webDist)) mountStatic(app, config.webDist, embedded ? appBridgeHead(config.shopifyApp!.clientId) : null);
  return app;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

const escapeAttr = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Mode intégré : identifiant de l'application (pas un secret) et App Bridge, à placer en tête de <head>. */
export function appBridgeHead(clientId: string): string {
  return `<meta name="shopify-api-key" content="${escapeAttr(clientId)}"><script src="${APP_BRIDGE_SRC}"></script>`;
}

/** Ajoute `head` juste après la balise <head> ouvrante (avant tout autre script) ; à défaut, en tout début. */
export function injectHead(html: string, head: string): string {
  const m = /<head(\s[^>]*)?>/i.exec(html);
  if (!m) return head + html;
  const at = m.index + m[0].length;
  return html.slice(0, at) + head + html.slice(at);
}

/** Sert web/dist ; toute route de l'interface sans fichier renvoie index.html (complété par `head` s'il est donné). */
function mountStatic(app: Hono<AppEnv>, root: string, head: string | null = null): void {
  const rootAbs = path.resolve(root);
  app.get("*", (c) => {
    let rel: string;
    try {
      rel = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      rel = "/";
    }
    const file = path.resolve(rootAbs, "." + path.posix.normalize("/" + rel));
    const inside = file === rootAbs || file.startsWith(rootAbs + path.sep);
    let target = path.join(rootAbs, "index.html");
    if (inside && existsSync(file) && statSync(file).isFile()) target = file;
    else if (path.extname(rel)) return c.text("Fichier introuvable", 404);
    if (!existsSync(target)) return c.text("Interface introuvable", 404);
    const ext = path.extname(target).toLowerCase();
    const immutable = target.includes(`${path.sep}assets${path.sep}`);
    const isIndex = target === path.join(rootAbs, "index.html");
    const body = head && isIndex ? injectHead(readFileSync(target, "utf8"), head) : readFileSync(target);
    return new Response(body, {
      headers: {
        "content-type": MIME[ext] ?? "application/octet-stream",
        "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
        "x-content-type-options": "nosniff",
      },
    });
  });
}
