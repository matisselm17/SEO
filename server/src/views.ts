/**
 * Réponses composées (vue d'ensemble, problèmes, pages, recommandations) au format de shared/api.ts.
 */
import type {
  Coverage,
  IssuesResponse,
  Overview,
  PageCheck,
  PageSort,
  PagesResponse,
  Progress,
  ProgressPoint,
  RecommendationsResponse,
} from "../../shared/api.ts";
import type { IssueDetail } from "../../shared/api.ts";
import { toIssue } from "./analyse/aggregate.ts";
import { MAX_PAGES_LIMITS } from "./config.ts";
import { buildCoverage } from "./coverage.ts";
import { totalsOf } from "./gsc/import.ts";
import { pathKey } from "./shopify/repo.ts";
import type { AuditRow, PageRow, SiteRow, Store } from "./store.ts";

const PAGE_SORTS: PageSort[] = ["score_asc", "score_desc", "issues_desc", "clicks_desc", "path_asc"];
export const isPageSort = (s: string): s is PageSort => (PAGE_SORTS as string[]).includes(s);

/** Problèmes par gravité (Overview.counts.issues, ProgressPoint.issues). */
export function issueCounts(issues: Array<Pick<IssueDetail, "severity">>): Overview["counts"]["issues"] {
  return {
    critical: issues.filter((i) => i.severity === "critical").length,
    warning: issues.filter((i) => i.severity === "warning").length,
    info: issues.filter((i) => i.severity === "info").length,
  };
}

/** Nom du site tel que l'agrégat le reçoit (le même que la Vue d'ensemble). */
const siteName = (site: SiteRow) => site.name || site.host;

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
      issues: issueCounts(issues),
    },
    topIssues: issues.slice(0, 5).map(toIssue),
    strengths: (agg?.strengths ?? []).slice(0, 5),
    actions: (agg?.recommendations ?? []).slice(0, 5),
    coverage: audit ? auditCoverage(store, audit) : null,
    organic: gsc ? { period: gsc.data.period, totals: totalsOf(gsc.data), series: gsc.data.series } : null,
  };
}

/** Couverture de l'analyse affichée ; null tant qu'aucune page n'a été notée. */
export function coverage(store: Store, siteId: string): Coverage | null {
  const audit = store.resultsAudit(siteId);
  return audit ? auditCoverage(store, audit) : null;
}

export function auditCoverage(store: Store, audit: AuditRow): Coverage {
  return buildCoverage(store.coverageState(audit), store.typeStats(audit.id), MAX_PAGES_LIMITS.max);
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

// ───────── Évolution (docs/format-echange.md, « Évolution et rapport »)

/**
 * Une analyse terminée telle que la Vue d'ensemble l'affichait : même agrégat (note, problèmes par gravité), même
 * nombre de pages notées. null si l'analyse n'a plus aucune page en base.
 */
export function progressPoint(store: Store, site: SiteRow, audit: AuditRow): ProgressPoint | null {
  // Résumé seulement : le détail des pages de cette analyse n'est pas gardé en mémoire.
  const sum = store.auditSummary(audit.id, siteName(site));
  if (sum.score === null || !audit.finished_at) return null;
  return {
    auditId: audit.id,
    finishedAt: audit.finished_at,
    score: sum.score,
    pagesAnalyzed: audit.pages_done,
    maxPages: audit.max_pages,
    issues: issueCounts(sum.severities.map((severity) => ({ severity }))),
  };
}

const TIMELINE_MAX = 50;
const isProblem = (c: PageCheck | undefined) => !!c && c.status !== "pass";

/** Pages d'une analyse par chemin normalisé (la première page de chaque chemin). */
function byPathKey(rows: PageRow[]): Map<string, PageRow> {
  const out = new Map<string, PageRow>();
  for (const r of rows) {
    const k = pathKey(r.path);
    if (!out.has(k)) out.set(k, r);
  }
  return out;
}

const avg = (xs: number[]) => Math.round(xs.reduce((a, x) => a + x, 0) / xs.length);

/** Comparaison à périmètre égal (pages communes aux deux analyses, reconnues par leur chemin normalisé). */
export function compareAudits(initialRows: PageRow[], currentRows: PageRow[]): Progress["comparison"] {
  // Détail des pages de l'une des deux analyses absent : rien n'est reconstitué.
  if (!initialRows.length || !currentRows.length) return null;
  const a = byPathKey(initialRows);
  const b = byPathKey(currentRows);
  const common = [...a.keys()].filter((k) => b.has(k));
  if (!common.length) return null;
  let issuesFixed = 0;
  let issuesRemaining = 0;
  let issuesNew = 0;
  for (const k of common) {
    const before = new Map((JSON.parse(a.get(k)!.checks_json) as PageCheck[]).map((c) => [c.id, c]));
    for (const after of JSON.parse(b.get(k)!.checks_json) as PageCheck[]) {
      const prev = before.get(after.id);
      // Un critère absent de l'une des deux analyses n'est pas comparable (même grille exigée).
      if (!prev) continue;
      const was = isProblem(prev);
      const is = isProblem(after);
      if (was && is) issuesRemaining++;
      else if (was && !is) issuesFixed++;
      else if (!was && is) issuesNew++;
    }
  }
  return {
    pagesInCommon: common.length,
    pagesOnlyInitial: a.size - common.length,
    pagesOnlyCurrent: b.size - common.length,
    scoreInitial: avg(common.map((k) => a.get(k)!.score)),
    scoreCurrent: avg(common.map((k) => b.get(k)!.score)),
    issuesFixed,
    issuesRemaining,
    issuesNew,
  };
}

/** GET …/progress. `corrections` : compteurs des corrections de la boutique (tous à 0 sans boutique reliée). */
export function progress(store: Store, site: SiteRow, corrections: Progress["corrections"]): Progress {
  const audits = store.doneAudits(site.id);
  const empty: Progress = { available: false, initial: null, current: null, timeline: [], comparison: null, corrections };
  // Première analyse qui compte (au moins une page encore en base).
  let first: { audit: AuditRow; point: ProgressPoint } | null = null;
  for (const audit of audits) {
    const point = progressPoint(store, site, audit);
    if (point) {
      first = { audit, point };
      break;
    }
  }
  if (!first) return empty;
  // Les 50 plus récentes, sans recalculer au-delà.
  const tail: Array<{ audit: AuditRow; point: ProgressPoint }> = [];
  for (let i = audits.length - 1; i >= 0 && tail.length < TIMELINE_MAX; i--) {
    const audit = audits[i];
    if (audit.seq < first.audit.seq) break;
    const point = audit.id === first.audit.id ? first.point : progressPoint(store, site, audit);
    if (point) tail.push({ audit, point });
  }
  tail.reverse();
  const last = tail[tail.length - 1];
  return {
    available: true,
    initial: first.point,
    current: last.point,
    timeline: tail.map((p) => p.point),
    comparison: first.audit.id === last.audit.id ? null : compareAudits(store.pageRows(first.audit.id), store.pageRows(last.audit.id)),
    corrections,
  };
}
