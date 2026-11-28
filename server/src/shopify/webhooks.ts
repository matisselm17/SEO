/**
 * Appels signés de Shopify, mode intégré (docs/format-echange.md, « Appels de Shopify : désinstallation et vie
 * privée (mode intégré) ») : `POST /webhooks/shopify`.
 *
 * Ordre, avant tout traitement : au plus 20 corps lus en même temps (sinon 503), corps brut lu au fil de l'eau
 * (256 Ko au plus, sinon 413), signature HMAC-SHA256 du corps brut avec le secret de l'application comparée en temps
 * constant (sinon 401, rien d'enregistré), sujet connu (sinon 200 sans traitement), corps de la forme de son sujet et
 * boutique lue DANS LE CORPS SIGNÉ (sinon 200 sans traitement), doublon (identifiant déjà vu : 200 sans
 * retraitement). Un corps qui n'est pas arrivé en entier en 10 secondes est abandonné (408). La réponse part tout de
 * suite ; le travail long se fait après.
 *
 * Désinstallation : un avis n'est jamais cru sur parole. Il est noté (`uninstall_checks`), puis, après la réponse,
 * Shopify est interrogé avec les jetons lisibles de la boutique : acceptés → avis ignoré ; refusés définitivement →
 * désinstallation confirmée ; tout le reste (réponse non claire, jetons absents, expirés ou illisibles) → rien n'est
 * marqué ni effacé, l'avis reste en attente (reposé au démarrage puis au plus une fois par heure), et il est abandonné
 * sans effet 48 heures après son arrivée.
 *
 * Effacement immédiat sur preuve seulement : désinstallation confirmée (`uninstalled_at` rempli, aucun jeton enregistré
 * depuis), ou jetons lisibles refusés définitivement par Shopify à l'instant. Sinon la demande attend (même cadence) ;
 * au bout de 25 jours elle est exécutée si aucune requête identifiée de la boutique n'est arrivée depuis la demande.
 *
 * Journaux : jamais le secret, un jeton, un domaine de boutique ni le corps (les appels de vie privée contiennent
 * des données de client final : leur corps n'est ni enregistré ni journalisé).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Crawler } from "../crawl/crawler.ts";
import { tx } from "../db.ts";
import type { EventHub } from "../events.ts";
import type { PageSpeedService } from "../speed/service.ts";
import type { Store } from "../store.ts";
import { parseShopDomain } from "./auth.ts";
import { purgeShop } from "./redact.ts";
import { bundleBusy, type ShopBundle, type ShopifyRegistry } from "./registry.ts";
import { markUninstalled, shopLifecycle, type ShopLifecycle } from "./shops.ts";

export const WEBHOOK_PATH = "/webhooks/shopify";
export const WEBHOOK_BODY_LIMIT = 256 * 1024;
export const WEBHOOK_TOPICS = ["app/uninstalled", "shop/redact", "customers/data_request", "customers/redact"] as const;
export type WebhookTopic = (typeof WEBHOOK_TOPICS)[number];
/**
 * Reprise des avis et des demandes d'effacement en attente ; aussi l'écart minimal entre deux tentatives d'une même
 * ligne (sauf au démarrage, et sauf pour une ligne qui n'a jamais été tentée).
 */
export const REDACTION_RETRY_MS = 60 * 60 * 1000;
/** Sans preuve, une demande d'effacement est exécutée au bout de ce délai (Shopify en accorde 30 jours). */
export const REDACTION_DEADLINE_MS = 25 * 24 * 60 * 60 * 1000;
/** Un avis de désinstallation qui n'a pas reçu de réponse claire de Shopify est abandonné, sans effet, au bout de ce délai. */
export const UNINSTALL_CHECK_TTL_MS = 48 * 60 * 60 * 1000;
/** Les identifiants d'appels reçus sont gardés ce temps (Shopify réessaie pendant 4 heures). */
export const WEBHOOK_EVENTS_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Au plus ce nombre de corps lus en même temps sur la route ; au-delà, 503. */
export const WEBHOOK_MAX_CONCURRENT_READS = 20;
/** Avertissement « demande en attente au-delà de 25 jours » : au plus une fois par jour. */
export const REDACTION_WARNING_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Un corps qui n'est pas arrivé en entier dans ce délai est abandonné (408) : la place est rendue. */
export const WEBHOOK_READ_TIMEOUT_MS = 10_000;

