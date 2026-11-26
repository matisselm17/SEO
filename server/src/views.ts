/**
 * Réponses composées (vue d'ensemble, problèmes, pages, recommandations) au format de shared/api.ts.
 */
import type {
  IssuesResponse,
  Overview,
  PageSort,
  PagesResponse,
  RecommendationsResponse,
} from "../../shared/api.ts";
import { toIssue } from "./analyse/aggregate.ts";
import { totalsOf } from "./gsc/import.ts";
import type { SiteRow, Store } from "./store.ts";

const PAGE_SORTS: PageSort[] = ["score_asc", "score_desc", "issues_desc", "clicks_desc", "path_asc"];
export const isPageSort = (s: string): s is PageSort => (PAGE_SORTS as string[]).includes(s);

export function overview(store: Store, site: SiteRow): Overview {
  const summary = store.siteSummary(site);
  const audit = store.resultsAudit(site.id);
  const agg = audit ? store.aggregate(audit.id, summary.name) : null;
  const gsc = store.getGsc(site.id);
  const prev = audit ? store.previousDoneAudit(site.id, audit.seq) : null;
  const issues = agg?.issues ?? [];
  return {
    site: summary,
    score:
      agg && agg.score !== null
        ? { value: agg.score, previous: prev ? store.auditScore(prev.id) : null, categories: agg.categories }
        : null,
    counts: {
      pages: agg?.pagesTotal ?? 0,
      issues: {
        critical: issues.filter((i) => i.severity === "critical").length,
        warning: issues.filter((i) => i.severity === "warning").length,
        info: issues.filter((i) => i.severity === "info").length,
      },
    },
    topIssues: issues.slice(0, 5).map(toIssue),
    strengths: (agg?.strengths ?? []).slice(0, 5),
    actions: (agg?.recommendations ?? []).slice(0, 5),
    organic: gsc ? { period: gsc.data.period, totals: totalsOf(gsc.data), series: gsc.data.series } : null,
  };
}

export function issues(store: Store, site: SiteRow): IssuesResponse {
  const audit = store.resultsAudit(site.id);
  if (!audit) return { issues: [], strengths: [], categories: [] };
  const agg = store.aggregate(audit.id, site.name || site.host);
  return { issues: agg.issues.map(toIssue), strengths: agg.strengths, categories: agg.categories };
}

export function recommendations(store: Store, site: SiteRow): RecommendationsResponse {
  const audit = store.resultsAudit(site.id);
  if (!audit) return { recommendations: [] };
  return { recommendations: store.aggregate(audit.id, site.name || site.host).recommendations };
}

export function listPages(store: Store, siteId: string, q: { sort: PageSort; q: string; offset: number; limit: number }): PagesResponse {
  const audit = store.resultsAudit(siteId);
  if (!audit) return { pages: [], total: 0, offset: q.offset, limit: q.limit };
  const gsc = store.gscIndex(siteId);
  let rows = store.pageRows(audit.id).map((r) => store.pageSummary(r, gsc));
  const needle = q.q.trim().toLowerCase();
  if (needle) rows = rows.filter((p) => p.path.toLowerCase().includes(needle) || (p.title ?? "").toLowerCase().includes(needle));
  const byPath = (a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path);
  const sorters: Record<PageSort, (a: (typeof rows)[number], b: (typeof rows)[number]) => number> = {
    score_asc: (a, b) => a.score - b.score || byPath(a, b),
    score_desc: (a, b) => b.score - a.score || byPath(a, b),
    issues_desc: (a, b) => b.issues - a.issues || a.score - b.score || byPath(a, b),
    clicks_desc: (a, b) => (b.organic?.clicks ?? -1) - (a.organic?.clicks ?? -1) || (b.organic?.impressions ?? -1) - (a.organic?.impressions ?? -1) || byPath(a, b),
    path_asc: byPath,
  };
  rows.sort(sorters[q.sort]);
  return { pages: rows.slice(q.offset, q.offset + q.limit), total: rows.length, offset: q.offset, limit: q.limit };
}
