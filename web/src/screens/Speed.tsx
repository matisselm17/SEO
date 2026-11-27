/**
 * Vitesse des pages, mesurée par Google (PageSpeed Insights) à la demande, par le serveur.
 * Deux natures de chiffres, toujours séparées : la mesure de Google en conditions simulées (laboratoire)
 * et le vécu des vrais visiteurs sur 28 jours (terrain). Les verdicts sont ceux de Google.
 * La note de vitesse n'entre pas dans la note SEO du site.
 */
import { useId, useState } from "react";
import { ChevronDown, CircleCheck, CircleSlash, Gauge, LoaderCircle, Monitor, OctagonAlert, Smartphone, Square, TriangleAlert } from "lucide-react";
import type { PageSpeedState, SiteSummary, SpeedMeasure, SpeedMetric, SpeedPage, SpeedRating } from "../lib/types";
import { keys, usePageSpeed, useSettings } from "../lib/queries";
import { sendJSON, toAppError, type AppError } from "../lib/api";
import { invalidate, setQueryData } from "../lib/cache";
import { sitePath } from "../lib/router";
import { PAGE_TYPE_LABEL } from "../lib/pagetype";
import { fmtDateTime, fmtDec2, fmtInt, fmtMs, plural } from "../lib/format";
import { Section } from "../ui/Section";
import { Button, Link } from "../ui/Button";
import { Tag } from "../ui/Badge";
import { Meter } from "../ui/Meter";
import { Tabs } from "../ui/Tabs";
import { EmptyState, ErrorState, fmtWait, useRetryCountdown } from "../ui/States";
import { SkeletonRows } from "../ui/Skeleton";
import { useToast } from "../ui/Toast";

type Device = "mobile" | "desktop";
const DEVICE_LABEL: Record<Device, string> = { mobile: "Téléphone", desktop: "Ordinateur" };
type Failure = PageSpeedState["failures"][number];

/** Échecs de la dernière demande, rangés par chemin de page. */
function failuresByPath(st: PageSpeedState | undefined): Map<string, Failure[]> {
  const map = new Map<string, Failure[]>();
  for (const f of st?.failures ?? []) map.set(f.path, [...(map.get(f.path) ?? []), f]);
  return map;
}
const failureFor = (list: Failure[] | undefined, device: Device) => list?.find((f) => f.device === device) ?? null;

/** Appareils en toutes lettres : « téléphone », « ordinateur », « téléphone et ordinateur ». */
function devicesText(list: Failure[]): string {
  const has = (d: Device) => list.some((f) => f.device === d);
  return has("mobile") && has("desktop") ? "téléphone et ordinateur" : has("mobile") ? "téléphone" : "ordinateur";
}

/** Échecs d'une même page regroupés quand Google a donné la même raison pour les deux appareils. */
function groupByMessage(list: Failure[]): Failure[][] {
  const groups = new Map<string, Failure[]>();
  for (const f of list) groups.set(f.message, [...(groups.get(f.message) ?? []), f]);
  return [...groups.values()];
}

/** À la place d'une note : la mesure n'a pas abouti. Une icône et un mot, jamais la couleur seule. */
function FailedMark({ f }: { f: Failure }) {
  return (
    <span className="speed-fail" title={f.message}>
      <CircleSlash size={13} strokeWidth={2.25} aria-hidden />
      <span>Échec</span>
    </span>
  );
}

/** Sur l'onglet d'un appareil : sa dernière mesure a échoué. */
function FailTabMark() {
  return (
    <span className="speed-tab__fail" title="La dernière mesure a échoué">
      <CircleSlash size={13} strokeWidth={2.25} aria-hidden />
      <span className="sr-only"> (dernière mesure échouée)</span>
    </span>
  );
}

/** Message d'échec d'un appareil, là où son résultat était attendu. */
function FailureNote({ f, stale }: { f: Failure | Failure[]; stale?: string | null }) {
  const list = Array.isArray(f) ? f : [f];
  return (
    <p className="speed-failnote small" role="note">
      <TriangleAlert size={14} strokeWidth={2.25} aria-hidden />
      <span>
        <strong>La dernière mesure sur {devicesText(list)} n'a pas abouti.</strong> {list[0].message}
        {stale && <span className="muted"> Le résultat affiché ci-dessous date du {stale}.</span>}
      </span>
    </p>
  );
}

