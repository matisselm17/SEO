/**
 * Évolution du site (GET /api/sites/:siteId/progress) : bloc de la Vue d'ensemble et chiffres du
 * « Rapport d'optimisation ». Tout chiffre affiché vient d'un champ de `Progress` (ou est l'écart entre deux
 * de ces champs) : rien n'est estimé, aucun pourcentage n'est calculé.
 */
import { ArrowRight, CircleAlert, CircleCheck, CircleDashed, FileText, Undo2, TriangleAlert, type LucideIcon } from "lucide-react";
import type { Progress, ProgressPoint, SiteSummary } from "../lib/types";
import { useProgress } from "../lib/queries";
import { useShopifySection } from "../lib/features";
import { sitePath } from "../lib/router";
import { fmtDate, fmtInt, fmtShortDate, pl, plural } from "../lib/format";
import { Section } from "../ui/Section";
import { Link } from "../ui/Button";
import { Skeleton } from "../ui/Skeleton";
import { ScoreTimeline } from "../ui/ScoreTimeline";
import { AuditButton, QueryError, isRunning } from "./common";

type Comparison = NonNullable<Progress["comparison"]>;
type Corrections = Progress["corrections"];

/** Une seule analyse terminée : `initial` et `current` sont la même. */
export const singleAnalysis = (p: Progress) => !!p.current && (!p.initial || p.initial.auditId === p.current.auditId);

export const reportPath = (siteId: string) => sitePath(siteId, "report");

function Delta({ from, to }: { from: number; to: number }) {
  const d = to - from;
  if (d === 0) return <span className="delta delta--flat">Note inchangée</span>;
  return <span className={`delta ${d > 0 ? "delta--up" : "delta--down"}`}>{d > 0 ? "+" : "−"}{plural(Math.abs(d), "point", "points")}</span>;
}

function Step({ label, point, now }: { label: string; point: ProgressPoint; now?: boolean }) {
  return (
    <div className={`journey__step ${now ? "journey__step--now" : ""}`}>
      <span className="journey__label">{label}</span>
      <span className="journey__value tnum">{point.score}<span className="journey__max">/100</span></span>
      <span className="journey__meta">{fmtShortDate(point.finishedAt)} · {plural(point.pagesAnalyzed, "page", "pages")}</span>
    </div>
  );
}

/** Note de la première analyse → note de la dernière, sur toutes leurs pages. */
function Journey({ p }: { p: Progress }) {
  const cur = p.current!;
  if (singleAnalysis(p)) {
    return (
      <div className="journey">
        <Step label="Note actuelle" point={cur} now />
      </div>
    );
  }
  const ini = p.initial!;
  return (
    <div className="journey">
      <Step label="Première analyse" point={ini} />
      <ArrowRight size={18} className="journey__arrow" aria-label="puis" />
      <Step label="Dernière analyse" point={cur} now />
      <Delta from={ini.score} to={cur.score} />
    </div>
  );
}

function Stat({ icon: Icon, tone, label, value, hint }: { icon: LucideIcon; tone: "good" | "warning" | "critical" | "info" | "neutral"; label: string; value: number; hint?: string }) {
  return (
    <div className={`evo-stat evo-stat--${tone}`}>
      <dt className="evo-stat__label"><Icon size={15} strokeWidth={2.25} aria-hidden className="evo-stat__icon" />{label}</dt>
      <dd className="evo-stat__value tnum">{fmtInt(value)}</dd>
      {hint && <dd className="evo-stat__hint">{hint}</dd>}
    </div>
  );
}

