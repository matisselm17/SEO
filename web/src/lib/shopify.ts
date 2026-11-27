/** Boutique Shopify : libellés, repères de longueur et actions (lecture, écriture, annulation). */
import { useSyncExternalStore } from "react";
import { sendJSON, sendPut } from "./api";
import { setQueryData } from "./cache";
import { keys } from "./queries";
import { invalidateShopify } from "./live";
import type {
  AutomationPolicy, AutomationState, CheckStatus, CreateBatchRequest, OptimizeRequest, ProposalOrigin, ShopifyBatch, ShopifyBatchItem,
  ShopifyBatchResponse, ShopifyBatchSummary, ShopifyBatchesResponse, ShopifyChange, ShopifyChangeRequest, ShopifyChangeResponse, ShopifyField,
  ShopifyResourceResponse, ShopifyResourceType, ShopifyState, UpdateAutomationRequest, UpdateBatchItemRequest,
} from "./types";

export const FIELD_LABEL: Record<ShopifyField, string> = {
  seo_title: "Titre pour Google",
  seo_description: "Description pour Google",
  image_alt: "Texte alternatif",
};

/** Libellé à accorder avec un nombre : « 1 titre pour Google », « 4 descriptions pour Google ». */
export const FIELD_COUNT: Record<ShopifyField, [string, string]> = {
  seo_title: ["titre pour Google", "titres pour Google"],
  seo_description: ["description pour Google", "descriptions pour Google"],
  image_alt: ["texte alternatif", "textes alternatifs"],
};

/** Même libellé, avec son article, pour l'insérer dans une phrase : « le titre pour Google ». */
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
 * pour qu'un texte « de bonne longueur » ici soit aussi validé par la prochaine analyse.
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

/**
 * Introduction de la section. `autoActive` : le mode automatique est réellement en vigueur (verrous 1 à 3 réunis :
 * écritures activées et mode automatique autorisé sur le serveur, niveau « auto » choisi) ; la phrase ne prétend
 * alors plus que tout passe par une confirmation.
 */
export function sectionIntro(autoActive: boolean): string {
  const base = "Les titres, descriptions et textes alternatifs de votre boutique, tels que Google les lit. Ils se corrigent ici, une valeur ou un lot à la fois";
  return autoActive
    ? `${base} ; certaines corrections préparées par l'IA sont écrites sans votre validation.`
    : `${base}, toujours après confirmation.`;
}

/** Le mode automatique est réellement en vigueur : les trois premiers verrous sont réunis. */
export const autoActive = (s: Pick<AutomationState, "policy" | "autoAllowed" | "writesEnabled"> | null | undefined): boolean =>
  !!s && s.policy.mode === "auto" && s.autoAllowed && s.writesEnabled;

const localeNames = (() => {
  try {
    return new Intl.DisplayNames(["fr"], { type: "language" });
  } catch {
    return null;
  }
})();

/** « en » → « Anglais ». */
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

// ───────── Ce que l'analyse a vu sur la page affichée

/** Verdict de l'analyse sur le texte réellement affiché, en mots simples (jamais la couleur seule). */
export const VERDICT_LABEL: Record<CheckStatus, string> = { pass: "Correct", warn: "À revoir", fail: "Absent" };

/**
 * Pourquoi un texte affiché est « à revoir », d'après les repères de la grille. null si sa longueur est dans
 * les repères (le verdict du serveur fait foi : on ne contredit jamais son verdict, on l'explique seulement).
 */
export function lengthReason(field: "seo_title" | "seo_description", text: string | null): string | null {
  const g = FIELD_GUIDE[field]!;
  if (!text) return null;
  const n = codeLength(text);
  if (n < g.min) return `trop court (${n} caractères, repère ${g.min} à ${g.max})`;
  if (n > g.max) return `trop long (${n} caractères, repère ${g.min} à ${g.max})`;
  return null;
}

// ───────── Lots de corrections

export const ORIGIN_LABEL: Record<ProposalOrigin, string> = {
  manual: "Vous",
  assistant: "L'assistant",
  automation: "Optimisation automatique",
};

