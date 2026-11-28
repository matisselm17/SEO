/**
 * Section « Boutique Shopify » : état de la connexion, lecture de la boutique, liste des éléments avec ce que
 * l'analyse a réellement vu sur leur page, lots de corrections, historique des modifications, automatisation.
 * Chaque onglet a sa propre adresse (/boutique, /boutique/lots, /boutique/historique, /boutique/automatisation).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowRight, BookOpenCheck, FileText, CircleCheck, CircleMinus, Info, KeyRound, ListPlus, Lock, OctagonAlert, RefreshCw, Search, ShoppingBag, Store, TriangleAlert, X, Zap } from "lucide-react";
import type { CheckStatus, ShopifyChange, ShopifyField, ShopifyResourceSummary, ShopifyResourceType, ShopifyState, SiteSummary } from "../lib/types";
import { SHOPIFY_PAGE, useAutomation, useShopify, useShopifyBatches, useShopifyChanges, useShopifyResources, useSites, type ShopifyResourceFilter } from "../lib/queries";
import { NEW_BATCH, navigate, shopPath, sitePath, type ShopifyView } from "../lib/router";
import { automationTabLabel, autoActive, sectionIntro, TYPE_LABEL, TYPE_ORDER, VERDICT_LABEL, syncShopify, useShopifySyncing } from "../lib/shopify";
import { addDraftLines, lineKey, useDraftLines, type DraftLine } from "../lib/batchDraft";
import { toAppError } from "../lib/api";
import { invalidateShopify } from "../lib/live";
import { fmtDateTime, fmtInt, fmtRelative, pl, plural } from "../lib/format";
import { PageHeader } from "../ui/Section";
import { Button, ButtonLink, Link } from "../ui/Button";
import { ScorePill } from "../ui/Badge";
import { Tabs } from "../ui/Tabs";
import { Meter } from "../ui/Meter";
import { Pagination } from "../ui/Pagination";
import { EmptyState, ErrorState } from "../ui/States";
import { Skeleton, SkeletonRows, LoadingLabel } from "../ui/Skeleton";
import { useToast } from "../ui/Toast";
import { QueryError } from "./common";
import { ShopifyResourceSheet } from "./ShopifyResource";
import { ChangeList, ConfirmWrite, type WriteIntent } from "./ShopifyChanges";
import { BatchDetail, BatchList, Composer, DraftBar } from "./ShopifyBatches";
import { AutomationPanel } from "./ShopifyAutomation";
import { READONLY_ID, useSticky } from "./shopShared";
import { isEmbedded } from "../lib/embedded";
import { reportPath } from "./Evolution";


function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function SyncButton({ site, variant = "secondary", label }: { site: SiteSummary; variant?: "secondary" | "primary"; label: string }) {
  const syncing = useShopifySyncing(site.id);
  const toast = useToast();
  return (
    <Button
      variant={variant}
      icon={<RefreshCw size={15} aria-hidden />}
      loading={syncing}
      onClick={async () => {
        try {
          const s = await syncShopify(site.id);
          const n = s.sync ? Object.values(s.sync.counts).reduce((a, b) => a + b, 0) : 0;
          toast.show({ tone: "success", title: "Boutique lue", text: `${plural(n, "élément relevé", "éléments relevés")}. Rien n'a été modifié dans Shopify.` });
        } catch (err) {
          const e = toAppError(err);
          toast.show({ tone: "error", title: e.message, text: e.action });
        }
      }}
    >
      {syncing ? "Lecture en cours…" : label}
    </Button>
  );
}

const VERDICT_ICON = { pass: CircleCheck, warn: TriangleAlert, fail: OctagonAlert } as const;

/**
 * Ce que l'analyse a vu sur la page affichée, pour un champ : un mot et une icône (jamais la couleur seule).
 * Un champ vide dans Shopify est dit en information neutre, sous le verdict : ce n'est pas un défaut en soi.
 */
