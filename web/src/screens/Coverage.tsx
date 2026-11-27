import { useState, type ReactNode } from "react";
import { Globe, Layers } from "lucide-react";
import type { Coverage, CoverageRow, SiteSummary } from "../lib/types";
import { fmtInt, pl, plural } from "../lib/format";
import { scoreBand } from "../lib/score";
import { localeName } from "../lib/pagetype";
import { startAudit } from "../lib/actions";
import { useSettings } from "../lib/queries";
import { Section } from "../ui/Section";
import { ScorePill } from "../ui/Badge";
import { Meter } from "../ui/Meter";
import { Button } from "../ui/Button";
import { useToast } from "../ui/Toast";
import { isRunning } from "./common";
import { isRelaunching } from "../lib/results";

/** Produits de l'inventaire ni ouverts ni lus (catalogue inaccessible). */
function productsNotCovered(c: Coverage): number {
  const row = c.rows.find((r) => r.type === "product");
  if (!row || row.onSite === null) return 0;
  return Math.max(0, row.onSite - row.analyzed - row.viaCatalogue - row.failed);
}

/** La phrase qui dit d'un coup d'œil ce que l'analyse couvre. */
function coverageSentence(c: Coverage): { lead: ReactNode; tail: string | null } {
  const t = c.totals;
  if (c.inventory === "links") {
    return {
      lead: (
        <>
          <strong className="tnum">{plural(t.analyzed, "page ouverte", "pages ouvertes")} en entier</strong>, trouvée{t.analyzed > 1 ? "s" : ""} en suivant les liens du site.
        </>
      ),
      tail: null,
    };
  }
  if (c.complete && t.onSite !== null) {
    if (t.failed > 0) {
      return {
        lead: (
          <>
            <strong>Toutes les pages du site ont été traitées</strong> : {plural(t.analyzed, "page ouverte", "pages ouvertes")} en entier, {fmtInt(t.failed)} {t.failed > 1 ? "n'ont" : "n'a"} pas pu être {t.failed > 1 ? "chargées" : "chargée"}.
          </>
        ),
        tail: null,
      };
    }
    return { lead: <><strong className="tnum">{t.onSite > 1 ? `Les ${fmtInt(t.onSite)} pages` : "La page"} du site</strong> {t.onSite > 1 ? "ont été ouvertes" : "a été ouverte"} en entier.</>, tail: null };
  }
  if (c.catalogue === "read" && t.viaCatalogue > 0) {
    const covered = t.analyzed + t.viaCatalogue;
    const rest = t.onSite !== null ? t.onSite - covered - t.failed : 0;
    return {
      lead: (
        <>
          <strong className="tnum">{fmtInt(covered)} pages couvertes</strong> : {fmtInt(t.analyzed)} {pl(t.analyzed, "ouverte", "ouvertes")} en entier, {plural(t.viaCatalogue, "produit lu", "produits lus")} dans le catalogue.
        </>
      ),
      tail:
        t.onSite !== null
          ? rest > 0
            ? `Le site en compte ${fmtInt(t.onSite)} d'après son plan : ${plural(rest, "page n'est", "pages ne sont")} pas couverte${rest > 1 ? "s" : ""}.`
            : "Tout le site est couvert, mais seules les pages ouvertes en entier comptent dans la note."
          : null,
    };
  }
  return {
    lead: (
      <>
        <strong className="tnum">{plural(t.analyzed, "page ouverte", "pages ouvertes")} en entier</strong> sur {fmtInt(t.onSite ?? 0)} inventoriées.
      </>
    ),
    tail: null,
  };
}

