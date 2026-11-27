import { useDeferredValue, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ExternalLink, Search } from "lucide-react";
import type { CategoryId, PageCheck, PageDetail, PageSummary, PageType, SiteSummary } from "../lib/types";
import { PAGE_TYPE_LABEL, PAGE_TYPE_ORDER } from "../lib/pagetype";
import { useAllPages, useOverview, usePage } from "../lib/queries";
import { closeDetail, sitePath } from "../lib/router";
import { isRelaunching, noResultsReason, resultsOf } from "../lib/results";
import { CATEGORY_LABEL, scoreBand } from "../lib/score";
import { fmtCompact, fmtDateTime, fmtInt, fmtPct, fmtPosition, plural } from "../lib/format";
import { PageHeader } from "../ui/Section";
import { CheckBadge, ScorePill, Tag } from "../ui/Badge";
import { Tabs } from "../ui/Tabs";
import { Sheet } from "../ui/Sheet";
import { SerpPreview } from "../ui/SerpPreview";
import { Link } from "../ui/Button";
import { EmptyState, ErrorState } from "../ui/States";
import { Skeleton, SkeletonRows, SkeletonText, LoadingLabel } from "../ui/Skeleton";
import { useMedia, useWindowVirtual } from "../ui/useVirtual";
import { FailedPagesToggle, NoResults, QueryError, ReliabilityNote, isRunning } from "./common";

type SortKey = "path" | "type" | "score" | "issues" | "words" | "clicks" | "position";
type Band = "all" | "critical" | "warning" | "good";

const CAT_ORDER: CategoryId[] = ["balises", "contenu", "technique", "medias", "partage"];

function comparator(key: SortKey, dir: 1 | -1) {
  return (a: PageSummary, b: PageSummary) => {
    let r = 0;
    switch (key) {
      case "path": r = a.path.localeCompare(b.path, "fr"); break;
      case "type": r = PAGE_TYPE_ORDER.indexOf(a.pageType) - PAGE_TYPE_ORDER.indexOf(b.pageType); break;
      case "score": r = a.score - b.score; break;
      case "issues": r = a.issues - b.issues; break;
      case "words": r = a.words - b.words; break;
      // Les pages sans donnée Search Console vont toujours à la fin.
      case "clicks": r = (a.organic?.clicks ?? -1) - (b.organic?.clicks ?? -1); if (!a.organic || !b.organic) return a.organic ? -1 : b.organic ? 1 : 0; break;
      case "position": if (!a.organic || !b.organic) return a.organic ? -1 : b.organic ? 1 : 0; r = a.organic.position - b.organic.position; break;
    }
    return r * dir || a.path.localeCompare(b.path, "fr");
  };
}

function SortHeader({ k, label, sort, onSort, align = "left", className }: { k: SortKey; label: string; sort: { key: SortKey; dir: 1 | -1 }; onSort: (k: SortKey) => void; align?: "left" | "right"; className?: string }) {
  const active = sort.key === k;
  return (
    <div role="columnheader" aria-sort={active ? (sort.dir === 1 ? "ascending" : "descending") : "none"} className={`ptable__th ptable__th--${align} ${className ?? ""}`}>
      <button type="button" onClick={() => onSort(k)} className={active ? "is-active" : ""}>
        {align === "right" && (active ? (sort.dir === 1 ? <ArrowUp size={12} aria-hidden /> : <ArrowDown size={12} aria-hidden />) : null)}
        {label}
        {align === "left" && (active ? (sort.dir === 1 ? <ArrowUp size={12} aria-hidden /> : <ArrowDown size={12} aria-hidden />) : null)}
      </button>
    </div>
  );
}

const typeLabel = (t: PageType | undefined) => (t ? PAGE_TYPE_LABEL[t]?.one ?? "Autre" : "—");

