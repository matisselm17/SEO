/**
 * Lots de corrections : lot en préparation (dans le navigateur), liste des lots, écran d'un lot (relecture du
 * brouillon, validation, écriture ligne par ligne, bilan, annulation), préparation par l'IA, et la carte d'un lot
 * affichée sous une réponse de l'assistant.
 *
 * Garde-fous : rien n'est écrit sans une confirmation qui montre chaque valeur écrite ; le focus initial de cette
 * confirmation n'est jamais sur le bouton qui écrit ; les valeurs sont contrôlées par la même règle que le serveur
 * (valueProblem). Les textes venus de Shopify ou de l'IA sont affichés comme du texte brut.
 */
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import {
  ArrowLeft, ArrowRight, Bot, ChevronDown, CircleAlert, CircleCheck, CircleDashed, CircleMinus, History as HistoryIcon, Layers, ListPlus, LoaderCircle,
  Eye, OctagonPause, PenLine, Play, RotateCcw, Sparkles, Trash2, TriangleAlert, Undo2, X, Zap,
} from "lucide-react";
import type { AppError } from "../lib/api";
import { toAppError } from "../lib/api";
import type { OptimizeRequest, ShopifyBatch, ShopifyBatchItem, ShopifyBatchSummary, ShopifyField, ShopifyResourceType, SiteSummary } from "../lib/types";
import { useAutomation, useShopifyBatch, useShopifyBatches } from "../lib/queries";
import { NEW_BATCH, navigate, shopPath, sitePath } from "../lib/router";
import {
  BATCH_STATE, FIELD_COUNT, FIELD_GUIDE, FIELD_LABEL, FIELD_MAX, ITEM_STATE, ORIGIN_LABEL, OTHER_BATCH_RUNNING, SCOPE_TEXT, TOKENS_HINT, TOKENS_SCOPE, TYPE_LABEL,
  TYPE_ORDER, VERDICT_LABEL, applyBatch, batchBusy, cancelBatch, codeLength, createBatch, emptyMeaning, localeLabel, normalizeValue, optimize,
  processedCount, restoreBatch, stopBatch, updateBatchItem, valueProblem,
} from "../lib/shopify";
import { MAX_LINES, clearDraft, removeDraftLine, setDraftValue, useDraftLines, type DraftLine } from "../lib/batchDraft";
import { fmtDateTime, fmtInt, fmtRelative, fmtWhen, pl, plural } from "../lib/format";
import { Button, ButtonLink, Link } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { CharCount } from "../ui/CharCount";
import { SerpPreview } from "../ui/SerpPreview";
import { ConfirmButton } from "../ui/ConfirmButton";
import { EmptyState, ErrorState, useRetryCountdown } from "../ui/States";
import { Skeleton, SkeletonRows, LoadingLabel } from "../ui/Skeleton";
import { useToast } from "../ui/Toast";
import { QueryError } from "./common";
import { Thumb, Value } from "./ShopifyChanges";
import { READONLY_ID, useSticky } from "./shopShared";

const cut = (s: string, n: number) => (codeLength(s) > n ? [...s].slice(0, n - 1).join("").trimEnd() + "…" : s);

/** Libellé d'un champ dans une ligne : « Texte alternatif de l'image 2 · version anglaise ». */
function fieldLabel(field: ShopifyField, opts: { imageIndex?: number | null; locale?: string | null }) {
  let t = FIELD_LABEL[field];
  if (field === "image_alt" && opts.imageIndex) t += ` de l'image ${opts.imageIndex}`;
  if (opts.locale) t += ` · version ${localeLabel(opts.locale).toLowerCase()}`;
  return t;
}

function emptyText(field: ShopifyField, type: ShopifyResourceType, locale: string | null) {
  if (locale) return "Vide : pas de traduction";
  if (field === "image_alt") return "Vide : image non décrite";
  return emptyMeaning(field, type);
}

const fmtTokens = (n: number) => fmtInt(n);

/**
 * Erreurs propres aux lots, affichées avec des mots justes : `limit_reached` (un autre lot est déjà en écriture
 * sur ce site) reçoit la consigne « attendez sa fin ou arrêtez-le ». `rate_limited` garde son délai (ErrorState).
 */
function batchError(e: AppError): AppError {
  if (e.code === "limit_reached") return { ...e, message: OTHER_BATCH_RUNNING, action: null };
  return e;
}

/** Un autre lot en cours d'écriture sur ce site, d'après la liste déjà chargée, pour y mener directement. */
function RunningBatchLink({ site, exceptId }: { site: SiteSummary; exceptId?: string }) {
  const running = useShopifyBatches(site.id).data?.batches.find((x) => x.state === "applying" && x.id !== exceptId);
  if (!running) return null;
  return (
    <p className="small">
      <Link to={shopPath(site.id, "batches", running.id)} className="text-link">Ouvrir le lot en cours : « {running.title} »</Link>
    </p>
  );
}

/** Ligne retenue par le filtre de contenu des écritures automatiques : restée en attente, avec sa raison. */
const heldForReview = (it: ShopifyBatchItem) => it.state === "pending" && !!it.error;

// ───────────────────────── Lot en préparation (navigateur)

/** Rappel, sur tous les onglets, qu'un lot est en préparation dans ce navigateur. */
export function DraftBar({ site, lines }: { site: SiteSummary; lines: DraftLine[] }) {
  const todo = lines.filter((l) => !normalizeValue(l.value)).length;
  return (
    <div className="draftbar" role="status">
      <ListPlus size={16} aria-hidden className="draftbar__icon" />
      <p className="draftbar__text">
        <strong>Lot en préparation :</strong> {plural(lines.length, "ligne", "lignes")}
        {todo > 0 && <span className="muted"> dont {fmtInt(todo)} à rédiger</span>}
        <span className="muted"> · rien n'est encore envoyé</span>
      </p>
      <ButtonLink to={shopPath(site.id, "batches", NEW_BATCH)} size="sm" variant="secondary" iconRight={<ArrowRight size={14} aria-hidden />}>
        {todo > 0 ? "Rédiger" : "Relire et créer le brouillon"}
      </ButtonLink>
    </div>
  );
}

function lineProblem(l: DraftLine): string | null {
  const v = normalizeValue(l.value);
  if (!v) return null;
  const p = valueProblem(l.field, l.value);
  if (p) return p;
  if (v === normalizeValue(l.current)) return "C'est déjà la valeur de la boutique : changez-la ou retirez la ligne.";
  return null;
}

