/**
 * Boutique Shopify : connexion, lecture complète (sync), détail en direct, écritures, historique.
 * Voir docs/format-echange.md, section « Boutique Shopify ».
 *
 * Garde-fous des écritures, dans cet ordre :
 * 1. SHOPIFY_WRITES_ENABLED=1, vérifié avant tout appel réseau (`assertWritable`) ;
 * 2. une valeur par demande, jamais d'écriture en lot ;
 * 3. relecture dans Shopify juste avant d'écrire : si la valeur diffère de `expectedBefore` (ou, pour une
 *    annulation, de ce que la modification avait écrit), rien n'est écrit (`shopify_conflict`).
 * Journal avant écriture : la valeur d'avant (exacte) et la valeur demandée sont enregistrées (« pending ») AVANT
 * l'appel. Refus de Shopify : la ligne passe « failed » (hors historique). Accepté : relecture, ligne « applied »
 * avec la valeur relue ; si la relecture échoue, valeur envoyée et afterVerified false, et la réponse reste un succès.
 * Une ligne restée « pending » (arrêt brutal) est montrée non vérifiée, puis tranchée à la prochaine relecture.
 * Titre et description : metafields global.title_tag / global.description_tag pour les quatre types (compareDigest).
 * Texte alternatif : images de produit seulement.
 *
 * Le domaine myshopify.com, les identifiants de l'application et le jeton ne sortent jamais d'ici :
 * ni dans les réponses, ni dans les erreurs, ni dans les journaux.
 */
import type {
  Evidence,
  IssueDetail,
  ShopifyChange,
  ShopifyChangeRequest,
  ShopifyChangeResponse,
  ShopifyChangesResponse,
  ShopifyConnection,
  ShopifyField,
  ShopifyMissingScope,
  ShopifyResourceDetail,
  ShopifyResourcesResponse,
  ShopifyResourceSummary,
  ShopifyResourceType,
  ShopifyState,
  ShopifyTranslation,
} from "../../../shared/api.ts";
import { errors, HttpError } from "../errors.ts";
import type { EventHub } from "../events.ts";
import type { SiteRow, Store } from "../store.ts";
import { ShopifyAuth, ShopifyError, ShopifyWritesDisabledError, type ShopifyCredentials } from "./auth.ts";
import { readAllResources, readerFor, readLocales, readResource, readShopInfo, readTranslations, toResourceInput, type Gql, type LiveImage, type LiveResource, type LiveTranslations } from "./read.ts";
import {
  changeCounts,
  changesFor,
  getChange,
  getResource,
  insertPending,
  latestByField,
  markApplied,
  markFailed,
  pendingFor,
  pathKey,
  productAlias,
  replaceResources,
  resourceIdForPath,
  resourceIdOf,
  resourceIndex,
  resourceRows,
  RESOURCE_TYPES,
  syncedAt,
  toChange,
  updateResource,
  type ChangeRow,
  type ResourceRow,
} from "./repo.ts";
import { ShopifyUserError, writeProductImageAlt, writerFor, writeSeo, writeTranslation, type Mutate } from "./write.ts";

export const CONNECTION_TTL_MS = 60_000;
const ERROR_TTL_MS = 10_000;
export const MAX_LENGTH: Record<ShopifyField, number> = { seo_title: 255, seo_description: 500, image_alt: 512 };
const FIELDS: ShopifyField[] = ["seo_title", "seo_description", "image_alt"];
const TRANSLATION_KEY = { seo_title: "meta_title", seo_description: "meta_description" } as const;

/** Permissions dont le logiciel se sert, et ce que leur absence empêche. */
export const USED_SCOPES: Array<{ scope: string; blocks: string }> = [
  { scope: "read_products", blocks: "Lire les produits et les collections de la boutique" },
  { scope: "write_products", blocks: "Modifier les titres et descriptions pour Google des produits et des collections" },
  { scope: "read_content", blocks: "Lire les pages et les articles de blog de la boutique" },
  { scope: "write_content", blocks: "Modifier les titres et descriptions pour Google des pages et des articles" },
  { scope: "write_files", blocks: "Modifier le texte alternatif des images des produits" },
  { scope: "read_translations", blocks: "Lire les traductions des titres et descriptions pour Google" },
  { scope: "write_translations", blocks: "Modifier les traductions des titres et descriptions pour Google" },
  { scope: "read_locales", blocks: "Connaître les langues publiées de la boutique (nécessaire aux traductions)" },
];

/** Permission accordée ; une permission d'écriture vaut aussi lecture, comme chez Shopify. */
export function hasScope(scopes: string[], scope: string): boolean {
  return scopes.includes(scope) || (scope.startsWith("read_") && scopes.includes("write_" + scope.slice(5)));
}

/** Permission nécessaire pour écrire ce champ sur ce type d'élément. */
export function scopeFor(type: ShopifyResourceType, field: ShopifyField, locale: string | null): string | null {
  if (locale) return "write_translations";
  // Texte alternatif : seulement les images des produits (voir imageAltReadOnly).
  if (field === "image_alt") return type === "product" ? "write_files" : null;
  return type === "product" || type === "collection" ? "write_products" : "write_content";
}

const LANG: Record<string, string> = { fr: "français", en: "anglais", de: "allemand", es: "espagnol", it: "italien", nl: "néerlandais", pt: "portugais" };

