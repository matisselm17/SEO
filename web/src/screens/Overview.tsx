import { ArrowDown, ArrowRight, ArrowUp, Bot, CircleCheck, FileUp, Info, OctagonAlert, TriangleAlert } from "lucide-react";
import type { Issue, Overview, Recommendation, SiteSummary, Strength } from "../lib/types";
import { useOverview, useSettings } from "../lib/queries";
import { sitePath } from "../lib/router";
import { fmtCompact, fmtDec, fmtInt, fmtPct, fmtPeriod, fmtPosition, fmtScorePoints, pl } from "../lib/format";
import { CATEGORY_LABEL, EFFORT_LABEL, IMPACT_LABEL, SEVERITY_LABEL, scoreVerdict } from "../lib/score";
import { isRelaunching, isUnreliable, noResultsReason, resultsOf } from "../lib/results";
import { PageHeader, Section } from "../ui/Section";
import { ScoreGauge } from "../ui/ScoreGauge";
import { CategoryBars } from "../ui/CategoryBars";
import { SeverityBadge, Tag } from "../ui/Badge";
import { ButtonLink, Link } from "../ui/Button";
import { Meter } from "../ui/Meter";
import { Skeleton, SkeletonRows, LoadingLabel } from "../ui/Skeleton";
import { TrendChart } from "../ui/TrendChart";
import { useMedia } from "../ui/useVirtual";
import { FailedPagesToggle, NoResults, QueryError, RelaunchButton, ReliabilityNote, auditLine, isRunning } from "./common";

function Delta({ value, previous }: { value: number; previous: number | null }) {
  if (previous === null) return <span className="delta delta--none">Première analyse</span>;
  const d = value - previous;
  if (d === 0) return <span className="delta delta--flat">Stable depuis la dernière analyse</span>;
  return (
    <span className={`delta ${d > 0 ? "delta--up" : "delta--down"}`}>
      {d > 0 ? <ArrowUp size={13} aria-hidden /> : <ArrowDown size={13} aria-hidden />}
      {d > 0 ? "+" : "−"}{Math.abs(d)} depuis la dernière analyse ({previous})
    </span>
  );
}

