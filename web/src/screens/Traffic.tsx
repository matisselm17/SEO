import { useMemo, useRef, useState } from "react";
import { CloudDownload, FileUp, Info, Link2, Search, Trash2, Upload } from "lucide-react";
import type { OrganicPage, OrganicQuery, SearchConsoleData, SiteSummary } from "../lib/types";
import { keys, useSearchConsole, useSettings } from "../lib/queries";
import { sendFile, sendJSON, toAppError, type AppError } from "../lib/api";
import { invalidate, setQueryData } from "../lib/cache";
import { patchSite } from "../lib/live";
import { sitePath } from "../lib/router";
import { fmtCompact, fmtDateTime, fmtInt, fmtPct, fmtPeriod, fmtPosition, plural } from "../lib/format";
import { PageHeader, Section } from "../ui/Section";
import { Dropzone } from "../ui/Dropzone";
import { TrendChart } from "../ui/TrendChart";
import { Tabs } from "../ui/Tabs";
import { Button, Link } from "../ui/Button";
import { ConfirmButton } from "../ui/ConfirmButton";
import { Dialog } from "../ui/Dialog";
import { ScorePill } from "../ui/Badge";
import { ErrorState, fmtWait, useRetryCountdown } from "../ui/States";
import { Skeleton, SkeletonRows, LoadingLabel } from "../ui/Skeleton";
import { useToast } from "../ui/Toast";
import { CodeBlock } from "../ui/CodeBlock";
import { QueryError } from "./common";
import { VisitsChapter } from "./Visits";

type Available = Extract<SearchConsoleData, { available: true }>;
const ACCEPT = ".zip,.csv,application/zip,text/csv";
const MAX = 20 * 1024 * 1024;

function useUpload(siteId: string) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const last = useRef<File | null>(null);
  const upload = async (file: File) => {
    last.current = file;
    setError(null);
    if (!/\.(zip|csv)$/i.test(file.name)) {
      setError({ code: "invalid_file", message: "Ce fichier n'est pas un export Search Console.", action: "Déposez le fichier .zip téléchargé depuis « Performances », ou l'un des fichiers .csv qu'il contient.", status: 0 });
      return;
    }
    if (file.size > MAX) {
      setError({ code: "file_too_large", message: "Ce fichier dépasse 20 Mo.", action: "Exportez une période plus courte, puis réessayez.", status: 0 });
      return;
    }
    setBusy(true);
    try {
      const data = await sendFile<SearchConsoleData>(`${keys.searchConsole(siteId)}`, file);
      setQueryData(keys.searchConsole(siteId), data);
      if (data.available) patchSite(siteId, (s) => ({ ...s, searchConsole: { available: true, importedAt: data.importedAt } }));
      invalidate(keys.overview(siteId));
      invalidate(keys.allPages(siteId));
      invalidate(`/sites/${encodeURIComponent(siteId)}/pages/`);
      const m = data.available ? data.matching : null;
      toast.show({
        tone: "success",
        title: "Export importé",
        text: m
          ? m.total === 0
            ? "L'export ne contient aucune page de ce site."
            : m.matched === 0
            ? `Aucune des ${fmtInt(m.total)} pages de l'export ne correspond aux pages analysées.`
            : `${fmtInt(m.matched)} ${m.matched > 1 ? "pages" : "page"} sur ${fmtInt(m.total)} reliée${m.matched > 1 ? "s" : ""} à l'analyse.`
          : "Vos clics et vos recherches sont importés. L'export ne contient pas la liste des pages.",
      });
    } catch (err) {
      setError(toAppError(err));
    } finally {
      setBusy(false);
    }
  };
  // Choisir un autre fichier : sélecteur de fichier du système, sans dépendre d'un champ présent à l'écran.
  const pick = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ACCEPT;
    input.onchange = () => {
      const f = input.files?.[0];
      if (f) void upload(f);
    };
    input.click();
  };
  return { busy, error, upload, pick, retry: () => last.current && upload(last.current), clear: () => setError(null) };
}

/** Périodes de lecture directe acceptées par le serveur (jours). */
const PERIODS = [
  { days: 28, label: "28 jours" },
  { days: 90, label: "3 mois" },
  { days: 480, label: "16 mois" },
] as const;

