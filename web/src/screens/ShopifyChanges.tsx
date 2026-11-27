/**
 * Boutique Shopify : confirmation d'une écriture ou d'une annulation, et historique des modifications.
 * Une seule valeur par confirmation ; l'avant et l'après sont toujours montrés.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowRight, Image as ImageIcon, ImageOff, Info, RotateCcw, TriangleAlert, Undo2 } from "lucide-react";
import { DEMO_ENABLED } from "../lib/transport";
import type { ShopifyChange, ShopifyChangeRequest, ShopifyChangeResponse, ShopifyResourceType, SiteSummary } from "../lib/types";
import { toAppError, type AppError } from "../lib/api";
import { FIELD_LABEL, TYPE_LABEL, applyShopifyChange, emptyMeaning, fieldInline, localeLabel, restoreShopifyChange, safeImageUrl } from "../lib/shopify";
import { startAudit } from "../lib/actions";
import { invalidateShopify } from "../lib/live";
import { fmtDateTime } from "../lib/format";
import { Dialog } from "../ui/Dialog";
import { Button, Link } from "../ui/Button";
import { ErrorState, useRetryCountdown } from "../ui/States";
import { Tag } from "../ui/Badge";
import { useToast } from "../ui/Toast";
import { sitePath } from "../lib/router";

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

/** Une valeur affichée telle quelle (texte brut), ou « Vide ». */
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
        toast.show({
          tone: "success",
          title: isRestore ? `Valeur d'avant remise dans Shopify` : `${FIELD_LABEL[field]} modifié dans Shopify`,
          text: "La note de la page ne changera qu'à la prochaine analyse du site.",
          action: { label: "Relancer l'analyse", onClick: () => void startAudit(site.id, undefined, toast) },
        });
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
            {/* Focus initial sur « Ne rien modifier » : Entrée n'écrit jamais dans la boutique par réflexe. */}
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

/** Historique des modifications : quoi, où, avant, après, quand ; « Annuler » sur la dernière modification d'un champ. */
export function ChangeList({ site, changes, onRestore, showResource = true, empty, blocked, onReread }: {
  site: SiteSummary;
  changes: ShopifyChange[];
  onRestore: (c: ShopifyChange) => void;
  /** Relire l'élément (modification acceptée mais non relue). Sans elle, le lien ouvre la fiche de l'élément. */
  onReread?: () => void;
  showResource?: boolean;
  empty?: ReactNode;
  /** Lecture seule : « Annuler » reste visible, désactivé, avec cette raison. */
  blocked?: string | null;
}) {
  if (changes.length === 0) return <>{empty ?? null}</>;
  const byId = new Map(changes.map((c) => [c.id, c]));
  return (
    <ol className="changes">
      {changes.map((c) => (
        <li key={c.id} className="change">
          <div className="change__head">
            <p className="change__what">
              {c.kind === "restore" ? <Undo2 size={14} aria-hidden className="change__kind-icon" /> : null}
              <span className="change__field">{FIELD_LABEL[c.field]}</span>
              {c.locale && <Tag>{localeLabel(c.locale)}</Tag>}
              {c.kind === "restore" && <Tag>Annulation</Tag>}
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
        </li>
      ))}
    </ol>
  );
}
