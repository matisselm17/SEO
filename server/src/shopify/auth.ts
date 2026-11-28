/**
 * Connexion à la boutique Shopify. Deux stratégies, fixées au démarrage (SHOPIFY_APP_MODE) :
 *
 * - `local` : « Client Credentials Grant ». Shopify délivre un jeton valable 24 heures, renouvelé tout seul
 *   avant chaque appel s'il expire dans moins de `RENEW_MARGIN_MS`, et après un refus 401 (une fois).
 * - `embedded` : « Token Exchange ». Le jeton de session d'une requête identifiée est échangé contre un jeton
 *   hors ligne à expiration (1 h) et son jeton de renouvellement (90 jours) ; le jeton d'accès est ensuite
 *   renouvelé par `grant_type=refresh_token` (docs/format-echange.md, « Application intégrée à Shopify »).
 *
 * Mode local : les jetons restent en mémoire. Mode intégré : le couple de jetons est aussi lu et écrit par un
 * magasin injecté (`TokenStore`, chiffré en base en production) ; le nouveau couple est enregistré avant d'être
 * utilisé. Jamais dans les journaux. Une seule demande de jeton part à la fois : les appels simultanés attendent la
 * même réponse.
 *
 * L'identifiant et le secret de l'application ne quittent jamais ce fichier : aucun message
 * d'erreur ne les contient, ni le jeton.
 */

export interface ShopifyCredentials {
  /** Domaine `xxx.myshopify.com`, déjà validé par `parseShopDomain`. */
  storeDomain: string;
  clientId: string;
  clientSecret: string;
}

/** Version de l'API d'administration utilisée par les appels GraphQL. */
export const SHOPIFY_API_VERSION = "2026-07";
/** Le jeton est renouvelé quand il lui reste moins que cette marge. */
export const RENEW_MARGIN_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * - `session_rejected` : Shopify a refusé le jeton de session à l'échange (400 : jeton périmé) ; mode intégré.
 * - `no_session` : mode intégré, aucun jeton d'accès ni jeton de renouvellement utilisable, et aucune requête
 *   identifiée pour en obtenir (tâche de fond après un redémarrage, jeton de renouvellement refusé).
 */
export type ShopifyErrorCode = "auth_refused" | "unreachable" | "bad_response" | "graphql" | "throttled" | "session_rejected" | "no_session";

export class ShopifyError extends Error {
  readonly code: ShopifyErrorCode;
  readonly status: number | null;
  /**
   * Renouvellement refusé définitivement (docs/format-echange.md, « Effacement d'une boutique ») : refus `401` dont le
   * code est `invalid_request`, pour le jeton de renouvellement qui était encore celui enregistré en base au moment de
   * conclure. Seule preuve de désinstallation venue de Shopify.
   */
  readonly revoked: boolean;
  constructor(code: ShopifyErrorCode, message: string, status: number | null = null, revoked = false) {
    super(message);
    this.name = "ShopifyError";
    this.code = code;
    this.status = status;
    this.revoked = revoked;
  }
}

/**
 * Valide le domaine saisi dans `.env`. Seul un domaine `*.myshopify.com` est accepté :
 * le secret de l'application n'est donc jamais envoyé ailleurs que chez Shopify.
 */
export function parseShopDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const host = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return /^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/.test(host) ? host : null;
}

export interface TokenInfo {
  /** Permissions accordées à l'application, telles qu'annoncées avec le jeton. */
  scopes: string[];
  expiresAt: Date;
}

export type ShopifyAppMode = "local" | "embedded";

/** Couple de jetons du mode intégré (dates en millisecondes depuis l'époque). */
export interface TokenPair {
  access: { value: string; expiresAt: number; scopes: string[] };
  refresh: { value: string; expiresAt: number };
}

/**
 * Magasin du couple de jetons d'une boutique (mode intégré). `load` renvoie null pour une absence comme pour une
 * valeur illisible ; `save` et `clear` sont synchrones (SQLite) et lèvent si l'écriture échoue.
 */
