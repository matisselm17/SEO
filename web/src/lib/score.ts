import type { CategoryId, Effort, Impact, Severity } from "./types";

export type ScoreBand = "good" | "warning" | "critical";

/** Mêmes seuils que la grille de référence (sonde-seo). */
export function scoreBand(score: number): ScoreBand {
  if (score >= 70) return "good";
  if (score >= 50) return "warning";
  return "critical";
}

export function scoreVerdict(score: number): string {
  if (score >= 85) return "Très bon niveau";
  if (score >= 70) return "Base correcte";
  if (score >= 50) return "À renforcer";
  return "Fragile";
}

export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "Critique",
  warning: "À améliorer",
  info: "Mineur",
};

export const SEVERITY_ORDER: Severity[] = ["critical", "warning", "info"];

export const IMPACT_LABEL: Record<Impact, string> = { high: "Impact fort", medium: "Impact moyen", low: "Impact faible" };
export const EFFORT_LABEL: Record<Effort, string> = { quick: "Rapide", medium: "Quelques heures", heavy: "Travail de fond" };
export const EFFORT_HINT: Record<Effort, string> = {
  quick: "Un réglage unique, souvent dans le thème du site",
  medium: "Quelques pages à reprendre une par une",
  heavy: "Un travail de rédaction page par page",
};

export const CATEGORY_LABEL: Record<CategoryId, string> = {
  balises: "Balises",
  contenu: "Contenu",
  technique: "Technique",
  medias: "Liens et images",
  partage: "Partage social",
};

export const CATEGORY_HINT: Record<CategoryId, string> = {
  balises: "Titre, description et intertitres : ce que Google lit en premier",
  contenu: "Quantité et organisation du texte",
  technique: "Ce qui permet à Google de lire et d'afficher la page",
  medias: "Images décrites et liens entre vos pages",
  partage: "L'aperçu affiché quand on partage un lien",
};

/**
 * Doublons (même titre ou même description sur plusieurs pages) : ils ne changent pas la note.
 * Identifiés par leur identifiant ; à défaut, par un impact nul sans aucun point perdu.
 */
export function isDuplicateIssue(i: { id: string; scoreImpact: number; pointsLost: number; basis?: "pages" | "catalogue" }): boolean {
  if (i.basis === "catalogue") return false;
  return i.id.startsWith("duplicate_") || (i.scoreImpact === 0 && i.pointsLost === 0);
}

/** Constat fondé sur le catalogue de la boutique (produits dont la page n'a pas été ouverte). */
export function isCatalogueIssue(i: { basis?: "pages" | "catalogue" }): boolean {
  return i.basis === "catalogue";
}

export const CATALOGUE_NOTE =
  "Hors note : ces produits ont été lus dans le catalogue de la boutique, sans ouvrir leur page. Seules les pages ouvertes en entier sont notées. Mais ce que le catalogue contient est ce que Google affiche : le corriger compte quand même.";

export const DUPLICATE_NOTE =
  "Ne change pas la note : elle est calculée page par page. Mais des pages identiques dans Google se font concurrence, et l'internaute ne sait pas laquelle choisir.";