function Displayed({ status, empty, label }: { status: CheckStatus | null; empty: boolean; label: string }) {
  if (status === null) {
    return (
      <span className="dstate dstate--na">
        <span className="dstate__word">Non vérifié</span>
        <span className="dstate__sub">{empty ? "Vide dans Shopify" : "Renseigné dans Shopify"}</span>
        <span className="sr-only"> : {label}, page non ouverte par l'analyse</span>
      </span>
    );
  }
  const Icon = VERDICT_ICON[status];
  return (
    <span className={`dstate dstate--${status}`}>
      <span className="dstate__word"><Icon size={14} aria-hidden />{VERDICT_LABEL[status]}</span>
      {empty && <span className="dstate__sub">Vide dans Shopify</span>}
      <span className="sr-only"> : {label}</span>
    </span>
  );
}

function ImagesState({ r }: { r: ShopifyResourceSummary }) {
  if (r.images === 0) return <span className="subtle">Aucune image</span>;
  if (r.imagesWithoutAlt === 0) return <span className="fstate fstate--ok"><CircleCheck size={14} aria-hidden /><span className="fstate__word">{r.images > 1 ? `Les ${r.images} décrites` : "Décrite"}</span></span>;
  return (
    <span className="fstate fstate--empty">
      <CircleMinus size={14} aria-hidden />
      <span className="fstate__word tnum">{r.imagesWithoutAlt} sur {r.images} sans texte</span>
    </span>
  );
}

