import { useMemo, useState } from "react";
import { ArrowRight, Bot, ExternalLink, Package, PenLine, Search } from "lucide-react";
import type { CategoryId, Issue, IssueDetail, Severity, SiteSummary } from "../lib/types";
import { useIssue, useIssues, useSettings } from "../lib/queries";
import { closeDetail, navigate, sitePath, useSearch } from "../lib/router";
import { CATALOGUE_NOTE, CATEGORY_LABEL, DUPLICATE_NOTE, SEVERITY_LABEL, SEVERITY_ORDER, isCatalogueIssue, isDuplicateIssue, scoreBand } from "../lib/score";
import { isRelaunching, noResultsReason, resultsOf } from "../lib/results";
import { fmtDec, fmtScorePoints, pl, plural } from "../lib/format";
import { setDraft } from "../lib/draft";
import { PageHeader, Section } from "../ui/Section";
import { SeverityBadge, Tag } from "../ui/Badge";
import { Tabs } from "../ui/Tabs";
import { Meter } from "../ui/Meter";
import { Sheet } from "../ui/Sheet";
import { CodeBlock } from "../ui/CodeBlock";
import { Button, ButtonLink, Link } from "../ui/Button";
import { EmptyState, ErrorState } from "../ui/States";
import { Skeleton, SkeletonRows, SkeletonText, LoadingLabel } from "../ui/Skeleton";
import { StrengthList } from "./Overview";
import { useOverflowHint } from "../ui/useVirtual";
import { NoResults, QueryError, RelaunchButton, ReliabilityNote, isRunning } from "./common";

type SevFilter = "all" | Severity;

function AuditRow({ issue, siteId, search }: { issue: Issue; siteId: string; search: string }) {
  return (
    <li>
      <Link to={`${sitePath(siteId, "audit", issue.id)}${search}`} className="audit-row">
        <SeverityBadge severity={issue.severity} />
        <span className="audit-row__main">
          <span className="audit-row__title">{issue.title}</span>
          <span className="audit-row__summary">{issue.summary}</span>
          {isCatalogueIssue(issue) && <CatalogueMark />}
        </span>
        <span className="audit-row__cat">{CATEGORY_LABEL[issue.category]}</span>
        <span className="audit-row__pages">
          <span className="tnum">
            {issue.pagesAffected} / {issue.pagesTotal} {isCatalogueIssue(issue) ? pl(issue.pagesTotal, "produit", "produits") : pl(issue.pagesTotal, "page", "pages")}
          </span>
          <Meter value={issue.pagesAffected} max={issue.pagesTotal} tone={issue.severity === "critical" ? "critical" : issue.severity === "warning" ? "warning" : "neutral"} />
        </span>
        <IssuePoints issue={issue} />
        <ArrowRight size={16} className="row-arrow" aria-hidden />
      </Link>
    </li>
  );
}

/** Mention visible des constats fondés sur le catalogue de la boutique. */
function CatalogueMark() {
  return (
    <span className="catmark">
      <Package size={12} aria-hidden />
      Lu dans le catalogue, page non ouverte
    </span>
  );
}

/** Effet sur la note du site (sur 100). Doublons et catalogue ne la changent pas : aucun chiffre, une mention. */
function IssuePoints({ issue }: { issue: Issue }) {
  if (isCatalogueIssue(issue)) return <span className="audit-row__pts audit-row__pts--none" title={CATALOGUE_NOTE}>Hors note</span>;
  if (isDuplicateIssue(issue)) return <span className="audit-row__pts audit-row__pts--none" title={DUPLICATE_NOTE}>Sans effet sur la note</span>;
  if (issue.scoreImpact <= 0) return <span className="audit-row__pts audit-row__pts--none">Moins de 0,1 point</span>;
  return (
    <span className="audit-row__pts tnum" title="Points que ce problème retire à la note du site, sur 100">
      −{fmtScorePoints(issue.scoreImpact)}<span className="audit-row__pts-unit"> sur la note</span>
    </span>
  );
}

const EVIDENCE_STEP = 25;

