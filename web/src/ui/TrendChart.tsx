/**
 * Courbes clics / impressions en petits multiples : deux graphiques empilés qui partagent
 * l'axe du temps et le survol (jamais deux échelles sur un même graphique).
 * Survol à la souris ou au doigt, flèches du clavier, infobulle, et vue en tableau.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { OrganicPoint } from "../lib/types";
import { fmtCompact, fmtDay, fmtDayLong, fmtInt } from "../lib/format";

type Metric = "clicks" | "impressions";
const METRICS: { id: Metric; label: string; color: string }[] = [
  { id: "clicks", label: "Clics", color: "var(--chart-1)" },
  { id: "impressions", label: "Impressions", color: "var(--chart-2)" },
];

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return step * p;
}

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

const PAD = { l: 44, r: 12, t: 26, b: 6 };
const PANEL_H = 112;
const AXIS_H = 24;

export function TrendChart({ series, height = PANEL_H }: { series: OrganicPoint[]; height?: number }) {
  const [wrap, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const n = series.length;
  const innerW = Math.max(10, width - PAD.l - PAD.r);
  const x = (i: number) => PAD.l + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);

  const panels = useMemo(
    () =>
      METRICS.map((m) => {
        const max = niceMax(Math.max(0, ...series.map((p) => p[m.id])));
        const y = (v: number) => PAD.t + (height - PAD.t - PAD.b) * (1 - v / max);
        let d = "";
        series.forEach((p, i) => {
          d += `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[m.id]).toFixed(1)}`;
        });
        const area = n ? `${d}L${x(n - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z` : "";
        const total = series.reduce((s, p) => s + p[m.id], 0);
        return { ...m, max, y, d, area, total };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series, width, height],
  );

  // Graduations du temps : environ une tous les 110 px.
  const ticks = useMemo(() => {
    if (n < 2) return n ? [0] : [];
    const count = Math.max(2, Math.min(7, Math.floor(innerW / 110)));
    const out: number[] = [];
    for (let k = 0; k < count; k++) out.push(Math.round((k / (count - 1)) * (n - 1)));
    return [...new Set(out)];
  }, [n, innerW]);

  const indexFromX = (clientX: number, el: Element) => {
    const rect = el.getBoundingClientRect();
    const px = clientX - rect.left;
    const i = Math.round(((px - PAD.l) / innerW) * (n - 1));
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

  const hp = hover !== null ? series[hover] : null;
  const tipLeft = hover !== null ? Math.min(Math.max(x(hover), 90), Math.max(90, width - 90)) : 0;

  return (
    <div className="trend">
      <div className="trend__legend">
        <button type="button" className="link-btn trend__toggle" onClick={() => setTable((t) => !t)} aria-pressed={table}>
          {table ? "Voir la courbe" : "Voir en tableau"}
        </button>
      </div>

      {table ? (
        <div className="trend__table table-scroll" tabIndex={0}>
          <table className="table table--compact">
            <thead>
              <tr>
                <th scope="col">Jour</th>
                <th scope="col" className="num">Clics</th>
                <th scope="col" className="num">Impressions</th>
              </tr>
            </thead>
            <tbody>
              {[...series].reverse().map((p) => (
                <tr key={p.date}>
                  <td>{fmtDay(p.date)}</td>
                  <td className="num tnum">{fmtInt(p.clicks)}</td>
                  <td className="num tnum">{fmtInt(p.impressions)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="trend__plot" ref={wrap}>
          {width > 0 && (
            <svg
              width={width}
              height={height * 2 + AXIS_H + 16}
              className="trend__svg"
              role="img"
              aria-label={`Évolution quotidienne sur ${n} jours. Utilisez les flèches pour parcourir les jours.`}
              tabIndex={0}
              onPointerMove={onMove}
              onPointerDown={onMove}
              onPointerLeave={(e) => e.pointerType === "mouse" && setHover(null)}
              onKeyDown={onKey}
              onBlur={() => setHover(null)}
            >
              {panels.map((p, pi) => {
                const top = pi * (height + 16);
                return (
                  <g key={p.id} transform={`translate(0 ${top})`}>
                    {[0, 0.5, 1].map((f) => {
                      const v = p.max * f;
                      const yy = p.y(v);
                      return (
                        <g key={f}>
                          <line x1={PAD.l} x2={width - PAD.r} y1={yy} y2={yy} className="trend__grid" />
                          <text x={PAD.l - 8} y={yy} className="trend__ytick" dominantBaseline="middle" textAnchor="end">
                            {fmtCompact(v)}
                          </text>
                        </g>
                      );
                    })}
                    <circle cx={PAD.l + 4} cy={9} r={4} fill={p.color} />
                    <text x={PAD.l + 14} y={9} className="trend__panel-label" dominantBaseline="middle">{p.label}</text>
                    <path d={p.area} fill={p.color} className="trend__area" />
                    <path d={p.d} stroke={p.color} className="trend__line" />
                    {hp && hover !== null && (
                      <circle cx={x(hover)} cy={p.y(hp[p.id])} r={4.5} fill={p.color} className="trend__dot" />
                    )}
                  </g>
                );
              })}
              {hover !== null && (
                <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={height * 2 + 16 - PAD.b} className="trend__cross" />
              )}
              <g transform={`translate(0 ${height * 2 + 16})`}>
                {ticks.map((i, k) => (
                  <text
                    key={i}
                    x={x(i)}
                    y={16}
                    className="trend__xtick"
                    textAnchor={k === 0 ? "start" : k === ticks.length - 1 ? "end" : "middle"}
                  >
                    {fmtDay(series[i].date)}
                  </text>
                ))}
              </g>
            </svg>
          )}
          {hp && (
            <div className="chart-tip" style={{ left: tipLeft }} role="status">
              <p className="chart-tip__date">{fmtDayLong(hp.date)}</p>
              {METRICS.map((m) => (
                <p key={m.id} className="chart-tip__row">
                  <span className="trend__swatch" style={{ background: m.color }} aria-hidden />
                  <span>{m.label}</span>
                  <strong className="tnum">{fmtInt(hp[m.id])}</strong>
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
