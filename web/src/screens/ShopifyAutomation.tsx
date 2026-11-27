/**
 * Onglet « Automatisation » de la boutique : ce que l'IA a le droit de préparer ou d'appliquer seule
 * (AutomationState). Les quatre verrous du mode automatique sont affichés d'après leur état réel ; le plafond
 * de jetons est présenté à part : il limite la préparation, pas l'écriture. Passer en « auto », ou élargir une
 * règle déjà en « auto », demande une confirmation qui montre les limites choisies et ce qui s'élargit.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CircleAlert, CircleCheck, CircleMinus, Info, ShieldCheck, Zap } from "lucide-react";
import type { AutomationPolicy, AutomationState, ShopifyField, ShopifyResourceType, SiteSummary } from "../lib/types";
import { useAutomation } from "../lib/queries";
import { toAppError, type AppError } from "../lib/api";
import { CONTENT_FILTER_TEXT, FIELD_COUNT, FIELD_LABEL, MODE_TEXT, SCOPE_TEXT, TOKENS_HINT, TOKENS_SCOPE, TYPE_LABEL, TYPE_ORDER, saveAutomation } from "../lib/shopify";
import { fmtInt, fmtWhen, plural } from "../lib/format";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Meter } from "../ui/Meter";
import { ErrorState, useRetryCountdown } from "../ui/States";
import { Skeleton, LoadingLabel } from "../ui/Skeleton";
import { useToast } from "../ui/Toast";

const FIELDS: ShopifyField[] = ["seo_title", "seo_description", "image_alt"];
const MODES: AutomationPolicy["mode"][] = ["off", "propose", "auto"];
const SCOPES: AutomationPolicy["scope"][] = ["empty_only", "failing", "any"];
type Caps = "maxChangesPerRun" | "maxAutoChangesPerDay" | "aiTokensPerDay";
const CAPS: { key: Caps; label: string; unit: string; hint: string }[] = [
  { key: "maxChangesPerRun", label: "Lignes au plus par lot préparé par l'IA", unit: "lignes", hint: "Un lot plus court se relit mieux." },
  { key: "maxAutoChangesPerDay", label: "Écritures automatiques au plus par jour", unit: "écritures", hint: "En mode automatique ; au-delà, le reste du lot attend votre validation." },
  { key: "aiTokensPerDay", label: "Jetons d'IA au plus par jour, pour préparer", unit: "jetons", hint: `${TOKENS_SCOPE} ${TOKENS_HINT}` },
];

const SCOPE_RANK: Record<AutomationPolicy["scope"], number> = { empty_only: 0, failing: 1, any: 2 };

/**
 * Ce qu'une règle déjà en « auto » gagne en largeur : champs, types, portée, traductions, plafonds d'écriture.
 * Le plafond de jetons n'y figure pas : il limite la préparation, pas ce qui est écrit.
 */
function widenings(from: AutomationPolicy, to: AutomationPolicy): string[] {
  const out: string[] = [];
  const fields = to.fields.filter((f) => !from.fields.includes(f));
  if (fields.length) out.push(`Champs ajoutés : ${fields.map((f) => FIELD_COUNT[f][0]).join(", ")}`);
  const types = TYPE_ORDER.filter((t) => to.resourceTypes.includes(t) && !from.resourceTypes.includes(t));
  if (types.length) out.push(`Éléments ajoutés : ${types.map((t) => TYPE_LABEL[t].many.toLowerCase()).join(", ")}`);
  if (SCOPE_RANK[to.scope] > SCOPE_RANK[from.scope]) out.push(`Remplace désormais : ${SCOPE_TEXT[to.scope].label.toLowerCase()} (avant : ${SCOPE_TEXT[from.scope].label.toLowerCase()})`);
  if (to.translations && !from.translations) out.push("Traductions désormais autorisées");
  if (to.maxAutoChangesPerDay > from.maxAutoChangesPerDay) out.push(`Écritures automatiques par jour : ${fmtInt(to.maxAutoChangesPerDay)} au lieu de ${fmtInt(from.maxAutoChangesPerDay)}`);
  if (to.maxChangesPerRun > from.maxChangesPerRun) out.push(`Lignes par lot : ${fmtInt(to.maxChangesPerRun)} au lieu de ${fmtInt(from.maxChangesPerRun)}`);
  return out;
}