/** Ce que l'analyse ne couvre pas, et l'analyse complète quand elle est possible. */
function FullAudit({ c, site }: { c: Coverage; site: SiteSummary }) {
  const toast = useToast();
  const settings = useSettings();
  const [busy, setBusy] = useState(false);
  if (c.complete) return null;
  if (c.inventory === "links") {
    return (
      <p className="cov__aside">
        Le site ne publie pas de plan (sitemap) : son nombre total de pages est inconnu. Seules les pages trouvées en suivant les liens sont comptées, et rien ne permet de dire s'il en manque.
      </p>
    );
  }
  const notCovered = c.catalogue === "unavailable" ? productsNotCovered(c) : 0;
  const unavailable = c.catalogue === "unavailable" && (
    <p className="cov__aside cov__aside--warn">
      Le catalogue de cette boutique n'est pas accessible : {notCovered > 0 ? `${plural(notCovered, "produit dont la page n'a pas été ouverte n'est", "produits dont la page n'a pas été ouverte ne sont")} pas couverts` : "les produits dont la page n'a pas été ouverte ne sont pas couverts"} — ni notés, ni vérifiés.
    </p>
  );
  const n = c.fullAuditMaxPages;
  if (n === null) {
    // Cas normal pour un grand site : le plafond d'une analyse est atteint.
    const max = settings.data?.maxPagesLimits.max;
    return (
      <>
        {unavailable}
        <p className="cov__aside">
          {max ? `Une analyse ouvre au plus ${fmtInt(max)} pages` : "Une analyse ouvre un nombre limité de pages"} : elles sont choisies type par type, pour que chacun soit représenté dans la note.
          {c.catalogue === "read" && c.totals.viaCatalogue > 0 ? " Les produits restants sont lus dans le catalogue de la boutique : leurs problèmes sont signalés dans l'audit, hors note." : ""}
        </p>
      </>
    );
  }
  return (
    <>
      {unavailable}
      <div className="cov__full">
        <p>
          <strong>Pour une note sur tout le site</strong>, ouvrez les {fmtInt(n)} pages en entier. L'analyse sera plus longue ; les résultats actuels restent affichés jusqu'à sa fin.
        </p>
        {isRunning(site) ? (
          <span className="muted small">Une analyse est en cours : sa progression s'affiche en haut de l'écran.</span>
        ) : (
          <Button
            variant="primary"
            size="sm"
            icon={<Layers size={14} aria-hidden />}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              await startAudit(site.id, n, toast);
              setBusy(false);
            }}
          >
            Analyser les {fmtInt(n)} pages
          </Button>
        )}
      </div>
    </>
  );
}

function Num({ n, label, zero = "0" }: { n: number | null; label: string; zero?: string }) {
  if (n === null) return <span className="subtle" title="L'inventaire ne permet pas de le dire">—<span className="sr-only">inconnu</span></span>;
  return <span className={n === 0 ? "subtle" : undefined} aria-label={`${fmtInt(n)} ${label}`}>{n === 0 ? zero : fmtInt(n)}</span>;
}

function TypeScore({ row }: { row: CoverageRow }) {
  if (row.score === null) return <span className="subtle small">Non notée</span>;
  return (
    <span className="cov__score">
      <ScorePill score={row.score} />
      <Meter value={row.score} max={100} tone={scoreBand(row.score)} />
    </span>
  );
}

/**
 * Couverture de l'analyse : sur quoi repose la note, par type de page, et ce qui n'a pas été ouvert.
 * La note par type rend comparables les familles de pages (c'est elle qui explique un écart).
 */
/** Langues distinctes : « de » et « de-DE » ne font qu'une (allemand). */
function distinctLanguages(codes: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of codes) {
    const base = c.toLowerCase().split(/[-_]/)[0];
    if (!base || seen.has(base)) continue;
    seen.add(base);
    out.push(localeName(base));
  }
  return out;
}

