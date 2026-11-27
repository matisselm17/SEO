/**
 * Connexion à la boutique Shopify par « Client Credentials Grant ».
 *
 * Shopify délivre un jeton valable 24 heures. Ce module le garde en mémoire (jamais sur disque,
 * jamais dans les journaux) et le renouvelle tout seul :
 * - avant chaque appel, si le jeton expire dans moins de `RENEW_MARGIN_MS` ;
 * - après un refus 401, une seule fois, au cas où Shopify l'aurait révoqué plus tôt.
 * Plusieurs appels simultanés partagent la même demande de jeton.
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

export type ShopifyErrorCode = "auth_refused" | "unreachable" | "bad_response" | "graphql";

export class ShopifyError extends Error {
  readonly code: ShopifyErrorCode;
  readonly status: number | null;
  constructor(code: ShopifyErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = "ShopifyError";
    this.code = code;
    this.status = status;
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

export class ShopifyAuth {
  private token: { value: string; expiresAt: number; scopes: string[] } | null = null;
  private pending: Promise<string> | null = null;
  private readonly creds: ShopifyCredentials;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(creds: ShopifyCredentials, fetchImpl: typeof fetch = fetch, now: () => number = Date.now) {
    if (!parseShopDomain(creds.storeDomain)) throw new ShopifyError("bad_response", "Domaine Shopify invalide : attendu « ma-boutique.myshopify.com ».");
    this.creds = { ...creds, storeDomain: parseShopDomain(creds.storeDomain)! };
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  get storeDomain(): string {
    return this.creds.storeDomain;
  }

  /** Jeton valide : celui en mémoire s'il lui reste assez de temps, sinon un nouveau. */
  async getToken(): Promise<string> {
    if (this.token && this.token.expiresAt - RENEW_MARGIN_MS > this.now()) return this.token.value;
    return this.renew();
  }

  /** Oublie le jeton en mémoire ; le prochain appel en demandera un neuf. Sans effet si `stale` n'est plus le jeton courant. */
  invalidate(stale?: string): void {
    if (!stale || this.token?.value === stale) this.token = null;
  }

  /** État du jeton courant, sans sa valeur. null tant qu'aucun jeton n'a été obtenu. */
  info(): TokenInfo | null {
    return this.token ? { scopes: [...this.token.scopes], expiresAt: new Date(this.token.expiresAt) } : null;
  }

  private renew(): Promise<string> {
    // Une seule demande à la fois : les appels simultanés attendent la même réponse.
    this.pending ??= this.requestToken().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async requestToken(): Promise<string> {
    const { storeDomain, clientId, clientSecret } = this.creds;
    let res: Response;
    try {
      res = await this.fetchImpl(`https://${storeDomain}/admin/oauth/access_token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }).toString(),
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new ShopifyError("unreachable", "Shopify n'a pas répondu à la demande de jeton.");
    }
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      // Le corps de la réponse n'est pas recopié : il peut rappeler l'identifiant envoyé.
      throw new ShopifyError("auth_refused", `Shopify a refusé les identifiants de l'application (${res.status}). Vérifiez le Client ID, le Client Secret et que l'application est installée sur la boutique.`, res.status);
    }
    if (!res.ok) throw new ShopifyError("unreachable", `Shopify a répondu ${res.status} à la demande de jeton.`, res.status);
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    const o = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
    const value = typeof o.access_token === "string" ? o.access_token : "";
    const expiresIn = typeof o.expires_in === "number" && o.expires_in > 0 ? o.expires_in : 0;
    if (!value || !expiresIn) throw new ShopifyError("bad_response", "Réponse inattendue de Shopify à la demande de jeton.");
    const scopes = typeof o.scope === "string" ? o.scope.split(",").map((s) => s.trim()).filter(Boolean) : [];
    this.token = { value, expiresAt: this.now() + expiresIn * 1000, scopes };
    return value;
  }
}

/**
 * Appel GraphQL à l'API d'administration, avec le jeton courant.
 * Un refus 401 fait redemander un jeton et rejouer l'appel une fois.
 */
export async function shopifyGraphql<T = unknown>(
  auth: ShopifyAuth,
  query: string,
  variables?: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
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
    if (!res.ok) throw new ShopifyError("unreachable", `Shopify a répondu ${res.status}.`, res.status);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new ShopifyError("bad_response", "Réponse illisible de Shopify.");
    }
    const o = (body && typeof body === "object" ? body : {}) as { data?: T; errors?: Array<{ message?: unknown }> };
    if (Array.isArray(o.errors) && o.errors.length) {
      const first = typeof o.errors[0]?.message === "string" ? o.errors[0].message.slice(0, 300) : "erreur inconnue";
      throw new ShopifyError("graphql", `Shopify a refusé la requête : ${first}`);
    }
    if (o.data === undefined || o.data === null) throw new ShopifyError("bad_response", "Réponse vide de Shopify.");
    return o.data;
  }
}