/** Ce que l'analyse a vu pour ce champ sur la page affichée. */
function Rendered({ rendered, field }: { rendered: DraftLine["rendered"]; field: ShopifyField }) {
  if (field === "image_alt") return null;
  if (!rendered) return <p className="bline__seen"><span className="bline__k">Affiché</span><span className="subtle">Page non ouverte par l'analyse : affichage non vérifié.</span></p>;
  return (
    <p className="bline__seen">
      <span className="bline__k">Affiché</span>
      <span>
        <Verdict status={rendered.status} /> {rendered.text ? <span className="value">« {rendered.text} »</span> : <span className="value value--empty">Rien n'est affiché</span>}
      </span>
    </p>
  );
}

function Verdict({ status }: { status: "pass" | "warn" | "fail" }) {
  const Icon = status === "pass" ? CircleCheck : status === "warn" ? TriangleAlert : CircleMinus;
  return <span className={`verdict verdict--${status}`}><Icon size={13} aria-hidden />{VERDICT_LABEL[status]}</span>;
}

/** Aperçu Google repliable, pour un titre ou une description. */
function PreviewToggle({ site, path, title, description }: { site: SiteSummary; path: string; title: string | null; description: string | null }) {
  const url = (() => {
    try {
      return new URL(path, site.url).href;
    } catch {
      return site.url;
    }
  })();
  return (
    <details className="bline__preview">
      <summary><ChevronDown size={14} aria-hidden className="bline__chev" />Aperçu dans Google</summary>
      <SerpPreview url={url} title={title ? cut(title, 60) : null} description={description ? cut(description, 160) : null} siteName={site.name} missingDescription="Pas de description : Google choisira un extrait de la page." />
    </details>
  );
}

function ComposeRow({ site, l, showErrors }: { site: SiteSummary; l: DraftLine; showErrors: boolean }) {
  const id = useId();
  const v = normalizeValue(l.value);
  const problem = lineProblem(l);
  const missing = !v;
  const Input = l.field === "seo_description" ? "textarea" : "input";
  const errId = `${id}-err`;
  const previewTitle = l.field === "seo_title" ? v ?? l.rendered?.text ?? l.title : l.rendered?.text ?? l.current ?? l.title;
  const previewDesc = l.field === "seo_description" ? v ?? l.rendered?.text ?? null : null;
  return (
    <li className="bline">
      <div className="bline__head">
        <div className="bline__what">
          {l.imageUrl && <Thumb url={l.imageUrl} size={36} />}
          <div className="bline__names">
            <p className="bline__res">
              <Link to={sitePath(site.id, "shopify", l.resourceId)} className="bline__name">{l.title}</Link>
              <span className="bline__type">{TYPE_LABEL[l.resourceType].one}</span>
            </p>
            <p className="bline__field">{fieldLabel(l.field, { imageIndex: l.imageIndex, locale: l.locale })} <span className="mono bline__path">{l.path}</span></p>
          </div>
        </div>
        <Button size="sm" variant="ghost" icon={<X size={14} aria-hidden />} onClick={() => removeDraftLine(site.id, l.key)} aria-label={`Retirer la ligne ${l.title}, ${FIELD_LABEL[l.field]}`}>Retirer</Button>
      </div>
      <div className="bline__body">
        <p className="bline__now"><span className="bline__k">Dans Shopify</span><Value v={l.current} empty={emptyText(l.field, l.resourceType, l.locale)} /></p>
        {!l.locale && <Rendered rendered={l.rendered} field={l.field} />}
        <div className="bline__edit">
          <div className="fedit__head">
            <label htmlFor={id} className="fedit__label">Nouvelle valeur</label>
            <CharCount length={codeLength(v ?? "")} guide={FIELD_GUIDE[l.field]} max={FIELD_MAX[l.field]} />
          </div>
          <div className={`field__control fedit__control ${problem || (showErrors && missing) ? "is-invalid" : ""}`}>
            <Input
              id={id}
              className={`field__input fedit__input ${l.field === "seo_description" ? "fedit__input--multi" : ""}`}
              value={l.value}
              onChange={(e) => setDraftValue(site.id, l.key, e.target.value)}
              placeholder={l.field === "seo_title" ? "Ex. : Bol en grès bleu tourné main | Atelier Lune" : l.field === "seo_description" ? "Ce que Google affichera sous le titre, en une ou deux phrases" : "Décrivez ce qu'on voit sur l'image"}
              rows={l.field === "seo_description" ? 3 : undefined}
              lang={l.locale ?? "fr"}
              spellCheck
              aria-invalid={problem || (showErrors && missing) ? true : undefined}
              aria-describedby={problem || (showErrors && missing) ? errId : undefined}
            />
          </div>
          {problem && <p className="fedit__error" id={errId} role="alert"><CircleAlert size={13} aria-hidden />{problem}</p>}
          {!problem && showErrors && missing && <p className="fedit__error" id={errId}><CircleAlert size={13} aria-hidden />Rédigez une valeur, ou retirez la ligne.</p>}
        </div>
        {l.field !== "image_alt" && <PreviewToggle site={site} path={l.path} title={previewTitle} description={previewDesc} />}
      </div>
    </li>
  );
}

/** Lot en préparation : une valeur par ligne, puis création du brouillon (rien n'est écrit dans la boutique). */
export function Composer({ site }: { site: SiteSummary }) {
  const lines = useDraftLines(site.id);
  const toast = useToast();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [tried, setTried] = useState(false);
  const todo = lines.filter((l) => !normalizeValue(l.value)).length;
  const problems = lines.filter((l) => lineProblem(l)).length;
  const ready = lines.length > 0 && todo === 0 && problems === 0;
  const wait = useRetryCountdown(error);

  const create = async () => {
    setTried(true);
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const b = await createBatch(site.id, {
        title: title.trim() || undefined,
        items: lines.map((l) => ({
          resourceId: l.resourceId, field: l.field, value: normalizeValue(l.value)!,
          ...(l.imageId ? { imageId: l.imageId } : {}), ...(l.locale ? { locale: l.locale } : {}),
        })),
      });
      clearDraft(site.id);
      toast.show({ tone: "success", title: "Brouillon créé", text: "Rien n'a été écrit dans la boutique. Relisez-le, puis validez-le quand vous êtes prêt." });
      navigate(shopPath(site.id, "batches", b.id), { replace: true });
    } catch (err) {
      setError(toAppError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="batch">
      <BackLink site={site} />
      <header className="batch__head">
        <div className="batch__titles">
          <h2 className="batch__title">Lot en préparation</h2>
          <p className="batch__lead">Rédigez une valeur pour chaque ligne : il n'y a pas de valeur commune appliquée à tous. Créer le brouillon n'écrit rien dans la boutique ; vous le relirez, puis le validerez.</p>
        </div>
      </header>

      {lines.length === 0 ? (
        <EmptyState tone="framed" icon={<ListPlus size={20} />} title="Le lot en préparation est vide">
          <p>Pour ajouter des lignes : dans l'onglet <Link to={shopPath(site.id, "items")} className="text-link">Éléments</Link>, cochez des éléments et choisissez le champ à corriger ; ou, dans la fiche d'un élément, écrivez une valeur et choisissez « Ajouter au lot ».</p>
        </EmptyState>
      ) : (
        <>
          <div className="batch__name">
            <label htmlFor="batch-name" className="field__label">Nom du lot <span className="subtle">(facultatif)</span></label>
            <div className="field__control"><input id="batch-name" className="field__input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ex. : Descriptions des bols" maxLength={120} /></div>
          </div>
          <ol className="blines" aria-label="Lignes du lot en préparation">
            {lines.map((l) => <ComposeRow key={l.key} site={site} l={l} showErrors={tried} />)}
          </ol>
          {error && <ErrorState error={error} inline />}
          <div className="actionbar">
            <p className="actionbar__text">
              <strong className="tnum">{plural(lines.length, "ligne", "lignes")}</strong>
              <span className="muted">{todo > 0 ? ` · ${fmtInt(todo)} à rédiger` : problems > 0 ? ` · ${plural(problems, "valeur à corriger", "valeurs à corriger")}` : " · prêtes"}{lines.length >= MAX_LINES ? " · 50 au plus par lot" : ""}</span>
            </p>
            <div className="actionbar__actions">
              <ConfirmButton size="sm" icon={<Trash2 size={14} aria-hidden />} confirmLabel="Vider le lot ?" onConfirm={() => clearDraft(site.id)}>Vider</ConfirmButton>
              <Button variant="primary" loading={busy} disabled={wait > 0} onClick={() => void create()} aria-disabled={!ready || undefined}>Créer le brouillon</Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function BackLink({ site }: { site: SiteSummary }) {
  return (
    <Link to={shopPath(site.id, "batches")} className="backlink">
      <ArrowLeft size={14} aria-hidden /> Lots de corrections
    </Link>
  );
}

// ───────────────────────── Liste des lots

function StateTag({ b }: { b: Pick<ShopifyBatchSummary, "state"> }) {
  const s = BATCH_STATE[b.state];
  const Icon = b.state === "preparing" || b.state === "applying" ? LoaderCircle : b.state === "applied" ? CircleCheck : b.state === "partial" ? TriangleAlert : b.state === "failed" ? CircleAlert : b.state === "draft" ? PenLine : CircleDashed;
  return (
    <span className={`bstate bstate--${s.tone}`}>
      <Icon size={13} aria-hidden className={batchBusy(b) ? "btn__spin" : undefined} />
      {s.label}
    </span>
  );
}

function OriginLabel({ b }: { b: Pick<ShopifyBatchSummary, "origin"> }) {
  const Icon = b.origin === "manual" ? PenLine : b.origin === "assistant" ? Bot : Sparkles;
  return <span className="borigin"><Icon size={13} aria-hidden />{ORIGIN_LABEL[b.origin]}</span>;
}

/** Résumé chiffré d'un lot : « 12 lignes · 10 écrites · 2 en conflit ». */
function countsLine(b: ShopifyBatchSummary): string {
  const c = b.counts;
  const parts = [c.total === 0 ? "Aucune ligne" : plural(c.total, "ligne", "lignes")];
  if (b.state === "draft" && c.selected !== c.total) parts.push(`${fmtInt(c.selected)} ${pl(c.selected, "retenue", "retenues")}`);
  if (c.applied) parts.push(`${fmtInt(c.applied)} ${pl(c.applied, "écrite", "écrites")}`);
  if (c.conflict) parts.push(`${fmtInt(c.conflict)} en conflit`);
  if (c.failed) parts.push(`${fmtInt(c.failed)} ${pl(c.failed, "refusée", "refusées")}`);
  if (c.restored) parts.push(`${fmtInt(c.restored)} ${pl(c.restored, "annulée", "annulées")}`);
  return parts.join(" · ");
}

export function BatchList({ site }: { site: SiteSummary }) {
  const q = useShopifyBatches(site.id);
  const data = useSticky(q.data);
  const [optimizing, setOptimizing] = useState(false);
  const auto = data?.batches.filter((b) => b.autoApplied) ?? [];
  const busy = data?.batches.some(batchBusy) ?? false;
  // Un lot en cours (préparation ou écriture) : relu régulièrement, en plus du flux en direct.
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => void q.refetch(), 2500);
    return () => clearInterval(t);
  }, [busy, q.refetch]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div className="blist__intro">
        <p className="shop-history__lead">Un lot regroupe plusieurs corrections à relire et valider d'un coup. Chaque ligne est écrite comme une modification isolée : relue avant d'écrire, ajoutée à l'historique, annulable.</p>
        <div className="blist__actions">
          <Button variant="primary" icon={<Sparkles size={15} aria-hidden />} onClick={() => setOptimizing(true)}>Préparer des corrections avec l'IA</Button>
          <ButtonLink to={shopPath(site.id, "batches", NEW_BATCH)} icon={<ListPlus size={15} aria-hidden />}>Composer un lot</ButtonLink>
        </div>
      </div>

      {auto.length > 0 && (
        <div className="notice notice--auto" role="note">
          <Zap size={16} className="notice__icon" aria-hidden />
          <div className="notice__body">
            <p className="notice__title">{plural(auto.length, "lot contient des lignes écrites sans validation humaine", "lots contiennent des lignes écrites sans validation humaine")}</p>
            <p className="notice__text">« Préparer des corrections avec l'IA » les a écrites dans la boutique, dans les limites de la règle d'automatisation. Le détail ligne par ligne est dans chaque lot ; elles sont dans l'historique et s'annulent comme les autres.</p>
          </div>
        </div>
      )}

      <QueryError q={q} />
      {!data && !q.error && (<><LoadingLabel /><SkeletonRows rows={5} height={64} /></>)}
      {data && data.batches.length === 0 && (
        <EmptyState title="Aucun lot pour l'instant">
          <p>Composez un lot à partir de la liste des éléments, ou demandez à l'IA de préparer des propositions. Rien n'est écrit dans la boutique sans votre validation.</p>
        </EmptyState>
      )}
      {data && data.batches.length > 0 && (
        <ul className="blist" aria-label="Lots de corrections">
          {data.batches.map((b) => (
            <li key={b.id} className={`blist__row ${b.autoApplied ? "is-auto" : ""}`}>
              <div className="blist__main">
                <Link to={shopPath(site.id, "batches", b.id)} className="blist__title blist__link">{b.title}</Link>
                <p className="blist__meta">
                  <OriginLabel b={b} />
                  <time dateTime={b.createdAt}>{fmtDateTime(b.createdAt)}</time>
                </p>
              </div>
              <div className="blist__state">
                <StateTag b={b} />
                {b.autoApplied && <span className="bauto"><Zap size={12} aria-hidden />Écritures sans validation humaine</span>}
              </div>
              <p className="blist__counts">{countsLine(b)}</p>
              <ArrowRight size={16} className="row-arrow" aria-hidden />
            </li>
          ))}
        </ul>
      )}
      <OptimizeDialog site={site} open={optimizing} onClose={() => setOptimizing(false)} />
    </>
  );
}

// ───────────────────────── Écran d'un lot

function BatchItemRow({ site, b, it, onBusy }: { site: SiteSummary; b: ShopifyBatch; it: ShopifyBatchItem; onBusy: (busy: boolean) => void }) {
  const toast = useToast();
  const id = useId();
  // Une ligne déjà écrite (lot automatique repassé en brouillon) ne se corrige plus et ne s'écarte plus.
  const draft = b.state === "draft" && (it.state === "pending" || it.state === "skipped");
  const held = heldForReview(it) && b.state !== "applying";
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(it.proposed);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!editing) setValue(it.proposed);
  }, [it.proposed, editing]);
  useEffect(() => onBusy(editing), [editing]); // eslint-disable-line react-hooks/exhaustive-deps
  const v = normalizeValue(value);
  const problem = editing ? (v ? valueProblem(it.field, value) ?? (v === normalizeValue(it.before) ? "C'est déjà la valeur de la boutique : écartez plutôt la ligne." : null) : "Écrivez une valeur, ou écartez la ligne.") : null;
  const shown = editing ? value : it.proposed;
  const empty = emptyText(it.field, it.resourceType, it.locale);
  const off = !it.selected;

  const patch = async (req: { proposed?: string; selected?: boolean }) => {
    setSaving(true);
    try {
      await updateBatchItem(site.id, b.id, it.id, req);
      if (req.proposed !== undefined) setEditing(false);
    } catch (err) {
      const e = toAppError(err);
      toast.show({ tone: "error", title: e.message, text: e.action });
    } finally {
      setSaving(false);
    }
  };

  const stateWord = it.state === "pending" && b.state === "applying" && it.selected ? "En attente d'écriture" : it.state === "pending" && b.state === "partial" && it.selected ? "Pas écrite" : ITEM_STATE[it.state];
  const StateIcon = it.state === "applied" ? CircleCheck : it.state === "conflict" ? TriangleAlert : it.state === "failed" ? CircleAlert : it.state === "restored" ? Undo2 : it.state === "skipped" ? CircleMinus : CircleDashed;
  const tone = it.state === "applied" ? "good" : it.state === "conflict" ? "warning" : it.state === "failed" ? "critical" : "neutral";

  return (
    <li className={`bline ${off ? "is-off" : ""} ${it.state === "conflict" || it.state === "failed" ? "is-problem" : ""} ${held ? "is-held" : ""}`}>
      <div className="bline__head">
        <div className="bline__what">
          {draft && (
            <input
              type="checkbox"
              className="check bline__keep"
              checked={it.selected}
              disabled={saving}
              onChange={(e) => void patch({ selected: e.target.checked })}
              aria-label={it.selected ? `Écarter la ligne ${it.resourceTitle}` : `Retenir la ligne ${it.resourceTitle}`}
            />
          )}
          {it.image && <Thumb url={it.image.url} size={36} />}
          <div className="bline__names">
            <p className="bline__res">
              <Link to={sitePath(site.id, "shopify", it.resourceId)} className="bline__name">{it.resourceTitle}</Link>
              <span className="bline__type">{TYPE_LABEL[it.resourceType].one}</span>
            </p>
            <p className="bline__field">{fieldLabel(it.field, { locale: it.locale })} <span className="mono bline__path">{it.path}</span></p>
          </div>
        </div>
        <span className="bline__status">
          {held ? (
            <span className="istate istate--warning"><Eye size={13} aria-hidden />À relire par vous</span>
          ) : draft || b.state === "preparing" ? (
            off ? <span className="istate istate--neutral"><CircleMinus size={13} aria-hidden />Écartée</span> : null
          ) : (
            <span className={`istate istate--${tone}`}><StateIcon size={13} aria-hidden />{stateWord}</span>
          )}
          {it.autoApplied && <span className="bauto"><Zap size={12} aria-hidden />Sans validation humaine</span>}
        </span>
      </div>

      <div className="bline__body">
        <div className="bdiff">
          <div className="bdiff__col">
            <p className="bline__k">Avant</p>
            <p className="bdiff__before"><Value v={it.before} empty={empty} /></p>
          </div>
          <ArrowRight size={14} className="bdiff__arrow" aria-hidden />
          <div className="bdiff__col">
            <div className="bdiff__headrow">
              <label className="bline__k" htmlFor={id}>{it.state === "applied" ? "Après" : it.state === "restored" ? "Écrit, puis annulé" : "Proposé"}</label>
              {it.field !== "image_alt" || editing ? <CharCount length={codeLength(normalizeValue(shown) ?? "")} guide={FIELD_GUIDE[it.field]} max={FIELD_MAX[it.field]} /> : null}
            </div>
            {editing ? (
              <>
                <div className={`field__control fedit__control ${problem ? "is-invalid" : ""}`}>
                  {it.field === "seo_description" ? (
                    <textarea id={id} className="field__input fedit__input fedit__input--multi" rows={3} value={value} onChange={(e) => setValue(e.target.value)} lang={it.locale ?? "fr"} spellCheck aria-invalid={problem ? true : undefined} aria-describedby={problem ? `${id}-err` : undefined} autoFocus />
                  ) : (
                    <input id={id} className="field__input fedit__input" value={value} onChange={(e) => setValue(e.target.value)} lang={it.locale ?? "fr"} spellCheck aria-invalid={problem ? true : undefined} aria-describedby={problem ? `${id}-err` : undefined} autoFocus />
                  )}
                </div>
                {problem && <p className="fedit__error" id={`${id}-err`} role="alert"><CircleAlert size={13} aria-hidden />{problem}</p>}
                <div className="fedit__actions">
                  <Button size="sm" variant="primary" disabled={!!problem} loading={saving} onClick={() => v && void patch({ proposed: v })}>Enregistrer la proposition</Button>
                  <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setValue(it.proposed); }} disabled={saving}>Annuler</Button>
                </div>
              </>
            ) : (
              <p className={`bdiff__after ${off ? "is-off" : ""}`} id={id}><span className="value">{it.proposed}</span></p>
            )}
          </div>
        </div>

        {it.note && (
          <p className="bline__note"><Bot size={14} aria-hidden /><span><span className="bline__note-k">Note de l'IA :</span> {it.note}</span></p>
        )}
        {it.state === "conflict" && (
          <p className="bline__why bline__why--warning"><TriangleAlert size={14} aria-hidden /><span>La valeur avait changé dans Shopify depuis la préparation du lot : <strong>rien n'a été écrit sur ce champ</strong>. Ouvrez l'élément pour voir sa valeur actuelle et décider.</span></p>
        )}
        {it.state === "failed" && (
          <p className="bline__why bline__why--critical"><CircleAlert size={14} aria-hidden /><span>{it.error ?? "Shopify a refusé cette valeur. Rien n'a été écrit."}</span></p>
        )}
        {held && (
          <p className="bline__why bline__why--warning"><Eye size={14} aria-hidden /><span><strong>Pas écrite automatiquement :</strong> {it.error} Relisez-la, corrigez-la ou écartez-la, puis validez le lot.</span></p>
        )}
        {it.state !== "failed" && it.state !== "conflict" && !held && it.error && (
          <p className="bline__why"><CircleAlert size={14} aria-hidden /><span>{it.error}</span></p>
        )}

        <div className="bline__foot">
          {draft && !editing && (
            <Button size="sm" variant="secondary" icon={<PenLine size={14} aria-hidden />} onClick={() => setEditing(true)} disabled={saving || off}>Corriger la proposition</Button>
          )}
          {it.changeId && (it.state === "applied" || it.state === "restored") && (
            <Link to={`${sitePath(site.id, "shopify", it.resourceId)}?modif=${encodeURIComponent(it.changeId)}`} className="text-link bline__hist">
              <HistoryIcon size={13} aria-hidden /> Voir la modification dans l'historique de l'élément
            </Link>
          )}
          {it.field !== "image_alt" && (
            <PreviewToggle
              site={site}
              path={it.path}
              title={it.field === "seo_title" ? normalizeValue(shown) : null}
              description={it.field === "seo_description" ? normalizeValue(shown) : null}
            />
          )}
        </div>
      </div>
    </li>
  );
}

