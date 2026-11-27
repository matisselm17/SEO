import { useEffect, useState, type FormEvent } from "react";
import { BarChart3, Bot, CircleCheck, CircleMinus, ShoppingBag, Trash2, Users } from "lucide-react";
import type { Settings, SiteSummary, SitesResponse, UpdateSettingsRequest } from "../lib/types";
import { keys, useAutomation, useSettings } from "../lib/queries";
import { autoActive } from "../lib/shopify";
import { sendJSON, toAppError } from "../lib/api";
import { removeQueries, setQueryData } from "../lib/cache";
import { navigate, shopPath, sitePath } from "../lib/router";
import { fmtDate, fmtDateTime, fmtInt } from "../lib/format";
import { PageHeader } from "../ui/Section";
import { Button, Link } from "../ui/Button";
import { Tag } from "../ui/Badge";
import { TextField } from "../ui/Field";
import { ConfirmButton } from "../ui/ConfirmButton";
import { Skeleton, LoadingLabel } from "../ui/Skeleton";
import { useToast } from "../ui/Toast";
import { QueryError, RelaunchButton } from "./common";

function Row({ title, hint, children }: { title: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="setting">
      <div className="setting__text">
        <p className="setting__title">{title}</p>
        {hint && <div className="setting__hint">{hint}</div>}
      </div>
      <div className="setting__control">{children}</div>
    </div>
  );
}

function Status({ on, label }: { on: boolean; label: string }) {
  return (
    <span className={`status ${on ? "status--on" : "status--off"}`}>
      {on ? <CircleCheck size={15} aria-hidden /> : <CircleMinus size={15} aria-hidden />}
      {label}
    </span>
  );
}

function MaxPagesForm({ s }: { s: Settings }) {
  const toast = useToast();
  const [value, setValue] = useState(String(s.maxPagesDefault));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setValue(String(s.maxPagesDefault)), [s.maxPagesDefault]);
  const dirty = value !== String(s.maxPagesDefault);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const n = Number(value);
    const { min, max } = s.maxPagesLimits;
    if (!/^\d+$/.test(value.trim()) || n < min || n > max) {
      setError(`Saisissez un nombre entier entre ${fmtInt(min)} et ${fmtInt(max)}.`);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const next = await sendJSON<Settings>("PATCH", keys.settings, { maxPagesDefault: n } satisfies UpdateSettingsRequest);
      setQueryData(keys.settings, next);
      toast.show({ tone: "success", title: "Plafond enregistré", text: `Les prochaines analyses liront jusqu'à ${fmtInt(next.maxPagesDefault)} pages.` });
    } catch (err) {
      const ae = toAppError(err);
      setError([ae.message, ae.action].filter(Boolean).join(" "));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="setting__form" noValidate>
      <TextField
        label="Plafond de pages"
        hideLabel
        type="number"
        inputMode="numeric"
        min={s.maxPagesLimits.min}
        max={s.maxPagesLimits.max}
        value={value}
        onChange={(e) => { setValue(e.target.value); setError(null); }}
        suffix="pages"
        error={error}
        className="setting__number"
      />
      <Button type="submit" variant="primary" disabled={!dirty} loading={busy}>Enregistrer</Button>
    </form>
  );
}

