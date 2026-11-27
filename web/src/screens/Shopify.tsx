/**
 * Section « Boutique Shopify » : état de la connexion, lecture de la boutique, liste des éléments avec
 * l'état de leurs champs, et historique des modifications avec annulation.
 */
import { useEffect, useRef, useState } from "react";
import { ArrowRight, BookOpenCheck, CircleCheck, CircleMinus, KeyRound, Lock, RefreshCw, Search, ShoppingBag, Store, TriangleAlert } from "lucide-react";
import type { ShopifyChange, ShopifyField, ShopifyResourceSummary, ShopifyResourceType, ShopifyState, SiteSummary } from "../lib/types";
import { SHOPIFY_PAGE, useShopify, useShopifyChanges, useShopifyResources, useSites, type ShopifyResourceFilter } from "../lib/queries";
import { navigate, sitePath } from "../lib/router";
import { SECTION_INTRO, TYPE_LABEL, TYPE_ORDER, syncShopify, useShopifySyncing } from "../lib/shopify";
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

type View = "items" | "history";

/** Garde la dernière donnée affichée pendant le chargement d'un nouveau filtre : pas de saut de mise en page. */
function useSticky<T>(value: T | undefined): T | undefined {
  const ref = useRef(value);
  if (value !== undefined) ref.current = value;
  return value ?? ref.current;
}

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