const RATING = {
  good: { label: "Bon", Icon: CircleCheck, tone: "good" },
  average: { label: "À améliorer", Icon: TriangleAlert, tone: "warning" },
  poor: { label: "Lent", Icon: OctagonAlert, tone: "critical" },
} as const;

/** Verdict de Google : une icône et un mot, jamais la couleur seule. */
export function SpeedVerdict({ rating }: { rating: SpeedRating }) {
  const r = RATING[rating];
  return (
    <span className={`badge badge--${r.tone}`}>
      <r.Icon size={13} strokeWidth={2.25} aria-hidden />
      <span>{r.label}</span>
    </span>
  );
}

/** Tranches de la note de performance telles que PageSpeed Insights les présente : 90 et plus, 50 à 89, moins de 50. */
function scoreRating(score: number): SpeedRating {
  return score >= 90 ? "good" : score >= 50 ? "average" : "poor";
}
const SCORE_WORD: Record<SpeedRating, string> = { good: "rapide", average: "moyenne", poor: "lente" };

/** Note de vitesse de 0 à 100 : le chiffre, une icône, et la tranche en toutes lettres pour les lecteurs d'écran. */
export function SpeedScore({ score, size = "md" }: { score: number; size?: "md" | "lg" }) {
  const rating = scoreRating(score);
  const r = RATING[rating];
  return (
    <span className={`speed-score speed-score--${r.tone} speed-score--${size}`} aria-label={`${score} sur 100, ${SCORE_WORD[rating]}`} title={`Note de vitesse : ${score} sur 100`}>
      <r.Icon size={size === "lg" ? 16 : 13} strokeWidth={2.25} aria-hidden />
      <span className="tnum">{score}</span>
    </span>
  );
}

type LabKey = keyof SpeedMeasure["lab"];
type FieldKey = "lcp" | "inp" | "cls";
const METRIC: Record<LabKey | FieldKey, { label: string; abbr: string; help: string }> = {
  lcp: { label: "Affichage du contenu principal", abbr: "LCP", help: "Temps avant que le plus grand élément visible (photo, titre) apparaisse." },
  fcp: { label: "Premier affichage", abbr: "FCP", help: "Temps avant que quelque chose apparaisse à l'écran." },
  tbt: { label: "Temps de blocage", abbr: "TBT", help: "Pendant le chargement, durée où la page ne réagit pas aux clics." },
  cls: { label: "Stabilité de la mise en page", abbr: "CLS", help: "Ce qui bouge pendant le chargement. Plus c'est bas, mieux c'est ; sans unité." },
  inp: { label: "Réactivité", abbr: "INP", help: "Délai entre un clic ou une touche et la réaction de la page." },
};
const metricValue = (k: LabKey | FieldKey, m: SpeedMetric) => (k === "cls" ? fmtDec2(m.value) : fmtMs(m.value));

function MetricRow({ k, m }: { k: LabKey | FieldKey; m: SpeedMetric | null }) {
  const d = METRIC[k];
  return (
    <li className="speed-metric">
      <div className="speed-metric__text">
        <p className="speed-metric__label">{d.label} <abbr className="speed-metric__abbr" title={d.label}>{d.abbr}</abbr></p>
        <p className="speed-metric__help">{d.help}</p>
      </div>
      {m ? (
        <div className="speed-metric__value">
          <span className="tnum speed-metric__num">{metricValue(k, m)}</span>
          <SpeedVerdict rating={m.rating} />
        </div>
      ) : (
        <p className="speed-metric__none small subtle">Pas assez de données</p>
      )}
    </li>
  );
}