const WEBHOOK_ID = /^[A-Za-z0-9._:-]{1,200}$/;

/**
 * Signature d'un appel : `header` doit être le HMAC-SHA256 de `raw` (octets bruts) avec `secret`, en base64
 * canonique. Comparaison en temps constant. Fonction pure.
 */
export function verifyWebhookSignature(raw: Buffer, header: string | null | undefined, secret: string): boolean {
  if (!secret || typeof header !== "string" || header.length === 0 || header.length > 200) return false;
  const expected = createHmac("sha256", secret).update(raw).digest();
  const given = Buffer.from(header, "base64");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
  // Une seule écriture de la signature est acceptée.
  return given.toString("base64") === header;
}

export const isWebhookTopic = (t: string | null | undefined): t is WebhookTopic => typeof t === "string" && (WEBHOOK_TOPICS as readonly string[]).includes(t);

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Forme du corps exigée par sujet (contrat, tableau « forme du corps par sujet ») : l'en-tête de sujet n'est pas signé,
 * un corps signé ne doit jamais pouvoir être rejoué sous un autre sujet. Fonction pure.
 */
export function bodyMatchesTopic(topic: WebhookTopic, body: Record<string, unknown>): boolean {
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
  switch (topic) {
    case "shop/redact": {
      const keys = Object.keys(body);
      return keys.length === 2 && has("shop_id") && has("shop_domain") && typeof body.shop_id === "number" && Number.isFinite(body.shop_id);
    }
    case "customers/redact":
      return has("shop_domain") && isObject(body.customer) && !has("data_request") && !has("myshopify_domain");
    case "customers/data_request":
      return has("shop_domain") && isObject(body.customer) && isObject(body.data_request) && !has("myshopify_domain");
    case "app/uninstalled":
      return has("myshopify_domain") && !has("shop_domain") && !has("customer");
  }
}

/**
 * Boutique d'un appel, lue dans le corps signé : `myshopify_domain` pour la désinstallation, `shop_domain` pour les
 * trois appels de vie privée. Le corps doit avoir la forme de son sujet (`bodyMatchesTopic`). Forme exacte
 * `xxx.myshopify.com` ; l'en-tête `X-Shopify-Shop-Domain`, s'il est présent, doit lui être égal. null sinon (corps
 * illisible, forme d'un autre sujet, champ absent, discordance). Fonction pure.
 */
export function shopFromBody(topic: WebhookTopic, raw: Buffer, headerShop: string | null | undefined): string | null {
  let body: unknown;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
  if (!isObject(body) || !bodyMatchesTopic(topic, body)) return null;
  const field = topic === "app/uninstalled" ? "myshopify_domain" : "shop_domain";
  const v = body[field];
  if (typeof v !== "string" || parseShopDomain(v) !== v) return null;
  if (headerShop !== null && headerShop !== undefined && headerShop !== v) return null;
  return v;
}

