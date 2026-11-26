import { useId, useState, type ReactNode } from "react";
import { ChevronDown, CircleAlert, CirclePause, Play, RefreshCw, TriangleAlert } from "lucide-react";
import type { UseQueryResult } from "../lib/cache";
import type { SiteSummary } from "../lib/types";
import { ErrorState, EmptyState } from "../ui/States";
import { Button } from "../ui/Button";
import { useToast } from "../ui/Toast";
import { startAudit } from "../lib/actions";
import { useFailedPages } from "../lib/queries";
import { fmtDateTime, fmtDuration, fmtInt, fmtRelative, pl, plural } from "../lib/format";
import { isActive, isUnreliable, noResultsReason, resultsOf } from "../lib/results";

/**
 * Erreur de chargement : bloc si rien n'est affiché, bandeau si une donnée reste à l'écran.
 * Une coupure réseau avec une donnée déjà affichée n'est pas répétée ici : l'indicateur
 * « Connexion au serveur perdue » en haut de l'écran la signale une seule fois.
 */
export function QueryError<T>({ q }: { q: UseQueryResult<T> }) {
  if (!q.error) return null;
  if (q.data !== undefined && q.error.code === "network") return null;
  return <ErrorState error={q.error} inline={q.data !== undefined} onRetry={() => void q.refetch()} retrying={q.fetching} />;
}

export function isRunning(site: SiteSummary) {
  return isActive(site.audit);
}

/** Phrase d'état de l'analyse affichée, pour l'en-tête des écrans. Mêmes nombres que le bandeau d'analyse. */
export function auditLine(site: SiteSummary): string {
  const a = site.audit;
  const r = resultsOf(site);
  if (!r) {
    if (!a) return "Aucune analyse pour l'instant.";
    if (a.state === "queued") return "Première analyse en file d'attente : elle démarre dans un instant.";
    if (a.state === "running") return `Première analyse en cours, lancée ${fmtRelative(a.startedAt)}.`;
    if (a.state === "cancelled") return "Analyse arrêtée avant la première page notée.";
    return "La dernière analyse a échoué : aucune page n'a pu être notée.";
  }
  const failed = r.pagesFailed ? `, ${plural(r.pagesFailed, "page non chargée", "pages non chargées")}` : "";
  if (a && a.id === r.auditId) {
    const when = a.finishedAt ? fmtRelative(a.finishedAt) : fmtRelative(a.startedAt);
    if (a.state === "queued" || a.state === "running") return `Analyse en cours, lancée ${fmtRelative(a.startedAt)} : ${plural(a.pagesDone, "page notée", "pages notées")} jusqu'ici.`;
    if (a.state === "cancelled") return `Analyse arrêtée ${when} : ${plural(a.pagesDone, "page notée", "pages notées")} avant l'arrêt${failed}.`;
    if (a.state === "failed") return `Analyse interrompue ${when} : ${plural(a.pagesDone, "page notée", "pages notées")} avant l'interruption${failed}.`;
    const dur = a.finishedAt ? ` en ${fmtDuration(a.startedAt, a.finishedAt)}` : "";
    return `Analyse terminée ${when} : ${plural(a.pagesDone, "page analysée", "pages analysées")}${dur}${failed}.`;
  }
  // Une analyse plus récente existe (en cours, arrêtée ou en échec) : les résultats sont ceux d'avant.
  const date = r.finishedAt ? ` du ${fmtDateTime(r.finishedAt)}` : " précédente";
  const base = `Résultats de l'analyse${date} : ${plural(r.pagesDone, "page analysée", "pages analysées")}${failed}.`;
  if (a?.state === "cancelled") return `${base} La nouvelle analyse a été arrêtée avant la fin et ne les remplace pas.`;
  return base;
}

/**
 * « Relancer l'analyse » dans l'en-tête des écrans. Absent quand l'action est déjà proposée ailleurs :
 * analyse en cours (bandeau « Arrêter »), en échec (bandeau ou bloc d'échec), ou aucun résultat (bloc vide).
 */
export function RelaunchButton({ site, variant = "secondary" }: { site: SiteSummary; variant?: "secondary" | "ghost" | "primary" }) {
  if (isRunning(site) || site.audit?.state === "failed" || !resultsOf(site)) return null;
  return <RelaunchAction site={site} variant={variant} />;
}

function RelaunchAction({ site, variant, label = "Relancer l'analyse" }: { site: SiteSummary; variant: "secondary" | "ghost" | "primary"; label?: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant={variant}
      icon={label === "Lancer l'analyse" ? <Play size={15} aria-hidden /> : <RefreshCw size={15} aria-hidden />}
      loading={busy}
      onClick={async () => {
        setBusy(true);
        await startAudit(site.id, undefined, toast);
        setBusy(false);
      }}
    >
      {label}
    </Button>
  );
}

