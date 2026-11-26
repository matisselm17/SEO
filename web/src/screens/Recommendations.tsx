import { useEffect, useMemo, useState } from "react";
import { ArrowRight } from "lucide-react";
import type { Effort, SiteSummary } from "../lib/types";
import { useRecommendations } from "../lib/queries";
import { sitePath } from "../lib/router";
import { EFFORT_HINT, EFFORT_LABEL, IMPACT_LABEL } from "../lib/score";
import { fmtInt, plural } from "../lib/format";
import { PageHeader } from "../ui/Section";
import { Tabs } from "../ui/Tabs";
import { Tag } from "../ui/Badge";
import { Link } from "../ui/Button";
import { EmptyState } from "../ui/States";
import { SkeletonRows, LoadingLabel } from "../ui/Skeleton";
import { QueryError, isRunning } from "./common";

type F = "all" | Effort;

export function RecommendationsScreen({ site }: { site: SiteSummary }) {
  const q = useRecommendations(site.id);
  const [f, setF] = useState<F>("all");
  const recs = q.data?.recommendations;
  const counts = useMemo(() => {
    const c = { all: 0, quick: 0, medium: 0, heavy: 0 };
    (recs ?? []).forEach((r) => { c.all++; c[r.effort]++; });
    return c;
  }, [recs]);
  const list = (recs ?? []).filter((r) => f === "all" || r.effort === f);
  const total = (recs ?? []).reduce((s, r) => s + r.pointsToGain, 0);
  const pagesTotal = site.pagesAnalyzed || 1;

  // Arrivée depuis un lien « #rec_… » : défilement et mise en évidence.
  const [hash, setHash] = useState(() => window.location.hash.slice(1));
  useEffect(() => {
    if (!hash || !recs) return;
    const el = document.getElementById(hash);
    if (el) {
      el.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      const t = setTimeout(() => setHash(""), 2400);
      return () => clearTimeout(t);
    }
  }, [hash, recs]);

  return (
    <>
      <PageHeader
        title="Recommandations"
        description="Une action par problème, classée : d'abord ce qui rapporte le plus de points pour le moins d'effort."
        meta={recs && recs.length > 0 ? <span className="muted small">En tout, {fmtInt(total)} points à regagner, soit {Math.round(total / pagesTotal)} points de plus sur la note moyenne de vos pages.</span> : undefined}
      />
      <QueryError q={q} />
      {!recs && !q.error && (<><LoadingLabel /><SkeletonRows rows={6} height={120} /></>)}
      {recs && recs.length === 0 && (
        <EmptyState title={isRunning(site) ? "Les actions arrivent" : "Rien à faire pour l'instant"}>
          {isRunning(site) ? "Elles s'affichent au fil des pages notées." : "Aucun problème n'a été détecté sur les pages analysées."}
        </EmptyState>
      )}
      {recs && recs.length > 0 && (
        <>
          <div className="toolbar">
            <Tabs<F>
              label="Filtrer par effort"
              value={f}
              onChange={setF}
              items={[
                { id: "all", label: "Toutes", count: counts.all },
                { id: "quick", label: "Rapides", count: counts.quick },
                { id: "medium", label: "Quelques heures", count: counts.medium },
                { id: "heavy", label: "Travail de fond", count: counts.heavy },
              ]}
            />
          </div>
          {f !== "all" && <p className="table-note rec-hint">{EFFORT_HINT[f]}.</p>}
          <ol className="recs">
            {list.map((r) => (
              <li key={r.id} id={r.id} className={`rec ${hash === r.id ? "is-target" : ""}`}>
                <span className={`rec__rank tnum ${r.rank <= 3 ? "is-top" : ""}`} aria-label={`Priorité ${r.rank}`}>{r.rank}</span>
                <div className="rec__main">
                  <div className="rec__head">
                    <h2 className="rec__title">{r.title}</h2>
                    <span className="rec__gain tnum">+{fmtInt(r.pointsToGain)} pts</span>
                  </div>
                  <div className="rec__tags">
                    <Tag tone={r.impact === "high" ? "accent" : "neutral"}>{IMPACT_LABEL[r.impact]}</Tag>
                    <Tag>Effort : {EFFORT_LABEL[r.effort].toLowerCase()}</Tag>
                    <span className="small muted">{plural(r.pagesAffected, "page concernée", "pages concernées")}</span>
                  </div>
                  <ol className="steps rec__steps">
                    {r.steps.map((s, i) => <li key={i}>{s}</li>)}
                  </ol>
                  <Link to={sitePath(site.id, "audit", r.issueId)} className="text-link rec__link">
                    Voir le problème, les pages et le code <ArrowRight size={13} aria-hidden />
                  </Link>
                </div>
              </li>
            ))}
          </ol>
        </>
      )}
    </>
  );
}
