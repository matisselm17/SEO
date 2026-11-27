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
import type { CatalogueProduct } from "../crawl/shopify.ts";
import { CATALOGUE, CATALOGUE_ISSUES, CATALOGUE_THRESHOLDS, DUPLICATES, effortFor, issueSteps, recommendationSteps } from "./catalogue.ts";
import { CATEGORIES, CRITERIA, cut, type PageFacts } from "./grille.ts";

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

/**
 * `catalogue` : produits lus dans le catalogue de la boutique sans que leur page soit ouverte (null s'il n'a pas été lu).
 * Leurs constats (basis « catalogue ») ne changent jamais la note.
 */
export function aggregate(pages: PageRecord[], siteName: string, catalogue: CatalogueProduct[] | null = null): SiteAggregate {
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
      basis: "pages",
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
      basis: "pages",
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

  const fromCatalogue = catalogue?.length ? catalogueIssues(catalogue) : [];
  for (const c of fromCatalogue) {
    issues.push(c.issue);
    effortById.set(c.issue.id, effortFor("page", c.issue.pagesAffected));
    actionById.set(c.issue.id, c.action);
    stepsById.set(c.issue.id, recommendationSteps(c.issue.fix.steps, false));
  }

  // Ordre : problèmes critiques, puis doublons, puis les autres ; à l'intérieur, par points perdus.
  // Les constats du catalogue viennent après tous ceux des pages (« warning » puis « info »).
  const isDup = (id: string) => id === "duplicate_title" || id === "duplicate_description" || id === "catalogue_duplicate_title" || id === "catalogue_duplicate_description";
  const group = (i: { id: string; severity: Severity; basis: Issue["basis"] }) =>
    i.basis === "catalogue" ? (i.severity === "info" ? 4 : 3) : i.severity === "critical" ? 0 : isDup(i.id) ? 1 : 2;
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
      impact: isDup(i.id) ? "medium" : i.basis === "catalogue" ? "low" : impactFor(i.pointsLost, total),
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

/** Constats sur les produits lus dans le catalogue : preuves sans page analysée (pageId null). */
function catalogueIssues(products: CatalogueProduct[]): Array<{ issue: IssueDetail; action: string }> {
  const total = products.length;
  const out: Array<{ issue: IssueDetail; action: string }> = [];
  const T = CATALOGUE_THRESHOLDS;
  const push = (id: keyof typeof CATALOGUE_ISSUES, evidence: Evidence[], affected: number, groups?: number) => {
    if (!affected) return;
    const def = CATALOGUE_ISSUES[id];
    out.push({
      issue: {
        id,
        category: def.category,
        severity: def.severity,
        title: def.title(affected, groups),
        summary: def.summary,
        basis: "catalogue",
        pagesAffected: affected,
        pagesTotal: total,
        scoreImpact: 0,
        pointsLost: 0,
        why: def.why,
        fix: { steps: def.steps, snippet: null },
        evidence: evidence.slice(0, MAX_EVIDENCE),
      },
      action: def.action(affected),
    });
  };
  const ev = (p: CatalogueProduct, found: string, expected: string): Evidence => ({ pageId: null, url: p.url, path: p.path, found, expected });

  // Nom (titre par défaut dans Google) : les plus éloignés de la fourchette d'abord.
  const titleBad = products
    .filter((p) => p.title.length < T.titleMin || p.title.length > T.titleMax)
    .sort((a, b) => distance(b.title.length) - distance(a.title.length) || a.path.localeCompare(b.path));
  push(
    "catalogue_title",
    titleBad.map((p) =>
      ev(p, p.title ? `Nom « ${cut(p.title, 80)} » (${p.title.length} caractères)` : "Aucun nom", `Entre ${T.titleMin} et ${T.titleMax} caractères (idéalement 30 à 60)`),
    ),
    titleBad.length,
  );

  // Description : absente d'abord, puis la plus courte.
  const descBad = products.filter((p) => p.descWords < T.descMinWords).sort((a, b) => a.descWords - b.descWords || a.path.localeCompare(b.path));
  push(
    "catalogue_description",
    descBad.map((p) =>
      ev(p, p.descWords ? `Description de ${p.descWords} ${p.descWords > 1 ? "mots" : "mot"} : « ${cut(p.descExcerpt, 90)} »` : "Aucune description", `Au moins ${T.descMinWords} mots qui décrivent le produit`),
    ),
    descBad.length,
  );

  // Images sans texte alternatif.
  const altBad = products.filter((p) => p.imagesNoAltCount > 0).sort((a, b) => b.imagesNoAltCount - a.imagesNoAltCount || a.path.localeCompare(b.path));
  push(
    "catalogue_image_alt",
    altBad.map((p) =>
      ev(p, `${p.imagesNoAltCount} ${p.imagesNoAltCount > 1 ? "images" : "image"} sur ${p.images} sans texte alternatif`, "Un texte alternatif pour chaque image"),
    ),
    altBad.length,
  );

  // Doublons de nom et de description, entre produits lus dans le catalogue.
  const dupes = (pick: (p: CatalogueProduct) => string | null) => {
    const groups = new Map<string, CatalogueProduct[]>();
    for (const p of products) {
      const k = pick(p);
      if (!k) continue;
      const list = groups.get(k) ?? [];
      list.push(p);
      groups.set(k, list);
    }
    return [...groups.values()].filter((g) => g.length > 1).sort((a, b) => b.length - a.length || a[0].path.localeCompare(b[0].path));
  };
  const sameTitle = dupes((p) => p.title.trim().replace(/\s+/g, " ").toLowerCase() || null);
  push(
    "catalogue_duplicate_title",
    sameTitle.flatMap((g) => g.map((p) => ev(p, `« ${cut(p.title, 90)} », identique sur ${g.length} produits`, "Un nom propre à chaque produit"))),
    sameTitle.reduce((a, g) => a + g.length, 0),
    sameTitle.length,
  );
  const sameDesc = dupes((p) => p.descHash);
  push(
    "catalogue_duplicate_description",
    sameDesc.flatMap((g) => g.map((p) => ev(p, `« ${cut(p.descExcerpt, 90)} », identique sur ${g.length} produits`, "Une description propre à chaque produit"))),
    sameDesc.reduce((a, g) => a + g.length, 0),
    sameDesc.length,
  );
  return out;
}

function distance(len: number): number {
  const T = CATALOGUE_THRESHOLDS;
  return len < T.titleMin ? T.titleMin - len : len > T.titleMax ? len - T.titleMax : 0;
}

function maxOf(id: string): number {
  return CRITERIA.find((c) => c.id === id)?.max ?? 0;
}

export function toIssue(d: IssueDetail): Issue {
  const { why: _w, fix: _f, evidence: _e, ...rest } = d;
  return rest;
}
