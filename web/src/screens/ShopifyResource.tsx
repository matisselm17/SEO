/**
 * Fiche d'un élément de la boutique : valeurs actuelles relues dans Shopify, édition du titre et de la
 * description pour Google (compteur, aperçu Google), des textes alternatifs des images, des traductions,
 * et historique de l'élément. Chaque écriture passe par une confirmation.
 *
 * Ce qui est validé ici est exactement ce que le serveur accepte (espaces normalisés, pas de < ni >, pas de
 * caractère de contrôle, longueur maximale en points de code) : la confirmation montre la valeur qui sera écrite.
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { CircleAlert, CircleCheck, ExternalLink, Info, ListPlus, Lock, OctagonAlert, RefreshCw, TriangleAlert } from "lucide-react";
import type { ShopifyChange, ShopifyChangeResponse, ShopifyField, ShopifyResourceDetail, ShopifyState, ShopifyTranslation, SiteSummary } from "../lib/types";
import { useShopifyBatches, useShopifyResource } from "../lib/queries";
import { NEW_BATCH, navigate, shopPath, sitePath, useSearch } from "../lib/router";
import {
  EMPTY_DESCRIPTION_PREVIEW, FIELD_GUIDE, FIELD_HINT, FIELD_LABEL, FIELD_MAX, TYPE_LABEL, VERDICT_LABEL, codeLength, emptyMeaning, lengthReason,
  localeLabel, normalizeValue, valueProblem,
} from "../lib/shopify";
import { addDraftLines, lineKey, type DraftLine } from "../lib/batchDraft";
import { useToast } from "../ui/Toast";
import { fmtDateTime, plural } from "../lib/format";
import { Sheet } from "../ui/Sheet";
import { SerpPreview } from "../ui/SerpPreview";
import { CharCount } from "../ui/CharCount";
import { Button, Link } from "../ui/Button";
import { ScorePill, Tag } from "../ui/Badge";
import { ErrorState } from "../ui/States";
import { Skeleton, SkeletonText, LoadingLabel } from "../ui/Skeleton";
import { RelaunchButton } from "./common";
import { ChangeList, ConfirmWrite, Thumb, Value, type WriteIntent } from "./ShopifyChanges";

/** Pourquoi on ne peut pas appliquer. `id` : la raison est dite ailleurs (bandeau, section), on y renvoie. */
type Block = { text: string; id?: string } | null;

const RO_ID = "shop-readonly";
const WRITES_OFF = "Lecture seule : les modifications sont désactivées sur ce serveur.";
const NO_PERMISSION = "L'application Shopify n'a pas la permission de modifier ce champ.";

const cut = (s: string, n: number) => (codeLength(s) > n ? [...s].slice(0, n - 1).join("").trimEnd() + "…" : s);
const changeKey = (field: ShopifyField, imageId: string | null | undefined, locale: string | null | undefined) => `${field}|${imageId ?? ""}|${locale ?? ""}`;