/** Le détail d'une mesure (un appareil) : laboratoire, terrain, améliorations proposées. */
function MeasureDetail({ m, device }: { m: SpeedMeasure; device: Device }) {
  return (
    <div className="speed-detail">
      <div className="speed-detail__score">
        <SpeedScore score={m.score} size="lg" />
        <p className="small">
          <strong>Note de vitesse sur {DEVICE_LABEL[device].toLowerCase()}</strong>, sur 100
          <span className="muted"> · mesurée le {fmtDateTime(m.measuredAt)}</span>
        </p>
      </div>

      <div className="speed-groups">
        <section className="speed-group" aria-label="Mesure de Google en conditions simulées">
          <h4 className="speed-group__title">Mesure de Google en conditions simulées</h4>
          <p className="speed-group__desc">Un chargement simulé par Google, reproductible : utile pour repérer et corriger.</p>
          <ul className="speed-metrics">
            <MetricRow k="lcp" m={m.lab.lcp} />
            <MetricRow k="cls" m={m.lab.cls} />
            <MetricRow k="tbt" m={m.lab.tbt} />
            <MetricRow k="fcp" m={m.lab.fcp} />
          </ul>
        </section>
        <section className="speed-group speed-group--field" aria-label="Vécu par vos visiteurs sur 28 jours">
          <h4 className="speed-group__title">Vécu par vos visiteurs sur 28 jours</h4>
          {m.field ? (
            <>
              <p className="speed-group__desc">
                Ce qu'ont vécu les vrais visiteurs qui utilisent Chrome.
                {m.field.scope === "site" && <strong className="speed-group__scope"> Ces chiffres portent sur tout le site : Google n'a pas assez de visites sur cette page seule.</strong>}
              </p>
              <ul className="speed-metrics">
                <MetricRow k="lcp" m={m.field.lcp} />
                <MetricRow k="inp" m={m.field.inp} />
                <MetricRow k="cls" m={m.field.cls} />
              </ul>
            </>
          ) : (
            <p className="speed-group__empty">Google n'a pas assez de visites sur cette page pour mesurer le vécu réel. Seule la mesure simulée est disponible.</p>
          )}
        </section>
      </div>

      {m.opportunities.length > 0 && (
        <section className="speed-opps" aria-label="Améliorations proposées par Google">
          <h4 className="speed-group__title">Ce que Google propose d'améliorer</h4>
          <ul className="speed-opps__list">
            {m.opportunities.map((o, i) => (
              <li key={i} className="speed-opp">
                <div className="speed-opp__text">
                  <p className="speed-opp__title">{o.title}</p>
                  {o.detail && <p className="speed-opp__detail">{o.detail}</p>}
                </div>
                {o.savingsMs !== null && o.savingsMs > 0 && <span className="speed-opp__gain small tnum">Gain estimé par Google : {fmtMs(o.savingsMs)}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** Téléphone et ordinateur d'une page, en onglets. */
export function SpeedDetail({ mobile, desktop, failures }: { mobile: SpeedMeasure | null; desktop: SpeedMeasure | null; failures?: Failure[] }) {
  const [device, setDevice] = useState<Device>(mobile || !desktop ? "mobile" : "desktop");
  const m = device === "mobile" ? mobile : desktop;
  const failed = failureFor(failures, device);
  return (
    <div className="speed-device">
      <Tabs<Device>
        label="Appareil"
        value={device}
        onChange={setDevice}
        items={[
          { id: "mobile", label: <span className="speed-tab"><Smartphone size={14} aria-hidden /> Téléphone{failureFor(failures, "mobile") && <FailTabMark />}</span> },
          { id: "desktop", label: <span className="speed-tab"><Monitor size={14} aria-hidden /> Ordinateur{failureFor(failures, "desktop") && <FailTabMark />}</span> },
        ]}
      />
      {failed && <FailureNote f={failed} stale={m ? fmtDateTime(m.measuredAt) : null} />}
      {m ? <MeasureDetail key={device} m={m} device={device} /> : !failed && <p className="muted small speed-device__none">Pas de mesure sur {DEVICE_LABEL[device].toLowerCase()} pour cette page.</p>}
    </div>
  );
}

// ───────── Lancer, suivre, arrêter

function useMeasure(siteId: string) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const run = async (pageIds?: string[]) => {
    setBusy(true);
    setError(null);
    try {
      const st = await sendJSON<PageSpeedState>("POST", keys.pageSpeed(siteId), pageIds ? { pageIds } : {});
      setQueryData(keys.pageSpeed(siteId), st);
    } catch (err) {
      setError(toAppError(err));
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    setStopping(true);
    try {
      const st = await sendJSON<PageSpeedState>("POST", keys.pageSpeedCancel(siteId));
      setQueryData(keys.pageSpeed(siteId), st);
      invalidate(`/sites/${encodeURIComponent(siteId)}/pages/`);
      toast.show({ tone: "neutral", title: "Mesure arrêtée", text: "Les pages déjà mesurées sont gardées." });
    } catch (err) {
      const e = toAppError(err);
      toast.show({ tone: "error", title: e.message, text: e.action });
    } finally {
      setStopping(false);
    }
  };
  return { busy, stopping, error, run, cancel };
}
type Measure = ReturnType<typeof useMeasure>;

function MeasureButton({ m, running, label, size = "md", variant = "primary", pageIds }: { m: Measure; running: boolean; label: string; size?: "sm" | "md"; variant?: "primary" | "secondary"; pageIds?: string[] }) {
  const wait = useRetryCountdown(m.error);
  return (
    <Button variant={variant} size={size} icon={<Gauge size={size === "sm" ? 14 : 15} aria-hidden />} loading={m.busy} disabled={running || m.busy || wait > 0} onClick={() => void m.run(pageIds)}>
      {wait > 0 ? `Nouvel essai dans ${fmtWait(wait)}` : running ? "Mesure en cours…" : label}
    </Button>
  );
}

function pathOf(url: string) {
  try {
    return decodeURIComponent(new URL(url).pathname) || "/";
  } catch {
    return url;
  }
}

function Progress({ run, m }: { run: NonNullable<PageSpeedState["running"]>; m: Measure }) {
  return (
    <div className="speed-run" role="status" aria-live="polite">
      <div className="speed-run__head">
        <LoaderCircle size={16} className="spin speed-run__icon" aria-hidden />
        <p className="speed-run__title">
          Mesure en cours : <span className="tnum">{plural(run.done, "page mesurée", "pages mesurées")} sur {fmtInt(run.total)}</span>
        </p>
        <Button size="sm" variant="secondary" icon={<Square size={12} aria-hidden />} loading={m.stopping} onClick={() => void m.cancel()}>Arrêter</Button>
      </div>
      <Meter value={run.done} max={run.total} tone="accent" label={`${run.done} pages mesurées sur ${run.total}`} />
      {run.currentUrl && <p className="speed-run__url small">Page en cours : <span className="mono">{pathOf(run.currentUrl)}</span></p>}
      <p className="speed-run__note small muted">Chaque page est mesurée sur téléphone puis sur ordinateur ; Google prend 10 à 40 secondes par mesure. Vous pouvez quitter cet écran : la mesure continue et les résultats s'ajoutent au fil de l'eau. Arrêter garde les pages déjà mesurées.</p>
    </div>
  );
}

function MeasureError({ m }: { m: Measure }) {
  if (!m.error) return null;
  // Délai d'attente : le bouton l'affiche déjà ; le message dit pourquoi.
  return <ErrorState error={m.error} inline />;
}

/** Sur quoi porte le vécu réel des visiteurs : cette page, tout le site, ou rien (pas assez de visites). */
function fieldLabel(p: SpeedPage): string | null {
  if (!p.mobile && !p.desktop) return null;
  const f = p.mobile?.field ?? p.desktop?.field ?? null;
  if (!f) return "Pas assez de visites";
  return f.scope === "site" ? "Tout le site" : "Cette page";
}

/** Note d'un appareil dans une ligne : la note, ou l'échec de la dernière mesure, ou « Non mesuré ». */
function DeviceCell({ m, f, device }: { m: SpeedMeasure | null; f: Failure | null; device: Device }) {
  const Icon = device === "mobile" ? Smartphone : Monitor;
  return (
    <span className="speed-row__dev">
      <span className="speed-row__devlabel"><Icon size={13} aria-hidden /> <span>{DEVICE_LABEL[device]}</span></span>
      {m ? (
        <>
          <SpeedScore score={m.score} />
          {f && <span className="speed-stale" title={`Dernière mesure échouée : ${f.message}`}><CircleSlash size={13} strokeWidth={2.25} aria-hidden /><span className="sr-only">La dernière mesure a échoué ; note précédente</span></span>}
        </>
      ) : f ? (
        <FailedMark f={f} />
      ) : (
        <span className="subtle small">Non mesuré</span>
      )}
    </span>
  );
}

function SpeedRow({ p, siteId, failures }: { p: SpeedPage; siteId: string; failures?: Failure[] }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const field = fieldLabel(p);
  return (
    <li className={`speed-row ${open ? "is-open" : ""}`}>
      <button type="button" className="speed-row__btn" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        <span className="speed-row__page">
          <span className="speed-row__pageline">
            <span className="mono speed-row__path">{p.path}</span>
            {p.pageType && <Tag>{PAGE_TYPE_LABEL[p.pageType].one}</Tag>}
          </span>
          {field && <span className="speed-row__fieldsm small">Vécu réel : {field.toLowerCase()}</span>}
        </span>
        <DeviceCell m={p.mobile} f={failureFor(failures, "mobile")} device="mobile" />
        <DeviceCell m={p.desktop} f={failureFor(failures, "desktop")} device="desktop" />
        <span className="speed-row__field small">{field ?? <span className="subtle">—</span>}</span>
        <ChevronDown size={16} className="speed-row__chev" aria-hidden />
      </button>
      {open && (
        <div className="speed-row__body" id={id}>
          <SpeedDetail mobile={p.mobile} desktop={p.desktop} failures={failures} />
          {p.pageId && <p className="speed-row__link small"><Link to={sitePath(siteId, "pages", p.pageId)} className="text-link">Ouvrir la fiche de la page</Link></p>}
        </div>
      )}
    </li>
  );
}

const NOT_IN_SCORE = "Cette note de vitesse n'entre pas dans la note SEO du site.";

/** En tête du bloc : les pages et appareils que Google n'a pas pu mesurer lors de la dernière demande. */
function FailureSummary({ byPath, running }: { byPath: Map<string, Failure[]>; running: boolean }) {
  if (!byPath.size) return null;
  const entries = [...byPath.entries()];
  const count = entries.reduce((n, [, l]) => n + l.length, 0);
  const shown = entries.slice(0, 4);
  return (
    <div className="speed-failsum" role="status">
      <TriangleAlert size={16} strokeWidth={2.25} className="speed-failsum__icon" aria-hidden />
      <div className="speed-failsum__text">
        <p className="speed-failsum__title">
          {running ? "Pendant cette mesure, " : "Lors de la dernière mesure, "}
          Google n'a pas pu mesurer <span className="tnum">{plural(entries.length, "page", "pages")}</span>
          {count > entries.length ? <> (<span className="tnum">{plural(count, "mesure", "mesures")}</span>)</> : null}.
        </p>
        <ul className="speed-failsum__list small">
          {shown.map(([path, list]) => (
            <li key={path}><span className="mono">{path}</span> <span className="muted">sur {devicesText(list)}</span></li>
          ))}
          {entries.length > shown.length && <li className="muted">et {plural(entries.length - shown.length, "autre page", "autres pages")}</li>}
        </ul>
        <p className="small muted">La raison est indiquée sur chaque ligne : ouvrez-la pour la lire. {running ? "La mesure continue pour les autres pages." : "Les autres pages ont été mesurées normalement."}</p>
      </div>
    </div>
  );
}

/** Bloc « Vitesse des pages » de l'Audit SEO. */
export function SpeedSection({ site }: { site: SiteSummary }) {
  const settings = useSettings().data;
  const configured = settings?.integrations.pageSpeed.configured;
  const q = usePageSpeed(site.id, configured === true);
  const m = useMeasure(site.id);
  if (settings === undefined) return null;
  const st = q.data;
  const running = !!st?.running;
  const notConfigured = !configured || st?.configured === false;
  const byPath = failuresByPath(st);
  // Pages dont aucune mesure n'existe et dont la dernière demande a échoué : elles ont leur ligne, avec la raison.
  const failedOnly: SpeedPage[] = [...byPath.keys()]
    .filter((path) => !st?.pages.some((p) => p.path === path))
    .map((path) => ({ pageId: null, url: path, path, pageType: null, mobile: null, desktop: null }));
  const rows = st ? [...st.pages, ...failedOnly] : [];
  const hasPages = rows.length > 0;

  return (
    <Section
      id="speed"
      className="speed"
      title="Vitesse des pages"
      description={<>Mesurée par Google (PageSpeed Insights), sur téléphone et sur ordinateur. {NOT_IN_SCORE}</>}
      actions={!notConfigured && hasPages && !running ? <MeasureButton m={m} running={running} label="Mesurer de nouveau" variant="secondary" /> : undefined}
    >
      {notConfigured ? (
        <EmptyState title="La mesure de vitesse n'est pas activée" tone="framed">
          <p>Google sait mesurer le temps d'affichage de vos pages et ce que vivent vos visiteurs. Pour l'activer, la personne qui gère l'installation ajoute une clé Google PageSpeed Insights sur le serveur (<span className="mono small">GOOGLE_PAGESPEED_API_KEY</span>).</p>
        </EmptyState>
      ) : (
        <>
          {q.error && <ErrorState error={q.error} inline={!!st} onRetry={() => void q.refetch()} retrying={q.fetching} />}
          {!st && !q.error && <SkeletonRows rows={4} height={56} />}
          {st?.running && <Progress run={st.running} m={m} />}
          <MeasureError m={m} />
          {st?.lastError && !running && (
            <ErrorState inline error={{ code: st.lastError.code, message: `La dernière demande de mesure s'est arrêtée : ${st.lastError.message}`, action: st.lastError.action, status: 0, details: st.lastError.details }} />
          )}
          <FailureSummary byPath={byPath} running={running} />
          {st && !hasPages && !running && (
            <EmptyState title="Aucune page mesurée pour l'instant" tone="framed" actions={<MeasureButton m={m} running={running} label="Mesurer la vitesse" />}>
              <p>Google mesure l'accueil et une page de chaque type (10 pages au plus), sur téléphone puis sur ordinateur. Comptez 10 à 40 secondes par page et par appareil, soit quelques minutes en tout : vous pouvez continuer à naviguer pendant ce temps.</p>
              <p className="small muted">30 pages au plus peuvent être mesurées par heure pour un même site.</p>
            </EmptyState>
          )}
          {hasPages && (
            <>
              <div className="speed-head" aria-hidden>
                <span>Page</span><span>Téléphone</span><span>Ordinateur</span><span>Vécu réel</span><span />
              </div>
              <ul className="speed-list">
                {rows.map((p) => <SpeedRow key={p.path} p={p} siteId={site.id} failures={byPath.get(p.path)} />)}
              </ul>
              <p className="speed-foot small muted">Note sur 100 donnée par Google : 90 et plus, rapide ; 50 à 89, moyenne ; moins de 50, lente. Les pages les plus lentes sur téléphone d'abord. Ouvrez une ligne pour le détail. 30 pages au plus peuvent être mesurées par heure.</p>
            </>
          )}
        </>
      )}
    </Section>
  );
}

/**
 * Fiche d'une page : sa vitesse, en résumé compact près du haut (deux notes et « Mesurer cette page »),
 * le détail se déplie à la demande pour ne pas repousser les critères de la grille.
 */
export function PageSpeedBlock({ siteId, pageId, pageUrl, pagePath, speed }: { siteId: string; pageId: string; pageUrl: string; pagePath: string; speed: { mobile: SpeedMeasure | null; desktop: SpeedMeasure | null } | null }) {
  const configured = useSettings().data?.integrations.pageSpeed.configured === true;
  const q = usePageSpeed(siteId, configured);
  const m = useMeasure(siteId);
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!configured) return null;
  const run = q.data?.running ?? null;
  const thisOne = !!run && run.currentUrl === pageUrl;
  const failures = failuresByPath(q.data).get(pagePath);
  const hasMeasure = !!speed && (!!speed.mobile || !!speed.desktop);
  return (
    <section className="detail-block speed-page">
      <h3 className="detail-block__title">Vitesse <span className="detail-block__src">PageSpeed Insights</span></h3>
      <div className="speed-page__head">
        {hasMeasure || failures ? (
          <div className="speed-page__scores">
            <DeviceCell m={speed?.mobile ?? null} f={failureFor(failures, "mobile")} device="mobile" />
            <DeviceCell m={speed?.desktop ?? null} f={failureFor(failures, "desktop")} device="desktop" />
          </div>
        ) : (
          !thisOne && <p className="speed-page__none small muted">Pas encore mesurée. Google la charge sur téléphone puis sur ordinateur : comptez 10 à 40 secondes par appareil.</p>
        )}
        <MeasureButton m={m} running={!!run} label={hasMeasure ? "Mesurer de nouveau" : "Mesurer cette page"} size="sm" variant="secondary" pageIds={[pageId]} />
      </div>
      {run && (
        <p className="speed-inline small" role="status">
          <LoaderCircle size={14} className="spin" aria-hidden />
          <span>{thisOne ? "Cette page est en cours de mesure." : "Une mesure de vitesse est en cours sur ce site."} <span className="muted tnum">{plural(run.done, "page mesurée", "pages mesurées")} sur {fmtInt(run.total)}.</span></span>
        </p>
      )}
      {!hasMeasure && failures && groupByMessage(failures).map((g) => <FailureNote key={g[0].device} f={g} />)}
      <MeasureError m={m} />
      {hasMeasure && (
        <>
          <button type="button" className="speed-page__toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
            <ChevronDown size={15} className="speed-page__chev" aria-hidden />
            <span>{open ? "Masquer le détail" : "Voir le détail"}{failures ? " et la mesure échouée" : ""}</span>
          </button>
          {open && (
            <div id={id} className="speed-page__body">
              <SpeedDetail mobile={speed!.mobile} desktop={speed!.desktop} failures={failures} />
            </div>
          )}
        </>
      )}
      <p className="small subtle">{NOT_IN_SCORE}</p>
    </section>
  );
}
