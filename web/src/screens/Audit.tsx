import { useMemo, useState } from "react";
import { ArrowRight, Bot, Search } from "lucide-react";
import type { CategoryId, Issue, IssueDetail, Severity, SiteSummary } from "../lib/types";
import { useIssue, useIssues } from "../lib/queries";
import { navigate, sitePath, useSearch } from "../lib/router";
import { CATEGORY_LABEL, SEVERITY_LABEL, SEVERITY_ORDER, scoreBand } from "../lib/score";
import { fmtDec, fmtInt, plural } from "../lib/format";
import { setDraft } from "../lib/draft";
import { PageHeader, Section } from "../ui/Section";
import { SeverityBadge, Tag } from "../ui/Badge";
import { Tabs } from "../ui/Tabs";
import { Meter } from "../ui/Meter";
import { Sheet } from "../ui/Sheet";
import { CodeBlock } from "../ui/CodeBlock";
import { Button, Link } from "../ui/Button";
import { EmptyState, ErrorState } from "../ui/States";
import { Skeleton, SkeletonRows, SkeletonText, LoadingLabel } from "../ui/Skeleton";
import { StrengthList } from "./Overview";
import { QueryError, RelaunchButton, isRunning } from "./common";

type SevFilter = "all" | Severity;

function AuditRow({ issue, siteId, search }: { issue: Issue; siteId: string; search: string }) {
  return (
    <li>
      <Link to={`${sitePath(siteId, "audit", issue.id)}${search}`} className="audit-row">
        <SeverityBadge severity={issue.severity} />
        <span className="audit-row__main">
          <span className="audit-row__title">{issue.title}</span>
          <span className="audit-row__summary">{issue.summary}</span>
        </span>
        <span className="audit-row__cat">{CATEGORY_LABEL[issue.category]}</span>
        <span className="audit-row__pages">
          <span className="tnum">{issue.pagesAffected} / {issue.pagesTotal}</span>
          <Meter value={issue.pagesAffected} max={issue.pagesTotal} tone={issue.severity === "critical" ? "critical" : issue.severity === "warning" ? "warning" : "neutral"} />
        </span>
        <span className="audit-row__pts tnum" title="Points de note perdus sur l'ensemble du site">−{fmtInt(issue.pointsLost)} pts</span>
        <ArrowRight size={16} className="row-arrow" aria-hidden />
      </Link>
    </li>
  );
}

const EVIDENCE_STEP = 25;

function Evidence({ issue, siteId }: { issue: IssueDetail; siteId: string }) {
  const [shown, setShown] = useState(EVIDENCE_STEP);
  const [q, setQ] = useState("");
  const list = useMemo(() => (q ? issue.evidence.filter((e) => e.path.toLowerCase().includes(q.toLowerCase())) : issue.evidence), [issue.evidence, q]);
  return (
    <>
      {issue.evidence.length > 10 && (
        <label className="search evidence__search">
          <Search size={14} aria-hidden />
          <span className="sr-only">Filtrer les pages concernées</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filtrer par adresse" />
        </label>
      )}
      <ul className="evidence">
        {list.slice(0, shown).map((e) => (
          <li key={e.pageId} className="evidence__row">
            <Link to={sitePath(siteId, "pages", e.pageId)} className="evidence__path mono" title={e.url}>{e.path}</Link>
            <span className="evidence__found">{e.found ?? "Rien de relevé"}</span>
          </li>
        ))}
      </ul>
      {list.length === 0 && <p className="muted">Aucune page ne correspond.</p>}
      {list.length > shown && (
        <Button size="sm" variant="ghost" onClick={() => setShown((s) => s + EVIDENCE_STEP)} className="evidence__more">
          Afficher {Math.min(EVIDENCE_STEP, list.length - shown)} pages de plus ({list.length - shown} restantes)
        </Button>
      )}
      {issue.pagesAffected > issue.evidence.length && (
        <p className="muted small">Seules les {issue.evidence.length} pages les plus touchées sont listées.</p>
      )}
    </>
  );
}