function ResourceRow({ r, siteId, selected, onSelect }: { r: ShopifyResourceSummary; siteId: string; selected: boolean; onSelect: (on: boolean) => void }) {
  const a = r.audit;
  const issues: string[] = [];
  if (a && a.titleStatus !== "pass") issues.push(a.titleStatus === "fail" ? "Titre absent" : "Titre à revoir");
  if (a && a.descriptionStatus !== "pass") issues.push(a.descriptionStatus === "fail" ? "Description absente" : "Description à revoir");
  if (r.imagesWithoutAlt > 0) issues.push(plural(r.imagesWithoutAlt, "image sans texte", "images sans texte"));
  return (
    <li className={`srow ${selected ? "is-selected" : ""}`}>
      <span className="srow__check">
        <input type="checkbox" className="check" checked={selected} onChange={(e) => onSelect(e.target.checked)} aria-label={`Sélectionner ${r.title}`} />
      </span>
      <span className="srow__main">
        <Link to={sitePath(siteId, "shopify", r.id)} className="srow__title srow__link">{r.title}</Link>
        <span className="srow__path mono">{r.path}</span>
      </span>
      <span className="srow__type">{TYPE_LABEL[r.type].one}</span>
      <span className="srow__cell"><Displayed status={a?.titleStatus ?? null} empty={!r.seoTitle} label="titre affiché dans Google" /></span>
      <span className="srow__cell"><Displayed status={a?.descriptionStatus ?? null} empty={!r.seoDescription} label="description affichée dans Google" /></span>
      <span className="srow__cell"><ImagesState r={r} /></span>
      <span className="srow__score">{r.pageScore !== null ? <ScorePill score={r.pageScore} /> : <span className="subtle srow__na">Non analysée</span>}</span>
      <ArrowRight size={16} className="row-arrow" aria-hidden />
      {/* Sur écran étroit : un résumé de ce qui est réellement à corriger. */}
      <span className="srow__compact" aria-hidden>
        <span className="srow__ctype">{TYPE_LABEL[r.type].one}</span>
        {!a && <span className="srow__cna">Page non ouverte par l'analyse</span>}
        {issues.map((t) => <span key={t} className="srow__cmiss">{t}</span>)}
        {a && issues.length === 0 && <span className="srow__cok"><CircleCheck size={12} aria-hidden /> Rien à corriger</span>}
      </span>
    </li>
  );
}

/** Filtre de la liste : à corriger d'après l'analyse (fix), ou vide dans Shopify (missing). */
type Show = "" | "fix:seo_title" | "fix:seo_description" | "missing:image_alt" | "missing:seo_title" | "missing:seo_description";
const SHOW_LABEL: Record<Exclude<Show, "">, string> = {
  "fix:seo_title": "Titre affiché à revoir",
  "fix:seo_description": "Description affichée à revoir",
  "missing:image_alt": "Images sans texte alternatif",
  "missing:seo_title": "Titre pour Google vide",
  "missing:seo_description": "Description pour Google vide",
};

function filterOf(show: Show): Pick<ShopifyResourceFilter, "fix" | "missing"> {
  if (show.startsWith("fix:")) return { fix: show.slice(4) as "seo_title" | "seo_description", missing: null };
  if (show.startsWith("missing:")) return { fix: null, missing: show.slice(8) as ShopifyField };
  return { fix: null, missing: null };
}

function Stat({ label, value, of, unit, tone, active, disabled, onClick, sub }: {
  label: string; value: number | null; of: number; unit: string; tone: "warning" | "good" | "neutral"; active: boolean; disabled: boolean; onClick: () => void; sub?: ReactNode;
}) {
  return (
    <button type="button" className={`shopstats__item ${active ? "is-active" : ""}`} aria-pressed={active} onClick={onClick} disabled={disabled}>
      <span className="shopstats__label">{label}</span>
      <span className="shopstats__value tnum">
        {value === null ? "—" : fmtInt(value)}
        <span className="shopstats__of">{value === null ? " aucune page analysée" : ` sur ${fmtInt(of)} ${unit}`}</span>
      </span>
      {value !== null && <Meter value={value} max={Math.max(1, of)} tone={tone} />}
      {sub && <span className="shopstats__sub">{sub}</span>}
    </button>
  );
}

/** Lignes ajoutées au lot en préparation depuis la liste : une ligne par élément, valeur à rédiger. */
function toDraftLine(r: ShopifyResourceSummary, field: "seo_title" | "seo_description"): DraftLine {
  const a = r.audit;
  return {
    key: lineKey(r.id, field, null, null), resourceId: r.id, resourceType: r.type, title: r.title, path: r.path, field,
    imageId: null, imageUrl: null, imageIndex: null, locale: null,
    current: field === "seo_title" ? r.seoTitle : r.seoDescription,
    rendered: a ? (field === "seo_title" ? { text: a.renderedTitle, status: a.titleStatus } : { text: a.renderedDescription, status: a.descriptionStatus }) : null,
    value: "",
  };
}

function SelectionBar({ site, selected, onClear }: { site: SiteSummary; selected: Map<string, ShopifyResourceSummary>; onClear: () => void }) {
  const toast = useToast();
  const [field, setField] = useState<"seo_title" | "seo_description">("seo_description");
  const n = selected.size;
  if (n === 0) return null;
  const add = () => {
    const res = addDraftLines(site.id, [...selected.values()].map((r) => toDraftLine(r, field)));
    const parts = [res.added ? plural(res.added, "ligne ajoutée", "lignes ajoutées") : null, res.refused ? `${plural(res.refused, "ligne refusée", "lignes refusées")} (50 au plus par lot)` : null].filter(Boolean);
    toast.show({
      tone: res.refused ? "error" : "success",
      title: res.added ? "Ajouté au lot en préparation" : "Déjà dans le lot en préparation",
      text: parts.length ? `${parts.join(", ")}. Rédigez une valeur pour chacune, puis créez le brouillon.` : "Ces lignes y figuraient déjà.",
      action: { label: "Rédiger", onClick: () => navigate(shopPath(site.id, "batches", NEW_BATCH)) },
    });
    onClear();
  };
  return (
    <div className="selbar" role="region" aria-label="Sélection">
      <p className="selbar__count"><strong className="tnum">{fmtInt(n)}</strong> {pl(n, "élément sélectionné", "éléments sélectionnés")}</p>
      <label className="selbar__field">
        <span className="selbar__label">Champ à corriger</span>
        <select className="select" value={field} onChange={(e) => setField(e.target.value as typeof field)}>
          <option value="seo_title">Titre pour Google</option>
          <option value="seo_description">Description pour Google</option>
        </select>
      </label>
      <div className="selbar__actions">
        <Button variant="primary" size="sm" icon={<ListPlus size={15} aria-hidden />} onClick={add}>Ajouter au lot</Button>
        <Button variant="ghost" size="sm" icon={<X size={14} aria-hidden />} onClick={onClear}>Désélectionner</Button>
      </div>
    </div>
  );
}

function Items({ site, sync }: { site: SiteSummary; sync: NonNullable<ShopifyState["sync"]> }) {
  const [type, setType] = useState<ShopifyResourceType | null>(null);
  const [show, setShow] = useState<Show>("");
  const [text, setText] = useState("");
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Map<string, ShopifyResourceSummary>>(() => new Map());
  const q = useDebounced(text.trim(), 250);
  useEffect(() => setOffset(0), [type, show, q]);
  const filter: ShopifyResourceFilter = { type, q, offset, ...filterOf(show) };
  const res = useShopifyResources(site.id, filter);
  const data = useSticky(res.data);
  const total = Object.values(sync.counts).reduce((a, b) => a + b, 0);
  const listTop = useRef<HTMLDivElement>(null);
  const goTo = (o: number) => {
    setOffset(o);
    listTop.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  const toggleShow = (s: Show) => setShow((cur) => (cur === s ? "" : s));
  const t = sync.toFix;
  const notAudited = Math.max(0, total - t.audited);
  const pageIds = data?.resources.map((r) => r.id) ?? [];
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const someOnPage = pageIds.some((id) => selected.has(id));
  const select = (r: ShopifyResourceSummary, on: boolean) =>
    setSelected((m) => {
      const n = new Map(m);
      if (on) n.set(r.id, r);
      else n.delete(r.id);
      return n;
    });
  const selectPage = (on: boolean) =>
    setSelected((m) => {
      const n = new Map(m);
      data?.resources.forEach((r) => (on ? n.set(r.id, r) : n.delete(r.id)));
      return n;
    });

  return (
    <>
      <div className="shopstats" role="group" aria-label="À corriger d'après l'analyse (filtrer la liste)">
        <div className="shopstats__item shopstats__item--static">
          <span className="shopstats__label">Éléments lus</span>
          <span className="shopstats__value tnum">{fmtInt(total)}</span>
          <span className="shopstats__sub">
            {TYPE_ORDER.filter((x) => sync.counts[x] > 0).map((x) => `${fmtInt(sync.counts[x])} ${TYPE_LABEL[x][sync.counts[x] > 1 ? "many" : "one"].toLowerCase()}`).join(" · ") || "Aucun élément"}
          </span>
        </div>
        <Stat
          label="Titre affiché à revoir" value={t.audited ? t.title : null} of={t.audited} unit={pl(t.audited, "page analysée", "pages analysées")}
          tone={t.title > 0 ? "warning" : "good"} active={show === "fix:seo_title"} disabled={!t.audited || (t.title === 0 && show !== "fix:seo_title")}
          onClick={() => toggleShow("fix:seo_title")}
        />
        <Stat
          label="Description affichée à revoir" value={t.audited ? t.description : null} of={t.audited} unit={pl(t.audited, "page analysée", "pages analysées")}
          tone={t.description > 0 ? "warning" : "good"} active={show === "fix:seo_description"} disabled={!t.audited || (t.description === 0 && show !== "fix:seo_description")}
          onClick={() => toggleShow("fix:seo_description")}
        />
        <Stat
          label="Images sans texte alternatif" value={sync.missing.imagesWithoutAlt} of={sync.missing.images} unit={pl(sync.missing.images, "image", "images")}
          tone={sync.missing.imagesWithoutAlt > 0 ? "warning" : "good"} active={show === "missing:image_alt"} disabled={sync.missing.imagesWithoutAlt === 0 && show !== "missing:image_alt"}
          onClick={() => toggleShow("missing:image_alt")}
        />
      </div>

      <div className="shop-facts">
        <Info size={15} aria-hidden className="shop-facts__icon" />
        <div className="shop-facts__body">
          <p>
            <strong>Champs vides dans Shopify :</strong>{" "}
            <button type="button" className="link-btn" onClick={() => toggleShow("missing:seo_title")} aria-pressed={show === "missing:seo_title"}>{plural(sync.missing.seoTitle, "titre pour Google", "titres pour Google")}</button>{" "}
            (Shopify affiche alors le nom de l'élément) et{" "}
            <button type="button" className="link-btn" onClick={() => toggleShow("missing:seo_description")} aria-pressed={show === "missing:seo_description"}>{plural(sync.missing.seoDescription, "description", "descriptions")}</button>{" "}
            (Shopify affiche alors le début du texte).
          </p>
          <p className="shop-facts__muted">
            Un champ vide n'est pas un défaut en soi : seul compte le texte réellement affiché, que l'analyse vérifie page par page.
            {t.audited === 0
              ? " Aucune page de la boutique n'a été ouverte par l'analyse affichée : relancez l'analyse pour savoir lesquels sont réellement à corriger."
              : notAudited > 0 ? ` ${plural(notAudited, "élément n'a pas sa page ouverte", "éléments n'ont pas leur page ouverte")} par l'analyse : leur affichage n'est pas vérifié.` : ""}
          </p>
        </div>
      </div>

      <div className="toolbar shop-toolbar" ref={listTop}>
        <label className="search shop-search">
          <Search size={15} aria-hidden />
          <span className="sr-only">Rechercher un élément</span>
          <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Rechercher un nom ou une adresse" />
        </label>
        <Tabs<ShopifyResourceType | "all">
          label="Filtrer par type"
          value={type ?? "all"}
          onChange={(v) => setType(v === "all" ? null : v)}
          items={[
            { id: "all", label: "Tous", count: total },
            ...TYPE_ORDER.filter((x) => sync.counts[x] > 0).map((x) => ({ id: x, label: TYPE_LABEL[x].many, count: sync.counts[x] })),
          ]}
        />
        <select className="select" aria-label="Afficher" value={show} onChange={(e) => setShow(e.target.value as Show)}>
          <option value="">Tous les éléments</option>
          <optgroup label="À corriger d'après l'analyse">
            <option value="fix:seo_title">{SHOW_LABEL["fix:seo_title"]}</option>
            <option value="fix:seo_description">{SHOW_LABEL["fix:seo_description"]}</option>
            <option value="missing:image_alt">{SHOW_LABEL["missing:image_alt"]}</option>
          </optgroup>
          <optgroup label="Vide dans Shopify (information)">
            <option value="missing:seo_title">{SHOW_LABEL["missing:seo_title"]}</option>
            <option value="missing:seo_description">{SHOW_LABEL["missing:seo_description"]}</option>
          </optgroup>
        </select>
      </div>

      <div className="pages__count">
        <p aria-live="polite">
          {data ? (data.total === total && !show && !type && !q ? plural(total, "élément", "éléments") : `${fmtInt(data.total)} sur ${plural(total, "élément", "éléments")}`) : " "}
          {show && <span className="subtle"> · {SHOW_LABEL[show]}{show.startsWith("missing:seo") ? " (le texte affiché peut être correct)" : ""}</span>}
          {res.fetching && data && <span className="subtle"> · mise à jour…</span>}
        </p>
      </div>

      <QueryError q={res} />
      {!data && !res.error && (<><LoadingLabel /><SkeletonRows rows={8} height={60} /></>)}
      {data && (
        <div className={`stable ${res.fetching && res.data === undefined ? "is-loading" : ""}`}>
          <div className="stable__head">
            <span className="srow__check">
              <input
                type="checkbox"
                className="check"
                checked={allOnPage}
                ref={(el) => { if (el) el.indeterminate = !allOnPage && someOnPage; }}
                onChange={(e) => selectPage(e.target.checked)}
                aria-label="Sélectionner les éléments de cette page de la liste"
                disabled={pageIds.length === 0}
                id="shop-select-page"
              />
              <label htmlFor="shop-select-page" className="stable__alllabel" aria-hidden>Sélectionner cette page de la liste</label>
            </span>
            <span aria-hidden>Élément</span>
            <span aria-hidden>Type</span>
            <span aria-hidden title="Le titre que Google lit sur la page, vérifié par l'analyse">Titre affiché</span>
            <span aria-hidden title="La description que Google lit sur la page, vérifiée par l'analyse">Description affichée</span>
            <span aria-hidden>Images</span>
            <span aria-hidden>Note de la page</span>
            <span />
          </div>
          {data.resources.length > 0 ? (
            <ul className="stable__body" aria-label="Éléments de la boutique">
              {data.resources.map((r) => <ResourceRow key={r.id} r={r} siteId={site.id} selected={selected.has(r.id)} onSelect={(on) => select(r, on)} />)}
            </ul>
          ) : (
            <EmptyState title="Aucun élément ne correspond">
              <button type="button" className="link-btn" onClick={() => { setText(""); setType(null); setShow(""); }}>Retirer les filtres</button>
            </EmptyState>
          )}
          <Pagination offset={data.offset} limit={SHOPIFY_PAGE} total={data.total} onChange={goTo} label="Pages de la liste des éléments" />
        </div>
      )}
      <SelectionBar site={site} selected={selected} onClear={() => setSelected(new Map())} />
    </>
  );
}

function History({ site, onRestore, blocked }: { site: SiteSummary; onRestore: (c: ShopifyChange) => void; blocked: string | null }) {
  const [offset, setOffset] = useState(0);
  const q = useShopifyChanges(site.id, offset);
  const batches = useShopifyBatches(site.id).data?.batches;
  const batchTitles = useMemo(() => new Map((batches ?? []).map((b) => [b.id, { title: b.title, auto: b.autoApplied }])), [batches]);
  const data = useSticky(q.data);
  return (
    <>
      <p className="shop-history__lead">Chaque modification faite depuis Chat SEO, la plus récente d'abord, seule ou au sein d'un lot de corrections. Rien n'est jamais effacé de cet historique. Seule la dernière modification d'un champ peut être annulée : la valeur d'avant est alors remise dans la boutique.</p>
      <p className="shop-history__report">
        <Link to={reportPath(site.id)} className="text-link"><FileText size={15} aria-hidden />Rapport d'optimisation</Link>
        <span className="muted"> : l'évolution de la note et les corrections vérifiées, à imprimer ou à enregistrer en PDF.</span>
      </p>
      <QueryError q={q} />
      {!data && !q.error && (<><LoadingLabel /><SkeletonRows rows={5} height={96} /></>)}
      {data && (
        <>
          <ChangeList
            site={site}
            changes={data.changes}
            onRestore={onRestore}
            blocked={blocked}
            batchTitles={batchTitles}
            empty={<EmptyState title="Aucune modification pour l'instant">Les modifications faites depuis la fiche d'un élément ou par un lot de corrections apparaîtront ici, avec la possibilité de les annuler.</EmptyState>}
          />
          <Pagination offset={data.offset} limit={SHOPIFY_PAGE} total={data.total} onChange={setOffset} label="Pages de l'historique" />
        </>
      )}
    </>
  );
}

const WRITES_OFF = "Lecture seule : les modifications sont désactivées sur ce serveur.";

function Connected({ site, state, resourceId, view, batchId }: { site: SiteSummary; state: ShopifyState; resourceId: string | null; view: ShopifyView; batchId: string | null }) {
  const c = state.connection;
  const [intent, setIntent] = useState<WriteIntent | null>(null);
  const changes = useShopifyChanges(site.id, state.sync ? 0 : null);
  const batches = useShopifyBatches(site.id, !!state.sync);
  const draftLines = useDraftLines(site.id);
  const syncing = useShopifySyncing(site.id);
  const listPath = sitePath(site.id, "shopify");
  const toValidate = batches.data?.batches.filter((b) => b.state === "draft").length ?? 0;
  const closeSheet = () => {
    const prev = (window.history.state as { prev?: string | null } | null)?.prev ?? null;
    if (prev) window.history.back();
    else navigate(listPath, { replace: true });
  };
  const onComposer = view === "batches" && batchId === NEW_BATCH;
  // Le mode automatique réellement en vigueur (verrous 1 à 3) : signalé en permanence en tête de section.
  const automation = useAutomation(site.id, !!state.sync);
  const auto = autoActive(automation.data);

  return (
    <>
      <PageHeader
        title="Boutique Shopify"
        description={sectionIntro(auto)}
        meta={
          <span className="shop-meta">
            <Store size={14} aria-hidden />
            <strong>{c.shopName ?? c.shopHost}</strong>
            {c.shopHost && <span className="mono">{c.shopHost}</span>}
            {state.sync && (
              <span className="shop-meta__when">Lue {fmtRelative(state.sync.syncedAt)} <span className="subtle">({fmtDateTime(state.sync.syncedAt)})</span></span>
            )}
          </span>
        }
        actions={state.sync ? <SyncButton site={site} label="Relire la boutique" /> : undefined}
      />

      {(!c.writesEnabled || c.missingScopes.length > 0 || auto) && (
        <div className="shop-limits">
          {auto && (
            <p className="shop-limit shop-limit--auto">
              <Zap size={15} aria-hidden className="shop-limit__icon" />
              <span>
                <strong>Écritures automatiques actives.</strong> Les lots de « Préparer des corrections avec l'IA » peuvent être écrits dans la boutique sans votre validation, dans les limites de la règle.{" "}
                {view !== "automation" && <Link to={shopPath(site.id, "automation")} className="text-link">Voir la règle d'automatisation</Link>}
              </span>
            </p>
          )}
          {!c.writesEnabled && (
            <p className="shop-limit" id={READONLY_ID}>
              <Lock size={15} aria-hidden className="shop-limit__icon" />
              <span><strong>Lecture seule.</strong> Vous pouvez tout consulter et préparer vos textes et vos lots, mais rien n'est appliqué à la boutique : la personne qui gère l'installation active les modifications côté serveur.</span>
            </p>
          )}
          {c.missingScopes.map((m) => (
            <p className="shop-limit shop-limit--warning" key={m.scope}>
              <KeyRound size={15} aria-hidden className="shop-limit__icon" />
              <span><strong>Permission manquante.</strong> L'application Shopify ne peut pas {m.blocks.charAt(0).toLowerCase() + m.blocks.slice(1)} ; la personne qui gère l'installation peut {c.missingScopes.length > 1 ? "accorder ces permissions" : "accorder cette permission"} dans les réglages de l'application.</span>
            </p>
          ))}
        </div>
      )}

      {!state.sync ? (
        <EmptyState
          tone="framed"
          icon={<BookOpenCheck size={20} />}
          title="Lisez votre boutique pour commencer"
          actions={<SyncButton site={site} variant="primary" label="Lire la boutique" />}
        >
          <p>Chat SEO va parcourir vos produits, collections, pages et articles pour relever leur titre et leur description pour Google, et le texte alternatif de leurs images.</p>
          <p><strong>C'est une lecture seule : rien n'est modifié dans Shopify.</strong>{syncing ? " La lecture peut prendre une minute ; vous pouvez parcourir les autres sections en attendant." : ""}</p>
        </EmptyState>
      ) : (
        <>
          <div className="toolbar toolbar--tabs shop-tabs">
            <Tabs<ShopifyView>
              label="Vue"
              value={view}
              onChange={(v) => navigate(shopPath(site.id, v))}
              items={[
                { id: "items", label: "Éléments" },
                { id: "batches", label: "Lots de corrections", count: toValidate || undefined },
                { id: "history", label: "Historique", count: changes.data?.total },
                { id: "automation", label: automationTabLabel(isEmbedded()) },
              ]}
            />
          </div>
          {draftLines.length > 0 && !onComposer && <DraftBar site={site} lines={draftLines} />}
          {view === "items" && <Items site={site} sync={state.sync} />}
          {view === "batches" && (batchId === NEW_BATCH ? <Composer site={site} /> : batchId ? <BatchDetail site={site} batchId={batchId} writesEnabled={c.writesEnabled} /> : <BatchList site={site} />)}
          {view === "history" && <History site={site} blocked={c.writesEnabled ? null : WRITES_OFF} onRestore={(ch) => setIntent({ kind: "restore", change: ch })} />}
          {view === "automation" && <AutomationPanel site={site} />}
        </>
      )}

      <ShopifyResourceSheet site={site} shop={state} resourceId={state.sync ? resourceId : null} onClose={closeSheet} />
      <ConfirmWrite site={site} intent={intent} onClose={() => setIntent(null)} onReload={() => invalidateShopify(site.id)} />
    </>
  );
}

export function ShopifyScreen({ site, resourceId, view, batchId }: { site: SiteSummary; resourceId: string | null; view: ShopifyView; batchId: string | null }) {
  const q = useShopify(site.id);
  const sites = useSites().data?.sites ?? [];
  const state = q.data;

  if (!state) {
    if (q.error) {
      return (
        <>
          <PageHeader title="Boutique Shopify" />
          <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.fetching} />
        </>
      );
    }
    return (
      <>
        <LoadingLabel />
        <Skeleton w={220} h={26} />
        <div style={{ height: 12 }} />
        <Skeleton w={460} h={12} />
        <div style={{ height: 32 }} />
        <div className="shopstats" aria-hidden>{Array.from({ length: 4 }, (_, i) => <div key={i} className="shopstats__item shopstats__item--static"><Skeleton w="60%" h={10} /><Skeleton w="40%" h={20} /><Skeleton h={5} /></div>)}</div>
        <SkeletonRows rows={8} height={60} />
      </>
    );
  }

  const c = state.connection;
  if (c.state === "connected") return <Connected site={site} state={state} resourceId={resourceId} view={view} batchId={batchId} />;

  const other = c.state === "other_shop" && c.shopHost ? sites.find((s) => s.host.replace(/^www\./, "") === c.shopHost) : null;
  return (
    <>
      <PageHeader title="Boutique Shopify" description={sectionIntro(false)} />
      {q.error && <ErrorState error={q.error} inline onRetry={() => void q.refetch()} retrying={q.fetching} />}
      {c.state === "not_configured" && (
        <EmptyState tone="framed" icon={<ShoppingBag size={20} />} title="Aucune boutique Shopify n'est connectée">
          <p>La connexion à une boutique se fait sur le serveur, par la personne qui gère l'installation de Chat SEO. Une fois la boutique connectée, cette section affiche ses produits, collections, pages et articles, et permet d'en corriger les textes lus par Google.</p>
        </EmptyState>
      )}
      {c.state === "other_shop" && (
        <EmptyState
          tone="framed"
          icon={<Store size={20} />}
          title="La boutique connectée est celle d'un autre site"
          actions={other ? <ButtonLink to={sitePath(other.id, "shopify")} variant="primary">Ouvrir {other.host}</ButtonLink> : undefined}
        >
          <p>
            Cette installation est reliée à la boutique {c.shopName ? <strong>{c.shopName}</strong> : "Shopify"}{c.shopHost ? <> (<span className="mono">{c.shopHost}</span>)</> : null}, qui ne correspond pas à <span className="mono">{site.host}</span>.
          </p>
          <p>{other ? "Ouvrez ce site-là pour gérer sa boutique." : c.shopHost ? `Ajoutez le site ${c.shopHost} pour gérer sa boutique.` : "Ouvrez le site de cette boutique pour la gérer."}</p>
        </EmptyState>
      )}
      {c.state === "error" && (
        <ErrorState
          error={{
            code: c.error?.code ?? "shopify_unavailable",
            message: c.error?.message ?? "La connexion à Shopify a échoué.",
            action: c.error?.action ?? "Réessayez dans quelques minutes.",
            status: 0,
            details: c.error?.details,
          }}
          onRetry={() => void q.refetch()}
          retrying={q.fetching}
          retryLabel="Vérifier à nouveau"
        />
      )}
      {c.state === "error" && (
        <p className="muted small shop-error-note"><TriangleAlert size={13} aria-hidden /> Rien n'a été lu ni modifié. Les autres sections de Chat SEO restent disponibles.</p>
      )}
    </>
  );
}
