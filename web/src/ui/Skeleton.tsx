import type { CSSProperties } from "react";

export function Skeleton({ w, h = 12, r, style, className }: { w?: number | string; h?: number | string; r?: number; style?: CSSProperties; className?: string }) {
  return <span className={`skel ${className ?? ""}`} style={{ width: w ?? "100%", height: h, borderRadius: r, ...style }} aria-hidden />;
}

/** Lignes de texte simulées. */
export function SkeletonText({ lines = 3, last = "60%" }: { lines?: number; last?: string }) {
  return (
    <span className="skel-text" aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} h={10} w={i === lines - 1 ? last : "100%"} />
      ))}
    </span>
  );
}

/** Lignes de liste ou de tableau simulées. */
export function SkeletonRows({ rows = 5, height = 52 }: { rows?: number; height?: number }) {
  return (
    <div className="skel-rows" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skel-rows__row" style={{ height }}>
          <Skeleton w={20} h={20} r={6} />
          <span className="skel-rows__main">
            <Skeleton h={11} w={`${70 - ((i * 13) % 30)}%`} />
            <Skeleton h={9} w={`${40 - ((i * 7) % 15)}%`} />
          </span>
          <Skeleton w={48} h={11} />
        </div>
      ))}
    </div>
  );
}

/** À placer dans une zone en cours de chargement, pour les lecteurs d'écran. */
export function LoadingLabel({ children = "Chargement…" }: { children?: string }) {
  return (
    <span className="sr-only" role="status">
      {children}
    </span>
  );
}
