import { useState } from "react";
import { CircleAlert, RefreshCw, Square } from "lucide-react";
import type { AuditResponse, SiteSummary } from "../lib/types";
import { sendJSON, toAppError } from "../lib/api";
import { keys } from "../lib/queries";
import { patchSite } from "../lib/live";
import { useToast } from "../ui/Toast";
import { Button } from "../ui/Button";
import { fmtInt, plural } from "../lib/format";
import { startAudit } from "../lib/actions";

function pathOf(url: string) {
  try {
    const u = new URL(url);
    return decodeURIComponent(u.pathname + u.search) || "/";
  } catch {
    return url;
  }
}

/**
 * Bandeau d'analyse, visible sur tous les écrans pendant une analyse.
 * Chiffres réels reçus du serveur : pages notées, en attente, en échec, page en cours.
 * Aucun pourcentage : le total n'est pas connu d'avance.
 */
export function AuditBar({ site }: { site: SiteSummary }) {
  const toast = useToast();
  const [stopping, setStopping] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const a = site.audit;
  if (!a) return null;

  if (a.state === "failed") {
    return (
      <div className="auditbar auditbar--failed" role="alert">
        <CircleAlert size={16} aria-hidden className="auditbar__icon" />
        <p className="auditbar__text">
          <strong>L'analyse a échoué.</strong> {a.error?.message ?? "Le site n'a pas pu être analysé."}
          {a.error?.action && <span className="auditbar__muted"> {a.error.action}</span>}
        </p>
        <Button
          size="sm"
          icon={<RefreshCw size={14} aria-hidden />}
          loading={retrying}
          onClick={async () => {
            setRetrying(true);
            await startAudit(site.id, undefined, toast);
            setRetrying(false);
          }}
        >
          Relancer l'analyse
        </Button>
      </div>
    );
  }

  if (a.state !== "running" && a.state !== "queued") return null;

  const stop = async () => {
    setStopping(true);
    try {
      const res = await sendJSON<AuditResponse>("POST", `${keys.audits(site.id)}/cancel`);
      patchSite(site.id, (s) => ({ ...s, audit: res.audit }));
      toast.show({ tone: "neutral", title: "Analyse arrêtée", text: `${plural(res.audit.pagesDone, "page notée est conservée", "pages notées sont conservées")}.` });
    } catch (err) {
      const e = toAppError(err);
      toast.show({ tone: "error", title: e.message, text: e.action });
    } finally {
      setStopping(false);
    }
  };

  return (
    <div className="auditbar" role="status" aria-live="off">
      <span className="live-dot" aria-hidden />
      <div className="auditbar__main">
        <p className="auditbar__title">
          {a.state === "queued" ? "Analyse en file d'attente" : "Analyse en cours"}
          <span className="auditbar__counts">
            <span><strong className="tnum">{fmtInt(a.pagesDone)}</strong> {a.pagesDone > 1 ? "pages notées" : "page notée"}</span>
            <span><strong className="tnum">{fmtInt(a.pagesQueued)}</strong> en attente</span>
            {a.pagesFailed > 0 && <span className="auditbar__failed"><strong className="tnum">{fmtInt(a.pagesFailed)}</strong> en échec</span>}
            <span className="auditbar__muted">plafond {fmtInt(a.maxPages)}</span>
          </span>
        </p>
        <p className="auditbar__url" title={a.currentUrl ?? undefined}>
          {a.currentUrl ? <>Lecture de <span className="mono">{pathOf(a.currentUrl)}</span></> : "Préparation…"}
        </p>
      </div>
      <Button size="sm" variant="ghost" icon={<Square size={12} aria-hidden fill="currentColor" />} onClick={stop} loading={stopping}>
        Arrêter
      </Button>
    </div>
  );
}