/** Pourquoi le texte alternatif n'est pas modifiable sur ce type d'élément ; null pour un produit. */
export function imageAltReadOnly(type: ShopifyResourceType): string | null {
  if (type === "product") return null;
  if (type === "page") return "Une page Shopify n'a pas d'image propre : ses images viennent du thème ou de son texte.";
  const what = type === "collection" ? "d'une collection" : "d'un article";
  return `Le texte alternatif de l'image ${what} ne se modifie pas depuis le logiciel : Shopify peut alors remplacer ou retirer l'image. Modifiez-le dans l'administration Shopify.`;
}

/** Espaces normalisés, pour comparer deux valeurs sans tenir compte des espaces en trop. null et vide sont égaux. */
const collapse = (v: string | null | undefined) => (v ?? "").replace(/\s+/g, " ").trim();
export const sameValue = (a: string | null | undefined, b: string | null | undefined) => collapse(a) === collapse(b);
const orNull = (v: string | null | undefined) => (v && v.trim() ? v : null);

/**
 * Valeur à écrire : seuls les espaces en trop sont retirés (retours à la ligne et tabulations compris).
 * Une valeur qui contient < ou >, un autre caractère de contrôle, ou qui dépasse la longueur maximale
 * (comptée en points de code) est REFUSÉE (shopify_invalid_value), jamais transformée.
 * null ou vide : vider le champ.
 */
export function normalizeValue(raw: unknown, field: ShopifyField): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") throw shopifyErrors.invalidValue("La valeur doit être un texte.", "Saisissez un texte, puis réessayez.");
  const s = raw.replace(/[\t\n\r\f\v \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/g, " ").trim();
  if (!s) return null;
  const what = field === "seo_title" ? "Le titre" : field === "seo_description" ? "La description" : "Le texte alternatif";
  if (/[<>]/.test(s)) throw shopifyErrors.invalidValue(`${what} contient le caractère « < » ou « > », refusé par sécurité.`, "Retirez ces caractères (écrivez par exemple « moins de » ou « plus de »), puis réessayez.");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(s)) throw shopifyErrors.invalidValue(`${what} contient un caractère invisible non autorisé.`, "Retapez le texte sans le copier-coller depuis un autre logiciel, puis réessayez.");
  const max = MAX_LENGTH[field];
  const len = [...s].length;
  if (len > max) throw shopifyErrors.invalidValue(`${what} fait ${len} caractères ; ${max} au plus.`, `Raccourcissez le texte de ${len - max} caractère${len - max > 1 ? "s" : ""}, puis réessayez.`);
  return s;
}

const scrub = (s: string) => s.replace(/[a-z0-9][a-z0-9-]*\.myshopify\.com/gi, "la boutique").replace(/gid:\/\/shopify\/[A-Za-z]+\/\d+/g, "un élément");

// ───────── Erreurs

export const shopifyErrors = {
  notConfigured: () =>
    new HttpError(
      503,
      "shopify_not_configured",
      "Aucune boutique Shopify n'est connectée à ce serveur.",
      "La personne qui gère l'installation peut renseigner SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID et SHOPIFY_CLIENT_SECRET, puis redémarrer le serveur.",
    ),
  otherShop: (shopHost: string | null) =>
    new HttpError(409, "shopify_other_shop", "La boutique Shopify connectée n'est pas celle de ce site.", "Ouvrez le site dont l'adresse est celle de la boutique.", { shopHost }),
  notSynced: () => new HttpError(409, "shopify_not_synced", "La boutique n'a pas encore été lue.", "Lancez une lecture de la boutique, puis réessayez."),
  writesDisabled: () =>
    new HttpError(
      403,
      "shopify_writes_disabled",
      "Les modifications de la boutique ne sont pas activées sur ce serveur.",
      "La personne qui gère l'installation peut les activer avec SHOPIFY_WRITES_ENABLED=1, puis redémarrer le serveur.",
    ),
  missingScope: (scope: string) => {
    const blocks = USED_SCOPES.find((s) => s.scope === scope)?.blocks;
    return new HttpError(
      403,
      "shopify_missing_scope",
      `L'application Shopify n'a pas la permission « ${scope} »${blocks ? ` : impossible de ${blocks.charAt(0).toLowerCase()}${blocks.slice(1)}` : ""}.`,
      "Ajoutez cette permission à l'application dans l'administration Shopify, réinstallez-la, puis réessayez.",
      { scope },
    );
  },
  conflict: (current: string | null) =>
    new HttpError(409, "shopify_conflict", "Cette valeur a changé dans Shopify depuis que vous l'avez affichée. Rien n'a été modifié.", "Relisez la valeur actuelle, puis recommencez.", {
      current,
    }),
  rejected: (message: string) =>
    new HttpError(422, "bad_request", `Shopify a refusé la modification : ${scrub(message)}`, "Corrigez la valeur, puis réessayez. Rien n'a été modifié."),
  invalidValue: (message: string, action: string) => new HttpError(422, "shopify_invalid_value", `${message} Rien n'a été écrit.`, action),
  gone: () => new HttpError(404, "not_found", "Cet élément n'existe plus dans la boutique Shopify.", "Relancez une lecture de la boutique."),
};

/** Traduit une erreur de Shopify en erreur affichable, sans domaine ni identifiant. */
export function fromShopify(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof ShopifyWritesDisabledError) return shopifyErrors.writesDisabled();
  if (err instanceof ShopifyError) {
    const scope = /Required access:\s*`?([a-z_]+)`?/i.exec(err.message)?.[1];
    if (err.code === "graphql" && scope) return shopifyErrors.missingScope(scope);
    const retryable = err.code === "unreachable" || err.code === "throttled";
    const message =
      err.code === "auth_refused"
        ? "Shopify a refusé l'accès de l'application."
        : err.code === "throttled"
          ? "Shopify demande de patienter : trop de demandes en peu de temps."
          : err.code === "unreachable"
            ? "Shopify ne répond pas pour le moment."
            : scrub(err.message);
    return new HttpError(
      502,
      "shopify_unavailable",
      message,
      retryable ? "Réessayez dans un instant." : "Vérifiez que l'application Shopify est installée et a ses permissions, puis réessayez.",
      { retryable },
    );
  }
  console.error("[shopify] erreur inattendue :", err instanceof Error ? scrub(err.message) : "inconnue");
  return errors.internal();
}