/** Comparaison à périmètre égal : seulement les pages présentes dans les deux analyses. */
function ComparisonBlock({ c }: { c: Comparison }) {
  const outside = c.pagesOnlyInitial + c.pagesOnlyCurrent;
  return (
    <div className="evo-block">
      <h3 className="evo-block__title">À périmètre égal</h3>
      <p className="evo-block__lead">
        Sur {plural(c.pagesInCommon, "page commune", "pages communes")} aux deux analyses, la note moyenne {c.scoreInitial === c.scoreCurrent ? <>reste à <strong className="tnum">{c.scoreCurrent}</strong></> : <>passe de <strong className="tnum">{c.scoreInitial}</strong> à <strong className="tnum">{c.scoreCurrent}</strong></>}.
      </p>
      <dl className="evo-stats">
        <Stat icon={CircleCheck} tone="good" label={pl(c.issuesFixed, "Problème corrigé", "Problèmes corrigés")} value={c.issuesFixed} />
        <Stat icon={CircleDashed} tone="warning" label={pl(c.issuesRemaining, "Toujours présent", "Toujours présents")} value={c.issuesRemaining} />
        <Stat icon={TriangleAlert} tone="critical" label={pl(c.issuesNew, "Nouveau problème", "Nouveaux problèmes")} value={c.issuesNew} />
      </dl>
      <p className="evo-block__foot">
        Un problème est un critère de la grille en défaut sur une page.
        {outside > 0 && (
          <> {[
            c.pagesOnlyInitial > 0 ? `${plural(c.pagesOnlyInitial, "page vue", "pages vues")} seulement à la première analyse` : null,
            c.pagesOnlyCurrent > 0 ? `${plural(c.pagesOnlyCurrent, "page vue", "pages vues")} seulement à la dernière` : null,
          ].filter(Boolean).join(" et ")} {pl(outside, "n'entre", "n'entrent")} pas dans cette comparaison.</>
        )}
      </p>
    </div>
  );
}

/** Ce qui remplace la comparaison quand elle n'existe pas. */
function NoComparison({ p }: { p: Progress }) {
  return (
    <div className="evo-block">
      <h3 className="evo-block__title">À périmètre égal</h3>
      <p className="evo-block__lead">
        {singleAnalysis(p)
          ? "La comparaison apparaîtra après la prochaine analyse."
          : "La comparaison page par page n'est pas disponible pour ces deux analyses : elles n'ont aucune page en commun, ou le détail des pages de la première n'est plus conservé."}
      </p>
    </div>
  );
}

function CorrectionsBlock({ c, siteId }: { c: Corrections; siteId: string }) {
  const total = c.verified + c.applied + c.failed + c.cancelled;
  return (
    <div className="evo-block">
      <h3 className="evo-block__title">Corrections dans la boutique</h3>
      {total === 0 ? (
        <p className="evo-block__lead">
          Aucune correction appliquée depuis Chat SEO pour l'instant. Les titres, descriptions et textes d'images se corrigent depuis la section{" "}
          <Link to={sitePath(siteId, "shopify")} className="text-link">Boutique Shopify</Link>.
        </p>
      ) : (
        <>
          <dl className="evo-stats evo-stats--four">
            <Stat icon={CircleCheck} tone="good" label={pl(c.verified, "Vérifiée", "Vérifiées")} value={c.verified} hint="Constatée sur la page publique" />
            <Stat icon={CircleDashed} tone="info" label="En place" value={c.applied} hint="Pas encore vérifiée sur la page" />
            <Stat icon={CircleAlert} tone="critical" label={pl(c.failed, "Échouée", "Échouées")} value={c.failed} hint="Non constatée sur la page" />
            <Stat icon={Undo2} tone="neutral" label={pl(c.cancelled, "Annulée", "Annulées")} value={c.cancelled} hint="Valeur d'avant remise" />
          </dl>
          <p className="evo-block__foot">
            {c.resourcesOptimized > 0
              ? `${plural(c.resourcesOptimized, "élément de la boutique a", "éléments de la boutique ont")} au moins une correction vérifiée.`
              : "Aucun élément de la boutique n'a encore de correction vérifiée."}
            {c.firstAt && c.lastAt && (c.firstAt.slice(0, 10) === c.lastAt.slice(0, 10)
              ? ` Corrections en place appliquées le ${fmtDate(c.lastAt)}.`
              : ` Corrections en place appliquées du ${fmtDate(c.firstAt)} au ${fmtDate(c.lastAt)}.`)}
          </p>
        </>
      )}
    </div>
  );
}