export function CoverageSection({ coverage: c, site, scoreValue }: { coverage: Coverage; site: SiteSummary; scoreValue: number | null }) {
  // Colonne et définition du catalogue seulement quand des produits y ont été lus.
  const showCatalogue = c.catalogue === "read" && c.totals.viaCatalogue > 0;
  const showFailed = c.totals.failed > 0;
  // Inventaire inconnu : la colonne « Sur le site » ne contiendrait que des tirets.
  const showOnSite = c.totals.onSite !== null;
  const { lead, tail } = coverageSentence(c);
  const langs = distinctLanguages(c.otherLocales);
  // Première analyse en cours : la couverture se complète au fil des pages, rien n'est encore à proposer.
  const provisional = isRunning(site) && !isRelaunching(site);
  // L'écart entre types n'est cité que pour des types assez fournis (au moins 3 pages notées).
  const scored = c.rows.filter((r) => r.score !== null && r.analyzed >= 3);
  const low = scored.length >= 2 ? scored.reduce((a, b) => ((b.score ?? 0) < (a.score ?? 0) ? b : a)) : null;
  const high = scored.length >= 2 ? scored.reduce((a, b) => ((b.score ?? 0) > (a.score ?? 0) ? b : a)) : null;

  return (
    <Section id="coverage" title="Ce que couvre l'analyse" description="Sur quelles pages repose la note, type par type.">
      <div className="cov">
        <div className="cov__summary">
          <p className="cov__lead">{lead}</p>
          <p className="cov__basis">
            {scoreValue !== null && <>La note de <strong className="tnum">{scoreValue} / 100</strong> est la moyenne des {plural(c.totals.analyzed, "page ouverte", "pages ouvertes")} en entier. </>}
            {tail}
            {!provisional && low && high && (high.score ?? 0) - (low.score ?? 0) >= 8 && (
              <> Selon le type de page, la note va de <strong className="tnum">{low.score}</strong> ({low.label.toLowerCase()}) à <strong className="tnum">{high.score}</strong> ({high.label.toLowerCase()}) : c'est ce qui explique l'écart entre un échantillon et le site entier.</>
            )}
          </p>
          {provisional ? (
            <p className="cov__aside">Analyse en cours : ces chiffres se complètent au fil des pages, jusqu'au plafond de l'analyse.</p>
          ) : (
            <FullAudit c={c} site={site} />
          )}
        </div>

        <dl className="cov__defs">
          <div>
            <dt>Ouverte en entier</dt>
            <dd>La page est chargée comme dans un navigateur et vérifiée sur toute la grille. Elle compte dans la note.</dd>
          </div>
          {showCatalogue && (
            <div>
              <dt>Lue via le catalogue</dt>
              <dd>Pour les produits d'une boutique Shopify, le titre, la description et les images sont lus dans le catalogue public, sans ouvrir la page. Les problèmes trouvés sont signalés, mais n'entrent pas dans la note.</dd>
            </div>
          )}
        </dl>
      </div>

      <div className="table-scroll cov__tablewrap">
        <table className="table cov__table">
          <caption className="sr-only">Couverture par type de page</caption>
          <thead>
            <tr>
              <th scope="col">Type de page</th>
              {showOnSite && <th scope="col" className="num">Sur le site</th>}
              <th scope="col" className="num">Ouvertes en entier</th>
              {showCatalogue && <th scope="col" className="num">Via le catalogue</th>}
              {showFailed && <th scope="col" className="num">Non chargées</th>}
              <th scope="col">Note du type</th>
            </tr>
          </thead>
          <tbody>
            {c.rows.map((r) => (
              <tr key={r.type}>
                <th scope="row" className="cov__type">{r.label}</th>
                {showOnSite && <td className="num tnum" data-label="Sur le site"><Num n={r.onSite} label="sur le site" /></td>}
                <td className="num tnum" data-label="Ouvertes en entier"><Num n={r.analyzed} label="ouvertes en entier" /></td>
                {showCatalogue && <td className={`num tnum ${r.viaCatalogue === 0 ? "is-zero" : ""}`} data-label="Via le catalogue"><Num n={r.viaCatalogue} label="via le catalogue" zero="—" /></td>}
                {showFailed && <td className={`num tnum ${r.failed === 0 ? "is-zero" : ""}`} data-label="Non chargées"><Num n={r.failed} label="non chargées" zero="—" /></td>}
                <td data-label="Note du type"><TypeScore row={r} /></td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Total</th>
              {showOnSite && <td className="num tnum" data-label="Sur le site"><Num n={c.totals.onSite} label="sur le site" /></td>}
              <td className="num tnum" data-label="Ouvertes en entier">{fmtInt(c.totals.analyzed)}</td>
              {showCatalogue && <td className="num tnum" data-label="Via le catalogue"><Num n={c.totals.viaCatalogue} label="via le catalogue" zero="—" /></td>}
              {showFailed && <td className="num tnum" data-label="Non chargées">{fmtInt(c.totals.failed)}</td>}
              <td data-label="Note du site">{scoreValue !== null ? <ScorePill score={scoreValue} /> : <span className="subtle small">—</span>}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {langs.length > 0 && (
        <p className="cov__locales">
          <Globe size={14} aria-hidden />
          <span>
            {langs.length > 1 ? "Autres versions de langue détectées" : "Autre version de langue détectée"} : {langs.join(", ")}.{" "}
            <span className="muted">
              {langs.length > 1 ? "Elles ne sont" : "Elle n'est"} ni {langs.length > 1 ? "analysées" : "analysée"} ni {langs.length > 1 ? "comptées" : "comptée"} : l'analyse porte sur la version {c.mainLocale ? `en ${localeName(c.mainLocale.split(/[-_]/)[0])}` : "principale"}.
            </span>
          </span>
        </p>
      )}
    </Section>
  );
}