// ───────── Service

interface ConnectionInfo {
  name: string | null;
  host: string | null;
  scopes: string[];
  primaryLocale: string | null;
  otherLocales: string[];
}

export interface ShopifyServiceOptions {
  creds: ShopifyCredentials | null;
  writesEnabled: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface ResourceQuery {
  type: ShopifyResourceType | null;
  q: string;
  missing: "seo_title" | "seo_description" | "image_alt" | null;
  offset: number;
  limit: number;
}

export class ShopifyService {
  readonly configured: boolean;
  readonly writesEnabled: boolean;
  private readonly gql: Gql | null;
  private readonly mutate: Mutate | null;
  private readonly now: () => number;
  private cache: { at: number; ok: true; info: ConnectionInfo } | { at: number; ok: false; error: HttpError } | null = null;
  private pendingInfo: Promise<ConnectionInfo> | null = null;
  private locks = new Map<string, Promise<unknown>>();
  private syncing = new Map<string, Promise<ShopifyState>>();
  /** Écritures en cours dans ce processus (lignes « pending » à ne pas réconcilier). */
  private inflight = new Set<string>();

  constructor(
    private store: Store,
    private hub: EventHub,
    opts: ShopifyServiceOptions,
  ) {
    this.configured = !!opts.creds;
    this.writesEnabled = this.configured && opts.writesEnabled === true;
    this.now = opts.now ?? Date.now;
    const fetchImpl = opts.fetchImpl ?? fetch;
    const auth = opts.creds ? new ShopifyAuth(opts.creds, fetchImpl, this.now) : null;
    this.gql = auth ? readerFor(auth, fetchImpl) : null;
    // Le chemin d'écriture n'existe que si les écritures sont activées ; `shopifyMutate` le revérifie.
    this.mutate = auth ? writerFor(auth, this.writesEnabled, fetchImpl) : null;
  }

  // ───── Connexion

  private async info(): Promise<ConnectionInfo> {
    if (!this.gql) throw shopifyErrors.notConfigured();
    const t = this.now();
    if (this.cache && t - this.cache.at < (this.cache.ok ? CONNECTION_TTL_MS : ERROR_TTL_MS)) {
      if (this.cache.ok) return this.cache.info;
      throw this.cache.error;
    }
    this.pendingInfo ??= (async () => {
      try {
        const shop = await readShopInfo(this.gql!);
        let locales = { primary: null as string | null, others: [] as string[] };
        if (hasScope(shop.scopes, "read_locales")) {
          try {
            locales = await readLocales(this.gql!);
          } catch {
            /* langues inconnues : les traductions seront simplement indisponibles */
          }
        }
        const info: ConnectionInfo = { name: shop.name, host: shop.host, scopes: shop.scopes, primaryLocale: locales.primary, otherLocales: locales.others };
        this.cache = { at: this.now(), ok: true, info };
        return info;
      } catch (err) {
        const e = fromShopify(err);
        this.cache = { at: this.now(), ok: false, error: e };
        throw e;
      } finally {
        this.pendingInfo = null;
      }
    })();
    return this.pendingInfo;
  }

  /** Connexion de la boutique de ce site ; lève l'erreur de l'état (non configurée, autre boutique, Shopify injoignable). */
  private async connected(site: SiteRow): Promise<ConnectionInfo> {
    const info = await this.info();
    if (!info.host || info.host !== site.host) throw shopifyErrors.otherShop(info.host);
    return info;
  }

  async connection(site: SiteRow): Promise<ShopifyConnection> {
    const base: ShopifyConnection = {
      state: "not_configured",
      shopName: null,
      shopHost: null,
      scopes: [],
      missingScopes: [],
      writesEnabled: this.writesEnabled,
      primaryLocale: null,
      otherLocales: [],
      error: null,
    };
    if (!this.configured) return base;
    let info: ConnectionInfo;
    try {
      info = await this.info();
    } catch (err) {
      return { ...base, state: "error", error: fromShopify(err).toErrorObject() };
    }
    if (!info.host || info.host !== site.host) return { ...base, state: "other_shop", shopName: info.name, shopHost: info.host };
    return {
      ...base,
      state: "connected",
      shopName: info.name,
      shopHost: info.host,
      scopes: [...info.scopes].sort(),
      missingScopes: missingScopes(info.scopes),
      primaryLocale: info.primaryLocale,
      otherLocales: info.otherLocales,
    };
  }

  async state(site: SiteRow): Promise<ShopifyState> {
    const connection = await this.connection(site);
    return { connection, sync: connection.state === "connected" ? this.syncSummary(site.id) : null };
  }

  private syncSummary(siteId: string): ShopifyState["sync"] {
    const at = syncedAt(this.store.db, siteId);
    if (!at) return null;
    const rows = resourceRows(this.store.db, siteId);
    const counts = Object.fromEntries(RESOURCE_TYPES.map((t) => [t, 0])) as Record<ShopifyResourceType, number>;
    const missing = { seoTitle: 0, seoDescription: 0, imagesWithoutAlt: 0, images: 0 };
    for (const r of rows) {
      counts[r.type]++;
      if (!r.seo_title) missing.seoTitle++;
      if (!r.seo_description) missing.seoDescription++;
      missing.images += r.images;
      missing.imagesWithoutAlt += r.images_without_alt;
    }
    return { syncedAt: at, counts, missing };
  }