/** Lecture directe de la Search Console par le compte de service du serveur (lecture seule). */
function useGoogleSync(siteId: string) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const run = async (days: number) => {
    setBusy(true);
    setError(null);
    try {
      const data = await sendJSON<SearchConsoleData>("POST", keys.searchConsoleSync(siteId), { days });
      setQueryData(keys.searchConsole(siteId), data);
      if (data.available) patchSite(siteId, (s) => ({ ...s, searchConsole: { available: true, importedAt: data.importedAt } }));
      invalidate(keys.overview(siteId));
      invalidate(keys.allPages(siteId));
      invalidate(`/sites/${encodeURIComponent(siteId)}/pages/`);
      toast.show({ tone: "success", title: "Données lues chez Google", text: data.available && data.period ? `Période ${fmtPeriod(data.period)}. Elles remplacent les données précédentes.` : "Elles remplacent les données précédentes." });
    } catch (err) {
      setError(toAppError(err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, clear: () => setError(null) };
}

/**
 * Période du sélecteur : celle des données affichées quand elle correspond à une période proposée
 * (à deux jours près : un export de « 3 mois » couvre 90 ou 91 jours), sinon 28 jours.
 */
function periodDaysOf(period: { start: string; end: string } | null | undefined): number {
  if (!period) return 28;
  const days = Math.round((Date.parse(period.end) - Date.parse(period.start)) / 86400000) + 1;
  if (!Number.isFinite(days)) return 28;
  const match = PERIODS.find((p) => Math.abs(p.days - days) <= Math.max(2, Math.round(p.days * 0.02)));
  return match ? match.days : 28;
}

function PeriodPicker({ value, onChange, id }: { value: number; onChange: (d: number) => void; id: string }) {
  return (
    <div className="seg" role="radiogroup" aria-labelledby={id}>
      {PERIODS.map((p) => (
        <label key={p.days} className={`seg__opt ${value === p.days ? "is-on" : ""}`}>
          <input type="radio" name={id} value={p.days} checked={value === p.days} onChange={() => onChange(p.days)} />
          <span>{p.label}</span>
        </label>
      ))}
    </div>
  );
}

/** Erreurs de la lecture directe : l'adresse à ajouter dans la Search Console est montrée telle quelle, avec les étapes. */
function GoogleError({ g }: { g: ReturnType<typeof useGoogleSync> }) {
  if (!g.error) return null;
  if (g.error.code === "search_console_no_access") {
    const account = typeof g.error.details?.account === "string" ? g.error.details.account : null;
    return (
      <div className="gsc-access" role="alert">
        <p className="gsc-access__title">{g.error.message}</p>
        <p className="gsc-access__lead">Chat SEO lit vos données avec un compte de service Google. Donnez-lui accès à votre propriété, en lecture :</p>
        <ol className="howto howto--compact">
          <li><strong>Copiez l'adresse du compte de service</strong>{account ? <CodeBlock code={account} label="Adresse à ajouter" /> : <span>La personne qui gère l'installation peut vous la donner.</span>}</li>
          <li><strong>Ouvrez la Search Console</strong><span>Choisissez la propriété de ce site, puis « Paramètres », « Utilisateurs et autorisations ».</span></li>
          <li><strong>Ajoutez l'utilisateur</strong><span>Collez l'adresse, choisissez l'autorisation « Limité » (lecture seule, c'est suffisant), puis validez. Revenez ici et relancez la lecture.</span></li>
        </ol>
      </div>
    );
  }
  return <ErrorState error={g.error} inline />;
}

/**
 * Bloc de lecture directe, à côté du dépôt de fichier (qui reste disponible). `replacesFile` : un export déposé
 * est en place ; la lecture le remplacerait, donc elle est d'abord confirmée.
 */