const same = (a: AutomationPolicy, b: AutomationPolicy) => JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
const normalize = (p: AutomationPolicy) => ({ ...p, fields: [...p.fields].sort(), resourceTypes: [...p.resourceTypes].sort() });

function toggle<T>(list: T[], v: T, on: boolean): T[] {
  return on ? (list.includes(v) ? list : [...list, v]) : list.filter((x) => x !== v);
}

/** Un groupe de réglages : le titre n'est annoncé qu'une fois, par la légende (le titre visible est décoratif). */
function Group({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <fieldset className="auto-group">
      <legend className="sr-only">{title}</legend>
      <div className="auto-group__text">
        <p className="auto-group__title" aria-hidden>{title}</p>
        {hint && <p className="auto-group__hint">{hint}</p>}
      </div>
      <div className="auto-group__control">{children}</div>
    </fieldset>
  );
}

/**
 * Les quatre verrous, d'après l'état réel ; « auto » n'écrit seul que si tous sont réunis. Le quatrième est
 * vérifié par le serveur ligne par ligne : la règle, le filtre de contenu et le plafond d'écritures du jour.
 * Le plafond de jetons n'en fait pas partie (il limite la préparation, voir Usage).
 */
function Locks({ s, saved }: { s: AutomationState; saved: AutomationPolicy }) {
  const u = s.usage;
  const left = Math.max(0, saved.maxAutoChangesPerDay - u.autoChanges);
  const capOk = left > 0;
  const locks: { ok: boolean; title: string; who: string; detail?: string }[] = [
    { ok: s.writesEnabled, title: "Les modifications de la boutique sont activées sur le serveur", who: "La personne qui gère l'installation" },
    { ok: s.autoAllowed, title: "Le mode automatique est autorisé sur le serveur", who: "La personne qui gère l'installation" },
    { ok: saved.mode === "auto", title: "Le niveau enregistré ici est « L'IA applique seule »", who: "Vous, sur cet écran" },
    {
      ok: capOk,
      title: "Chaque ligne respecte la règle, le filtre de contenu et le plafond d'écritures du jour",
      who: "Vous fixez la règle ; le serveur la vérifie avant chaque écriture",
      detail: saved.maxAutoChangesPerDay === 0
        ? "Plafond réglé sur 0 : aucune écriture automatique."
        : capOk
          ? `${plural(left, "écriture automatique restante", "écritures automatiques restantes")} aujourd'hui.`
          : `Plafond d'écritures du jour atteint, remise à zéro ${fmtWhen(u.resetsAt)}.`,
    },
  ];
  const all = locks.every((l) => l.ok);
  return (
    <section className="auto-locks" aria-labelledby="auto-locks-t">
      <h3 className="auto-aside__title" id="auto-locks-t"><ShieldCheck size={15} aria-hidden /> Écriture sans validation humaine</h3>
      <p className="auto-aside__lead">{all ? "Les quatre conditions sont réunies : les lignes conformes des lots de « Préparer des corrections avec l'IA » sont écrites sans attendre votre validation." : "Les quatre conditions sont nécessaires. Tant qu'il en manque une, rien n'est écrit sans votre validation."}</p>
      <ol className="locks">
        {locks.map((l) => (
          <li key={l.title} className={`lock ${l.ok ? "lock--ok" : "lock--off"}`}>
            {l.ok ? <CircleCheck size={15} aria-hidden className="lock__icon" /> : <CircleMinus size={15} aria-hidden className="lock__icon" />}
            <div>
              <p className="lock__title">{l.title}</p>
              <p className="lock__meta"><span className="lock__state">{l.ok ? "Réuni" : "Pas réuni"}</span> · {l.who}{l.detail ? ` · ${l.detail}` : ""}</p>
            </div>
          </li>
        ))}
      </ol>
      <p className="auto-aside__note"><strong>Filtre de contenu.</strong> {CONTENT_FILTER_TEXT}</p>
      <p className="auto-aside__note">Ce que l'assistant propose dans la conversation attend toujours votre validation, quel que soit le niveau.</p>
    </section>
  );
}