  // ───── Lecture complète

  async sync(site: SiteRow): Promise<ShopifyState> {
    if (!this.configured) throw shopifyErrors.notConfigured();
    const running = this.syncing.get(site.id);
    if (running) return running;
    const p = (async () => {
      const info = await this.connected(site);
      for (const scope of ["read_products", "read_content"]) if (!hasScope(info.scopes, scope)) throw shopifyErrors.missingScope(scope);
      let items;
      try {
        items = await readAllResources(this.gql!, { products: true, content: true });
      } catch (err) {
        throw fromShopify(err);
      }
      // Le site a pu être supprimé pendant la lecture.
      if (!this.store.getSite(site.id)) throw errors.siteNotFound();
      replaceResources(this.store.db, site.id, items, new Date(this.now()).toISOString());
      this.hub.emit(site.id, { type: "shopify" });
      return this.state(site);
    })().finally(() => this.syncing.delete(site.id));
    this.syncing.set(site.id, p);
    return p;
  }

  // ───── Rapprochement avec l'analyse affichée

  /** Pages de l'analyse affichée par clé de chemin (recalculé à chaque lecture : jamais une ancienne analyse). */
  private pageIndex(siteId: string): Map<string, { id: string; score: number }> {
    const map = new Map<string, { id: string; score: number }>();
    const audit = this.store.resultsAudit(siteId);
    if (!audit) return map;
    const rows = this.store.pageRows(audit.id);
    for (const r of rows) {
      const k = pathKey(r.path);
      if (!map.has(k)) map.set(k, { id: r.id, score: r.score });
    }
    // Un produit ouvert seulement depuis une collection (/collections/x/products/y) vaut pour /products/y.
    for (const r of rows) {
      const alias = productAlias(pathKey(r.path));
      if (alias && !map.has(alias)) map.set(alias, { id: r.id, score: r.score });
    }
    return map;
  }

  /** Élément de la boutique d'une page analysée (dès qu'il y a correspondance) ; null sans boutique configurée ou lue. */
  resourceIdForPage(siteId: string, path: string): string | null {
    if (!this.configured) return null;
    return resourceIdForPath(resourceIndex(this.store.db, siteId), path);
  }

  /** Permissions connues (dernière vérification réussie), sans appel réseau ; null si inconnues. */
  private knownScopes(): string[] | null {
    return this.cache?.ok ? this.cache.info.scopes : null;
  }

  /** Le champ est-il réellement modifiable sur cet élément (d'après la dernière lecture) ? */
  private fieldEditableOn(r: ResourceRow, field: ShopifyField): boolean {
    const scope = scopeFor(r.type, field, null);
    if (!scope) return false;
    const scopes = this.knownScopes();
    if (scopes && !hasScope(scopes, scope)) return false;
    if (field === "image_alt") return r.images_without_alt > 0;
    return true;
  }

  /**
   * Renseigne Evidence.shopifyResourceId d'un problème, seulement là où le champ `shopifyField` est réellement
   * modifiable sur l'élément (jamais le texte alternatif d'une page, d'une collection ou d'un article ; pour un
   * produit, seulement s'il a au moins une image sans texte alternatif).
   */
  linkIssue(siteId: string, issue: IssueDetail): IssueDetail {
    const field = issue.shopifyField;
    const none = () => ({ ...issue, evidence: issue.evidence.map((e) => ({ ...e, shopifyResourceId: null })) });
    if (!this.configured || !field) return none();
    const rows = resourceRows(this.store.db, siteId);
    if (!rows.length) return none();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const index = resourceIndex(this.store.db, siteId);
    const evidence: Evidence[] = issue.evidence.map((e) => {
      const id = resourceIdForPath(index, e.path);
      const row = id ? byId.get(id) : undefined;
      return { ...e, shopifyResourceId: row && this.fieldEditableOn(row, field) ? row.id : null };
    });
    return { ...issue, evidence };
  }

  private summary(r: ResourceRow, pages: Map<string, { id: string; score: number }>, counts: Map<string, number>): ShopifyResourceSummary {
    const page = pages.get(r.path_key) ?? null;
    return {
      id: r.id,
      type: r.type,
      path: r.path,
      title: r.title,
      seoTitle: r.seo_title,
      seoDescription: r.seo_description,
      images: r.images,
      imagesWithoutAlt: r.images_without_alt,
      pageId: page?.id ?? null,
      pageScore: page?.score ?? null,
      changes: counts.get(r.id) ?? 0,
    };
  }

  /**
   * Garde des routes qui ne lisent que des données stockées : la boutique doit être celle du site. Si Shopify
   * ne répond pas, ces données restent consultables pour un site qui en a déjà (lecture faite ou historique).
   */
  private async connectedOrLocal(site: SiteRow, hasLocal: () => boolean): Promise<void> {
    try {
      await this.connected(site);
    } catch (err) {
      if (err instanceof HttpError && err.code === "shopify_unavailable" && hasLocal()) return;
      throw err;
    }
  }

