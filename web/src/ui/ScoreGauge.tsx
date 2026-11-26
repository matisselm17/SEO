import { useEffect, useState } from "react";
import { scoreBand, scoreVerdict } from "../lib/score";

const SWEEP = 240; // degrés

function polar(cx: number, cy: number, r: number, deg: number) {
  const a = ((deg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}
function arc(cx: number, cy: number, r: number, from: number, to: number) {
  const s = polar(cx, cy, r, to);
  const e = polar(cx, cy, r, from);
  const large = to - from <= 180 ? 0 : 1;
  return `M ${s.x} ${s.y} A ${r} ${r} 0 ${large} 0 ${e.x} ${e.y}`;
}

/** Jauge de note sur 100. La couleur suit la tranche, le chiffre et le verdict portent l'information. */
export function ScoreGauge({ score, size = 176, label = "Note du site" }: { score: number | null; size?: number; label?: string }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const r = requestAnimationFrame(() => setShown(score ?? 0));
    return () => cancelAnimationFrame(r);
  }, [score]);
  const stroke = Math.max(8, Math.round(size * 0.06));
  const r = size / 2 - stroke / 2 - 2;
  const c = size / 2;
  const start = -SWEEP / 2;
  const end = SWEEP / 2;
  const path = arc(c, c, r, start, end);
  const length = (Math.PI * 2 * r * SWEEP) / 360;
  const band = score === null ? "none" : scoreBand(score);
  const h = size * 0.86;
  return (
    <div className={`gauge gauge--${band}`} style={{ width: size, height: h }} role="img" aria-label={score === null ? `${label} : pas encore calculée` : `${label} : ${score} sur 100, ${scoreVerdict(score)}`}>
      <svg width={size} height={h} viewBox={`0 0 ${size} ${h}`} aria-hidden>
        <path d={path} className="gauge__track" strokeWidth={stroke} fill="none" strokeLinecap="round" />
        {/* Repères des seuils 50 et 70 */}
        {[50, 70].map((t) => {
          const deg = start + (SWEEP * t) / 100;
          const p1 = polar(c, c, r - stroke / 2 - 3, deg);
          const p2 = polar(c, c, r - stroke / 2 - 7, deg);
          return <line key={t} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} className="gauge__tick" />;
        })}
        {score !== null && (
          <path
            d={path}
            className="gauge__value"
            strokeWidth={stroke}
            fill="none"
            strokeLinecap="round"
            strokeDasharray={length}
            strokeDashoffset={length * (1 - shown / 100)}
          />
        )}
      </svg>
      <div className="gauge__center">
        <span className="gauge__num tnum" style={{ fontSize: size * 0.3 }}>{score ?? "–"}</span>
        <span className="gauge__max">sur 100</span>
      </div>
    </div>
  );
}