/** État d'un lot : un mot et un ton (le ton complète le mot, il ne le remplace pas). */
export const BATCH_STATE: Record<ShopifyBatchSummary["state"], { label: string; tone: "neutral" | "accent" | "good" | "warning" | "critical" }> = {
  preparing: { label: "L'IA rédige", tone: "neutral" },
  draft: { label: "À valider", tone: "accent" },
  applying: { label: "Écriture en cours", tone: "neutral" },
  applied: { label: "Appliqué", tone: "good" },
  partial: { label: "Appliqué en partie", tone: "warning" },
  cancelled: { label: "Abandonné", tone: "neutral" },
  restored: { label: "Annulé", tone: "neutral" },
  failed: { label: "Échec de la préparation", tone: "critical" },
};

export const ITEM_STATE: Record<ShopifyBatchItem["state"], string> = {
  pending: "En attente",
  applied: "Écrite",
  conflict: "Valeur changée entre-temps",
  failed: "Refusée par Shopify",
  skipped: "Écartée",
  restored: "Annulée",
};

/** Le lot est en cours de traitement côté serveur : on le relit régulièrement en plus du flux en direct. */
export const batchBusy = (b: Pick<ShopifyBatchSummary, "state">) => b.state === "preparing" || b.state === "applying";

/** Lignes déjà traitées pendant l'écriture (écrites, en conflit, refusées). */
export const processedCount = (b: ShopifyBatchSummary) => b.counts.applied + b.counts.conflict + b.counts.failed;

function storeBatch(siteId: string, batch: ShopifyBatch) {
  setQueryData<ShopifyBatchResponse>(keys.shopifyBatch(siteId, batch.id), { batch });
  setQueryData<ShopifyBatchesResponse>(keys.shopifyBatches(siteId), (prev) => {
    if (!prev) return prev;
    const { items: _items, ...summary } = batch;
    const i = prev.batches.findIndex((b) => b.id === batch.id);
    if (i < 0) return { batches: [summary, ...prev.batches] };
    const batches = prev.batches.slice();
    batches[i] = summary;
    return { batches };
  });
}

/** Crée un brouillon. N'écrit rien dans la boutique. */
export async function createBatch(siteId: string, req: CreateBatchRequest): Promise<ShopifyBatch> {
  const res = await sendJSON<ShopifyBatchResponse>("POST", keys.shopifyBatches(siteId), req);
  storeBatch(siteId, res.batch);
  return res.batch;
}

/** Corrige ou écarte une ligne d'un brouillon. N'écrit rien dans la boutique. */
export async function updateBatchItem(siteId: string, batchId: string, itemId: string, req: UpdateBatchItemRequest): Promise<ShopifyBatch> {
  const res = await sendJSON<ShopifyBatchResponse>("PATCH", keys.shopifyBatchItem(siteId, batchId, itemId), req);
  storeBatch(siteId, res.batch);
  return res.batch;
}

/** Écrit dans la boutique les lignes retenues, une par une. Toujours après confirmation. */
export async function applyBatch(siteId: string, batchId: string): Promise<ShopifyBatch> {
  const res = await sendJSON<ShopifyBatchResponse>("POST", keys.shopifyBatchApply(siteId, batchId));
  storeBatch(siteId, res.batch);
  invalidateShopify(siteId);
  return res.batch;
}

/**
 * Arrête une écriture ou une annulation en cours, après la ligne en cours. Sans confirmation : arrêter est
 * toujours sûr (les lignes écrites restent dans l'historique, les autres ne sont pas touchées).
 */
export async function stopBatch(siteId: string, batchId: string): Promise<ShopifyBatch> {
  const res = await sendJSON<ShopifyBatchResponse>("POST", keys.shopifyBatchStop(siteId, batchId));
  storeBatch(siteId, res.batch);
  invalidateShopify(siteId);
  return res.batch;
}

