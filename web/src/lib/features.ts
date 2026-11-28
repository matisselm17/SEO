/**
 * Sections facultatives (Settings.features) : point de vérité unique pour toute l'interface.
 *
 * Une section à `false` n'apparaît nulle part (navigation, blocs, liens, boutons, textes qui la citent),
 * son adresse directe mène à la Vue d'ensemble, et ses routes ne sont jamais appelées (elles répondent 403).
 * Tant que les réglages ne sont pas chargés, aucune de ces sections n'est affichée : elles ne peuvent donc
 * pas apparaître puis disparaître.
 *
 *   competitors        section Concurrents
 *   analytics          visites Google Analytics (Mots-clés et trafic, fiche d'une page)
 *   pageSpeed          vitesse des pages (Audit SEO, fiche d'une page)
 *   assistant          Assistant IA, et tout bouton ou renvoi vers lui
 *   searchConsoleSync  seulement la lecture directe « Lire depuis Google » (le dépôt de l'export reste)
 */
import type { Settings } from "./types";
import type { SectionName } from "./router";
import { useSettings } from "./queries";

export type Feature = keyof Settings["features"];
export type Features = Settings["features"];

const NONE: Features = { competitors: false, analytics: false, pageSpeed: false, assistant: false, searchConsoleSync: false };

/** Sections de la navigation qui dépendent d'un drapeau. */
export const SECTION_FEATURE: Partial<Record<SectionName, Feature>> = {
  competitors: "competitors",
  assistant: "assistant",
};

/** Drapeaux lus dans les réglages. `ready` : les réglages sont chargés. Avant cela, tout vaut `false`. */
export function useFeatures(): { ready: boolean; on: Features; error: boolean } {
  const q = useSettings();
  const f = q.data?.features;
  return { ready: !!f, on: f ?? NONE, error: !f && !!q.error };
}

/** Une section facultative est-elle présente ? `false` tant que les réglages ne sont pas chargés. */
export function useFeature(name: Feature): boolean {
  return useFeatures().on[name];
}

/**
 * Une section de la navigation est-elle visible ? `null` : on ne le sait pas encore (réglages non chargés).
 * Les sections sans drapeau sont toujours visibles.
 */
export function sectionState(section: SectionName, f: { ready: boolean; on: Features }): boolean | null {
  const flag = SECTION_FEATURE[section];
  if (!flag) return true;
  if (!f.ready) return null;
  return f.on[flag];
}

/** La section Boutique Shopify existe-t-elle (boutique configurée côté serveur) ? */
export function useShopifySection(): boolean {
  return useSettings().data?.integrations.shopify?.configured === true;
}
