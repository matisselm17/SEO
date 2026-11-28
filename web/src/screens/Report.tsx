/**
 * « Rapport d'optimisation » d'un site : une page à garder ou à transmettre, imprimable proprement.
 * En-tête (site, dates de la première et de la dernière analyse), les chiffres de l'évolution
 * (GET …/progress), puis la liste des corrections vérifiées, lue dans l'historique de la boutique
 * (GET …/shopify/changes, pages parcourues jusqu'à un plafond). Les textes venus de la boutique sont du texte brut.
 */
import { ArrowLeft, Printer } from "lucide-react";
import type { ShopifyChange, ShopifyChangesResponse, SiteSummary } from "../lib/types";
import { keys, useProgress } from "../lib/queries";
import { useQuery } from "../lib/cache";
import { getJSON } from "../lib/api";
import { useShopifySection } from "../lib/features";
import { sitePath } from "../lib/router";
import { fmtDate, fmtDateTime, fmtInt, plural } from "../lib/format";
import { TYPE_LABEL, changeWhat } from "../lib/shopify";
import { PageHeader, Section } from "../ui/Section";
import { Button, ButtonLink } from "../ui/Button";
import { SkeletonRows, LoadingLabel } from "../ui/Skeleton";
import { EvolutionSkeleton, NoProgress, ProgressFigures, singleAnalysis } from "./Evolution";
import { QueryError } from "./common";

/** Corrections vérifiées affichées au plus, et modifications parcourues au plus pour les trouver. */
const SHOWN_MAX = 300;
const SCAN_MAX = 3000;
const CHUNK = 200;

interface Verified {
  changes: ShopifyChange[];
  /** Toutes les pages de l'historique ont été parcourues. */
  complete: boolean;
}

/** Sous le préfixe de la boutique : relu à l'événement « shopify » comme le reste de l'historique. */
const verifiedKey = (siteId: string) => `${keys.shopifyAll(siteId)}/changes#verified`;

const fetchers = new Map<string, (o: { signal: AbortSignal }) => Promise<{ data: Verified; etag: null; notModified: false }>>();
function verifiedFetcher(siteId: string) {
  let f = fetchers.get(siteId);
  if (f) return f;
  f = async ({ signal }) => {
    const found: ShopifyChange[] = [];
    let offset = 0;
    let complete = false;
    while (offset < SCAN_MAX && found.length < SHOWN_MAX) {
      const { data } = await getJSON<ShopifyChangesResponse>(`${keys.shopifyChangesPost(siteId)}?offset=${offset}&limit=${CHUNK}`, undefined, signal);
      if (!data) break;
      for (const c of data.changes) if (c.kind === "edit" && c.correctionStatus === "verified" && found.length < SHOWN_MAX) found.push(c);
      offset += data.changes.length;
      if (data.changes.length === 0 || offset >= data.total) {
        complete = true;
        break;
      }
    }
    return { data: { changes: found, complete }, etag: null, notModified: false };
  };
  fetchers.set(siteId, f);
  return f;
}

/** Valeur avant ou après : texte brut, « (vide) » quand le champ était ou est vide. */
function Value({ v }: { v: string | null }) {
  return v === null || v.trim() === "" ? <span className="rcorr__empty">(vide)</span> : <>{v}</>;
}

