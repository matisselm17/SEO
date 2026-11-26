/** Actions partagées entre plusieurs écrans. */
import { sendJSON, toAppError } from "./api";
import { keys } from "./queries";
import { patchSite, invalidateSiteResults } from "./live";
import { invalidate } from "./cache";
import { applyAudit, resultsOf } from "./results";
import type { AuditResponse, SiteSummary } from "./types";

type Toaster = { show: (t: { tone: "success" | "error" | "neutral"; title: string; text?: string | null }) => void };

export async function startAudit(siteId: string, maxPages: number | undefined, toast: Toaster): Promise<boolean> {
  try {
    const res = await sendJSON<AuditResponse>("POST", keys.audits(siteId), maxPages ? { maxPages } : {});
    let after: SiteSummary | null = null;
    patchSite(siteId, (s) => (after = applyAudit(s, res.audit, undefined)));
    const kept = after ? resultsOf(after) : null;
    if (!kept) invalidateSiteResults(siteId);
    invalidate(keys.sites);
    toast.show({
      tone: "success",
      title: "Analyse lancée",
      text: kept ? "Les résultats actuels restent affichés jusqu'à la fin de la nouvelle analyse." : "Les écrans se remplissent au fil des pages.",
    });
    return true;
  } catch (err) {
    const e = toAppError(err);
    toast.show({ tone: "error", title: e.message, text: e.action });
    return false;
  }
}