function PageRow({ p, siteId, hasOrganic }: { p: PageSummary; siteId: string; hasOrganic: boolean }) {
  return (
    <Link to={sitePath(siteId, "pages", p.id)} className="ptable__row" role="row">
      <span role="cell" className="ptable__page">
        <span className="ptable__path mono">{p.path}</span>
        <span className={`ptable__title ${p.title ? "" : "is-missing"}`}>{p.title ?? "Sans titre"}</span>
      </span>
      <span role="cell" className="ptable__type">{typeLabel(p.pageType)}</span>
      <span role="cell" className="ptable__score"><ScorePill score={p.score} /></span>
      <span role="cell" className="ptable__num tnum"><span className="ptable__typeinline">{typeLabel(p.pageType)} · </span>{p.issues}<span className="ptable__unit"> {p.issues > 1 ? "problèmes" : "problème"}</span></span>
      <span role="cell" className="ptable__num tnum ptable__words">{fmtInt(p.words)}<span className="ptable__unit"> mots</span></span>
      {hasOrganic && <span role="cell" className="ptable__num tnum">{p.organic ? fmtInt(p.organic.clicks) : <span className="subtle">—</span>}<span className="ptable__unit"> clics</span></span>}
      {hasOrganic && <span role="cell" className="ptable__num tnum ptable__pos">{p.organic ? fmtPosition(p.organic.position) : <span className="subtle">—</span>}</span>}
      <span role="cell" className="ptable__status">{p.httpStatus !== 200 && <Tag tone={p.httpStatus >= 400 ? "critical" : "warning"}>HTTP {p.httpStatus}</Tag>}</span>
    </Link>
  );
}

function CheckRow({ c }: { c: PageCheck }) {
  return (
    <li className={`check check--${c.status}`}>
      <CheckBadge status={c.status} />
      <div className="check__main">
        <p className="check__label">{c.label}</p>
        <p className="check__msg">{c.message}</p>
        {c.status !== "pass" && (
          <dl className="check__facts">
            <div><dt>Relevé</dt><dd>{c.found ?? "Rien"}</dd></div>
            <div><dt>Attendu</dt><dd>{c.expected}</dd></div>
          </dl>
        )}
      </div>
      <span className="check__pts tnum">{c.points}<span className="subtle">/{c.max}</span></span>
    </li>
  );
}

