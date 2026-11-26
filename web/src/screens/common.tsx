import { useState } from "react";
import { RefreshCw } from "lucide-react";
import type { UseQueryResult } from "../lib/cache";
import type { SiteSummary } from "../lib/types";
import { ErrorState } from "../ui/States";
import { Button } from "../ui/Button";
import { useToast } from "../ui/Toast";
import { startAudit } from "../lib/actions";
import { fmtDuration, fmtInt, fmtRelative, plural } from "../lib/format";

/** Erreur de chargement : bloc si rien n'est affiché, bandeau si une donnée reste à l'écran. */
export function QueryError<T>({ q }: { q: UseQueryResult<T> }) {
  if (!q.error) return null;
  return <ErrorState error={q.error} inline={q.data !== undefined} onRetry={() => void q.refetch()} retrying={q.fetching} />;
}

export function isRunning(site: SiteSummary) {
  return site.audit?.state === "running" || site.audit?.state === "queued";
}

/** Phrase d'état de la dernière analyse, pour l'en-tête des écrans. */
export function auditLine(site: SiteSummary): string {
  const a = site.audit;
  if (!a) return "Aucune analyse pour l'instant.";
  if (a.state === "queued") return "Analyse en file d'attente : elle démarre dans un instant.";
  if (a.state === "running") return `Analyse en cours, lancée ${fmtRelative(a.startedAt)}. ${plural(a.pagesDone, "page notée", "pages notées")} jusqu'ici.`;
  if (a.state === "failed") return "La dernière analyse a échoué.";
  const when = a.finishedAt ? fmtRelative(a.finishedAt) : fmtRelative(a.startedAt);
  const pages = plural(a.pagesDone, "page", "pages");
  const dur = a.finishedAt ? ` en ${fmtDuration(a.startedAt, a.finishedAt)}` : "";
  const failed = a.pagesFailed ? `, ${fmtInt(a.pagesFailed)} en échec` : "";
  if (a.state === "cancelled") return `Analyse arrêtée ${when} : ${pages} notées${failed}.`;
  return `Analyse terminée ${when} : ${pages}${dur}${failed}.`;
}

export function RelaunchButton({ site, variant = "secondary" }: { site: SiteSummary; variant?: "secondary" | "ghost" | "primary" }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (isRunning(site)) return null;
  return (
    <Button
      variant={variant}
      icon={<RefreshCw size={15} aria-hidden />}
      loading={busy}
      onClick={async () => {
        setBusy(true);
        await startAudit(site.id, undefined, toast);
        setBusy(false);
      }}
    >
      Relancer l'analyse
    </Button>
  );
}