/** Récapitulatif par champ : « 4 titres pour Google, 6 descriptions ». */
function byField(items: ShopifyBatchItem[]) {
  const m = new Map<ShopifyField, number>();
  items.forEach((i) => m.set(i.field, (m.get(i.field) ?? 0) + 1));
  return [...m.entries()];
}

function ApplyConfirm({ site, b, open, onClose }: { site: SiteSummary; b: ShopifyBatch; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  useEffect(() => {
    if (open) setError(null);
  }, [open]);
  const rows = b.items.filter((i) => i.selected && i.state === "pending");
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await applyBatch(site.id, b.id);
      toast.show({ tone: "neutral", title: "Écriture lancée", text: "Les valeurs sont écrites l'une après l'autre ; vous pouvez naviguer pendant ce temps." });
      onClose();
    } catch (err) {
      setError(batchError(toAppError(err)));
    } finally {
      setBusy(false);
    }
  };
  const blocked = !!error && ["shopify_writes_disabled", "batch_not_editable", "shopify_other_shop", "shopify_not_configured"].includes(error.code);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      busy={busy}
      size="lg"
      title={`Appliquer ${plural(rows.length, "correction", "corrections")} à la boutique ?`}
      footer={
        <>
          {/* Focus initial sur « Ne rien appliquer » : Entrée n'écrit jamais dans la boutique par réflexe. */}
          <Button variant="secondary" onClick={onClose} disabled={busy} data-autofocus>Ne rien appliquer</Button>
          <Button variant="primary" loading={busy} disabled={blocked || rows.length === 0} onClick={() => void submit()}>
            {error && !blocked ? "Réessayer" : `Appliquer ${plural(rows.length, "correction", "corrections")}`}
          </Button>
        </>
      }
    >
      <ul className="confirm__recap">
        {byField(rows).map(([f, n]) => (
          <li key={f}><strong className="tnum">{fmtInt(n)}</strong> {pl(n, ...FIELD_COUNT[f])}</li>
        ))}
      </ul>
      <p className="confirm__note">
        <strong>La boutique en ligne sera modifiée :</strong> vos visiteurs et Google verront les nouvelles valeurs. Elles sont écrites l'une après l'autre ; avant chacune, Chat SEO vérifie que la valeur n'a pas changé dans Shopify depuis la préparation, sinon il n'y touche pas. Chaque écriture s'ajoute à l'historique et peut être annulée.
      </p>
      <ol className="confirm__rows" aria-label="Valeurs qui seront écrites">
        {rows.map((i) => (
          <li key={i.id}>
            <p className="confirm__row-what"><span className="confirm__name">{i.resourceTitle}</span> <span className="confirm__type">{fieldLabel(i.field, { locale: i.locale })}</span></p>
            <p className="confirm__row-val"><span className="value">{i.proposed}</span></p>
          </li>
        ))}
      </ol>
      {rows.some(heldForReview) && <p className="muted small">Dont {plural(rows.filter(heldForReview).length, "ligne que le filtre de contenu avait retenue", "lignes que le filtre de contenu avait retenues")} : en validant, vous confirmez {pl(rows.filter(heldForReview).length, "l'avoir relue", "les avoir relues")}.</p>}
      {(() => {
        const skipped = b.items.filter((i) => !i.selected || i.state === "skipped").length;
        const done = b.items.filter((i) => i.selected && i.state !== "pending" && i.state !== "skipped").length;
        const parts = [
          skipped > 0 ? plural(skipped, "ligne écartée ne sera pas écrite", "lignes écartées ne seront pas écrites") : null,
          done > 0 ? plural(done, "ligne déjà traitée n'est pas concernée", "lignes déjà traitées ne sont pas concernées") : null,
        ].filter(Boolean);
        return parts.length ? <p className="muted small">{parts.join(" ; ")}.</p> : null;
      })()}
      {error && <ErrorState error={error} inline />}
      {error?.code === "limit_reached" && <RunningBatchLink site={site} exceptId={b.id} />}
    </Dialog>
  );
}

