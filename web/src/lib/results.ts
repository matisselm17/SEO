/**
 * « Quelle analyse est affichée » (docs/format-echange.md) :
 * les écrans de résultats portent sur `site.results`, la nouvelle analyse est décrite par `site.audit`.
 */
import type { AuditStatus, SiteSummary } from "./types";
import { fmtDateTime } from "./format";

export type Results = NonNullable<SiteSummary["results"]>;

export function resultsFromAudit(a: AuditStatus): Results {
  return { auditId: a.id, state: a.state, finishedAt: a.finishedAt, pagesDone: a.pagesDone, pagesFailed: a.pagesFailed };
}

/** Résultats affichés. Tolère un serveur antérieur au champ `results` (déduit de l'analyse). */
export function resultsOf(site: SiteSummary): Results | null {
  if (site.results !== undefined) return site.results;
  const a = site.audit;
  return a && a.pagesDone > 0 ? resultsFromAudit(a) : null;
}

export function isActive(a: AuditStatus | null | undefined): boolean {
  return !!a && (a.state === "running" || a.state === "queued");
}

/** Une analyse plus récente que celle affichée existe (en cours, arrêtée ou en échec). */
export function isNewerAudit(site: SiteSummary): boolean {
  const r = resultsOf(site);
  return !!r && !!site.audit && site.audit.id !== r.auditId;
}

/** Relance en cours : les résultats affichés sont ceux d'une analyse précédente. */
export function isRelaunching(site: SiteSummary): boolean {
  return isNewerAudit(site) && isActive(site.audit);
}

/** Pourquoi aucun résultat n'est affiché. null si des résultats existent. */
export type NoResultsReason = "running" | "failed" | "cancelled" | "none";
export function noResultsReason(site: SiteSummary): NoResultsReason | null {
  if (resultsOf(site)) return null;
  const a = site.audit;
  if (!a) return "none";
  if (isActive(a)) return "running";
  if (a.state === "cancelled") return "cancelled";
  return "failed";
}

/** Plus de pages en échec que de pages notées : la note ne représente pas le site. */
export function isUnreliable(site: SiteSummary): boolean {
  const r = resultsOf(site);
  return !!r && r.pagesFailed > r.pagesDone;
}

/** « du 26 novembre à 14:01 » : date de l'analyse affichée. */
export function resultsDate(site: SiteSummary): string | null {
  const r = resultsOf(site);
  if (!r?.finishedAt) return null;
  return fmtDateTime(r.finishedAt);
}

/**
 * Applique un changement d'analyse reçu en direct au résumé du site, selon la règle du format :
 * une analyse terminée devient l'analyse affichée ; une analyse en cours, arrêtée ou en échec ne remplace
 * jamais une analyse terminée, mais remplace une analyse non terminée dès qu'elle a une page notée.
 */
export function applyAudit(site: SiteSummary, audit: AuditStatus, score: number | null | undefined): SiteSummary {
  const prev = resultsOf(site);
  let results = prev;
  let s = site.score;
  const takeOver = audit.state === "done" || prev?.auditId === audit.id || ((!prev || prev.state !== "done") && audit.pagesDone > 0);
  if (takeOver) {
    results = resultsFromAudit(audit);
    if (score !== undefined) s = score;
  }
  return { ...site, audit, results, score: results ? s : null, pagesAnalyzed: results ? results.pagesDone : 0 };
}