/** Note, courbe, comparaison et bilan des corrections : le cœur commun du bloc et du rapport. */
export function ProgressFigures({ p, siteId, report }: { p: Progress; siteId: string; report?: boolean }) {
  const shopify = useShopifySection();
  return (
    <div className={`evo ${report ? "evo--report" : ""}`}>
      <div className="evo__main">
        <Journey p={p} />
        {!singleAnalysis(p) && p.current && p.initial && p.current.pagesAnalyzed !== p.initial.pagesAnalyzed && (
          <p className="evo__note">Chaque note porte sur toutes les pages de son analyse, qui n'en a pas ouvert le même nombre : la comparaison à périmètre égal ne garde que les pages communes.</p>
        )}
        {singleAnalysis(p) && <p className="evo__note">La comparaison apparaîtra après la prochaine analyse.</p>}
        <ScoreTimeline points={p.timeline} />
      </div>
      <div className="evo__side">
        {p.comparison ? <ComparisonBlock c={p.comparison} /> : !singleAnalysis(p) && <NoComparison p={p} />}
        {shopify && <CorrectionsBlock c={p.corrections} siteId={siteId} />}
      </div>
    </div>
  );
}

export function EvolutionSkeleton() {
  return (
    <div className="evo" aria-hidden>
      <div className="evo__main"><Skeleton w={260} h={44} /><div style={{ height: 20 }} /><Skeleton h={184} r={8} /></div>
      <div className="evo__side"><Skeleton w="50%" h={14} /><div style={{ height: 12 }} /><Skeleton h={88} r={8} /></div>
    </div>
  );
}

/** Aucune analyse terminée : ce qui manque et comment l'obtenir. */
export function NoProgress({ site }: { site: SiteSummary }) {
  return (
    <div className="evo-empty">
      <p className="evo-empty__title">L'évolution apparaîtra à la fin de la première analyse</p>
      <p className="evo-empty__text">
        {isRunning(site)
          ? "Une analyse est en cours : dès qu'elle sera terminée, sa note deviendra le point de départ de la courbe. Chaque analyse suivante y ajoutera un point."
          : site.audit?.state === "failed" && site.audit.error
            ? `La dernière analyse n'a pas abouti : ${site.audit.error.message} Relancez-la quand c'est réglé : sa note deviendra le point de départ de la courbe.`
            : "Lancez une analyse et laissez-la aller jusqu'au bout : sa note deviendra le point de départ de la courbe. Chaque analyse suivante y ajoutera un point."}
      </p>
      <div className="evo-empty__actions"><AuditButton site={site} /></div>
    </div>
  );
}

/** Bloc « Évolution » de la Vue d'ensemble. */
export function EvolutionSection({ site }: { site: SiteSummary }) {
  const q = useProgress(site.id);
  const p = q.data?.progress;
  return (
    <Section
      id="evolution"
      title="Évolution"
      description={p?.available && p.initial ? (singleAnalysis(p) ? `Première analyse terminée le ${fmtDate(p.initial.finishedAt)}.` : `Depuis la première analyse, le ${fmtDate(p.initial.finishedAt)}.`) : undefined}
      actions={p?.available ? <Link to={reportPath(site.id)} className="text-link evo__report-link"><FileText size={15} aria-hidden />Rapport d'optimisation</Link> : undefined}
    >
      <QueryError q={q} />
      {!p && !q.error && <EvolutionSkeleton />}
      {p && !p.available && <NoProgress site={site} />}
      {p?.available && p.current && <ProgressFigures p={p} siteId={site.id} />}
    </Section>
  );
}
