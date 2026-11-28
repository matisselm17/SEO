/**
 * Boutiques du mode intégré (table `shops`) : enregistrement à la première requête identifiée, et magasin chiffré
 * du couple de jetons de chaque boutique (docs/format-echange.md, « Jetons d'accès (mode intégré) »).
 *
 * Les jetons sont chiffrés par `crypto/secretbox.ts`, avec en donnée authentifiée le domaine de la boutique et le nom
 * du champ : une valeur copiée d'une ligne ou d'une colonne à une autre ne se déchiffre pas. Aucune valeur (claire ou
 * chiffrée) ni domaine n'est journalisé.
 */
import { open, seal } from "../crypto/secretbox.ts";
import type { DB } from "../db.ts";
import type { TokenPair, TokenStore } from "./auth.ts";

interface ShopRow {
  domain: string;
  access_token: string | null;
  access_expires_at: number | null;
  refresh_token: string | null;
  refresh_expires_at: number | null;
  scopes: string | null;
}

const aad = (domain: string, field: "access_token" | "refresh_token") => `${domain}\n${field}`;

/** Enregistre la boutique si elle ne l'est pas ; sinon met à jour `last_seen_at`. */
export function touchShop(db: DB, domain: string, at = new Date().toISOString()): void {
  db.prepare("INSERT INTO shops (domain, installed_at, last_seen_at) VALUES (?, ?, ?) ON CONFLICT(domain) DO UPDATE SET last_seen_at = excluded.last_seen_at").run(domain, at, at);
}

/**
 * Désinstallation confirmée (`app/uninstalled`) : boutique marquée désinstallée, jetons effacés. Une boutique déjà
 * marquée garde sa date (une requête identifiée arrivée depuis continue de compter). Sans effet sur une boutique
 * inconnue. Renvoie true si la boutique est connue.
 */
export function markUninstalled(db: DB, domain: string, at = new Date().toISOString()): boolean {
  const res = db
    .prepare("UPDATE shops SET uninstalled_at = COALESCE(uninstalled_at, ?), access_token = NULL, access_expires_at = NULL, refresh_token = NULL, refresh_expires_at = NULL WHERE domain = ?")
    .run(at, domain);
  return Number(res.changes) === 1;
}

/**
 * Throttle de `last_seen_at` : une mise à jour par minute au plus, sauf pour une boutique marquée désinstallée ou qui a
 * une demande d'effacement en attente.
 */
export const SEEN_THROTTLE_MS = 60_000;

/**
 * Enregistre une requête identifiée de la boutique (`touchShop`), au plus une fois par minute. Une boutique marquée
 * désinstallée, ou qui a une demande d'effacement en attente, est toujours mise à jour : une requête arrivée juste
 * après la demande doit compter (elle interdit l'effacement sans preuve au bout de 25 jours). `seen` : dernier
 * enregistrement par boutique.
 */
export function recordShopSeen(db: DB, domain: string, seen: Map<string, number>, nowMs = Date.now()): void {
  if (nowMs - (seen.get(domain) ?? 0) < SEEN_THROTTLE_MS) {
    const r = db
      .prepare("SELECT s.uninstalled_at, EXISTS (SELECT 1 FROM shop_redactions r WHERE r.state = 'pending' AND r.shop_domain = s.domain) AS waiting FROM shops s WHERE s.domain = ?")
      .get(domain) as { uninstalled_at: string | null; waiting: number } | undefined;
    if (!r || (r.uninstalled_at === null && !Number(r.waiting))) return;
  }
  touchShop(db, domain, new Date(nowMs).toISOString());
  seen.set(domain, nowMs);
}

/** État de la boutique qui décide d'un effacement (sans les jetons eux-mêmes). */
export interface ShopLifecycle {
  uninstalledAt: string | null;
  lastSeenAt: string | null;
  tokensSavedAt: string | null;
  /** Empreinte des jetons enregistrés (chiffrés) ; null sans jeton. */
  tokenMark: string | null;
}