function Usage({ s, policy }: { s: AutomationState; policy: AutomationPolicy }) {
  const u = s.usage;
  const tokensOut = u.aiTokens >= policy.aiTokensPerDay;
  return (
    <section className="auto-usage" aria-labelledby="auto-usage-t">
      <h3 className="auto-aside__title" id="auto-usage-t">Consommation du jour</h3>
      <dl className="usage">
        <div className="usage__row">
          <dt>Écritures automatiques</dt>
          <dd className="tnum">{fmtInt(u.autoChanges)} <span className="subtle">sur {fmtInt(policy.maxAutoChangesPerDay)}</span></dd>
          <Meter value={u.autoChanges} max={Math.max(1, policy.maxAutoChangesPerDay)} tone={u.autoChanges >= policy.maxAutoChangesPerDay ? "warning" : "neutral"} />
        </div>
      </dl>
      <h4 className="auto-usage__sub">Limite de préparation</h4>
      <dl className="usage">
        <div className="usage__row">
          <dt>Jetons d'IA</dt>
          <dd className="tnum">{fmtInt(u.aiTokens)} <span className="subtle">sur {fmtInt(policy.aiTokensPerDay)}</span></dd>
          <Meter value={u.aiTokens} max={Math.max(1, policy.aiTokensPerDay)} tone={tokensOut ? "warning" : "neutral"} />
        </div>
      </dl>
      <p className="auto-aside__note">{tokensOut ? "Atteinte : « Préparer des corrections avec l'IA » attend la remise à zéro. " : ""}{TOKENS_SCOPE}</p>
      <p className="auto-aside__note">Remise à zéro {fmtWhen(u.resetsAt)} (minuit, heure universelle).</p>
    </section>
  );
}

function ConfirmAuto({ open, policy, widen, s, onClose, onConfirm, busy, error, wait }: {
  open: boolean; policy: AutomationPolicy; widen: string[] | null; s: AutomationState; onClose: () => void; onConfirm: () => void; busy: boolean; error: AppError | null; wait: number;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      busy={busy}
      size="lg"
      title={widen ? "Élargir ce que l'IA applique seule ?" : "Laisser l'IA appliquer seule ses corrections ?"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy} data-autofocus>{widen ? "Ne pas élargir" : "Ne pas activer"}</Button>
          <Button variant="primary" icon={<Zap size={15} aria-hidden />} loading={busy} disabled={wait > 0} onClick={onConfirm}>{widen ? "Élargir la règle" : "Activer le mode automatique"}</Button>
        </>
      }
    >
      {widen ? (
        <>
          <p className="confirm__note"><strong>Le mode automatique est déjà choisi : davantage de corrections pourront être écrites dans la boutique en ligne sans votre validation.</strong> Ce qui s'élargit :</p>
          <ul className="auto-widen">{widen.map((w) => <li key={w}>{w}</li>)}</ul>
          <p className="confirm__note">La règle complète, une fois enregistrée :</p>
        </>
      ) : (
        <p className="confirm__note">
          <strong>Les corrections préparées avec « Préparer des corrections avec l'IA » pourront être écrites dans la boutique en ligne sans votre validation</strong>, dans ces limites :
        </p>
      )}
      <dl className="confirm__target auto-recap">
        <div><dt>Champs</dt><dd>{policy.fields.map((f) => FIELD_LABEL[f]).join(", ") || "aucun"}</dd></div>
        <div><dt>Éléments</dt><dd>{TYPE_ORDER.filter((t) => policy.resourceTypes.includes(t)).map((t) => TYPE_LABEL[t].many).join(", ") || "aucun"}</dd></div>
        <div><dt>Remplace</dt><dd>{SCOPE_TEXT[policy.scope].label}</dd></div>
        <div><dt>Traductions</dt><dd>{policy.translations ? "autorisées" : "non"}</dd></div>
        <div><dt>Écritures</dt><dd>{plural(policy.maxAutoChangesPerDay, "écriture automatique", "écritures automatiques")} au plus par jour, {plural(policy.maxChangesPerRun, "ligne", "lignes")} au plus par lot</dd></div>
        <div><dt>Filtre</dt><dd>{CONTENT_FILTER_TEXT}</dd></div>
      </dl>
      <p className="confirm__note">Ce que l'assistant propose dans la conversation attend toujours votre validation. Chaque écriture reste dans l'historique et s'annule, seule ou avec tout son lot ; les lignes écrites ainsi sont signalées « sans validation humaine ».</p>
      <p className="muted small">Le plafond de {fmtInt(policy.aiTokensPerDay)} jetons d'IA par jour limite la préparation des propositions, pas leur écriture.</p>
      {!s.autoAllowed && (
        <p className="auto-warn"><Info size={14} aria-hidden /><span>Le mode automatique n'est pas encore autorisé côté serveur : en attendant, l'IA continuera de préparer des lots que vous validez.</span></p>
      )}
      {error && <ErrorState error={error} inline />}
    </Dialog>
  );
}