  async resources(site: SiteRow, q: ResourceQuery): Promise<ShopifyResourcesResponse> {
    if (!this.configured) throw shopifyErrors.notConfigured();
    await this.connectedOrLocal(site, () => !!syncedAt(this.store.db, site.id));
    if (!syncedAt(this.store.db, site.id)) throw shopifyErrors.notSynced();
    const pages = this.pageIndex(site.id);
    const counts = changeCounts(this.store.db, site.host);
    const needle = q.q.trim().toLowerCase();
    let rows = resourceRows(this.store.db, site.id);
    if (q.type) rows = rows.filter((r) => r.type === q.type);
    if (needle) rows = rows.filter((r) => r.title.toLowerCase().includes(needle) || r.path.toLowerCase().includes(needle));
    if (q.missing === "seo_title") rows = rows.filter((r) => !r.seo_title);
    else if (q.missing === "seo_description") rows = rows.filter((r) => !r.seo_description);
    else if (q.missing === "image_alt") rows = rows.filter((r) => r.images_without_alt > 0);
    return { resources: rows.slice(q.offset, q.offset + q.limit).map((r) => this.summary(r, pages, counts)), total: rows.length, offset: q.offset, limit: q.limit };
  }

  /** Nombre d'éléments rapprochés d'une page de l'analyse affichée (pour les vérifications). */
  matchedCount(siteId: string): number {
    const pages = this.pageIndex(siteId);
    return resourceRows(this.store.db, siteId).filter((r) => pages.has(r.path_key)).length;
  }

  // ───── Détail en direct

  private async requireRow(site: SiteRow, id: string): Promise<{ info: ConnectionInfo; row: ResourceRow }> {
    const info = await this.connected(site);
    const row = getResource(this.store.db, site.id, id);
    if (!row) {
      if (!syncedAt(this.store.db, site.id)) throw shopifyErrors.notSynced();
      throw errors.notFound("Cet élément de la boutique");
    }
    return { info, row };
  }

  private async live(row: { type: ShopifyResourceType; gid: string }): Promise<LiveResource> {
    let live: LiveResource | null;
    try {
      live = await readResource(this.gql!, row.type, row.gid);
    } catch (err) {
      throw fromShopify(err);
    }
    if (!live) throw shopifyErrors.gone();
    return live;
  }

  private async translations(info: ConnectionInfo, gid: string, locales = info.otherLocales): Promise<LiveTranslations | null> {
    if (!locales.length || !hasScope(info.scopes, "read_translations")) return null;
    try {
      return await readTranslations(this.gql!, gid, locales);
    } catch (err) {
      throw fromShopify(err);
    }
  }

  async resource(site: SiteRow, id: string): Promise<ShopifyResourceDetail> {
    const { info, row } = await this.requireRow(site, id);
    const live = await this.live(row);
    const tr = await this.translations(info, live.gid);
    this.reconcile(site, live, tr);
    updateResource(this.store.db, site.id, toResourceInput(live));
    return this.detail(site, info, live, tr);
  }

  /**
   * Écritures restées « en attente » (arrêt brutal pendant l'appel à Shopify) : la valeur relue tranche.
   * Valeur demandée en place → appliquée (vérifiée) ; valeur d'avant en place → échec ; autre valeur → reste en attente.
   * Les écritures en cours dans ce processus ne sont jamais touchées.
   */
  private reconcile(site: SiteRow, live: LiveResource, tr: LiveTranslations | null): void {
    for (const c of pendingFor(this.store.db, site.host, resourceIdOf(live.gid))) {
      if (this.inflight.has(c.id)) continue;
      if (c.locale && !tr?.byLocale.has(c.locale)) continue;
      const cur = currentOf(live, tr, { field: c.field, imageId: c.image_id, locale: c.locale });
      if (c.field === "image_alt" && !cur.image) continue;
      try {
        if (sameValue(cur.value, c.requested_value)) markApplied(this.store.db, c.id, cur.value, true, c.applied_at);
        else if (sameValue(cur.value, c.before_value)) markFailed(this.store.db, c.id);
      } catch {
        /* sans effet : la ligne reste en attente, visible */
      }
    }
  }

  private detail(site: SiteRow, info: ConnectionInfo, live: LiveResource, tr: LiveTranslations | null): ShopifyResourceDetail {
    const id = resourceIdOf(live.gid);
    const pages = this.pageIndex(site.id);
    const page = pages.get(pathKey(live.path)) ?? null;
    const history = changesFor(this.store.db, site.host, id);
    const latest = latestByField(this.store.db, site.host, id);
    const reasons: ShopifyResourceDetail["readOnlyReasons"] = {};
    const tooLong = "La valeur actuelle dépasse 5 000 caractères : elle ne peut pas être lue en entier, et l'annuler ne serait pas fidèle. Modifiez-la dans l'administration Shopify.";
    for (const field of ["seo_title", "seo_description"] as const) {
      const scope = scopeFor(live.type, field, null)!;
      const m = field === "seo_title" ? live.meta.title : live.meta.description;
      if (!hasScope(info.scopes, scope)) reasons[field] = `L'application Shopify n'a pas la permission « ${scope} ».`;
      else if (m && !m.complete) reasons[field] = tooLong;
    }
    const altScope = scopeFor(live.type, "image_alt", null);
    const altType = imageAltReadOnly(live.type);
    if (altType) reasons.image_alt = altType;
    else if (!live.imageList.length) reasons.image_alt = "Cet élément n'a pas d'image.";
    else if (altScope && !hasScope(info.scopes, altScope)) reasons.image_alt = `L'application Shopify n'a pas la permission « ${altScope} ».`;
    if (!info.otherLocales.length) reasons.translations = "La boutique n'a pas d'autre langue publiée.";
    else if (!hasScope(info.scopes, "read_translations")) reasons.translations = "L'application Shopify n'a pas la permission « read_translations ».";
    else if (!hasScope(info.scopes, "write_translations")) reasons.translations = "L'application Shopify n'a pas la permission « write_translations ».";
    return {
      id,
      type: live.type,
      path: live.path,
      title: live.title,
      seoTitle: live.seoTitle,
      seoDescription: live.seoDescription,
      images: live.images,
      imagesWithoutAlt: live.imagesWithoutAlt,
      pageId: page?.id ?? null,
      pageScore: page?.score ?? null,
      changes: history.length,
      imageList: live.imageList.map((i) => ({ id: i.id, url: i.url, alt: i.alt })),
      translations: this.translationList(info, live, tr),
      history: history.map((c) => toChange(c, latest)),
      editable: {
        seo_title: !reasons.seo_title,
        seo_description: !reasons.seo_description,
        image_alt: !reasons.image_alt,
        translations: !reasons.translations,
      },
      readOnlyReasons: reasons,
    };
  }