function IssueSheet({ site, issueId, onClose }: { site: SiteSummary; issueId: string | null; onClose: () => void }) {
  const q = useIssue(site.id, issueId);
  const issue = q.data?.issue && q.data.issue.id === issueId ? q.data.issue : null;
  const askAssistant = () => {
    if (!issue) return;
    setDraft(site.id, `Explique-moi le problème « ${issue.title} » et comment le corriger sur mon site.`);
    navigate(sitePath(site.id, "assistant"));
  };
  return (
    <Sheet
      open={!!issueId}
      onClose={onClose}
      title={issue?.title ?? (q.error ? "Problème introuvable" : <Skeleton w="70%" h={22} />)}
      subtitle={
        issue && (
          <>
            <SeverityBadge severity={issue.severity} />
            <Tag>{CATEGORY_LABEL[issue.category]}</Tag>
            <span>{plural(issue.pagesAffected, "page concernée", "pages concernées")} sur {issue.pagesTotal}</span>
            <span aria-hidden>·</span>
            <span>−{fmtInt(issue.pointsLost)} points</span>
          </>
        )
      }
      footer={
        issue && (
          <>
            <Button variant="ghost" onClick={() => navigate(`${sitePath(site.id, "recommendations")}#rec_${issue.id}`)}>Voir l'action</Button>
            <Button variant="primary" icon={<Bot size={16} aria-hidden />} onClick={askAssistant}>Demander à l'assistant</Button>
          </>
        )
      }
    >
      {q.error && !issue && <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.fetching} />}
      {!issue && !q.error && (
        <div className="detail-stack">
          <LoadingLabel />
          <SkeletonText lines={3} />
          <Skeleton w={160} h={14} />
          <SkeletonText lines={4} />
          <Skeleton h={90} r={8} />
        </div>
      )}
      {issue && (
        <div className="detail-stack">
          <p className="detail-lead">{issue.summary}</p>
          <section className="detail-block">
            <h3 className="detail-block__title">Pourquoi c'est important</h3>
            <p className="detail-block__text">{issue.why}</p>
          </section>
          <section className="detail-block">
            <h3 className="detail-block__title">Comment corriger</h3>
            <ol className="steps">
              {issue.fix.steps.map((s, i) => <li key={i}>{s}</li>)}
            </ol>
            {issue.fix.snippet && <CodeBlock code={issue.fix.snippet.code} language={issue.fix.snippet.language} label={issue.fix.snippet.language === "html" ? "Code à coller" : undefined} />}
          </section>
          <section className="detail-block">
            <h3 className="detail-block__title">Pages concernées <span className="muted tnum">{issue.pagesAffected}</span></h3>
            <p className="detail-block__hint">Ce qui a été relevé sur chaque page. Attendu : {issue.evidence[0]?.expected ?? "—"}.</p>
            <Evidence issue={issue} siteId={site.id} />
          </section>
        </div>
      )}
    </Sheet>
  );
}