export function AutomationPanel({ site }: { site: SiteSummary }) {
  const q = useAutomation(site.id);
  const toast = useToast();
  const s = q.data;
  const [draft, setDraft] = useState<AutomationPolicy | null>(null);
  const [caps, setCaps] = useState<Record<Caps, string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [confirming, setConfirming] = useState(false);
  // Trop d'enregistrements en peu de temps (rate_limited) : le bouton attend la fin du délai.
  const wait = useRetryCountdown(error);

  // La règle enregistrée fait foi tant que rien n'est modifié ici.
  useEffect(() => {
    if (!s) return;
    setDraft((d) => (d === null || (caps === null) ? s.policy : d));
    setCaps((c) => c ?? { maxChangesPerRun: String(s.policy.maxChangesPerRun), maxAutoChangesPerDay: String(s.policy.maxAutoChangesPerDay), aiTokensPerDay: String(s.policy.aiTokensPerDay) });
  }, [s]); // eslint-disable-line react-hooks/exhaustive-deps

  const capErrors = useMemo(() => {
    const out: Partial<Record<Caps, string>> = {};
    if (!s || !caps) return out;
    for (const c of CAPS) {
      const v = caps[c.key].trim();
      const r = s.limits[c.key];
      if (!/^\d+$/.test(v) || Number(v) < r.min || Number(v) > r.max) out[c.key] = `Entre ${fmtInt(r.min)} et ${fmtInt(r.max)}.`;
    }
    return out;
  }, [caps, s]);

  if (!s || !draft || !caps) {
    if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.fetching} />;
    return <><LoadingLabel /><Skeleton h={220} r={8} /><div style={{ height: 16 }} /><Skeleton h={160} r={8} /></>;
  }

  const policy: AutomationPolicy = {
    ...draft,
    maxChangesPerRun: Number(caps.maxChangesPerRun) || 0,
    maxAutoChangesPerDay: Number(caps.maxAutoChangesPerDay) || 0,
    aiTokensPerDay: Number(caps.aiTokensPerDay) || 0,
  };
  const dirty = !same(policy, s.policy);
  const ruleErrors: string[] = [];
  if (policy.mode !== "off" && policy.fields.length === 0) ruleErrors.push("Choisissez au moins un champ.");
  if (policy.mode !== "off" && policy.resourceTypes.length === 0) ruleErrors.push("Choisissez au moins un type d'élément.");
  const invalid = Object.keys(capErrors).length > 0 || ruleErrors.length > 0;
  const set = (patch: Partial<AutomationPolicy>) => setDraft((d) => ({ ...(d ?? s.policy), ...patch }));
  const reset = () => {
    setDraft(s.policy);
    setCaps({ maxChangesPerRun: String(s.policy.maxChangesPerRun), maxAutoChangesPerDay: String(s.policy.maxAutoChangesPerDay), aiTokensPerDay: String(s.policy.aiTokensPerDay) });
    setError(null);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await saveAutomation(site.id, policy);
      setDraft(next.policy);
      setCaps({ maxChangesPerRun: String(next.policy.maxChangesPerRun), maxAutoChangesPerDay: String(next.policy.maxAutoChangesPerDay), aiTokensPerDay: String(next.policy.aiTokensPerDay) });
      setConfirming(false);
      toast.show({ tone: "success", title: "Règle d'automatisation enregistrée", text: MODE_TEXT[next.policy.mode].label + "." });
    } catch (err) {
      setError(toAppError(err));
    } finally {
      setBusy(false);
    }
  };
  // Passer en « auto », ou élargir une règle déjà en « auto », demande la même confirmation.
  const widen = policy.mode === "auto" && s.policy.mode === "auto" ? widenings(s.policy, policy) : [];
  const needsConfirm = policy.mode === "auto" && (s.policy.mode !== "auto" || widen.length > 0);
  const onSave = () => {
    if (invalid) return;
    if (needsConfirm) setConfirming(true);
    else void save();
  };

  return (
    <div className="auto">
      <p className="shop-history__lead">
        Ce que l'IA a le droit de faire dans cette boutique. La règle vaut pour l'assistant comme pour « Préparer des corrections avec l'IA », pas pour les lots que vous composez vous-même. Le serveur la vérifie à chaque ligne : le contenu de la boutique ne peut pas la modifier.
      </p>
      {!s.aiConfigured && (
        <div className="notice notice--info notice--compact" role="note">
          <CircleAlert size={15} className="notice__icon" aria-hidden />
          <div className="notice__body">
            <p className="notice__title">Aucune clé d'IA n'est configurée sur le serveur</p>
            <p className="notice__text">L'IA ne peut rien préparer tant que la personne qui gère l'installation n'a pas ajouté la clé de l'API Claude. Vous pouvez régler la règle dès maintenant.</p>
          </div>
        </div>
      )}

      <div className="auto__layout">
        <div className="auto__form">
          <Group title="Niveau" hint="Du plus prudent au plus autonome.">
            <div className="modes">
              {MODES.map((m) => (
                <label key={m} className={`mode ${draft.mode === m ? "is-on" : ""}`}>
                  <input type="radio" name="auto-mode" value={m} checked={draft.mode === m} onChange={() => set({ mode: m })} />
                  <span className="mode__body">
                    <span className="mode__label">{m === "auto" && <Zap size={14} aria-hidden />}{MODE_TEXT[m].label}</span>
                    <span className="mode__text">{MODE_TEXT[m].text}</span>
                  </span>
                </label>
              ))}
            </div>
            {draft.mode === "auto" && !s.autoAllowed && (
              <p className="auto-warn" role="note">
                <Info size={14} aria-hidden />
                <span><strong>Ce niveau se comportera comme « L'IA prépare, vous validez »</strong> tant que la personne qui gère l'installation ne l'a pas autorisé côté serveur. Rien ne sera écrit sans vous d'ici là.</span>
              </p>
            )}
            {draft.mode === "auto" && s.autoAllowed && !s.writesEnabled && (
              <p className="auto-warn" role="note"><Info size={14} aria-hidden /><span>Les modifications de la boutique sont désactivées sur le serveur : rien ne sera écrit, même automatiquement, tant qu'elles ne sont pas activées.</span></p>
            )}
          </Group>

          <Group title="Champs autorisés" hint="Ce que l'IA a le droit de proposer.">
            <div className="checks">
              {FIELDS.map((f) => (
                <label key={f} className="checkrow">
                  <input type="checkbox" className="check" checked={draft.fields.includes(f)} onChange={(e) => set({ fields: toggle(draft.fields, f, e.target.checked) })} />
                  <span>{FIELD_LABEL[f]}{f === "image_alt" && <span className="subtle"> · images des produits seulement</span>}</span>
                </label>
              ))}
            </div>
          </Group>

          <Group title="Types d'élément">
            <div className="checks checks--row">
              {TYPE_ORDER.map((t: ShopifyResourceType) => (
                <label key={t} className="checkrow">
                  <input type="checkbox" className="check" checked={draft.resourceTypes.includes(t)} onChange={(e) => set({ resourceTypes: toggle(draft.resourceTypes, t, e.target.checked) })} />
                  <span>{TYPE_LABEL[t].many}</span>
                </label>
              ))}
            </div>
          </Group>
          {ruleErrors.length > 0 && <p className="field__error auto-ruleerr" role="alert"><CircleAlert size={14} aria-hidden /><span>{ruleErrors.join(" ")}</span></p>}

          <Group title="Ce que l'IA a le droit de remplacer">
            <div className="modes modes--compact">
              {SCOPES.map((sc) => (
                <label key={sc} className={`mode ${draft.scope === sc ? "is-on" : ""}`}>
                  <input type="radio" name="auto-scope" value={sc} checked={draft.scope === sc} onChange={() => set({ scope: sc })} />
                  <span className="mode__body">
                    <span className="mode__label">{SCOPE_TEXT[sc].label}</span>
                    <span className="mode__text">{SCOPE_TEXT[sc].example}</span>
                  </span>
                </label>
              ))}
            </div>
          </Group>

          <Group title="Traductions" hint="Les versions des autres langues publiées par la boutique.">
            <label className="checkrow">
              <input type="checkbox" className="check" checked={draft.translations} onChange={(e) => set({ translations: e.target.checked })} />
              <span>L'IA peut proposer des traductions des titres et descriptions</span>
            </label>
          </Group>

          <Group title="Plafonds" hint="Bornés par le serveur.">
            <div className="caps">
              {CAPS.map((c) => {
                const r = s.limits[c.key];
                const err = capErrors[c.key];
                return (
                  <div key={c.key} className="cap">
                    <label className="field__label" htmlFor={`cap-${c.key}`}>{c.label}</label>
                    <div className={`field__control cap__control ${err ? "is-invalid" : ""}`}>
                      <input
                        id={`cap-${c.key}`}
                        className="field__input"
                        type="number"
                        inputMode="numeric"
                        min={r.min}
                        max={r.max}
                        value={caps[c.key]}
                        onChange={(e) => setCaps((x) => ({ ...(x ?? caps), [c.key]: e.target.value }))}
                        aria-invalid={err ? true : undefined}
                        aria-describedby={`cap-${c.key}-h`}
                      />
                      <span className="field__affix field__affix--suf">{c.unit}</span>
                    </div>
                    <p className={err ? "field__error" : "field__hint"} id={`cap-${c.key}-h`}>{err ?? `${c.hint} Entre ${fmtInt(r.min)} et ${fmtInt(r.max)}.`}</p>
                  </div>
                );
              })}
            </div>
          </Group>
        </div>

        <aside className="auto__aside">
          <Locks s={s} saved={s.policy} />
          <Usage s={s} policy={s.policy} />
        </aside>
      </div>

      {error && !confirming && <ErrorState error={error} inline />}
      {dirty && (
        <div className="actionbar">
          <p className="actionbar__text"><strong>Modifications non enregistrées</strong>{needsConfirm ? <span className="muted"> · {s.policy.mode === "auto" ? "l'élargissement de la règle sera confirmé" : "le passage en automatique sera confirmé"}</span> : null}</p>
          <div className="actionbar__actions">
            <Button size="sm" variant="ghost" onClick={reset} disabled={busy}>Annuler les changements</Button>
            <Button variant="primary" loading={busy && !confirming} disabled={invalid || wait > 0} onClick={onSave}>Enregistrer</Button>
          </div>
        </div>
      )}
      <ConfirmAuto open={confirming} policy={policy} widen={s.policy.mode === "auto" ? widen : null} s={s} onClose={() => { setConfirming(false); setError(null); }} onConfirm={() => void save()} wait={wait} busy={busy} error={confirming ? error : null} />
    </div>
  );
}
