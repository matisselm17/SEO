import { useEffect, useMemo, useState } from "react";
import { ArrowRight } from "lucide-react";
import type { Effort, SiteSummary } from "../lib/types";
import { useIssues, useRecommendations } from "../lib/queries";
import { sitePath } from "../lib/router";
import { CATALOGUE_NOTE, DUPLICATE_NOTE, EFFORT_HINT, EFFORT_LABEL, IMPACT_LABEL } from "../lib/score";
import { isRelaunching, noResultsReason } from "../lib/results";
import { fmtScorePoints, plural } from "../lib/format";
import { PageHeader } from "../ui/Section";
import { Tabs } from "../ui/Tabs";
import { Tag } from "../ui/Badge";
import { Link } from "../ui/Button";
import { EmptyState } from "../ui/States";
import { SkeletonRows, LoadingLabel } from "../ui/Skeleton";
import { NoResults, QueryError, RelaunchButton, isRunning } from "./common";

type F = "all" | Effort;

export function RecommendationsScreen({ site }: { site: SiteSummary }) {
  const q = useRecommendations(site.id);
  // Pour savoir quelles actions viennent du catalogue (le format le porte sur le problème).
  const issuesQ = useIssues(site.id);
  const catalogueIds = new Set((issuesQ.data?.issues ?? []).filter((i) => i.basis === "catalogue").map((i) => i.id));
  const [f, setF] = useState<F>("all");
  const recs = q.data?.recommendations;
  const counts = useMemo(() => {
    const c = { all: 0, quick: 0, medium: 0, heavy: 0 };
    (recs ?? []).forEach((r) => { c.all++; c[r.effort]++; });
    return c;
  }, [recs]);
  const list = (recs ?? []).filter((r) => f === "all" || r.effort === f);
  const reason = noResultsReason(site);
  const firstRun = isRunning(site) && !isRelaunching(site);

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
        description="Une action par problème, classée : d'abord ce qui fait gagner le plus de points sur la note du site pour le moins d'effort."
        meta={recs && recs.length > 0 && reason === null ? <span className="muted small">{plural(recs.length, "action", "actions")}, dont {plural(counts.quick, "rapide", "rapides")} à mener.{isRelaunching(site) ? " Elles portent sur l'analyse précédente, une nouvelle est en cours." : ""}</span> : undefined}
        actions={<RelaunchButton site={site} />}
      />
      {reason !== null && <NoResults site={site} running="Les actions s'affichent au fil des pages notées, classées par gain et par effort." />}
      {reason === null && <QueryError q={q} />}
      {reason === null && !recs && !q.error && (<><LoadingLabel /><SkeletonRows rows={6} height={120} /></>)}
      {reason === null && recs && recs.length === 0 && (
        <EmptyState title={firstRun ? "Les actions arrivent" : "Aucune action à mener"}>
          {firstRun ? "Elles s'affichent au fil des pages notées." : "Aucun problème n'a été détecté sur les pages analysées."}
        </EmptyState>
      )}
      {reason === null && recs && recs.length > 0 && (
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
                    {r.scoreGain > 0 ? (
                      <span className="rec__gain tnum">+{fmtScorePoints(r.scoreGain)}<span className="rec__gain-unit">sur la note</span></span>
                    ) : catalogueIds.has(r.issueId) ? (
                      <span className="rec__gain rec__gain--none">Hors note</span>
                    ) : r.pointsToGain === 0 ? (
                      <span className="rec__gain rec__gain--none">Ne change pas la note</span>
                    ) : null}
                  </div>
                  <div className="rec__tags">
                    <Tag tone={r.impact === "high" ? "accent" : "neutral"}>{IMPACT_LABEL[r.impact]}</Tag>
                    <Tag>Effort : {EFFORT_LABEL[r.effort].toLowerCase()}</Tag>
                    <span className="small muted">{catalogueIds.has(r.issueId) ? plural(r.pagesAffected, "produit concerné", "produits concernés") : plural(r.pagesAffected, "page concernée", "pages concernées")}</span>
                  </div>
                  {catalogueIds.has(r.issueId) ? (
                    <p className="rec__why">{CATALOGUE_NOTE}</p>
                  ) : (
                    r.scoreGain === 0 && r.pointsToGain === 0 && <p className="rec__why">{DUPLICATE_NOTE}</p>
                  )}
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
