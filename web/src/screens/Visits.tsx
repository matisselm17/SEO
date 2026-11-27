/**
 * Après le clic : les visites lues dans Google Analytics (lecture seule, par le serveur).
 * Affiché sous les données de la Search Console, sans jamais les additionner ni les mélanger :
 * la Search Console compte des clics dans Google, Google Analytics compte des visites sur le site.
 */
import { useMemo, useState } from "react";
import { CloudDownload, Info, Search } from "lucide-react";
import type { AnalyticsData, LandingPage, PageVisits, SiteSummary } from "../lib/types";
import { keys, useAnalytics, useSettings } from "../lib/queries";
import { sendJSON, toAppError, type AppError } from "../lib/api";
import { invalidate, setQueryData } from "../lib/cache";
import { sitePath } from "../lib/router";
import { fmtCompact, fmtDateTime, fmtInt, fmtMoney, fmtPct, fmtPeriod } from "../lib/format";
import { Section } from "../ui/Section";
import { TrendChart, type TrendMetric } from "../ui/TrendChart";
import { Button, Link } from "../ui/Button";
import { ScorePill } from "../ui/Badge";
import { Meter } from "../ui/Meter";
import { CodeBlock } from "../ui/CodeBlock";
import { EmptyState, ErrorState, fmtWait, useRetryCountdown } from "../ui/States";
import { Skeleton, SkeletonRows } from "../ui/Skeleton";
import { useToast } from "../ui/Toast";

type Read = Extract<AnalyticsData, { available: true }>;

/** Libellés des origines de visite de Google, dits simplement. Un libellé inconnu s'affiche tel quel. */
const CHANNEL_LABEL: Record<string, string> = {
  "Organic Search": "Moteurs de recherche",
  Direct: "Accès direct",
  "Paid Search": "Annonces sur les moteurs de recherche",
  "Organic Social": "Réseaux sociaux",
  "Paid Social": "Annonces sur les réseaux sociaux",
  Referral: "Autres sites",
  Email: "E-mails",
  "Organic Shopping": "Google Shopping",
  "Organic Video": "Vidéos",
  Display: "Bannières publicitaires",
  Affiliates: "Sites affiliés",
  Unassigned: "Origine inconnue",
};
const channelLabel = (c: string) => CHANNEL_LABEL[c] ?? c;

const PERIODS = [
  { days: 28, label: "28 jours" },
  { days: 90, label: "3 mois" },
] as const;

const VISIT_METRICS: TrendMetric<"organicSessions" | "sessions">[] = [
  { id: "organicSessions", label: "Depuis les moteurs de recherche", color: "var(--chart-1)" },
  { id: "sessions", label: "Toutes les visites", color: "var(--chart-2)" },
];