function RestoreConfirm({ site, b, open, onClose }: { site: SiteSummary; b: ShopifyBatch; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  useEffect(() => {
    if (open) setError(null);
  }, [open]);
  const rows = b.items.filter((i) => i.state === "applied");
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await restoreBatch(site.id, b.id);
      toast.show({ tone: "neutral", title: "Annulation lancée", text: "Les valeurs d'avant sont remises l'une après l'autre." });
      onClose();
    } catch (err) {
      setError(batchError(toAppError(err)));
    } finally {
      setBusy(false);
    }
  };
  const blocked = !!error && ["shopify_writes_disabled", "shopify_other_shop", "shopify_not_configured"].includes(error.code);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      busy={busy}
      size="lg"
      title="Annuler tout le lot ?"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy} data-autofocus>Ne rien annuler</Button>
          <Button variant="primary" icon={<Undo2 size={15} aria-hidden />} loading={busy} disabled={blocked || rows.length === 0} onClick={() => void submit()}>
            {error && !blocked ? "Réessayer" : `Remettre ${plural(rows.length, "valeur", "valeurs")}`}
          </Button>
        </>
      }
    >
      <p className="confirm__note">
        <strong>La boutique en ligne sera modifiée :</strong> chaque valeur écrite par ce lot est remplacée par celle d'avant. Une valeur modifiée depuis, dans Shopify ou par une autre correction, reste telle quelle et le lot le dira.
      </p>
      <ol className="confirm__rows" aria-label="Valeurs qui seront remises">
        {rows.map((i) => (
          <li key={i.id}>
            <p className="confirm__row-what"><span className="confirm__name">{i.resourceTitle}</span> <span className="confirm__type">{fieldLabel(i.field, { locale: i.locale })}</span></p>
            <p className="confirm__row-val"><span className="confirm__row-k">Sera remis :</span> <Value v={i.before} empty={emptyText(i.field, i.resourceType, i.locale)} /></p>
          </li>
        ))}
      </ol>
      {error && <ErrorState error={error} inline />}
      {error?.code === "limit_reached" && <RunningBatchLink site={site} exceptId={b.id} />}
    </Dialog>
  );
}

