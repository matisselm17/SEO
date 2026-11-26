import { CircleCheck, CircleMinus, Info, OctagonAlert, TriangleAlert } from "lucide-react";
import type { CheckStatus, Severity } from "../lib/types";
import { SEVERITY_LABEL, scoreBand, type ScoreBand } from "../lib/score";

const SEV_ICON = { critical: OctagonAlert, warning: TriangleAlert, info: Info } as const;

/** Gravité : toujours une icône et un mot, jamais la couleur seule. */
export function SeverityBadge({ severity, compact }: { severity: Severity; compact?: boolean }) {
  const Icon = SEV_ICON[severity];
  return (
    <span className={`badge badge--${severity}`} title={compact ? SEVERITY_LABEL[severity] : undefined}>
      <Icon size={13} strokeWidth={2.25} aria-hidden />
      {compact ? <span className="sr-only">{SEVERITY_LABEL[severity]}</span> : <span>{SEVERITY_LABEL[severity]}</span>}
    </span>
  );
}

const STATUS = {
  pass: { label: "Validé", Icon: CircleCheck, tone: "good" },
  warn: { label: "À revoir", Icon: TriangleAlert, tone: "warning" },
  fail: { label: "Manquant", Icon: CircleMinus, tone: "critical" },
} as const;

export function CheckBadge({ status }: { status: CheckStatus }) {
  const s = STATUS[status];
  return (
    <span className={`badge badge--${s.tone}`}>
      <s.Icon size={13} strokeWidth={2.25} aria-hidden />
      <span>{s.label}</span>
    </span>
  );
}

const BAND_LABEL: Record<ScoreBand, string> = { good: "bonne note", warning: "note moyenne", critical: "note faible" };

/** Note d'une page : le chiffre porte l'information, la pastille de couleur la complète. */
export function ScorePill({ score, size = "md" }: { score: number; size?: "md" | "lg" }) {
  const band = scoreBand(score);
  return (
    <span className={`score-pill score-pill--${band} score-pill--${size}`} aria-label={`${score} sur 100, ${BAND_LABEL[band]}`}>
      <span className="score-pill__dot" aria-hidden />
      <span className="tnum">{score}</span>
    </span>
  );
}

export function Tag({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "accent" | "good" | "warning" | "critical" }) {
  return <span className={`tag tag--${tone}`}>{children}</span>;
}
