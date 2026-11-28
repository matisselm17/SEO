/**
 * Registre des services Shopify (docs/format-echange.md, « Plusieurs boutiques (mode intégré) »).
 *
 * `ShopifyService` reste un objet « une boutique ». Le registre rend, pour une boutique, son jeu de services
 * (connexion, lots, optimisation), créé à la demande et gardé en mémoire : chacun a son `ShopifyAuth`, donc ses jetons,
 * ses files et ses verrous. En mode local, il rend toujours l'unique jeu de services configuré au démarrage.
 *
 * Tout le code qui appelle Shopify passe par `forSite(site)` : en mode intégré, un site sans boutique n'a aucun
 * service Shopify (null), et un site n'utilise jamais que les jetons de sa propre boutique.
 */
import { Optimizer } from "../automation/optimize.ts";
import type { ChatClient } from "../chat/assistant.ts";
import type { EventHub } from "../events.ts";
import type { PolicyBounds } from "../automation/policy.ts";
import type { SiteRow, Store } from "../store.ts";
import { parseShopDomain, type ShopifyAppMode } from "./auth.ts";
import { BatchService } from "./batches.ts";
import { ShopifyService } from "./service.ts";
import { dbTokenStore } from "./shops.ts";
import type { VerifierOptions } from "./verification.ts";

export interface ShopBundle {
  shopify: ShopifyService;
  batches: BatchService;
  optimizer: Optimizer;
}

/** Jeu de services d'une boutique inactif depuis ce délai (aucune requête ni aucun travail) : libéré de la mémoire. */
export const IDLE_RELEASE_MS = 30 * 60_000;

/** Un jeu de services en travail ne se libère jamais. */
export function bundleBusy(b: ShopBundle): boolean {
  return b.shopify.busy() || b.batches.busy() || b.optimizer.busy();
}

export class ShopifyRegistry {
  readonly mode: ShopifyAppMode;
  private readonly local: ShopBundle | null;
  private readonly factory: ((domain: string) => ShopBundle) | null;
  private readonly shops = new Map<string, ShopBundle>();
  /** Mode intégré : dernière demande de chaque boutique (horloge `now`), et requêtes en cours. */
  private readonly lastUsed = new Map<string, number>();
  private readonly requests = new Map<string, number>();
  private readonly now: () => number;

  private constructor(mode: ShopifyAppMode, local: ShopBundle | null, factory: ((domain: string) => ShopBundle) | null, now: () => number = Date.now) {
    this.mode = mode;
    this.local = local;
    this.factory = factory;
    this.now = now;
  }

  /** Mode local : un seul jeu de services, pour tous les sites (comportement d'avant le mode intégré). */
  static local(bundle: ShopBundle): ShopifyRegistry {
    return new ShopifyRegistry("local", bundle, null);
  }

  /** Mode intégré : un jeu de services par boutique, construit par `factory` à la première demande. */
  static embedded(factory: (domain: string) => ShopBundle, now?: () => number): ShopifyRegistry {
    return new ShopifyRegistry("embedded", null, factory, now);
  }

  /** Services de la boutique propriétaire du site ; null en mode intégré pour un site sans boutique. */
  forSite(site: Pick<SiteRow, "shop_domain">): ShopBundle | null {
    if (this.mode === "local") return this.local;
    return site.shop_domain ? this.forShop(site.shop_domain) : null;
  }

  /**
   * Mode intégré : services de la boutique `domain` (domaine du jeton de session vérifié). Le domaine est revalidé :
   * l'adresse des appels à Shopify en dépend.
   */
  forShop(domain: string): ShopBundle {
    if (this.mode !== "embedded" || !this.factory) throw new Error("Registre Shopify : forShop est réservé au mode intégré.");
    const d = parseShopDomain(domain);
    if (!d || d !== domain) throw new Error("Registre Shopify : domaine de boutique invalide.");
    let b = this.shops.get(d);
    if (!b) {
      b = this.factory(d);
      this.shops.set(d, b);
    }
    this.lastUsed.set(d, this.now());
    return b;
  }

  /**
   * Mode intégré : une requête identifiée de la boutique commence (`enter`) ou se termine (`leave`). Tant qu'une
   * requête est en cours, son jeu de services n'est pas libéré.
   */
  enter(domain: string): void {
    if (this.mode !== "embedded") return;
    this.requests.set(domain, (this.requests.get(domain) ?? 0) + 1);
    this.lastUsed.set(domain, this.now());
  }
  leave(domain: string): void {
    if (this.mode !== "embedded") return;
    const n = (this.requests.get(domain) ?? 1) - 1;
    if (n > 0) this.requests.set(domain, n);
    else this.requests.delete(domain);
    this.lastUsed.set(domain, this.now());
  }