/** Annule dans la boutique chaque ligne écrite encore annulable. Toujours après confirmation. */
export async function restoreBatch(siteId: string, batchId: string): Promise<ShopifyBatch> {
  const res = await sendJSON<ShopifyBatchResponse>("POST", keys.shopifyBatchRestore(siteId, batchId));
  storeBatch(siteId, res.batch);
  invalidateShopify(siteId);
  return res.batch;
}

/** Abandonne un brouillon (le lot reste consultable). */
export async function cancelBatch(siteId: string, batchId: string): Promise<ShopifyBatch> {
  const res = await sendJSON<ShopifyBatchResponse>("DELETE", keys.shopifyBatch(siteId, batchId));
  storeBatch(siteId, res.batch);
  return res.batch;
}

/** Demande à l'IA de préparer un lot. Répond tout de suite, le lot en « preparing ». */
export async function optimize(siteId: string, req: OptimizeRequest): Promise<ShopifyBatch> {
  const res = await sendJSON<ShopifyBatchResponse>("POST", keys.shopifyOptimize(siteId), req);
  storeBatch(siteId, res.batch);
  return res.batch;
}

// ───────── Automatisation

export async function saveAutomation(siteId: string, policy: AutomationPolicy): Promise<AutomationState> {
  const res = await sendPut<AutomationState>(keys.automation(siteId), { policy } satisfies UpdateAutomationRequest);
  setQueryData(keys.automation(siteId), res);
  return res;
}

/** Ce que l'IA a le droit de remplacer, avec une phrase d'exemple pour chacun. */
export const SCOPE_TEXT: Record<AutomationPolicy["scope"], { label: string; example: string }> = {
  empty_only: { label: "Seulement les champs vides", example: "Un produit sans description pour Google en reçoit une ; une description déjà écrite n'est jamais touchée." },
  failing: { label: "Les champs vides, et ceux que l'analyse juge à revoir", example: "Une description de 320 caractères, coupée par Google, peut être réécrite ; une description correcte n'est pas touchée." },
  any: { label: "N'importe quelle valeur", example: "Même une description jugée correcte peut être réécrite si l'IA propose mieux." },
};

export const MODE_TEXT: Record<AutomationPolicy["mode"], { label: string; text: string }> = {
  off: { label: "L'IA ne prépare rien", text: "Ni l'assistant ni l'optimisation ne proposent de corrections. Vous pouvez toujours composer vos lots vous-même." },
  propose: { label: "L'IA prépare, vous validez", text: "L'IA rédige des propositions dans un lot ; rien n'est écrit dans la boutique avant que vous ayez relu et validé." },
  auto: {
    label: "L'IA applique seule, dans des limites",
    text: "Seuls les lots de « Préparer des corrections avec l'IA » peuvent être écrits sans votre validation, ligne par ligne, s'ils respectent la règle, le filtre de contenu et le plafond d'écritures du jour. Ce que l'assistant propose dans la conversation attend toujours votre validation. Tout reste dans l'historique et s'annule.",
  },
};

/** « jetons d'IA » : l'unité de consommation de l'IA. */
export const TOKENS_HINT = "Un jeton est l'unité de consommation de l'IA : environ trois quarts d'un mot lu ou écrit.";

/** Ce que limite le plafond de jetons : la préparation, pas l'écriture, ni la conversation avec l'assistant. */
export const TOKENS_SCOPE = "Limite seulement « Préparer des corrections avec l'IA » : ce n'est pas une limite d'écriture, et la conversation avec l'assistant n'est pas comptée.";

/** Filtre de contenu des écritures automatiques, en mots simples (format d'échange). */
export const CONTENT_FILTER_TEXT = "Une proposition écrite sans relecture ne doit contenir ni adresse web, ni nom de domaine, ni adresse e-mail, ni numéro de téléphone, et doit reprendre un mot du nom de l'élément. Sinon elle reste dans le lot, à relire par vous.";

/** Message d'erreur quand un autre lot est déjà en écriture sur le site (limit_reached). */
export const OTHER_BATCH_RUNNING = "Un autre lot est en cours d'écriture sur ce site : attendez sa fin ou arrêtez-le, puis recommencez.";
