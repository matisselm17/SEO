/**
 * Flux en direct d'un site (GET /api/sites/:id/events) :
 * met à jour le cache au fil des événements, sans recalcul coûteux à chaque message.
 */
import { useEffect, useSyncExternalStore } from "react";
import { getQueryData, invalidate, setQueryData } from "./cache";
import { keys, type AllPages } from "./queries";
import { openLiveStream, type StreamStatus } from "./sse";
import { applyAudit, resultsOf } from "./results";
import type { Overview, SiteEvent, SiteResponse, SiteSummary, SitesResponse } from "./types";

let status: StreamStatus = "connecting";
const statusListeners = new Set<() => void>();
function setStatus(s: StreamStatus) {
  if (status === s) return;
  status = s;
  statusListeners.forEach((l) => l());
}
export function useLiveStatus(): StreamStatus {
  return useSyncExternalStore(
    (cb) => {
      statusListeners.add(cb);
      return () => statusListeners.delete(cb);
    },
    () => status,
  );
}

/** Résumé du site le plus à jour parmi les copies en cache. */
function currentSite(siteId: string): SiteSummary | undefined {
  return getQueryData<SitesResponse>(keys.sites)?.sites.find((s) => s.id === siteId) ?? getQueryData<SiteResponse>(keys.site(siteId))?.site;
}

/** Applique un résumé de site à toutes les copies en cache. */
export function patchSite(siteId: string, patch: (s: SiteSummary) => SiteSummary) {
  setQueryData<SitesResponse>(keys.sites, (prev) => (prev ? { sites: prev.sites.map((x) => (x.id === siteId ? patch(x) : x)) } : prev));
  setQueryData<SiteResponse>(keys.site(siteId), (prev) => (prev ? { site: patch(prev.site) } : prev));
  setQueryData<Overview>(keys.overview(siteId), (prev) => (prev ? { ...prev, site: patch(prev.site) } : prev));
}

const RESULT_KEYS = (id: string) => [keys.overview(id), keys.issues(id), keys.recommendations(id), keys.failedPages(id)];

export function invalidateSiteResults(siteId: string) {
  for (const k of RESULT_KEYS(siteId)) invalidate(k);
  invalidate(`/sites/${encodeURIComponent(siteId)}/issues/`);
  invalidate(keys.allPages(siteId));
  invalidate(`/sites/${encodeURIComponent(siteId)}/pages/`);
  invalidate(keys.chat(siteId));
  invalidate(keys.competitors(siteId));
}

/** Les résultats affichés ont changé d'analyse, ou d'état : tout ce qui en dépend est relu. */
function resultsChanged(before: SiteSummary | undefined, after: SiteSummary | undefined) {
  const a = before ? resultsOf(before) : null;
  const b = after ? resultsOf(after) : null;
  return (a?.auditId ?? null) !== (b?.auditId ?? null) || (a?.state ?? null) !== (b?.state ?? null);
}

export function useSiteEvents(siteId: string | null) {
  useEffect(() => {
    if (!siteId) return;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let connections = 0;
    setStatus("connecting");

    // Pendant une première analyse : au plus un rafraîchissement des écrans de résultats toutes les 2,5 s.
    const scheduleRefresh = () => {
      if (refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        for (const k of RESULT_KEYS(siteId)) invalidate(k);
        invalidate(`/sites/${encodeURIComponent(siteId)}/issues/`);
      }, 2500);
    };

    const onChange = (before: SiteSummary | undefined) => {
      const after = currentSite(siteId);
      if (resultsChanged(before, after)) {
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = null;
        invalidateSiteResults(siteId);
        invalidate(keys.sites);
      }
    };

    const stop = openLiveStream(
      keys.events(siteId),
      (m) => {
        let ev: SiteEvent;
        try {
          ev = JSON.parse(m.data) as SiteEvent;
        } catch {
          return;
        }
        switch (ev.type) {
          case "site": {
            const before = currentSite(siteId);
            patchSite(siteId, () => ev.site);
            connections += 1;
            // Après une coupure, les écrans relisent leurs données (ETag : rien n'est renvoyé si rien n'a changé).
            if (connections > 1) invalidateSiteResults(siteId);
            else onChange(before);
            break;
          }
          case "audit": {
            const before = currentSite(siteId);
            patchSite(siteId, (s) => applyAudit(s, ev.audit, ev.score));
            onChange(before);
            break;
          }
          case "page": {
            // Une page de la nouvelle analyse ne s'ajoute à la liste que si c'est elle qui est affichée
            // (première analyse). Pendant une relance, la liste garde les pages de l'analyse précédente.
            const site = currentSite(siteId);
            const r = site ? resultsOf(site) : null;
            if (!site?.audit || !r || r.auditId !== site.audit.id) break;
            const page = ev.page;
            setQueryData<AllPages>(keys.allPages(siteId), (prev) => {
              if (!prev) return prev;
              const i = prev.pages.findIndex((p) => p.id === page.id);
              if (i >= 0) {
                const pages = prev.pages.slice();
                pages[i] = page;
                return { ...prev, pages };
              }
              return { pages: [...prev.pages, page], total: prev.total + 1 };
            });
            scheduleRefresh();
            break;
          }
          case "search_console":
            patchSite(siteId, (s) => ({ ...s, searchConsole: { available: ev.available, importedAt: ev.available ? s.searchConsole.importedAt : null } }));
            invalidate(keys.searchConsole(siteId));
            invalidate(keys.overview(siteId));
            invalidate(keys.allPages(siteId));
            invalidate(keys.site(siteId));
            break;
        }
      },
      (s) => {
        setStatus(s);
        // Site supprimé ailleurs : la liste des sites est relue, l'écran le dira.
        if (s === "gone") invalidate(keys.sites);
      },
    );
    return () => {
      stop();
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [siteId]);
}
