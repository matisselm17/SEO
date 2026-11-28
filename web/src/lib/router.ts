/** Routage par l'historique du navigateur, sans rechargement. */
import { useSyncExternalStore, type MouseEvent } from "react";

const NAV_EVENT = "app:navigate";

function subscribe(cb: () => void) {
  window.addEventListener("popstate", cb);
  window.addEventListener(NAV_EVENT, cb);
  return () => {
    window.removeEventListener("popstate", cb);
    window.removeEventListener(NAV_EVENT, cb);
  };
}

const getPath = () => window.location.pathname;
const getSearch = () => window.location.search;

export function usePath(): string {
  return useSyncExternalStore(subscribe, getPath, getPath);
}

export function useSearch(): URLSearchParams {
  const s = useSyncExternalStore(subscribe, getSearch, getSearch);
  return new URLSearchParams(s);
}

/** Chaque entrée d'historique retient l'adresse d'où l'on vient (pour refermer un détail sans empiler d'entrée). */
interface NavState {
  prev: string | null;
}

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  const current = window.location.pathname + window.location.search;
  if (to === current) return;
  if (opts.replace) window.history.replaceState({ prev: (window.history.state as NavState | null)?.prev ?? null } satisfies NavState, "", to);
  else window.history.pushState({ prev: current } satisfies NavState, "", to);
  window.dispatchEvent(new Event(NAV_EVENT));
}

/**
 * Referme un panneau de détail. S'il a été ouvert depuis la liste, on revient en arrière dans l'historique :
 * « Précédent » ne le rouvre donc pas. Ouvert depuis un lien partagé, on remplace l'entrée par la liste.
 */
export function closeDetail(listPath: string) {
  const prev = (window.history.state as NavState | null)?.prev ?? null;
  if (prev === listPath) window.history.back();
  else navigate(listPath, { replace: true });
}

/** Intercepte un clic sur un lien interne, en laissant passer Ctrl/Cmd+clic. */
export function onLinkClick(e: MouseEvent<HTMLAnchorElement>, to: string, replace = false) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  navigate(to, { replace });
}

export type Route =
  | { name: "home" }
  | { name: "add" }
  | { name: "overview"; siteId: string }
  | { name: "audit"; siteId: string; issueId: string | null }
  | { name: "pages"; siteId: string; pageId: string | null }
  | { name: "traffic"; siteId: string }
  | { name: "competitors"; siteId: string }
  | { name: "recommendations"; siteId: string }
  | { name: "shopify"; siteId: string; resourceId: string | null; view: ShopifyView; batchId: string | null }
  | { name: "assistant"; siteId: string }
  | { name: "settings"; siteId: string | null }
  /** Rapport d'optimisation imprimable (pas d'entrée dans la navigation latérale). */
  | { name: "report"; siteId: string }
  | { name: "notfound" };

/** Onglets de la section Boutique Shopify, chacun avec son adresse. */
export type ShopifyView = "items" | "batches" | "history" | "automation";
const SHOPIFY_VIEWS: Record<string, ShopifyView> = { lots: "batches", historique: "history", automatisation: "automation" };
export const SHOPIFY_VIEW_SLUG: Record<ShopifyView, string | null> = { items: null, batches: "lots", history: "historique", automation: "automatisation" };
/** Identifiant réservé : le lot en préparation dans le navigateur (pas encore envoyé au serveur). */
export const NEW_BATCH = "nouveau";

export type SectionName = Exclude<Route["name"], "home" | "add" | "notfound">;

const SECTION_SLUGS: Record<string, SectionName> = {
  "": "overview",
  audit: "audit",
  pages: "pages",
  trafic: "traffic",
  concurrents: "competitors",
  recommandations: "recommendations",
  boutique: "shopify",
  assistant: "assistant",
  parametres: "settings",
  rapport: "report",
};

export const SECTION_PATHS: Record<SectionName, string> = {
  overview: "",
  audit: "/audit",
  pages: "/pages",
  traffic: "/trafic",
  competitors: "/concurrents",
  recommendations: "/recommandations",
  shopify: "/boutique",
  assistant: "/assistant",
  settings: "/parametres",
  report: "/rapport",
};

export function parseRoute(path: string): Route {
  const parts = path.replace(/\/+$/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts.length === 0) return { name: "home" };
  if (parts[0] === "ajouter" && parts.length === 1) return { name: "add" };
  if (parts[0] === "parametres" && parts.length === 1) return { name: "settings", siteId: null };
  if (parts[0] !== "sites" || !parts[1]) return { name: "notfound" };
  const siteId = parts[1];
  const section = SECTION_SLUGS[parts[2] ?? ""];
  if (!section) return { name: "notfound" };
  const extra = parts[3] ?? null;
  if (section === "shopify") {
    // /boutique, /boutique/:élément, /boutique/lots, /boutique/lots/:lot, /boutique/historique, /boutique/automatisation
    const view = extra ? SHOPIFY_VIEWS[extra] : undefined;
    if (view) {
      const batchId = view === "batches" ? parts[4] ?? null : null;
      if (parts.length > (view === "batches" ? 5 : 4)) return { name: "notfound" };
      return { name: "shopify", siteId, resourceId: null, view, batchId };
    }
    if (parts.length > 4) return { name: "notfound" };
    return { name: "shopify", siteId, resourceId: extra, view: "items", batchId: null };
  }
  if (parts.length > 4) return { name: "notfound" };
  switch (section) {
    case "audit":
      return { name: "audit", siteId, issueId: extra };
    case "pages":
      return { name: "pages", siteId, pageId: extra };
    default:
      if (extra) return { name: "notfound" };
      return { name: section, siteId } as Route;
  }
}

export function sitePath(siteId: string, section: SectionName = "overview", extra?: string) {
  return `/sites/${encodeURIComponent(siteId)}${SECTION_PATHS[section]}${extra ? "/" + encodeURIComponent(extra) : ""}`;
}

/** Adresse d'un onglet de la boutique, ou d'un lot. */
export function shopPath(siteId: string, view: ShopifyView, batchId?: string) {
  const slug = SHOPIFY_VIEW_SLUG[view];
  const base = sitePath(siteId, "shopify");
  if (!slug) return base;
  return `${base}/${slug}${batchId ? "/" + encodeURIComponent(batchId) : ""}`;
}