export function shopLifecycle(db: DB, domain: string): ShopLifecycle | null {
  const r = db.prepare("SELECT uninstalled_at, last_seen_at, tokens_saved_at, access_token, refresh_token FROM shops WHERE domain = ?").get(domain) as
    | { uninstalled_at: string | null; last_seen_at: string | null; tokens_saved_at: string | null; access_token: string | null; refresh_token: string | null }
    | undefined;
  if (!r) return null;
  return {
    uninstalledAt: r.uninstalled_at,
    lastSeenAt: r.last_seen_at,
    tokensSavedAt: r.tokens_saved_at,
    tokenMark: !r.access_token && !r.refresh_token ? null : `${r.access_token ?? ""}|${r.refresh_token ?? ""}`,
  };
}

/** La boutique a-t-elle encore des jetons enregistrés (chiffrés) ? Renvoie aussi l'empreinte pour détecter un échange. */
export function storedTokenMark(db: DB, domain: string): string | null {
  const r = db.prepare("SELECT access_token, refresh_token FROM shops WHERE domain = ?").get(domain) as { access_token: string | null; refresh_token: string | null } | undefined;
  if (!r || (!r.access_token && !r.refresh_token)) return null;
  return `${r.access_token ?? ""}|${r.refresh_token ?? ""}`;
}

/** Magasin de production : couple de jetons chiffré dans la ligne de la boutique. */
export function dbTokenStore(db: DB, domain: string, key: Buffer): TokenStore {
  return {
    load(): TokenPair | null {
      const r = db.prepare("SELECT domain, access_token, access_expires_at, refresh_token, refresh_expires_at, scopes FROM shops WHERE domain = ?").get(domain) as unknown as ShopRow | undefined;
      if (!r || !r.access_token || !r.refresh_token) return null;
      const access = open(key, r.access_token, aad(domain, "access_token"));
      const refresh = open(key, r.refresh_token, aad(domain, "refresh_token"));
      if (access === null || refresh === null) {
        // Clé changée, valeur altérée ou copiée d'une autre ligne : comme une absence de jeton. Ni valeur ni domaine.
        console.warn("[shopify] Jetons enregistrés illisibles pour une boutique : ignorés, un nouvel échange les remplacera.");
        return null;
      }
      const accessAt = Number(r.access_expires_at);
      const refreshAt = Number(r.refresh_expires_at);
      if (!Number.isFinite(accessAt) || !Number.isFinite(refreshAt)) return null;
      let scopes: string[] = [];
      try {
        const parsed = JSON.parse(r.scopes ?? "[]");
        if (Array.isArray(parsed)) scopes = parsed.filter((s): s is string => typeof s === "string");
      } catch {
        scopes = [];
      }
      return { access: { value: access, expiresAt: accessAt, scopes }, refresh: { value: refresh, expiresAt: refreshAt } };
    },
    save(pair: TokenPair): void {
      const at = new Date().toISOString();
      // Un couple neuf (échange ou renouvellement réussi) prouve que l'application est installée : réinstallation.
      db.prepare(
        `INSERT INTO shops (domain, access_token, access_expires_at, refresh_token, refresh_expires_at, scopes, installed_at, last_seen_at, tokens_saved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(domain) DO UPDATE SET access_token = excluded.access_token, access_expires_at = excluded.access_expires_at,
           refresh_token = excluded.refresh_token, refresh_expires_at = excluded.refresh_expires_at, scopes = excluded.scopes,
           tokens_saved_at = excluded.tokens_saved_at, uninstalled_at = NULL`,
      ).run(
        domain,
        seal(key, pair.access.value, aad(domain, "access_token")),
        Math.trunc(pair.access.expiresAt),
        seal(key, pair.refresh.value, aad(domain, "refresh_token")),
        Math.trunc(pair.refresh.expiresAt),
        JSON.stringify(pair.access.scopes),
        at,
        at,
        at,
      );
    },
    clear(): void {
      db.prepare("UPDATE shops SET access_token = NULL, access_expires_at = NULL, refresh_token = NULL, refresh_expires_at = NULL WHERE domain = ?").run(domain);
    },
  };
}
