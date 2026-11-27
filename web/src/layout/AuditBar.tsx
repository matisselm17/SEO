import { useRef, useState } from "react";
import { CircleAlert, RefreshCw, Square } from "lucide-react";
import type { AuditResponse, SiteSummary } from "../lib/types";
import { sendJSON, toAppError } from "../lib/api";
import { keys } from "../lib/queries";
import { patchSite } from "../lib/live";
import { useToast } from "../ui/Toast";
import { Button } from "../ui/Button";
import { fmtDateTime, fmtInt, pl, plural } from "../lib/format";
import { startAudit } from "../lib/actions";
import { applyAudit, isNewerAudit, resultsOf } from "../lib/results";

/** Adresse d'inventaire : un plan du site (sitemap) ou le catalogue d'une boutique. */
function isInventoryUrl(url: string) {
  try {
    const p = new URL(url).pathname.toLowerCase();
    return /sitemap[^/]*\.xml$/.test(p) || p.endsWith("/products.json");
  } catch {
    return false;
  }
}

function pathOf(url: string, withoutQuery = false) {
  try {
    const u = new URL(url);
    return decodeURIComponent(u.pathname + (withoutQuery ? "" : u.search)) || "/";
  } catch {
    return url;
  }
}

/** Dernière page lue de l'analyse : entre deux pages, le serveur n'en signale aucune, on garde la précédente. */
function useLastUrl(auditId: string | undefined, url: string | null | undefined) {
  const last = useRef<{ id?: string; url: string | null }>({ url: null });
  if (last.current.id !== auditId) last.current = { id: auditId, url: null };
  if (url) last.current.url = url;
  return last.current.url;
}

/**
 * Bandeau d'analyse, visible sur tous les écrans pendant une analyse ou après un échec.
 * Chiffres réels reçus du serveur : pages notées, en attente, en échec, page en cours.
 * Aucun pourcentage : le total n'est pas connu d'avance.
 */
export function AuditBar({ site }: { site: SiteSummary }) {
  const toast = useToast();
  const [stopping, setStopping] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const a = site.audit;
  const lastUrl = useLastUrl(a?.id, a?.currentUrl);
  if (!a) return null;
  const older = isNewerAudit(site);
  const r = resultsOf(site);
  const olderLine = older && r ? `Les résultats affichés sont ceux de l'analyse ${r.finishedAt ? `du ${fmtDateTime(r.finishedAt)}` : "précédente"}.` : null;

  if (a.state === "failed") {
    return (
      <div className="auditbar auditbar--failed" role="alert">
        <CircleAlert size={16} aria-hidden className="auditbar__icon" />
        <div className="auditbar__text">
          <p>
            <strong>{older ? "La nouvelle analyse a échoué." : "L'analyse a échoué."}</strong> {a.error?.message ?? "Le site n'a pas pu être analysé."}
            {a.error?.action && <span className="auditbar__muted"> {a.error.action}</span>}
          </p>
          {olderLine && <p className="auditbar__note">{olderLine}</p>}
        </div>
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
      patchSite(site.id, (s) => applyAudit(s, res.audit, undefined));
      toast.show({
        tone: "neutral",
        title: "Analyse arrêtée",
        text: older
          ? "Les résultats de l'analyse précédente restent affichés."
          : `${plural(res.audit.pagesDone, "page notée est conservée", "pages notées sont conservées")}.`,
      });
    } catch (err) {
      const e = toAppError(err);
      toast.show({ tone: "error", title: e.message, text: e.action });
    } finally {
      setStopping(false);
    }
  };

  // Avant la première page, le serveur lit le plan du site (sitemap) ou le catalogue de la boutique.
  const inventorying = a.state === "running" && a.pagesDone === 0 && !!lastUrl && isInventoryUrl(lastUrl);
  const title = a.state === "queued"
    ? (older ? "Nouvelle analyse en file d'attente" : "Analyse en file d'attente")
    : inventorying
    ? "Inventaire du site en cours"
    : older ? "Nouvelle analyse en cours" : "Analyse en cours";

  return (
    <div className="auditbar" role="status" aria-live="off">
      <span className="live-dot" aria-hidden />
      <div className="auditbar__main">
        <p className="auditbar__title">
          {title}
          {!inventorying && <span className="auditbar__counts">
            <span><strong className="tnum">{fmtInt(a.pagesDone)}</strong> {pl(a.pagesDone, "page notée", "pages notées")}</span>
            <span><strong className="tnum">{fmtInt(a.pagesQueued)}</strong> en attente</span>
            {a.pagesFailed > 0 && <span className="auditbar__failed"><strong className="tnum">{fmtInt(a.pagesFailed)}</strong> en échec</span>}
            <span className="auditbar__muted">plafond {fmtInt(a.maxPages)}</span>
          </span>}
        </p>
        {olderLine ? (
          <p className="auditbar__url auditbar__url--wrap">{olderLine} Ils seront remplacés à la fin.</p>
        ) : (
          <p className={`auditbar__url ${inventorying ? "auditbar__url--wrap" : ""}`} title={lastUrl ?? undefined}>
            {inventorying && lastUrl ? (
              <>Lecture de <span className="mono">{pathOf(lastUrl, true)}</span> pour recenser les pages. La première page peut mettre un moment à arriver.</>
            ) : lastUrl ? (
              <>Lecture de <span className="mono">{pathOf(lastUrl)}</span></>
            ) : a.state === "queued" ? "Elle démarre dès qu'une autre analyse se termine." : "Démarrage…"}
          </p>
        )}
      </div>
      <Button size="sm" variant="ghost" icon={<Square size={12} aria-hidden fill="currentColor" />} onClick={stop} loading={stopping}>
        Arrêter
      </Button>
    </div>
  );
}
