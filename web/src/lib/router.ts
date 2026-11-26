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

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  const current = window.location.pathname + window.location.search;
  if (to === current) return;
  if (opts.replace) window.history.replaceState(null, "", to);
  else window.history.pushState(null, "", to);
  window.dispatchEvent(new Event(NAV_EVENT));
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
  | { name: "assistant"; siteId: string }
  | { name: "settings"; siteId: string | null }
  | { name: "notfound" };

export type SectionName = Exclude<Route["name"], "home" | "add" | "notfound">;

const SECTION_SLUGS: Record<string, SectionName> = {
  "": "overview",
  audit: "audit",
  pages: "pages",
  trafic: "traffic",
  concurrents: "competitors",
  recommandations: "recommendations",
  assistant: "assistant",
  parametres: "settings",
};

export const SECTION_PATHS: Record<SectionName, string> = {
  overview: "",
  audit: "/audit",
  pages: "/pages",
  traffic: "/trafic",
  competitors: "/concurrents",
  recommendations: "/recommandations",
  assistant: "/assistant",
  settings: "/parametres",
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
