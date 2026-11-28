/**
 * Mode intégré à Shopify : point de vérité unique pour toute l'interface.
 *
 * En mode intégré (App Bridge présent, `window.shopify`), une boutique a exactement un site, créé par
 * le serveur : pas d'ajout, pas de suppression, pas de choix entre plusieurs sites, pas de réglage du
 * nombre de pages par défaut (ces routes répondent `403 not_in_embedded_mode`).
 *
 * En démonstration (développement uniquement), App Bridge n'existe pas : le parcours intégré se simule
 * avec `?integre=…` (mémorisé pour l'onglet, voir web/README.md). Hors démonstration, ce paramètre
 * n'est jamais lu : `DEMO_ENABLED` vaut `false` dans tout build de production.
 */
import { DEMO_ENABLED, hasAppBridge } from "./transport";

/**
 *   non (défaut)  mode local : plusieurs sites, ajout et suppression
 *   oui           mode intégré : la première lecture des sites attend quelques secondes, puis le site s'ouvre
 *   echec         mode intégré : la première lecture des sites échoue (shopify_unavailable), « Réessayer » réussit
 *   vide          mode intégré : la lecture des sites rend toujours une liste vide
 */
export type DemoEmbeddedMode = "non" | "oui" | "echec" | "vide";
const DEMO_MODES: DemoEmbeddedMode[] = ["non", "oui", "echec", "vide"];
const STORAGE_KEY = "demo-integre";

function readDemoMode(): DemoEmbeddedMode {
  try {
    const fromUrl = new URLSearchParams(location.search).get("integre") as DemoEmbeddedMode | null;
    if (fromUrl && DEMO_MODES.includes(fromUrl)) {
      sessionStorage.setItem(STORAGE_KEY, fromUrl);
      return fromUrl;
    }
    const saved = sessionStorage.getItem(STORAGE_KEY) as DemoEmbeddedMode | null;
    return saved && DEMO_MODES.includes(saved) ? saved : "non";
  } catch {
    return "non";
  }
}

/** État de démonstration du parcours intégré ; toujours "non" hors démonstration. */
export const demoEmbeddedMode: DemoEmbeddedMode = import.meta.env.DEV && DEMO_ENABLED ? readDemoMode() : "non";

/** L'interface tourne-t-elle dans l'administration Shopify (une boutique, un site) ? */
export function isEmbedded(): boolean {
  if (DEMO_ENABLED) return demoEmbeddedMode !== "non";
  return hasAppBridge();
}
