/** Petits éléments partagés par les écrans de la boutique (évite les imports circulaires entre écrans). */
import { useRef } from "react";

/** Identifiant du bandeau « Lecture seule », dit une fois pour toute la section ; les boutons désactivés y renvoient. */
export const READONLY_ID = "shop-readonly";

/** Garde la dernière donnée affichée pendant le chargement d'un nouveau filtre : pas de saut de mise en page. */
export function useSticky<T>(value: T | undefined): T | undefined {
  const ref = useRef(value);
  if (value !== undefined) ref.current = value;
  return value ?? ref.current;
}