export interface TokenStore {
  load(): TokenPair | null;
  save(pair: TokenPair): void;
  clear(): void;
}

export interface ShopifyAuthOptions {
  /** Stratégie d'obtention du jeton ; `local` par défaut. */
  mode?: ShopifyAppMode;
  /** Mode intégré : magasin du couple de jetons (relu à la création, écrit à chaque nouveau couple). */
  tokenStore?: TokenStore;
}

const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const ID_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:id_token";
const OFFLINE_TOKEN_TYPE = "urn:shopify:params:oauth:token-type:offline-access-token";

/** Erreur des tâches sans requête identifiée en mode intégré. */
export const noSessionError = () => new ShopifyError("no_session", "Aucun accès à la boutique tant que l'application n'a pas été ouverte depuis l'administration Shopify.");

/** Répit après un échange échoué pour une autre raison qu'un jeton de session périmé. */
export const EXCHANGE_BACKOFF_MS = 30_000;

export class ShopifyAuth {
  private token: { value: string; expiresAt: number; scopes: string[] } | null = null;
  /** Mode intégré : jeton de renouvellement et sa date d'expiration. */
  private refresh: { value: string; expiresAt: number } | null = null;
  /** Demande de jeton en cours (une seule à la fois, toutes stratégies confondues). */
  private pending: Promise<void> | null = null;
  private exchangeBlockedUntil = 0;
  /**
   * Génération des jetons : augmentée par `forget()` (désinstallation). Une réponse de Shopify à une demande de jeton
   * partie sous une génération antérieure n'est jamais enregistrée.
   */
  private generation = 0;
  private savedPairs = 0;
  /**
   * Vérifications d'installation en cours (`verifying`) : pendant ce temps, un refus du renouvellement qui n'est pas
   * définitif ne fait pas oublier les jetons (la vérification se conclut « réponse non claire » et sera reposée). Les
   * requêtes des marchands gardent le comportement ordinaire : un refus oublie les jetons.
   */
  private verifications = 0;
  private readonly creds: ShopifyCredentials;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly tokenStore: TokenStore | null;
  readonly mode: ShopifyAppMode;

  constructor(creds: ShopifyCredentials, fetchImpl: typeof fetch = fetch, now: () => number = Date.now, opts: ShopifyAuthOptions = {}) {
    if (!parseShopDomain(creds.storeDomain)) throw new ShopifyError("bad_response", "Domaine Shopify invalide : attendu « ma-boutique.myshopify.com ».");
    this.creds = { ...creds, storeDomain: parseShopDomain(creds.storeDomain)! };
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.mode = opts.mode ?? "local";
    this.tokenStore = this.mode === "embedded" ? (opts.tokenStore ?? null) : null;
    // Après un redémarrage : le couple enregistré resservira sans nouvel échange (illisible : comme absent).
    const stored = this.tokenStore ? safeLoad(this.tokenStore) : null;
    if (stored) {
      this.token = { value: stored.access.value, expiresAt: stored.access.expiresAt, scopes: [...stored.access.scopes] };
      this.refresh = { value: stored.refresh.value, expiresAt: stored.refresh.expiresAt };
    }
  }

  /** Nombre de couples de jetons enregistrés par cet objet (un renouvellement réussi l'augmente). */
  get pairsSaved(): number {
    return this.savedPairs;
  }

  get storeDomain(): string {
    return this.creds.storeDomain;
  }