/**
 * Pendant `applying`, le lot écrit ou annule. Une annulation se reconnaît à ses lignes remises, ou, avant la
 * première, à l'absence de toute ligne retenue encore à écrire alors que des lignes sont écrites.
 */
const isRestoring = (b: ShopifyBatch) => b.counts.restored > 0 || (b.counts.applied > 0 && !b.items.some((i) => i.selected && i.state === "pending"));

/**
 * « Arrêter après la ligne en cours » : sans confirmation, arrêter est toujours sûr. Les lignes déjà écrites
 * restent dans l'historique ; les autres ne sont pas touchées.
 */
function StopButton({ site, b }: { site: SiteSummary; b: ShopifyBatch }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState(false);
  const stop = async () => {
    setBusy(true);
    try {
      await stopBatch(site.id, b.id);
      setAsked(true);
      toast.show({ tone: "neutral", title: "Lot arrêté", text: "Les lignes déjà écrites sont dans l'historique ; les autres n'ont pas été touchées." });
    } catch (err) {
      const e = toAppError(err);
      // Le lot s'est terminé entre-temps : rien à arrêter, l'écran se met à jour par le flux en direct.
      if (e.code === "batch_not_editable") toast.show({ tone: "neutral", title: "Ce lot venait de se terminer", text: "Il n'y avait plus rien à arrêter." });
      else toast.show({ tone: "error", title: e.message, text: e.action });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button size="sm" variant="secondary" icon={<OctagonPause size={14} aria-hidden />} loading={busy} disabled={asked} onClick={() => void stop()} className="bprogress__stop">
      {asked ? "Arrêt demandé" : "Arrêter après la ligne en cours"}
    </Button>
  );
}

/** Progression réelle de l'écriture : lignes traitées, reçues du serveur ; aucun pourcentage avant la première. */
function Progress({ site, b }: { site: SiteSummary; b: ShopifyBatch }) {
  if (isRestoring(b)) {
    const left = b.items.filter((i) => i.state === "applied").length;
    return (
      <div className="bprogress" role="status" aria-live="polite">
        <span className="live-dot" aria-hidden />
        <div className="bprogress__main">
          <p><strong>Annulation en cours :</strong> {b.counts.restored === 0 ? "remise de la première valeur…" : <>{plural(b.counts.restored, "valeur remise", "valeurs remises")}, {plural(left, "reste", "restent")} à remettre.</>}</p>
          <p className="bprogress__hint">Une valeur après l'autre. Vous pouvez quitter cet écran : l'annulation continue sur le serveur.</p>
        </div>
        <StopButton site={site} b={b} />
      </div>
    );
  }
  const done = processedCount(b);
  const total = b.counts.selected;
  return (
    <div className="bprogress" role="status" aria-live="polite">
      <span className="live-dot" aria-hidden />
      <div className="bprogress__main">
        <p>
          <strong>Écriture dans la boutique :</strong>{" "}
          {done === 0 ? "écriture de la première valeur…" : <><span className="tnum">{fmtInt(done)}</span> sur <span className="tnum">{fmtInt(total)}</span> {pl(total, "ligne traitée", "lignes traitées")}</>}
          {b.counts.conflict + b.counts.failed > 0 && <span className="muted"> · {plural(b.counts.conflict + b.counts.failed, "ligne non écrite", "lignes non écrites")}</span>}
        </p>
        {done > 0 && <span className="meter meter--accent bprogress__bar" aria-hidden><span className="meter__fill" style={{ width: `${Math.min(100, (done / Math.max(1, total)) * 100)}%` }} /></span>}
        <p className="bprogress__hint">Une valeur après l'autre, au rythme permis par Shopify. Vous pouvez quitter cet écran : l'écriture continue sur le serveur.</p>
      </div>
      <StopButton site={site} b={b} />
    </div>
  );
}

function Outcome({ b }: { b: ShopifyBatch }) {
  const c = b.counts;
  const skipped = b.items.filter((i) => i.state === "skipped").length;
  const pending = b.items.filter((i) => i.selected && i.state === "pending").length;
  const facts: { k: string; v: number; tone?: string }[] = [
    { k: pl(c.applied, "écrite", "écrites"), v: c.applied, tone: "good" },
    { k: "en conflit", v: c.conflict, tone: "warning" },
    { k: pl(c.failed, "refusée", "refusées"), v: c.failed, tone: "critical" },
    { k: pl(c.restored, "annulée", "annulées"), v: c.restored },
    { k: pl(skipped, "écartée", "écartées"), v: skipped },
    { k: pl(pending, "pas écrite", "pas écrites"), v: b.state === "draft" ? 0 : pending },
  ].filter((f) => f.v > 0);
  // Annulation arrêtée : des lignes sont remises, d'autres toujours en place sans avoir été refusées.
  const restoreStopped = b.state === "partial" && c.restored > 0 && c.applied > 0 && b.items.every((i) => i.state !== "applied" || !i.error);
  const partialText = restoreStopped
    ? `Annulation arrêtée avant la fin : ${plural(c.restored, "valeur a été remise", "valeurs ont été remises")} comme avant ; ${plural(c.applied, "valeur écrite par ce lot est", "valeurs écrites par ce lot sont")} toujours en place et ${pl(c.applied, "peut", "peuvent")} encore être annulée${c.applied > 1 ? "s" : ""}.`
    : c.restored > 0
      ? "Une partie des valeurs n'a pas pu être remise : elles avaient changé depuis."
      : pending > 0
        ? `Lot partiel : l'écriture s'est arrêtée avant la fin. ${c.applied > 0 ? `${plural(c.applied, "ligne écrite est", "lignes écrites sont")} dans l'historique` : "Aucune ligne n'a été écrite"} ; ${plural(pending, "autre ligne n'a", "autres lignes n'ont")} pas été touchée${pending > 1 ? "s" : ""}.`
        : "Certaines lignes n'ont pas été écrites : leur raison est indiquée ci-dessous.";
  const text: Record<string, string> = {
    applied: "Toutes les lignes retenues ont été écrites dans la boutique.",
    partial: partialText,
    restored: "Toutes les valeurs écrites par ce lot ont été remises comme avant.",
    cancelled: c.applied > 0
      ? `Ce lot a été abandonné : les lignes en attente n'ont pas été écrites ; ${plural(c.applied, "ligne écrite auparavant reste", "lignes écrites auparavant restent")} en place.`
      : "Ce lot a été abandonné sans rien écrire dans la boutique.",
  };
  if (!text[b.state]) return null;
  return (
    <div className="boutcome">
      <p className="boutcome__text">{text[b.state]}{b.finishedAt && <span className="muted"> Terminé le {fmtDateTime(b.finishedAt)}.</span>}</p>
      {facts.length > 0 && (
        <dl className="boutcome__facts">
          {facts.map((f) => (
            <div key={f.k} className={f.tone ? `boutcome__fact boutcome__fact--${f.tone}` : "boutcome__fact"}>
              <dt>{f.k}</dt>
              <dd className="tnum">{fmtInt(f.v)}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

export function BatchDetail({ site, batchId, writesEnabled }: { site: SiteSummary; batchId: string; writesEnabled: boolean }) {
  const q = useShopifyBatch(site.id, batchId);
  const toast = useToast();
  const b = q.data?.batch && q.data.batch.id === batchId ? q.data.batch : null;
  const [confirm, setConfirm] = useState<"apply" | "restore" | null>(null);
  const [editingRows, setEditingRows] = useState<Set<string>>(() => new Set());
  const [cancelling, setCancelling] = useState(false);
  const busy = b ? batchBusy(b) : false;
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => void q.refetch(), 2000);
    return () => clearInterval(t);
  }, [busy, q.refetch]); // eslint-disable-line react-hooks/exhaustive-deps
  const recap = useMemo(() => (b ? byField(b.items.filter((i) => i.selected && i.state === "pending")) : []), [b]);

  if (!b) {
    return (
      <div className="batch">
        <BackLink site={site} />
        {q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.fetching} /> : (
          <>
            <LoadingLabel />
            <Skeleton w={320} h={24} />
            <div style={{ height: 10 }} />
            <Skeleton w={220} h={12} />
            <div style={{ height: 32 }} />
            <SkeletonRows rows={4} height={140} />
          </>
        )}
      </div>
    );
  }

  const draft = b.state === "draft";
  // Lignes retenues encore à écrire : dans un brouillon, ou après un arrêt (lot partiel, reprise possible).
  const toWrite = b.items.filter((i) => i.selected && i.state === "pending").length;
  const resumable = b.state === "partial" && toWrite > 0;
  const selected = draft ? toWrite : b.counts.selected;
  const restorable = b.counts.applied > 0 && !busy;
  const autoLines = b.items.filter((i) => i.autoApplied).length;
  const held = b.items.filter(heldForReview).length;
  const cancel = async () => {
    setCancelling(true);
    try {
      const written = b.counts.applied;
      await cancelBatch(site.id, b.id);
      toast.show({
        tone: "neutral",
        title: "Lot abandonné",
        text: written > 0
          ? "Les lignes en attente ne seront pas écrites. Celles déjà écrites restent en place et s'annulent depuis le lot ou l'historique."
          : "Rien n'a été écrit dans la boutique. Le lot reste consultable.",
      });
    } catch (err) {
      const e = toAppError(err);
      toast.show({ tone: "error", title: e.message, text: e.action });
    } finally {
      setCancelling(false);
    }
  };
  const resetsAt = typeof b.error?.details?.resetsAt === "string" ? b.error.details.resetsAt : null;
  const applyReason = !writesEnabled ? READONLY_ID : undefined;

  return (
    <div className="batch">
      <BackLink site={site} />
      <header className="batch__head">
        <div className="batch__titles">
          <h2 className="batch__title">{b.title}</h2>
          <p className="batch__meta">
            <StateTag b={b} />
            <OriginLabel b={b} />
            <span>Créé {fmtRelative(b.createdAt)} <span className="subtle">({fmtDateTime(b.createdAt)})</span></span>
            <span className="tnum">{countsLine(b)}</span>
          </p>
        </div>
        {restorable && (
          <Button icon={<RotateCcw size={15} aria-hidden />} onClick={() => setConfirm("restore")} disabled={!writesEnabled} aria-describedby={applyReason}>
            Annuler tout le lot
          </Button>
        )}
      </header>

      {autoLines > 0 && (
        <div className="notice notice--auto" role="note">
          <Zap size={16} className="notice__icon" aria-hidden />
          <div className="notice__body">
            <p className="notice__title">{plural(autoLines, "ligne écrite sans validation humaine", "lignes écrites sans validation humaine")}</p>
            <p className="notice__text">
              « Préparer des corrections avec l'IA » les a écrites dans les limites de la règle d'automatisation de ce site ; elles portent la mention « Sans validation humaine » ci-dessous. Chacune est dans l'historique et peut être annulée, seule ou avec tout le lot.
              {held > 0 && <> <strong>{plural(held, "ligne est à relire par vous", "lignes sont à relire par vous")}</strong> : le filtre de contenu {pl(held, "l'a retenue", "les a retenues")}, rien n'a été écrit pour {pl(held, "elle", "elles")}.</>}
            </p>
          </div>
        </div>
      )}
      {autoLines === 0 && held > 0 && (
        <div className="notice notice--compact" role="note">
          <Eye size={15} className="notice__icon" aria-hidden />
          <div className="notice__body">
            <p className="notice__title">{plural(held, "ligne à relire par vous", "lignes à relire par vous")}</p>
            <p className="notice__text">Le filtre de contenu des écritures automatiques {pl(held, "l'a retenue", "les a retenues")} : rien n'a été écrit. Relisez avant de valider.</p>
          </div>
        </div>
      )}

      {b.state === "preparing" && (
        <div className="bprogress" role="status" aria-live="polite">
          <span className="live-dot" aria-hidden />
          <div className="bprogress__main">
            <p><strong>L'IA rédige les propositions…</strong> {b.counts.total > 0 ? `${plural(b.counts.total, "proposition prête", "propositions prêtes")}.` : "La première arrive dans quelques secondes."}</p>
            <p className="bprogress__hint">Le lot s'ouvrira en brouillon pour relecture. Vous pouvez quitter cet écran : la préparation continue sur le serveur.</p>
          </div>
        </div>
      )}
      {b.state === "applying" && <Progress site={site} b={b} />}
      {b.state === "failed" && b.error && (
        <ErrorState error={{ code: b.error.code, message: b.error.message, action: [b.error.action, resetsAt ? `Remise à zéro des compteurs ${fmtWhen(resetsAt)}.` : null].filter(Boolean).join(" ") || null, status: 0 }} />
      )}
      {b.state !== "failed" && b.error && (
        <div className="notice notice--compact" role="note">
          <TriangleAlert size={15} className="notice__icon" aria-hidden />
          <div className="notice__body">
            <p className="notice__title">{b.error.message}</p>
            <p className="notice__text">{[b.error.action, resetsAt ? `Remise à zéro des compteurs ${fmtWhen(resetsAt)}.` : null].filter(Boolean).join(" ")}</p>
          </div>
        </div>
      )}
      {draft && (
        <p className="batch__lead">
          {b.counts.applied > 0 ? "Relisez chaque ligne en attente" : "Relisez chaque proposition"} : corrigez-la, ou décochez-la pour l'écarter. <strong>Rien {b.counts.applied > 0 ? "de plus n'est écrit" : "n'est écrit"} dans la boutique</strong> tant que vous n'avez pas validé.
          {recap.length > 0 && <> Retenu : {recap.map(([f, n]) => plural(n, ...FIELD_COUNT[f])).join(", ")}.</>}
        </p>
      )}
      <Outcome b={b} />

      {b.items.length > 0 && (
        <ol className="blines" aria-label="Lignes du lot">
          {b.items.map((it) => (
            <BatchItemRow
              key={it.id}
              site={site}
              b={b}
              it={it}
              onBusy={(on) => setEditingRows((s) => {
                if (s.has(it.id) === on) return s;
                const n = new Set(s);
                if (on) n.add(it.id);
                else n.delete(it.id);
                return n;
              })}
            />
          ))}
        </ol>
      )}
      {b.state === "preparing" && b.items.length === 0 && <SkeletonRows rows={3} height={140} />}

      {resumable && (
        <div className="actionbar">
          <p className="actionbar__text">
            <strong className="tnum">{fmtInt(toWrite)}</strong> {pl(toWrite, "ligne retenue n'a", "lignes retenues n'ont")} pas été écrite{toWrite > 1 ? "s" : ""}
          </p>
          <div className="actionbar__actions">
            <Button
              variant="primary"
              icon={<Play size={14} aria-hidden />}
              onClick={() => setConfirm("apply")}
              disabled={!writesEnabled}
              aria-describedby={applyReason}
            >
              Reprendre l'écriture…
            </Button>
          </div>
        </div>
      )}
      {draft && (
        <div className="actionbar">
          <p className="actionbar__text">
            <strong className="tnum">{fmtInt(selected)}</strong> {pl(selected, "ligne retenue", "lignes retenues")} à écrire sur {fmtInt(b.items.filter((i) => i.state === "pending" || i.state === "skipped").length)}
            {editingRows.size > 0 && <span className="muted"> · terminez la correction en cours</span>}
          </p>
          <div className="actionbar__actions">
            <ConfirmButton size="sm" icon={<Trash2 size={14} aria-hidden />} confirmLabel="Abandonner ce lot ?" onConfirm={() => void cancel()} loading={cancelling}>Abandonner</ConfirmButton>
            <Button
              variant="primary"
              onClick={() => setConfirm("apply")}
              disabled={!writesEnabled || selected === 0 || editingRows.size > 0}
              aria-describedby={applyReason}
              title={!writesEnabled ? "Lecture seule : les modifications sont désactivées sur ce serveur." : undefined}
            >
              Valider et appliquer…
            </Button>
          </div>
        </div>
      )}
      <ApplyConfirm site={site} b={b} open={confirm === "apply"} onClose={() => setConfirm(null)} />
      <RestoreConfirm site={site} b={b} open={confirm === "restore"} onClose={() => setConfirm(null)} />
    </div>
  );
}

// ───────────────────────── Préparer des corrections avec l'IA

export function OptimizeDialog({ site, open, onClose }: { site: SiteSummary; open: boolean; onClose: () => void }) {
  const a = useAutomation(site.id, open);
  const toast = useToast();
  const s = a.data;
  const p = s?.policy;
  const fields = (p?.fields ?? []).filter((f): f is OptimizeRequest["field"] => f === "seo_title" || f === "seo_description" || f === "image_alt");
  const [field, setField] = useState<OptimizeRequest["field"] | null>(null);
  const [type, setType] = useState<ShopifyResourceType | "">("");
  const [count, setCount] = useState("10");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const max = p?.maxChangesPerRun ?? 10;
  useEffect(() => {
    if (!open) return;
    setError(null);
  }, [open]);
  useEffect(() => {
    if (!p) return;
    setField((f) => (f && fields.includes(f) ? f : fields[0] ?? null));
    setCount((c) => String(Math.min(Number(c) || max, max)));
  }, [p]); // eslint-disable-line react-hooks/exhaustive-deps
  const types = (p?.resourceTypes ?? []).filter((t) => field !== "image_alt" || t === "product");
  const n = Number(count);
  const countError = !/^\d+$/.test(count.trim()) || n < 1 || n > max ? `Entre 1 et ${fmtInt(max)} (plafond de la règle).` : null;
  const autoEffective = !!s && p?.mode === "auto" && s.autoAllowed && s.writesEnabled;
  const tokensLeft = s ? Math.max(0, s.policy.aiTokensPerDay - s.usage.aiTokens) : 0;
  const canSubmit = !!s && s.aiConfigured && p?.mode !== "off" && !!field && !countError && types.length > 0 && tokensLeft > 0;

  const submit = async () => {
    if (!canSubmit || !field) return;
    setBusy(true);
    setError(null);
    try {
      const b = await optimize(site.id, { field, limit: n, ...(type ? { resourceType: type } : {}) });
      toast.show({ tone: "neutral", title: "Préparation lancée", text: "L'IA rédige les propositions ; le lot s'ouvre en brouillon dès qu'elles sont prêtes." });
      onClose();
      navigate(shopPath(site.id, "batches", b.id));
    } catch (err) {
      setError(batchError(toAppError(err)));
    } finally {
      setBusy(false);
    }
  };
  const wait = useRetryCountdown(error);
  const resetsAt = error?.code === "budget_exceeded" && typeof error.details?.resetsAt === "string" ? error.details.resetsAt : null;

  let body: ReactNode;
  if (!s) {
    body = a.error ? <ErrorState error={a.error} inline onRetry={() => void a.refetch()} retrying={a.fetching} /> : <><LoadingLabel /><Skeleton h={120} r={8} /></>;
  } else if (!s.aiConfigured) {
    body = (
      <div className="notice notice--info" role="note">
        <CircleAlert size={16} className="notice__icon" aria-hidden />
        <div className="notice__body">
          <p className="notice__title">Aucune clé d'IA n'est configurée sur le serveur</p>
          <p className="notice__text">Sans elle, l'IA ne peut rien préparer. La personne qui gère l'installation peut ajouter la clé de l'API Claude côté serveur. Vous pouvez toujours composer vos lots vous-même.</p>
        </div>
      </div>
    );
  } else if (s.policy.mode === "off") {
    body = (
      <div className="notice notice--info" role="note">
        <CircleMinus size={16} className="notice__icon" aria-hidden />
        <div className="notice__body">
          <p className="notice__title">L'automatisation est arrêtée pour ce site</p>
          <p className="notice__text">Le niveau choisi est « L'IA ne prépare rien ». Choisissez « L'IA prépare, vous validez » dans l'onglet Automatisation pour lui demander des propositions.</p>
          <div className="notice__actions"><ButtonLink to={shopPath(site.id, "automation")} size="sm" onClick={onClose}>Ouvrir l'automatisation</ButtonLink></div>
        </div>
      </div>
    );
  } else if (fields.length === 0) {
    body = <p className="muted">La règle n'autorise l'IA sur aucun champ. Ajoutez-en dans l'onglet Automatisation.</p>;
  } else {
    body = (
      <div className="optim">
        <fieldset className="optim__group">
          <legend className="field__label">Champ</legend>
          <div className="optim__choices">
            {fields.map((f) => (
              <label key={f} className={`choice ${field === f ? "is-on" : ""}`}>
                <input type="radio" name="optim-field" value={f} checked={field === f} onChange={() => { setField(f); if (f === "image_alt") setType(""); }} />
                <span className="choice__label">{FIELD_LABEL[f]}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="optim__row">
          <label className="optim__cell">
            <span className="field__label">Type d'élément</span>
            <select className="select" value={type} onChange={(e) => setType(e.target.value as ShopifyResourceType | "")}>
              <option value="">{types.length > 1 ? "Tous les types autorisés" : TYPE_LABEL[types[0] ?? "product"].many}</option>
              {types.length > 1 && TYPE_ORDER.filter((t) => types.includes(t)).map((t) => <option key={t} value={t}>{TYPE_LABEL[t].many}</option>)}
            </select>
          </label>
          <div className="optim__cell">
            <label className="field__label" htmlFor="optim-count">Nombre de propositions</label>
            <div className={`field__control optim__count ${countError ? "is-invalid" : ""}`}>
              <input id="optim-count" className="field__input" type="number" inputMode="numeric" min={1} max={max} value={count} onChange={(e) => setCount(e.target.value)} aria-describedby="optim-count-hint" aria-invalid={countError ? true : undefined} />
            </div>
            <p className={countError ? "field__error" : "field__hint"} id="optim-count-hint">{countError ?? `${fmtInt(max)} au plus par lot (règle d'automatisation).`}</p>
          </div>
        </div>
        <ul className="optim__facts">
          <li><span className="optim__k">L'IA remplace</span><span>{SCOPE_TEXT[s.policy.scope].label}. D'abord les éléments dont la page analysée est en défaut.</span></li>
          <li>
            <span className="optim__k">Jetons d'IA</span>
            <span>{tokensLeft === 0 ? <strong>Limite de préparation du jour atteinte</strong> : <>{fmtTokens(tokensLeft)} restants aujourd'hui sur {fmtTokens(s.policy.aiTokensPerDay)}</>}{tokensLeft === 0 ? `, remise à zéro ${fmtWhen(s.usage.resetsAt)}` : ""}. <span className="subtle">{TOKENS_SCOPE} {TOKENS_HINT}</span></span>
          </li>
          <li>
            <span className="optim__k">Ensuite</span>
            <span>
              {autoEffective
                ? <strong>Mode automatique actif : les propositions conformes à la règle et au filtre de contenu seront écrites dans la boutique sans attendre votre validation, dans la limite de {plural(s.policy.maxAutoChangesPerDay, "écriture automatique", "écritures automatiques")} par jour. Les autres resteront dans le lot, à relire par vous.</strong>
                : "Le lot s'ouvre en brouillon : vous relisez chaque proposition avant toute écriture."}
            </span>
          </li>
        </ul>
        {error && (
          <ErrorState error={{ code: error.code, message: error.message, status: error.status, details: error.details, action: [error.action, resetsAt ? `Remise à zéro des compteurs ${fmtWhen(resetsAt)}.` : null].filter(Boolean).join(" ") || null }} inline />
        )}
        {error?.code === "limit_reached" && <RunningBatchLink site={site} />}
      </div>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      busy={busy}
      size="lg"
      title="Préparer des corrections avec l'IA"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy} data-autofocus={autoEffective || undefined}>{canSubmit ? "Annuler" : "Fermer"}</Button>
          {s && s.aiConfigured && s.policy.mode !== "off" && fields.length > 0 && (
            <Button variant="primary" icon={<Sparkles size={15} aria-hidden />} loading={busy} disabled={!canSubmit || wait > 0} onClick={() => void submit()}>
              {autoEffective ? "Préparer et appliquer" : "Préparer les propositions"}
            </Button>
          )}
        </>
      }
    >
      {body}
    </Dialog>
  );
}

// ───────────────────────── Carte d'un lot, sous une réponse de l'assistant

export function BatchCard({ site, batchId }: { site: SiteSummary; batchId: string }) {
  const q = useShopifyBatch(site.id, batchId);
  const b = q.data?.batch;
  if (!b) {
    if (q.error) {
      return (
        <div className="bcard bcard--error">
          <Layers size={16} aria-hidden className="bcard__icon" />
          <p className="bcard__text"><span className="bcard__title">Lot de corrections indisponible</span><span className="bcard__meta">{q.error.message}</span></p>
        </div>
      );
    }
    return <div className="bcard" aria-hidden><Skeleton w={18} h={18} r={4} /><div style={{ flex: 1 }}><Skeleton w="60%" h={12} /><div style={{ height: 6 }} /><Skeleton w="35%" h={10} /></div></div>;
  }
  // Un lot de l'assistant attend toujours une validation humaine : jamais « appliqué automatiquement » ici.
  // Seul un lot d'une autre origine peut porter des lignes écrites sans validation.
  const auto = b.origin !== "assistant" && b.autoApplied;
  const label = auto ? "Contient des écritures sans validation humaine" : b.state === "draft" ? "À valider" : BATCH_STATE[b.state].label;
  return (
    <Link to={shopPath(site.id, "batches", b.id)} className={`bcard ${auto ? "is-auto" : b.state === "draft" ? "is-draft" : ""}`}>
      {auto ? <Zap size={16} aria-hidden className="bcard__icon" /> : <Layers size={16} aria-hidden className="bcard__icon" />}
      <span className="bcard__text">
        <span className="bcard__title">{b.title}</span>
        <span className="bcard__meta">{plural(b.counts.total, "ligne", "lignes")} · <span className="bcard__state">{label}</span></span>
      </span>
      <span className="bcard__go">{b.state === "draft" ? "Relire" : "Ouvrir"}<ArrowRight size={14} aria-hidden /></span>
    </Link>
  );
}
