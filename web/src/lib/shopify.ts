/** Boutique Shopify : libellés, repères de longueur et actions (lecture, écriture, annulation). */
import { useSyncExternalStore } from "react";
import { sendJSON } from "./api";
import { setQueryData } from "./cache";
import { keys } from "./queries";
import { invalidateShopify } from "./live";
import type {
  ShopifyChange, ShopifyChangeRequest, ShopifyChangeResponse, ShopifyField, ShopifyResourceResponse, ShopifyResourceType, ShopifyState,
} from "./types";

export const FIELD_LABEL: Record<ShopifyField, string> = {
  seo_title: "Titre pour Google",
  seo_description: "Description pour Google",
  image_alt: "Texte alternatif",
};

/** Même libellé, avec son article, pour l'insérer dans une phrase : « le titre pour Google ». */
export const fieldInline = (f: ShopifyField) => ({ seo_title: "le titre pour Google", seo_description: "la description pour Google", image_alt: "le texte alternatif" })[f];

export const FIELD_HINT: Record<ShopifyField, string> = {
  seo_title: "La ligne cliquable affichée dans les résultats de Google.",
  seo_description: "Le court texte affiché sous le titre dans les résultats de Google.",
  image_alt: "Décrit l'image à Google Images et aux personnes qui ne la voient pas.",
};

/** Longueurs maximales acceptées par le serveur (format d'échange). */
export const FIELD_MAX: Record<ShopifyField, number> = { seo_title: 255, seo_description: 500, image_alt: 512 };

/**
 * Repères de longueur affichés au compteur : ceux de la grille d'audit du serveur (server/src/analyse/grille.ts),
 * pour qu'un texte « de bonne longueur » ici soit aussi validé par la prochaine analyse.
 */
export const FIELD_GUIDE: Partial<Record<ShopifyField, { min: number; max: number }>> = {
  seo_title: { min: 30, max: 60 },
  seo_description: { min: 70, max: 160 },
};

/** Longueur comptée comme le serveur : en points de code (un emoji compte pour un). */
export const codeLength = (s: string) => [...s].length;

/**
 * Même règle que le serveur, appliquée avant la confirmation : seuls les espaces sont normalisés ;
 * une valeur avec < ou >, un caractère de contrôle, ou trop longue est refusée. null : valeur acceptée.
 */
export function valueProblem(field: ShopifyField, raw: string): string | null {
  const v = raw.replace(/\s+/g, " ").trim();
  if (/[<>]/.test(v)) return "Les signes < et > ne sont pas acceptés : retirez-les.";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(v)) return "Le texte contient un caractère invisible non accepté : retapez-le sans copier-coller.";
  const n = codeLength(v);
  if (n > FIELD_MAX[field]) return `${n} caractères : la boutique en accepte ${FIELD_MAX[field]} au plus. Raccourcissez le texte.`;
  return null;
}

export const TYPE_LABEL: Record<ShopifyResourceType, { one: string; many: string; the: string }> = {
  product: { one: "Produit", many: "Produits", the: "le nom du produit" },
  collection: { one: "Collection", many: "Collections", the: "le nom de la collection" },
  page: { one: "Page", many: "Pages", the: "le titre de la page" },
  article: { one: "Article de blog", many: "Articles de blog", the: "le titre de l'article" },
};
export const TYPE_ORDER: ShopifyResourceType[] = ["product", "collection", "page", "article"];

/** Ce que Shopify montre quand le champ est vide. */
export function emptyMeaning(field: ShopifyField, type: ShopifyResourceType): string {
  if (field === "seo_title") return `Vide : Shopify utilise ${TYPE_LABEL[type].the}.`;
  if (field === "seo_description") return "Vide : Shopify utilise le début du texte de la page.";
  return "Vide : l'image n'est pas décrite.";
}

/** Texte de l'aperçu Google quand la description est vide : le même constat que sous le champ. */
export const EMPTY_DESCRIPTION_PREVIEW = "Pas de description pour Google : Shopify montre le début du texte de la page (Google peut aussi choisir un autre extrait).";

/** Introduction de la section, la même quel que soit l'état de la connexion. */
export const SECTION_INTRO = "Les titres, descriptions et textes alternatifs de votre boutique, tels que Google les lit. Ils se corrigent ici, une valeur à la fois, après confirmation.";

const localeNames = (() => {
  try {
    return new Intl.DisplayNames(["fr"], { type: "language" });
  } catch {
    return null;
  }
})();

/** « en » → « Anglais ». */
export function localeLabel(code: string): string {
  const n = localeNames?.of(code);
  return n ? n.charAt(0).toUpperCase() + n.slice(1) : code;
}

/** Une image venue de Shopify ne s'affiche que si son adresse est en https. */
export function safeImageUrl(url: string): string | null {
  try {
    const u = new URL(url);
    // Seul l'hôte d'images de Shopify est autorisé par la politique de sécurité du serveur (img-src).
    return u.protocol === "https:" && u.hostname === "cdn.shopify.com" ? u.href : null;
  } catch {
    return null;
  }
}

/** Le serveur normalise : espaces en trop retirés, aucune balise. On compare sur la même base. */
export function normalizeValue(v: string | null): string | null {
  if (v === null) return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t === "" ? null : t;
}

/** Ce qui est écrit dans la description d'une modification : champ, langue, image. */
export function changeWhat(c: Pick<ShopifyChange, "field" | "locale" | "image">): string {
  const base = FIELD_LABEL[c.field];
  if (c.locale) return `${base} · ${localeLabel(c.locale)}`;
  return base;
}

// ───────── Lecture de la boutique (POST sync) : état partagé entre les écrans

const syncing = new Set<string>();
const syncListeners = new Set<() => void>();
const emitSync = () => syncListeners.forEach((l) => l());

export function useShopifySyncing(siteId: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      syncListeners.add(cb);
      return () => syncListeners.delete(cb);
    },
    () => syncing.has(siteId),
  );
}

/** Lit toute la boutique (lecture seule). La réponse arrive quand la lecture est finie. */
export async function syncShopify(siteId: string): Promise<ShopifyState> {
  syncing.add(siteId);
  emitSync();
  try {
    const state = await sendJSON<ShopifyState>("POST", keys.shopifySync(siteId));
    setQueryData(keys.shopify(siteId), state);
    invalidateShopify(siteId);
    return state;
  } finally {
    syncing.delete(siteId);
    emitSync();
  }
}

// ───────── Écritures : une valeur à la fois, toujours après confirmation

function afterWrite(siteId: string, res: ShopifyChangeResponse) {
  setQueryData<ShopifyResourceResponse>(keys.shopifyResource(siteId, res.resource.id), { resource: res.resource });
  invalidateShopify(siteId);
}

export async function applyShopifyChange(siteId: string, req: ShopifyChangeRequest): Promise<ShopifyChangeResponse> {
  const res = await sendJSON<ShopifyChangeResponse>("POST", keys.shopifyChangesPost(siteId), req);
  afterWrite(siteId, res);
  return res;
}

export async function restoreShopifyChange(siteId: string, changeId: string): Promise<ShopifyChangeResponse> {
  const res = await sendJSON<ShopifyChangeResponse>("POST", keys.shopifyRestore(siteId, changeId));
  afterWrite(siteId, res);
  return res;
}