function Evidence({ issue, siteId }: { issue: IssueDetail; siteId: string }) {
  const [shown, setShown] = useState(EVIDENCE_STEP);
  const [q, setQ] = useState("");
  const list = useMemo(() => (q ? issue.evidence.filter((e) => e.path.toLowerCase().includes(q.toLowerCase())) : issue.evidence), [issue.evidence, q]);
  const unit = isCatalogueIssue(issue) ? { one: "fiche", many: "fiches" } : { one: "page", many: "pages" };
  // Problème corrigeable dans la boutique : chaque preuve reliée à un élément Shopify ouvre sa fiche sur le bon champ.
  const fix = issue.shopifyField;
  const fixable = !!fix && issue.evidence.some((e) => e.shopifyResourceId);
  // Le lien n'existe que si le champ est modifiable sur cet élément (le serveur ne renseigne shopifyResourceId que dans ce cas).
  // En lecture seule, il ne promet pas une correction impossible.
  const shopWrites = useSettings().data?.integrations.shopify.writesEnabled === true;
  const fixLabel = shopWrites ? "Corriger dans Shopify" : "Voir dans la boutique";
  return (
    <>
      {issue.evidence.length > 10 && (
        <label className="search evidence__search">
          <Search size={14} aria-hidden />
          <span className="sr-only">Filtrer les pages concernées</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filtrer par adresse" />
        </label>
      )}
      {fixable && (
        <p className="evidence__shop">
          {shopWrites
            ? <>Ces {unit.many} sont reliées à votre boutique Shopify : « Corriger dans Shopify » ouvre l'élément sur le bon champ, avec un aperçu et une confirmation avant toute modification.</>
            : <>Ces {unit.many} sont reliées à votre boutique Shopify, consultable en lecture seule : « Voir dans la boutique » ouvre l'élément sur le bon champ.</>}
        </p>
      )}
      <ul className="evidence">
        {list.slice(0, shown).map((e) => (
          <li key={e.pageId ?? e.url} className={`evidence__row ${fixable ? "evidence__row--fix" : ""}`}>
            {e.pageId ? (
              <Link to={sitePath(siteId, "pages", e.pageId)} className="evidence__path mono" title={e.url}>{e.path}</Link>
            ) : (
              // Produit lu dans le catalogue : pas de fiche dans l'analyse, on ouvre la page sur le site.
              <a href={e.url} target="_blank" rel="noopener noreferrer nofollow" className="evidence__path evidence__path--ext mono" title={`${e.url} (s'ouvre sur votre site)`}>
                <span className="evidence__pathtext">{e.path}</span>
                <ExternalLink size={12} aria-hidden />
              </a>
            )}
            <span className="evidence__found">{e.found ?? "Rien de relevé"}</span>
            {fixable && (
              <span className="evidence__fix">
                {fix && e.shopifyResourceId && (
                  <ButtonLink
                    to={`${sitePath(siteId, "shopify", e.shopifyResourceId)}?champ=${fix}`}
                    size="sm"
                    variant="ghost"
                    icon={<PenLine size={14} aria-hidden />}
                    aria-label={`${fixLabel} : ${e.path}`}
                  >
                    {fixLabel}
                  </ButtonLink>
                )}
              </span>
            )}
          </li>
        ))}
      </ul>
      {list.length === 0 && <p className="muted">Aucune {unit.one} ne correspond.</p>}
      {list.length > shown && (
        <Button size="sm" variant="ghost" onClick={() => setShown((s) => s + EVIDENCE_STEP)} className="evidence__more">
          Afficher {Math.min(EVIDENCE_STEP, list.length - shown)} {unit.many} de plus ({list.length - shown} restants)
        </Button>
      )}
      {issue.pagesAffected > issue.evidence.length && (
        <p className="muted small">Seules les {issue.evidence.length} premières {unit.many} sont listées.</p>
      )}
    </>
  );
}

function IssueSheet({ site, issueId, onClose }: { site: SiteSummary; issueId: string | null; onClose: () => void }) {
  const q = useIssue(site.id, issueId);
  const settings = useSettings();
  const chatReady = settings.data?.integrations.chat.configured === true;
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
            <span>{isCatalogueIssue(issue) ? `${plural(issue.pagesAffected, "produit concerné", "produits concernés")} sur ${issue.pagesTotal} lus dans le catalogue` : `${plural(issue.pagesAffected, "page concernée", "pages concernées")} sur ${issue.pagesTotal}`}</span>
            <span aria-hidden>·</span>
            <span>{isCatalogueIssue(issue) ? "Hors note" : isDuplicateIssue(issue) ? "Sans effet sur la note" : issue.scoreImpact > 0 ? `−${fmtScorePoints(issue.scoreImpact)} sur la note` : "Moins de 0,1 point sur la note"}</span>
          </>
        )
      }
      footer={
        issue && (
          <>
            <Button variant={chatReady ? "ghost" : "secondary"} onClick={() => navigate(`${sitePath(site.id, "recommendations")}#rec_${issue.id}`)}>Voir l'action</Button>
            {chatReady && <Button variant="primary" icon={<Bot size={16} aria-hidden />} onClick={askAssistant}>Demander à l'assistant</Button>}
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
          {isCatalogueIssue(issue) && (
            <p className="detail-note detail-note--catalogue">
              <strong>Constat tiré du catalogue de la boutique, sans ouvrir les pages.</strong> Pour ces produits, le titre, la description et les images ont été lus dans le catalogue public. Ils ne comptent pas dans la note sur 100, qui ne repose que sur les pages ouvertes en entier. Ce constat compte quand même : c'est ce texte que Google affiche pour vos produits. Ouvrez une fiche pour vérifier sur votre site.
            </p>
          )}
          {isDuplicateIssue(issue) && (
            <p className="detail-note">
              <strong>Ce problème ne change pas la note sur 100</strong>, calculée page par page. Il compte quand même : des pages identiques dans Google se font concurrence, Google hésite sur celle à montrer et l'internaute ne sait pas laquelle choisir.
            </p>
          )}
          <section className="detail-block">
            <h3 className="detail-block__title">Pourquoi c'est important</h3>
            <p className="detail-block__text">{issue.why}</p>
          </section>
          <section className="detail-block">
            <h3 className="detail-block__title">Comment corriger</h3>
            <ol className="steps">
              {issue.fix.steps.map((s, i) => <li key={i}>{s}</li>)}
            </ol>
            {issue.fix.snippet && (
              <CodeBlock
                code={issue.fix.snippet.code}
                language={issue.fix.snippet.language}
                label={
                  issue.fix.snippet.forPath ? (
                    <>Exemple pour la page <span className="mono">{issue.fix.snippet.forPath}</span> — à adapter pour chaque page</>
                  ) : issue.fix.snippet.language === "html" ? (
                    "Code à coller, valable pour tout le site"
                  ) : undefined
                }
              />
            )}
          </section>
          <section className="detail-block">
            <h3 className="detail-block__title">{isCatalogueIssue(issue) ? "Produits concernés" : "Pages concernées"} <span className="muted tnum">{issue.pagesAffected}</span></h3>
            <p className="detail-block__hint">
              {isCatalogueIssue(issue) ? "Ce qui a été relevé dans le catalogue pour chaque produit ; l'adresse ouvre la fiche sur votre site." : "Ce qui a été relevé sur chaque page."} Attendu : {issue.evidence[0]?.expected ?? "—"}.
            </p>
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
  // Une valeur inconnue dans l'adresse revient à « tous », plutôt qu'à une liste vide.
  const rawSev = search.get("gravite");
  const sev: SevFilter = rawSev === "critical" || rawSev === "warning" || rawSev === "info" ? rawSev : "all";
  const rawCat = search.get("famille");
  const cat = rawCat && rawCat in CATEGORY_LABEL ? (rawCat as CategoryId) : null;
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

  const reason = noResultsReason(site);
  const r = resultsOf(site);
  const [famRef] = useOverflowHint<HTMLDivElement>();
  const catalogueCount = (q.data?.issues ?? []).filter(isCatalogueIssue).reduce((m, i) => Math.max(m, i.pagesTotal), 0);
  const firstRun = isRunning(site) && !isRelaunching(site);
  return (
    <>
      <PageHeader
        title="Audit SEO"
        description={
          r
            ? `Tous les problèmes détectés sur ${plural(r.pagesDone, "page ouverte", "pages ouvertes")} en entier${catalogueCount ? ` et ${plural(catalogueCount, "produit lu", "produits lus")} dans le catalogue` : ""}${isRelaunching(site) ? " lors de l'analyse précédente" : ""}, du plus coûteux au moins coûteux. Ouvrez-en un pour voir les preuves et la correction.`
            : "Tous les problèmes détectés, du plus coûteux au moins coûteux, avec leurs preuves et leur correction."
        }
        actions={<RelaunchButton site={site} />}
      />
      {reason !== null ? (
        <NoResults site={site} running="Les problèmes apparaissent ici au fil des pages notées. Vous pouvez parcourir les autres sections en attendant." />
      ) : (
        <>
      <ReliabilityNote site={site} compact />
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
            <div className="famstrip scroll-hint" role="group" aria-label="Filtrer par famille de critères" ref={famRef}>
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
            <EmptyState title={firstRun ? "Aucun problème pour l'instant" : "Aucun problème détecté"}>
              {firstRun ? "Les problèmes apparaissent ici au fil des pages notées." : `${r && r.pagesDone > 1 ? "Les pages analysées respectent" : "La page analysée respecte"} tous les critères de la grille.`}
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
                {g.items.some((i) => !isCatalogueIssue(i)) && (
                  <ul className="audit-list">
                    {g.items.filter((i) => !isCatalogueIssue(i)).map((i) => <AuditRow key={i.id} issue={i} siteId={site.id} search={currentQs} />)}
                  </ul>
                )}
                {g.items.some(isCatalogueIssue) && (
                  <>
                    <p className="audit-subhead">
                      <Package size={14} aria-hidden />
                      <span><strong>Lus dans le catalogue, hors note.</strong> Des produits dont la page n'a pas été ouverte : ces constats ne changent pas la note, mais c'est ce que Google affiche pour eux.</span>
                    </p>
                    <ul className="audit-list">
                      {g.items.filter(isCatalogueIssue).map((i) => <AuditRow key={i.id} issue={i} siteId={site.id} search={currentQs} />)}
                    </ul>
                  </>
                )}
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
        </>
      )}
      <IssueSheet site={site} issueId={issueId} onClose={() => closeDetail(`${sitePath(site.id, "audit")}${currentQs}`)} />
    </>
  );
}