function ScoreBand({ data, site }: { data: Overview; site: SiteSummary }) {
  const s = data.score;
  const c = data.counts.issues;
  // « Provisoire » seulement quand les résultats affichés sont ceux de l'analyse en cours (première analyse).
  const running = isRunning(site) && !isRelaunching(site);
  const r = resultsOf(site);
  const small = useMedia("(max-width: 767px)");
  return (
    <section className="scoreband" aria-label="Note du site">
      <div className="scoreband__gauge">
        <ScoreGauge score={s?.value ?? null} size={small ? 136 : 176} />
        {s ? (
          <div className="scoreband__verdict">
            <p className="scoreband__verdict-title">{scoreVerdict(s.value)}</p>
            <Delta value={s.value} previous={s.previous} />
            {running && <p className="scoreband__live">Provisoire : la note évolue à chaque page notée.</p>}
            {isUnreliable(site) && <p className="scoreband__warn">Note peu fiable</p>}
          </div>
        ) : (
          <div className="scoreband__verdict">
            <p className="scoreband__verdict-title">Note en attente</p>
            <p className="scoreband__live">{running ? "Elle apparaîtra dès la première page notée." : "Aucune page n'a pu être notée."}</p>
          </div>
        )}
      </div>

      <div className="scoreband__cats">
        <h2 className="scoreband__label">Les cinq familles de critères</h2>
        {s ? <CategoryBars categories={s.categories} compact /> : <p className="muted">Les familles s'affichent avec la note.</p>}
      </div>

      <div className="scoreband__figures">
        <div className="figure">
          <span className="figure__label">Pages analysées</span>
          <span className="figure__value tnum">{fmtInt(r?.pagesDone ?? data.counts.pages)}</span>
          {r && r.pagesFailed > 0 && <FailedPagesToggle site={site} count={r.pagesFailed} />}
        </div>
        <div className="figure">
          <span className="figure__label">Problèmes détectés</span>
          <ul className="sevcounts">
            {([["critical", c.critical, OctagonAlert], ["warning", c.warning, TriangleAlert], ["info", c.info, Info]] as const).map(([k, n, Icon]) => (
              <li key={k}>
                <Link to={`${sitePath(site.id, "audit")}?gravite=${k}`} className={`sevcount sevcount--${k}`}>
                  <Icon size={14} strokeWidth={2.25} aria-hidden />
                  <span className="tnum sevcount__n">{n}</span>
                  <span className="sevcount__label">{SEVERITY_LABEL[k].toLowerCase()}{n > 1 && k !== "warning" ? "s" : ""}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function IssueRow({ issue, siteId }: { issue: Issue; siteId: string }) {
  return (
    <li>
      <Link to={sitePath(siteId, "audit", issue.id)} className="issue-row">
        <SeverityBadge severity={issue.severity} />
        <span className="issue-row__main">
          <span className="issue-row__title">{issue.title}</span>
          <span className="issue-row__summary">{issue.summary}</span>
        </span>
        <span className="issue-row__meta">
          <span className="issue-row__pages tnum">{issue.pagesAffected} / {issue.pagesTotal} {pl(issue.pagesTotal, "page", "pages")}</span>
          <Meter value={issue.pagesAffected} max={issue.pagesTotal} tone={issue.severity === "critical" ? "critical" : issue.severity === "warning" ? "warning" : "neutral"} />
        </span>
        <ArrowRight size={16} className="row-arrow" aria-hidden />
      </Link>
    </li>
  );
}

function ActionRow({ rec, siteId }: { rec: Recommendation; siteId: string }) {
  return (
    <li className="action-row">
      <span className="action-row__rank tnum" aria-label={`Priorité ${rec.rank}`}>{rec.rank}</span>
      <div className="action-row__main">
        <Link to={`${sitePath(siteId, "recommendations")}#${rec.id}`} className="action-row__title">{rec.title}</Link>
        <span className="action-row__tags">
          <Tag tone={rec.impact === "high" ? "accent" : "neutral"}>{IMPACT_LABEL[rec.impact]}</Tag>
          <Tag>{EFFORT_LABEL[rec.effort]}</Tag>
          {rec.scoreGain > 0 ? (
            <span className="action-row__gain tnum">+{fmtScorePoints(rec.scoreGain)} sur la note</span>
          ) : rec.pointsToGain === 0 ? (
            <span className="action-row__neutral">Ne change pas la note</span>
          ) : null}
        </span>
      </div>
    </li>
  );
}

function StrengthList({ items }: { items: Strength[] }) {
  return (
    <ul className="strengths">
      {items.map((s) => (
        <li key={s.id} className="strength">
          <CircleCheck size={16} className="strength__icon" aria-hidden />
          <div>
            <p className="strength__title">{s.title}</p>
            <p className="strength__detail">{s.detail} <span className="muted">{CATEGORY_LABEL[s.category]}</span></p>
          </div>
        </li>
      ))}
    </ul>
  );
}

function Organic({ data, siteId }: { data: Overview; siteId: string }) {
  const o = data.organic;
  if (!o) {
    return (
      <div className="invite">
        <FileUp size={18} className="invite__icon" aria-hidden />
        <p className="invite__text">
          <strong>Voyez aussi vos visites depuis Google.</strong> Déposez l'export de votre Search Console pour relier vos clics et vos recherches à chaque page. C'est facultatif.
        </p>
        <ButtonLink to={sitePath(siteId, "traffic")} size="sm">Déposer l'export</ButtonLink>
      </div>
    );
  }
  const kpis = [
    { label: "Clics", value: fmtCompact(o.totals.clicks), hint: "Visites venues de Google" },
    { label: "Impressions", value: fmtCompact(o.totals.impressions), hint: "Affichages dans les résultats" },
    { label: "Taux de clic", value: fmtPct(o.totals.ctr), hint: "Clics ÷ impressions" },
    { label: "Position moyenne", value: fmtPosition(o.totals.position), hint: "Rang moyen dans Google" },
  ];
  return (
    <div className="organic">
      <dl className="kpis">
        {kpis.map((k) => (
          <div key={k.label} className="kpi">
            <dt className="kpi__label">{k.label}</dt>
            <dd className="kpi__value tnum">{k.value}</dd>
            <dd className="kpi__hint">{k.hint}</dd>
          </div>
        ))}
      </dl>
      {o.series && o.series.length > 1 && <TrendChart series={o.series} height={84} />}
    </div>
  );
}

function OverviewSkeleton() {
  const small = useMedia("(max-width: 767px)");
  return (
    <>
      <LoadingLabel />
      <div className="scoreband" aria-hidden>
        <div className="scoreband__gauge"><ScoreGauge score={null} size={small ? 136 : 176} /><div className="scoreband__verdict"><Skeleton w={110} h={16} /><Skeleton w={140} h={11} /></div></div>
        <div className="scoreband__cats">{Array.from({ length: 5 }, (_, i) => <div key={i} style={{ marginBottom: 14 }}><Skeleton w="40%" h={10} /><div style={{ height: 8 }} /><Skeleton h={6} /></div>)}</div>
        <div className="scoreband__figures"><Skeleton w={80} h={10} /><Skeleton w={60} h={30} /><Skeleton w={120} h={10} /></div>
      </div>
      <div className="overview-cols">
        <div><Skeleton w={220} h={16} /><div style={{ height: 16 }} /><SkeletonRows rows={4} height={72} /></div>
        <div><Skeleton w={180} h={16} /><div style={{ height: 16 }} /><SkeletonRows rows={4} height={56} /></div>
      </div>
    </>
  );
}

export function OverviewScreen({ site }: { site: SiteSummary }) {
  const q = useOverview(site.id);
  const settings = useSettings();
  const chatReady = settings.data?.integrations.chat.configured === true;
  const data = q.data;
  const reason = noResultsReason(site);
  const totalIssues = data ? data.counts.issues.critical + data.counts.issues.warning + data.counts.issues.info : 0;

  return (
    <>
      <PageHeader
        title="Vue d'ensemble"
        description={<><span className="mono-host">{site.host}</span> {auditLine(site)}</>}
        actions={
          <>
            <RelaunchButton site={site} />
            {chatReady && reason === null && <ButtonLink to={sitePath(site.id, "assistant")} variant="primary" icon={<Bot size={16} aria-hidden />}>Poser une question</ButtonLink>}
          </>
        }
      />
      {reason !== null && reason !== "running" ? (
        <NoResults site={site} running={null} />
      ) : (
        <>
      <QueryError q={q} />
      {!data && !q.error && <OverviewSkeleton />}
      {data && (
        <>
          <ReliabilityNote site={site} />
          <ScoreBand data={data} site={site} />

          {reason === "running" || data.counts.pages === 0 ? (
            <NoResults
              site={site}
              running="Les problèmes, les actions et les points positifs s'afficheront ici au fil des pages notées. Vous pouvez parcourir les autres sections en attendant."
            />
          ) : (
            <>
              <div className="overview-cols">
                <Section
                  id="top-issues"
                  title="À corriger en priorité"
                  description="Les problèmes qui coûtent le plus de points à votre site."
                  actions={<Link to={sitePath(site.id, "audit")} className="text-link">{totalIssues > 1 ? `Voir les ${totalIssues} problèmes` : "Voir le problème"}</Link>}
                >
                  {data.topIssues.length ? (
                    <ul className="issue-list">{data.topIssues.map((i) => <IssueRow key={i.id} issue={i} siteId={site.id} />)}</ul>
                  ) : (
                    <p className="muted">{isRunning(site) && !isRelaunching(site) ? "Aucun problème pour l'instant sur les pages déjà notées." : "Aucun problème détecté. Les pages analysées respectent tous les critères de la grille."}</p>
                  )}
                </Section>
                <Section
                  id="actions"
                  title="Par où commencer"
                  description="Classées par gain et par effort."
                  actions={<Link to={sitePath(site.id, "recommendations")} className="text-link">Toutes les actions</Link>}
                >
                  {data.actions.length ? (
                    <ol className="action-list">{data.actions.map((r) => <ActionRow key={r.id} rec={r} siteId={site.id} />)}</ol>
                  ) : (
                    <p className="muted">Aucune action à mener sur les pages analysées.</p>
                  )}
                </Section>
              </div>

              <Section
                id="organic"
                title="Trafic depuis Google"
                description={data.organic?.period ? `Search Console, ${fmtPeriod(data.organic.period)}.` : data.organic ? "Données de la Search Console." : undefined}
                actions={data.organic ? <Link to={sitePath(site.id, "traffic")} className="text-link">Requêtes et pages</Link> : undefined}
              >
                <Organic data={data} siteId={site.id} />
              </Section>

              {data.strengths.length > 0 && (
                <Section id="strengths" title="Ce qui est déjà bien fait" description="Critères validés sur au moins 90 % des pages.">
                  <StrengthList items={data.strengths} />
                </Section>
              )}
            </>
          )}
        </>
      )}
        </>
      )}
    </>
  );
}

// Re-export pour d'autres écrans
export { IssueRow, StrengthList, fmtDec };