export function SettingsScreen({ site }: { site: SiteSummary }) {
  const q = useSettings();
  const shopWritable = !!q.data?.integrations.shopify.configured && !!q.data?.integrations.shopify.writesEnabled;
  // Mode automatique réellement en vigueur : la phrase sur les corrections ne dit alors plus « toujours après confirmation ».
  const auto = autoActive(useAutomation(site.id, shopWritable).data);
  const toast = useToast();
  const [deleting, setDeleting] = useState(false);
  const s = q.data;

  const remove = async () => {
    setDeleting(true);
    try {
      await sendJSON("DELETE", keys.site(site.id));
      setQueryData<SitesResponse>(keys.sites, (prev) => (prev ? { sites: prev.sites.filter((x) => x.id !== site.id) } : prev));
      removeQueries(`/sites/${encodeURIComponent(site.id)}`);
      toast.show({ tone: "neutral", title: "Site supprimé", text: `${site.host} et toutes ses données ont été supprimés.` });
      navigate("/", { replace: true });
    } catch (err) {
      const e = toAppError(err);
      toast.show({ tone: "error", title: e.message, text: e.action });
      setDeleting(false);
    }
  };

  return (
    <>
      <PageHeader title="Paramètres" description="Réglages de l'analyse, état des services connectés, et gestion de ce site." />
      <QueryError q={q} />

      <section className="settings-group" aria-labelledby="set-analysis">
        <h2 id="set-analysis" className="settings-group__title">Analyse</h2>
        <Row
          title="Plafond de pages par analyse"
          hint={s ? <>Nombre de pages ouvertes en entier à chaque analyse, entre {fmtInt(s.maxPagesLimits.min)} et {fmtInt(s.maxPagesLimits.max)} au plus. S'applique aux prochaines analyses de tous les sites. Quand le site compte plus de pages, elles sont choisies type par type pour que chacun soit représenté, et les autres produits d'une boutique Shopify sont lus dans son catalogue (hors note). Un plafond plus bas donne une analyse plus rapide mais une note fondée sur moins de pages.</> : "Nombre de pages ouvertes en entier à chaque analyse."}
        >
          {s ? <MaxPagesForm s={s} /> : <Skeleton w={260} h={36} r={6} />}
        </Row>
      </section>

      <section className="settings-group" aria-labelledby="set-int">
        <h2 id="set-int" className="settings-group__title">Services connectés</h2>
        <p className="settings-group__desc">Ils se configurent côté serveur. Les clés d'accès restent sur le serveur et ne sont jamais affichées ici.</p>
        {!s && <><LoadingLabel /><Skeleton h={64} /><div style={{ height: 8 }} /><Skeleton h={64} /><div style={{ height: 8 }} /><Skeleton h={64} /></>}
        {s && (
          <>
            <Row
              title="Assistant IA"
              hint={s.integrations.chat.configured ? <>Modèle utilisé : <span className="mono">{s.integrations.chat.model ?? "par défaut"}</span>.</> : <>Pour l'activer, ajoutez la variable <span className="mono">ANTHROPIC_API_KEY</span> dans l'environnement du serveur, puis redémarrez-le.</>}
            >
              <span className="setting__icon" aria-hidden><Bot size={16} /></span>
              <Status on={s.integrations.chat.configured} label={s.integrations.chat.configured ? "Activé" : "Non configuré"} />
            </Row>
            <Row
              title="Relevé des concurrents"
              hint={s.integrations.competitors.configured ? "Les recherches Google sont relevées à la demande, depuis la section Concurrents." : <>Pour l'activer, ajoutez la variable <span className="mono">FIRECRAWL_API_KEY</span> dans l'environnement du serveur, puis redémarrez-le.</>}
            >
              <span className="setting__icon" aria-hidden><Users size={16} /></span>
              <Status on={s.integrations.competitors.configured} label={s.integrations.competitors.configured ? "Activé" : "Non configuré"} />
            </Row>
            <Row
              title="Boutique Shopify"
              hint={
                !s.integrations.shopify.configured ? (
                  <>Pour l'activer, ajoutez les variables <span className="mono">SHOPIFY_STORE_DOMAIN</span>, <span className="mono">SHOPIFY_CLIENT_ID</span> et <span className="mono">SHOPIFY_CLIENT_SECRET</span> dans l'environnement du serveur, puis redémarrez-le.</>
                ) : s.integrations.shopify.writesEnabled ? (
                  auto ? (
                  <>Les titres, descriptions et textes alternatifs se corrigent depuis la section <Link to={sitePath(site.id, "shopify")} className="text-link">Boutique Shopify</Link>. Vos corrections passent par une confirmation ; <strong>des écritures automatiques sont actives</strong> : les lots de « Préparer des corrections avec l'IA » peuvent être écrits sans votre validation, dans les limites de la <Link to={shopPath(site.id, "automation")} className="text-link">règle d'automatisation</Link>.</>
                ) : (
                  <>Les titres, descriptions et textes alternatifs se corrigent depuis la section <Link to={sitePath(site.id, "shopify")} className="text-link">Boutique Shopify</Link>, une valeur ou un lot à la fois, toujours après confirmation.</>
                )
                ) : (
                  <>Lecture seule : la boutique se consulte depuis la section <Link to={sitePath(site.id, "shopify")} className="text-link">Boutique Shopify</Link>, sans rien y modifier. Pour autoriser les modifications, ajoutez <span className="mono">SHOPIFY_WRITES_ENABLED=1</span> dans l'environnement du serveur, puis redémarrez-le.</>
                )
              }
            >
              <span className="setting__icon" aria-hidden><ShoppingBag size={16} /></span>
              {s.integrations.shopify.configured && <Tag>{!s.integrations.shopify.writesEnabled ? "Lecture seule" : auto ? "Écritures automatiques actives" : "Modifications activées"}</Tag>}
              <Status on={s.integrations.shopify.configured} label={s.integrations.shopify.configured ? "Configurée" : "Non configurée"} />
            </Row>
            <Row
              title="Lecture directe de la Search Console"
              hint={
                s.integrations.searchConsole.configured ? (
                  <>Un compte de service Google est présent sur le serveur : vos clics et vos recherches se lisent directement chez Google, en lecture seule, depuis la section <Link to={sitePath(site.id, "traffic")} className="text-link">Mots-clés et trafic organique</Link>. Le dépôt de l'export reste possible.</>
                ) : (
                  <>Facultatif : sans lui, déposez l'export de la Search Console. Pour lire directement chez Google, placez le fichier du compte de service sur le serveur (<span className="mono">GOOGLE_SERVICE_ACCOUNT_FILE</span>), puis ajoutez son adresse comme utilisateur de votre propriété Search Console.</>
                )
              }
            >
              <span className="setting__icon" aria-hidden><BarChart3 size={16} /></span>
              <Status on={s.integrations.searchConsole.configured} label={s.integrations.searchConsole.configured ? "Compte présent" : "Non configurée"} />
            </Row>
          </>
        )}
      </section>

      <section className="settings-group" aria-labelledby="set-site">
        <h2 id="set-site" className="settings-group__title">Ce site</h2>
        <dl className="facts settings-facts">
          <div><dt>Adresse</dt><dd className="mono facts__mono">{site.url}</dd></div>
          <div><dt>Suivi depuis le</dt><dd>{fmtDate(site.createdAt)}</dd></div>
          <div><dt>Dernière analyse</dt><dd>{site.audit ? (site.audit.finishedAt ? `le ${fmtDateTime(site.audit.finishedAt)}` : "en cours") : "aucune"}</dd></div>
          <div><dt>Search Console</dt><dd>{site.searchConsole.available && site.searchConsole.importedAt ? `données importées le ${fmtDateTime(site.searchConsole.importedAt)}` : "aucune donnée importée"}</dd></div>
        </dl>
        <div className="settings-actions"><RelaunchButton site={site} /></div>
      </section>

      <section className="settings-group settings-group--danger" aria-labelledby="set-danger">
        <h2 id="set-danger" className="settings-group__title">Supprimer ce site</h2>
        <Row title={`Supprimer ${site.host}`} hint="Les analyses, les pages notées, l'export Search Console et la conversation avec l'assistant sont supprimés définitivement.">
          <ConfirmButton icon={<Trash2 size={15} aria-hidden />} confirmLabel="Confirmer la suppression" onConfirm={remove} loading={deleting}>Supprimer le site</ConfirmButton>
        </Row>
      </section>

      {s && <p className="muted small settings-version">Chat SEO, version {s.version}</p>}
    </>
  );
}
