/**
 * Boutique Shopify : confirmation d'une écriture ou d'une annulation, et historique des modifications.
 * Une seule valeur par confirmation ; l'avant et l'après sont toujours montrés.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowRight, CircleAlert, CircleCheck, CircleMinus, ExternalLink, Image as ImageIcon, ImageOff, Info, Layers, RefreshCw, RotateCcw, TriangleAlert, Undo2, Zap } from "lucide-react";
import { DEMO_ENABLED } from "../lib/transport";
import type { CheckStatus, ShopifyChange, ShopifyChangeRequest, ShopifyChangeResponse, ShopifyResourceType, SiteSummary } from "../lib/types";
import { toAppError, type AppError } from "../lib/api";
import { CRITERION_LABEL, FIELD_LABEL, TYPE_LABEL, applyShopifyChange, emptyMeaning, fieldInline, localeLabel, restoreShopifyChange, safeHttpsUrl, safeImageUrl, verifyShopifyChange } from "../lib/shopify";
import { startAudit } from "../lib/actions";
import { invalidateShopify } from "../lib/live";
import { fmtDateTime } from "../lib/format";
import { Dialog } from "../ui/Dialog";
import { Button, Link } from "../ui/Button";
import { ErrorState, useRetryCountdown } from "../ui/States";
import { Tag } from "../ui/Badge";
import { useToast } from "../ui/Toast";
import { CorrectionStatus } from "../ui/CorrectionStatus";
import { shopPath, sitePath } from "../lib/router";

/** Vignette d'une image Shopify : affichée seulement si son adresse est en https, sinon une vignette neutre. */
export function Thumb({ url, alt, size = 48 }: { url: string; alt?: string | null; size?: number }) {
  const safe = safeImageUrl(url);
  const [broken, setBroken] = useState(false);
  // Mode démonstration (développement) : les images fictives ne sont pas chargées.
  const demo = DEMO_ENABLED && !!safe && safe.includes("/files/1/0000/demo/");
  useEffect(() => setBroken(false), [url]);
  const style = { width: size, height: size };
  if (demo) {
    return (
      <span className="thumb thumb--empty" style={style} title="Image de démonstration">
        <ImageIcon size={Math.round(size * 0.36)} aria-hidden />
      </span>
    );
  }
  if (!safe || broken) {
    return (
      <span className="thumb thumb--empty" style={style} title={safe ? "Image indisponible" : "Image non affichée : adresse non sécurisée"}>
        <ImageOff size={Math.round(size * 0.36)} aria-hidden />
      </span>
    );
  }
  // alt vide : l'image est décrite à côté, par le champ qu'elle accompagne.
  return <img className="thumb" src={safe} alt={alt ?? ""} style={style} loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} />;
}

/** Une valeur affichée telle quelle (texte brut), ou « Vide ». */
export function Value({ v, empty = "Vide" }: { v: string | null; empty?: string }) {
  return v ? <span className="value">{v}</span> : <span className="value value--empty">{empty}</span>;
}

export type WriteIntent =
  | {
      kind: "edit";
      req: ShopifyChangeRequest;
      resource: { title: string; path: string; type: ShopifyResourceType };
      image?: { url: string; index: number } | null;
    }
  | { kind: "restore"; change: ShopifyChange };


/**
 * Étape de confirmation avant toute écriture dans la boutique.
 * `onReload` : relire la valeur actuelle (après un conflit).
 */