  private translationList(info: ConnectionInfo, live: LiveResource, tr: LiveTranslations | null): ShopifyTranslation[] {
    const out: ShopifyTranslation[] = [];
    const lang = info.primaryLocale && LANG[info.primaryLocale] ? `en ${LANG[info.primaryLocale]}` : "dans la langue principale";
    const canRead = hasScope(info.scopes, "read_translations");
    const canWrite = hasScope(info.scopes, "write_translations");
    for (const locale of info.otherLocales) {
      for (const field of ["seo_title", "seo_description"] as const) {
        const key = TRANSLATION_KEY[field];
        const primary = field === "seo_title" ? live.seoTitle : live.seoDescription;
        const content = tr?.content.get(key);
        const t = tr?.byLocale.get(locale)?.get(key);
        const empty =
          field === "seo_title" ? `Le titre pour Google est vide ${lang} : renseignez-le d'abord.` : `La description pour Google est vide ${lang} : renseignez-la d'abord.`;
        let reason: string | null = null;
        if (!canRead) reason = "L'application Shopify n'a pas la permission de lire les traductions (read_translations).";
        else if (!canWrite) reason = "L'application Shopify n'a pas la permission de modifier les traductions (write_translations).";
        else if (!content && !orNull(primary)) reason = empty;
        else if (!content) reason = "Shopify ne propose pas la traduction de ce champ pour cet élément.";
        else if (t && !t.complete) reason = "La traduction actuelle dépasse 5 000 caractères : elle ne peut pas être lue en entier. Modifiez-la dans l'administration Shopify.";
        out.push({ locale, field, value: t?.value ?? null, outdated: t?.outdated ?? false, editable: reason === null, reason });
      }
    }
    return out;
  }

  // ───── Écritures

  /** Garde-fou sans appel réseau : boutique configurée. */
  assertConfigured(): void {
    if (!this.configured) throw shopifyErrors.notConfigured();
  }

  /** Garde-fous sans appel réseau : boutique configurée, écritures activées. À appeler en premier. */
  assertWritable(): void {
    if (!this.configured) throw shopifyErrors.notConfigured();
    if (!this.writesEnabled || !this.mutate) throw shopifyErrors.writesDisabled();
  }

  /** Une écriture à la fois par site : la relecture, l'écriture et l'enregistrement ne s'entremêlent pas. */
  private async exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    const tail = run.catch(() => undefined);
    this.locks.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  async change(site: SiteRow, body: Partial<ShopifyChangeRequest>): Promise<ShopifyChangeResponse> {
    this.assertWritable();
    const req = parseChange(body);
    const { info, row } = await this.requireRow(site, req.resourceId);
    return this.apply(site, info, {
      type: row.type,
      gid: row.gid,
      field: req.field,
      imageId: req.imageId,
      locale: req.locale,
      value: req.value,
      expected: req.expectedBefore,
      restores: null,
    });
  }

  async restore(site: SiteRow, changeId: string): Promise<ShopifyChangeResponse> {
    this.assertWritable();
    const info = await this.connected(site);
    const c = getChange(this.store.db, changeId);
    if (!c || c.site_host !== site.host || c.status === "failed") throw errors.notFound("Cette modification");
    if (c.restored_by_change_id) throw errors.badRequest("Cette modification a déjà été annulée.", null);
    const latest = latestByField(this.store.db, site.host, c.resource_id);
    const view = toChange(c, latest);
    if (!view.restorable) {
      throw errors.badRequest("Seule la dernière modification d'un champ peut être annulée.", "Annulez d'abord la modification la plus récente de ce champ.");
    }
    return this.apply(site, info, {
      type: c.resource_type,
      gid: c.resource_gid,
      field: c.field,
      imageId: c.image_id,
      locale: c.locale,
      // La valeur d'avant exacte, telle que lue avant la modification (pas de nouvelle validation : c'était la valeur de la boutique).
      value: c.before_value,
      expected: view.after,
      restores: c,
    });
  }