/** Champ éditable : la valeur actuelle de la boutique, le texte préparé, un compteur, et « Vérifier et appliquer ». */
function FieldEditor({ label, hint, field, current, emptyText, multiline, block, onApply, onDraft, dataField, locked, lockedReason, extraTag, compact, lang, resetSignal, onAddToBatch }: {
  /** « Ajouter au lot » : la valeur rejoint le lot en préparation au lieu d'être écrite tout de suite. */
  onAddToBatch?: (value: string) => void;
  label: string;
  hint?: string;
  field: ShopifyField;
  current: string | null;
  emptyText: string;
  multiline?: boolean;
  block: Block;
  onApply: (value: string | null) => void;
  onDraft?: (v: string) => void;
  dataField?: string;
  /** Champ non modifiable ici : sa raison s'affiche (sauf si elle est dite pour toute la section). */
  locked?: boolean;
  lockedReason?: string | null;
  extraTag?: ReactNode;
  compact?: boolean;
  /** Langue du texte saisi (attribut lang). */
  lang: string;
  /** Change après une écriture réussie : le champ reprend la valeur relue par le serveur. */
  resetSignal?: number;
}) {
  const id = useId();
  const [draft, setDraft] = useState(current ?? "");
  const last = useRef(current);
  // La valeur de la boutique a changé (relecture) : le champ suit, sauf si l'utilisateur y a écrit autre chose.
  useEffect(() => {
    if (current === last.current) return;
    setDraft((d) => (normalizeValue(d) === normalizeValue(last.current) ? current ?? "" : d));
    last.current = current;
  }, [current]);
  // Après une écriture : la valeur relue fait foi, plus de brouillon.
  useEffect(() => {
    if (resetSignal === undefined || resetSignal === 0) return;
    setDraft(current ?? "");
    last.current = current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetSignal]);
  useEffect(() => onDraft?.(draft), [draft]); // eslint-disable-line react-hooks/exhaustive-deps

  const value = normalizeValue(draft);
  const dirty = value !== normalizeValue(current);
  const problem = dirty && !locked ? valueProblem(field, draft) : null;
  const reasonId = block?.id ?? `${id}-why`;
  const problemId = `${id}-pb`;
  const can = dirty && !problem && !block && !locked;
  const Input = multiline ? "textarea" : "input";
  const inline = compact && !multiline;
  const described = [problem ? problemId : null, block || (locked && lockedReason) ? reasonId : null].filter(Boolean).join(" ") || undefined;
  const apply = (
    <Button size="sm" variant={can ? "primary" : "secondary"} disabled={!can} onClick={() => can && onApply(value)} aria-describedby={described}>
      {inline ? "Appliquer…" : "Vérifier et appliquer"}
    </Button>
  );
  const control = (
    <div className={`field__control fedit__control ${locked ? "is-locked" : ""} ${problem ? "is-invalid" : ""}`}>
      <Input
        id={id}
        className={`field__input fedit__input ${multiline ? "fedit__input--multi" : ""}`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={emptyText}
        disabled={locked}
        rows={multiline ? 3 : undefined}
        spellCheck
        lang={lang}
        aria-invalid={problem ? true : undefined}
        aria-describedby={described}
      />
    </div>
  );
  return (
    <div className={`fedit ${compact ? "fedit--compact" : ""}`} data-field={dataField}>
      <div className="fedit__head">
        <label htmlFor={id} className="fedit__label">{label}{extraTag}</label>
        {!locked && <CharCount length={codeLength(value ?? "")} guide={FIELD_GUIDE[field]} max={FIELD_MAX[field]} />}
      </div>
      {hint && <p className="fedit__hint">{hint}</p>}
      {inline && !locked ? <div className="fedit__row">{control}{apply}</div> : control}
      {problem && (
        <p className="fedit__error" id={problemId} role="alert"><CircleAlert size={13} aria-hidden />{problem}</p>
      )}
      {locked ? (
        lockedReason ? <p className="fedit__locked" id={reasonId}><Lock size={13} aria-hidden />{lockedReason}</p> : null
      ) : (
        <>
          {dirty && (
            <p className="fedit__current">
              Aujourd'hui dans Shopify : <Value v={current} empty={emptyText} />
            </p>
          )}
          {(!inline || dirty || (block && !block.id)) && (
            <div className="fedit__actions">
              {!inline && apply}
              {onAddToBatch && dirty && value && !problem && (
                <Button size="sm" variant="secondary" icon={<ListPlus size={14} aria-hidden />} onClick={() => onAddToBatch(value)}>Ajouter au lot</Button>
              )}
              {dirty && <Button size="sm" variant="ghost" onClick={() => setDraft(current ?? "")}>Revenir à la valeur actuelle</Button>}
              {block && !block.id && <span className="fedit__block" id={reasonId}><Lock size={13} aria-hidden />{block.text}</span>}
            </div>
          )}
        </>
      )}
    </div>
  );
}

const VERDICT_ICON = { pass: CircleCheck, warn: TriangleAlert, fail: OctagonAlert } as const;

/**
 * Ce que l'analyse a vu sur la page affichée : le titre et la description réellement lus par Google, et leur verdict.
 * Un champ vide dans Shopify dont le texte affiché est correct n'est pas présenté comme un défaut.
 */
function SeenOnPage({ r }: { r: ShopifyResourceDetail }) {
  const a = r.audit;
  if (!a) {
    return (
      <div className="seen seen--na">
        <p className="seen__lead"><Info size={14} aria-hidden /> Page non ouverte par l'analyse : on ne sait pas encore ce que Google lit réellement sur cette page. Relancez l'analyse avec un plafond de pages plus élevé pour la vérifier.</p>
      </div>
    );
  }
  const rows = [
    { field: "seo_title" as const, label: "Titre affiché", text: a.renderedTitle, status: a.titleStatus, empty: !r.seoTitle, fallback: `Le champ est vide dans Shopify : la page affiche ${TYPE_LABEL[r.type].the}.` },
    { field: "seo_description" as const, label: "Description affichée", text: a.renderedDescription, status: a.descriptionStatus, empty: !r.seoDescription, fallback: "Le champ est vide dans Shopify : la page affiche le début du texte." },
  ];
  return (
    <dl className="seen">
      {rows.map((x) => {
        const Icon = VERDICT_ICON[x.status];
        const why = x.status === "warn" ? lengthReason(x.field, x.text) : null;
        return (
          <div key={x.field} className="seen__row">
            <dt className="seen__k">{x.label}</dt>
            <dd className="seen__v">
              <span className={`verdict verdict--${x.status}`}><Icon size={13} aria-hidden />{VERDICT_LABEL[x.status]}{why ? ` : ${why}` : x.status === "fail" ? " : rien n'est affiché" : ""}</span>
              {x.text && <span className="seen__text">« {x.text} »</span>}
              {x.empty && <span className="seen__note">{x.fallback}{x.status === "pass" ? " Le résultat est correct : rien à corriger." : ""}</span>}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/** Image dont le texte alternatif ne se modifie pas ici : elle reste affichée avec son texte actuel. */
function ImageReadOnly({ image, index }: { image: ShopifyResourceDetail["imageList"][number]; index: number }) {
  return (
    <li className="imgrow imgrow--ro" data-image={image.id}>
      <Thumb url={image.url} alt={image.alt} size={56} />
      <div className="imgrow__ro">
        <p className="fedit__label">Image {index}{!image.alt && <span className="fedit__flag">Sans texte alternatif</span>}</p>
        <p className="imgrow__alt"><Value v={image.alt} empty="Pas de texte alternatif" /></p>
      </div>
    </li>
  );
}

export function ShopifyResourceSheet({ site, shop, resourceId, onClose }: { site: SiteSummary; shop: ShopifyState | undefined; resourceId: string | null; onClose: () => void }) {
  const q = useShopifyResource(site.id, resourceId);
  const search = useSearch();
  const focusField = search.get("champ") as ShopifyField | null;
  const focusChange = search.get("modif");
  const batchList = useShopifyBatches(site.id, !!resourceId).data?.batches;
  const batchTitles = useMemo(() => new Map((batchList ?? []).map((b) => [b.id, { title: b.title, auto: b.autoApplied }])), [batchList]);
  const toast = useToast();
  const r = q.data?.resource && q.data.resource.id === resourceId ? q.data.resource : null;
  const conn = shop?.connection;
  const writesOn = conn?.writesEnabled === true;
  const primary = conn?.primaryLocale ?? "fr";
  const primaryName = localeLabel(primary).toLowerCase();
  const [intent, setIntent] = useState<WriteIntent | null>(null);
  const [changed, setChanged] = useState<{ at: string; verified: boolean; restore: boolean; locale: boolean } | null>(null);
  const [resets, setResets] = useState<Record<string, number>>({});
  const [draftTitle, setDraftTitle] = useState<string | null>(null);
  const [draftDesc, setDraftDesc] = useState<string | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const focused = useRef<string | null>(null);

  useEffect(() => {
    setChanged(null);
    setResets({});
    setDraftTitle(null);
    setDraftDesc(null);
    focused.current = null;
  }, [resourceId]);

  // Ouverte depuis l'audit sur un champ précis : on l'amène à l'écran et on y place le curseur.
  useEffect(() => {
    if (!r || !focusField || focused.current === r.id) return;
    focused.current = r.id;
    const t = setTimeout(() => {
      const root = body.current;
      if (!root) return;
      const target =
        focusField === "image_alt"
          ? root.querySelector<HTMLElement>("[data-image][data-missing]") ?? root.querySelector<HTMLElement>("[data-image]")
          : root.querySelector<HTMLElement>(`[data-field="${focusField}"]`);
      if (!target) return;
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      target.querySelector<HTMLElement>("input:not([disabled]),textarea:not([disabled])")?.focus({ preventScroll: true });
      target.classList.add("is-target");
      setTimeout(() => target.classList.remove("is-target"), 1600);
    }, 320);
    return () => clearTimeout(t);
  }, [r, focusField]);

  // Ouverte depuis un lot sur une modification précise : on l'amène à l'écran dans l'historique de l'élément.
  useEffect(() => {
    if (!r || !focusChange) return;
    const t = setTimeout(() => {
      const el = body.current?.querySelector<HTMLElement>(`[data-change="${CSS.escape(focusChange)}"]`);
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 320);
    return () => clearTimeout(t);
  }, [r, focusChange]);

  /** « Ajouter au lot » depuis la fiche : la valeur rejoint le lot en préparation, rien n'est écrit. */
  const addToBatch = (field: ShopifyField, value: string, current: string | null, extra?: { imageId?: string; locale?: string; image?: { url: string; index: number } }) => {
    if (!r) return;
    const a = r.audit;
    const line: DraftLine = {
      key: lineKey(r.id, field, extra?.imageId ?? null, extra?.locale ?? null), resourceId: r.id, resourceType: r.type, title: r.title, path: r.path, field,
      imageId: extra?.imageId ?? null, imageUrl: extra?.image?.url ?? null, imageIndex: extra?.image?.index ?? null, locale: extra?.locale ?? null, current,
      rendered: a && !extra?.locale && field !== "image_alt" ? (field === "seo_title" ? { text: a.renderedTitle, status: a.titleStatus } : { text: a.renderedDescription, status: a.descriptionStatus }) : null,
      value,
    };
    const res = addDraftLines(site.id, [line]);
    toast.show({
      tone: res.refused ? "error" : "success",
      title: res.refused ? "Le lot en préparation est plein" : res.updated ? "Valeur mise à jour dans le lot en préparation" : "Ajouté au lot en préparation",
      text: res.refused ? "Un lot compte 50 lignes au plus : créez d'abord le brouillon." : "Rien n'est écrit dans la boutique. Vous validerez le lot entier, après relecture.",
      action: res.refused ? undefined : { label: "Ouvrir le lot", onClick: () => navigate(shopPath(site.id, "batches", NEW_BATCH)) },
    });
  };

  /** Raison propre à l'élément (readOnlyReasons), dite une fois. */
  const roReason = (field: ShopifyField | "translations") => r?.readOnlyReasons?.[field] ?? null;
  /** Pourquoi on ne peut pas appliquer un champ modifiable par nature. */
  const blockFor = (field: ShopifyField | "translations", sectionId?: string): Block => {
    if (!writesOn) return { text: WRITES_OFF, id: RO_ID };
    if (r && !r.editable[field]) return { text: NO_PERMISSION, id: sectionId };
    return null;
  };

  const edit = (field: ShopifyField, value: string | null, current: string | null, extra?: { imageId?: string; locale?: string; image?: { url: string; index: number } }) => {
    if (!r) return;
    setIntent({
      kind: "edit",
      req: { resourceId: r.id, field, value, expectedBefore: current, ...(extra?.imageId ? { imageId: extra.imageId } : {}), ...(extra?.locale ? { locale: extra.locale } : {}) },
      resource: { title: r.title, path: r.path, type: r.type },
      image: extra?.image ?? null,
    });
  };

  const onDone = (res: ShopifyChangeResponse) => {
    setChanged({ at: res.change.appliedAt, verified: res.change.afterVerified, restore: res.change.kind === "restore", locale: !!res.change.locale });
    const k = changeKey(res.change.field, res.change.image?.id, res.change.locale);
    setResets((m) => ({ ...m, [k]: (m[k] ?? 0) + 1 }));
  };

  const pageUrl = useMemo(() => {
    if (!r) return null;
    try {
      return new URL(r.path, site.url).href;
    } catch {
      return null;
    }
  }, [r, site.url]);

  // L'aperçu suit la saisie ; sans saisie, il montre ce que l'analyse a vu sur la page (le nom ou le début du texte si le champ est vide).
  const previewTitle = r ? normalizeValue(draftTitle ?? r.seoTitle ?? "") ?? (r.seoTitle ? r.title : r.audit?.renderedTitle ?? r.title) : null;
  const previewDesc = r ? normalizeValue(draftDesc ?? r.seoDescription ?? "") ?? (r.seoDescription ? null : r.audit?.renderedDescription ?? null) : null;
  const locales = useMemo(() => {
    if (!r) return [];
    const m = new Map<string, ShopifyTranslation[]>();
    r.translations.forEach((t) => m.set(t.locale, [...(m.get(t.locale) ?? []), t]));
    return [...m.entries()];
  }, [r]);
  const missingAlt = r ? r.imageList.filter((i) => !i.alt).length : 0;
  const imagesRo = r ? roReason("image_alt") : null;
  const imagesNoPerm = r && !imagesRo && writesOn && !r.editable.image_alt;
  const trRo = r ? roReason("translations") : null;
  const trNoPerm = r && !trRo && writesOn && !r.editable.translations;

  return (
    <>
      <Sheet
        open={!!resourceId}
        onClose={onClose}
        title={r ? r.title : q.error ? "Élément introuvable" : <Skeleton w="55%" h={22} />}
        subtitle={
          r && (
            <>
              <Tag>{TYPE_LABEL[r.type].one}</Tag>
              <span className="mono sheet__path-inline">{r.path}</span>
              {r.pageId && r.pageScore !== null ? (
                <Link to={sitePath(site.id, "pages", r.pageId)} className="shop-score" title="Voir l'analyse de cette page">
                  <ScorePill score={r.pageScore} /> <span className="text-link">Voir l'analyse</span>
                </Link>
              ) : (
                <span className="subtle">Page non analysée</span>
              )}
              {pageUrl && (
                <a href={pageUrl} target="_blank" rel="noopener noreferrer nofollow" className="text-link sheet__ext">
                  Ouvrir la page <ExternalLink size={12} aria-hidden />
                </a>
              )}
            </>
          )
        }
      >
        <div ref={body}>
          {q.error && !r && <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.fetching} />}
          {!r && !q.error && (
            <div className="detail-stack">
              <LoadingLabel>Lecture de l'élément dans Shopify…</LoadingLabel>
              <Skeleton h={112} r={8} />
              <SkeletonText lines={2} />
              <Skeleton h={36} r={6} />
              <SkeletonText lines={2} />
              <Skeleton h={78} r={6} />
            </div>
          )}
          {r && (
            <div className="detail-stack shop-detail">
              <div className="shop-detail__notes">
                <p className="shop-live">
                  <RefreshCw size={13} aria-hidden className={q.fetching ? "btn__spin" : undefined} />
                  {q.fetching ? "Relecture dans Shopify…" : "Valeurs relues à l'instant dans Shopify."}
                </p>
                {q.error && <ErrorState error={q.error} inline onRetry={() => void q.refetch()} retrying={q.fetching} />}
                {!writesOn && conn && (
                  <div className="notice notice--info notice--compact" role="note" id={RO_ID}>
                    <Lock size={15} className="notice__icon" aria-hidden />
                    <div className="notice__body">
                      <p className="notice__title">Lecture seule</p>
                      <p className="notice__text">Vous pouvez tout consulter et préparer vos textes, mais pas les appliquer. La personne qui gère l'installation active les modifications côté serveur.</p>
                    </div>
                  </div>
                )}
                {changed && (
                  <div className={`notice notice--compact ${!changed.verified ? "notice--warning" : changed.restore ? "notice--good" : "notice--info"}`} role="status">
                    {changed.verified && changed.restore ? <CircleCheck size={15} className="notice__icon" aria-hidden /> : <Info size={15} className="notice__icon" aria-hidden />}
                    <div className="notice__body">
                      <p className="notice__title">
                        {!changed.verified
                          ? `Modification acceptée par Shopify le ${fmtDateTime(changed.at)}`
                          : changed.restore
                            ? `Valeur d'avant remise dans Shopify le ${fmtDateTime(changed.at)}`
                            : `Valeur enregistrée dans Shopify le ${fmtDateTime(changed.at)}`}
                      </p>
                      <p className="notice__text">
                        {!changed.verified
                          ? "La nouvelle valeur n'a pas pu être relue juste après. Relisez l'élément pour vérifier ce que montre la boutique."
                          : changed.restore
                            ? "La note de la page ne changera qu'à la prochaine analyse du site, qui relira la page en ligne."
                            : changed.locale
                              ? "Les traductions ne peuvent pas encore être vérifiées sur la page publique. La note de la page ne changera qu'à la prochaine analyse du site."
                              : "Chat SEO va relire la page publique d'ici quelques secondes pour vérifier que la correction y apparaît : le résultat s'affiche dans l'historique ci-dessous. La note de la page dans l'analyse ne changera qu'à la prochaine analyse du site."}
                      </p>
                      <div className="notice__actions">
                        {changed.verified ? <RelaunchButton site={site} /> : <Button size="sm" variant="secondary" icon={<RefreshCw size={14} aria-hidden />} loading={q.fetching} onClick={() => void q.refetch()}>Relire l'élément</Button>}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <section className="detail-block" aria-labelledby="shop-google">
                <h3 className="detail-block__title" id="shop-google">Dans Google</h3>
                <p className="detail-block__hint">Ce que l'analyse a lu sur la page en ligne, puis l'aperçu, qui suit ce que vous écrivez ci-dessous.</p>
                <SeenOnPage r={r} />
                <SerpPreview
                  url={pageUrl ?? site.url}
                  title={previewTitle ? cut(previewTitle, 60) : null}
                  description={previewDesc ? cut(previewDesc, 160) : null}
                  siteName={conn?.shopName ?? site.name}
                  missingDescription={EMPTY_DESCRIPTION_PREVIEW}
                />
                {(["seo_title", "seo_description"] as const).map((f) => (
                  <FieldEditor
                    key={f}
                    dataField={f}
                    label={FIELD_LABEL[f]}
                    hint={FIELD_HINT[f]}
                    field={f}
                    current={f === "seo_title" ? r.seoTitle : r.seoDescription}
                    emptyText={emptyMeaning(f, r.type)}
                    multiline={f === "seo_description"}
                    lang={primary}
                    block={blockFor(f)}
                    locked={!!roReason(f)}
                    lockedReason={roReason(f)}
                    resetSignal={resets[changeKey(f, null, null)]}
                    onDraft={f === "seo_title" ? setDraftTitle : setDraftDesc}
                    onApply={(v) => edit(f, v, f === "seo_title" ? r.seoTitle : r.seoDescription)}
                    onAddToBatch={roReason(f) || !r.editable[f] ? undefined : (v) => addToBatch(f, v, f === "seo_title" ? r.seoTitle : r.seoDescription)}
                  />
                ))}
              </section>

              {(r.imageList.length > 0 || r.images > 0) && (
                <section className="detail-block" aria-labelledby="shop-images">
                  <h3 className="detail-block__title" id="shop-images">
                    Images <span className="muted tnum">{r.images}</span>
                    {missingAlt > 0 && <span className="detail-block__aside">{plural(missingAlt, "sans texte alternatif", "sans texte alternatif")}</span>}
                  </h3>
                  <p className="detail-block__hint">
                    {FIELD_HINT.image_alt}{!imagesRo && " Décrivez ce qu'on voit : le produit, sa couleur, sa matière. Une image à la fois."}
                  </p>
                  {(imagesRo || imagesNoPerm) && (
                    <p className="fedit__block fedit__block--section" id="shop-images-why">
                      <Lock size={13} aria-hidden />
                      {imagesRo ?? "L'application Shopify n'a pas la permission de modifier le texte alternatif des images."}
                    </p>
                  )}
                  <ul className="imgrows">
                    {r.imageList.map((im, i) =>
                      imagesRo ? (
                        <ImageReadOnly key={im.id} image={im} index={i + 1} />
                      ) : (
                        <li key={im.id} className="imgrow" data-image={im.id} data-missing={im.alt ? undefined : "1"}>
                          <Thumb url={im.url} alt={im.alt} size={56} />
                          <FieldEditor
                            label={`Image ${i + 1}`}
                            field="image_alt"
                            current={im.alt}
                            emptyText="Décrivez l'image"
                            lang={primary}
                            block={blockFor("image_alt", "shop-images-why")}
                            resetSignal={resets[changeKey("image_alt", im.id, null)]}
                            extraTag={im.alt ? null : <span className="fedit__flag">Sans texte alternatif</span>}
                            onApply={(v) => edit("image_alt", v, im.alt, { imageId: im.id, image: { url: im.url, index: i + 1 } })}
                            onAddToBatch={r.editable.image_alt ? (v) => addToBatch("image_alt", v, im.alt, { imageId: im.id, image: { url: im.url, index: i + 1 } }) : undefined}
                            compact
                          />
                        </li>
                      ),
                    )}
                  </ul>
                  {r.images > r.imageList.length && <p className="muted small">Seules les {r.imageList.length} premières images sont affichées.</p>}
                </section>
              )}

              {locales.length > 0 && (
                <section className="detail-block" aria-labelledby="shop-tr">
                  <h3 className="detail-block__title" id="shop-tr">Traductions</h3>
                  <p className="detail-block__hint">Ce que Google affiche aux internautes des autres langues publiées par la boutique.</p>
                  {(trRo || trNoPerm) && (
                    <p className="fedit__block fedit__block--section" id="shop-tr-why">
                      <Lock size={13} aria-hidden />
                      {trRo ?? "L'application Shopify n'a pas la permission de modifier les traductions."}
                    </p>
                  )}
                  {locales.map(([loc, list]) => (
                    <div key={loc} className="locale">
                      <p className="locale__name">{localeLabel(loc)} <span className="subtle mono">{loc}</span></p>
                      {list.map((t) => (
                        <FieldEditor
                          key={`${loc}-${t.field}`}
                          label={FIELD_LABEL[t.field]}
                          field={t.field}
                          current={t.value}
                          emptyText="Pas de traduction"
                          hint={t.value ? undefined : t.field === "seo_title" ? `Sans traduction, Google affiche le titre en ${primaryName}.` : `Sans traduction, Google affiche la description en ${primaryName}.`}
                          multiline={t.field === "seo_description"}
                          lang={loc}
                          block={blockFor("translations", "shop-tr-why")}
                          locked={!!trRo || !t.editable}
                          lockedReason={trRo ? null : t.reason}
                          resetSignal={resets[changeKey(t.field, null, loc)]}
                          extraTag={t.outdated ? <span className="fedit__flag" title={`Le texte en ${primaryName} a été modifié après cette traduction.`}>À revoir : le texte en {primaryName} a changé depuis</span> : null}
                          onApply={(v) => edit(t.field, v, t.value, { locale: loc })}
                          onAddToBatch={t.editable && r.editable.translations && !trRo ? (v) => addToBatch(t.field, v, t.value, { locale: loc }) : undefined}
                          compact
                        />
                      ))}
                    </div>
                  ))}
                </section>
              )}

              <section className="detail-block" aria-labelledby="shop-hist">
                <h3 className="detail-block__title" id="shop-hist">Historique de cet élément <span className="muted tnum">{r.history.length}</span></h3>
                <ChangeList
                  site={site}
                  changes={r.history}
                  showResource={false}
                  blocked={writesOn ? null : WRITES_OFF}
                  onRestore={(c: ShopifyChange) => setIntent({ kind: "restore", change: c })}
                  onReread={() => void q.refetch()}
                  highlight={focusChange}
                  batchTitles={batchTitles}
                  empty={<p className="muted small shop-empty-hist"><Info size={14} aria-hidden /> Aucune modification faite par Chat SEO sur cet élément.</p>}
                />
              </section>
            </div>
          )}
        </div>
      </Sheet>
      <ConfirmWrite
        site={site}
        intent={intent}
        onClose={() => setIntent(null)}
        onDone={onDone}
        onReload={() => q.refetch()}
        onReread={() => void q.refetch()}
      />
    </>
  );
}
