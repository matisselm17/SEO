import { ChevronLeft, ChevronRight } from "lucide-react";
import { fmtInt } from "../lib/format";
import { Button } from "./Button";

/** Pagination d'une liste servie par tranches : « 51 à 100 sur 240 », précédent, suivant. */
export function Pagination({ offset, limit, total, onChange, label }: { offset: number; limit: number; total: number; onChange: (offset: number) => void; label: string }) {
  if (total <= limit && offset === 0) return null;
  const end = Math.min(total, offset + limit);
  return (
    <nav className="pager" aria-label={label}>
      <p className="pager__range tnum">{fmtInt(total === 0 ? 0 : offset + 1)} à {fmtInt(end)} sur {fmtInt(total)}</p>
      <div className="pager__btns">
        <Button size="sm" variant="secondary" icon={<ChevronLeft size={15} aria-hidden />} disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>Précédents</Button>
        <Button size="sm" variant="secondary" iconRight={<ChevronRight size={15} aria-hidden />} disabled={end >= total} onClick={() => onChange(offset + limit)}>Suivants</Button>
      </div>
    </nav>
  );
}