  private async apply(
    site: SiteRow,
    info: ConnectionInfo,
    w: { type: ShopifyResourceType; gid: string; field: ShopifyField; imageId: string | null; locale: string | null; value: string | null; expected: string | null; restores: ChangeRow | null },
  ): Promise<ShopifyChangeResponse> {
    if (w.locale && !info.otherLocales.includes(w.locale)) {
      throw errors.badRequest(`La langue « ${w.locale.slice(0, 20)} » n'est pas publiée dans la boutique.`, info.otherLocales.length ? `Langues disponibles : ${info.otherLocales.join(", ")}.` : null);
    }
    // Texte alternatif d'une collection, d'un article ou d'une page : refusé avant tout appel d'écriture.
    if (!w.locale && w.field === "image_alt" && imageAltReadOnly(w.type)) throw errors.badRequest(imageAltReadOnly(w.type)!, null);
    const scope = scopeFor(w.type, w.field, w.locale);
    if (!scope) throw errors.badRequest("Ce champ n'existe pas pour ce type d'élément.", null);
    if (!hasScope(info.scopes, scope)) throw shopifyErrors.missingScope(scope);
    if (w.locale && !hasScope(info.scopes, "read_translations")) throw shopifyErrors.missingScope("read_translations");

    return this.exclusive(`${site.id}`, async () => {
      // Relecture juste avant d'écrire.
      const read = async () => {
        const live = await this.live(w);
        const tr = w.locale ? await this.translations(info, live.gid, [w.locale]) : null;
        return { live, tr, cur: currentOf(live, tr, w) };
      };
      const before = await read();
      this.reconcile(site, before.live, before.tr);
      const { live } = before;
      if (w.field === "image_alt" && !before.cur.image) throw errors.notFound("Cette image");
      if (!before.cur.complete) {
        throw errors.badRequest("La valeur actuelle est trop longue pour être lue en entier : la modifier ici empêcherait de la remettre à l'identique.", "Modifiez-la dans l'administration Shopify.");
      }
      if (!sameValue(before.cur.value, w.expected)) throw shopifyErrors.conflict(before.cur.value);
      if (sameValue(before.cur.value, w.value)) {
        throw errors.badRequest("Cette valeur est déjà en place dans Shopify. Rien n'a été modifié.", null);
      }
      if (w.locale && w.value !== null && !before.cur.digest) {
        throw errors.badRequest("Shopify ne permet pas de traduire ce champ ici : le texte d'origine est vide.", "Renseignez d'abord ce champ dans la langue principale.");
      }

      // Journal avant écriture : la valeur d'avant (exacte) et la valeur demandée sont enregistrées AVANT l'appel.
      const pending = insertPending(this.store.db, {
        site_host: site.host,
        resource_id: resourceIdOf(live.gid),
        resource_gid: live.gid,
        resource_type: w.type,
        resource_title: live.title,
        path: live.path,
        field: w.field,
        image_id: w.field === "image_alt" ? before.cur.image!.id : null,
        image_gid: w.field === "image_alt" ? before.cur.image!.gid : null,
        image_url: w.field === "image_alt" ? before.cur.image!.url : null,
        locale: w.locale,
        before_value: before.cur.value,
        requested_value: w.value,
        applied_at: new Date(this.now()).toISOString(),
        kind: w.restores ? "restore" : "edit",
        restores_change_id: w.restores?.id ?? null,
      });
      this.inflight.add(pending.id);
      try {
        let verified: Awaited<ReturnType<typeof read>> | null = null;
        try {
          if (w.locale) await writeTranslation(this.mutate!, live.gid, TRANSLATION_KEY[w.field as "seo_title" | "seo_description"], w.locale, w.value, before.cur.digest ?? "");
          else if (w.field === "image_alt") await writeProductImageAlt(this.mutate!, before.cur.image!, w.value);
          else await writeSeo(this.mutate!, live.gid, w.field, w.value, w.field === "seo_title" ? live.meta.title : live.meta.description);
        } catch (err) {
          if (err instanceof ShopifyUserError) {
            markFailed(this.store.db, pending.id);
            if (err.stale) {
              const now = await read().catch(() => null);
              throw shopifyErrors.conflict(now?.cur.value ?? null);
            }
            throw shopifyErrors.rejected(err.message);
          }
          if (err instanceof ShopifyError && err.code === "unreachable") {
            // Réponse perdue : la relecture dit si l'écriture a eu lieu.
            const now = await read().catch(() => null);
            if (now && sameValue(now.cur.value, w.value)) verified = now;
            else {
              // Relecture impossible : l'issue est inconnue, la ligne reste « en attente » (visible, non vérifiée).
              if (now) markFailed(this.store.db, pending.id);
              throw fromShopify(err);
            }
          } else {
            markFailed(this.store.db, pending.id);
            throw fromShopify(err);
          }
        }

        // Shopify a accepté. Désormais la réponse est un succès, même si la relecture ou l'enregistrement échoue.
        if (!verified) verified = await read().catch(() => null);
        const at = new Date(this.now()).toISOString();
        let row: ChangeRow = pending;
        try {
          row = verified ? markApplied(this.store.db, pending.id, verified.cur.value, true, at) : markApplied(this.store.db, pending.id, w.value, false, at);
        } catch (err) {
          console.error("[shopify] modification acceptée par Shopify mais non finalisée dans le journal :", err instanceof Error ? scrub(err.message) : "erreur");
        }
        if (verified) {
          try {
            updateResource(this.store.db, site.id, toResourceInput(verified.live));
          } catch {
            /* le résumé sera mis à jour à la prochaine lecture */
          }
        }
        this.hub.emit(site.id, { type: "shopify" });
        const shown = verified ?? { live: patched(before.live, w), tr: patchedTr(before.tr, w) };
        const tr = verified ? await this.translations(info, verified.live.gid).catch(() => verified!.tr) : shown.tr;
        const resource = this.detail(site, info, shown.live, tr);
        const latest = latestByField(this.store.db, site.host, row.resource_id);
        return { change: toChange(getChange(this.store.db, pending.id) ?? row, latest), resource };
      } finally {
        this.inflight.delete(pending.id);
      }
    });
  }

  // ───── Historique