  /** Jeton valide : celui en mémoire s'il lui reste assez de temps, sinon un nouveau. */
  async getToken(): Promise<string> {
    if (this.accessValid()) return this.token!.value;
    if (this.mode === "local") {
      await this.single(() => this.requestClientCredentials());
      if (this.token) return this.token.value;
      throw new ShopifyError("bad_response", "Réponse inattendue de Shopify à la demande de jeton.");
    }
    // Mode intégré : attendre une demande déjà en cours (échange ou renouvellement), puis renouveler si besoin.
    if (this.pending) {
      await this.pending.catch(() => undefined);
      if (this.accessValid()) return this.token!.value;
    }
    if (this.refreshUsable()) {
      try {
        await this.single(() => this.requestRefresh());
      } catch (err) {
        // Tant que le jeton d'accès n'a pas expiré, il sert encore (un refus définitif l'a déjà effacé).
        if (this.token && this.token.expiresAt > this.now()) return this.token.value;
        throw err;
      }
      if (this.accessValid()) return this.token!.value;
    }
    throw noSessionError();
  }

  /**
   * Mode intégré, après une vérification réussie du jeton de session : s'il n'y a ni jeton d'accès valide ni jeton
   * de renouvellement utilisable, échange le jeton de session. Renvoie true si un échange a abouti.
   * Lève `session_rejected` si Shopify répond 400 (jeton périmé) ; les autres échecs sont levés aussi, l'appelant
   * décide (la requête continue sans jeton).
   */
  async ensureSession(sessionToken: string): Promise<boolean> {
    if (this.mode !== "embedded") return false;
    if (this.accessValid() || this.refreshUsable()) return false;
    if (this.pending) {
      let failure: unknown = null;
      await this.pending.catch((err) => {
        failure = err;
      });
      if (this.accessValid() || this.refreshUsable()) return false;
      // L'échange d'une autre requête a échoué : on ne recommence que si son jeton de session a été refusé
      // (le nôtre est peut-être plus récent). Un échec passager vaut pour toutes les requêtes en attente.
      // Un renouvellement refusé définitivement (`no_session`) se répare aussi par un échange avec notre jeton.
      if (failure && !(failure instanceof ShopifyError && (failure.code === "session_rejected" || failure.code === "no_session"))) throw failure;
    }
    // Après un échec qui ne vient pas du jeton de session (Shopify indisponible ou refus de l'application), pas de
    // nouvel échange pendant un moment : les requêtes ne font pas la queue derrière Shopify et ne le sollicitent pas.
    if (this.now() < this.exchangeBlockedUntil) return false;
    try {
      await this.single(() => this.requestExchange(sessionToken));
    } catch (err) {
      // Pas de répit pour une réponse écartée parce qu'une désinstallation est survenue pendant l'échange (`no_session`).
      if (!(err instanceof ShopifyError && (err.code === "session_rejected" || err.code === "no_session"))) this.exchangeBlockedUntil = this.now() + EXCHANGE_BACKOFF_MS;
      throw err;
    }
    this.exchangeBlockedUntil = 0;
    return true;
  }

  /**
   * Oublie le jeton d'accès en mémoire ; le prochain appel en demandera un neuf (en mode intégré, par le jeton de
   * renouvellement, qui est gardé). Sans effet si `stale` n'est plus le jeton courant.
   */
  invalidate(stale?: string): void {
    if (!stale || this.token?.value === stale) this.token = null;
  }

  /** Désinstallation (mode intégré) : oublie les deux jetons, en mémoire et dans le magasin. */
  forget(): void {
    this.generation++;
    this.forgetPair();
  }

  /** Une demande de jeton (échange ou renouvellement) est-elle en cours ? Le jeu de services n'est pas libéré pendant ce temps. */
  busy(): boolean {
    return this.pending !== null;
  }

  /** Vérification d'installation (effacement, avis de désinstallation) : voir `verifications`. */
  async verifying<T>(fn: () => Promise<T>): Promise<T> {
    this.verifications++;
    try {
      return await fn();
    } finally {
      this.verifications--;
    }
  }

  /** Mode intégré : un couple de jetons est-il connu (en mémoire) ? */
  hasTokens(): boolean {
    return !!this.token || !!this.refresh;
  }

