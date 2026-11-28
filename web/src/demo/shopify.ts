/**
 * MODE DÉMONSTRATION — développement uniquement (jamais inclus dans le build de production).
 * Fausse boutique Shopify pour le site fictif Atelier Lune : elle répond aux routes `shopify/…`
 * de docs/format-echange.md, avec les mêmes garde-fous que le serveur (lecture seule par défaut,
 * contrôle de la valeur avant écriture, historique jamais effacé, annulation de la dernière modification).
 * Aucun appel à Shopify : tout est en mémoire.
 *
 * État de la boutique, choisi avec ?boutique=… dans l'adresse (mémorisé pour l'onglet) :
 *   lecture (défaut)    connectée, lue, modifications désactivées côté serveur, une permission manquante
 *   ecriture            connectée, lue, modifications activées, toutes les permissions
 *   ecriture-partielle  modifications activées, permission des images manquante
 *   jamais-lue          connectée, jamais lue, modifications activées
 *   erreur              Shopify ne répond pas
 *   non-configuree      aucune boutique configurée côté serveur (la section disparaît du menu)
 * Le second site (Maison Orlux) voit toujours « la boutique connectée est celle d'un autre site ».
 *
 * Saisies spéciales dans un champ, au moment d'appliquer :
 *   « conflit »    la valeur a été changée dans Shopify entre-temps → shopify_conflict (details.current)
 *   « rafale »     rate_limited (30 écritures par minute)
 *   « permission » shopify_missing_scope
 *   « panne »      shopify_unavailable
 *   « relecture »  Shopify accepte, mais la valeur n'a pas pu être relue (afterVerified: false)
 *   « < » ou « > », caractère de contrôle, texte trop long : shopify_invalid_value (l'interface le bloque avant)
 *
 * Lots de corrections et automatisation (voir plus bas) : lots déjà présents dans chaque état, application
 * ligne par ligne au rythme d'une valeur toutes les 0,9 s, préparation par l'IA simulée (aucun appel à une IA).
 * Règle d'automatisation choisie avec ?ia=… (mémorisé pour l'onglet) :
 *   propose (défaut)  l'IA prépare, un humain valide ; mode automatique non autorisé côté serveur
 *   auto              mode automatique autorisé côté serveur et choisi (avec ?boutique=ecriture : écritures sans validation)
 *   auto-refuse       mode « auto » choisi, mais non autorisé côté serveur (se comporte comme « vous validez »)
 *   arret             l'IA ne prépare rien (automation_off)
 *   sans-cle          aucune clé d'IA sur le serveur (aiConfigured: false)
 *   budget            plafond de jetons du jour atteint (budget_exceeded)
 * Valeurs spéciales dans un lot : une proposition contenant « panne » est refusée par Shopify à l'application
 * (ligne en échec) ; « conflit » fait changer la valeur dans Shopify juste avant son écriture (ligne en conflit).
 * Un lot nommé « rafale » est refusé à la création (rate_limited).
 * Écriture d'un lot : une valeur toutes les 1,6 s ; « Arrêter après la ligne en cours » (route stop) laisse le
 * lot en « partial ». Un seul lot en écriture par site : en lancer un second répond limit_reached.
 * Le lot « Descriptions vides de produits » montre trois lignes écrites sans validation humaine
 * (`ShopifyBatchItem.autoApplied`) et une ligne retenue par le filtre de contenu (elle cite un nom de domaine),
 * restée en attente avec sa raison. Les lots de l'assistant attendent toujours une validation humaine.
 */
import type {
  ApiError, AutomationPolicy, AutomationState, CheckStatus, CreateBatchRequest, ErrorCode, OptimizeRequest, ProposalOrigin, ShopifyBatch,
  ShopifyBatchItem, ShopifyChange, ShopifyChangeRequest, ShopifyConnection, ShopifyField, ShopifyImage, ShopifyResourceDetail,
  ShopifyResourceSummary, ShopifyResourceType, ShopifyState, ShopifyTranslation, ShopifyVerification, UpdateAutomationRequest, UpdateBatchItemRequest,
} from "../lib/types";
import { rng, type DemoPage } from "./data";
import { demoEmbeddedMode } from "../lib/embedded";

export type ShopMode = "lecture" | "ecriture" | "ecriture-partielle" | "jamais-lue" | "erreur" | "non-configuree";
const MODES: ShopMode[] = ["lecture", "ecriture", "ecriture-partielle", "jamais-lue", "erreur", "non-configuree"];

function readMode(): ShopMode {
  const fromUrl = new URLSearchParams(location.search).get("boutique") as ShopMode | null;
  if (fromUrl && MODES.includes(fromUrl)) {
    sessionStorage.setItem("demo-boutique", fromUrl);
    return fromUrl;
  }
  const saved = sessionStorage.getItem("demo-boutique") as ShopMode | null;
  return saved && MODES.includes(saved) ? saved : "lecture";
}
export const shopMode = readMode();

export const SHOP_HOST = "atelier-lune.example";
const SHOP_NAME = "Atelier Lune";

interface Res {
  id: string;
  type: ShopifyResourceType;
  path: string;
  title: string;
  seoTitle: string | null;
  seoDescription: string | null;
  images: ShopifyImage[];
  /** Traductions anglaises ; `outdated` : le texte français a changé depuis. */
  en: Record<"seo_title" | "seo_description", { value: string | null; outdated: boolean }>;
  /** Page de l'inventaire de même chemin. */
  pagePath: string;
  /** Note de cette page dans l'inventaire (null : pas de page analysée). */
  score: number | null;
}

interface Shop {
  resources: Res[];
  changes: ShopifyChange[];
  syncedAt: string | null;
  writes: number[];
  lastSync: number | null;
  batches: ShopifyBatch[];
  automation: AutomationState;
  timers: Map<string, ReturnType<typeof setInterval>>;
  /** Relectures à programmer dès qu'une requête fournit de quoi émettre l'événement « shopify ». */
  pendingVerify: string[];
  /** Corrections laissées « appliquées » sans relecture au chargement (comme après un redémarrage du serveur). */
  seedKeep: Set<string>;
  /** Relectures à la demande de la dernière minute (10 au plus). */
  verifies: number[];
}

const scopesAll = ["read_content", "read_products", "read_translations", "write_content", "write_files", "write_products", "write_translations"];
const missingFiles = { scope: "write_files", blocks: "Modifier le texte alternatif des images" };

function connectionFor(host: string): ShopifyConnection {
  const base: ShopifyConnection = {
    state: "connected", shopName: SHOP_NAME, shopHost: SHOP_HOST, scopes: [], missingScopes: [], writesEnabled: false,
    primaryLocale: "fr", otherLocales: ["en"], error: null,
  };
  if (shopMode === "non-configuree") {
    return { ...base, state: "not_configured", shopName: null, shopHost: null, primaryLocale: null, otherLocales: [] };
  }
  if (host !== SHOP_HOST) return { ...base, state: "other_shop", primaryLocale: null, otherLocales: [] };
  if (shopMode === "erreur") {
    return {
      ...base, state: "error", shopName: null, primaryLocale: null, otherLocales: [],
      error: {
        code: "shopify_unavailable", message: "Shopify n'a pas répondu à la vérification de la connexion.",
        action: "Réessayez dans quelques minutes. Si le problème persiste, la personne qui gère l'installation peut vérifier l'application Shopify.",
        details: { retryable: true },
      },
    };
  }
  const partial = shopMode === "lecture" || shopMode === "ecriture-partielle";
  return {
    ...base,
    scopes: partial ? scopesAll.filter((s) => s !== "write_files") : scopesAll,
    missingScopes: partial ? [missingFiles] : [],
    writesEnabled: shopMode !== "lecture",
  };
}

export const shopifyConfigured = shopMode !== "non-configuree";
export const shopifyWritesEnabled = shopifyConfigured && shopMode !== "lecture";

// ───────── Construction de la boutique à partir de l'inventaire du site