/** Champ renseigné ou vide : une icône et un mot, jamais la couleur seule. */
function FieldState({ filled, label }: { filled: boolean; label: string }) {
  return (
    <span className={`fstate ${filled ? "fstate--ok" : "fstate--empty"}`}>
      {filled ? <CircleCheck size={14} aria-hidden /> : <CircleMinus size={14} aria-hidden />}
      <span className="fstate__word">{filled ? "Renseigné" : "Vide"}</span>
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

function ResourceRow({ r, siteId }: { r: ShopifyResourceSummary; siteId: string }) {
  return (
    <li>
      <Link to={sitePath(siteId, "shopify", r.id)} className="srow">
        <span className="srow__main">
          <span className="srow__title">{r.title}</span>
          <span className="srow__path mono">{r.path}</span>
        </span>
        <span className="srow__type">{TYPE_LABEL[r.type].one}</span>
        <span className="srow__cell" data-label="Titre pour Google"><FieldState filled={!!r.seoTitle} label="titre pour Google" /></span>
        <span className="srow__cell" data-label="Description pour Google"><FieldState filled={!!r.seoDescription} label="description pour Google" /></span>
        <span className="srow__cell" data-label="Images"><ImagesState r={r} /></span>
        <span className="srow__score">{r.pageScore !== null ? <ScorePill score={r.pageScore} /> : <span className="subtle srow__na">Non analysée</span>}</span>
        <ArrowRight size={16} className="row-arrow" aria-hidden />
        {/* Sur écran étroit : un résumé des seuls champs à compléter. */}
        <span className="srow__compact" aria-hidden>
          <span className="srow__ctype">{TYPE_LABEL[r.type].one}</span>
          {!r.seoTitle && <span className="srow__cmiss">Titre vide</span>}
          {!r.seoDescription && <span className="srow__cmiss">Description vide</span>}
          {r.imagesWithoutAlt > 0 && <span className="srow__cmiss">{plural(r.imagesWithoutAlt, "image sans texte", "images sans texte")}</span>}
          {r.seoTitle && r.seoDescription && r.imagesWithoutAlt === 0 && <span className="srow__cok"><CircleCheck size={12} aria-hidden /> Tout est renseigné</span>}
        </span>
      </Link>
    </li>
  );
}

const MISSING_LABEL: Record<ShopifyField, string> = {
  seo_title: "Titre pour Google vide",
  seo_description: "Description pour Google vide",
  image_alt: "Images sans texte alternatif",
};

function Items({ site, sync }: { site: SiteSummary; sync: NonNullable<ShopifyState["sync"]> }) {
  const [type, setType] = useState<ShopifyResourceType | null>(null);
  const [missing, setMissing] = useState<ShopifyField | null>(null);
  const [text, setText] = useState("");
  const [offset, setOffset] = useState(0);
  const q = useDebounced(text.trim(), 250);
  useEffect(() => setOffset(0), [type, missing, q]);
  const filter: ShopifyResourceFilter = { type, missing, q, offset };
  const res = useShopifyResources(site.id, filter);
  const data = useSticky(res.data);
  const total = Object.values(sync.counts).reduce((a, b) => a + b, 0);
  const listTop = useRef<HTMLDivElement>(null);
  const goTo = (o: number) => {
    setOffset(o);
    listTop.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  const stats: { id: ShopifyField; label: string; n: number; of: number; unit: string }[] = [
    { id: "seo_title", label: "Sans titre pour Google", n: sync.missing.seoTitle, of: total, unit: pl(total, "élément", "éléments") },
    { id: "seo_description", label: "Sans description pour Google", n: sync.missing.seoDescription, of: total, unit: pl(total, "élément", "éléments") },
    { id: "image_alt", label: "Images sans texte alternatif", n: sync.missing.imagesWithoutAlt, of: sync.missing.images, unit: pl(sync.missing.images, "image", "images") },
  ];

  return (
    <>
      <div className="shopstats" role="group" aria-label="Champs vides dans la boutique (filtrer la liste)">
        <div className="shopstats__item shopstats__item--static">
          <span className="shopstats__label">Éléments lus</span>
          <span className="shopstats__value tnum">{fmtInt(total)}</span>
          <span className="shopstats__sub">
            {TYPE_ORDER.filter((t) => sync.counts[t] > 0).map((t) => `${fmtInt(sync.counts[t])} ${TYPE_LABEL[t][sync.counts[t] > 1 ? "many" : "one"].toLowerCase()}`).join(" · ") || "Aucun élément"}
          </span>
        </div>
        {stats.map((s) => {
          const active = missing === s.id;
          return (
            <button key={s.id} type="button" className={`shopstats__item ${active ? "is-active" : ""}`} aria-pressed={active} onClick={() => setMissing(active ? null : s.id)} disabled={s.n === 0 && !active}>
              <span className="shopstats__label">{s.label}</span>
              <span className="shopstats__value tnum">{fmtInt(s.n)}<span className="shopstats__of"> sur {fmtInt(s.of)} {s.unit}</span></span>
              <Meter value={s.n} max={Math.max(1, s.of)} tone={s.n > 0 ? "warning" : "good"} />
            </button>
          );
        })}
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
            ...TYPE_ORDER.filter((t) => sync.counts[t] > 0).map((t) => ({ id: t, label: TYPE_LABEL[t].many, count: sync.counts[t] })),
          ]}
        />
        <select className="select" aria-label="Filtrer par champ vide" value={missing ?? ""} onChange={(e) => setMissing((e.target.value || null) as ShopifyField | null)}>
          <option value="">Tous les champs</option>
          {(Object.keys(MISSING_LABEL) as ShopifyField[]).map((f) => <option key={f} value={f}>{MISSING_LABEL[f]}</option>)}
        </select>
      </div>

      <div className="pages__count">
        <p aria-live="polite">
          {data ? (data.total === total && !missing && !type && !q ? plural(total, "élément", "éléments") : `${fmtInt(data.total)} sur ${plural(total, "élément", "éléments")}`) : " "}
          {res.fetching && data && <span className="subtle"> · mise à jour…</span>}
        </p>
      </div>

      <QueryError q={res} />
      {!data && !res.error && (<><LoadingLabel /><SkeletonRows rows={8} height={60} /></>)}
      {data && (
        <div className={`stable ${res.fetching && res.data === undefined ? "is-loading" : ""}`}>
          <div className="stable__head" aria-hidden>
            <span>Élément</span>
            <span>Type</span>
            <span>Titre pour Google</span>
            <span>Description pour Google</span>
            <span>Images</span>
            <span>Note de la page</span>
            <span />
          </div>
          {data.resources.length > 0 ? (
            <ul className="stable__body" aria-label="Éléments de la boutique">
              {data.resources.map((r) => <ResourceRow key={r.id} r={r} siteId={site.id} />)}
            </ul>
          ) : (
            <EmptyState title="Aucun élément ne correspond">
              <button type="button" className="link-btn" onClick={() => { setText(""); setType(null); setMissing(null); }}>Retirer les filtres</button>
            </EmptyState>
          )}
          <Pagination offset={data.offset} limit={SHOPIFY_PAGE} total={data.total} onChange={goTo} label="Pages de la liste des éléments" />
        </div>
      )}
    </>
  );
}

function History({ site, onRestore, blocked }: { site: SiteSummary; onRestore: (c: ShopifyChange) => void; blocked: string | null }) {
  const [offset, setOffset] = useState(0);
  const q = useShopifyChanges(site.id, offset);
  const data = useSticky(q.data);
  return (
    <>
      <p className="shop-history__lead">Chaque modification faite depuis Chat SEO, la plus récente d'abord. Rien n'est jamais effacé de cet historique. Seule la dernière modification d'un champ peut être annulée : la valeur d'avant est alors remise dans la boutique.</p>
      <QueryError q={q} />
      {!data && !q.error && (<><LoadingLabel /><SkeletonRows rows={5} height={96} /></>)}
      {data && (
        <>
          <ChangeList
            site={site}
            changes={data.changes}
            onRestore={onRestore}
            blocked={blocked}
            empty={<EmptyState title="Aucune modification pour l'instant">Les modifications faites depuis la fiche d'un élément apparaîtront ici, avec la possibilité de les annuler.</EmptyState>}
          />
          <Pagination offset={data.offset} limit={SHOPIFY_PAGE} total={data.total} onChange={setOffset} label="Pages de l'historique" />
        </>
      )}
    </>
  );
}

function Connected({ site, state, resourceId }: { site: SiteSummary; state: ShopifyState; resourceId: string | null }) {
  const c = state.connection;
  const [view, setView] = useState<View>("items");
  const [intent, setIntent] = useState<WriteIntent | null>(null);
  const changes = useShopifyChanges(site.id, state.sync ? 0 : null);
  const syncing = useShopifySyncing(site.id);
  const listPath = sitePath(site.id, "shopify");
  const closeSheet = () => {
    const prev = (window.history.state as { prev?: string | null } | null)?.prev ?? null;
    if (prev) window.history.back();
    else navigate(listPath, { replace: true });
  };

  return (
    <>
      <PageHeader
        title="Boutique Shopify"
        description={SECTION_INTRO}
        meta={
          <span className="shop-meta">
            <Store size={14} aria-hidden />
            <strong>{c.shopName ?? c.shopHost}</strong>
            {c.shopHost && <span className="mono">{c.shopHost}</span>}
            {state.sync && (
              <>
                <span className="shop-meta__when">Lue {fmtRelative(state.sync.syncedAt)} <span className="subtle">({fmtDateTime(state.sync.syncedAt)})</span></span>
              </>
            )}
          </span>
        }
        actions={state.sync ? <SyncButton site={site} label="Relire la boutique" /> : undefined}
      />

      {(!c.writesEnabled || c.missingScopes.length > 0) && (
        <div className="shop-limits">
          {!c.writesEnabled && (
            <p className="shop-limit">
              <Lock size={15} aria-hidden className="shop-limit__icon" />
              <span><strong>Lecture seule.</strong> Vous pouvez tout consulter et préparer vos textes, mais rien n'est appliqué à la boutique : la personne qui gère l'installation active les modifications côté serveur.</span>
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
            <Tabs<View>
              label="Vue"
              value={view}
              onChange={setView}
              items={[
                { id: "items", label: "Éléments" },
                { id: "history", label: "Historique des modifications", count: changes.data?.total },
              ]}
            />
          </div>
          {view === "items" ? <Items site={site} sync={state.sync} /> : <History site={site} blocked={c.writesEnabled ? null : "Lecture seule : les modifications sont désactivées sur ce serveur."} onRestore={(ch) => setIntent({ kind: "restore", change: ch })} />}
        </>
      )}

      <ShopifyResourceSheet site={site} shop={state} resourceId={state.sync ? resourceId : null} onClose={closeSheet} />
      <ConfirmWrite site={site} intent={intent} onClose={() => setIntent(null)} onReload={() => invalidateShopify(site.id)} />
    </>
  );
}

export function ShopifyScreen({ site, resourceId }: { site: SiteSummary; resourceId: string | null }) {
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
  if (c.state === "connected") return <Connected site={site} state={state} resourceId={resourceId} />;

  const other = c.state === "other_shop" && c.shopHost ? sites.find((s) => s.host.replace(/^www\./, "") === c.shopHost) : null;
  return (
    <>
      <PageHeader title="Boutique Shopify" description={SECTION_INTRO} />
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