  async changes(site: SiteRow, offset: number, limit: number): Promise<ShopifyChangesResponse> {
    if (!this.configured) throw shopifyErrors.notConfigured();
    await this.connectedOrLocal(site, () => !!syncedAt(this.store.db, site.id) || changesFor(this.store.db, site.host).length > 0);
    const all = changesFor(this.store.db, site.host);
    const latest = latestByField(this.store.db, site.host);
    const changes: ShopifyChange[] = all.slice(offset, offset + limit).map((c) => toChange(c, latest));
    return { changes, total: all.length, offset, limit };
  }

  /** Données stockées pour l'outil de l'assistant (aucun appel à Shopify). null sans lecture. */
  storedOverview(site: SiteRow): { syncedAt: string; rows: ShopifyResourceSummary[] } | null {
    if (!this.configured) return null;
    const at = syncedAt(this.store.db, site.id);
    if (!at) return null;
    const pages = this.pageIndex(site.id);
    const counts = changeCounts(this.store.db, site.host);
    return { syncedAt: at, rows: resourceRows(this.store.db, site.id).map((r) => this.summary(r, pages, counts)) };
  }
}

export function missingScopes(scopes: string[]): ShopifyMissingScope[] {
  return USED_SCOPES.filter((s) => !hasScope(scopes, s.scope)).map((s) => ({ scope: s.scope, blocks: s.blocks }));
}

/** Valeur actuelle (exacte) du champ visé, relue dans Shopify. */
function currentOf(
  live: LiveResource,
  tr: LiveTranslations | null,
  w: { field: ShopifyField; imageId: string | null; locale: string | null },
): { value: string | null; complete: boolean; image: LiveImage | null; digest: string | null } {
  if (w.locale) {
    const key = TRANSLATION_KEY[w.field as "seo_title" | "seo_description"];
    const t = tr?.byLocale.get(w.locale)?.get(key);
    return { value: t?.value ?? null, complete: t?.complete ?? true, image: null, digest: tr?.content.get(key)?.digest ?? null };
  }
  if (w.field === "image_alt") {
    const image = live.imageList.find((i) => i.id === w.imageId) ?? null;
    return { value: image?.alt ?? null, complete: image?.complete ?? true, image, digest: null };
  }
  const m = w.field === "seo_title" ? live.meta.title : live.meta.description;
  return { value: m?.value ?? null, complete: m?.complete ?? true, image: null, digest: null };
}

/** Élément tel qu'il doit être après une écriture acceptée dont la relecture a échoué (valeur envoyée). */
function patched(live: LiveResource, w: { field: ShopifyField; imageId: string | null; locale: string | null; value: string | null }): LiveResource {
  if (w.locale) return live;
  if (w.field === "seo_title") return { ...live, seoTitle: w.value };
  if (w.field === "seo_description") return { ...live, seoDescription: w.value };
  return { ...live, imageList: live.imageList.map((i) => (i.id === w.imageId ? { ...i, alt: w.value } : i)) };
}

function patchedTr(tr: LiveTranslations | null, w: { field: ShopifyField; locale: string | null; value: string | null }): LiveTranslations | null {
  if (!tr || !w.locale) return tr;
  const key = TRANSLATION_KEY[w.field as "seo_title" | "seo_description"];
  const byLocale = new Map(tr.byLocale);
  const map = new Map(byLocale.get(w.locale) ?? []);
  map.set(key, { value: w.value, complete: true, outdated: false });
  byLocale.set(w.locale, map);
  return { content: tr.content, byLocale };
}

const LOCALE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;

function parseChange(b: Partial<ShopifyChangeRequest>): {
  resourceId: string;
  field: ShopifyField;
  imageId: string | null;
  locale: string | null;
  value: string | null;
  expectedBefore: string | null;
} {
  const resourceId = typeof b.resourceId === "string" ? b.resourceId.trim() : "";
  if (!/^shr_[a-z0-9]{6,40}$/.test(resourceId)) throw errors.badRequest("L'élément à modifier n'est pas indiqué.", "Choisissez un élément de la boutique, puis réessayez.");
  const field = b.field as ShopifyField;
  if (!FIELDS.includes(field)) throw errors.badRequest("Ce champ ne peut pas être modifié.", "Champs possibles : seo_title, seo_description, image_alt.");
  const locale = b.locale === undefined || b.locale === null || b.locale === "" ? null : b.locale;
  if (locale !== null && (typeof locale !== "string" || !LOCALE_RE.test(locale))) throw errors.badRequest("Cette langue n'est pas valide.", null);
  if (locale && field === "image_alt") throw errors.badRequest("Le texte alternatif d'une image ne se traduit pas ici.", null);
  let imageId: string | null = null;
  if (field === "image_alt") {
    if (typeof b.imageId !== "string" || !/^img_[a-z0-9]{6,40}$/.test(b.imageId)) throw errors.badRequest("L'image à modifier n'est pas indiquée.", "Choisissez une image, puis réessayez.");
    imageId = b.imageId;
  }
  if (!("value" in b)) throw errors.badRequest("La nouvelle valeur manque.", null);
  if (!("expectedBefore" in b)) throw errors.badRequest("La valeur actuelle affichée (expectedBefore) manque.", "Rechargez l'élément, puis réessayez.");
  if (b.expectedBefore !== null && typeof b.expectedBefore !== "string") throw errors.badRequest("La valeur actuelle affichée (expectedBefore) doit être un texte ou null.", null);
  return { resourceId, field, imageId, locale, value: normalizeValue(b.value, field), expectedBefore: b.expectedBefore ?? null };
}