function PageDetailBody({ page, siteName }: { page: PageDetail; siteName: string }) {
  const byCat = CAT_ORDER.map((id) => {
    const checks = page.checks.filter((c) => c.category === id).sort((a, b) => (a.status === "pass" ? 1 : 0) - (b.status === "pass" ? 1 : 0));
    return { id, checks, pts: checks.reduce((s, c) => s + c.points, 0), max: checks.reduce((s, c) => s + c.max, 0) };
  }).filter((g) => g.checks.length);
  return (
    <div className="detail-stack">
      <section className="detail-block">
        <h3 className="detail-block__title">Aperçu dans Google</h3>
        <SerpPreview url={page.serpPreview.url} title={page.serpPreview.title} description={page.serpPreview.description} siteName={siteName} />
      </section>

      {page.organic && (
        <section className="detail-block">
          <h3 className="detail-block__title">Visites depuis Google</h3>
          <dl className="minikpis">
            <div><dt>Clics</dt><dd className="tnum">{fmtInt(page.organic.clicks)}</dd></div>
            <div><dt>Impressions</dt><dd className="tnum">{fmtCompact(page.organic.impressions)}</dd></div>
            <div><dt>Position moyenne</dt><dd className="tnum">{fmtPosition(page.organic.position)}</dd></div>
          </dl>
          {page.queries === null ? (
            <p className="detail-block__hint">L'export Search Console ne relie pas les recherches à cette page.</p>
          ) : page.queries.length > 0 ? (
            <div className="table-scroll">
              <table className="table table--compact">
                <thead><tr><th scope="col">Recherche</th><th scope="col" className="num">Clics</th><th scope="col" className="num">Taux de clic</th><th scope="col" className="num">Position</th></tr></thead>
                <tbody>
                  {page.queries.map((q) => (
                    <tr key={q.query}><td className="query-cell" title={q.query}><span className="query-clamp">{q.query}</span></td><td className="num tnum">{fmtInt(q.clicks)}</td><td className="num tnum">{fmtPct(q.ctr)}</td><td className="num tnum">{fmtPosition(q.position)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="detail-block__hint">Aucune recherche relevée pour cette page.</p>
          )}
        </section>
      )}

      <section className="detail-block">
        <h3 className="detail-block__title">Critères de la grille</h3>
        {byCat.map((g) => (
          <div key={g.id} className="checkgroup">
            <p className="checkgroup__head">
              <span>{CATEGORY_LABEL[g.id]}</span>
              <span className="tnum">{g.pts} / {g.max}</span>
            </p>
            <ul className="checks">{g.checks.map((c) => <CheckRow key={c.id} c={c} />)}</ul>
          </div>
        ))}
      </section>

      <section className="detail-block">
        <h3 className="detail-block__title">Ce que la page déclare</h3>
        <dl className="facts">
          <div><dt>Titre</dt><dd>{page.title ?? <span className="subtle">Aucun</span>}</dd></div>
          <div><dt>Description</dt><dd>{page.description ?? <span className="subtle">Aucune</span>}</dd></div>
          <div><dt>Titre principal (H1)</dt><dd>{page.h1.length ? page.h1.map((h, i) => <span key={i} className="facts__item">{h}</span>) : <span className="subtle">Aucun</span>}</dd></div>
          <div><dt>Adresse de référence</dt><dd className="mono facts__mono">{page.canonical ?? <span className="subtle">Aucune</span>}</dd></div>
          <div><dt>Langue</dt><dd>{page.lang ?? <span className="subtle">Non déclarée</span>}</dd></div>
          <div><dt>Analysée</dt><dd>le {fmtDateTime(page.analyzedAt)}</dd></div>
        </dl>
      </section>
    </div>
  );
}

function PageSheet({ site, pageId, onClose }: { site: SiteSummary; pageId: string | null; onClose: () => void }) {
  const q = usePage(site.id, pageId);
  const page = q.data?.page && q.data.page.id === pageId ? q.data.page : null;
  return (
    <Sheet
      open={!!pageId}
      onClose={onClose}
      title={page ? <span className="mono sheet__path">{page.path}</span> : q.error ? "Page introuvable" : <Skeleton w="50%" h={22} />}
      subtitle={
        page && (
          <>
            <ScorePill score={page.score} />
            <Tag>{typeLabel(page.pageType)}</Tag>
            <span>{plural(page.issues, "critère à revoir", "critères à revoir")}</span>
            <span aria-hidden>·</span>
            <span>{plural(page.words, "mot", "mots")}</span>
            {page.httpStatus !== 200 && <Tag tone="warning">HTTP {page.httpStatus}</Tag>}
            <a href={page.url} target="_blank" rel="noopener noreferrer nofollow" className="text-link sheet__ext">
              Ouvrir la page <ExternalLink size={12} aria-hidden />
            </a>
          </>
        )
      }
    >
      {q.error && !page && <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.fetching} />}
      {!page && !q.error && (
        <div className="detail-stack"><LoadingLabel /><Skeleton h={110} r={8} /><SkeletonText lines={2} /><SkeletonRows rows={6} height={56} /></div>
      )}
      {page && <PageDetailBody page={page} siteName={site.name} />}
    </Sheet>
  );
}

export function PagesScreen({ site, pageId }: { site: SiteSummary; pageId: string | null }) {
  const q = useAllPages(site.id);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "score", dir: 1 });
  const [band, setBand] = useState<Band>("all");
  const [ptype, setPtype] = useState<PageType | "all">("all");
  const [text, setText] = useState("");
  const search = useDeferredValue(text.trim().toLowerCase());
  const mobile = useMedia("(max-width: 767px)");
  const all = q.data?.pages;
  const hasOrganic = !!all?.some((p) => p.organic);

  // Les compteurs par note suivent le type choisi.
  const bandCounts = useMemo(() => {
    const c = { all: 0, critical: 0, warning: 0, good: 0 };
    (all ?? []).forEach((p) => { if (ptype !== "all" && p.pageType !== ptype) return; c.all++; c[scoreBand(p.score)]++; });
    return c;
  }, [all, ptype]);

  const typeCounts = useMemo(() => {
    const m = new Map<PageType, number>();
    (all ?? []).forEach((p) => m.set(p.pageType, (m.get(p.pageType) ?? 0) + 1));
    return PAGE_TYPE_ORDER.filter((t) => m.has(t)).map((t) => ({ t, n: m.get(t)! }));
  }, [all]);

  const rows = useMemo(() => {
    let list = all ?? [];
    if (ptype !== "all") list = list.filter((p) => p.pageType === ptype);
    if (band !== "all") list = list.filter((p) => scoreBand(p.score) === band);
    if (search) list = list.filter((p) => p.path.toLowerCase().includes(search) || (p.title ?? "").toLowerCase().includes(search));
    return [...list].sort(comparator(sort.key, sort.dir));
  }, [all, band, ptype, search, sort]);

  const rowH = mobile ? 76 : 60;
  const v = useWindowVirtual(rows.length, rowH);
  const onSort = (k: SortKey) => setSort((s) => (s.key === k ? { key: k, dir: (s.dir * -1) as 1 | -1 } : { key: k, dir: k === "path" || k === "score" || k === "position" ? 1 : -1 }));

  const reason = noResultsReason(site);
  const r = resultsOf(site);
  const firstRun = isRunning(site) && !isRelaunching(site);
  const viaCatalogue = useOverview(site.id).data?.coverage?.totals.viaCatalogue ?? 0;
  return (
    <>
      <PageHeader
        title="Pages analysées"
        description={
          r
            ? `${plural(r.pagesDone, "page analysée", "pages analysées")}${isRelaunching(site) ? " lors de l'analyse précédente" : ""}, chacune notée sur 100. Triez, filtrez, et ouvrez une page pour voir chacun de ses critères et son aperçu dans Google.`
            : "Chaque page est notée sur 100, avec ses critères et son aperçu dans Google."
        }
      />
      {reason !== null && <NoResults site={site} running="Chaque page s'ajoute ici dès qu'elle est notée." />}
      {reason === null && <ReliabilityNote site={site} compact />}
      {reason === null && <QueryError q={q} />}
      {reason === null && !all && !q.error && (<><LoadingLabel /><Skeleton w={420} h={34} r={8} /><div style={{ height: 20 }} /><SkeletonRows rows={10} height={60} /></>)}
      {reason === null && all && all.length === 0 && (
        <EmptyState title={firstRun ? "Les pages arrivent" : "Aucune page analysée"}>
          {firstRun ? "Chaque page s'ajoute ici dès qu'elle est notée." : "La liste n'est pas encore disponible. Réessayez dans un instant."}
        </EmptyState>
      )}
      {reason === null && all && all.length > 0 && (
        <>
          <div className="toolbar toolbar--pages">
            <label className="search pages__search">
              <Search size={15} aria-hidden />
              <span className="sr-only">Rechercher une page</span>
              <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Rechercher une adresse ou un titre" />
            </label>
            <Tabs<Band>
              label="Filtrer par note"
              value={band}
              onChange={setBand}
              items={[
                { id: "all", label: "Toutes", count: bandCounts.all },
                { id: "critical", label: "Faibles", count: bandCounts.critical },
                { id: "warning", label: "Moyennes", count: bandCounts.warning },
                { id: "good", label: "Bonnes", count: bandCounts.good },
              ]}
            />
            {typeCounts.length > 1 && (
              <select className="select" aria-label="Filtrer par type de page" value={ptype} onChange={(e) => setPtype(e.target.value as PageType | "all")}>
                <option value="all">Tous les types ({fmtInt(all.length)})</option>
                {typeCounts.map(({ t, n }) => (
                  <option key={t} value={t}>{PAGE_TYPE_LABEL[t].many} ({fmtInt(n)})</option>
                ))}
              </select>
            )}
            {mobile && (
              <select className="select" aria-label="Trier par" value={`${sort.key}:${sort.dir}`} onChange={(e) => { const [k, d] = e.target.value.split(":"); setSort({ key: k as SortKey, dir: Number(d) as 1 | -1 }); }}>
                <option value="score:1">Note la plus basse</option>
                <option value="score:-1">Note la plus haute</option>
                <option value="issues:-1">Plus de problèmes</option>
                {hasOrganic && <option value="clicks:-1">Plus de clics</option>}
                <option value="path:1">Adresse (A à Z)</option>
                <option value="type:1">Type de page</option>
              </select>
            )}
          </div>
          <div className="pages__count">
            <p aria-live="polite">
              {rows.length === all.length ? plural(all.length, "page", "pages") : `${fmtInt(rows.length)} sur ${plural(all.length, "page", "pages")}`}
              {firstRun && " — la liste s'allonge au fil de l'analyse"}
            </p>
            {viaCatalogue > 0 && (
              <p className="pages__catalogue">
                {viaCatalogue > 1 ? `Les ${fmtInt(viaCatalogue)} produits lus dans le catalogue ne figurent pas ici : leur page n'a pas été ouverte, leurs problèmes sont dans l'audit.` : "Le produit lu dans le catalogue ne figure pas ici : sa page n'a pas été ouverte, ses problèmes sont dans l'audit."}
              </p>
            )}
            {r && r.pagesFailed > 0 && <FailedPagesToggle site={site} count={r.pagesFailed} label={`${plural(r.pagesFailed, "page non chargée", "pages non chargées")}, absente${r.pagesFailed > 1 ? "s" : ""} de la liste`} />}
          </div>

          <div className={`ptable ${hasOrganic ? "ptable--organic" : ""}`} role="table" aria-label="Pages analysées" aria-rowcount={rows.length + 1}>
            <div className="ptable__head" role="row">
              <SortHeader k="path" label="Page" sort={sort} onSort={onSort} />
              <SortHeader k="type" label="Type" sort={sort} onSort={onSort} className="ptable__type" />
              <SortHeader k="score" label="Note" sort={sort} onSort={onSort} />
              <SortHeader k="issues" label="Problèmes" sort={sort} onSort={onSort} align="right" />
              <SortHeader k="words" label="Mots" sort={sort} onSort={onSort} align="right" className="ptable__words" />
              {hasOrganic && <SortHeader k="clicks" label="Clics" sort={sort} onSort={onSort} align="right" />}
              {hasOrganic && <SortHeader k="position" label="Position" sort={sort} onSort={onSort} align="right" className="ptable__pos" />}
              <div role="columnheader" className="ptable__th"><span className="sr-only">État</span></div>
            </div>
            <div ref={v.ref} role="rowgroup" className="ptable__body" style={{ height: rows.length * rowH }}>
              <div style={{ transform: `translateY(${v.before}px)` }}>
                {rows.slice(v.start, v.end).map((p) => <PageRow key={p.id} p={p} siteId={site.id} hasOrganic={hasOrganic} />)}
              </div>
            </div>
            {rows.length === 0 && <p className="muted ptable__none">Aucune page ne correspond à ces filtres.</p>}
          </div>
        </>
      )}
      <PageSheet site={site} pageId={pageId} onClose={() => closeDetail(sitePath(site.id, "pages"))} />
    </>
  );
}
