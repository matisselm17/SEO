import { useEffect, useRef, useState } from "react";

/**
 * Virtualisation sur le défilement de la fenêtre, pour des lignes de hauteur fixe.
 * Renvoie la tranche à rendre et les espaces à réserver au-dessus et au-dessous.
 */
export function useWindowVirtual(count: number, rowHeight: number, overscan = 8) {
  const ref = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({ start: 0, end: Math.min(count, 40) });

  useEffect(() => {
    let raf = 0;
    const compute = () => {
      raf = 0;
      const el = ref.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top + window.scrollY;
      const viewTop = window.scrollY - top;
      const start = Math.max(0, Math.floor(viewTop / rowHeight) - overscan);
      const end = Math.min(count, Math.ceil((viewTop + window.innerHeight) / rowHeight) + overscan);
      setRange((r) => (r.start === start && r.end === end ? r : { start, end: Math.max(end, start) }));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(compute);
    };
    compute();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [count, rowHeight, overscan]);

  return { ref, start: range.start, end: Math.min(range.end, count), before: range.start * rowHeight, after: Math.max(0, (count - Math.min(range.end, count)) * rowHeight) };
}

export function useMedia(query: string) {
  const [m, setM] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setM(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return m;
}