function GoogleRead({ g, compact, replacesFile, initialDays = 28 }: { g: ReturnType<typeof useGoogleSync>; compact?: boolean; replacesFile?: { importedAt: string }; initialDays?: number }) {
  const [days, setDays] = useState<number>(initialDays);
  const [confirming, setConfirming] = useState(false);
  // Une lecture par minute au plus : après un refus, le bouton attend la fin du délai donné par le serveur.
  const wait = useRetryCountdown(g.error);
  const read = () => {
    if (replacesFile) setConfirming(true);
    else void g.run(days);
  };
  return (
    <div className={`gsc-google ${compact ? "gsc-google--compact" : ""}`}>
      {!compact && (
        <div className="gsc-google__text">
          <p className="gsc-google__title" id="gsc-period-t">Ou lisez-les directement chez Google</p>
          <p className="gsc-google__lead">En lecture seule, par le compte de service configuré sur le serveur. Les recherches sont alors reliées aux pages.</p>
        </div>
      )}
      <div className="gsc-google__row">
        {compact && <span className="sr-only" id="gsc-period-t">Période à lire</span>}
        <PeriodPicker value={days} onChange={setDays} id="gsc-period-t" />
        <Button variant={compact ? "secondary" : "primary"} icon={<CloudDownload size={15} aria-hidden />} loading={g.busy && !confirming} onClick={read} disabled={g.busy || wait > 0}>
          {g.busy ? "Lecture chez Google…" : wait > 0 ? `Nouvel essai dans ${fmtWait(wait)}` : compact ? "Relire depuis Google" : "Lire depuis Google"}
        </Button>
      </div>
      {!compact && <div className="gsc-error"><GoogleError g={g} /></div>}
      {replacesFile && (
        <Dialog
          open={confirming}
          onClose={() => setConfirming(false)}
          busy={g.busy}
          title="Remplacer l'export déposé ?"
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirming(false)} disabled={g.busy} data-autofocus>Garder l'export</Button>
              <Button variant="primary" icon={<CloudDownload size={15} aria-hidden />} loading={g.busy} onClick={() => void g.run(days).then(() => setConfirming(false))}>Lire et remplacer</Button>
            </>
          }
        >
          <p className="confirm__note">
            Les données lues chez Google ({PERIODS.find((p) => p.days === days)?.label.toLowerCase() ?? `${days} jours`}) remplaceront l'export que vous avez déposé le {fmtDateTime(replacesFile.importedAt)}. <strong>L'export ne sera pas conservé</strong> : pour y revenir, il faudra le déposer de nouveau.
          </p>
          <p className="muted small">La lecture se fait en lecture seule : rien n'est modifié dans votre Search Console.</p>
        </Dialog>
      )}
    </div>
  );
}

/**
 * Erreur de dépôt : un fichier refusé appelle un autre fichier ; une erreur du serveur ou du réseau,
 * un nouvel essai avec le même fichier.
 */
function UploadError({ u }: { u: ReturnType<typeof useUpload> }) {
  if (!u.error) return null;
  const refused = u.error.code === "invalid_file" || u.error.code === "file_too_large" || u.error.code === "bad_request";
  return refused ? (
    <ErrorState error={u.error} inline onRetry={u.pick} retryLabel="Choisir un autre fichier" retryIcon={<FileUp size={14} aria-hidden />} retrying={u.busy} />
  ) : (
    <ErrorState error={u.error} inline onRetry={() => void u.retry()} retrying={u.busy} />
  );
}

function HowTo() {
  return (
    <ol className="howto">
      <li>
        <strong>Ouvrez la Search Console</strong>
        <span>Sur search.google.com/search-console, choisissez votre site. C'est l'outil gratuit de Google qui mesure votre présence dans ses résultats.</span>
      </li>
      <li>
        <strong>Allez dans « Performances »</strong>
        <span>Puis « Résultats de recherche ». Choisissez une période : 3 mois donnent une bonne vue d'ensemble.</span>
      </li>
      <li>
        <strong>Cliquez sur « Exporter »</strong>
        <span>En haut à droite, puis « Télécharger le fichier CSV ». Vous obtenez un fichier .zip : déposez-le ici tel quel.</span>
      </li>
    </ol>
  );
}

function NoImport({ siteId, google }: { siteId: string; google: boolean }) {
  const u = useUpload(siteId);
  const g = useGoogleSync(siteId);
  return (
    <div className="gsc-empty">
      <div className="gsc-empty__main">
        <h2 className="gsc-empty__title">Reliez vos clics dans Google à vos pages</h2>
        <p className="gsc-empty__lead">
          L'analyse dit comment vos pages sont construites. L'export de la Search Console dit ce qu'elles vous rapportent : les recherches qui mènent à votre site, les clics, la position dans Google. C'est facultatif, et vous pouvez le remplacer à tout moment.
        </p>
        <Dropzone onFile={u.upload} accept={ACCEPT} busy={u.busy} title="Déposez ici l'export de la Search Console" hint="Le fichier .zip tel quel, ou un fichier .csv. 20 Mo au plus." />
        {u.error && <div className="gsc-error"><UploadError u={u} /></div>}
        {google && <GoogleRead g={g} />}
      </div>
      <aside className="gsc-empty__aside" aria-labelledby="howto-t">
        <h3 id="howto-t" className="gsc-empty__aside-title">Où trouver l'export</h3>
        <HowTo />
      </aside>
    </div>
  );
}

