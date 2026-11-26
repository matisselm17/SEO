/**
 * Regroupement à l'échelle du site : problèmes (avec preuves), points positifs, recommandations,
 * notes par famille. Applique les « Règles de fond » de docs/format-echange.md.
 */
import type {
  CategoryScore,
  Evidence,
  Impact,
  Issue,
  IssueDetail,
  PageCheck,
  Recommendation,
  Severity,
  Strength,
} from "../../../shared/api.ts";
import { CATALOGUE, DUPLICATES, effortFor, issueSteps, recommendationSteps } from "./catalogue.ts";
import { CATEGORIES, CRITERIA, type PageFacts } from "./grille.ts";

export interface PageRecord {
  id: string;
  url: string;
  path: string;
  score: number;
  checks: PageCheck[];
  facts: PageFacts;
  categories: Array<{ id: string; score: number; max: number }>;
}

export interface SiteAggregate {
  pagesTotal: number;
  score: number | null;
  categories: CategoryScore[];
  issues: IssueDetail[];
  strengths: Strength[];
  recommendations: Recommendation[];
}

const MAX_EVIDENCE = 200;

export function severityFor(id: string, max: number, affected: number, total: number): Severity {
  if (id === "indexable") return "critical";
  if (max >= 6 && affected > total / 2) return "critical";
  if (max <= 2) return "info";
  return "warning";
}

export function impactFor(pointsToGain: number, total: number): Impact {
  const perPage = total ? pointsToGain / total : 0;
  if (perPage >= 3) return "high";
  if (perPage >= 1) return "medium";
  return "low";
}

const round1 = (x: number) => Math.round(x * 10) / 10;

