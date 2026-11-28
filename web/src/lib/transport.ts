/**
 * Point unique par lequel passent toutes les requêtes vers /api.
 * En production, c'est fetch. En développement avec VITE_DEMO=1, le mode démonstration
 * remplace fetch par un faux serveur. La condition `import.meta.env.DEV` est remplacée
 * par `false` à la compilation de production : le mode démo est alors retiré du build.
 *
 * Mode intégré à Shopify (App Bridge présent, `window.shopify`) : chaque requête porte un jeton
 * de session neuf dans `Authorization: Bearer …`. Le jeton n'est gardé que le temps de la requête :
 * jamais dans l'adresse, jamais en stockage, jamais journalisé. Sans App Bridge, rien ne change.
 */
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Mode démonstration : `vite --mode demo` (script dev:demo) ou VITE_DEMO=1, en développement uniquement. */
export const DEMO_ENABLED: boolean = import.meta.env.DEV && (import.meta.env.MODE === "demo" || import.meta.env.VITE_DEMO === "1");

/** App Bridge n'a pas fourni de jeton de session (échec ou délai dépassé) : aucune requête n'est envoyée. */
export class SessionTokenError extends Error {
  constructor() {
    super("Jeton de session Shopify indisponible.");
    this.name = "SessionTokenError";
  }
}

const TOKEN_TIMEOUT_MS = 10_000;
const RETRY_HEADER = "X-Shopify-Retry-Invalid-Session-Request";

let impl: FetchLike = (input, init) => fetch(input, init);
let ready: Promise<void> = Promise.resolve();

if (import.meta.env.DEV && (import.meta.env.MODE === "demo" || import.meta.env.VITE_DEMO === "1")) {
  // En démonstration, jamais de repli sur fetch : si le faux serveur ne charge pas, toute requête échoue.
  impl = () => Promise.reject(new Error("Mode démonstration : faux serveur non chargé, aucun appel réseau réel."));
  ready = import("../demo/server").then((m) => {
    impl = m.demoFetch;
  });
}

function appBridge(): ShopifyAppBridge | null {
  if (typeof window === "undefined") return null;
  const b = window.shopify;
  return b && typeof b.idToken === "function" ? b : null;
}

/** App Bridge est-il présent ? Seul usage hors de ce fichier : `isEmbedded()` (lib/embedded.ts). */
export function hasAppBridge(): boolean {
  return appBridge() !== null;
}

/** Demande un jeton neuf à App Bridge, avec un délai maximal. Toute anomalie devient une SessionTokenError. */
async function sessionToken(bridge: ShopifyAppBridge): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const token = await Promise.race([
      bridge.idToken(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SessionTokenError()), TOKEN_TIMEOUT_MS);
      }),
    ]);
    if (typeof token !== "string" || token.length === 0) throw new SessionTokenError();
    return token;
  } catch {
    // Le détail de l'échec n'est pas repris : il pourrait contenir des informations de session.
    throw new SessionTokenError();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Copie de `init` avec l'en-tête d'identification ajouté, sans perdre les autres en-têtes (objet, tableau ou Headers). */
function withToken(init: RequestInit | undefined, token: string): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return { ...init, headers };
}

/** Seuls ces corps peuvent être renvoyés à l'identique (un flux est consommé au premier envoi). */
function replayable(body: RequestInit["body"]): boolean {
  return body === undefined || body === null || typeof body === "string" || body instanceof FormData;
}

export async function transport(input: string, init?: RequestInit): Promise<Response> {
  await ready;
  // Démonstration : faux serveur, jamais de jeton.
  if (DEMO_ENABLED) return impl(input, init);
  const bridge = appBridge();
  if (!bridge) return impl(input, init);

  const res = await impl(input, withToken(init, await sessionToken(bridge)));
  // Jeton refusé (expiré entre-temps, horloge) : un jeton neuf et une seule nouvelle tentative.
  if (res.status === 401 && res.headers.has(RETRY_HEADER) && replayable(init?.body)) {
    void res.body?.cancel().catch(() => {});
    return impl(input, withToken(init, await sessionToken(bridge)));
  }
  return res;
}