function VerifiedList({ siteId, total: counted }: { siteId: string; total: number }) {
  const q = useQuery<Verified>(counted > 0 ? verifiedKey(siteId) : null, verifiedFetcher(siteId));
  const d = q.data;
  // Le compteur et la liste viennent de deux lectures : si la liste en contient plus, c'est elle qui fait foi.
  const total = Math.max(counted, d?.changes.length ?? 0);
  if (total === 0) {
    return <p className="muted">Aucune correction n'a encore été constatée sur la page publique. Une correction est vérifiée quand la page relue affiche la nouvelle valeur et que le critère de la grille est validé.</p>;
  }
  return (
    <>
      <QueryError q={q} />
      {!d && !q.error && <><LoadingLabel /><SkeletonRows rows={4} height={88} /></>}
      {d && (
        <>
          <p className="rcorr__count small muted">
            {d.changes.length >= total
              ? total > 1 ? `${plural(total, "correction vérifiée", "corrections vérifiées")}, les plus récentes d'abord.` : "1 correction vérifiée."
              : `${fmtInt(d.changes.length)} ${d.changes.length > 1 ? "corrections affichées" : "correction affichée"} sur ${plural(total, "correction vérifiée", "corrections vérifiées")}, les plus récentes d'abord. La liste complète est dans l'historique de la boutique.`}
          </p>
          {d.changes.length > 0 && (
            <ol className="rcorr">
              {d.changes.map((c) => (
                <li key={c.id} className="rcorr__item">
                  <div className="rcorr__head">
                    <p className="rcorr__title">{c.resourceTitle}</p>
                    <p className="rcorr__meta">
                      <span>{TYPE_LABEL[c.resourceType].one}</span>
                      <span className="mono rcorr__path">{c.path}</span>
                      <span>{changeWhat(c)}{c.image ? " · image" : ""}</span>
                      <span>{fmtDateTime(c.appliedAt)}</span>
                    </p>
                  </div>
                  <div className="rcorr__values">
                    <div className="rcorr__value rcorr__value--before">
                      <span className="rcorr__k">Avant</span>
                      <p className="rcorr__text"><Value v={c.before} /></p>
                    </div>
                    <div className="rcorr__value rcorr__value--after">
                      <span className="rcorr__k">Après</span>
                      <p className="rcorr__text"><Value v={c.after} /></p>
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </>
  );
}

export function ReportScreen({ site }: { site: SiteSummary }) {
  const q = useProgress(site.id);
  const shopify = useShopifySection();
  const p = q.data?.progress;
  const today = new Date().toISOString();
  return (
    <div className="report">
      <div className="report__back no-print">
        <ButtonLink to={sitePath(site.id)} variant="ghost" size="sm" icon={<ArrowLeft size={15} aria-hidden />}>Vue d'ensemble</ButtonLink>
      </div>
      <PageHeader
        title="Rapport d'optimisation"
        description={<>Ce qui a changé sur <span className="mono-host">{site.host}</span> depuis que Chat SEO le suit : la note, les problèmes et les corrections constatées.</>}
        actions={p?.available ? <Button variant="primary" icon={<Printer size={15} aria-hidden />} onClick={() => window.print()} className="no-print">Imprimer ou enregistrer en PDF</Button> : undefined}
      />

      <dl className="report-meta">
        <div><dt>Site</dt><dd>{site.name}{site.name !== site.host && <span className="muted"> · {site.host}</span>}</dd></div>
        <div><dt>Première analyse</dt><dd>{p?.initial ? fmtDate(p.initial.finishedAt) : p ? "aucune" : "…"}</dd></div>
        <div><dt>Dernière analyse</dt><dd>{p?.current ? `${fmtDate(p.current.finishedAt)}${singleAnalysis(p) ? " (la seule terminée)" : ""}` : p ? "aucune" : "…"}</dd></div>
        <div><dt>Rapport établi le</dt><dd>{fmtDate(today)}</dd></div>
      </dl>

      <QueryError q={q} />
      {!p && !q.error && <EvolutionSkeleton />}
      {p && !p.available && <NoProgress site={site} />}
      {p?.available && p.current && (
        <>
          <Section id="report-evo" title="Évolution de la note" className="report__section">
            <ProgressFigures p={p} siteId={site.id} report />
          </Section>
          {shopify && (
            <Section
              id="report-verified"
              title="Corrections vérifiées"
              description="Corrections faites depuis Chat SEO dans la boutique, puis constatées sur la page publique : la page affiche la nouvelle valeur et le critère de la grille est validé."
              className="report__section"
            >
              <VerifiedList siteId={site.id} total={p.corrections.verified} />
            </Section>
          )}
        </>
      )}
    </div>
  );
}
