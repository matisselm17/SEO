/**
 * Courbe des notes sur 100, une analyse terminée par point (Progress.timeline), de la plus ancienne à la
 * plus récente. Échelle fixe de 0 à 100 : la pente n'est jamais exagérée. Les analyses sont espacées
 * régulièrement (l'infobulle et le tableau donnent les dates exactes). Lisible avec 1, 2 ou 50 points.
 * Survol à la souris ou au doigt, flèches du clavier, infobulle, et vue en tableau.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { ProgressPoint } from "../lib/types";
import { fmtDateTime, fmtInt, fmtShortDate, plural } from "../lib/format";

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

const PAD = { l: 34, r: 18, t: 22, b: 30 };
const GRID = [0, 25, 50, 75, 100];

/** « 3 critiques, 12 à améliorer, 5 mineurs » : les mots des gravités, jamais la couleur seule. */
export function issuesLine(i: ProgressPoint["issues"]): string {
  return `${plural(i.critical, "critique", "critiques")}, ${fmtInt(i.warning)} à améliorer, ${plural(i.info, "mineur", "mineurs")}`;
}

export function ScoreTimeline({ points, height = 184 }: { points: ProgressPoint[]; height?: number }) {
  const [wrap, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const n = points.length;
  const innerW = Math.max(10, width - PAD.l - PAD.r);
  const innerH = height - PAD.t - PAD.b;
  const x = (i: number) => PAD.l + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v: number) => PAD.t + innerH * (1 - Math.max(0, Math.min(100, v)) / 100);

  const { line, area } = useMemo(() => {
    let d = "";
    points.forEach((p, i) => {
      d += `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.score).toFixed(1)}`;
    });
    const a = n > 1 ? `${d}L${x(n - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z` : "";
    return { line: d, area: a };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, width, height]);

  // Dates en bas : la première et la dernière, et quelques-unes entre les deux s'il y a la place (une tous les 96 px).
  const ticks = useMemo(() => {
    if (n <= 1) return n ? [0] : [];
    const count = Math.max(2, Math.min(n, Math.floor(innerW / 96)));
    const out: number[] = [];
    for (let k = 0; k < count; k++) out.push(Math.round((k / (count - 1)) * (n - 1)));
    return [...new Set(out)];
  }, [n, innerW]);

  const showDots = n <= 24;
  const indexFromX = (clientX: number, el: Element) => {
    if (n <= 1) return 0;
    const rect = el.getBoundingClientRect();
    const i = Math.round(((clientX - rect.left - PAD.l) / innerW) * (n - 1));
    return Math.max(0, Math.min(n - 1, i));
  };
  const onMove = (e: PointerEvent<SVGSVGElement>) => setHover(indexFromX(e.clientX, e.currentTarget));
  const onKey = (e: KeyboardEvent) => {
    if (!n) return;
    if (e.key === "ArrowRight") setHover((h) => Math.min(n - 1, (h ?? -1) + 1));
    else if (e.key === "ArrowLeft") setHover((h) => Math.max(0, (h ?? n) - 1));
    else if (e.key === "Home") setHover(0);
    else if (e.key === "End") setHover(n - 1);
    else if (e.key === "Escape") setHover(null);
    else return;
    e.preventDefault();
  };

  if (!n) return null;
  const first = points[0];
  const last = points[n - 1];
  const hp = hover !== null ? points[hover] : null;
  const tipLeft = hover !== null ? Math.min(Math.max(x(hover), 100), Math.max(100, width - 100)) : 0;
  // L'infobulle se place sous le point quand il est haut, au-dessus quand il est bas : elle ne cache pas la courbe.
  const tipBelow = hp ? y(hp.score) < PAD.t + innerH / 2 : false;
  const summary = n === 1
    ? `Note de ${first.score} sur 100 à l'analyse du ${fmtDateTime(first.finishedAt)}.`
    : `Note de ${first.score} à ${last.score} sur 100, sur ${n >= 50 ? "les 50 dernières analyses terminées" : `${n} analyses terminées`}. Utilisez les flèches pour parcourir les analyses.`;

  return (
    <div className="stl">
      <div className="stl__bar">
        <span className="stl__scale">Note sur 100, une analyse par point</span>
        <button type="button" className="link-btn stl__toggle" onClick={() => setTable((t) => !t)} aria-pressed={table}>
          {table ? "Voir la courbe" : "Voir en tableau"}
        </button>
      </div>

      {table ? (
        <div className="stl__table table-scroll" tabIndex={0}>
          <table className="table table--compact">
            <thead>
              <tr>
                <th scope="col">Analyse</th>
                <th scope="col" className="num">Note</th>
                <th scope="col" className="num">Pages</th>
                <th scope="col">Problèmes</th>
              </tr>
            </thead>
            <tbody>
              {[...points].reverse().map((p) => (
                <tr key={p.auditId}>
                  <td>{fmtDateTime(p.finishedAt)}</td>
                  <td className="num tnum">{p.score}</td>
                  <td className="num tnum">{fmtInt(p.pagesAnalyzed)}</td>
                  <td className="muted">{issuesLine(p.issues)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="stl__plot" ref={wrap} style={{ height }}>
          {width > 0 && (
            <svg
              width={width}
              height={height}
              className="stl__svg"
              role="img"
              aria-label={summary}
              tabIndex={0}
              onPointerMove={onMove}
              onPointerDown={onMove}
              onPointerLeave={(e) => e.pointerType === "mouse" && setHover(null)}
              onKeyDown={onKey}
              onBlur={() => setHover(null)}
            >
              {GRID.map((v) => (
                <g key={v}>
                  <line x1={PAD.l} x2={width - PAD.r} y1={y(v)} y2={y(v)} className={`stl__grid ${v === 0 ? "stl__grid--base" : ""}`} />
                  {v % 50 === 0 && <text x={PAD.l - 8} y={y(v)} className="stl__ytick" dominantBaseline="middle" textAnchor="end">{v}</text>}
                </g>
              ))}
              {n > 1 && <path d={area} className="stl__area" />}
              {n > 1 && <path d={line} className="stl__line" />}
              {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={PAD.t + innerH} className="stl__cross" />}
              {points.map((p, i) => {
                const end = i === n - 1;
                const start = i === 0;
                if (!showDots && !end && !start && hover !== i) return null;
                return <circle key={p.auditId} cx={x(i)} cy={y(p.score)} r={end || hover === i ? 4.5 : 3} className={`stl__dot ${end ? "stl__dot--last" : ""}`} />;
              })}
              {/* Valeurs de la première et de la dernière analyse, toujours lisibles sans survol. */}
              {hover === null && (
                <>
                  {n > 1 && <text x={x(0)} y={y(first.score) - 10} className="stl__value stl__value--muted" textAnchor="start">{first.score}</text>}
                  <text x={x(n - 1)} y={y(last.score) - 10} className="stl__value" textAnchor={n > 1 ? "end" : "middle"}>{last.score}</text>
                </>
              )}
              {ticks.map((i, k) => (
                <text
                  key={i}
                  x={x(i)}
                  y={height - 8}
                  className="stl__xtick"
                  textAnchor={n === 1 ? "middle" : k === 0 ? "start" : k === ticks.length - 1 ? "end" : "middle"}
                >
                  {fmtShortDate(points[i].finishedAt)}
                </text>
              ))}
            </svg>
          )}
          {hp && hover !== null && (
            <div
              className={`chart-tip stl__tip ${tipBelow ? "" : "stl__tip--above"}`}
              style={{ left: tipLeft, top: tipBelow ? y(hp.score) + 14 : y(hp.score) - 14 }}
              role="status"
            >
              <p className="chart-tip__date">Analyse du {fmtDateTime(hp.finishedAt)}</p>
              <p className="chart-tip__row"><span>Note</span><strong className="tnum">{hp.score} / 100</strong></p>
              <p className="chart-tip__row"><span>Pages analysées</span><strong className="tnum">{fmtInt(hp.pagesAnalyzed)}</strong></p>
              <p className="stl__tip-issues">{issuesLine(hp.issues)}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