  /** État du jeton courant, sans sa valeur. null tant qu'aucun jeton n'a été obtenu. */
  info(): TokenInfo | null {
    return this.token ? { scopes: [...this.token.scopes], expiresAt: new Date(this.token.expiresAt) } : null;
  }

  private accessValid(): boolean {
    return !!this.token && this.token.expiresAt - RENEW_MARGIN_MS > this.now();
  }

  private refreshUsable(): boolean {
    return !!this.refresh && this.refresh.expiresAt - RENEW_MARGIN_MS > this.now();
  }

  /** Une seule demande à la fois : les appels simultanés attendent la même réponse. */
  private single(fn: () => Promise<void>): Promise<void> {
    this.pending ??= fn().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async post(params: Record<string, string>, what: string): Promise<Response> {
    try {
      return await this.fetchImpl(`https://${this.creds.storeDomain}/admin/oauth/access_token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams(params).toString(),
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new ShopifyError("unreachable", `Shopify n'a pas répondu à la demande ${what}.`);
    }
  }

  /** Corps JSON d'une réponse de jeton. Celui d'un refus n'est lu que pour son code d'erreur : jamais journalisé ni recopié. */
  private async body(res: Response): Promise<Record<string, unknown>> {
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  }

  /** Mode intégré : enregistre un couple jeton d'accès / jeton de renouvellement reçu de Shopify. */
  private keepPair(o: Record<string, unknown>, generation: number): void {
    // Demande partie avant une désinstallation : la réponse n'est ni enregistrée ni gardée.
    if (generation !== this.generation) throw noSessionError();
    const value = typeof o.access_token === "string" ? o.access_token : "";
    const expiresIn = typeof o.expires_in === "number" && o.expires_in > 0 ? o.expires_in : 0;
    const refresh = typeof o.refresh_token === "string" ? o.refresh_token : "";
    const refreshIn = typeof o.refresh_token_expires_in === "number" && o.refresh_token_expires_in > 0 ? o.refresh_token_expires_in : 0;
    if (!value || !expiresIn || !refresh || !refreshIn) throw new ShopifyError("bad_response", "Réponse inattendue de Shopify à la demande de jeton.");
    const scopes = typeof o.scope === "string" ? o.scope.split(",").map((s) => s.trim()).filter(Boolean) : [];
    const t = this.now();
    const pair: TokenPair = { access: { value, expiresAt: t + expiresIn * 1000, scopes }, refresh: { value: refresh, expiresAt: t + refreshIn * 1000 } };
    // Enregistré avant d'être utilisé : un couple qui n'a pas pu être enregistré ne sert pas (l'ancien jeton de
    // renouvellement a pu être invalidé par Shopify ; on le dit par une erreur passagère, sans valeur).
    if (this.tokenStore) {
      try {
        this.tokenStore.save(pair);
      } catch {
        throw new ShopifyError("unreachable", "Le jeton de la boutique n'a pas pu être enregistré.");
      }
    }
    this.savedPairs++;
    this.token = { ...pair.access, scopes: [...scopes] };
    this.refresh = { ...pair.refresh };
  }

  /** Oublie les deux jetons, en mémoire et dans le magasin. */
  private forgetPair(): void {
    this.refresh = null;
    this.token = null;
    try {
      this.tokenStore?.clear();
    } catch {
      console.warn("[shopify] Les jetons refusés n'ont pas pu être effacés de la base.");
    }
  }

  private async requestExchange(sessionToken: string): Promise<void> {
    const { clientId, clientSecret } = this.creds;
    const generation = this.generation;
    const res = await this.post(
      {
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: TOKEN_EXCHANGE_GRANT,
        subject_token: sessionToken,
        subject_token_type: ID_TOKEN_TYPE,
        requested_token_type: OFFLINE_TOKEN_TYPE,
        expiring: "1",
      },
      "d'échange du jeton de session",
    );
    if (res.status === 400) throw new ShopifyError("session_rejected", "Shopify a refusé le jeton de session (400).", 400);
    if (res.status === 401 || res.status === 403) throw new ShopifyError("auth_refused", `Shopify a refusé l'échange du jeton de session (${res.status}).`, res.status);
    if (!res.ok) throw new ShopifyError("unreachable", `Shopify a répondu ${res.status} à l'échange du jeton de session.`, res.status);
    const body = await this.body(res);
    this.keepPair(body, generation);
  }

  private async requestRefresh(): Promise<void> {
    const refresh = this.refresh;
    if (!refresh) throw noSessionError();
    const { clientId, clientSecret } = this.creds;
    const generation = this.generation;
    const res = await this.post({ client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: refresh.value }, "de renouvellement du jeton");
    if (res.status === 429 || res.status >= 500) throw new ShopifyError("unreachable", `Shopify a répondu ${res.status} au renouvellement du jeton.`, res.status);
    if (!res.ok) {
      // Le corps n'est lu que pour son code d'erreur : jamais journalisé ni recopié.
      let revoked = false;
      if (res.status === 401) {
        const o = await this.body(res);
        if (o.error === "invalid_request" && generation === this.generation) {
          // Conclu ici, sans attente : le jeton refusé doit être celui qui est encore enregistré en base.
          const stored = this.tokenStore ? safeLoad(this.tokenStore) : null;
          revoked = !!stored && stored.refresh.value === refresh.value;
        }
      } else {
        void res.body?.cancel().catch(() => undefined);
      }
      // Refus : les deux jetons sont oubliés ; le prochain échange se fera à la prochaine requête identifiée. Pendant
      // une vérification d'installation, seul un refus définitif les fait oublier.
      if (this.refresh === refresh && (revoked || this.verifications === 0)) this.forgetPair();
      const err = noSessionError();
      throw new ShopifyError(err.code, err.message, res.status, revoked);
    }
    const body = await this.body(res);
    this.keepPair(body, generation);
  }

  private async requestClientCredentials(): Promise<void> {
    const { clientId, clientSecret } = this.creds;
    const res = await this.post({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }, "de jeton");
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      // Le corps de la réponse n'est pas recopié : il peut rappeler l'identifiant envoyé.
      throw new ShopifyError("auth_refused", `Shopify a refusé les identifiants de l'application (${res.status}). Vérifiez le Client ID, le Client Secret et que l'application est installée sur la boutique.`, res.status);
    }
    if (!res.ok) throw new ShopifyError("unreachable", `Shopify a répondu ${res.status} à la demande de jeton.`, res.status);
    const o = await this.body(res);
    const value = typeof o.access_token === "string" ? o.access_token : "";
    const expiresIn = typeof o.expires_in === "number" && o.expires_in > 0 ? o.expires_in : 0;
    if (!value || !expiresIn) throw new ShopifyError("bad_response", "Réponse inattendue de Shopify à la demande de jeton.");
    const scopes = typeof o.scope === "string" ? o.scope.split(",").map((s) => s.trim()).filter(Boolean) : [];
    this.token = { value, expiresAt: this.now() + expiresIn * 1000, scopes };
  }
}

/** Lecture du magasin qui ne lève jamais : une erreur vaut absence de jeton (journal sans valeur). */
function safeLoad(store: TokenStore): TokenPair | null {
  try {
    return store.load();
  } catch {
    console.warn("[shopify] Les jetons enregistrés de la boutique n'ont pas pu être relus : ils sont ignorés.");
    return null;
  }
}

/**
 * Texte d'un document GraphQL sans ses commentaires ni ses chaînes : ce qui reste décide de sa nature.
 */
function stripGraphql(doc: string): string {
  return doc
    .replace(/"""[\s\S]*?"""/g, " ")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, " ")
    .replace(/#[^\n]*/g, " ");
}

/** true si le document contient une mutation (le mot-clé `mutation`, hors chaînes et commentaires). */
export function containsMutation(doc: string): boolean {
  return /(^|[^A-Za-z0-9_])mutation(?![A-Za-z0-9_])/.test(stripGraphql(doc));
}

/**
 * Appel GraphQL en LECTURE à l'API d'administration, avec le jeton courant.
 * Tout document qui contient une mutation est refusé avant tout appel réseau : les écritures passent
 * uniquement par `shopifyMutate`, qui exige que les écritures soient activées.
 * Un refus 401 fait redemander un jeton et rejouer l'appel une fois ; une requête freinée par Shopify
 * (THROTTLED) est rejouée deux fois au plus après une courte attente.
 */
export async function shopifyGraphql<T = unknown>(
  auth: ShopifyAuth,
  query: string,
  variables?: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  if (containsMutation(query)) throw new ShopifyError("bad_response", "Une écriture a été refusée : ce chemin du code ne fait que lire la boutique.");
  for (let attempt = 0; ; attempt++) {
    try {
      return await rawGraphql<T>(auth, query, variables, fetchImpl);
    } catch (err) {
      if (err instanceof ShopifyError && err.code === "throttled" && attempt < 2) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}

/** Les écritures ne sont pas activées côté serveur (SHOPIFY_WRITES_ENABLED). */
export class ShopifyWritesDisabledError extends Error {
  constructor() {
    super("Les écritures dans la boutique ne sont pas activées sur ce serveur.");
    this.name = "ShopifyWritesDisabledError";
  }
}

/**
 * Appel GraphQL en ÉCRITURE. Exige `writesEnabled` (SHOPIFY_WRITES_ENABLED=1) : sinon rien ne part.
 * Le document doit être une mutation et une seule opération. Jamais rejoué automatiquement.
 */
export async function shopifyMutate<T = unknown>(
  auth: ShopifyAuth,
  writesEnabled: boolean,
  mutation: string,
  variables: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  if (writesEnabled !== true) throw new ShopifyWritesDisabledError();
  if (!/^\s*mutation\b/.test(stripGraphql(mutation))) throw new ShopifyError("bad_response", "Document d'écriture invalide.");
  return rawGraphql<T>(auth, mutation, variables, fetchImpl);
}

async function rawGraphql<T>(auth: ShopifyAuth, query: string, variables: Record<string, unknown> | undefined, fetchImpl: typeof fetch): Promise<T> {
  const url = `https://${auth.storeDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  for (let attempt = 0; ; attempt++) {
    const token = await auth.getToken();
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", "x-shopify-access-token": token },
        body: JSON.stringify(variables ? { query, variables } : { query }),
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new ShopifyError("unreachable", "Shopify n'a pas répondu.");
    }
    if (res.status === 401 && attempt === 0) {
      auth.invalidate(token);
      continue;
    }
    if (res.status === 401 || res.status === 403) throw new ShopifyError("auth_refused", `Shopify a refusé l'accès (${res.status}).`, res.status);
    if (res.status === 429) throw new ShopifyError("throttled", "Shopify demande de ralentir (trop de demandes).", 429);
    if (!res.ok) throw new ShopifyError("unreachable", `Shopify a répondu ${res.status}.`, res.status);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new ShopifyError("bad_response", "Réponse illisible de Shopify.");
    }
    const o = (body && typeof body === "object" ? body : {}) as { data?: T; errors?: Array<{ message?: unknown; extensions?: { code?: unknown } }> };
    if (Array.isArray(o.errors) && o.errors.length) {
      if (o.errors.some((e) => e?.extensions?.code === "THROTTLED")) throw new ShopifyError("throttled", "Shopify demande de ralentir (trop de demandes).");
      const first = typeof o.errors[0]?.message === "string" ? o.errors[0].message.slice(0, 300) : "erreur inconnue";
      throw new ShopifyError("graphql", `Shopify a refusé la requête : ${first}`);
    }
    if (o.data === undefined || o.data === null) throw new ShopifyError("bad_response", "Réponse vide de Shopify.");
    return o.data;
  }
}
