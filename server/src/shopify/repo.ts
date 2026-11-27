/**
 * Stockage des données Shopify : dernière lecture de la boutique (par site) et historique des écritures
 * (par hôte du site, conservé même si le site est supprimé du logiciel).
 *
 * Les identifiants Shopify (gid://…) restent côté serveur : l'interface ne voit que des identifiants
 * internes dérivés (shr_…, img_…), stables d'une lecture à l'autre.
 */
import { createHash } from "node:crypto";
import type { ShopifyChange, ShopifyField, ShopifyResourceType } from "../../../shared/api.ts";
import { newId, tx, type DB, type Row } from "../db.ts";

export const RESOURCE_TYPES: ShopifyResourceType[] = ["product", "collection", "page", "article"];

const digest = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);
/** Identifiant interne d'un élément de la boutique, dérivé de son identifiant Shopify. */
export const resourceIdOf = (gid: string) => `shr_${digest(gid)}`;
/** Identifiant interne d'une image : celui du média pour un produit, sinon l'image unique de l'élément. */
export const imageIdOf = (key: string) => `img_${digest(key)}`;

/**
 * Clé de rapprochement d'un chemin : décodé, sans paramètres ni fragment, en minuscules, sans slash final.
 * La même fonction sert pour les pages de l'analyse et pour les éléments de la boutique.
 */
export function pathKey(raw: string): string {
  let p = raw.split("#")[0].split("?")[0].trim();
  try {
    p = decodeURIComponent(p);
  } catch {
    /* chemin laissé tel quel */
  }
  p = p.normalize("NFC").toLowerCase().replace(/\/{2,}/g, "/");
  if (!p.startsWith("/")) p = "/" + p;
  if (p.length > 1) p = p.replace(/\/+$/, "") || "/";
  return p;
}

/** Variante d'un chemin de produit vu depuis une collection : /collections/x/products/y → /products/y. */
export function productAlias(key: string): string | null {
  const m = /^\/collections\/[^/]+(\/products\/[^/]+)$/.exec(key);
  return m ? m[1] : null;
}

export interface ResourceRow {
  site_id: string;
  id: string;
  gid: string;
  type: ShopifyResourceType;
  path: string;
  path_key: string;
  title: string;
  seo_title: string | null;
  seo_description: string | null;
  images: number;
  images_without_alt: number;
  seq: number;
}

export type ResourceInput = Omit<ResourceRow, "site_id" | "id" | "path_key" | "seq">;

