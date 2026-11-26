import { useState } from "react";
import { ExternalLink, RefreshCw, Search, Users } from "lucide-react";
import type { CompetitorsData, SiteSummary } from "../lib/types";
import { keys, useCompetitors } from "../lib/queries";
import { sendJSON, toAppError, type AppError } from "../lib/api";
import { setQueryData } from "../lib/cache";
import { sitePath } from "../lib/router";
import { fmtDateTime, plural } from "../lib/format";
import { PageHeader } from "../ui/Section";
import { Button, ButtonLink } from "../ui/Button";
import { Meter } from "../ui/Meter";
import { EmptyState, ErrorState } from "../ui/States";
import { SkeletonRows, LoadingLabel } from "../ui/Skeleton";
import { QueryError } from "./common";

function useRun(siteId: string) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await sendJSON<CompetitorsData>("POST", keys.competitors(siteId));
      setQueryData(keys.competitors(siteId), data);
    } catch (err) {
      setError(toAppError(err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function CompetitorsScreen({ site }: { site: SiteSummary }) {
  const q = useCompetitors(site.id);
  const r = useRun(site.id);
  const data = q.data;

  return (
    <>
      <PageHeader
        title="Concurrents"
        description="Les sites qui apparaissent dans Google sur les mêmes recherches que vous, relevés dans de vrais résultats de recherche."
        meta={data?.available ? <span className="muted small">Relevé le {fmtDateTime(data.checkedAt)} sur {plural(data.queries.length, "recherche", "recherches")}.</span> : undefined}
        actions={data?.available ? <Button icon={<RefreshCw size={15} aria-hidden />} loading={r.busy} onClick={r.run}>{r.busy ? "Relevé en cours…" : "Refaire le relevé"}</Button> : undefined}
      />
      <QueryError q={q} />
      {/* Sans relevé précédent, le bouton « Relever les concurrents » juste dessous sert de relance : pas de doublon. */}
      {r.error && <ErrorState error={r.error} inline onRetry={r.error.code === "competitors_not_configured" || !data?.available ? undefined : r.run} retrying={r.busy} />}
      {!data && !q.error && (<><LoadingLabel /><SkeletonRows rows={6} height={88} /></>)}

      {data && !data.available && data.reason === "not_configured" && (
        <EmptyState
          tone="framed"
          icon={<Users size={20} />}
          title="Le relevé des concurrents n'est pas activé"
          actions={<ButtonLink to={sitePath(site.id, "settings")}>Voir les paramètres</ButtonLink>}
        >
          <p>Pour savoir qui apparaît dans Google à votre place, le serveur doit pouvoir interroger un service de recherche. Tant que ce n'est pas le cas, cette section reste vide : aucun concurrent n'est inventé.</p>
          <p>La personne qui gère l'installation peut l'activer en ajoutant une clé de recherche côté serveur.</p>
        </EmptyState>
      )}
      {data && !data.available && data.reason === "no_audit" && (
        <EmptyState tone="framed" icon={<Users size={20} />} title="Lancez d'abord une analyse">
          Les recherches à relever sont choisies à partir du contenu de vos pages : il faut une analyse pour les connaître.
        </EmptyState>
      )}
      {data && !data.available && data.reason === "not_run" && (
        <EmptyState
          tone="framed"
          icon={<Search size={20} />}
          title="Aucun relevé pour l'instant"
          actions={<Button variant="primary" loading={r.busy} onClick={r.run}>{r.busy ? "Relevé en cours…" : "Relever les concurrents"}</Button>}
        >
          Nous cherchons dans Google les sujets principaux de votre site, puis nous notons les sites qui apparaissent en tête. Chaque concurrent est accompagné du résultat qui le prouve. Le relevé prend une minute environ.
        </EmptyState>
      )}

      {data?.available && (
        <>
          <div className="searched">
            <span className="searched__label">Recherches relevées</span>
            <ul className="searched__list">
              {data.queries.map((s) => <li key={s} className="tag">{s}</li>)}
            </ul>
          </div>
          {data.competitors.length === 0 ? (
            <EmptyState title="Aucun concurrent récurrent">Aucun autre site n'apparaît sur plusieurs de ces recherches.</EmptyState>
          ) : (
            <ul className="comp-list" aria-label="Concurrents">
              <li className="comp-list__head" aria-hidden>
                <span>Site</span><span>Recherches en commun</span><span>Meilleure place</span><span>Preuve</span>
              </li>
              {data.competitors.map((c) => (
                <li key={c.host} className="comp">
                  <div className="comp__site">
                    <span className="monogram monogram--ghost" aria-hidden>{c.host[0]?.toUpperCase()}</span>
                    <span className="comp__host">{c.host}</span>
                  </div>
                  <div className="comp__match">
                    <span className="small"><strong className="tnum">{c.queriesMatched}</strong> sur {data.queries.length}</span>
                    <Meter value={c.queriesMatched} max={data.queries.length} tone="accent" />
                  </div>
                  <div className="comp__pos"><span className="comp__pos-n tnum">{c.bestPosition}</span><span className="sr-only">e place</span><sup aria-hidden>e</sup></div>
                  <div className="comp__proof">
                    <p className="comp__proof-q">
                      « {c.example.query} », {c.example.position}<sup>e</sup> résultat
                    </p>
                    <a href={c.example.url} target="_blank" rel="noopener noreferrer nofollow" className="comp__proof-title">
                      {c.example.title}
                      <ExternalLink size={12} aria-hidden />
                    </a>
                    <span className="comp__proof-url mono">{hostOf(c.example.url)}{(() => { try { return decodeURIComponent(new URL(c.example.url).pathname); } catch { return ""; } })()}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </>
  );
}
