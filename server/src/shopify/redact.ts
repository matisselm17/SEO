/**
 * Effacement des données d'une boutique (docs/format-echange.md, « Appels de Shopify : désinstallation et vie
 * privée (mode intégré) », `shop/redact`).
 *
 * `purgeShop` est la SEULE fonction du code qui écrit dans `history_delete_grant` : elle y pose l'autorisation
 * d'effacer l'historique d'une seule adresse de site, supprime, puis la retire, le tout dans une transaction. Hors de
 * cette transaction, la table est vide et les déclencheurs `*_no_delete` refusent toute suppression d'historique.
 *
 * `PURGE_PLAN` décide, pour CHAQUE table de la base, ce que l'effacement en fait. Un test échoue si une table
 * n'y figure pas : une table ajoutée plus tard doit y recevoir une décision.
 */
import { tx, type DB } from "../db.ts";

export type PurgeDecision =
  /** Rangée par `site_id` (cascade depuis `sites`, supprimée aussi explicitement). */
  | "site_id"
  /** Rangée par analyse (`audit_id` d'une analyse du site). */
  | "audit_id"
  /** Historique rangé par adresse du site (`site_host`), protégé par les déclencheurs. */
  | "site_host"
  /** Lignes de lots : par le lot (`batch_id`) d'un lot de l'adresse du site. */
  | "batch_of_site_host"
  /** Le site lui-même (`sites.shop_domain`). */
  | "site"
  /** La ligne de la boutique (`shops.domain`). */
  | "shop"
  /** Lignes rangées par domaine de la boutique (colonne `shop_domain`). */
  | "shop_domain"
  /** Sans donnée propre à une boutique (ou file des demandes, dont le domaine est effacé à la clôture). */
  | "not_concerned";

export const PURGE_PLAN: Readonly<Record<string, PurgeDecision>> = {
  sites: "site",
  audits: "site_id",
  pages: "site_id",
  search_console: "site_id",
  chat_messages: "site_id",
  competitors: "site_id",
  shopify_sync: "site_id",
  shopify_resources: "site_id",
  automation_policies: "site_id",
  analytics: "site_id",
  pagespeed_pages: "site_id",
  pagespeed_status: "site_id",
  page_failures: "audit_id",
  audit_catalogue: "audit_id",
  shopify_changes: "site_host",
  shopify_verifications: "site_host",
  shopify_batches: "site_host",
  automation_usage: "site_host",
  shopify_batch_items: "batch_of_site_host",
  shops: "shop",
  // File des demandes d'effacement : le domaine n'y est gardé que tant que la demande est en attente.
  shop_redactions: "not_concerned",
  // Identifiant, sujet et date des appels reçus : aucune boutique.
  webhook_events: "not_concerned",
  // Avis de désinstallation en attente de confirmation : effacés avec la boutique.
  uninstall_checks: "shop_domain",
  // Autorisation d'effacement : vide hors de la transaction de purgeShop.
  history_delete_grant: "not_concerned",
  settings: "not_concerned",
  schema_migrations: "not_concerned",
};

const tablesOf = (plan: Readonly<Record<string, PurgeDecision>>, d: PurgeDecision) => Object.keys(plan).filter((t) => plan[t] === d);

export interface PurgeResult {
  /** Site effacé (null : la boutique n'avait pas de site). */
  siteId: string | null;
  /** Analyses effacées (caches du Store à oublier). */
  auditIds: string[];
  /** La ligne `shops` existait. */
  shopRow: boolean;
}

/**
 * Efface, dans une seule transaction, le site de la boutique et tout ce qui en dépend, l'historique rangé par son
 * adresse, et la ligne `shops`. Rien d'une autre boutique n'est touché. `beforeDelete`, appelé dans la transaction
 * avant toute suppression, peut lever pour tout annuler (réinstallation constatée au dernier moment).
 */
export function purgeShop(db: DB, shopDomain: string, beforeDelete?: () => void): PurgeResult {
  if (typeof shopDomain !== "string" || !shopDomain) throw new Error("Effacement : boutique absente.");
  return tx(db, () => {
    beforeDelete?.();
    const site = db.prepare("SELECT id, host FROM sites WHERE shop_domain = ?").get(shopDomain) as { id: string; host: string } | undefined;
    const shopRow = !!db.prepare("SELECT 1 AS x FROM shops WHERE domain = ?").get(shopDomain);
    let auditIds: string[] = [];
    if (site) {
      const host = site.host;
      // Une adresse de site appartient à un seul site (index unique) : l'historique de cette adresse est celui de la boutique.
      db.prepare("INSERT INTO history_delete_grant (id, site_host) VALUES (1, ?)").run(host);
      for (const t of tablesOf(PURGE_PLAN, "batch_of_site_host")) {
        db.prepare(`DELETE FROM "${t}" WHERE batch_id IN (SELECT id FROM shopify_batches WHERE site_host = ?)`).run(host);
      }
      // Les lots en dernier : les lignes de lots s'y rapportent.
      const byHost = tablesOf(PURGE_PLAN, "site_host").sort((a, b) => Number(a === "shopify_batches") - Number(b === "shopify_batches"));
      for (const t of byHost) db.prepare(`DELETE FROM "${t}" WHERE site_host = ?`).run(host);
      db.prepare("DELETE FROM history_delete_grant WHERE id = 1").run();

      auditIds = (db.prepare("SELECT id FROM audits WHERE site_id = ?").all(site.id) as Array<{ id: string }>).map((r) => r.id);
      for (const t of tablesOf(PURGE_PLAN, "audit_id")) {
        db.prepare(`DELETE FROM "${t}" WHERE audit_id IN (SELECT id FROM audits WHERE site_id = ?)`).run(site.id);
      }
      // Les analyses après leurs pages (clé étrangère), le site en dernier.
      const bySite = tablesOf(PURGE_PLAN, "site_id").sort((a, b) => Number(a === "audits") - Number(b === "audits"));
      for (const t of bySite) db.prepare(`DELETE FROM "${t}" WHERE site_id = ?`).run(site.id);
      db.prepare("DELETE FROM sites WHERE id = ?").run(site.id);
    }
    for (const t of tablesOf(PURGE_PLAN, "shop_domain")) db.prepare(`DELETE FROM "${t}" WHERE shop_domain = ?`).run(shopDomain);
    db.prepare("DELETE FROM shops WHERE domain = ?").run(shopDomain);
    return { siteId: site?.id ?? null, auditIds, shopRow };
  });
}