export function replaceResources(db: DB, siteId: string, items: ResourceInput[], at: string): void {
  tx(db, () => {
    db.prepare("DELETE FROM shopify_resources WHERE site_id = ?").run(siteId);
    const ins = db.prepare(
      `INSERT OR REPLACE INTO shopify_resources (site_id, id, gid, type, path, path_key, title, seo_title, seo_description, images, images_without_alt, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    items.forEach((r, i) => ins.run(siteId, resourceIdOf(r.gid), r.gid, r.type, r.path, pathKey(r.path), r.title, r.seo_title, r.seo_description, r.images, r.images_without_alt, i));
    db.prepare("INSERT INTO shopify_sync (site_id, synced_at) VALUES (?, ?) ON CONFLICT(site_id) DO UPDATE SET synced_at = excluded.synced_at").run(siteId, at);
  });
}

/** Met à jour un élément après une lecture en direct (détail, écriture). Sans effet s'il n'a pas été lu par `sync`. */
export function updateResource(db: DB, siteId: string, r: ResourceInput): void {
  db.prepare(
    `UPDATE shopify_resources SET path = ?, path_key = ?, title = ?, seo_title = ?, seo_description = ?, images = ?, images_without_alt = ?
     WHERE site_id = ? AND id = ?`,
  ).run(r.path, pathKey(r.path), r.title, r.seo_title, r.seo_description, r.images, r.images_without_alt, siteId, resourceIdOf(r.gid));
}

export function syncedAt(db: DB, siteId: string): string | null {
  const r = db.prepare("SELECT synced_at FROM shopify_sync WHERE site_id = ?").get(siteId) as Row | undefined;
  return r ? (r.synced_at as string) : null;
}

export function resourceRows(db: DB, siteId: string): ResourceRow[] {
  return db.prepare("SELECT * FROM shopify_resources WHERE site_id = ? ORDER BY seq").all(siteId) as unknown as ResourceRow[];
}

export function getResource(db: DB, siteId: string, id: string): ResourceRow | null {
  return (db.prepare("SELECT * FROM shopify_resources WHERE site_id = ? AND id = ?").get(siteId, id) as unknown as ResourceRow) ?? null;
}

/** Index chemin → élément de la boutique, pour relier les pages analysées et les preuves. */
export function resourceIndex(db: DB, siteId: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of db.prepare("SELECT id, path_key FROM shopify_resources WHERE site_id = ? ORDER BY seq").all(siteId) as Array<{ id: string; path_key: string }>) {
    if (!map.has(r.path_key)) map.set(r.path_key, r.id);
  }
  return map;
}

/** Élément de la boutique d'un chemin de page (avec la variante produit vu depuis une collection). */
export function resourceIdForPath(index: Map<string, string>, path: string): string | null {
  const key = pathKey(path);
  const direct = index.get(key);
  if (direct) return direct;
  const alias = productAlias(key);
  return alias ? (index.get(alias) ?? null) : null;
}

// ───────── Historique (journal avant écriture)

export type ChangeStatus = "pending" | "applied" | "failed";

export interface ChangeRow {
  id: string;
  site_host: string;
  resource_id: string;
  resource_gid: string;
  resource_type: ShopifyResourceType;
  resource_title: string;
  path: string;
  field: ShopifyField;
  image_id: string | null;
  image_gid: string | null;
  image_url: string | null;
  locale: string | null;
  /** Valeur exacte lue dans Shopify juste avant l'écriture. */
  before_value: string | null;
  /** Valeur envoyée à Shopify. */
  requested_value: string | null;
  /** Valeur relue après l'écriture ; la valeur envoyée si la relecture a échoué (after_verified = 0). */
  after_value: string | null;
  after_verified: number;
  /** « pending » : enregistrée avant l'appel à Shopify, issue pas encore connue. */
  status: ChangeStatus;
  applied_at: string;
  kind: "edit" | "restore";
  restores_change_id: string | null;
  restored_by_change_id: string | null;
  /** Lot de corrections de cette écriture ; NULL pour une modification isolée. Figé dès l'insertion. */
  batch_id: string | null;
  /** Ordre d'insertion (rowid), pour départager deux écritures de la même milliseconde. */
  rid?: number;
}

export type PendingInput = Omit<ChangeRow, "id" | "restored_by_change_id" | "rid" | "status" | "after_value" | "after_verified" | "batch_id"> & { batch_id?: string | null };

/** Enregistre l'écriture AVANT l'appel à Shopify (statut « pending »). */
export function insertPending(db: DB, c: PendingInput): ChangeRow {
  const id = newId("chg");
  db.prepare(
    `INSERT INTO shopify_changes (id, site_host, resource_id, resource_gid, resource_type, resource_title, path, field, image_id, image_gid, image_url, locale,
      before_value, requested_value, after_value, after_verified, status, applied_at, kind, restores_change_id, restored_by_change_id, batch_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 'pending', ?, ?, ?, NULL, ?)`,
  ).run(
    id, c.site_host, c.resource_id, c.resource_gid, c.resource_type, c.resource_title, c.path, c.field, c.image_id, c.image_gid,
    c.image_url, c.locale, c.before_value, c.requested_value, c.applied_at, c.kind, c.restores_change_id, c.batch_id ?? null,
  );
  return getChange(db, id)!;
}

/** Shopify a accepté : valeur relue (ou envoyée, non vérifiée) ; une annulation relie la modification annulée. */
export function markApplied(db: DB, id: string, after: string | null, verified: boolean, at: string): ChangeRow {
  tx(db, () => {
    db.prepare("UPDATE shopify_changes SET status = 'applied', after_value = ?, after_verified = ?, applied_at = ? WHERE id = ? AND status = 'pending'").run(after, verified ? 1 : 0, at, id);
    const row = getChange(db, id);
    if (row?.status === "applied" && row.restores_change_id) {
      db.prepare("UPDATE shopify_changes SET restored_by_change_id = ? WHERE id = ? AND restored_by_change_id IS NULL AND status = 'applied'").run(id, row.restores_change_id);
    }
  });
  return getChange(db, id)!;
}

/** Shopify a refusé, ou la relecture prouve que rien n'a été écrit : la ligne sort de l'historique (jamais supprimée). */
export function markFailed(db: DB, id: string): void {
  db.prepare("UPDATE shopify_changes SET status = 'failed' WHERE id = ? AND status = 'pending'").run(id);
}

export function getChange(db: DB, id: string): ChangeRow | null {
  return (db.prepare("SELECT rowid AS rid, * FROM shopify_changes WHERE id = ?").get(id) as unknown as ChangeRow) ?? null;
}

/** Historique visible : modifications appliquées et en attente ; les échecs n'y figurent pas. */
export function changesFor(db: DB, siteHost: string, resourceId?: string): ChangeRow[] {
  const sql = resourceId
    ? "SELECT rowid AS rid, * FROM shopify_changes WHERE site_host = ? AND resource_id = ? AND status <> 'failed' ORDER BY rowid DESC"
    : "SELECT rowid AS rid, * FROM shopify_changes WHERE site_host = ? AND status <> 'failed' ORDER BY rowid DESC";
  return (resourceId ? db.prepare(sql).all(siteHost, resourceId) : db.prepare(sql).all(siteHost)) as unknown as ChangeRow[];
}

export function pendingFor(db: DB, siteHost: string, resourceId: string): ChangeRow[] {
  return db.prepare("SELECT rowid AS rid, * FROM shopify_changes WHERE site_host = ? AND resource_id = ? AND status = 'pending' ORDER BY rowid").all(siteHost, resourceId) as unknown as ChangeRow[];
}

export function changeCounts(db: DB, siteHost: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of db.prepare("SELECT resource_id, COUNT(*) AS n FROM shopify_changes WHERE site_host = ? AND status <> 'failed' GROUP BY resource_id").all(siteHost) as Array<{ resource_id: string; n: number }>) {
    map.set(r.resource_id, r.n);
  }
  return map;
}

const fieldKey = (c: Pick<ChangeRow, "resource_id" | "field" | "image_id" | "locale">) => `${c.resource_id}|${c.field}|${c.image_id ?? ""}|${c.locale ?? ""}`;

/** Dernière modification visible de chaque champ (élément, champ, image, langue) d'un site. */
export function latestByField(db: DB, siteHost: string, resourceId?: string): Map<string, string> {
  const latest = new Map<string, string>();
  for (const c of changesFor(db, siteHost, resourceId)) {
    const k = fieldKey(c);
    if (!latest.has(k)) latest.set(k, c.id); // trié du plus récent au plus ancien
  }
  return latest;
}

/**
 * Forme de l'API. Une ligne « pending » (issue inconnue, ex. arrêt brutal pendant l'écriture) est montrée
 * avec la valeur envoyée et afterVerified false ; l'annuler reste sûr : l'annulation relit d'abord Shopify
 * et n'écrit que si la valeur actuelle est bien celle-là.
 */
export function toChange(c: ChangeRow, latest: Map<string, string>): ShopifyChange {
  return {
    id: c.id,
    resourceId: c.resource_id,
    resourceType: c.resource_type,
    resourceTitle: c.resource_title,
    path: c.path,
    field: c.field,
    image: c.image_id && c.image_url ? { id: c.image_id, url: c.image_url } : null,
    locale: c.locale,
    before: c.before_value,
    after: c.status === "applied" ? c.after_value : c.requested_value,
    afterVerified: c.status === "applied" && c.after_verified === 1,
    appliedAt: c.applied_at,
    kind: c.kind,
    restoresChangeId: c.restores_change_id,
    restoredByChangeId: c.restored_by_change_id,
    batchId: c.batch_id ?? null,
    restorable: latest.get(fieldKey(c)) === c.id && c.restored_by_change_id === null,
  };
}
