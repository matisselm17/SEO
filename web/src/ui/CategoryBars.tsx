import type { CategoryScore } from "../lib/types";
import { CATEGORY_HINT, scoreBand } from "../lib/score";
import { fmtDec } from "../lib/format";
import { Meter } from "./Meter";

/** Les cinq familles de la grille, chacune avec ses points sur son maximum. */
export function CategoryBars({ categories, compact }: { categories: CategoryScore[]; compact?: boolean }) {
  return (
    <ul className={`cats ${compact ? "cats--compact" : ""}`}>
      {categories.map((c) => {
        const ratio = c.max ? c.score / c.max : 0;
        const band = scoreBand(Math.round(ratio * 100));
        return (
          <li key={c.id} className="cats__row">
            <div className="cats__head">
              <span className="cats__label">{c.label}</span>
              <span className="cats__value tnum">
                {fmtDec(c.score)}
                <span className="cats__max"> / {c.max}</span>
              </span>
            </div>
            <Meter value={c.score} max={c.max} tone={band} label={`${c.label} : ${fmtDec(c.score)} points sur ${c.max}`} />
            {!compact && <p className="cats__hint">{CATEGORY_HINT[c.id]}</p>}
          </li>
        );
      })}
    </ul>
  );
}
