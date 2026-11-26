/**
 * Flux en direct d'un site (GET /api/sites/:id/events) :
 * met à jour le cache au fil des événements, sans recalcul coûteux à chaque message.
 */
import { useEffect, useSyncExternalStore } from "react";
import { getQueryData, invalidate, setQueryData } from "./cache";
import { keys, type AllPages } from "./queries";
import { openLiveStream, type StreamStatus } from "./sse";
import type { AuditStatus, Overview, SiteEvent, SiteResponse, SiteSummary, SitesResponse } from "./types";

let status: StreamStatus = "connecting";
const statusListeners = new Set<() => void>();
function setStatus(s: StreamStatus) {
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

/** Applique un résumé de site à toutes les copies en cache. */
export function patchSite(siteId: string, patch: (s: SiteSummary) => SiteSummary) {
  setQueryData<SitesResponse>(keys.sites, (prev) => (prev ? { sites: prev.sites.map((x) => (x.id === siteId ? patch(x) : x)) } : prev));
  setQueryData<SiteResponse>(keys.site(siteId), (prev) => (prev ? { site: patch(prev.site) } : prev));
  setQueryData<Overview>(keys.overview(siteId), (prev) => (prev ? { ...prev, site: patch(prev.site) } : prev));
}

const RESULT_KEYS = (id: string) => [keys.overview(id), keys.issues(id), keys.recommendations(id)];

function isFinished(a: AuditStatus | null | undefined) {
  return !!a && (a.state === "done" || a.state === "failed" || a.state === "cancelled");
}

export function invalidateSiteResults(siteId: string) {
  for (const k of RESULT_KEYS(siteId)) invalidate(k);
  invalidate(`/sites/${encodeURIComponent(siteId)}/issues/`);
  invalidate(keys.allPages(siteId));
  invalidate(`/sites/${encodeURIComponent(siteId)}/pages/`);
  invalidate(keys.chat(siteId));
  invalidate(keys.competitors(siteId));
}

export function useSiteEvents(siteId: string | null) {
  useEffect(() => {
    if (!siteId) return;
    let lastAudit: AuditStatus | null = getQueryData<SiteResponse>(keys.site(siteId))?.site.audit ?? null;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;

    // Pendant l'analyse : au plus un rafraîchissement des écrans de résultats toutes les 2,5 s.
    const scheduleRefresh = () => {
      if (refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        for (const k of RESULT_KEYS(siteId)) invalidate(k);
        invalidate(`/sites/${encodeURIComponent(siteId)}/issues/`);
      }, 2500);
    };

    const onAudit = (audit: AuditStatus | null, score: number | null | undefined, pagesAnalyzed?: number) => {
      const newAudit = !!audit && !!lastAudit && audit.id !== lastAudit.id;
      const justFinished = !!audit && !isFinished(lastAudit) && isFinished(audit) && lastAudit?.id === audit.id;
      lastAudit = audit;
      patchSite(siteId, (s) => ({
        ...s,
        audit,
        score: score === undefined ? s.score : score,
        pagesAnalyzed: pagesAnalyzed ?? (audit && audit.state === "running" ? audit.pagesDone : s.pagesAnalyzed),
      }));
      if (newAudit) {
        setQueryData<AllPages>(keys.allPages(siteId), { pages: [], total: 0 });
        invalidateSiteResults(siteId);
      } else if (justFinished) {
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
            const prev = lastAudit;
            const changed = !prev || !ev.site.audit || prev.id !== ev.site.audit.id || prev.state !== ev.site.audit.state;
            patchSite(siteId, () => ev.site);
            lastAudit = ev.site.audit;
            if (changed && prev) invalidateSiteResults(siteId);
            break;
          }
          case "audit":
            onAudit(ev.audit, ev.score);
            break;
          case "page": {
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
      setStatus,
    );
    return () => {
      stop();
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [siteId]);
}
