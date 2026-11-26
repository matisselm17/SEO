import { type KeyboardEvent, type ReactNode } from "react";
import { useOverflowHint } from "./useVirtual";

export interface TabItem<T extends string> {
  id: T;
  label: ReactNode;
  count?: number;
}

/** Onglets segmentés, navigables aux flèches. */
export function Tabs<T extends string>({ items, value, onChange, label }: { items: TabItem<T>[]; value: T; onChange: (v: T) => void; label: string }) {
  const [ref, node] = useOverflowHint<HTMLDivElement>();
  const onKey = (e: KeyboardEvent) => {
    const i = items.findIndex((t) => t.id === value);
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % items.length;
    if (e.key === "ArrowLeft") next = (i - 1 + items.length) % items.length;
    if (e.key === "Home") next = 0;
    if (e.key === "End") next = items.length - 1;
    if (next >= 0) {
      e.preventDefault();
      onChange(items[next].id);
      const b = node.current?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next];
      b?.focus();
      b?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  };
  return (
    <div className="tabs scroll-hint" role="tablist" aria-label={label} ref={ref} onKeyDown={onKey}>
      {items.map((t) => (
        <button
          key={t.id}
          role="tab"
          type="button"
          aria-selected={t.id === value}
          tabIndex={t.id === value ? 0 : -1}
          className="tabs__tab"
          onClick={() => onChange(t.id)}
        >
          {t.label}
          {t.count !== undefined && <span className="tabs__count tnum">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}
