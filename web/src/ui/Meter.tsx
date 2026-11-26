import type { ScoreBand } from "../lib/score";

/** Barre de proportion fine (pages touchées, points d'une famille). */
export function Meter({ value, max, tone = "neutral", label }: { value: number; max: number; tone?: ScoreBand | "neutral" | "accent"; label?: string }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <span className={`meter meter--${tone}`} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <span className="meter__fill" style={{ width: `${pct}%` }} />
    </span>
  );
}
