/** Actions partagées entre plusieurs écrans. */
import { sendJSON, toAppError } from "./api";
import { keys } from "./queries";
import { patchSite, invalidateSiteResults } from "./live";
import { setQueryData } from "./cache";
import type { AuditResponse } from "./types";
import type { AllPages } from "./queries";

type Toaster = { show: (t: { tone: "success" | "error" | "neutral"; title: string; text?: string | null }) => void };

export async function startAudit(siteId: string, maxPages: number | undefined, toast: Toaster): Promise<boolean> {
  try {
    const res = await sendJSON<AuditResponse>("POST", keys.audits(siteId), maxPages ? { maxPages } : {});
    patchSite(siteId, (s) => ({ ...s, audit: res.audit, score: null, pagesAnalyzed: 0 }));
    setQueryData<AllPages>(keys.allPages(siteId), { pages: [], total: 0 });
    invalidateSiteResults(siteId);
    toast.show({ tone: "success", title: "Analyse lancée", text: "Les écrans se remplissent au fil des pages." });
    return true;
  } catch (err) {
    const e = toAppError(err);
    toast.show({ tone: "error", title: e.message, text: e.action });
    return false;
  }
}