export function aggregate(pages: PageRecord[], siteName: string): SiteAggregate {
  const total = pages.length;
  if (!total) return { pagesTotal: 0, score: null, categories: [], issues: [], strengths: [], recommendations: [] };

  const categories: CategoryScore[] = CATEGORIES.map((c) => ({
    id: c.id,
    label: c.label,
    max: c.max,
    score: round1(pages.reduce((a, p) => a + (p.categories.find((k) => k.id === c.id)?.score ?? 0), 0) / total),
  }));
  const score = Math.round(pages.reduce((a, p) => a + p.score, 0) / total);

  const issues: IssueDetail[] = [];
  const strengths: Strength[] = [];
  const effortById = new Map<string, ReturnType<typeof effortFor>>();
  const actionById = new Map<string, string>();
  const stepsById = new Map<string, string[]>();

  for (const crit of CRITERIA) {
    const entry = CATALOGUE[crit.id];
    const rows = pages
      .map((p) => ({ p, c: p.checks.find((k) => k.id === crit.id) }))
      .filter((r): r is { p: PageRecord; c: PageCheck } => !!r.c);
    const bad = rows.filter((r) => r.c.status !== "pass");
    const passing = rows.length - bad.length;
    if (rows.length && passing / total >= 0.9) {
      strengths.push({
        id: crit.id,
        category: crit.category,
        title: passing === total ? entry.strength.title : entry.strength.most,
        detail: entry.strength.detail(passing, total),
        pagesPassing: passing,
        pagesTotal: total,
      });
    }
    if (!bad.length) continue;
    bad.sort((a, b) => b.c.max - b.c.points - (a.c.max - a.c.points) || a.p.path.localeCompare(b.p.path));
    const pointsLost = bad.reduce((a, r) => a + (r.c.max - r.c.points), 0);
    const failing = bad.filter((r) => r.c.status === "fail").length;
    const sample = bad[0];
    const ctx = {
      affected: bad.length,
      total,
      failing,
      sample: { url: sample.p.url, facts: sample.p.facts, siteName },
    };
    const evidence: Evidence[] = bad.slice(0, MAX_EVIDENCE).map((r) => ({
      pageId: r.p.id,
      url: r.p.url,
      path: r.p.path,
      found: r.c.found,
      expected: r.c.expected,
    }));
    const built = entry.snippet ? entry.snippet(ctx) : null;
    const snippet = built ? { language: built.language, code: built.code, forPath: entry.snippetFromPage ? sample.p.path : null } : null;
    const rawSteps = entry.steps(ctx);
    issues.push({
      id: crit.id,
      category: crit.category,
      severity: severityFor(crit.id, crit.max, bad.length, total),
      title: entry.title(ctx),
      summary: entry.summary,
      pagesAffected: bad.length,
      pagesTotal: total,
      scoreImpact: round1(pointsLost / total),
      pointsLost,
      why: entry.why,
      fix: { steps: issueSteps(rawSteps, !!snippet), snippet },
      evidence,
    });
    effortById.set(crit.id, effortFor(entry.scope, bad.length));
    actionById.set(crit.id, entry.action(ctx));
    stepsById.set(crit.id, recommendationSteps(rawSteps, !!snippet));
  }

  // Doublons à l'échelle du site : même titre ou même description sur plusieurs pages.
  for (const kind of ["duplicate_title", "duplicate_description"] as const) {
    const pick = (p: PageRecord) => (kind === "duplicate_title" ? p.facts.title : p.facts.description);
    const groups = new Map<string, PageRecord[]>();
    for (const p of pages) {
      const v = pick(p).trim().replace(/\s+/g, " ").toLowerCase();
      if (!v) continue;
      const list = groups.get(v) ?? [];
      list.push(p);
      groups.set(v, list);
    }
    const dup = [...groups.values()].filter((g) => g.length > 1).sort((a, b) => b.length - a.length);
    if (!dup.length) continue;
    const affected = dup.reduce((a, g) => a + g.length, 0);
    const def = DUPLICATES[kind];
    const evidence: Evidence[] = [];
    for (const g of dup) {
      const value = pick(g[0]).trim();
      const shown = value.length > 90 ? value.slice(0, 89).trimEnd() + "…" : value;
      for (const p of g) {
        if (evidence.length >= MAX_EVIDENCE) break;
        evidence.push({
          pageId: p.id,
          url: p.url,
          path: p.path,
          found: `« ${shown} », identique sur ${g.length} pages`,
          expected: kind === "duplicate_title" ? "Un titre propre à chaque page" : "Une description propre à chaque page",
        });
      }
    }
    issues.push({
      id: kind,
      category: def.category,
      severity: "warning",
      title: def.title(affected, dup.length),
      summary: def.summary,
      pagesAffected: affected,
      pagesTotal: total,
      scoreImpact: 0,
      pointsLost: 0,
      why: def.why,
      fix: { steps: def.steps, snippet: null },
      evidence,
    });
    effortById.set(kind, effortFor("page", affected));
    actionById.set(kind, def.action(affected));
    stepsById.set(kind, recommendationSteps(def.steps, false));
  }

  // Ordre : problèmes critiques, puis doublons, puis les autres ; à l'intérieur, par points perdus.
  const isDup = (id: string) => id === "duplicate_title" || id === "duplicate_description";
  const group = (i: { id: string; severity: Severity }) => (i.severity === "critical" ? 0 : isDup(i.id) ? 1 : 2);
  issues.sort((a, b) => group(a) - group(b) || b.pointsLost - a.pointsLost || b.pagesAffected - a.pagesAffected || a.id.localeCompare(b.id));
  strengths.sort((a, b) => maxOf(b.id) - maxOf(a.id) || b.pagesPassing - a.pagesPassing);

  const impactRank: Record<Impact, number> = { high: 0, medium: 1, low: 2 };
  const effortWeight = { quick: 1.5, medium: 1, heavy: 0.6 } as const;
  const recs: Recommendation[] = issues.map((i) => {
    const effort = effortById.get(i.id) ?? "medium";
    return {
      id: `rec_${i.id}`,
      issueId: i.id,
      title: actionById.get(i.id) ?? i.title,
      impact: isDup(i.id) ? "medium" : impactFor(i.pointsLost, total),
      effort,
      pagesAffected: i.pagesAffected,
      scoreGain: i.scoreImpact,
      pointsToGain: i.pointsLost,
      rank: 0,
      steps: stepsById.get(i.id) ?? i.fix.steps,
    };
  });
  const byIssue = new Map(issues.map((i) => [i.id, i]));
  const recGroup = (r: Recommendation) => (r.issueId === "indexable" ? -1 : group(byIssue.get(r.issueId)!));
  const weight = (r: Recommendation) => r.pointsToGain * effortWeight[r.effort];
  recs.sort((a, b) => recGroup(a) - recGroup(b) || impactRank[a.impact] - impactRank[b.impact] || weight(b) - weight(a) || b.pagesAffected - a.pagesAffected);
  recs.forEach((r, i) => (r.rank = i + 1));

  return { pagesTotal: total, score, categories, issues, strengths, recommendations: recs };
}

function maxOf(id: string): number {
  return CRITERIA.find((c) => c.id === id)?.max ?? 0;
}

export function toIssue(d: IssueDetail): Issue {
  const { why: _w, fix: _f, evidence: _e, ...rest } = d;
  return rest;
}