/** Date lisible (millisecondes) ou null. */
const ms = (v: string | null | undefined): number | null => {
  if (typeof v !== "string" || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

/**
 * Désinstallation confirmée : `uninstalled_at` rempli (seulement sur refus définitif de Shopify) et aucun jeton
 * enregistré depuis (la boutique n'a aucun jeton en base, et aucun couple n'a été enregistré après cette date).
 */
function confirmedUninstall(st: ShopLifecycle | null): boolean {
  if (!st || st.tokenMark) return false;
  const un = ms(st.uninstalledAt);
  if (un === null) return false;
  const saved = ms(st.tokensSavedAt);
  if (saved !== null && saved > un) return false;
  // Une requête identifiée arrivée après la désinstallation confirmée signale une réinstallation (même si l'échange
  // de jeton n'a pas encore abouti) : ce n'est plus une preuve, la demande attend.
  const seen = ms(st.lastSeenAt);
  return seen === null || seen <= un;
}

/** Une requête identifiée de la boutique est-elle arrivée après la demande d'effacement ? */
const seenSince = (st: ShopLifecycle | null, receivedAt: string): boolean => {
  const seen = ms(st?.lastSeenAt);
  const received = ms(receivedAt);
  return seen !== null && received !== null && seen > received;
};

export interface WebhookTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const defaultTimers: WebhookTimers = {
  setInterval: (fn, ms) => {
    const t = setInterval(fn, ms);
    t.unref?.();
    return t;
  },
  clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
};

export interface WebhookDeps {
  store: Store;
  registry: ShopifyRegistry;
  hub: EventHub;
  crawler: Crawler;
  pagespeed: PageSpeedService;
  /** Secret de l'application (SHOPIFY_CLIENT_SECRET). */
  secret: string;
  now?: () => number;
  timers?: WebhookTimers;
  /** Délai de lecture d'un corps (tests) ; `WEBHOOK_READ_TIMEOUT_MS` par défaut. */
  readTimeoutMs?: number;
}

/** Réinstallation (ou requête identifiée) constatée dans la transaction d'effacement : tout est annulé, la demande reste en attente. */
class ReinstalledDuringPurge extends Error {}

const empty = (status: number) => new Response(null, { status });

interface UninstallRow {
  shop_domain: string;
  received_at: string;
  last_attempt_at: string | null;
}

interface RedactionRow {
  id: number;
  shop_domain: string | null;
  received_at: string;
  last_warned_at: string | null;
  last_attempt_at: string | null;
}

export class ShopifyWebhooks {
  private readonly d: WebhookDeps;
  private readonly now: () => number;
  private readonly timers: WebhookTimers;
  private interval: unknown = null;
  private stopped = false;
  /** Travaux lancés après une réponse (désinstallation, effacement). */
  private tasks = new Set<Promise<void>>();
  private runner: Promise<void> | null = null;
  private again = false;
  /** Le prochain passage reprend toutes les lignes, même tentées il y a moins d'une heure (démarrage). */
  private forceAll = false;
  /** Début du passage en cours : date notée pour chaque tentative (cadence d'une heure par ligne). */
  private passAt: number | null = null;
  /** Corps en cours de lecture sur la route. */
  private reading = 0;

  constructor(deps: WebhookDeps) {
    this.d = deps;
    this.now = deps.now ?? Date.now;
    this.timers = deps.timers ?? defaultTimers;
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  /** Traite un appel. Ne lève jamais : toute réponse est vide. */
  async handle(req: Request): Promise<Response> {
    if (this.reading >= WEBHOOK_MAX_CONCURRENT_READS) {
      void req.body?.cancel().catch(() => undefined);
      const res = empty(503);
      res.headers.set("connection", "close");
      return res;
    }
    let raw: Buffer | null;
    this.reading++;
    try {
      const read = await readLimited(req, WEBHOOK_BODY_LIMIT, this.d.readTimeoutMs ?? WEBHOOK_READ_TIMEOUT_MS);
      if (read === "timeout") {
        const res = empty(408);
        res.headers.set("connection", "close");
        return res;
      }
      raw = read;
    } catch {
      return empty(400);
    } finally {
      this.reading--;
    }
    if (raw === null) {
      const res = empty(413);
      res.headers.set("connection", "close");
      return res;
    }
    if (!verifyWebhookSignature(raw, req.headers.get("x-shopify-hmac-sha256"), this.d.secret)) return empty(401);

    const topic = req.headers.get("x-shopify-topic");
    if (!isWebhookTopic(topic)) {
      console.warn("[webhooks] Appel Shopify d'un sujet non traité : ignoré.");
      return empty(200);
    }
    const shop = shopFromBody(topic, raw, req.headers.get("x-shopify-shop-domain"));
    // Le corps n'est plus utilisé au-delà de ce point (ni gardé, ni journalisé).
    raw = null;
    if (!shop) {
      console.warn("[webhooks] Appel Shopify ignoré : boutique absente, mal formée ou discordante.");
      return empty(200);
    }
    const idHeader = req.headers.get("x-shopify-webhook-id");
    const webhookId = idHeader && WEBHOOK_ID.test(idHeader) ? idHeader : null;

    const db = this.d.store.db;
    let fresh: boolean;
    try {
      fresh = tx(db, () => {
        if (webhookId) {
          const r = db.prepare("INSERT OR IGNORE INTO webhook_events (webhook_id, topic, received_at) VALUES (?, ?, ?)").run(webhookId, topic, this.iso());
          if (Number(r.changes) === 0) return false;
        }
        if (topic === "app/uninstalled") {
          // Jamais cru sur parole : noté, puis vérifié auprès de Shopify après la réponse (aucun effet d'ici là).
          db.prepare("INSERT OR IGNORE INTO uninstall_checks (shop_domain, received_at) VALUES (?, ?)").run(shop, this.iso());
        } else if (topic === "shop/redact") {
          const pending = db.prepare("SELECT 1 AS x FROM shop_redactions WHERE state = 'pending' AND shop_domain = ?").get(shop);
          if (!pending) db.prepare("INSERT INTO shop_redactions (shop_domain, received_at, state) VALUES (?, ?, 'pending')").run(shop, this.iso());
        }
        return true;
      });
    } catch (err) {
      // Shopify réessaiera : rien n'a été enregistré (transaction annulée).
      console.error("[webhooks] Appel Shopify non enregistré :", err instanceof Error ? err.constructor.name : "erreur");
      return empty(500);
    }
    if (!fresh) return empty(200);

    if (topic === "app/uninstalled" || topic === "shop/redact") {
      this.later(() => this.runPending());
    } else {
      console.log("[webhooks] Demande de vie privée d'un client reçue : aucune donnée de client final n'est gardée.");
    }
    return empty(200);
  }

  /** Lance un travail après la réponse. */
  private later(fn: () => Promise<void>): void {
    this.track(new Promise<void>((resolve) => setImmediate(resolve)).then(fn));
  }

  /** Suit un travail en cours (attendu par `idle`) ; ses erreurs sont journalisées sans valeur. */
  private track(work: Promise<void>): void {
    const p: Promise<void> = work
      .catch((err) => {
        console.error("[webhooks] Traitement interrompu :", err instanceof Error ? err.constructor.name : "erreur");
      })
      .finally(() => {
        this.tasks.delete(p);
      });
    this.tasks.add(p);
  }

  /** Attend la fin des travaux lancés (tests, arrêt). */
  async idle(): Promise<void> {
    while (this.tasks.size || this.runner) {
      await Promise.all([...this.tasks, this.runner]);
    }
  }

  /**
   * Arrête les travaux de la boutique : analyse, mesures de vitesse, lot en cours d'écriture (arrêt propre, jamais de
   * reprise), puis ferme les flux `/events` de son site et libère son jeu de services. `forPurge` : attend aussi la
   * préparation par l'IA et les relectures en file, qui écriraient dans des tables à effacer.
   */
  private async stopShopWork(shop: string, forPurge: boolean): Promise<void> {
    const site = this.d.store.siteByShop(shop);
    const bundle: ShopBundle | null = this.d.registry.peek(shop);
    // Tous les arrêts sont demandés avant la première attente (partie synchrone de l'appel).
    const waits: Array<Promise<unknown>> = [];
    if (site) {
      if (this.d.crawler.cancel(site.id)) waits.push(this.d.crawler.wait(site.id));
      waits.push(this.d.pagespeed.cancel(site.id));
    }
    if (bundle) waits.push(bundle.batches.stopAll());
    await Promise.all(waits);
    if (bundle) {
      if (forPurge) {
        if (site) await bundle.optimizer.wait(site.id).catch(() => undefined);
        await bundle.shopify.verifier.idle();
      }
    }
    if (site) {
      this.d.hub.forget(site.id);
      this.d.hub.close(site.id);
    }
    // Un jeu recréé entre-temps (réinstallation) n'est pas libéré.
    if (bundle && this.d.registry.peek(shop) === bundle) this.d.registry.release(shop);
  }

  // ───── Avis de désinstallation

  /** Jeu de services de la boutique pour une vérification : celui en mémoire, ou un jeu créé pour l'occasion. */
  private bundleFor(shop: string): { bundle: ShopBundle; created: boolean } {
    const existed = this.d.registry.peek(shop);
    return existed ? { bundle: existed, created: false } : { bundle: this.d.registry.forShop(shop), created: true };
  }

  /** Libère un jeu de services créé pour une seule vérification (sauf s'il sert de nouveau entre-temps). */
  private releaseCreated(shop: string, b: { bundle: ShopBundle; created: boolean }): void {
    if (b.created && this.d.registry.peek(shop) === b.bundle && !bundleBusy(b.bundle)) this.d.registry.release(shop);
  }

  private dropUninstallCheck(shop: string): void {
    this.d.store.db.prepare("DELETE FROM uninstall_checks WHERE shop_domain = ?").run(shop);
  }

  /** Date d'une tentative : le début du passage en cours (cadence d'une heure par ligne). */
  private attemptIso(): string {
    return new Date(this.passAt ?? this.now()).toISOString();
  }

  /**
   * Avis de désinstallation en attente : Shopify confirme-t-il ? Acceptés → avis ignoré (aucun effet) ; refusés
   * définitivement → désinstallation confirmée ; tout le reste (réponse non claire, jetons absents, expirés ou
   * illisibles) → rien n'est marqué ni effacé, l'avis reste en attente.
   */
  private async processUninstall(row: UninstallRow): Promise<void> {
    const shop = row.shop_domain;
    const db = this.d.store.db;
    if (parseShopDomain(shop) !== shop || !db.prepare("SELECT 1 AS x FROM shops WHERE domain = ?").get(shop)) {
      // Boutique inconnue : rien à marquer, aucune boutique créée.
      this.dropUninstallCheck(shop);
      return;
    }
    const before = shopLifecycle(db, shop);
    const b = this.bundleFor(shop);
    let check: Awaited<ReturnType<ShopBundle["shopify"]["installationCheck"]>>;
    try {
      check = await b.bundle.shopify.installationCheck();
    } catch {
      check = "unknown";
    }
    if (check === "installed") {
      this.dropUninstallCheck(shop);
      this.releaseCreated(shop, b);
      console.log("[webhooks] Avis de désinstallation ignoré : Shopify accepte les jetons de la boutique (application installée).");
      return;
    }
    if (check !== "refused") {
      // Aucune preuve : ni marque, ni effacement. Nouvel essai au plus tard dans une heure, abandon à 48 heures.
      this.releaseCreated(shop, b);
      db.prepare("UPDATE uninstall_checks SET attempts = attempts + 1, last_attempt_at = ? WHERE shop_domain = ?").run(this.attemptIso(), shop);
      console.warn(
        check === "no_tokens"
          ? "[webhooks] Avis de désinstallation en attente : aucun jeton lisible pour interroger Shopify, nouvel essai plus tard."
          : "[webhooks] Avis de désinstallation en attente : Shopify ne confirme pas la désinstallation, nouvel essai plus tard.",
      );
      return;
    }
    // Refus définitif : désinstallation confirmée, sauf si un couple neuf a été enregistré pendant la vérification
    // (réinstallation : Shopify l'a accepté).
    const marked = tx(db, () => {
      const now = shopLifecycle(db, shop);
      db.prepare("DELETE FROM uninstall_checks WHERE shop_domain = ?").run(shop);
      if (!now || now.tokensSavedAt !== (before?.tokensSavedAt ?? null)) return false;
      if (now.tokenMark && now.tokenMark !== (before?.tokenMark ?? null)) return false;
      markUninstalled(db, shop, this.iso());
      return true;
    });
    if (!marked) {
      console.log("[webhooks] Avis de désinstallation ignoré : la boutique a été réinstallée pendant la vérification.");
      return;
    }
    const current = this.d.registry.peek(shop);
    if (current === b.bundle) current.shopify.forgetSession();
    await this.stopShopWork(shop, false);
    console.log("[webhooks] Application désinstallée d'une boutique (confirmé par Shopify) : jetons effacés, travaux arrêtés, données gardées jusqu'à l'effacement.");
  }

  // ───── Demandes d'effacement

  /**
   * Exécute les avis de désinstallation puis les demandes d'effacement en attente (une exécution à la fois ; ce qui
   * arrive pendant est repris). Cadence : une ligne tentée il y a moins d'une heure n'est pas retentée, sauf au
   * démarrage ; une ligne jamais tentée (qui vient d'arriver) l'est tout de suite. Chaque passage note ses tentatives :
   * un nouveau passage déclenché par un autre appel ne les reprend pas, la boucle ne tourne pas sans fin.
   */
  runPending(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.again = true;
    this.runner ??= (async () => {
      // Jamais synchrone : sans cette attente, une exécution sans demande se terminerait (et remettrait `runner` à
      // null) avant que `runner` ne reçoive sa promesse, qui resterait alors posée pour toujours.
      await null;
      try {
        while (this.again && !this.stopped) {
          this.again = false;
          const force = this.forceAll;
          this.forceAll = false;
          const passAt = this.now();
          this.passAt = passAt;
          const due = (last: string | null): boolean => force || last === null || (ms(last) ?? 0) <= passAt - REDACTION_RETRY_MS;
          const checks = this.d.store.db.prepare("SELECT shop_domain, received_at, last_attempt_at FROM uninstall_checks ORDER BY received_at, shop_domain").all() as unknown as UninstallRow[];
          for (const row of checks) {
            if (this.stopped) break;
            const received = ms(row.received_at);
            if (received === null || passAt - received >= UNINSTALL_CHECK_TTL_MS) {
              // Aucune réponse claire de Shopify en 48 heures : avis abandonné, sans aucun effet.
              try {
                this.dropUninstallCheck(row.shop_domain);
                console.warn("[webhooks] Avis de désinstallation abandonné sans effet : Shopify ne l'a pas confirmé en 48 heures.");
              } catch {
                /* abandonné au prochain passage */
              }
              continue;
            }
            if (!due(row.last_attempt_at)) continue;
            try {
              await this.processUninstall(row);
            } catch (err) {
              console.error("[webhooks] Vérification d'un avis de désinstallation reportée :", err instanceof Error ? err.constructor.name : "erreur");
            }
          }
          const rows = this.d.store.db.prepare("SELECT id, shop_domain, received_at, last_warned_at, last_attempt_at FROM shop_redactions WHERE state = 'pending' ORDER BY id").all() as unknown as RedactionRow[];
          for (const row of rows) {
            if (this.stopped) break;
            if (!due(row.last_attempt_at)) continue;
            try {
              await this.processRedaction(row);
            } catch (err) {
              this.noteAttempt(row.id);
              console.error("[webhooks] Effacement d'une boutique reporté :", err instanceof Error ? err.constructor.name : "erreur");
            }
          }
        }
      } finally {
        this.passAt = null;
        this.runner = null;
      }
    })();
    return this.runner;
  }

  private close(id: number, outcome: "erased" | "reinstalled" | "unknown_shop" | "invalid"): void {
    this.d.store.db.prepare("UPDATE shop_redactions SET state = 'closed', outcome = ?, closed_at = ?, shop_domain = NULL, attempts = attempts + 1, last_attempt_at = ? WHERE id = ?").run(outcome, this.iso(), this.iso(), id);
  }

  private noteAttempt(id: number): void {
    try {
      this.d.store.db.prepare("UPDATE shop_redactions SET attempts = attempts + 1, last_attempt_at = ? WHERE id = ? AND state = 'pending'").run(this.attemptIso(), id);
    } catch {
      /* noté à la prochaine reprise */
    }
  }

  /** Demande laissée en attente (nouvel essai au prochain passage), avec un journal sans valeur. */
  private keepPending(id: number, why: string): void {
    this.noteAttempt(id);
    console.warn(`[webhooks] Effacement d'une boutique en attente : ${why}, nouvel essai plus tard.`);
  }

  /**
   * Demande en attente depuis plus de 25 jours, mais une requête identifiée de la boutique est arrivée depuis
   * (application vraisemblablement installée) : elle reste en attente, avec un avertissement au plus une fois par jour.
   */
  private keepPendingActive(row: RedactionRow): void {
    this.noteAttempt(row.id);
    const last = ms(row.last_warned_at);
    if (last !== null && this.now() - last < REDACTION_WARNING_INTERVAL_MS) return;
    try {
      this.d.store.db.prepare("UPDATE shop_redactions SET last_warned_at = ? WHERE id = ? AND state = 'pending'").run(this.iso(), row.id);
    } catch {
      /* averti de nouveau au prochain passage */
    }
    console.warn("[webhooks] Demande d'effacement en attente depuis plus de 25 jours, mais la boutique a utilisé l'application depuis la demande : rien n'est effacé.");
  }

  private async processRedaction(row: RedactionRow): Promise<void> {
    const shop = row.shop_domain;
    if (!shop || parseShopDomain(shop) !== shop) {
      this.close(row.id, "invalid");
      return;
    }
    const db = this.d.store.db;
    const known = !!db.prepare("SELECT 1 AS x FROM shops WHERE domain = ?").get(shop) || !!this.d.store.siteByShop(shop);
    if (!known) {
      this.close(row.id, "unknown_shop");
      console.log("[webhooks] Demande d'effacement d'une boutique inconnue : close sans effet.");
      return;
    }

    // Preuve que l'application n'est plus installée (contrat : un refus définitif de Shopify, et seulement lui).
    let proof: "uninstalled" | "refused" | null = null;
    let waiting = "";
    const initial = shopLifecycle(db, shop);
    if (initial?.tokenMark) {
      // Des jetons sont enregistrés : Shopify les accepte-t-il encore ?
      const b = this.bundleFor(shop);
      // Une vérification qui lève une erreur vaut « pas de réponse claire » : elle ne bloque pas l'échéance.
      const check = await b.bundle.shopify.installationCheck().catch(() => "unknown" as const);
      // Jeu de services créé pour cette seule vérification : libéré (sauf si l'application est réinstallée).
      if (check !== "installed") this.releaseCreated(shop, b);
      if (check === "installed") {
        this.close(row.id, "reinstalled");
        console.log("[webhooks] Demande d'effacement close sans rien effacer : l'application est de nouveau installée sur la boutique.");
        return;
      }
      // Un refus définitif ne vaut preuve que si la boutique n'a pas été utilisée depuis la demande : une requête
      // identifiée plus récente signale une application installée (rotation de jeton dont la réponse s'est perdue).
      if (check === "refused" && !seenSince(shopLifecycle(db, shop), row.received_at)) proof = "refused";
      else if (check === "refused") waiting = "la boutique a été utilisée depuis la demande";
      else waiting = check === "no_tokens" ? "jetons enregistrés illisibles" : "Shopify ne confirme pas la désinstallation";
    } else if (confirmedUninstall(initial)) {
      // Désinstallation confirmée par Shopify, aucun jeton enregistré depuis.
      proof = "uninstalled";
    } else {
      waiting = "aucune preuve de la désinstallation";
    }

    // État tel qu'il est après la vérification (un renouvellement refusé a effacé les jetons) : comparé dans la
    // transaction d'effacement, pour annuler si la boutique a été réinstallée ou utilisée entre-temps.
    const checked = shopLifecycle(db, shop);
    let deadline = false;
    if (!proof) {
      const received = ms(row.received_at);
      if (received === null || this.now() - received < REDACTION_DEADLINE_MS) {
        this.keepPending(row.id, waiting);
        return;
      }
      // Sans preuve, seulement si aucune requête identifiée de la boutique n'est arrivée depuis la demande (une
      // boutique désinstallée ne peut plus en envoyer).
      if (seenSince(checked, row.received_at)) {
        this.keepPendingActive(row);
        return;
      }
      deadline = true;
      console.warn("[webhooks] Délai de 25 jours atteint sans preuve de la désinstallation, et aucune requête de la boutique depuis la demande : la boutique est effacée sans confirmation.");
    }

    await this.stopShopWork(shop, true);
    let result;
    try {
      result = purgeShop(db, shop, () => {
        const now = shopLifecycle(db, shop);
        if (!now) return;
        // Un échange ou un renouvellement a réussi pendant l'arrêt des travaux : réinstallation, rien n'est effacé.
        if (now.tokensSavedAt !== (checked?.tokensSavedAt ?? null)) throw new ReinstalledDuringPurge();
        if (now.tokenMark && now.tokenMark !== (checked?.tokenMark ?? null)) throw new ReinstalledDuringPurge();
        // La désinstallation confirmée ne tient plus (couple enregistré depuis), ou une requête identifiée est arrivée
        // depuis la demande : rien n'est effacé.
        if (proof === "uninstalled" && !confirmedUninstall(now)) throw new ReinstalledDuringPurge();
        if (deadline && seenSince(now, row.received_at)) throw new ReinstalledDuringPurge();
      });
    } catch (err) {
      if (err instanceof ReinstalledDuringPurge) {
        this.keepPending(row.id, "la boutique a été réinstallée ou utilisée pendant la préparation");
        return;
      }
      throw err;
    }
    this.d.store.forgetAudits(result.auditIds);
    if (result.siteId) {
      this.d.hub.forget(result.siteId);
      this.d.hub.close(result.siteId);
    }
    this.d.registry.release(shop);
    this.close(row.id, "erased");
    // Les lignes supprimées ne restent ni dans les pages libres (secure_delete) ni dans le journal (vidé).
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      console.warn("[webhooks] Le journal de la base n'a pas pu être vidé après un effacement : nouvel essai au prochain effacement.");
    }
    console.log("[webhooks] Données d'une boutique effacées à sa demande (shop/redact).");
  }

  /** Reprise : au démarrage, puis toutes les heures (minuterie qui ne retient pas le processus). */
  start(): void {
    if (this.interval || this.stopped) return;
    // Au démarrage, toutes les lignes en attente sont reprises, même tentées il y a moins d'une heure.
    this.forceAll = true;
    this.later(() => this.tick());
    this.interval = this.timers.setInterval(() => void this.tick(), REDACTION_RETRY_MS);
  }

  /** Arrêt du serveur : plus de reprise ; un effacement en cours se termine (transaction courte). */
  stop(): void {
    this.stopped = true;
    if (this.interval) this.timers.clearInterval(this.interval);
    this.interval = null;
  }

  private async tick(): Promise<void> {
    try {
      const cutoff = new Date(this.now() - WEBHOOK_EVENTS_RETENTION_MS).toISOString();
      this.d.store.db.prepare("DELETE FROM webhook_events WHERE received_at < ?").run(cutoff);
    } catch {
      /* rien d'urgent */
    }
    await this.runPending();
  }
}

/**
 * Corps lu au fil de l'eau ; null au-delà de `max` octets (rien n'est gardé au-delà) ; "timeout" s'il n'est pas arrivé
 * en entier en `timeoutMs` (la lecture est abandonnée).
 */
async function readLimited(req: Request, max: number, timeoutMs: number): Promise<Buffer | null | "timeout"> {
  const declared = req.headers.get("content-length");
  if (declared !== null && !req.headers.has("transfer-encoding") && Number(declared) > max) {
    void req.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => undefined);
  }, timeoutMs);
  timer.unref?.();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (timedOut) return "timeout";
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        void reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch (err) {
    if (timedOut) return "timeout";
    throw err;
  } finally {
    clearTimeout(timer);
  }
  return Buffer.concat(chunks, size);
}