  /**
   * Mode intégré : libère les jeux de services des boutiques sans requête depuis `idleMs` et sans aucun travail en
   * cours (lecture, écriture, lot, vérification, préparation par l'IA, ni ce que `busyElsewhere` signale, comme une
   * analyse du site). La prochaine requête en recrée un, qui relit ses jetons en base. Renvoie le nombre libéré.
   */
  releaseIdle(idleMs: number = IDLE_RELEASE_MS, busyElsewhere: (domain: string) => boolean = () => false): number {
    if (this.mode !== "embedded") return 0;
    const t = this.now();
    let released = 0;
    for (const [d, b] of [...this.shops]) {
      if ((this.requests.get(d) ?? 0) > 0) continue;
      if (t - (this.lastUsed.get(d) ?? 0) < idleMs) continue;
      if (bundleBusy(b)) continue;
      let elsewhere = true;
      try {
        elsewhere = busyElsewhere(d);
      } catch {
        elsewhere = true; // dans le doute, on garde
      }
      if (elsewhere) continue;
      this.shops.delete(d);
      this.lastUsed.delete(d);
      released++;
    }
    return released;
  }

  /** Nombre de jeux de services en mémoire (tests). */
  get size(): number {
    return this.local ? 1 : this.shops.size;
  }

  /** Mode intégré : jeu de services déjà créé pour cette boutique, sans en créer un (null sinon). */
  peek(domain: string): ShopBundle | null {
    if (this.mode !== "embedded") return null;
    return this.shops.get(domain) ?? null;
  }

  /**
   * Mode intégré, désinstallation ou effacement : libère le jeu de services de la boutique. La prochaine requête
   * identifiée en recrée un, qui relit ses jetons en base.
   */
  release(domain: string): void {
    if (this.mode !== "embedded") return;
    this.shops.delete(domain);
    this.lastUsed.delete(domain);
  }

  /** Jeux de services existants (arrêt du serveur). */
  all(): ShopBundle[] {
    return this.local ? [this.local] : [...this.shops.values()];
  }

  /** Arrêt du serveur : chaque écriture de lot en cours s'arrête après sa ligne. */
  async stopAll(): Promise<void> {
    await Promise.all(this.all().map((b) => b.batches.stopAll()));
  }
}

export interface EmbeddedRegistryOptions {
  store: Store;
  hub: EventHub;
  clientId: string;
  clientSecret: string;
  /** TOKEN_ENCRYPTION_KEY déjà validée (32 octets). */
  encryptionKey: Buffer;
  writesEnabled: boolean;
  chatClient: ChatClient | null;
  model: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  verification?: VerifierOptions;
  sleep?: (ms: number) => Promise<void>;
  /** AI_TOKENS_PER_DAY_MAX : plafond du réglage de jetons d'IA par jour de chaque boutique. */
  aiTokensMax?: number;
}

/**
 * Registre du mode intégré : pour chaque boutique, un `ShopifyService` dont les jetons sont lus et écrits chiffrés
 * dans sa ligne de `shops`. Chaque boutique a sa propre limite d'écritures par minute (créée par son service).
 * Aucune écriture automatique : `autoAllowed` vaut toujours false, quelle que soit SHOPIFY_AUTO_APPLY, et une règle
 * « auto » enregistrée est lue « propose » (refus fermé : aucun lot n'est appliqué sans validation humaine).
 */
export function createEmbeddedRegistry(o: EmbeddedRegistryOptions): ShopifyRegistry {
  const bounds: PolicyBounds = { aiTokensMax: o.aiTokensMax, noAuto: true };
  return ShopifyRegistry.embedded((domain) => {
    const shopify = new ShopifyService(o.store, o.hub, {
      creds: { storeDomain: domain, clientId: o.clientId, clientSecret: o.clientSecret },
      writesEnabled: o.writesEnabled,
      appMode: "embedded",
      fetchImpl: o.fetchImpl,
      now: o.now,
      verification: o.verification,
      tokenStore: dbTokenStore(o.store.db, domain, o.encryptionKey),
    });
    const batches = new BatchService(o.store, o.hub, shopify, { autoAllowed: false, now: o.now, sleep: o.sleep, bounds });
    const optimizer = new Optimizer({ store: o.store, shopify, batches, client: o.chatClient, model: o.model, bounds });
    return { shopify, batches, optimizer };
  }, o.now);
}

/**
 * Mode intégré : toutes les `everyMs`, libère les jeux de services inactifs (voir `releaseIdle`). Minuterie qui ne
 * retient pas le processus ; la fonction rendue l'arrête.
 */
export function startIdleSweep(registry: ShopifyRegistry, busyElsewhere: (domain: string) => boolean, everyMs = 5 * 60_000): () => void {
  if (registry.mode !== "embedded") return () => {};
  const timer = setInterval(() => {
    try {
      registry.releaseIdle(IDLE_RELEASE_MS, busyElsewhere);
    } catch {
      console.warn("[shopify] Libération des services inactifs impossible pour le moment.");
    }
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