export function AuditScreen({ site, issueId }: { site: SiteSummary; issueId: string | null }) {
  const q = useIssues(site.id);
  const search = useSearch();
  const sev = (search.get("gravite") as SevFilter | null) ?? "all";
  const cat = (search.get("famille") as CategoryId | null) ?? null;
  const qs = (s: SevFilter, c: CategoryId | null) => {
    const p = new URLSearchParams();
    if (s !== "all") p.set("gravite", s);
    if (c) p.set("famille", c);
    const str = p.toString();
    return str ? `?${str}` : "";
  };
  const currentQs = qs(sev, cat);
  const setFilter = (s: SevFilter, c: CategoryId | null) => navigate(`${sitePath(site.id, "audit")}${qs(s, c)}`, { replace: true });

  const issues = q.data?.issues;
  const filteredByCat = useMemo(() => (issues ?? []).filter((i) => !cat || i.category === cat), [issues, cat]);
  const counts = useMemo(() => {
    const c = { critical: 0, warning: 0, info: 0 };
    filteredByCat.forEach((i) => c[i.severity]++);
    return c;
  }, [filteredByCat]);
  const visible = filteredByCat.filter((i) => sev === "all" || i.severity === sev);
  const groups = SEVERITY_ORDER.map((s) => ({ s, items: visible.filter((i) => i.severity === s) })).filter((g) => g.items.length);

  return (
    <>
      <PageHeader
        title="Audit SEO"
        description={q.data ? `Tous les problèmes détectés sur ${plural(q.data.issues[0]?.pagesTotal ?? site.pagesAnalyzed, "page analysée", "pages analysées")}, du plus coûteux au moins coûteux. Ouvrez-en un pour voir les preuves et la correction.` : "Tous les problèmes détectés, du plus coûteux au moins coûteux."}
        actions={<RelaunchButton site={site} />}
      />
      <QueryError q={q} />
      {!q.data && !q.error && (
        <>
          <LoadingLabel />
          <div className="famstrip" aria-hidden>{Array.from({ length: 5 }, (_, i) => <div key={i} className="famstrip__item"><Skeleton w="60%" h={10} /><Skeleton w="40%" h={18} /><Skeleton h={5} /></div>)}</div>
          <SkeletonRows rows={7} height={76} />
        </>
      )}
      {q.data && (
        <>
          {q.data.categories.length > 0 && (
            <div className="famstrip" role="group" aria-label="Filtrer par famille de critères">
              {q.data.categories.map((c) => {
                const active = cat === c.id;
                const band = scoreBand(Math.round((c.score / c.max) * 100));
                return (
                  <button key={c.id} type="button" className={`famstrip__item ${active ? "is-active" : ""}`} aria-pressed={active} onClick={() => setFilter(sev, active ? null : c.id)}>
                    <span className="famstrip__label">{c.label}</span>
                    <span className="famstrip__value tnum">{fmtDec(c.score)}<span className="famstrip__max"> / {c.max}</span></span>
                    <Meter value={c.score} max={c.max} tone={band} />
                  </button>
                );
              })}
            </div>
          )}

          <div className="toolbar">
            <Tabs<SevFilter>
              label="Filtrer par gravité"
              value={sev}
              onChange={(v) => setFilter(v, cat)}
              items={[
                { id: "all", label: "Tous", count: filteredByCat.length },
                { id: "critical", label: "Critiques", count: counts.critical },
                { id: "warning", label: "À améliorer", count: counts.warning },
                { id: "info", label: "Mineurs", count: counts.info },
              ]}
            />
            {cat && (
              <button type="button" className="filter-chip" onClick={() => setFilter(sev, null)} aria-label={`Retirer le filtre ${CATEGORY_LABEL[cat]}`}>
                {CATEGORY_LABEL[cat]} <span aria-hidden>×</span>
              </button>
            )}
          </div>

          {q.data.issues.length === 0 ? (
            <EmptyState title={isRunning(site) ? "Aucun problème pour l'instant" : "Aucun problème détecté"}>
              {isRunning(site) ? "Les problèmes apparaissent ici au fil des pages notées." : "Toutes les pages analysées respectent les critères de la grille."}
            </EmptyState>
          ) : groups.length === 0 ? (
            <EmptyState title="Aucun problème avec ces filtres">
              <button type="button" className="link-btn" onClick={() => setFilter("all", null)}>Afficher tous les problèmes</button>
            </EmptyState>
          ) : (
            groups.map((g) => (
              <section key={g.s} className="audit-group" aria-label={SEVERITY_LABEL[g.s]}>
                <h2 className="audit-group__title">
                  {g.s === "critical" ? "Critiques" : g.s === "warning" ? "À améliorer" : "Mineurs"}
                  <span className="audit-group__count tnum">{g.items.length}</span>
                  <span className="audit-group__hint">
                    {g.s === "critical" ? "Ils pèsent lourd et touchent la majorité des pages, ou empêchent Google d'afficher des pages." : g.s === "warning" ? "Ils coûtent des points sur une partie des pages." : "Des détails, à corriger quand le reste est fait."}
                  </span>
                </h2>
                <ul className="audit-list">
                  {g.items.map((i) => <AuditRow key={i.id} issue={i} siteId={site.id} search={currentQs} />)}
                </ul>
              </section>
            ))
          )}

          {q.data.strengths.length > 0 && !cat && sev === "all" && (
            <Section id="audit-strengths" title="Ce qui est déjà bien fait" description="Critères validés sur au moins 90 % des pages.">
              <StrengthList items={q.data.strengths} />
            </Section>
          )}
        </>
      )}
      <IssueSheet site={site} issueId={issueId} onClose={() => navigate(`${sitePath(site.id, "audit")}${currentQs}`)} />
    </>
  );
}
