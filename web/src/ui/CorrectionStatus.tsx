import { CircleAlert, CircleCheck, CircleDashed, LoaderCircle, PenLine, TriangleAlert, Undo2 } from "lucide-react";
import type { ShopifyCorrectionStatus } from "../lib/types";

/**
 * Où en est une correction, du problème détecté à la vérification sur la page publique.
 * "detected" : un problème de l'analyse ; "proposed" : une ligne d'un lot à valider ; les autres : ShopifyChange.correctionStatus.
 */
export type CorrectionStep = "detected" | "proposed" | ShopifyCorrectionStatus;

const STEP: Record<CorrectionStep, { label: string; tone: "warning" | "accent" | "info" | "good" | "critical" | "neutral"; Icon: typeof CircleCheck }> = {
  detected: { label: "Problème détecté", tone: "warning", Icon: TriangleAlert },
  proposed: { label: "Correction proposée", tone: "accent", Icon: PenLine },
  applied: { label: "Correction appliquée", tone: "info", Icon: CircleDashed },
  verifying: { label: "Vérification en cours…", tone: "info", Icon: LoaderCircle },
  verified: { label: "Correction vérifiée", tone: "good", Icon: CircleCheck },
  failed: { label: "Correction échouée", tone: "critical", Icon: CircleAlert },
  cancelled: { label: "Correction annulée", tone: "neutral", Icon: Undo2 },
};

export const CORRECTION_LABEL = (s: CorrectionStep) => STEP[s].label;

/** Pastille de statut : une icône et un mot, la couleur ne fait que les compléter. */
export function CorrectionStatus({ status }: { status: CorrectionStep }) {
  const s = STEP[status];
  return (
    <span className={`badge badge--${s.tone} cstatus`}>
      <s.Icon size={13} strokeWidth={2.25} aria-hidden className={status === "verifying" ? "btn__spin" : undefined} />
      <span>{s.label}</span>
    </span>
  );
}
