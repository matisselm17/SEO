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
 * Le second site (Maison Orlux) voit toujours « la boutique connectée est celle d'un autre site ».
 *
 * Saisies spéciales dans un champ, au moment d'appliquer :
 *   « conflit »    la valeur a été changée dans Shopify entre-temps → shopify_conflict (details.current)
 *   « rafale »     rate_limited (30 écritures par minute)
 *   « permission » shopify_missing_scope
 *   « panne »      shopify_unavailable
 *   « relecture »  Shopify accepte, mais la valeur n'a pas pu être relue (afterVerified: false)
 *   « < » ou « > », caractère de contrôle, texte trop long : shopify_invalid_value (l'interface le bloque avant)
 */
import type {
  ApiError, ErrorCode, ShopifyChange, ShopifyChangeRequest, ShopifyConnection, ShopifyField, ShopifyImage, ShopifyResourceDetail,
  ShopifyResourceSummary, ShopifyResourceType, ShopifyState, ShopifyTranslation,
} from "../lib/types";
import { rng, type DemoPage } from "./data";

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
}

interface Shop {
  resources: Res[];
  changes: ShopifyChange[];
  syncedAt: string | null;
  writes: number[];
  lastSync: number | null;
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
      // Comme le serveur : « shr_ » suivi de 6 à 40 caractères [a-z0-9].
      id: `shr_${(slug.normalize("NFD").replace(/[^a-z0-9]/g, "").slice(0, 30) + n.toString(36)).padEnd(6, "0")}`,
      type, path: p.summary.path, title: name, seoTitle, seoDescription, images, pagePath: p.summary.path,
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
    bol.seoDescription = "Bol en grès émaillé bleu, tourné à la main à Nantes.";
    changes.push(change(bol, "seo_description", null, null, before, bol.seoDescription, "2026-11-27T10:20:31.000Z", "edit"));
    const other = resources.filter((x) => x.type === "collection")[1];
    if (other) {
      const prev = other.seoTitle;
      other.seoTitle = "Assiettes en grès émaillé faites à Nantes | Atelier Lune";
      const c1 = change(other, "seo_title", null, null, prev, other.seoTitle, "2026-11-26T16:42:10.000Z", "edit");
      changes.unshift(c1);
    }
  }
  changes.sort((a, b) => b.appliedAt.localeCompare(a.appliedAt));
  refreshRestorable(changes);
  return { resources, changes, syncedAt: shopMode === "jamais-lue" ? null : "2026-11-27T10:12:04.000Z", writes: [], lastSync: null };
}

let seq = 1;
function change(res: Res, field: ShopifyField, image: ShopifyImage | null, locale: string | null, before: string | null, after: string | null, at: string, kind: "edit" | "restore", restores: string | null = null): ShopifyChange {
  return {
    id: `chg_${(seq++).toString(36)}`, resourceId: res.id, resourceType: res.type, resourceTitle: res.title, path: res.path, field,
    image: image ? { id: image.id, url: image.url } : null, locale, before, after, appliedAt: at, kind,
    afterVerified: true, restoresChangeId: restores, restoredByChangeId: null, restorable: false,
  };
}

/** Seule la dernière modification d'un champ (élément, image, langue) est annulable, et seulement si elle n'a pas été annulée. */
function refreshRestorable(changes: ShopifyChange[]) {
  const seen = new Set<string>();
  for (const c of changes) {
    const k = `${c.resourceId}|${c.field}|${c.image?.id ?? ""}|${c.locale ?? ""}`;
    c.restorable = !seen.has(k) && c.restoredByChangeId === null;
    seen.add(k);
  }
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

function summaryOf(res: Res, ctx: ShopCtx, shop: Shop): ShopifyResourceSummary {
  const page = ctx.shown.find((p) => p.summary.path === res.pagePath) ?? null;
  return {
    id: res.id, type: res.type, path: res.path, title: res.title, seoTitle: res.seoTitle, seoDescription: res.seoDescription,
    images: res.images.length, imagesWithoutAlt: res.images.filter((i) => !i.alt).length,
    pageId: page?.summary.id ?? null, pageScore: page?.summary.score ?? null,
    changes: shop.changes.filter((c) => c.resourceId === res.id).length,
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
    const offset = Math.max(0, Number(q.get("offset") ?? 0));
    const limit = Math.min(200, Math.max(1, Number(q.get("limit") ?? 50)));
    let list = shop.resources;
    if (type) list = list.filter((r) => r.type === type);
    if (text) list = list.filter((r) => r.title.toLowerCase().includes(text) || r.path.toLowerCase().includes(text));
    if (missing === "seo_title") list = list.filter((r) => !r.seoTitle);
    if (missing === "seo_description") list = list.filter((r) => !r.seoDescription);
    if (missing === "image_alt") list = list.filter((r) => r.images.some((i) => !i.alt));
    await ctx.delay(160);
    return json({ resources: list.slice(offset, offset + limit).map((r) => summaryOf(r, ctx, shop)), total: list.length, offset, limit });
  }

  if (sub === "changes") {
    if (method === "GET" && !parts[1]) {
      const q = body as URLSearchParams;
      const offset = Math.max(0, Number(q.get("offset") ?? 0));
      const limit = Math.min(200, Math.max(1, Number(q.get("limit") ?? 50)));
      await ctx.delay(140);
      return json({ changes: shop.changes.slice(offset, offset + limit), total: shop.changes.length, offset, limit });
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
    ctx.emit();
    return json({ change: c, resource: detailOf(res, ctx, shop) }, 201);
  }
  return apiError(404, "not_found", "Cette ressource n'existe pas.", null);
}
