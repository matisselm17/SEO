/**
 * Lot en préparation, dans le navigateur, avant d'être envoyé au serveur comme brouillon.
 * On y ajoute des lignes depuis la liste des éléments (sélection + champ) ou depuis la fiche d'un élément
 * (« Ajouter au lot »). Chaque ligne a sa propre valeur : il n'existe aucune saisie appliquée en masse.
 * Gardé pour l'onglet (sessionStorage), jamais ailleurs ; rien n'est écrit dans la boutique à ce stade.
 */
import { useSyncExternalStore } from "react";
import type { CheckStatus, ShopifyField, ShopifyResourceType } from "./types";

export interface DraftLine {
  /** Élément, champ, image et langue : deux lignes ne visent jamais le même champ (règle du serveur). */
  key: string;
  resourceId: string;
  resourceType: ShopifyResourceType;
  title: string;
  path: string;
  field: ShopifyField;
  imageId: string | null;
  imageUrl: string | null;
  imageIndex: number | null;
  locale: string | null;
  /** Valeur vue dans Shopify au moment de l'ajout (le serveur la relira lui-même à la création). */
  current: string | null;
  /** Ce que l'analyse a vu sur la page affichée, pour ce champ ; null si la page n'a pas été ouverte. */
  rendered: { text: string | null; status: CheckStatus } | null;
  value: string;
}

/** Un lot compte au plus 50 lignes (format d'échange). */
export const MAX_LINES = 50;

export const lineKey = (resourceId: string, field: ShopifyField, imageId: string | null, locale: string | null) => `${resourceId}|${field}|${imageId ?? ""}|${locale ?? ""}`;

const storeKey = (siteId: string) => `lot-en-preparation:${siteId}`;
const cache = new Map<string, DraftLine[]>();
const listeners = new Set<() => void>();
const EMPTY: DraftLine[] = [];

function read(siteId: string): DraftLine[] {
  const hit = cache.get(siteId);
  if (hit) return hit;
  let lines: DraftLine[] = EMPTY;
  try {
    const raw = sessionStorage.getItem(storeKey(siteId));
    const parsed = raw ? (JSON.parse(raw) as DraftLine[]) : null;
    if (Array.isArray(parsed)) lines = parsed.filter((l) => l && typeof l.key === "string" && typeof l.value === "string").slice(0, MAX_LINES);
  } catch {
    /* stockage indisponible : le lot vit seulement en mémoire */
  }
  cache.set(siteId, lines);
  return lines;
}

function write(siteId: string, lines: DraftLine[]) {
  cache.set(siteId, lines);
  try {
    if (lines.length) sessionStorage.setItem(storeKey(siteId), JSON.stringify(lines));
    else sessionStorage.removeItem(storeKey(siteId));
  } catch {
    /* idem */
  }
  listeners.forEach((l) => l());
}

export function useDraftLines(siteId: string): DraftLine[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => read(siteId),
  );
}

/**
 * Ajoute des lignes. Une ligne qui vise un champ déjà présent remplace sa valeur seulement si une valeur est donnée.
 * Renvoie le nombre de lignes ajoutées et celles refusées faute de place.
 */
export function addDraftLines(siteId: string, add: DraftLine[]): { added: number; updated: number; refused: number } {
  const lines = read(siteId).slice();
  let added = 0;
  let updated = 0;
  let refused = 0;
  for (const l of add) {
    const i = lines.findIndex((x) => x.key === l.key);
    if (i >= 0) {
      if (l.value) {
        lines[i] = { ...lines[i], value: l.value, current: l.current, rendered: l.rendered };
        updated++;
      }
      continue;
    }
    if (lines.length >= MAX_LINES) {
      refused++;
      continue;
    }
    lines.push(l);
    added++;
  }
  write(siteId, lines);
  return { added, updated, refused };
}

export function setDraftValue(siteId: string, key: string, value: string) {
  write(siteId, read(siteId).map((l) => (l.key === key ? { ...l, value } : l)));
}

export function removeDraftLine(siteId: string, key: string) {
  write(siteId, read(siteId).filter((l) => l.key !== key));
}

export function clearDraft(siteId: string) {
  write(siteId, EMPTY);
}