const typeOfPath = (path: string): ShopifyResourceType | null => {
  if (/^\/products\//.test(path)) return "product";
  if (/^\/collections\//.test(path)) return "collection";
  if (/^\/blogs\/[^/]+\/[^/]+/.test(path)) return "article";
  if (/^\/pages\//.test(path)) return "page";
  return null;
};

/** Adresse d'image chez Shopify (le CDN n'est pas joignable en démonstration : l'interface affiche une vignette neutre). */
const img = (slug: string, i: number) => `https://cdn.shopify.com/s/files/1/0000/demo/${slug}-${i + 1}.jpg`;

function buildShop(inventory: DemoPage[]): Shop {
  const r = rng(404);
  const resources: Res[] = [];
  let n = 0;
  for (const p of inventory) {
    const type = typeOfPath(p.summary.path);
    if (!type) continue;
    n += 1;
    const slug = p.summary.path.split("/").filter(Boolean).pop() ?? "element";
    const name = p.detail.h1[0] ?? p.summary.title ?? slug;
    const hasTitle = r() > 0.55;
    const hasDesc = r() > 0.35;
    const desc = p.detail.description;
    const imageCount = type === "product" ? 1 + Math.floor(r() * 4) : type === "collection" || type === "article" ? 1 : 0;
    const images: ShopifyImage[] = Array.from({ length: imageCount }, (_, i) => ({
      id: `img_${n}_${i + 1}`,
      // Une adresse non sécurisée, pour vérifier que l'interface ne l'affiche pas.
      url: n === 3 && i === 1 ? img(slug, i).replace("https://", "http://") : img(slug, i),
      alt: r() > 0.6 ? `${name}, vue ${i === 0 ? "de face" : i === 1 ? "de dessus" : "en situation"}` : null,
    }));
    const seoTitle = hasTitle ? p.summary.title : null;
    const seoDescription = hasDesc && desc ? (desc.length > 300 ? desc.slice(0, 300) : desc) : null;
    resources.push({
      // Comme le serveur : « shr_ » suivi de 6 à 40 caractères [a-z0-9].
      id: `shr_${(slug.normalize("NFD").replace(/[^a-z0-9]/g, "").slice(0, 30) + n.toString(36)).padEnd(6, "0")}`,
      type, path: p.summary.path, title: name, seoTitle, seoDescription, images, pagePath: p.summary.path, score: p.summary.score,
      en: {
        seo_title: { value: seoTitle && r() > 0.5 ? `${name} — handmade stoneware | Atelier Lune` : null, outdated: r() > 0.8 },
        seo_description: { value: seoDescription && r() > 0.4 ? `${name}: hand-thrown stoneware made in our Nantes workshop.` : null, outdated: r() > 0.7 },
      },
    });
  }
  // Ordre de la boutique : produits, collections, pages, articles.
  const rank: Record<ShopifyResourceType, number> = { product: 0, collection: 1, page: 2, article: 3 };
  resources.sort((a, b) => rank[a.type] - rank[b.type]);
  // La fiche de l'exemple du format d'échange, reconnaissable.
  const bol = resources.find((x) => x.type === "product");
  const changes: ShopifyChange[] = [];
  if (bol) {
    const before = null;
    bol.seoDescription = "Bol en grès émaillé bleu, tourné à la main dans notre atelier de Nantes. Passe au lave-vaisselle.";
    changes.push(change(bol, "seo_description", null, null, before, bol.seoDescription, "2026-11-27T10:20:31.000Z", "edit"));
    // Une traduction : la relecture ne peut pas conclure (pas encore vérifiable).
    const prevEn = bol.en.seo_description.value;
    bol.en.seo_description = { value: `${bol.title}: blue glazed stoneware bowl, hand-thrown in our Nantes workshop.`, outdated: false };
    changes.push(change(bol, "seo_description", null, "en", prevEn, bol.en.seo_description.value, "2026-11-27T10:24:12.000Z", "edit"));
    const other = resources.filter((x) => x.type === "collection")[1];
    if (other) {
      const prev = other.seoTitle;
      other.seoTitle = "Assiettes en grès émaillé faites à Nantes | Atelier Lune";
      const c1 = change(other, "seo_title", null, null, prev, other.seoTitle, "2026-11-26T16:42:10.000Z", "edit");
      changes.unshift(c1);
    }
  }
  const shop: Shop = {
    resources, changes, syncedAt: shopMode === "jamais-lue" ? null : "2026-11-27T10:12:04.000Z", writes: [], lastSync: null,
    batches: [], automation: initialAutomation(), timers: new Map(), pendingVerify: [], seedKeep: new Set(), verifies: [],
  };
  if (shop.syncedAt) seedBatches(shop);
  shop.changes.sort((a, b) => b.appliedAt.localeCompare(a.appliedAt));
  refreshRestorable(shop.changes);
  // Relectures déjà faites au chargement, sauf celles laissées « appliquées » ou encore en attente.
  for (const c of shop.changes) {
    if (c.kind !== "edit" || c.correctionStatus !== "applied" || !c.restorable || shop.seedKeep.has(c.id)) continue;
    if (shop.pendingVerify.includes(c.id)) c.correctionStatus = "verifying";
    else applyVerification(shop, c, new Date(new Date(c.appliedAt).getTime() + 16_000).toISOString());
  }
  return shop;
}

let seq = 1;
function change(res: Res, field: ShopifyField, image: ShopifyImage | null, locale: string | null, before: string | null, after: string | null, at: string, kind: "edit" | "restore", restores: string | null = null): ShopifyChange {
  return {
    id: `chg_${(seq++).toString(36)}`, resourceId: res.id, resourceType: res.type, resourceTitle: res.title, path: res.path, field,
    image: image ? { id: image.id, url: image.url } : null, locale, before, after, appliedAt: at, kind,
    afterVerified: true, restoresChangeId: restores, restoredByChangeId: null, restorable: false, batchId: null,
    correctionStatus: kind === "edit" ? "applied" : null, verification: null,
  };
}

/** Seule la dernière modification d'un champ (élément, image, langue) est annulable, et seulement si elle n'a pas été annulée. */
function refreshRestorable(changes: ShopifyChange[]) {
  const seen = new Set<string>();
  for (const c of changes) {
    const k = `${c.resourceId}|${c.field}|${c.image?.id ?? ""}|${c.locale ?? ""}`;
    c.restorable = !seen.has(k) && c.restoredByChangeId === null;
    if (c.kind === "edit" && c.restoredByChangeId !== null) c.correctionStatus = "cancelled";
    seen.add(k);
  }
}

// ───────── Relecture de la page publique après une correction (même grille que l'analyse, simulée)

const CRITERION: Record<ShopifyField, { id: string; label: string; max: number }> = {
  seo_title: { id: "title", label: "Titre de la page", max: 8 },
  seo_description: { id: "meta_description", label: "Description", max: 7 },
  image_alt: { id: "image_alt", label: "Textes alternatifs des images", max: 5 },
};
const pointsOf = (st: CheckStatus, max: number) => (st === "pass" ? max : st === "warn" ? Math.round(max * 0.6) : 0);

/** Ce que la page publique affiche pour un champ, quand ce champ vaut `value`. */
function renderedFor(res: Res, field: "seo_title" | "seo_description", value: string | null): string | null {
  return field === "seo_title" ? `${value ?? res.title} – ${SHOP_NAME}` : value ?? bodyStart(res);
}

function verificationOf(res: Res, c: ShopifyChange, at: string): ShopifyVerification {
  if (c.locale) {
    return {
      checkedAt: at, outcome: "inconclusive", reason: "not_supported",
      message: "Les traductions ne peuvent pas encore être vérifiées sur la page publique : la correction reste appliquée.",
      url: null, displayed: null, rendered: null, criterion: null, pageScore: null,
    };
  }
  const url = `https://${SHOP_HOST}${res.path}`;
  const crit = CRITERION[c.field];
  const analysed = res.score !== null;
  let rendered: string | null;
  let displayed: boolean | null;
  let before: CheckStatus;
  let after: CheckStatus;
  let critMessage: string;
  if (c.field === "image_alt") {
    const im = res.images.find((i) => i.id === c.image?.id);
    if (!im) {
      return { checkedAt: at, outcome: "inconclusive", reason: "image_not_found", message: "L'image n'a pas été retrouvée sur la page publique : la correction n'a pas pu être vérifiée.", url, displayed: null, rendered: null, criterion: null, pageScore: null };
    }
    rendered = im.alt;
    displayed = c.after === null ? null : im.alt === c.after;
    const described = res.images.filter((i) => i.alt).length;
    const describedBefore = described - (c.before ? 0 : 1) + (c.after ? 0 : 1);
    const status = (n: number): CheckStatus => (n >= res.images.length ? "pass" : n > 0 ? "warn" : "fail");
    before = status(describedBefore);
    after = status(described);
    critMessage = `${described} image${described > 1 ? "s" : ""} décrite${described > 1 ? "s" : ""} sur ${res.images.length}.`;
  } else {
    const [min, max] = c.field === "seo_title" ? [30, 60] : [70, 160];
    rendered = renderedFor(res, c.field, c.field === "seo_title" ? res.seoTitle : res.seoDescription);
    displayed = c.after === null ? null : !!rendered && rendered.includes(c.after);
    before = gridStatus(renderedFor(res, c.field, c.before), min, max);
    after = gridStatus(rendered, min, max);
    const n = rendered ? [...rendered].length : 0;
    critMessage = c.field === "seo_title" ? `Le titre affiché fait ${n} caractères.` : rendered ? `La description fait ${n} caractères.` : "Aucune description affichée.";
  }
  const thing = c.field === "seo_title" ? "le nouveau titre" : c.field === "seo_description" ? "la nouvelle description" : "le nouveau texte alternatif";
  // Le texte alternatif se juge sur l'image elle-même ; titre et description, sur le critère de la grille.
  const ok = c.field === "image_alt" ? displayed !== false : displayed !== false && after === "pass";
  const outcome: ShopifyVerification["outcome"] = ok ? "verified" : "failed";
  const reason: ShopifyVerification["reason"] = ok ? "ok" : displayed === false ? "not_displayed" : "criterion_failing";
  const message = ok
    ? c.field === "image_alt"
      ? "L'image porte bien le nouveau texte alternatif sur la page publique."
      : `La page affiche ${thing} et le critère « ${crit.label} » est validé.`
    : reason === "not_displayed"
      ? `La page n'affiche pas encore ${thing} : la boutique met parfois quelques minutes à se mettre à jour.`
      : `La page affiche bien ${thing}, mais le critère « ${crit.label} » n'est pas encore validé : ${critMessage.charAt(0).toLowerCase()}${critMessage.slice(1, -1)}.`;
  const pts = pointsOf(after, crit.max);
  return {
    checkedAt: at, outcome, reason, message, url, displayed,
    rendered: rendered ? [...rendered].slice(0, 300).join("") : null,
    criterion: { id: crit.id, label: crit.label, before: analysed ? before : null, after, points: pts, max: crit.max, message: critMessage },
    pageScore: analysed ? { before: res.score, after: Math.max(0, Math.min(100, res.score! + pts - pointsOf(before, crit.max))) } : null,
  };
}

function applyVerification(shop: Shop, c: ShopifyChange, at: string) {
  const res = shop.resources.find((r) => r.id === c.resourceId);
  if (!res) return;
  const v = verificationOf(res, c, at);
  c.verification = v;
  c.correctionStatus = v.outcome === "inconclusive" ? "applied" : v.outcome;
}

/** Relecture automatique, quelques secondes après l'écriture (une quinzaine côté serveur). */
function scheduleVerify(ctx: ShopCtx, shop: Shop, c: ShopifyChange, ms: number) {
  c.correctionStatus = "verifying";
  setTimeout(() => {
    if (c.correctionStatus !== "verifying" || !c.restorable) return;
    applyVerification(shop, c, new Date().toISOString());
    ctx.emit();
  }, ms);
}

// ───────── Réponses

type Json = (body: unknown, status?: number) => Response;
type Err = (status: number, code: ErrorCode, message: string, action: string | null, details?: ApiError["error"]["details"]) => Response;

export interface ShopCtx {
  host: string;
  inventory: DemoPage[];
  /** Pages de l'analyse affichée : pageId et note des éléments. */
  shown: DemoPage[];
  emit: () => void;
  json: Json;
  apiError: Err;
  delay: (ms: number) => Promise<void>;
}

const shops = new Map<string, Shop>();
function shopOf(ctx: ShopCtx): Shop {
  let s = shops.get(ctx.host);
  if (!s) shops.set(ctx.host, (s = buildShop(ctx.inventory)));
  return s;
}

/** Statut de la grille d'audit pour une longueur : titre 30 à 60, description 70 à 160. */
function gridStatus(text: string | null, min: number, max: number): CheckStatus {
  if (!text) return "fail";
  const n = [...text].length;
  return n >= min && n <= max ? "pass" : "warn";
}

/** Ce que Shopify affiche quand la description est vide : le début du texte, coupé à 320 caractères. */
function bodyStart(res: Res): string | null {
  if (res.type === "collection" || res.type === "page") return null;
  const t = res.type === "product"
    ? `Matériaux : grès de Saint-Amand, émail sans plomb. Dimensions : diamètre 14 cm, hauteur 7 cm. Entretien : passe au lave-vaisselle et au four à micro-ondes. Chaque pièce de ${res.title.toLowerCase()} est tournée à la main dans notre atelier de Nantes : les nuances d'émail varient d'une pièce à l'autre, ce qui fait leur charme. Expédition sous 48 heures.`
    : `${res.title}. Dans cet article, nous revenons sur les gestes du tournage, le choix des terres et la cuisson à haute température qui donnent au grès sa solidité. Nous partageons aussi nos conseils pour choisir une vaisselle qui dure, l'entretenir et la faire vivre au quotidien, de la table du petit-déjeuner aux repas entre amis.`;
  return [...t].slice(0, 320).join("");
}

/** Constat de l'analyse sur la page affichée, null si elle n'a pas été ouverte. */
function auditOf(res: Res, ctx: ShopCtx): ShopifyResourceSummary["audit"] {
  const page = ctx.shown.find((p) => p.summary.path === res.pagePath) ?? null;
  if (!page) return null;
  // Comme la plupart des thèmes : le titre affiché est « titre ou nom – nom de la boutique ».
  const renderedTitle = `${res.seoTitle ?? res.title} – ${SHOP_NAME}`;
  const renderedDescription = res.seoDescription ?? bodyStart(res);
  return {
    renderedTitle,
    titleStatus: gridStatus(renderedTitle, 30, 60),
    renderedDescription,
    descriptionStatus: gridStatus(renderedDescription, 70, 160),
  };
}

function summaryOf(res: Res, ctx: ShopCtx, shop: Shop): ShopifyResourceSummary {
  const page = ctx.shown.find((p) => p.summary.path === res.pagePath) ?? null;
  return {
    id: res.id, type: res.type, path: res.path, title: res.title, seoTitle: res.seoTitle, seoDescription: res.seoDescription,
    images: res.images.length, imagesWithoutAlt: res.images.filter((i) => !i.alt).length,
    pageId: page?.summary.id ?? null, pageScore: page?.summary.score ?? null,
    changes: shop.changes.filter((c) => c.resourceId === res.id).length,
    audit: auditOf(res, ctx),
  };
}

function translationsOf(res: Res): ShopifyTranslation[] {
  return (["seo_title", "seo_description"] as const).map((field) => {
    const origin = field === "seo_title" ? res.seoTitle : res.seoDescription;
    const t = res.en[field];
    return {
      locale: "en", field, value: t.value, outdated: !!t.value && t.outdated,
      editable: !!origin,
      reason: origin ? null : field === "seo_title" ? "Le titre pour Google est vide en français : renseignez-le d'abord." : "La description pour Google est vide en français : renseignez-la d'abord.",
    };
  });
}

function detailOf(res: Res, ctx: ShopCtx, shop: Shop): ShopifyResourceDetail {
  const conn = connectionFor(ctx.host);
  const files = !conn.missingScopes.some((m) => m.scope === "write_files");
  return {
    ...summaryOf(res, ctx, shop),
    imageList: res.images.slice(0, 50),
    translations: translationsOf(res),
    history: shop.changes.filter((c) => c.resourceId === res.id),
    editable: { seo_title: true, seo_description: true, image_alt: files && res.type === "product" && res.images.length > 0, translations: true },
    readOnlyReasons:
      res.type === "collection" || res.type === "article"
        ? { image_alt: `Le texte alternatif de l'image ${res.type === "collection" ? "d'une collection" : "d'un article"} ne se modifie pas encore d'ici : Shopify pourrait remplacer ou retirer l'image. Modifiez-le dans l'administration Shopify.` }
        : {},
  };
}

function stateOf(ctx: ShopCtx): ShopifyState {
  const connection = connectionFor(ctx.host);
  if (connection.state !== "connected") return { connection, sync: null };
  const shop = shopOf(ctx);
  if (!shop.syncedAt) return { connection, sync: null };
  const count = (t: ShopifyResourceType) => shop.resources.filter((r) => r.type === t).length;
  const images = shop.resources.reduce((s, r) => s + r.images.length, 0);
  return {
    connection,
    sync: {
      syncedAt: shop.syncedAt,
      counts: { product: count("product"), collection: count("collection"), page: count("page"), article: count("article") },
      missing: {
        seoTitle: shop.resources.filter((r) => !r.seoTitle).length,
        seoDescription: shop.resources.filter((r) => !r.seoDescription).length,
        imagesWithoutAlt: shop.resources.reduce((s, r) => s + r.images.filter((i) => !i.alt).length, 0),
        images,
      },
      toFix: (() => {
        const audits = shop.resources.map((r) => auditOf(r, ctx)).filter((a): a is NonNullable<typeof a> => !!a);
        return { audited: audits.length, title: audits.filter((a) => a.titleStatus !== "pass").length, description: audits.filter((a) => a.descriptionStatus !== "pass").length };
      })(),
    },
  };
}

/**
 * Rattache les preuves des problèmes et la fiche d'une page à leur élément Shopify (après une lecture de la boutique).
 * Comme le serveur : pour une preuve (`field` donné), seulement si ce champ est modifiable sur cet élément.
 */
export function resourceIdForPath(ctx: Pick<ShopCtx, "host" | "inventory">, path: string, field?: ShopifyField | null): string | null {
  const conn = connectionFor(ctx.host);
  if (conn.state !== "connected") return null;
  const shop = shops.get(ctx.host) ?? (shops.set(ctx.host, buildShop(ctx.inventory)), shops.get(ctx.host)!);
  if (!shop.syncedAt) return null;
  const res = shop.resources.find((r) => r.path === path);
  if (!res) return null;
  if (field === "image_alt" && (res.type !== "product" || res.images.length === 0 || conn.missingScopes.some((m) => m.scope === "write_files"))) return null;
  return res.id;
}

const normalize = (v: string | null) => {
  if (v === null) return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t === "" ? null : t;
};

const MAX_LEN: Record<ShopifyField, number> = { seo_title: 255, seo_description: 500, image_alt: 512 };
const FIELD_LABEL: Record<ShopifyField, string> = { seo_title: "Le titre pour Google", seo_description: "La description pour Google", image_alt: "Le texte alternatif" };

function readValue(res: Res, field: ShopifyField, imageId: string | null, locale: string | null): string | null {
  if (field === "image_alt") return res.images.find((i) => i.id === imageId)?.alt ?? null;
  if (locale) return res.en[field].value;
  return field === "seo_title" ? res.seoTitle : res.seoDescription;
}

function writeValue(res: Res, field: ShopifyField, imageId: string | null, locale: string | null, value: string | null) {
  if (field === "image_alt") {
    const i = res.images.find((x) => x.id === imageId);
    if (i) i.alt = value;
    return;
  }
  if (locale) {
    res.en[field] = { value, outdated: false };
    return;
  }
  if (field === "seo_title") res.seoTitle = value;
  else res.seoDescription = value;
  // Le texte d'origine a changé : la traduction date d'avant.
  if (res.en[field].value) res.en[field].outdated = true;
}

export async function handleShopify(ctx: ShopCtx, parts: string[], method: string, body: unknown): Promise<Response> {
  const { json, apiError } = ctx;
  const conn = connectionFor(ctx.host);
  const sub = parts[0] ?? "";
  if (!sub && method === "GET") {
    await ctx.delay(150);
    return json(stateOf(ctx));
  }
  if (conn.state === "not_configured") return apiError(503, "shopify_not_configured", "Aucune boutique Shopify n'est configurée sur ce serveur.", "La personne qui gère l'installation peut la connecter côté serveur.");
  if (conn.state === "other_shop") return apiError(409, "shopify_other_shop", `La boutique connectée (${SHOP_HOST}) n'est pas celle de ce site.`, `Ouvrez le site ${SHOP_HOST} pour gérer sa boutique.`, { shopHost: SHOP_HOST });
  if (conn.state === "error") return apiError(502, "shopify_unavailable", "Shopify ne répond pas pour le moment.", "Réessayez dans quelques minutes.", { retryable: true });
  const shop = shopOf(ctx);
  for (const id of shop.pendingVerify.splice(0)) {
    const c = shop.changes.find((x) => x.id === id);
    if (c) scheduleVerify(ctx, shop, c, 12_000);
  }

  if (sub === "sync" && method === "POST") {
    // Une lecture complète par minute au plus.
    if (shop.lastSync && Date.now() - shop.lastSync < 60_000) {
      return apiError(429, "rate_limited", "La boutique vient d'être lue.", "Patientez une minute avant de la relire.", { retryAfterSeconds: Math.ceil((60_000 - (Date.now() - shop.lastSync)) / 1000) });
    }
    shop.lastSync = Date.now();
    await ctx.delay(2600);
    shop.syncedAt = new Date().toISOString();
    ctx.emit();
    return json(stateOf(ctx));
  }

  if (sub === "resources") {
    if (!shop.syncedAt) return apiError(409, "shopify_not_synced", "La boutique n'a pas encore été lue.", "Lancez une lecture de la boutique : rien n'y sera modifié.", { shopHost: SHOP_HOST });
    const rid = parts[1];
    if (rid) {
      await ctx.delay(380); // relue en direct dans Shopify
      const res = shop.resources.find((r) => r.id === rid);
      if (!res) return apiError(404, "not_found", "Cet élément n'existe plus dans la boutique.", "Relisez la boutique pour mettre la liste à jour.");
      return json({ resource: detailOf(res, ctx, shop) });
    }
    const q = (body as URLSearchParams);
    const type = q.get("type") as ShopifyResourceType | null;
    const text = (q.get("q") ?? "").toLowerCase();
    const missing = q.get("missing") as ShopifyField | null;
    const fix = q.get("fix") as ShopifyField | null;
    const offset = Math.max(0, Number(q.get("offset") ?? 0));
    const limit = Math.min(200, Math.max(1, Number(q.get("limit") ?? 50)));
    let list = shop.resources;
    if (type) list = list.filter((r) => r.type === type);
    if (text) list = list.filter((r) => r.title.toLowerCase().includes(text) || r.path.toLowerCase().includes(text));
    if (missing === "seo_title") list = list.filter((r) => !r.seoTitle);
    if (missing === "seo_description") list = list.filter((r) => !r.seoDescription);
    if (missing === "image_alt") list = list.filter((r) => r.images.some((i) => !i.alt));
    if (fix === "seo_title") list = list.filter((r) => { const a = auditOf(r, ctx); return !!a && a.titleStatus !== "pass"; });
    if (fix === "seo_description") list = list.filter((r) => { const a = auditOf(r, ctx); return !!a && a.descriptionStatus !== "pass"; });
    await ctx.delay(160);
    return json({ resources: list.slice(offset, offset + limit).map((r) => summaryOf(r, ctx, shop)), total: list.length, offset, limit });
  }

  if (sub === "batches" || sub === "optimize") return handleBatches(ctx, shop, conn, parts, method, body);

  if (sub === "changes") {
    if (method === "GET" && !parts[1]) {
      const q = body as URLSearchParams;
      const offset = Math.max(0, Number(q.get("offset") ?? 0));
      const limit = Math.min(200, Math.max(1, Number(q.get("limit") ?? 50)));
      await ctx.delay(140);
      return json({ changes: shop.changes.slice(offset, offset + limit), total: shop.changes.length, offset, limit });
    }
    // Relecture à la demande : n'écrit rien, disponible même quand les écritures sont désactivées.
    if (method === "POST" && parts[1] && parts[2] === "verify") {
      const target = shop.changes.find((c) => c.id === parts[1]);
      if (!target) return apiError(404, "not_found", "Cette modification n'existe pas.", null);
      if (target.kind !== "edit" || !target.restorable || target.correctionStatus === "cancelled") {
        return apiError(400, "bad_request", "Cette modification a été annulée ou remplacée depuis : seule la dernière modification d'un champ se vérifie.", null);
      }
      const t = Date.now();
      shop.verifies = shop.verifies.filter((x) => t - x < 60_000);
      if (shop.verifies.length >= 10) return apiError(429, "rate_limited", "Trop de vérifications en peu de temps.", "Patientez une minute, puis recommencez.", { retryAfterSeconds: 60 });
      shop.verifies.push(t);
      await ctx.delay(2200);
      applyVerification(shop, target, new Date().toISOString());
      ctx.emit();
      return json({ change: target });
    }
    // Écritures : mêmes garde-fous que le serveur.
    if (method !== "POST") return apiError(404, "not_found", "Cette ressource n'existe pas.", null);
    if (!conn.writesEnabled) {
      return apiError(403, "shopify_writes_disabled", "Les modifications de la boutique ne sont pas activées sur ce serveur.", "La personne qui gère l'installation peut les activer avec SHOPIFY_WRITES_ENABLED=1, puis redémarrer le serveur.");
    }
    const now = Date.now();
    shop.writes = shop.writes.filter((t) => now - t < 60_000);
    if (shop.writes.length >= 30) return apiError(429, "rate_limited", "Trop de modifications en peu de temps.", "Patientez un peu, puis recommencez.", { retryAfterSeconds: 30 });
    await ctx.delay(700);

    // Annulation
    if (parts[1] && parts[2] === "restore") {
      const target = shop.changes.find((c) => c.id === parts[1]);
      if (!target) return apiError(404, "not_found", "Cette modification n'existe pas.", null);
      if (!target.restorable) return apiError(400, "bad_request", "Cette modification ne peut plus être annulée : une modification plus récente a été faite sur ce champ.", "Annulez d'abord la plus récente, depuis l'historique.");
      const res = shop.resources.find((r) => r.id === target.resourceId)!;
      const imgObj = target.image ? res.images.find((i) => i.id === target.image!.id) ?? null : null;
      const current = readValue(res, target.field, target.image?.id ?? null, target.locale);
      if (current !== target.after) {
        return apiError(409, "shopify_conflict", "Cette valeur a changé dans Shopify depuis cette modification. Rien n'a été modifié.", "Relisez la valeur actuelle avant de décider.", { current });
      }
      writeValue(res, target.field, target.image?.id ?? null, target.locale, target.before);
      const c = change(res, target.field, imgObj, target.locale, current, target.before, new Date().toISOString(), "restore", target.id);
      target.restoredByChangeId = c.id;
      shop.changes.unshift(c);
      refreshRestorable(shop.changes);
      shop.writes.push(now);
      ctx.emit();
      return json({ change: c, resource: detailOf(res, ctx, shop) }, 201);
    }

    const req = body as ShopifyChangeRequest;
    const res = shop.resources.find((r) => r.id === req.resourceId);
    if (!res) return apiError(404, "not_found", "Cet élément n'existe plus dans la boutique.", "Relisez la boutique.");
    const locale = req.locale ?? null;
    const imageId = req.field === "image_alt" ? req.imageId ?? null : null;
    if (req.field === "image_alt" && !res.images.some((i) => i.id === imageId)) return apiError(400, "bad_request", "Cette image n'existe plus dans la boutique.", "Rechargez l'élément.");
    if (req.field === "image_alt" && res.type !== "product") {
      return apiError(403, "shopify_missing_scope", "Le texte alternatif de cette image ne se modifie pas d'ici.", "Modifiez-le dans l'administration Shopify.", { scope: "write_files" });
    }
    if (req.field === "image_alt" && conn.missingScopes.some((m) => m.scope === "write_files")) {
      return apiError(403, "shopify_missing_scope", "L'application Shopify n'a pas la permission de modifier le texte alternatif des images.", "La personne qui gère l'installation peut ajouter cette permission à l'application Shopify.", { scope: "write_files" });
    }
    const raw = req.value ?? "";
    const low = raw.toLowerCase();
    if (low.includes("permission")) return apiError(403, "shopify_missing_scope", "L'application Shopify n'a pas la permission nécessaire pour ce champ.", "La personne qui gère l'installation peut ajouter cette permission à l'application Shopify.", { scope: "write_translations" });
    if (low.includes("panne")) return apiError(502, "shopify_unavailable", "Shopify n'a pas répondu. Rien n'a été modifié.", "Réessayez dans quelques minutes.", { retryable: true });
    if (low.includes("rafale")) return apiError(429, "rate_limited", "Trop de modifications en peu de temps.", "Patientez un peu, puis recommencez.", { retryAfterSeconds: 20 });
    if (low.includes("conflit")) {
      // Quelqu'un a modifié la valeur dans l'administration Shopify entre-temps.
      const external = req.field === "seo_title" ? `${res.title} fait main` : req.field === "seo_description" ? `${res.title}, pièce artisanale.` : `${res.title}`;
      writeValue(res, req.field, imageId, locale, external);
    }
    const value = normalize(req.value);
    // eslint-disable-next-line no-control-regex
    if (value && (/[<>]/.test(value) || /[\u0000-\u001f\u007f]/.test(value))) {
      return apiError(422, "shopify_invalid_value", `${FIELD_LABEL[req.field]} ne peut pas contenir les signes < ou > ni de caractère de contrôle.`, "Retirez ces caractères, puis recommencez.");
    }
    if (value && [...value].length > MAX_LEN[req.field]) return apiError(422, "shopify_invalid_value", `${FIELD_LABEL[req.field]} fait ${[...value].length} caractères ; ${MAX_LEN[req.field]} au plus.`, "Raccourcissez le texte, puis recommencez.");
    const current = readValue(res, req.field, imageId, locale);
    if ((current ?? null) !== (normalize(req.expectedBefore) ?? null)) {
      return apiError(409, "shopify_conflict", "Cette valeur a changé dans Shopify depuis que vous l'avez affichée. Rien n'a été modifié.", "Relisez la valeur actuelle, puis recommencez.", { current });
    }
    if (current === value) return apiError(400, "bad_request", "Cette valeur est déjà celle de la boutique : rien n'a été modifié.", null);
    writeValue(res, req.field, imageId, locale, value);
    const c = change(res, req.field, res.images.find((i) => i.id === imageId) ?? null, locale, current, value, new Date().toISOString(), "edit");
    if (low.includes("relecture")) c.afterVerified = false;
    shop.changes.unshift(c);
    refreshRestorable(shop.changes);
    shop.writes.push(now);
    // Traduction : pas encore vérifiable, la relecture conclut tout de suite sans charger de page.
    if (locale) applyVerification(shop, c, new Date().toISOString());
    else scheduleVerify(ctx, shop, c, 6_000);
    ctx.emit();
    return json({ change: c, resource: detailOf(res, ctx, shop) }, 201);
  }
  return apiError(404, "not_found", "Cette ressource n'existe pas.", null);
}

// ───────── Automatisation et lots de corrections

type IaMode = "propose" | "auto" | "auto-refuse" | "arret" | "sans-cle" | "budget";
const IA_MODES: IaMode[] = ["propose", "auto", "auto-refuse", "arret", "sans-cle", "budget"];
function readIa(): IaMode {
  const fromUrl = new URLSearchParams(location.search).get("ia") as IaMode | null;
  if (fromUrl && IA_MODES.includes(fromUrl)) {
    sessionStorage.setItem("demo-ia", fromUrl);
    return fromUrl;
  }
  const saved = sessionStorage.getItem("demo-ia") as IaMode | null;
  return saved && IA_MODES.includes(saved) ? saved : "propose";
}
export const iaMode = readIa();
/** Le serveur de démonstration accepte-t-il une clé d'IA (assistant, préparation des corrections). */
export const aiConfiguredDemo = iaMode !== "sans-cle";

const LIMITS: AutomationState["limits"] = {
  maxChangesPerRun: { min: 1, max: 50 },
  maxAutoChangesPerDay: { min: 0, max: 200 },
  aiTokensPerDay: { min: 10_000, max: 2_000_000 },
};

/** Prochain minuit UTC : remise à zéro des compteurs. */
function nextReset(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
}

function initialAutomation(): AutomationState {
  const policy: AutomationPolicy = {
    mode: iaMode === "arret" ? "off" : iaMode === "auto" || iaMode === "auto-refuse" ? "auto" : "propose",
    fields: iaMode === "auto" ? ["seo_description", "image_alt"] : ["seo_description"],
    resourceTypes: ["product", "collection"],
    scope: iaMode === "auto" ? "failing" : "empty_only",
    translations: false,
    maxChangesPerRun: 10,
    maxAutoChangesPerDay: 20,
    aiTokensPerDay: 200_000,
  };
  return {
    policy,
    limits: LIMITS,
    // Mode intégré (?integre=…) : jamais de mode automatique, quel que soit ?ia=.
    autoAllowed: iaMode === "auto" && demoEmbeddedMode === "non",
    writesEnabled: shopifyWritesEnabled,
    aiConfigured: aiConfiguredDemo,
    usage: {
      day: new Date().toISOString().slice(0, 10),
      autoChanges: iaMode === "auto" ? 3 : 0,
      aiTokens: iaMode === "budget" ? 200_000 : iaMode === "auto" ? 14_320 : 6_180,
      resetsAt: nextReset(),
    },
  };
}

let batchSeq = 1;
const batchId = () => `bat_${(batchSeq++).toString(36).padStart(4, "0")}`;
let itemSeq = 1;
const itemId = () => `bit_${(itemSeq++).toString(36).padStart(4, "0")}`;

function countsOf(items: ShopifyBatchItem[]): ShopifyBatch["counts"] {
  return {
    total: items.length,
    selected: items.filter((i) => i.selected).length,
    applied: items.filter((i) => i.state === "applied").length,
    conflict: items.filter((i) => i.state === "conflict").length,
    failed: items.filter((i) => i.state === "failed").length,
    restored: items.filter((i) => i.state === "restored").length,
  };
}

function refreshCounts(b: ShopifyBatch) {
  b.counts = countsOf(b.items);
}

function newBatch(title: string, origin: ProposalOrigin, createdAt: string, state: ShopifyBatch["state"]): ShopifyBatch {
  return {
    id: batchId(), title, origin, createdAt, state, autoApplied: false,
    counts: { total: 0, selected: 0, applied: 0, conflict: 0, failed: 0, restored: 0 }, error: null, finishedAt: null, items: [],
  };
}

function newItem(res: Res, field: ShopifyField, proposed: string, note: string | null, opts: { image?: ShopifyImage | null; locale?: string | null } = {}): ShopifyBatchItem {
  const image = opts.image ?? null;
  const locale = opts.locale ?? null;
  return {
    id: itemId(), resourceId: res.id, resourceType: res.type, resourceTitle: res.title, path: res.path, field,
    image: image ? { id: image.id, url: image.url } : null, locale,
    before: readValue(res, field, image?.id ?? null, locale), proposed, note, selected: true, state: "pending", changeId: null, correctionStatus: null, error: null,
    autoApplied: false,
  };
}

/**
 * Filtre de contenu des écritures automatiques (format d'échange) : une proposition de l'IA appliquée sans
 * relecture est refusée si elle contient une adresse web, un nom de domaine, une adresse e-mail ou un numéro de
 * téléphone, ou si elle ne reprend aucun mot significatif du nom de l'élément. Renvoie la raison, ou null.
 */
function contentFilter(it: ShopifyBatchItem): string | null {
  const v = it.proposed;
  if (/https?:\/\/|www\./i.test(v)) return "Le filtre de contenu l'a retenue : elle contient une adresse web.";
  if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(v)) return "Le filtre de contenu l'a retenue : elle contient une adresse e-mail.";
  if (/\b[a-z0-9-]+\.(?:com|fr|net|org|io|shop|example)\b/i.test(v)) return "Le filtre de contenu l'a retenue : elle contient un nom de domaine.";
  if (/(?:\+33|\b0)[1-9](?:[ .-]?\d{2}){4}\b/.test(v)) return "Le filtre de contenu l'a retenue : elle contient un numéro de téléphone.";
  const words = it.resourceTitle.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4);
  if (words.length && !words.some((w) => v.toLowerCase().includes(w))) return "Le filtre de contenu l'a retenue : elle ne reprend aucun mot du nom de l'élément.";
  return null;
}

/** Écrit une ligne comme le ferait le serveur : relecture, écriture, modification dans l'historique avec son lot. */
function writeItem(shop: Shop, b: ShopifyBatch, it: ShopifyBatchItem, at: string): void {
  const res = shop.resources.find((r) => r.id === it.resourceId);
  if (!res) {
    it.state = "failed";
    it.error = "Cet élément n'existe plus dans la boutique.";
    return;
  }
  const imageId = it.image?.id ?? null;
  if (it.proposed.toLowerCase().includes("conflit")) writeValue(res, it.field, imageId, it.locale, `${res.title} (modifié dans Shopify)`);
  const current = readValue(res, it.field, imageId, it.locale);
  if ((current ?? null) !== (it.before ?? null)) {
    it.state = "conflict";
    it.error = null;
    return;
  }
  if (it.proposed.toLowerCase().includes("panne")) {
    it.state = "failed";
    it.error = "Shopify a refusé la valeur : « Le service est momentanément indisponible ». Rien n'a été écrit.";
    return;
  }
  const value = normalize(it.proposed);
  writeValue(res, it.field, imageId, it.locale, value);
  const c = change(res, it.field, res.images.find((i) => i.id === imageId) ?? null, it.locale, current, value, at, "edit");
  c.batchId = b.id;
  shop.changes.unshift(c);
  it.state = "applied";
  it.changeId = c.id;
  // La ligne porte le statut de sa correction, lu au moment de la réponse.
  Object.defineProperty(it, "correctionStatus", { enumerable: true, configurable: true, get: () => c.correctionStatus });
}

function restoreItem(shop: Shop, b: ShopifyBatch, it: ShopifyBatchItem, at: string): boolean {
  const target = shop.changes.find((c) => c.id === it.changeId);
  if (!target || !target.restorable) {
    it.error = "Cette valeur a été modifiée depuis : elle reste telle quelle.";
    return false;
  }
  const res = shop.resources.find((r) => r.id === it.resourceId)!;
  const imageId = it.image?.id ?? null;
  const current = readValue(res, it.field, imageId, it.locale);
  if (current !== target.after) {
    it.error = "Cette valeur a changé dans Shopify depuis : elle reste telle quelle.";
    return false;
  }
  writeValue(res, it.field, imageId, it.locale, target.before);
  const c = change(res, it.field, res.images.find((i) => i.id === imageId) ?? null, it.locale, current, target.before, at, "restore", target.id);
  c.batchId = b.id;
  target.restoredByChangeId = c.id;
  shop.changes.unshift(c);
  it.state = "restored";
  it.error = null;
  return true;
}

const proposalFor = (res: Res, field: ShopifyField): string => {
  if (field === "seo_title") {
    const options = [`${res.title} en grès fait main | Atelier Lune`, `${res.title} fait main | Atelier Lune`, `${res.title} | Atelier Lune`, res.title];
    return options.find((o) => [...o].length <= 60) ?? [...res.title].slice(0, 60).join("");
  }
  if (field === "image_alt") return `${res.title}, vue de face sur fond clair`;
  const base = res.type === "collection"
    ? `${res.title} : notre sélection de pièces en grès tournées à la main à Nantes. Livraison soignée, retours sous 30 jours.`
    : `${res.title} en grès émaillé, tourné à la main dans notre atelier de Nantes. Pièce unique, livraison soignée sous 48 h.`;
  return [...base].slice(0, 158).join("");
};

const noteFor = (res: Res, field: ShopifyField, ctx: ShopCtx | null): string => {
  const a = ctx ? auditOf(res, ctx) : null;
  if (field === "seo_title") {
    if (!res.seoTitle && a) return `Le titre était vide : la page affichait « ${a.renderedTitle} », ${a.titleStatus === "pass" ? "correct mais peu descriptif" : "trop court pour décrire la page"}.`;
    return "Le titre renseigné ne dit pas ce que vend la page ; la proposition reprend le nom et la matière.";
  }
  if (field === "image_alt") return "L'image n'était pas décrite : la proposition dit ce qu'elle montre, à partir du nom du produit.";
  if (!res.seoDescription) return res.type === "product" ? "La description était vide : Google affichait le début de la fiche (320 caractères, coupés)." : "La description était vide et la page n'a pas de texte : Google choisissait seul un extrait.";
  return "La description affichée sortait des repères de longueur (70 à 160 caractères).";
};

/** Lots présents au chargement : un dans chaque état utile. */
function seedBatches(shop: Shop) {
  const products = shop.resources.filter((r) => r.type === "product");
  const collections = shop.resources.filter((r) => r.type === "collection");
  const at = (iso: string, plusSec: number) => new Date(new Date(iso).getTime() + plusSec * 1000).toISOString();

  // Échec de la préparation (le plus ancien).
  const failed = newBatch("Descriptions des collections", "automation", "2026-11-22T21:00:00.000Z", "failed");
  failed.error = { code: "budget_exceeded", message: "Le plafond de jetons d'IA du jour était atteint : aucune proposition n'a été préparée.", action: "Réessayez après la remise à zéro, ou relevez le plafond dans l'onglet Automatisation.", details: { resetsAt: "2026-11-23T00:00:00.000Z" } };
  failed.finishedAt = failed.createdAt;

  // Abandonné sans rien écrire.
  const cancelled = newBatch("Titres des pages d'information", "assistant", "2026-11-23T15:12:00.000Z", "cancelled");
  for (const r of shop.resources.filter((x) => x.type === "page").slice(0, 2)) cancelled.items.push({ ...newItem(r, "seo_title", proposalFor(r, "seo_title"), noteFor(r, "seo_title", null)), selected: false, state: "skipped" });
  cancelled.finishedAt = at(cancelled.createdAt, 600);

  // Appliqué puis annulé en entier.
  const restored = newBatch("Textes alternatifs, première série", "manual", "2026-11-24T09:30:00.000Z", "applying");
  for (const r of products.slice(10, 12)) {
    const im = r.images.find((i) => !i.alt);
    if (im) restored.items.push(newItem(r, "image_alt", `${r.title}, posé sur une table en bois`, null, { image: im }));
  }
  restored.items.forEach((it, i) => writeItem(shop, restored, it, at(restored.createdAt, 60 + i * 2)));
  refreshRestorable(shop.changes.sort((a, b) => b.appliedAt.localeCompare(a.appliedAt)));
  restored.items.forEach((it, i) => restoreItem(shop, restored, it, at(restored.createdAt, 3600 + i * 2)));
  restored.state = "restored";
  restored.finishedAt = at(restored.createdAt, 3610);

  // Appliqué en partie : une valeur changée entre-temps, une refusée par Shopify.
  const partial = newBatch("Titres des collections", "manual", "2026-11-25T14:05:00.000Z", "applying");
  const pc = collections.slice(2, 6);
  pc.forEach((r) => partial.items.push(newItem(r, "seo_title", proposalFor(r, "seo_title"), null)));
  partial.items.forEach((it, i) => {
    const res = shop.resources.find((r) => r.id === it.resourceId)!;
    // Ligne 3 : quelqu'un a modifié le titre dans l'administration Shopify entre la préparation et l'écriture.
    if (i === 2) writeValue(res, "seo_title", null, null, `${res.title} — collection d'hiver`);
    if (i === 3) {
      it.state = "failed";
      it.error = "Shopify a refusé la valeur : « Title tag is too long for this theme setting ». Rien n'a été écrit.";
      return;
    }
    writeItem(shop, partial, it, at(partial.createdAt, 90 + i * 2));
  });
  partial.state = "partial";
  partial.finishedAt = at(partial.createdAt, 100);
  // Une correction jamais relue (comme après un redémarrage du serveur) : « Vérifier » à la demande.
  const unread = partial.items[1]?.changeId;
  if (unread) shop.seedKeep.add(unread);

  // Appliqué sans validation humaine par l'optimisation automatique.
  const auto = newBatch("Descriptions vides de produits", "automation", "2026-11-26T22:00:00.000Z", "applying");
  // La quatrième proposition cite le domaine de la boutique : le filtre de contenu la retient, elle attend
  // une validation humaine et le lot repasse en brouillon (les trois autres sont écrites sans validation).
  const autoRes = products.filter((x) => !x.seoDescription).slice(4, 8);
  for (const r of autoRes) auto.items.push(newItem(r, "seo_description", proposalFor(r, "seo_description"), noteFor(r, "seo_description", null)));
  const filtered = auto.items[3];
  if (filtered) filtered.proposed = `${filtered.resourceTitle} en grès émaillé, à découvrir sur ${SHOP_HOST}. Pièce unique tournée à la main à Nantes.`;
  auto.items.forEach((it, i) => {
    const why = contentFilter(it);
    if (why) {
      it.error = why;
      return;
    }
    writeItem(shop, auto, it, at(auto.createdAt, 30 + i * 2));
    it.autoApplied = it.state === "applied";
  });
  // La dernière ligne écrite attend encore sa relecture : elle se termine quelques secondes après le chargement.
  const lastWritten = [...auto.items].reverse().find((i) => i.state === "applied")?.changeId;
  if (lastWritten) shop.pendingVerify.push(lastWritten);
  auto.state = auto.items.some((i) => i.state === "pending") ? "draft" : "applied";
  auto.autoApplied = auto.items.some((i) => i.autoApplied);
  auto.finishedAt = auto.state === "draft" ? null : at(auto.createdAt, 40);

  // Brouillon préparé par l'assistant, à valider.
  const draft = newBatch("Descriptions de produits proposées par l'assistant", "assistant", "2026-11-27T09:40:00.000Z", "draft");
  for (const r of products.filter((x) => !x.seoDescription).slice(0, 4)) draft.items.push(newItem(r, "seo_description", proposalFor(r, "seo_description"), noteFor(r, "seo_description", null)));
  const tooLong = draft.items[1];
  if (tooLong) tooLong.proposed = `${tooLong.resourceTitle} en grès émaillé, tourné à la main dans notre atelier de Nantes, cuit à haute température pour une solidité à toute épreuve, au lave-vaisselle comme au four. Pièce unique.`;

  shop.batches = [draft, auto, partial, restored, cancelled, failed];
  shop.batches.forEach(refreshCounts);
  DEMO_BATCH_IDS.assistantDraft = draft.id;
  DEMO_BATCH_IDS.autoApplied = auto.id;
}

/** Identifiants des lots présents au chargement (pour la conversation de démonstration). */
export const DEMO_BATCH_IDS = { assistantDraft: "", autoApplied: "" };

/** Une valeur écrite toutes les 1,6 s : assez lent pour voir la progression et essayer « Arrêter ». */
const WRITE_EVERY_MS = 1_600;

function stopTimer(shop: Shop, id: string) {
  const t = shop.timers.get(id);
  if (t) clearInterval(t);
  shop.timers.delete(id);
}

/** Écrit les lignes retenues une par une, à 0,9 s d'intervalle (au rythme de la limite d'écriture). */
function runApply(ctx: ShopCtx, shop: Shop, b: ShopifyBatch, auto: boolean) {
  b.state = "applying";
  b.finishedAt = null;
  stopTimer(shop, b.id);
  const tick = () => {
    // En automatique, une ligne retenue par le filtre de contenu reste en attente (avec sa raison) : on passe à la suivante.
    const next = b.items.find((i) => i.selected && i.state === "pending" && !(auto && i.error));
    if (next && auto) {
      const a = shop.automation;
      const u = a.usage;
      // Les verrous sont revérifiés avant chaque ligne : passer la règle sur « off » ou « propose » arrête l'écriture.
      if (a.policy.mode !== "auto" || u.autoChanges >= a.policy.maxAutoChangesPerDay) {
        b.state = "draft";
        refreshCounts(b);
        stopTimer(shop, b.id);
        ctx.emit();
        return;
      }
      const why = contentFilter(next);
      if (why) {
        next.error = why;
        refreshCounts(b);
        ctx.emit();
        return;
      }
      u.autoChanges += 1;
    }
    if (next) {
      writeItem(shop, b, next, new Date().toISOString());
      const written = next.state === "applied" ? shop.changes.find((c) => c.id === next.changeId) : undefined;
      if (written) {
        if (written.locale) applyVerification(shop, written, new Date().toISOString());
        else scheduleVerify(ctx, shop, written, 6_000);
      }
      if (auto && next.state === "applied") {
        next.autoApplied = true;
        b.autoApplied = true;
      }
      refreshRestorable(shop.changes);
    } else if (auto && b.items.some((i) => i.selected && i.state === "pending")) {
      // Des lignes retenues par le filtre attendent une validation humaine : le lot repasse en brouillon.
      b.state = "draft";
      stopTimer(shop, b.id);
    } else {
      b.state = b.items.some((i) => i.state === "conflict" || i.state === "failed") ? "partial" : "applied";
      b.finishedAt = new Date().toISOString();
      stopTimer(shop, b.id);
    }
    refreshCounts(b);
    ctx.emit();
  };
  shop.timers.set(b.id, setInterval(tick, WRITE_EVERY_MS));
}

function runRestore(ctx: ShopCtx, shop: Shop, b: ShopifyBatch) {
  b.state = "applying";
  stopTimer(shop, b.id);
  const queue = b.items.filter((i) => i.state === "applied");
  let kept = 0;
  const tick = () => {
    const next = queue.shift();
    if (next) {
      if (!restoreItem(shop, b, next, new Date().toISOString())) kept++;
      refreshRestorable(shop.changes);
    } else {
      b.state = kept > 0 ? "partial" : "restored";
      b.finishedAt = new Date().toISOString();
      stopTimer(shop, b.id);
    }
    refreshCounts(b);
    ctx.emit();
  };
  shop.timers.set(b.id, setInterval(tick, WRITE_EVERY_MS));
}

/** Éléments que la règle autorise pour ce champ, d'abord ceux dont la page analysée est en défaut. */
function candidates(ctx: ShopCtx, shop: Shop, field: ShopifyField, type: ShopifyResourceType | undefined, policy: AutomationPolicy) {
  const out: { res: Res; image: ShopifyImage | null; failing: boolean }[] = [];
  for (const r of shop.resources) {
    if (type && r.type !== type) continue;
    if (!policy.resourceTypes.includes(r.type)) continue;
    if (shop.batches.some((b) => (b.state === "draft" || b.state === "preparing") && b.items.some((i) => i.resourceId === r.id && i.field === field))) continue;
    if (field === "image_alt") {
      if (r.type !== "product") continue;
      const im = r.images.find((i) => !i.alt || policy.scope === "any");
      if (im) out.push({ res: r, image: im, failing: !im.alt });
      continue;
    }
    const value = field === "seo_title" ? r.seoTitle : r.seoDescription;
    const a = auditOf(r, ctx);
    const failing = !!a && (field === "seo_title" ? a.titleStatus : a.descriptionStatus) !== "pass";
    const ok = policy.scope === "any" || !value || (policy.scope === "failing" && failing);
    if (ok) out.push({ res: r, image: null, failing });
  }
  return out.sort((x, y) => Number(y.failing) - Number(x.failing));
}

/** L'IA « rédige » : une proposition toutes les 0,7 s, comptée en jetons ; puis le brouillon (ou l'application automatique). */
function runPrepare(ctx: ShopCtx, shop: Shop, b: ShopifyBatch, picks: ReturnType<typeof candidates>, field: ShopifyField) {
  const a = shop.automation;
  const queue = picks.slice();
  stopTimer(shop, b.id);
  const tick = () => {
    const next = queue.shift();
    if (next && a.usage.aiTokens + 1_850 > a.policy.aiTokensPerDay) {
      b.error = { code: "budget_exceeded", message: "Plafond de jetons d'IA du jour atteint : la préparation s'est arrêtée. Le lot garde ce qui a été préparé.", action: null, details: { resetsAt: a.usage.resetsAt } };
      queue.length = 0;
    } else if (next) {
      a.usage.aiTokens += 1_850;
      b.items.push(newItem(next.res, field, proposalFor(next.res, field), noteFor(next.res, field, ctx), { image: next.image }));
      refreshCounts(b);
      ctx.emit();
      return;
    }
    stopTimer(shop, b.id);
    if (b.items.length === 0) {
      b.state = "failed";
      b.error = b.error ?? { code: "internal", message: "L'IA n'a rien pu préparer.", action: "Réessayez dans un instant.", details: undefined };
      b.finishedAt = new Date().toISOString();
      ctx.emit();
      return;
    }
    const conn = connectionFor(ctx.host);
    if (a.policy.mode === "auto" && a.autoAllowed && conn.writesEnabled) {
      runApply(ctx, shop, b, true);
    } else {
      b.state = "draft";
    }
    refreshCounts(b);
    ctx.emit();
  };
  shop.timers.set(b.id, setInterval(tick, 700));
}

const strip = ({ items: _i, ...rest }: ShopifyBatch) => rest;

/** Un seul lot en écriture ou en annulation par site (format d'échange) : limit_reached sinon. */
function otherWriting(ctx: ShopCtx, shop: Shop, b: ShopifyBatch) {
  const other = shop.batches.find((x) => x.id !== b.id && x.state === "applying");
  if (!other) return null;
  return ctx.apiError(409, "limit_reached", `Un autre lot est en cours d'écriture sur ce site : « ${other.title} ».`, "Attendez sa fin ou arrêtez-le, puis recommencez.", { batchId: other.id });
}

/** Limites de débit de la démo, comme le serveur : créations de lot, préparations par l'IA, enregistrements de règle. */
const hits = new Map<string, number[]>();
function overRate(key: string, perMinute: number): number {
  const now = Date.now();
  const list = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
  if (list.length >= perMinute) {
    hits.set(key, list);
    return Math.ceil((60_000 - (now - list[0])) / 1000);
  }
  list.push(now);
  hits.set(key, list);
  return 0;
}

function handleBatches(ctx: ShopCtx, shop: Shop, conn: ShopifyConnection, parts: string[], method: string, body: unknown): Promise<Response> | Response {
  const { json, apiError } = ctx;
  if (!shop.syncedAt) return apiError(409, "shopify_not_synced", "La boutique n'a pas encore été lue.", "Lancez une lecture de la boutique : rien n'y sera modifié.", { shopHost: SHOP_HOST });

  if (parts[0] === "optimize" && method === "POST") {
    const req = body as OptimizeRequest;
    const a = shop.automation;
    const wait = overRate(`optimize:${ctx.host}`, 5);
    if (wait) return apiError(429, "rate_limited", "Vous avez demandé beaucoup de préparations en peu de temps.", "Patientez un peu, puis relancez la préparation.", { retryAfterSeconds: wait });
    if (!a.aiConfigured) return apiError(503, "chat_not_configured", "Aucune clé d'API Claude n'est configurée sur ce serveur : l'IA ne peut rien préparer.", "La personne qui gère l'installation peut ajouter ANTHROPIC_API_KEY côté serveur.");
    if (a.policy.mode === "off") return apiError(409, "automation_off", "L'automatisation est arrêtée pour ce site : l'IA ne prépare aucune correction.", "Choisissez « L'IA prépare, vous validez » dans l'onglet Automatisation.");
    if (!a.policy.fields.includes(req.field)) return apiError(403, "automation_not_allowed", `La règle n'autorise pas l'IA à proposer ce champ.`, "Ajoutez-le aux champs autorisés dans l'onglet Automatisation.");
    if (req.resourceType && !a.policy.resourceTypes.includes(req.resourceType)) return apiError(403, "automation_not_allowed", "La règle n'autorise pas l'IA sur ce type d'élément.", "Ajoutez-le aux types autorisés dans l'onglet Automatisation.");
    if (a.usage.aiTokens >= a.policy.aiTokensPerDay) return apiError(429, "budget_exceeded", "Le plafond de jetons d'IA du jour est atteint.", "Réessayez après la remise à zéro, ou relevez le plafond dans l'onglet Automatisation.", { resetsAt: a.usage.resetsAt });
    const limit = Math.max(1, Math.min(a.policy.maxChangesPerRun, req.limit ?? a.policy.maxChangesPerRun));
    const picks = candidates(ctx, shop, req.field, req.resourceType, a.policy).slice(0, limit);
    if (picks.length === 0) return apiError(403, "automation_not_allowed", "Aucun élément ne correspond à la règle pour ce champ : rien à préparer.", "Élargissez ce que l'IA a le droit de remplacer, ou choisissez un autre champ.");
    const label = req.field === "seo_title" ? "Titres préparés" : req.field === "seo_description" ? "Descriptions préparées" : "Textes alternatifs préparés";
    const b = newBatch(`${label} par l'IA`, "automation", new Date().toISOString(), "preparing");
    shop.batches.unshift(b);
    runPrepare(ctx, shop, b, picks, req.field);
    return json({ batch: b }, 202);
  }

  const id = parts[1];
  if (!id) {
    if (method === "GET") return json({ batches: shop.batches.map(strip) });
    if (method === "POST") {
      const req = body as CreateBatchRequest;
      const wait = req.title?.toLowerCase().includes("rafale") ? 20 : overRate(`batch:${ctx.host}`, 10);
      if (wait) return apiError(429, "rate_limited", "Trop de lots créés en peu de temps.", "Patientez un peu : votre lot en préparation est conservé.", { retryAfterSeconds: wait });
      if (!Array.isArray(req.items) || req.items.length === 0) return apiError(400, "bad_request", "Le lot ne contient aucune ligne.", null);
      if (req.items.length > 50) return apiError(400, "bad_request", "Un lot compte 50 lignes au plus.", "Répartissez vos corrections sur plusieurs lots.");
      const seen = new Set<string>();
      const b = newBatch(req.title?.trim() || `Lot du ${new Date().toLocaleDateString("fr-FR", { day: "numeric", month: "long" })}`, "manual", new Date().toISOString(), "draft");
      for (const it of req.items) {
        const res = shop.resources.find((r) => r.id === it.resourceId);
        if (!res) return apiError(404, "not_found", "Un élément du lot n'existe plus dans la boutique.", "Relisez la boutique.");
        const k = `${it.resourceId}|${it.field}|${it.imageId ?? ""}|${it.locale ?? ""}`;
        if (seen.has(k)) return apiError(400, "bad_request", `Deux lignes visent le même champ de « ${res.title} ».`, "Gardez-en une seule.");
        seen.add(k);
        const v = normalize(it.value);
        // eslint-disable-next-line no-control-regex
        if (!v || /[<>]/.test(v) || /[\u0000-\u001f\u007f]/.test(v) || [...v].length > MAX_LEN[it.field]) {
          return apiError(422, "shopify_invalid_value", `La valeur proposée pour « ${res.title} » est refusée telle quelle.`, "Corrigez-la, puis recommencez.");
        }
        const image = it.imageId ? res.images.find((i) => i.id === it.imageId) ?? null : null;
        const item = newItem(res, it.field, v, null, { image, locale: it.locale ?? null });
        if (item.before === v) return apiError(400, "bad_request", `La valeur proposée pour « ${res.title} » est déjà celle de la boutique.`, "Retirez cette ligne ou changez sa valeur.");
        b.items.push(item);
      }
      refreshCounts(b);
      shop.batches.unshift(b);
      ctx.emit();
      return json({ batch: b }, 201);
    }
  }
  const b = shop.batches.find((x) => x.id === id);
  if (!b) return apiError(404, "not_found", "Ce lot n'existe pas.", "Revenez à la liste des lots.");
  const action = parts[2];
  if (!action) {
    if (method === "GET") return json({ batch: b });
    if (method === "DELETE") {
      if (b.state !== "draft") return apiError(409, "batch_not_editable", "Ce lot n'est plus un brouillon.", null);
      b.state = "cancelled";
      b.items.forEach((i) => { if (i.state === "pending") { i.state = "skipped"; i.selected = false; } });
      b.finishedAt = new Date().toISOString();
      refreshCounts(b);
      ctx.emit();
      return json({ batch: b });
    }
  }
  if (action === "items" && method === "PATCH") {
    if (b.state !== "draft") return apiError(409, "batch_not_editable", "Ce lot n'est plus un brouillon : il ne se modifie plus.", null);
    const it = b.items.find((i) => i.id === parts[3]);
    if (!it) return apiError(404, "not_found", "Cette ligne n'existe pas.", null);
    const req = body as UpdateBatchItemRequest;
    if (typeof req.proposed === "string") {
      const v = normalize(req.proposed);
      // eslint-disable-next-line no-control-regex
      if (!v || /[<>]/.test(v) || /[\u0000-\u001f\u007f]/.test(v) || [...v].length > MAX_LEN[it.field]) return apiError(422, "shopify_invalid_value", "Cette valeur est refusée telle quelle.", "Corrigez-la, puis recommencez.");
      if (v === it.before) return apiError(400, "bad_request", "Cette valeur est déjà celle de la boutique.", "Écartez plutôt la ligne.");
      it.proposed = v;
    }
    if (typeof req.selected === "boolean") {
      it.selected = req.selected;
      it.state = req.selected ? "pending" : "skipped";
    }
    refreshCounts(b);
    return json({ batch: b });
  }
  if (action === "apply" && method === "POST") {
    if (!conn.writesEnabled) return apiError(403, "shopify_writes_disabled", "Les modifications de la boutique ne sont pas activées sur ce serveur.", "La personne qui gère l'installation peut les activer avec SHOPIFY_WRITES_ENABLED=1, puis redémarrer le serveur.");
    const resumable = b.state === "partial" && b.items.some((i) => i.selected && i.state === "pending");
    if (b.state !== "draft" && !resumable) return apiError(409, "batch_not_editable", "Ce lot n'est plus un brouillon.", null);
    if (b.counts.selected === 0) return apiError(400, "bad_request", "Aucune ligne n'est retenue.", "Retenez au moins une ligne.");
    const busy = otherWriting(ctx, shop, b);
    if (busy) return busy;
    // Validée par un humain : les lignes retenues par le filtre de contenu sont écrites comme les autres.
    b.items.forEach((i) => { if (i.state === "pending") i.error = null; });
    runApply(ctx, shop, b, false);
    refreshCounts(b);
    ctx.emit();
    return json({ batch: b }, 202);
  }
  if (action === "restore" && method === "POST") {
    if (!conn.writesEnabled) return apiError(403, "shopify_writes_disabled", "Les modifications de la boutique ne sont pas activées sur ce serveur.", "La personne qui gère l'installation peut les activer avec SHOPIFY_WRITES_ENABLED=1, puis redémarrer le serveur.");
    if (b.counts.applied === 0) return apiError(400, "bad_request", "Aucune ligne de ce lot n'est à annuler.", null);
    const busy = otherWriting(ctx, shop, b);
    if (busy) return busy;
    runRestore(ctx, shop, b);
    ctx.emit();
    return json({ batch: b }, 202);
  }
  if (action === "stop" && method === "POST") {
    if (b.state !== "applying") return apiError(409, "batch_not_editable", "Ce lot n'est pas en cours d'écriture.", null);
    // La ligne en cours est déjà terminée dans la démo (chaque écriture est instantanée) : on s'arrête là.
    stopTimer(shop, b.id);
    b.state = "partial";
    b.finishedAt = new Date().toISOString();
    refreshCounts(b);
    ctx.emit();
    return json({ batch: b });
  }
  return apiError(404, "not_found", "Cette ressource n'existe pas.", null);
}

/** GET et PUT /api/sites/:id/automation. */
export async function handleAutomation(ctx: ShopCtx, method: string, body: unknown): Promise<Response> {
  const { json, apiError } = ctx;
  const shop = shopOf(ctx);
  const a = shop.automation;
  a.writesEnabled = connectionFor(ctx.host).writesEnabled;
  if (new Date(a.usage.resetsAt).getTime() <= Date.now()) a.usage = { day: new Date().toISOString().slice(0, 10), autoChanges: 0, aiTokens: 0, resetsAt: nextReset() };
  if (method === "PUT") {
    const wait = overRate(`automation:${ctx.host}`, 10);
    if (wait) return apiError(429, "rate_limited", "La règle a été enregistrée beaucoup de fois en peu de temps.", "Patientez un peu, puis enregistrez de nouveau.", { retryAfterSeconds: wait });
    const p = (body as UpdateAutomationRequest).policy;
    const inRange = (v: number, r: { min: number; max: number }) => Number.isInteger(v) && v >= r.min && v <= r.max;
    if (!p || !["off", "propose", "auto"].includes(p.mode)) return apiError(400, "bad_request", "Niveau d'automatisation inconnu.", null);
    if (!inRange(p.maxChangesPerRun, LIMITS.maxChangesPerRun) || !inRange(p.maxAutoChangesPerDay, LIMITS.maxAutoChangesPerDay) || !inRange(p.aiTokensPerDay, LIMITS.aiTokensPerDay)) {
      return apiError(400, "bad_request", "Un plafond sort des bornes acceptées.", "Corrigez la valeur, puis enregistrez.");
    }
    a.policy = { ...p, fields: [...new Set(p.fields)], resourceTypes: [...new Set(p.resourceTypes)] };
    await ctx.delay(300);
  }
  return json(a);
}

/**
 * L'assistant prépare un lot (outil de la conversation) : soumis à la règle, comme l'optimisation.
 * Renvoie l'identifiant du lot, ou null si la règle ne le permet pas.
 */
export function assistantBatch(ctx: ShopCtx): string | null {
  if (connectionFor(ctx.host).state !== "connected") return null;
  const shop = shopOf(ctx);
  const a = shop.automation;
  if (!shop.syncedAt || a.policy.mode === "off" || !a.aiConfigured) return null;
  const field: ShopifyField = a.policy.fields.includes("seo_description") ? "seo_description" : a.policy.fields[0];
  if (!field) return null;
  const picks = candidates(ctx, shop, field, undefined, a.policy).slice(0, Math.min(3, a.policy.maxChangesPerRun));
  if (!picks.length) return null;
  const b = newBatch("Corrections proposées dans la conversation", "assistant", new Date().toISOString(), "draft");
  for (const p of picks) b.items.push(newItem(p.res, field, proposalFor(p.res, field), noteFor(p.res, field, ctx), { image: p.image }));
  refreshCounts(b);
  shop.batches.unshift(b);
  // Un lot préparé par l'assistant attend toujours une validation humaine, quel que soit le niveau (format d'échange).
  ctx.emit();
  return b.id;
}

/**
 * Bilan des corrections pour l'évolution (Progress.corrections), compté sur l'historique de la boutique tel que
 * GET …/shopify/changes le renvoie : les compteurs du rapport correspondent donc à sa liste. Sans boutique reliée
 * à ce site (autre boutique, non configurée, en erreur), tout vaut 0.
 */
export function demoCorrections(ctx: ShopCtx): { verified: number; applied: number; failed: number; cancelled: number; resourcesOptimized: number; firstAt: string | null; lastAt: string | null } {
  const empty = { verified: 0, applied: 0, failed: 0, cancelled: 0, resourcesOptimized: 0, firstAt: null, lastAt: null };
  if (connectionFor(ctx.host).state !== "connected") return empty;
  const edits = shopOf(ctx).changes.filter((c) => c.kind === "edit");
  const out = { ...empty };
  const optimized = new Set<string>();
  const inPlace: string[] = [];
  for (const c of edits) {
    const st = c.correctionStatus;
    if (st === "verified") {
      out.verified++;
      optimized.add(c.resourceId);
    } else if (st === "applied" || st === "verifying") out.applied++;
    else if (st === "failed") out.failed++;
    else if (st === "cancelled") out.cancelled++;
    if (c.restoredByChangeId === null) inPlace.push(c.appliedAt);
  }
  inPlace.sort();
  return { ...out, resourcesOptimized: optimized.size, firstAt: inPlace[0] ?? null, lastAt: inPlace[inPlace.length - 1] ?? null };
}

/** Les lots de démonstration existent dès le premier chargement de la boutique. */
export function ensureShop(ctx: Pick<ShopCtx, "host" | "inventory">) {
  if (connectionFor(ctx.host).state !== "connected") return;
  if (!shops.has(ctx.host)) shops.set(ctx.host, buildShop(ctx.inventory));
}