/**
 * Section de résultats sans aucune page notée (`results` null) : jamais « aucun problème ».
 * Dit pourquoi — analyse en cours, en échec (avec son message) ou arrêtée — et propose de relancer.
 */
export function NoResults({ site, running }: { site: SiteSummary; running: ReactNode }) {
  const reason = noResultsReason(site);
  if (!reason) return null;
  if (reason === "running") {
    return <EmptyState title="Les premiers résultats arrivent">{running}</EmptyState>;
  }
  const err = site.audit?.error;
  if (reason === "failed") {
    return (
      <EmptyState
        tone="framed"
        icon={<CircleAlert size={20} className="tone-critical" />}
        title="Aucune page analysée : l'analyse a échoué"
        actions={<RelaunchAction site={site} variant="primary" />}
      >
        <p>{err?.message ?? "Le site n'a pas pu être analysé."}</p>
        {err?.action && <p>{err.action}</p>}
      </EmptyState>
    );
  }
  if (reason === "cancelled") {
    return (
      <EmptyState tone="framed" icon={<CirclePause size={20} />} title="Aucune page analysée" actions={<RelaunchAction site={site} variant="primary" />}>
        L'analyse a été arrêtée avant que la première page soit notée. Relancez-la pour obtenir la note, les problèmes et les actions.
      </EmptyState>
    );
  }
  return (
    <EmptyState tone="framed" title="Aucune analyse pour l'instant" actions={<RelaunchAction site={site} variant="primary" label="Lancer l'analyse" />}>
      Lancez une analyse : chaque page sera lue et notée sur 100.
    </EmptyState>
  );
}

/** Liste repliable des pages non chargées de l'analyse affichée, avec leur raison. */
export function FailedPagesToggle({ site, count, label }: { site: SiteSummary; count: number; label?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const q = useFailedPages(site.id, open);
  const [shown, setShown] = useState(20);
  const pages = q.data?.pages;
  return (
    <div className={`failed ${open ? "is-open" : ""}`}>
      <button type="button" className="failed__toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        <span>{label ?? `${plural(count, "page n'a pas pu être lue", "pages n'ont pas pu être lues")}`}</span>
        <span className="failed__see">{open ? "Masquer" : count > 1 ? "Voir lesquelles" : "Voir laquelle"}</span>
        <ChevronDown size={14} className="failed__chev" aria-hidden />
      </button>
      {open && (
        <div id={id} className="failed__panel">
          {q.error && !pages && <ErrorState error={q.error} inline onRetry={() => void q.refetch()} retrying={q.fetching} />}
          {!pages && !q.error && <p className="muted small">Chargement de la liste…</p>}
          {pages && pages.length === 0 && <p className="muted small">La liste n'est plus disponible pour cette analyse.</p>}
          {pages && pages.length > 0 && (
            <>
              <ul className="failed__list">
                {pages.slice(0, shown).map((p) => (
                  <li key={p.url} className="failed__row">
                    <span className="failed__path mono" title={p.url}>{p.path}</span>
                    <span className="failed__reason">{p.reason}</span>
                  </li>
                ))}
              </ul>
              {pages.length > shown && (
                <button type="button" className="link-btn small" onClick={() => setShown((s) => s + 50)}>
                  Afficher {fmtInt(Math.min(50, pages.length - shown))} de plus ({fmtInt(pages.length - shown)} restantes)
                </button>
              )}
              <p className="failed__hint">Ces pages ne comptent pas dans la note. Vérifiez qu'elles s'ouvrent dans un navigateur, puis relancez l'analyse.</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Plus de pages en échec que de pages notées : la note ne représente pas le site. */
export function ReliabilityNote({ site, compact }: { site: SiteSummary; compact?: boolean }) {
  const r = resultsOf(site);
  if (!r || !isUnreliable(site)) return null;
  return (
    <div className={`notice notice--warning ${compact ? "notice--compact" : ""}`} role="note">
      <TriangleAlert size={16} className="notice__icon" aria-hidden />
      <div className="notice__body">
        <p className="notice__title">Note peu fiable</p>
        <p className="notice__text">
          {plural(r.pagesFailed, "page n'a", "pages n'ont")} pas pu être {pl(r.pagesFailed, "lue", "lues")}, contre {plural(r.pagesDone, "page notée", "pages notées")}. La note et les problèmes ne portent que sur une petite partie du site.
        </p>
        {!compact && <FailedPagesToggle site={site} count={r.pagesFailed} label="Pages non chargées" />}
      </div>
    </div>
  );
}