const STEP = 50;

/**
 * Écart entre le total des clics et la somme des recherches listées : Google ne détaille pas les recherches
 * trop rares (confidentialité). Calculé à partir des seules données affichées ; rien quand il n'y a pas d'écart.
 */
function HiddenQueriesNote({ rows, totalClicks, source }: { rows: OrganicQuery[]; totalClicks: number; source: Available["source"] }) {
  const listed = rows.reduce((s, r) => s + r.clicks, 0);
  if (!(totalClicks > 0) || listed >= totalClicks) return null;
  return (
    <p className="table-note gsc-hidden small">
      <Info size={14} aria-hidden />
      <span>
        <strong className="tnum">{fmtInt(listed)} des {fmtInt(totalClicks)} clics</strong> viennent de recherches que Google détaille ; les autres recherches, trop rares, sont masquées par Google pour protéger ceux qui les ont faites
        {source === "file" ? `, ou ne tiennent pas dans l'export (${fmtInt(1000)} recherches au plus).` : "."}
      </span>
    </p>
  );
}

function QueriesTable({ rows, mode, totalClicks, source }: { rows: OrganicQuery[]; mode: "all" | "reach"; totalClicks: number; source: Available["source"] }) {
  const [q, setQ] = useState("");
  const [shown, setShown] = useState(STEP);
  const list = useMemo(() => {
    let l = rows;
    if (mode === "reach") l = l.filter((r) => r.position > 3 && r.position <= 15).sort((a, b) => b.impressions - a.impressions);
    if (q) l = l.filter((r) => r.query.toLowerCase().includes(q.toLowerCase()));
    return l;
  }, [rows, q, mode]);
  return (
    <>
      <div className="toolbar">
        <label className="search pages__search">
          <Search size={15} aria-hidden />
          <span className="sr-only">Filtrer les recherches</span>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filtrer les recherches" />
        </label>
      </div>
      {mode === "reach" && <p className="table-note">Des recherches où vous apparaissez entre la 4ᵉ et la 15ᵉ place, triées par nombre d'affichages. Gagner quelques places sur elles rapporte vite des clics.</p>}
      <div className="table-scroll">
        <table className="table gsc-table">
          <thead>
            <tr>
              <th scope="col">Recherche</th>
              <th scope="col" className="num">Clics</th>
              <th scope="col" className="num">Impressions</th>
              <th scope="col" className="num col-ctr">Taux de clic</th>
              <th scope="col" className="num">Position</th>
            </tr>
          </thead>
          <tbody>
            {list.slice(0, shown).map((r) => (
              <tr key={r.query}>
                <td className="gsc-table__q" title={r.query.length > 60 ? r.query : undefined}><span className="query-clamp">{r.query}</span></td>
                <td className="num tnum">{fmtInt(r.clicks)}</td>
                <td className="num tnum">{fmtInt(r.impressions)}</td>
                <td className="num tnum col-ctr">{fmtPct(r.ctr)}</td>
                <td className="num tnum">{fmtPosition(r.position)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {list.length === 0 && <p className="muted table-empty">Aucune recherche ne correspond.</p>}
      {list.length > shown && <Button size="sm" variant="ghost" onClick={() => setShown((s) => s + STEP)} className="table-more">Afficher {Math.min(STEP, list.length - shown)} de plus</Button>}
      {mode === "all" && <HiddenQueriesNote rows={rows} totalClicks={totalClicks} source={source} />}
    </>
  );
}

function PagesTable({ rows, siteId }: { rows: OrganicPage[]; siteId: string }) {
  const [shown, setShown] = useState(STEP);
  return (
    <>
      <div className="table-scroll">
        <table className="table gsc-table">
          <thead>
            <tr>
              <th scope="col">Page</th>
              <th scope="col">Note</th>
              <th scope="col" className="num">Clics</th>
              <th scope="col" className="num">Impressions</th>
              <th scope="col" className="num col-ctr">Taux de clic</th>
              <th scope="col" className="num">Position</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, shown).map((r) => (
              <tr key={r.url}>
                <td className="gsc-table__q">
                  {r.pageId ? <Link to={sitePath(siteId, "pages", r.pageId)} className="mono gsc-table__path">{r.path}</Link> : <span className="mono gsc-table__path gsc-table__path--plain">{r.path}</span>}
                </td>
                <td>{r.score !== null ? <ScorePill score={r.score} /> : <span className="subtle small">Non analysée</span>}</td>
                <td className="num tnum">{fmtInt(r.clicks)}</td>
                <td className="num tnum">{fmtInt(r.impressions)}</td>
                <td className="num tnum col-ctr">{fmtPct(r.ctr)}</td>
                <td className="num tnum">{fmtPosition(r.position)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > shown && <Button size="sm" variant="ghost" onClick={() => setShown((s) => s + STEP)} className="table-more">Afficher {Math.min(STEP, rows.length - shown)} de plus</Button>}
    </>
  );
}

/** Rapprochement entre les pages de l'export et les pages analysées. */
function Matching({ data }: { data: Available }) {
  const m = data.matching;
  const from = data.source === "google" ? "des données lues chez Google" : "de l'export";
  if (!m) {
    return <p className="gsc-match muted small"><Link2 size={14} aria-hidden /> L'export ne contient pas la liste des pages : les clics ne peuvent pas être reliés aux pages analysées. Le fichier .zip complet la contient.</p>;
  }
  if (m.total === 0) return null;
  if (m.matched === 0) {
    return (
      <p className="gsc-match small">
        <Link2 size={14} aria-hidden />
        <span>
          <strong>Aucune des {fmtInt(m.total)} pages {from}</strong> ne correspond aux pages analysées : leurs clics ne peuvent pas être reliés à vos pages.
          <span className="muted"> Vérifiez que l'export vient bien de ce site, ou relancez l'analyse avec un plafond de pages plus élevé.</span>
        </span>
      </p>
    );
  }
  const rest = m.total - m.matched;
  return (
    <p className="gsc-match small">
      <Link2 size={14} aria-hidden />
      <span>
        <strong className="tnum">{fmtInt(m.matched)} {m.matched > 1 ? "pages" : "page"} sur {fmtInt(m.total)}</strong> {from} {m.matched > 1 ? "sont reliées" : "est reliée"} aux pages analysées : leurs clics apparaissent dans « Pages analysées ».
        {rest > 0 && <span className="muted"> {rest > 1 ? `Les ${fmtInt(rest)} autres n'ont pas été analysées` : "L'autre n'a pas été analysée"} (au-delà du plafond de pages, ou introuvable depuis les liens du site).</span>}
      </span>
    </p>
  );
}

function Imported({ data, site }: { data: Available; site: SiteSummary }) {
  const [tab, setTab] = useState<"queries" | "reach" | "pages">(data.queries ? "queries" : "pages");
  const reach = data.queries?.filter((r) => r.position > 3 && r.position <= 15).length ?? 0;
  const kpis = [
    { label: "Clics", value: fmtCompact(data.totals.clicks), hint: "Clics depuis les résultats de Google" },
    { label: "Impressions", value: fmtCompact(data.totals.impressions), hint: "Affichages dans les résultats" },
    { label: "Taux de clic", value: fmtPct(data.totals.ctr), hint: "Part des affichages suivis d'un clic" },
    { label: "Position moyenne", value: fmtPosition(data.totals.position), hint: "Rang moyen dans les résultats" },
  ];
  return (
    <>
      <dl className="kpis kpis--row kpis--band">
        {kpis.map((k) => (
          <div key={k.label} className="kpi">
            <dt className="kpi__label">{k.label}</dt>
            <dd className="kpi__value tnum">{k.value}</dd>
            <dd className="kpi__hint">{k.hint}</dd>
          </div>
        ))}
      </dl>

      <Matching data={data} />

      <Section id="series" title="Évolution jour par jour" description={data.period ? fmtPeriod(data.period) : undefined}>
        {data.series && data.series.length > 1 ? (
          <TrendChart series={data.series} />
        ) : (
          <p className="muted">L'export ne contient pas le détail par jour. Le fichier .zip complet de la Search Console le contient.</p>
        )}
      </Section>

      <Section id="detail" title="Recherches et pages">
        <div className="toolbar toolbar--tabs">
          <Tabs
            label="Afficher"
            value={tab}
            onChange={setTab}
            items={[
              ...(data.queries ? [{ id: "queries" as const, label: "Recherches", count: data.queries.length }, { id: "reach" as const, label: "À portée du haut", count: reach }] : []),
              ...(data.pages ? [{ id: "pages" as const, label: "Pages", count: data.pages.length }] : []),
            ]}
          />
        </div>
        {(tab === "queries" || tab === "reach") && data.queries && <QueriesTable key={tab} rows={data.queries} mode={tab === "reach" ? "reach" : "all"} totalClicks={data.totals.clicks} source={data.source} />}
        {tab === "pages" && data.pages && <PagesTable rows={data.pages} siteId={site.id} />}
        {!data.queries && !data.pages && <p className="muted">L'export ne contient ni les recherches ni les pages.</p>}
      </Section>
    </>
  );
}

export function TrafficScreen({ site }: { site: SiteSummary }) {
  const q = useSearchConsole(site.id);
  const google = useSettings().data?.integrations.searchConsole.configured === true;
  const g = useGoogleSync(site.id);
  const toast = useToast();
  const u = useUpload(site.id);
  const picker = useRef<HTMLInputElement>(null);
  const [deleting, setDeleting] = useState(false);
  const data = q.data;

  const remove = async () => {
    setDeleting(true);
    try {
      await sendJSON("DELETE", keys.searchConsole(site.id));
      setQueryData<SearchConsoleData>(keys.searchConsole(site.id), { available: false });
      patchSite(site.id, (s) => ({ ...s, searchConsole: { available: false, importedAt: null } }));
      invalidate(keys.overview(site.id));
      invalidate(keys.allPages(site.id));
      toast.show({ tone: "neutral", title: "Import supprimé" });
    } catch (err) {
      const e = toAppError(err);
      toast.show({ tone: "error", title: e.message, text: e.action });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Mots-clés et trafic organique"
        description="Ce que Google vous apporte : les recherches qui mènent à votre site, les pages sur lesquelles on clique, puis ce que font les visiteurs une fois arrivés."
        meta={data?.available ? (
          <span className="gsc-source small">
            <span className="gsc-source__tag">{data.source === "google" ? "Lu chez Google" : "Export déposé"}</span>
            <span className="muted">{data.source === "google" ? "Lu dans la Search Console" : "Importé"} le {fmtDateTime(data.importedAt)}{data.period ? `, données ${fmtPeriod(data.period)}` : ""}.</span>
          </span>
        ) : undefined}
        actions={
          data?.available ? (
            <>
              {google && <GoogleRead key={data.period ? `${data.period.start}_${data.period.end}` : "none"} initialDays={periodDaysOf(data.period)} g={g} compact replacesFile={data.source === "file" ? { importedAt: data.importedAt } : undefined} />}
              <Button icon={<Upload size={15} aria-hidden />} loading={u.busy} onClick={() => picker.current?.click()}>{data.source === "google" ? "Déposer un export" : "Remplacer l'export"}</Button>
              <ConfirmButton icon={<Trash2 size={15} aria-hidden />} confirmLabel="Confirmer la suppression" onConfirm={remove} loading={deleting}>Supprimer</ConfirmButton>
              <input ref={picker} type="file" accept={ACCEPT} className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void u.upload(f); e.target.value = ""; }} />
            </>
          ) : undefined
        }
      />
      <QueryError q={q} />
      {u.error && data?.available && <UploadError u={u} />}
      {g.error && data?.available && <div className="gsc-error gsc-error--top"><GoogleError g={g} /></div>}
      {!data && !q.error && (
        <>
          <LoadingLabel />
          <div className="kpis kpis--row kpis--band" aria-hidden>{Array.from({ length: 4 }, (_, i) => <div key={i} className="kpi"><Skeleton w="50%" h={10} /><div style={{ height: 8 }} /><Skeleton w="40%" h={24} /></div>)}</div>
          <div style={{ height: 40 }} />
          <Skeleton h={250} r={8} />
          <div style={{ height: 40 }} />
          <SkeletonRows rows={6} height={44} />
        </>
      )}
      {data && !data.available && <NoImport siteId={site.id} google={google} />}
      {data && data.available && <Imported data={data} site={site} />}
      {data?.available && <p className="muted small gsc-foot">{plural(data.queries?.length ?? 0, "recherche", "recherches")} et {plural(data.pages?.length ?? 0, "page", "pages")} {data.source === "google" ? "lues chez Google" : "dans l'export"}.</p>}
      {data && <VisitsChapter site={site} withGsc={data.available} />}
    </>
  );
}
