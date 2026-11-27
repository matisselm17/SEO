/**
 * Couverture d'une analyse (Coverage) : ce que le site contient d'après son inventaire, par type de page,
 * et ce qui a réellement été ouvert, lu dans le catalogue ou n'a pas pu être chargé.
 * L'état de l'inventaire est écrit par le parcours (audits.coverage_json) ; les décomptes de pages notées
 * et en échec sont lus dans la base, donc toujours à jour pendant l'analyse.
 */
import type { Coverage, CoverageRow, PageType } from "../../shared/api.ts";
import { PAGE_TYPE_LABELS, PAGE_TYPES } from "./crawl/inventory.ts";

/** Ce que le parcours sait de l'inventaire, enregistré au fil de l'analyse. */
export interface CoverageState {
  platform: "shopify" | null;
  inventory: "sitemap" | "links";
  mainLocale: string | null;
  otherLocales: string[];
  /**
   * Pages connues par type, dans la langue principale : l'inventaire du sitemap, plus les pages notées hors
   * inventaire et les produits du catalogue absents du sitemap (ces pages existent : elles ont été chargées ou lues).
   */
  counts: Partial<Record<PageType, number>>;
  /** Types dont le décompte n'est pas fiable ; "all" sans inventaire exploitable. */
  unknown: PageType[] | "all";
  /** Pages inventoriées, accueil compris : le plafond qui permet de toutes les ouvrir. null sans inventaire. */
  inventoryTotal: number | null;
  /** Pages inventoriées qui n'ont pas encore été chargées (ni ouvertes, ni en échec). null sans inventaire. */
  pending: number | null;
  /** Produits lus dans le catalogue sans que leur page soit ouverte. */
  viaCatalogue: number;
  /** Lecture du catalogue (Coverage.catalogue) ; absent des états écrits avant ce champ, lu comme null. */
  catalogue?: Coverage["catalogue"];
}

/** État par défaut d'une analyse antérieure à l'inventaire (base migrée) : rien n'est connu au-delà des pages chargées. */
export function legacyState(mainLocale: string | null): CoverageState {
  return { platform: null, inventory: "links", mainLocale, otherLocales: [], counts: {}, unknown: "all", inventoryTotal: null, pending: null, viaCatalogue: 0, catalogue: null };
}

export interface TypeStats {
  analyzed: Map<PageType, { count: number; scoreSum: number }>;
  failed: Map<PageType, number>;
}

export function buildCoverage(state: CoverageState, stats: TypeStats, maxPagesLimit: number): Coverage {
  const unknownAll = state.inventory === "links" || state.unknown === "all";
  const unknown = new Set<PageType>(Array.isArray(state.unknown) ? state.unknown : []);
  const rows: CoverageRow[] = [];
  for (const type of PAGE_TYPES) {
    const a = stats.analyzed.get(type);
    const analyzed = a?.count ?? 0;
    const failed = stats.failed.get(type) ?? 0;
    const viaCatalogue = type === "product" ? state.viaCatalogue : 0;
    const known = state.counts[type] ?? 0;
    const onSite = unknownAll || unknown.has(type) ? null : known;
    // Une ligne par type présent sur le site ou dans l'analyse ; un type au décompte incertain est montré comme tel.
    if (!analyzed && !failed && !viaCatalogue && !known && !(unknown.has(type) && !unknownAll)) continue;
    rows.push({
      type,
      label: PAGE_TYPE_LABELS[type],
      onSite,
      analyzed,
      viaCatalogue,
      failed,
      score: analyzed ? Math.round(a!.scoreSum / analyzed) : null,
    });
  }
  const sum = (f: (r: CoverageRow) => number) => rows.reduce((acc, r) => acc + f(r), 0);
  const totalsOnSite = unknownAll || rows.some((r) => r.onSite === null) ? null : sum((r) => r.onSite ?? 0);
  const inventoryKnown = !unknownAll && unknown.size === 0 && state.inventoryTotal !== null;
  const complete = inventoryKnown && state.pending === 0;
  const fullAuditMaxPages =
    !complete && inventoryKnown && state.inventoryTotal! >= 1 && state.inventoryTotal! <= maxPagesLimit ? state.inventoryTotal : null;
  const otherLocales = [...new Set(state.otherLocales.map((l) => l.toLowerCase().replace("_", "-")))]
    .filter((l) => /^[a-z]{2,3}(-[a-z0-9]{2,4})?$/.test(l) && l !== state.mainLocale)
    .sort();
  return {
    platform: state.platform,
    catalogue: state.platform === "shopify" ? (state.catalogue ?? null) : null,
    inventory: state.inventory,
    rows,
    totals: { onSite: totalsOnSite, analyzed: sum((r) => r.analyzed), viaCatalogue: sum((r) => r.viaCatalogue), failed: sum((r) => r.failed) },
    complete,
    mainLocale: state.mainLocale,
    otherLocales,
    fullAuditMaxPages,
  };
}
