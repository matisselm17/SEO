/**
 * Reprise après un redémarrage (docs/format-echange.md, « Exploitation (lot D) », « Reprise après un redémarrage »).
 *
 * La file des vérifications vit en mémoire : un redémarrage la perd. Au démarrage, les corrections appliquées depuis
 * moins de 24 heures, dans la langue principale, dernières de leur champ et sans aucune relecture enregistrée sont
 * remises dans la file, avec la cadence ordinaire (première relecture différée, une page à la fois). Rien n'est écrit
 * ni dans la base ni dans la boutique : seule la relecture de la page publique est programmée.
 */
import type { Store } from "../store.ts";
import type { ShopifyRegistry } from "./registry.ts";
import { isLatestOfField, latestByField, type ChangeRow } from "./repo.ts";

const isUninstalled = (store: Store, domain: string) =>
  !!(store.db.prepare("SELECT uninstalled_at FROM shops WHERE domain = ?").get(domain) as { uninstalled_at: string | null } | undefined)?.uninstalled_at;

/** Ancienneté maximale d'une correction reprise. */
export const RESUME_WINDOW_MS = 24 * 3_600_000;

/** Corrections à reprendre (voir l'en-tête), de la plus ancienne à la plus récente. */
export function changesToResume(store: Store, now: number): ChangeRow[] {
  const since = new Date(now - RESUME_WINDOW_MS).toISOString();
  const rows = store.db
    .prepare(
      `SELECT rowid AS rid, * FROM shopify_changes c
       WHERE c.status = 'applied' AND c.kind = 'edit' AND c.restored_by_change_id IS NULL AND c.locale IS NULL
         AND c.applied_at >= ?
         AND NOT EXISTS (SELECT 1 FROM shopify_verifications v WHERE v.change_id = c.id)
       ORDER BY c.rowid`,
    )
    .all(since) as unknown as ChangeRow[];
  const latest = new Map<string, Map<string, string>>();
  return rows.filter((c) => {
    const k = `${c.site_host}|${c.resource_id}`;
    let l = latest.get(k);
    if (!l) latest.set(k, (l = latestByField(store.db, c.site_host, c.resource_id)));
    return isLatestOfField(c, l);
  });
}

/**
 * Remet en file les vérifications à reprendre. Un site absent, ou sans services Shopify configurés, est passé.
 * Ne lève jamais ; renvoie le nombre de corrections remises en file.
 */
export function resumeVerifications(store: Store, registry: ShopifyRegistry, now: number = Date.now()): number {
  let n = 0;
  let rows: ChangeRow[];
  try {
    rows = changesToResume(store, now);
  } catch {
    console.warn("[vérification] Reprise des vérifications impossible au démarrage.");
    return 0;
  }
  for (const c of rows) {
    try {
      const site = store.siteByHost(c.site_host);
      if (!site) continue;
      // Mode intégré : boutique désinstallée, rien à relire pour elle.
      if (site.shop_domain && isUninstalled(store, site.shop_domain)) continue;
      const bundle = registry.forSite(site);
      if (!bundle || !bundle.shopify.configured) continue;
      if (bundle.shopify.verifier.schedule(site.id, c.id, 1)) n++;
    } catch {
      /* une correction illisible n'empêche pas les autres */
    }
  }
  return n;
}