export function ConfirmWrite({ site, intent, onClose, onDone, onReload, onReread }: {
  site: SiteSummary;
  intent: WriteIntent | null;
  onClose: () => void;
  onDone?: (res: ShopifyChangeResponse) => void;
  onReload: () => Promise<void> | void;
  /** Relire l'élément quand Shopify a accepté une écriture sans qu'on puisse relire la valeur. */
  onReread?: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [reloading, setReloading] = useState(false);
  // Un seul envoi, même en cas de double appui : le bouton n'est désactivé qu'au rendu suivant.
  const sending = useRef(false);
  // Trop de modifications en peu de temps : le bouton attend la fin du délai indiqué par le serveur.
  const wait = useRetryCountdown(error);
  // Garde le contenu pendant l'animation de fermeture.
  const [shown, setShown] = useState<WriteIntent | null>(intent);
  useEffect(() => {
    if (intent) {
      setShown(intent);
      setError(null);
      setBusy(false);
    }
  }, [intent]);
  const it = intent ?? shown;
  if (!it) return null;

  const isRestore = it.kind === "restore";
  const field = isRestore ? it.change.field : it.req.field;
  const locale = isRestore ? it.change.locale : it.req.locale ?? null;
  const before = isRestore ? it.change.after : it.req.expectedBefore;
  const after = isRestore ? it.change.before : it.req.value;
  const title = isRestore ? it.change.resourceTitle : it.resource.title;
  const path = isRestore ? it.change.path : it.resource.path;
  const type = isRestore ? it.change.resourceType : it.resource.type;
  const imageUrl = isRestore ? it.change.image?.url ?? null : it.image?.url ?? null;
  // Ce que montre un champ vide : Shopify se rabat sur le nom ou le texte de l'élément.
  const emptyText = locale ? "Vide : pas de traduction" : field === "image_alt" ? "Vide : image non décrite" : `Vide : ${emptyMeaning(field, type).replace(/^Vide : /, "").replace(/\.$/, "")}`;

  const submit = async () => {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = isRestore ? await restoreShopifyChange(site.id, it.change.id) : await applyShopifyChange(site.id, it.req);
      if (res.change.afterVerified) {
        toast.show(
          isRestore
            ? {
                tone: "success",
                title: "Valeur d'avant remise dans Shopify",
                text: "La note de la page ne changera qu'à la prochaine analyse du site.",
                action: { label: "Relancer l'analyse", onClick: () => void startAudit(site.id, undefined, toast) },
              }
            : {
                tone: "success",
                title: "Valeur enregistrée dans Shopify",
                text: locale
                  ? "Les traductions ne peuvent pas encore être vérifiées sur la page publique."
                  : "Chat SEO va relire la page publique d'ici quelques secondes pour vérifier la correction. Le résultat s'affiche dans l'historique.",
              },
        );
      } else {
        toast.show({
          tone: "neutral",
          title: "Modification acceptée par Shopify",
          text: "La nouvelle valeur n'a pas pu être relue : relisez l'élément pour vérifier.",
          action: { label: "Relire", onClick: () => (onReread ? onReread() : invalidateShopify(site.id)) },
        });
      }
      onDone?.(res);
      onClose();
    } catch (err) {
      setError(toAppError(err));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  const conflict = error?.code === "shopify_conflict";
  // Erreurs qu'un nouvel essai ne résoudrait pas : le bouton qui écrit reste désactivé.
  const blocked = !!error && ["shopify_writes_disabled", "shopify_missing_scope", "shopify_other_shop", "shopify_not_configured", "shopify_invalid_value", "bad_request"].includes(error.code);
  const current = conflict && error?.details && "current" in error.details ? (error.details.current as string | null) : null;

  const reload = async () => {
    setReloading(true);
    try {
      await onReload();
      invalidateShopify(site.id);
    } finally {
      setReloading(false);
      onClose();
    }
  };

  const where = (
    <dl className="confirm__target">
      <div><dt>Élément</dt><dd><span className="confirm__name">{title}</span> <span className="confirm__type">{TYPE_LABEL[type].one}</span><span className="mono confirm__path">{path}</span></dd></div>
      <div>
        <dt>Champ</dt>
        <dd className="confirm__field">
          {imageUrl && <Thumb url={imageUrl} size={36} />}
          <span>
            {FIELD_LABEL[field]}
            {!isRestore && it.image ? ` de l'image ${it.image.index}` : ""}
            {locale ? ` · version ${localeLabel(locale).toLowerCase()}` : ""}
          </span>
        </dd>
      </div>
    </dl>
  );

  return (
    <Dialog
      open={!!intent}
      onClose={onClose}
      busy={busy}
      size="lg"
      title={conflict ? "La valeur a changé dans Shopify" : isRestore ? "Remettre la valeur d'avant ?" : `Modifier ${fieldInline(field)} ?`}
      footer={
        conflict ? (
          <>
            <Button variant="secondary" onClick={onClose} data-autofocus>Fermer</Button>
            <Button variant="primary" icon={<RotateCcw size={15} aria-hidden />} loading={reloading} onClick={() => void reload()}>
              Recharger la valeur actuelle
            </Button>
          </>
        ) : (
          <>
            {/* Focus initial sur « Ne rien modifier » : Entrée n'écrit jamais dans la boutique par réflexe. */}
            <Button variant="secondary" onClick={onClose} disabled={busy} data-autofocus>Ne rien modifier</Button>
            <Button variant="primary" loading={busy} disabled={blocked || wait > 0} onClick={() => void submit()}>
              {error && !blocked && wait === 0 ? "Réessayer" : isRestore ? "Remettre cette valeur" : "Enregistrer dans Shopify"}
            </Button>
          </>
        )
      }
    >
      {where}
      {conflict ? (
        <div className="confirm__conflict">
          <p className="confirm__lead">
            <TriangleAlert size={16} aria-hidden className="confirm__lead-icon" />
            <span>
              {error?.message ?? "Quelqu'un a modifié cette valeur dans Shopify depuis que vous l'avez affichée."}
              {!/rien n'a été modifié/i.test(error?.message ?? "") && <strong> Rien n'a été modifié.</strong>}
            </span>
          </p>
          <Compare
            beforeLabel={isRestore ? "Valeur attendue (écrite par la modification)" : "Valeur que vous aviez sous les yeux"}
            before={before}
            afterLabel="Valeur actuelle dans Shopify"
            after={current}
            afterTone="current"
            empty={emptyText}
          />
          <p className="confirm__note">Rechargez la valeur actuelle, vérifiez-la, puis recommencez si besoin. {isRestore ? "" : "Votre texte reste dans le champ."}</p>
        </div>
      ) : (
        <>
          <Compare
            beforeLabel={isRestore ? "Valeur écrite par cette modification" : "Valeur actuelle, lue dans Shopify"}
            before={before}
            afterLabel={isRestore ? "Valeur qui sera remise" : "Après la modification"}
            after={after}
            empty={emptyText}
          />
          <p className="confirm__note">
            <strong>La boutique en ligne sera modifiée tout de suite :</strong> vos visiteurs et Google verront la nouvelle valeur. Vous pourrez revenir en arrière depuis l'historique des modifications.
          </p>
          {isRestore && <p className="confirm__note">Avant d'écrire, Chat SEO vérifie que la boutique contient toujours la valeur écrite par cette modification ; sinon, rien n'est modifié.</p>}
          {error && <ErrorState error={error} inline />}
        </>
      )}
    </Dialog>
  );
}

function Compare({ beforeLabel, before, afterLabel, after, afterTone = "new", empty }: { beforeLabel: string; before: string | null; afterLabel: string; after: string | null; afterTone?: "new" | "current"; empty?: string }) {
  return (
    <div className="compare">
      <div className="compare__box compare__box--before">
        <p className="compare__label">{beforeLabel}</p>
        <p className="compare__value"><Value v={before} empty={empty} /></p>
      </div>
      <ArrowRight size={16} className="compare__arrow" aria-hidden />
      <div className={`compare__box compare__box--${afterTone}`}>
        <p className="compare__label">{afterLabel}</p>
        <p className="compare__value"><Value v={after} empty={empty} /></p>
      </div>
    </div>
  );
}

/** Historique des modifications : quoi, où, avant, après, quand ; « Annuler » sur la dernière modification d'un champ. */
export function ChangeList({ site, changes, onRestore, showResource = true, empty, blocked, onReread, batchTitles, highlight }: {
  site: SiteSummary;
  /**
   * Lots connus, pour dire de quel lot vient une modification, et si ce lot contient des lignes écrites sans
   * validation humaine (le détail ligne par ligne est dans l'écran du lot : ShopifyBatchItem.autoApplied).
   */
  batchTitles?: Map<string, { title: string; auto: boolean }>;
  /** Modification à mettre en évidence (lien depuis un lot). */
  highlight?: string | null;
  changes: ShopifyChange[];
  onRestore: (c: ShopifyChange) => void;
  /** Relire l'élément (modification acceptée mais non relue). Sans elle, le lien ouvre la fiche de l'élément. */
  onReread?: () => void;
  showResource?: boolean;
  empty?: ReactNode;
  /** Lecture seule : « Annuler » reste visible, désactivé, avec cette raison. */
  blocked?: string | null;
}) {
  // Relectures demandées en cours : la pastille passe à « Vérification en cours… » sans attendre la réponse.
  const [checking, setChecking] = useState<ReadonlySet<string>>(() => new Set());
  const onChecking = (id: string, on: boolean) => setChecking((prev) => {
    const next = new Set(prev);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  });
  if (changes.length === 0) return <>{empty ?? null}</>;
  const byId = new Map(changes.map((c) => [c.id, c]));
  return (
    <ol className="changes">
      {changes.map((c) => (
        <li key={c.id} className={`change ${highlight === c.id ? "is-target" : ""}`} data-change={c.id}>
          <div className="change__head">
            <p className="change__what">
              {c.kind === "restore" ? <Undo2 size={14} aria-hidden className="change__kind-icon" /> : null}
              <span className="change__field">{FIELD_LABEL[c.field]}</span>
              {c.locale && <Tag>{localeLabel(c.locale)}</Tag>}
              {c.kind === "restore" && <Tag>Annulation</Tag>}
              {c.batchId && (
                <Link to={shopPath(site.id, "batches", c.batchId)} className="change__batch" title="Ouvrir le lot de corrections">
                  {batchTitles?.get(c.batchId)?.auto ? <Zap size={12} aria-hidden /> : <Layers size={12} aria-hidden />}
                  <span>{batchTitles?.get(c.batchId) ? `Lot « ${batchTitles.get(c.batchId)!.title} »` : "Lot de corrections"}{batchTitles?.get(c.batchId)?.auto ? " · lot avec des écritures sans validation humaine" : ""}</span>
                </Link>
              )}
              {showResource && (
                <>
                  <Link to={sitePath(site.id, "shopify", c.resourceId)} className="change__res">{c.resourceTitle}</Link>
                </>
              )}
            </p>
            <p className="change__meta">
              <time dateTime={c.appliedAt}>{fmtDateTime(c.appliedAt)}</time>
              {showResource && <span className="mono change__path">{c.path}</span>}
            </p>
            {c.kind === "edit" && c.correctionStatus && (
              <div className="change__state"><CorrectionStatus status={checking.has(c.id) ? "verifying" : c.correctionStatus} /></div>
            )}
          </div>
          <div className="change__body">
            {c.image && <Thumb url={c.image.url} size={40} />}
            <dl className="change__values">
              <div><dt>Avant</dt><dd><Value v={c.before} /></dd></div>
              <div><dt>Après</dt><dd><Value v={c.after} /></dd></div>
            </dl>
            {!c.afterVerified && (
              <p className="change__unverified">
                <Info size={13} aria-hidden />
                <span>
                  Shopify a accepté la modification, mais la valeur n'a pas pu être relue.{" "}
                  {onReread ? (
                    <button type="button" className="link-btn" onClick={onReread}>Relire l'élément</button>
                  ) : (
                    <Link to={sitePath(site.id, "shopify", c.resourceId)} className="text-link">Relire l'élément</Link>
                  )}
                </span>
              </p>
            )}
          </div>
          <div className="change__action">
            {c.restorable ? (
              <span className="change__restore">
                <Button size="sm" variant="secondary" icon={<Undo2 size={14} aria-hidden />} onClick={() => onRestore(c)} disabled={!!blocked} title={blocked ?? undefined} aria-label={blocked ? `Annuler (indisponible : ${blocked})` : undefined}>
                  Annuler
                </Button>
              </span>
            ) : c.restoredByChangeId ? (
              <span className="change__status">Annulée{byId.get(c.restoredByChangeId) ? ` le ${fmtDateTime(byId.get(c.restoredByChangeId)!.appliedAt)}` : ""}</span>
            ) : (
              <span className="change__status" title="Seule la dernière modification d'un champ peut être annulée.">Remplacée depuis</span>
            )}
          </div>
          {c.kind === "edit" && c.correctionStatus && <Verification site={site} change={c} onChecking={onChecking} />}
        </li>
      ))}
    </ol>
  );
}

const CRITERION_ICON: Record<CheckStatus, typeof CircleCheck> = { pass: CircleCheck, warn: TriangleAlert, fail: CircleMinus };

function Verdict({ status }: { status: CheckStatus }) {
  const Icon = CRITERION_ICON[status];
  return <span className={`verdict verdict--${status}`}><Icon size={13} aria-hidden />{CRITERION_LABEL[status]}</span>;
}

/**
 * Dernière relecture de la page publique pour une correction, et « Vérifier » à la demande.
 * Tout ce qui vient de la page relue (message, texte affiché, adresse) est affiché comme du texte.
 */
function Verification({ site, change: c, onChecking }: { site: SiteSummary; change: ShopifyChange; onChecking: (id: string, on: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const v = c.verification;
  const status = c.correctionStatus;
  // Une seule demande à la fois, même en cas de double appui.
  const sending = useRef(false);
  useEffect(() => setError(null), [c.id, v?.checkedAt]);

  // Seule la dernière modification d'un champ, encore en place, se vérifie ; jamais pendant une relecture.
  // Une traduction n'est pas encore vérifiable : pas de bouton qui ne mènerait à rien.
  const canVerify = c.restorable && !c.locale && status !== "cancelled" && status !== "verifying";
  if (!v && !canVerify && status !== "verifying") return null;

  const verify = async () => {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    onChecking(c.id, true);
    setError(null);
    try {
      await verifyShopifyChange(site.id, c.id);
    } catch (err) {
      setError(toAppError(err));
    } finally {
      sending.current = false;
      setBusy(false);
      onChecking(c.id, false);
    }
  };

  const href = safeHttpsUrl(v?.url ?? null);
  return (
    <div className="verif">
      {status === "verifying" && !busy ? (
        <p className="verif__msg"><Info size={14} aria-hidden /><span>La page publique va être relue pour vérifier que la correction y apparaît. Le résultat s'affichera ici.</span></p>
      ) : busy ? (
        <p className="verif__msg" role="status"><Info size={14} aria-hidden /><span>Relecture de la page publique en cours : cela peut prendre une vingtaine de secondes.</span></p>
      ) : v ? (
        <p className="verif__msg">
          {v.outcome === "verified" ? <CircleCheck size={14} aria-hidden /> : v.outcome === "failed" ? <CircleAlert size={14} aria-hidden /> : <Info size={14} aria-hidden />}
          <span>{v.message}</span>
        </p>
      ) : (
        <p className="verif__msg"><Info size={14} aria-hidden /><span>La page publique n'a pas encore été relue depuis cette correction.</span></p>
      )}

      {v && (
        <dl className="verif__facts">
          <dt>Relue le</dt>
          <dd><time dateTime={v.checkedAt}>{fmtDateTime(v.checkedAt)}</time></dd>
          {v.rendered !== null && (
            <>
              <dt>Ce que la page affiche</dt>
              <dd><span className="verif__rendered">{v.rendered}</span></dd>
            </>
          )}
          {v.criterion && (
            <>
              <dt>Critère « {v.criterion.label} »</dt>
              <dd>
                {v.criterion.before ? <Verdict status={v.criterion.before} /> : <span>Page absente de l'analyse</span>}
                <ArrowRight size={12} className="verif__arrow" aria-label="puis" />
                <Verdict status={v.criterion.after} />
              </dd>
            </>
          )}
          {v.pageScore && (
            <>
              <dt>Note de la page</dt>
              <dd className="tnum">
                {v.pageScore.before !== null ? <span>{v.pageScore.before} sur 100</span> : <span>Pas de note dans l'analyse</span>}
                <ArrowRight size={12} className="verif__arrow" aria-label="puis" />
                <span>{v.pageScore.after} sur 100 sur la page relue</span>
              </dd>
            </>
          )}
        </dl>
      )}

      {(href || canVerify) && (
        <div className="verif__foot">
          {canVerify && (
            <Button size="sm" variant="secondary" icon={<RefreshCw size={14} aria-hidden />} loading={busy} onClick={() => void verify()}>
              {v ? "Vérifier à nouveau" : "Vérifier"}
            </Button>
          )}
          {href && (
            <a className="text-link verif__link" href={href} target="_blank" rel="noopener noreferrer">
              Voir la page relue <ExternalLink size={12} aria-hidden /><span className="sr-only"> (nouvel onglet)</span>
            </a>
          )}
        </div>
      )}
      {error && (
        <p className="verif__error" role="alert"><CircleAlert size={13} aria-hidden /><span>{error.message}{error.action ? ` ${error.action}` : ""}</span></p>
      )}
    </div>
  );
}