function useAnalyticsSync(siteId: string) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  // Période de la dernière demande : « Réessayer » la reprend telle quelle.
  const [lastDays, setLastDays] = useState(28);
  const run = async (days: number) => {
    setLastDays(days);
    setBusy(true);
    setError(null);
    try {
      const data = await sendJSON<AnalyticsData>("POST", keys.analyticsSync(siteId), { days });
      setQueryData(keys.analytics(siteId), data);
      invalidate(`/sites/${encodeURIComponent(siteId)}/pages/`);
      toast.show({ tone: "success", title: "Visites lues dans Google Analytics", text: data.available ? `Période ${fmtPeriod(data.period)}. Elles remplacent la lecture précédente.` : undefined });
    } catch (err) {
      setError(toAppError(err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, lastDays };
}
type Sync = ReturnType<typeof useAnalyticsSync>;

function ReadControls({ sync, again, initialDays = 28 }: { sync: Sync; again: boolean; initialDays?: number }) {
  const [days, setDays] = useState<number>(initialDays);
  // Une lecture par minute au plus : après un refus, le bouton attend la fin du délai donné par le serveur.
  const wait = useRetryCountdown(sync.error);
  return (
    <div className="ga-read">
      <span className="sr-only" id="ga-period-t">Période à lire</span>
      <div className="seg" role="radiogroup" aria-labelledby="ga-period-t">
        {PERIODS.map((p) => (
          <label key={p.days} className={`seg__opt ${days === p.days ? "is-on" : ""}`}>
            <input type="radio" name="ga-period" value={p.days} checked={days === p.days} onChange={() => setDays(p.days)} />
            <span>{p.label}</span>
          </label>
        ))}
      </div>
      <Button variant={again ? "secondary" : "primary"} icon={<CloudDownload size={15} aria-hidden />} loading={sync.busy} disabled={sync.busy || wait > 0} onClick={() => void sync.run(days)}>
        {sync.busy ? "Lecture de Google Analytics…" : wait > 0 ? `Nouvel essai dans ${fmtWait(wait)}` : again ? "Relire Google Analytics" : "Lire Google Analytics"}
      </Button>
    </div>
  );
}

/** Erreurs de lecture : l'adresse à ajouter dans Google Analytics est montrée telle quelle, avec les étapes. */
function SyncError({ sync }: { sync: Sync }) {
  const e = sync.error;
  if (!e || e.code === "rate_limited") return e ? <p className="ga-wait small muted" role="status">{e.message}</p> : null;
  if (e.code === "analytics_no_access") {
    const account = typeof e.details?.account === "string" ? e.details.account : null;
    return (
      <div className="gsc-access" role="alert">
        <p className="gsc-access__title">{e.message}</p>
        <p className="gsc-access__lead">Chat SEO lit vos visites avec un compte de service Google, en lecture seule. Donnez-lui accès à votre propriété :</p>
        <ol className="howto howto--compact">
          <li><strong>Copiez l'adresse du compte de service</strong>{account ? <CodeBlock code={account} label="Adresse à ajouter" /> : <span>La personne qui gère l'installation peut vous la donner.</span>}</li>
          <li><strong>Ouvrez Google Analytics</strong><span>Choisissez la propriété de ce site, puis « Administration » (la roue dentée en bas à gauche) et « Gestion des accès à la propriété ».</span></li>
          <li><strong>Ajoutez cette adresse comme Lecteur</strong><span>Bouton « + », « Ajouter des utilisateurs », collez l'adresse, choisissez le rôle « Lecteur » (il suffit), puis « Ajouter ». Revenez ici et relancez la lecture.</span></li>
        </ol>
      </div>
    );
  }
  if (e.code === "analytics_other_site") {
    return (
      <ErrorState
        inline
        error={{ code: e.code, status: e.status, message: e.message, action: `${e.action ?? "Le numéro de propriété configuré sur le serveur désigne sans doute un autre site."} Rien n'a été enregistré.` }}
      />
    );
  }
  return <ErrorState error={e} inline onRetry={e.code === "analytics_unavailable" && e.details?.retryable === false ? undefined : () => void sync.run(sync.lastDays)} retrying={sync.busy} />;
}

function NotConfigured() {
  return (
    <EmptyState title="Google Analytics n'est pas relié" tone="framed">
      <p>La Search Console dit ce qui se passe dans Google ; Google Analytics dit ce que font les visiteurs une fois sur votre site : combien restent, combien achètent.</p>
      <p>Pour le relier, la personne qui gère l'installation donne au serveur un accès Google (le même que pour la Search Console) et le numéro de votre propriété Google Analytics (<span className="mono small">GA4_PROPERTY_ID</span>). Rien ne se configure dans le navigateur.</p>
    </EmptyState>
  );
}

const share = (part: number, whole: number) => (whole > 0 ? part / whole : 0);

/** Période du sélecteur : celle de la dernière lecture (28 jours ou 3 mois, à deux jours près), sinon 28 jours. */
function periodDaysOf(period: { start: string; end: string }): number {
  const days = Math.round((Date.parse(period.end) - Date.parse(period.start)) / 86400000) + 1;
  return PERIODS.find((p) => Math.abs(p.days - days) <= 2)?.days ?? 28;
}

/** Pourquoi le chiffre d'affaires manque. Jamais « 0 € » : null n'est pas zéro. */
const REVENUE_MISSING: Record<"not_measured" | "restricted", { value: string; text: string }> = {
  not_measured: { value: "Non mesuré", text: "Google Analytics ne mesure aucune vente sur ce site pour cette période." },
  restricted: { value: "Non visible", text: "L'accès Google utilisé n'a pas le droit de voir le chiffre d'affaires." },
};
const REVENUE_ASK =
  "Pour l'afficher, demandez à l'administrateur de la propriété Google Analytics de donner à l'accès de Chat SEO un rôle qui donne accès aux données de revenus, puis relisez Google Analytics.";

const revenueShown = (d: Read) => d.revenueStatus === "measured" && d.totals.revenue !== null;

function Kpis({ data }: { data: Read }) {
  const o = data.organic;
  const t = data.totals;
  const revenueMeasured = revenueShown(data);
  const missing = REVENUE_MISSING[data.revenueStatus === "restricted" ? "restricted" : "not_measured"];
  return (
    <dl className="kpis kpis--row kpis--band ga-kpis">
      <div className="kpi">
        <dt className="kpi__label">Visites venues des moteurs de recherche</dt>
        <dd className="kpi__value tnum">{fmtCompact(o.sessions)}</dd>
        <dd className="kpi__hint">sur {fmtInt(t.sessions)} visites en tout, soit {fmtPct(share(o.sessions, t.sessions))}</dd>
      </div>
      <div className="kpi">
        <dt className="kpi__label">Taux d'engagement</dt>
        <dd className="kpi__value tnum">{fmtPct(o.engagementRate)}</dd>
        <dd className="kpi__hint">Visites où le visiteur est resté actif ; {fmtPct(t.engagementRate)} pour l'ensemble des visites</dd>
      </div>
      <div className="kpi">
        <dt className="kpi__label">Événements clés</dt>
        <dd className="kpi__value tnum">{fmtCompact(o.keyEvents)}</dd>
        <dd className="kpi__hint">sur {fmtInt(t.keyEvents)} en tout : achats, inscriptions… selon vos réglages Google Analytics</dd>
      </div>
      <div className="kpi">
        <dt className="kpi__label">Chiffre d'affaires</dt>
        {revenueMeasured ? (
          <>
            <dd className="kpi__value tnum">{fmtMoney(o.revenue ?? 0, data.currency)}</dd>
            <dd className="kpi__hint">sur {fmtMoney(t.revenue ?? 0, data.currency)} en tout{data.currency ? "" : " (devise non précisée)"}</dd>
          </>
        ) : (
          <>
            <dd className="kpi__value kpi__value--none">{missing.value}</dd>
            <dd className="kpi__hint">{missing.text}</dd>
          </>
        )}
      </div>
    </dl>
  );
}

function Channels({ data }: { data: Read }) {
  const total = data.totals.sessions;
  return (
    <div className="table-scroll">
      <table className="table ga-channels">
        <thead>
          <tr>
            <th scope="col">Origine</th>
            <th scope="col" className="num">Visites</th>
            <th scope="col" className="ga-channels__share">Part des visites</th>
            <th scope="col" className="num col-ctr">Taux d'engagement</th>
            <th scope="col" className="num col-ga-events">Événements clés</th>
          </tr>
        </thead>
        <tbody>
          {data.channels.map((c) => {
            const organic = c.channel === "Organic Search";
            const label = channelLabel(c.channel);
            return (
              <tr key={c.channel} className={organic ? "is-organic" : undefined}>
                <th scope="row" className="ga-channels__name">
                  {label}
                  {label !== c.channel && <span className="ga-channels__orig" lang="en">{c.channel}</span>}
                </th>
                <td className="num tnum">{fmtInt(c.sessions)}</td>
                <td className="ga-channels__share">
                  <span className="ga-share">
                    <Meter value={c.sessions} max={total} tone={organic ? "accent" : "neutral"} />
                    <span className="tnum">{fmtPct(share(c.sessions, total))}</span>
                  </span>
                </td>
                <td className="num tnum col-ctr">{fmtPct(c.engagementRate)}</td>
                <td className="num tnum col-ga-events">{fmtInt(c.keyEvents)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const STEP = 50;

function LandingTable({ rows, siteId, currency, revenue }: { rows: LandingPage[]; siteId: string; currency: string | null; revenue: boolean }) {
  const [q, setQ] = useState("");
  const [shown, setShown] = useState(STEP);
  const list = useMemo(() => (q ? rows.filter((r) => r.path.toLowerCase().includes(q.toLowerCase())) : rows), [rows, q]);
  return (
    <>
      <div className="toolbar">
        <label className="search pages__search">
          <Search size={15} aria-hidden />
          <span className="sr-only">Filtrer les pages d'arrivée</span>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filtrer les pages" />
        </label>
      </div>
      <div className="table-scroll">
        <table className="table gsc-table">
          <thead>
            <tr>
              <th scope="col">Page d'arrivée</th>
              <th scope="col">Note SEO</th>
              <th scope="col" className="num">Depuis les moteurs</th>
              <th scope="col" className="num">Toutes les visites</th>
              <th scope="col" className="num col-ctr">Engagement</th>
              <th scope="col" className="num">Événements clés</th>
              {revenue && <th scope="col" className="num">Chiffre d'affaires</th>}
            </tr>
          </thead>
          <tbody>
            {list.slice(0, shown).map((r) => (
              <tr key={r.path}>
                <td className="gsc-table__q">
                  {r.pageId ? <Link to={sitePath(siteId, "pages", r.pageId)} className="mono gsc-table__path">{r.path}</Link> : <span className="mono gsc-table__path gsc-table__path--plain">{r.path}</span>}
                </td>
                <td>{r.score !== null ? <ScorePill score={r.score} /> : <span className="subtle small">Non analysée</span>}</td>
                <td className="num tnum">{fmtInt(r.organicSessions)}</td>
                <td className="num tnum">{fmtInt(r.sessions)}</td>
                <td className="num tnum col-ctr">{fmtPct(r.engagementRate)}</td>
                <td className="num tnum">{fmtInt(r.keyEvents)}</td>
                {revenue && <td className="num tnum">{r.revenue === null ? <span className="subtle">—</span> : fmtMoney(r.revenue, currency)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {list.length === 0 && <p className="muted table-empty">Aucune page ne correspond.</p>}
      {list.length > shown && <Button size="sm" variant="ghost" onClick={() => setShown((s) => s + STEP)} className="table-more">Afficher {Math.min(STEP, list.length - shown)} de plus</Button>}
    </>
  );
}

function ReadData({ data, site, withGsc }: { data: Read; site: SiteSummary; withGsc: boolean }) {
  const revenue = revenueShown(data);
  return (
    <>
      {withGsc && (
        <p className="ga-note small">
          <Info size={14} aria-hidden />
          <span>
            <strong>Deux mesures différentes, à ne pas additionner.</strong> Plus haut, la Search Console compte les clics dans les résultats de Google ; ici, Google Analytics compte les visites sur votre site. Un clic n'est pas toujours une visite mesurée (page quittée avant son chargement, mesure refusée par le visiteur) : les chiffres diffèrent toujours un peu.
          </span>
        </p>
      )}
      <Kpis data={data} />
      {data.revenueStatus === "restricted" && (
        <p className="ga-note ga-note--after small" role="note">
          <Info size={14} aria-hidden />
          <span><strong>Chiffre d'affaires non visible.</strong> {REVENUE_ASK}</span>
        </p>
      )}

      <Section id="ga-channels" title="D'où viennent les visites" description="Toutes les visites du site, par origine, telles que Google Analytics les classe.">
        <Channels data={data} />
      </Section>

      <Section id="ga-series" title="Visites jour par jour" description={fmtPeriod(data.period)}>
        {data.series.length > 1 ? (
          <TrendChart series={data.series} metrics={VISIT_METRICS} label="Visites quotidiennes" />
        ) : (
          <p className="muted">La période lue ne contient pas assez de jours pour tracer une courbe.</p>
        )}
      </Section>

      <Section
        id="ga-landing"
        title="Pages d'arrivée"
        description="La première page vue lors de chaque visite, triées par visites venues des moteurs de recherche. La note SEO est celle de l'analyse."
      >
        {data.landingPages.length ? (
          <>
            <LandingTable rows={data.landingPages} siteId={site.id} currency={data.currency} revenue={revenue} />
            {data.landingPagesTruncated && (
              <p className="table-note ga-truncated small">
                <Info size={14} aria-hidden />
                <span>Seules les <span className="tnum">{fmtInt(data.landingPages.length)}</span> pages d'arrivée les plus visitées sont listées. Une page absente de cette liste a pu recevoir des visites : elles ne sont simplement pas détaillées ici.</span>
              </p>
            )}
          </>
        ) : (
          <p className="muted">Google Analytics n'a enregistré aucune page d'arrivée sur cette période.</p>
        )}
      </Section>
    </>
  );
}

/** Le chapitre « Après le clic : les visites », dans la section Mots-clés et trafic organique. */
export function VisitsChapter({ site, withGsc }: { site: SiteSummary; withGsc: boolean }) {
  const settings = useSettings().data;
  const configured = settings?.integrations.analytics.configured;
  const q = useAnalytics(site.id, configured === true);
  const sync = useAnalyticsSync(site.id);
  const data = q.data;
  if (settings === undefined) return null;
  const notConfigured = !configured || (data && !data.available && data.reason === "not_configured");

  return (
    <section className="ga" aria-labelledby="ga-t">
      <header className="ga__head">
        <div className="ga__text">
          <p className="ga__source"><span className="gsc-source__tag">Google Analytics</span></p>
          <h2 id="ga-t" className="ga__title">Après le clic : les visites</h2>
          <p className="ga__desc">
            Ce que font les visiteurs une fois arrivés sur votre site : combien viennent des moteurs de recherche, combien restent, ce qu'ils accomplissent.
          </p>
          {data?.available && (
            <p className="ga__meta small muted">Lu le {fmtDateTime(data.syncedAt)}, visites {fmtPeriod(data.period)}.</p>
          )}
        </div>
        {!notConfigured && data?.available && <ReadControls key={`${data.period.start}_${data.period.end}`} sync={sync} again initialDays={periodDaysOf(data.period)} />}
      </header>

      {notConfigured ? (
        <NotConfigured />
      ) : (
        <>
          {q.error && !data && <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.fetching} />}
          {(sync.error && data?.available) || (q.error && data) ? (
            <div className="ga-error">{sync.error ? <SyncError sync={sync} /> : q.error && <ErrorState error={q.error} inline onRetry={() => void q.refetch()} retrying={q.fetching} />}</div>
          ) : null}
          {!data && !q.error && (
            <div aria-hidden>
              <div className="kpis kpis--row kpis--band">{Array.from({ length: 4 }, (_, i) => <div key={i} className="kpi"><Skeleton w="60%" h={10} /><div style={{ height: 8 }} /><Skeleton w="40%" h={24} /></div>)}</div>
              <div style={{ height: 40 }} />
              <SkeletonRows rows={5} height={40} />
            </div>
          )}
          {data && !data.available && (
            <div className="ga-empty">
              <EmptyState title="Vos visites n'ont pas encore été lues" tone="framed">
                <p>Chat SEO lit Google Analytics en lecture seule : rien n'y est modifié. Choisissez la période, puis lancez la lecture ; elle prend quelques secondes.</p>
                <div className="ga-empty__controls"><ReadControls sync={sync} again={false} /></div>
                {sync.error && <div className="ga-error ga-error--below"><SyncError sync={sync} /></div>}
              </EmptyState>
            </div>
          )}
          {data?.available && <ReadData data={data} site={site} withGsc={withGsc} />}
        </>
      )}
    </section>
  );
}

/** Fiche d'une page : ses visites d'après Google Analytics, à côté de ses données Search Console. */
export function PageVisitsBlock({ siteId, visits }: { siteId: string; visits: PageVisits | null }) {
  const configured = useSettings().data?.integrations.analytics.configured === true;
  const q = useAnalytics(siteId, configured);
  if (!configured) return null;
  const read = q.data?.available ? q.data : null;
  if (!read && !visits) {
    // Jamais lu : une ligne qui dit où lire, pas un bloc vide.
    if (q.data && !q.data.available && q.data.reason === "not_run") {
      return (
        <section className="detail-block">
          <h3 className="detail-block__title">Visites sur la page <span className="detail-block__src">Google Analytics</span></h3>
          <p className="detail-block__hint ga-hint">Les visites n'ont pas encore été lues. <Link to={sitePath(siteId, "traffic")} className="text-link">Lire Google Analytics</Link> depuis « Mots-clés et trafic organique ».</p>
        </section>
      );
    }
    return null;
  }
  return (
    <section className="detail-block">
      <h3 className="detail-block__title">Visites sur la page <span className="detail-block__src">Google Analytics</span></h3>
      {visits ? (
        <>
          <dl className="minikpis minikpis--4">
            <div><dt>Depuis les moteurs</dt><dd className="tnum">{fmtInt(visits.organicSessions)}</dd></div>
            <div><dt>Toutes les visites</dt><dd className="tnum">{fmtInt(visits.sessions)}</dd></div>
            <div><dt>Engagement</dt><dd className="tnum">{fmtPct(visits.engagementRate)}</dd></div>
            <div><dt>Événements clés</dt><dd className="tnum">{fmtInt(visits.keyEvents)}</dd></div>
          </dl>
          <p className="detail-block__hint">
            Visites dont cette page était la première vue{read ? `, ${fmtPeriod(read.period)}` : ""}.{" "}
            {visits.revenue !== null && (!read || read.revenueStatus === "measured") ? (
              <>Chiffre d'affaires de ces visites : <strong className="tnum">{fmtMoney(visits.revenue, read?.currency ?? null)}</strong>.</>
            ) : read?.revenueStatus === "restricted" ? (
              <>{REVENUE_MISSING.restricted.text} Il faut un rôle qui donne accès aux données de revenus dans Google Analytics.</>
            ) : read ? (
              REVENUE_MISSING.not_measured.text
            ) : (
              "Chiffre d'affaires non disponible."
            )}
            {" "}Ce sont des visites, pas des clics : elles ne s'additionnent pas aux chiffres de la Search Console.
          </p>
        </>
      ) : (
        read?.landingPagesTruncated ? (
          <p className="detail-block__hint">
            Cette page ne figure pas parmi les <span className="tnum">{fmtInt(read.landingPages.length)}</span> pages d'arrivée les plus visitées {fmtPeriod(read.period)}. Elle a pu recevoir des visites : seules ces pages sont détaillées.
          </p>
        ) : (
          <p className="detail-block__hint">Google Analytics n'a enregistré aucune visite arrivée sur cette page{read ? ` ${fmtPeriod(read.period)}` : ""}.</p>
        )
      )}
    </section>
  );
}

