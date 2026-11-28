/**
 * Stockage SQLite (module intégré node:sqlite) dans DATA_DIR.
 * Une seule connexion synchrone : les requêtes sont courtes, l'analyse n'y passe que pour écrire une page.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";

export type DB = DatabaseSync;

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("base64url").replace(/[-_]/g, "x").toLowerCase()}`;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 3000;
-- Les lignes supprimées sont écrasées par des zéros (effacement d'une boutique : rien ne reste dans les pages libres).
PRAGMA secure_delete = ON;

CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  host TEXT NOT NULL UNIQUE,
  name TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audits (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  state TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  max_pages INTEGER NOT NULL,
  pages_done INTEGER NOT NULL DEFAULT 0,
  pages_failed INTEGER NOT NULL DEFAULT 0,
  pages_queued INTEGER NOT NULL DEFAULT 0,
  current_url TEXT,
  error_json TEXT
);
CREATE INDEX IF NOT EXISTS audits_site ON audits(site_id, seq);

CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY,
  audit_id TEXT NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  url TEXT NOT NULL,
  url_key TEXT NOT NULL,
  path TEXT NOT NULL,
  title TEXT,
  http_status INTEGER NOT NULL,
  score INTEGER NOT NULL,
  issues INTEGER NOT NULL,
  words INTEGER NOT NULL,
  analyzed_at TEXT NOT NULL,
  checks_json TEXT NOT NULL,
  facts_json TEXT NOT NULL,
  categories_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pages_audit ON pages(audit_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS pages_audit_key ON pages(audit_id, url_key);

CREATE TABLE IF NOT EXISTS page_failures (
  audit_id TEXT NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  reason TEXT NOT NULL,
  http_status INTEGER
);

CREATE TABLE IF NOT EXISTS search_console (
  site_id TEXT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  imported_at TEXT NOT NULL,
  data_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sources_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_site ON chat_messages(site_id, seq);

CREATE TABLE IF NOT EXISTS competitors (
  site_id TEXT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  checked_at TEXT NOT NULL,
  data_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_catalogue (
  audit_id TEXT PRIMARY KEY REFERENCES audits(id) ON DELETE CASCADE,
  read_at TEXT NOT NULL,
  data_json TEXT NOT NULL
);

-- Dernière lecture de la boutique Shopify, par site. Les éléments sont remplacés à chaque lecture.
CREATE TABLE IF NOT EXISTS shopify_sync (
  site_id TEXT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  synced_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS shopify_resources (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  gid TEXT NOT NULL,
  type TEXT NOT NULL,
  path TEXT NOT NULL,
  path_key TEXT NOT NULL,
  title TEXT NOT NULL,
  seo_title TEXT,
  seo_description TEXT,
  images INTEGER NOT NULL,
  images_without_alt INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (site_id, id)
);
CREATE INDEX IF NOT EXISTS shopify_resources_path ON shopify_resources(site_id, path_key);

-- Historique des écritures dans la boutique. Sans lien vers sites : il survit à la suppression du site.
-- Journal avant écriture : une ligne est créée « pending » AVANT l'appel à Shopify, puis passe une seule fois à
-- « applied » ou « failed ». Aucune ligne n'est supprimée ; une ligne appliquée ne change plus, sauf
-- restored_by_change_id, posé une seule fois. Les déclencheurs l'imposent.
CREATE TABLE IF NOT EXISTS shopify_changes (
  id TEXT PRIMARY KEY,
  site_host TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  resource_gid TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_title TEXT NOT NULL,
  path TEXT NOT NULL,
  field TEXT NOT NULL,
  image_id TEXT,
  image_gid TEXT,
  image_url TEXT,
  locale TEXT,
  before_value TEXT,
  after_value TEXT,
  applied_at TEXT NOT NULL,
  kind TEXT NOT NULL,
  restores_change_id TEXT,
  restored_by_change_id TEXT,
  status TEXT NOT NULL DEFAULT 'applied',
  requested_value TEXT,
  after_verified INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS shopify_changes_site ON shopify_changes(site_host);
CREATE INDEX IF NOT EXISTS shopify_changes_resource ON shopify_changes(site_host, resource_id);
CREATE TRIGGER IF NOT EXISTS shopify_changes_no_delete BEFORE DELETE ON shopify_changes
BEGIN
  SELECT RAISE(ABORT, 'historique Shopify : suppression interdite');
END;
-- Le déclencheur des mises à jour est (re)créé par migrate(), après l'ajout des colonnes du journal.

-- Relectures de la page publique après une correction (vérification). Ajout seul : une ligne par relecture,
-- jamais modifiée ni supprimée (déclencheurs). Sans lien vers sites, comme l'historique qu'elle complète.
CREATE TABLE IF NOT EXISTS shopify_verifications (
  id TEXT PRIMARY KEY,
  change_id TEXT NOT NULL,
  site_host TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  outcome TEXT NOT NULL,
  reason TEXT NOT NULL,
  message TEXT NOT NULL,
  url TEXT,
  displayed INTEGER,
  rendered TEXT,
  criterion_id TEXT,
  criterion_before TEXT,
  criterion_after TEXT,
  criterion_points INTEGER,
  criterion_max INTEGER,
  criterion_message TEXT,
  page_score_before INTEGER,
  page_score_after INTEGER
);
CREATE INDEX IF NOT EXISTS shopify_verifications_change ON shopify_verifications(change_id);
CREATE INDEX IF NOT EXISTS shopify_verifications_site ON shopify_verifications(site_host);
CREATE TRIGGER IF NOT EXISTS shopify_verifications_no_update BEFORE UPDATE ON shopify_verifications
BEGIN
  SELECT RAISE(ABORT, 'vérifications Shopify : modification interdite');
END;
CREATE TRIGGER IF NOT EXISTS shopify_verifications_no_delete BEFORE DELETE ON shopify_verifications
BEGIN
  SELECT RAISE(ABORT, 'vérifications Shopify : suppression interdite');
END;

-- Lots de corrections. Sans lien vers sites (comme l'historique) : un lot n'est jamais supprimé.
CREATE TABLE IF NOT EXISTS shopify_batches (
  id TEXT PRIMARY KEY,
  site_host TEXT NOT NULL,
  title TEXT NOT NULL,
  origin TEXT NOT NULL,
  created_at TEXT NOT NULL,
  state TEXT NOT NULL,
  auto_applied INTEGER NOT NULL DEFAULT 0,
  error_json TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS shopify_batches_site ON shopify_batches(site_host);
CREATE TABLE IF NOT EXISTS shopify_batch_items (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES shopify_batches(id),
  seq INTEGER NOT NULL,
  resource_id TEXT NOT NULL,
  resource_gid TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_title TEXT NOT NULL,
  path TEXT NOT NULL,
  field TEXT NOT NULL,
  image_id TEXT,
  image_url TEXT,
  locale TEXT,
  before_value TEXT,
  proposed TEXT NOT NULL,
  note TEXT,
  selected INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'pending',
  change_id TEXT,
  error TEXT,
  auto_applied INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS shopify_batch_items_batch ON shopify_batch_items(batch_id, seq);
CREATE TRIGGER IF NOT EXISTS shopify_batches_no_delete BEFORE DELETE ON shopify_batches
BEGIN
  SELECT RAISE(ABORT, 'lots de corrections : suppression interdite');
END;
CREATE TRIGGER IF NOT EXISTS shopify_batch_items_no_delete BEFORE DELETE ON shopify_batch_items
BEGIN
  SELECT RAISE(ABORT, 'lots de corrections : suppression interdite');
END;

-- Règle d'automatisation par site (valeurs par défaut du format tant qu'aucune n'est enregistrée).
CREATE TABLE IF NOT EXISTS automation_policies (
  site_id TEXT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  policy_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Compteurs du jour (jour UTC), par hôte : supprimer puis recréer un site ne remet pas les compteurs à zéro.
CREATE TABLE IF NOT EXISTS automation_usage (
  site_host TEXT NOT NULL,
  day TEXT NOT NULL,
  auto_changes INTEGER NOT NULL DEFAULT 0,
  ai_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_host, day)
);

-- Dernière lecture de Google Analytics, par site (remplacée à chaque lecture). Les pages d'arrivée sont gardées
-- par chemin : le rapprochement avec les pages analysées est refait à l'affichage.
CREATE TABLE IF NOT EXISTS analytics (
  site_id TEXT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  synced_at TEXT NOT NULL,
  data_json TEXT NOT NULL
);

-- Dernières mesures de vitesse (PageSpeed Insights), par site et par chemin (clé de rapprochement).
CREATE TABLE IF NOT EXISTS pagespeed_pages (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  path_key TEXT NOT NULL,
  url TEXT NOT NULL,
  path TEXT NOT NULL,
  page_type TEXT,
  mobile_json TEXT,
  desktop_json TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (site_id, path_key)
);
-- Dernière demande de mesure : erreur qui l'a arrêtée (clé, quota) et échecs page par page (JSON).
CREATE TABLE IF NOT EXISTS pagespeed_status (
  site_id TEXT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  last_error_json TEXT,
  failures_json TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function openDb(dataDir: string | ":memory:"): DB {
  let file = ":memory:";
  if (dataDir !== ":memory:") {
    mkdirSync(dataDir, { recursive: true });
    file = path.join(dataDir, "chat-seo.sqlite");
  }
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  migrate(db);
  runMigrations(db);
  return db;
}

/**
 * Migrations numérotées (docs/format-echange.md, « Base »). Chacune s'exécute une seule fois, dans une transaction,
 * et laisse sa trace dans `schema_migrations`. Ne jamais modifier une migration publiée : en ajouter une nouvelle.
 * Elles s'appliquent après le schéma de départ (CREATE IF NOT EXISTS) et l'ajout de colonnes historique (`migrate`).
 */
export const MIGRATIONS: ReadonlyArray<{ version: number; name: string; sql: string }> = [
  {
    version: 1,
    name: "boutiques",
    sql: `
CREATE TABLE shops (
  domain TEXT PRIMARY KEY,
  access_token TEXT,
  access_expires_at INTEGER,
  refresh_token TEXT,
  refresh_expires_at INTEGER,
  scopes TEXT,
  installed_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  uninstalled_at TEXT
);`,
  },
  {
    version: 2,
    name: "site_de_la_boutique",
    sql: `
ALTER TABLE sites ADD COLUMN shop_domain TEXT;
CREATE UNIQUE INDEX sites_shop_domain ON sites(shop_domain) WHERE shop_domain IS NOT NULL;`,
  },
  {
    version: 3,
    name: "appels_shopify_et_effacement",
    sql: `
-- Appels signés reçus de Shopify (doublons) : identifiant, sujet, date. Ni le corps, ni la boutique.
CREATE TABLE webhook_events (
  webhook_id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE INDEX webhook_events_received ON webhook_events(received_at);

-- Demandes d'effacement d'une boutique (shop/redact), exécutées après la réponse et reprises jusqu'à leur clôture.
-- Le domaine n'est gardé que tant que la demande est en attente : effacé à la clôture.
CREATE TABLE shop_redactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_domain TEXT,
  received_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'closed')),
  outcome TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  closed_at TEXT
);
CREATE INDEX shop_redactions_pending ON shop_redactions(state, shop_domain);

-- Autorisation d'effacer l'historique d'UNE adresse de site : une ligne au plus, posée et retirée dans la même
-- transaction par purgeShop (shopify/redact.ts), seule fonction qui l'écrit. Vide en dehors de cette transaction.
CREATE TABLE history_delete_grant (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  site_host TEXT NOT NULL
);

-- Les quatre tables d'historique refusent toujours la suppression, sauf pour l'adresse portée par l'autorisation.
DROP TRIGGER IF EXISTS shopify_changes_no_delete;
CREATE TRIGGER shopify_changes_no_delete BEFORE DELETE ON shopify_changes
WHEN NOT EXISTS (SELECT 1 FROM history_delete_grant g WHERE g.id = 1 AND g.site_host = OLD.site_host)
BEGIN
  SELECT RAISE(ABORT, 'historique Shopify : suppression interdite');
END;
DROP TRIGGER IF EXISTS shopify_verifications_no_delete;
CREATE TRIGGER shopify_verifications_no_delete BEFORE DELETE ON shopify_verifications
WHEN NOT EXISTS (SELECT 1 FROM history_delete_grant g WHERE g.id = 1 AND g.site_host = OLD.site_host)
BEGIN
  SELECT RAISE(ABORT, 'vérifications Shopify : suppression interdite');
END;
DROP TRIGGER IF EXISTS shopify_batches_no_delete;
CREATE TRIGGER shopify_batches_no_delete BEFORE DELETE ON shopify_batches
WHEN NOT EXISTS (SELECT 1 FROM history_delete_grant g WHERE g.id = 1 AND g.site_host = OLD.site_host)
BEGIN
  SELECT RAISE(ABORT, 'lots de corrections : suppression interdite');
END;
DROP TRIGGER IF EXISTS shopify_batch_items_no_delete;
CREATE TRIGGER shopify_batch_items_no_delete BEFORE DELETE ON shopify_batch_items
WHEN NOT EXISTS (SELECT 1 FROM history_delete_grant g JOIN shopify_batches b ON b.site_host = g.site_host WHERE g.id = 1 AND b.id = OLD.batch_id)
BEGIN
  SELECT RAISE(ABORT, 'lots de corrections : suppression interdite');
END;`,
  },
  {
    version: 4,
    name: "avis_rejoues_et_preuves_d_effacement",
    sql: `
-- Date du dernier enregistrement de jetons : un avis de désinstallation daté d'avant est écarté.
ALTER TABLE shops ADD COLUMN tokens_saved_at TEXT;
-- Dernier avertissement « demande en attente au-delà de 30 jours » (au plus un par jour).
ALTER TABLE shop_redactions ADD COLUMN last_warned_at TEXT;
-- Empreintes (SHA-256) des corps d'avis de désinstallation traités, gardées sans limite de durée : un corps déjà
-- vu n'est jamais retraité, quel que soit son identifiant. Ni le corps, ni la boutique en clair.
CREATE TABLE IF NOT EXISTS uninstall_digests (
  digest TEXT PRIMARY KEY,
  received_at TEXT NOT NULL
);`,
  },
  {
    version: 5,
    name: "avis_de_desinstallation_verifies",
    sql: `
-- Un avis de désinstallation n'est plus jamais cru sur parole : Shopify est interrogé. Les empreintes des corps ne
-- servent plus (une seconde désinstallation réelle au corps identique doit être traitée).
DROP TABLE IF EXISTS uninstall_digests;
-- Avis de désinstallation en attente de confirmation par Shopify (une ligne par boutique), reposés au démarrage puis
-- toutes les heures, sans aucun effet entre-temps. Supprimés quand Shopify a répondu clairement.
CREATE TABLE IF NOT EXISTS uninstall_checks (
  shop_domain TEXT PRIMARY KEY,
  received_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT
);`,
  },
];

export function runMigrations(db: DB, migrations: ReadonlyArray<{ version: number; name: string; sql: string }> = MIGRATIONS): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  const done = new Set((db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map((r) => Number(r.version)));
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (done.has(m.version)) continue;
    tx(db, () => {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(m.version, m.name, new Date().toISOString());
    });
  }
}

/**
 * Colonnes ajoutées depuis la première version. Ajout seulement, sans perte : les anciennes lignes gardent
 * NULL, que le code lit comme une valeur par défaut (type de page déduit du chemin, couverture « par les liens »).
 */
const ADDED_COLUMNS: Array<[table: string, column: string, type: string]> = [
  ["pages", "page_type", "TEXT"],
  ["page_failures", "page_type", "TEXT"],
  ["audits", "coverage_json", "TEXT"],
  ["shopify_changes", "status", "TEXT NOT NULL DEFAULT 'applied'"],
  ["shopify_changes", "requested_value", "TEXT"],
  ["shopify_changes", "after_verified", "INTEGER NOT NULL DEFAULT 1"],
  ["shopify_changes", "batch_id", "TEXT"],
  ["chat_messages", "batch_ids_json", "TEXT"],
  ["audits", "paused_until", "TEXT"],
  ["search_console", "source", "TEXT NOT NULL DEFAULT 'file'"],
  ["shopify_batch_items", "auto_applied", "INTEGER NOT NULL DEFAULT 0"],
  ["pagespeed_status", "failures_json", "TEXT"],
];

/**
 * Mises à jour permises sur shopify_changes :
 * - une ligne « pending » passe une fois à « applied » ou « failed » (avec after_value, after_verified, applied_at) ;
 * - restored_by_change_id passe une fois de NULL à une valeur, sur une ligne « applied ».
 * Tout le reste (avant, valeur demandée, élément, champ…) est figé dès l'insertion.
 */
const CHANGES_UPDATE_TRIGGER = `
DROP TRIGGER IF EXISTS shopify_changes_no_update;
CREATE TRIGGER shopify_changes_no_update BEFORE UPDATE ON shopify_changes
WHEN NEW.id IS NOT OLD.id OR NEW.site_host IS NOT OLD.site_host OR NEW.resource_id IS NOT OLD.resource_id
  OR NEW.resource_gid IS NOT OLD.resource_gid OR NEW.resource_type IS NOT OLD.resource_type
  OR NEW.resource_title IS NOT OLD.resource_title OR NEW.path IS NOT OLD.path OR NEW.field IS NOT OLD.field
  OR NEW.image_id IS NOT OLD.image_id OR NEW.image_gid IS NOT OLD.image_gid OR NEW.image_url IS NOT OLD.image_url
  OR NEW.locale IS NOT OLD.locale OR NEW.before_value IS NOT OLD.before_value OR NEW.requested_value IS NOT OLD.requested_value
  OR NEW.kind IS NOT OLD.kind OR NEW.restores_change_id IS NOT OLD.restores_change_id OR NEW.batch_id IS NOT OLD.batch_id
  OR (OLD.status <> 'pending' AND (NEW.status IS NOT OLD.status OR NEW.after_value IS NOT OLD.after_value
      OR NEW.after_verified IS NOT OLD.after_verified OR NEW.applied_at IS NOT OLD.applied_at))
  OR (OLD.status = 'pending' AND NEW.status NOT IN ('pending', 'applied', 'failed'))
  OR (NEW.restored_by_change_id IS NOT OLD.restored_by_change_id AND (OLD.restored_by_change_id IS NOT NULL OR NEW.status <> 'applied'))
BEGIN
  SELECT RAISE(ABORT, 'historique Shopify : modification interdite');
END;
`;

function migrate(db: DB): void {
  for (const [table, column, type] of ADDED_COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    if (table === "shopify_batch_items" && column === "auto_applied") {
      // Lots antérieurs : seul le lot portait la marque. Au mieux, ses lignes écrites la reçoivent.
      db.exec("UPDATE shopify_batch_items SET auto_applied = 1 WHERE state IN ('applied', 'restored') AND batch_id IN (SELECT id FROM shopify_batches WHERE auto_applied = 1)");
    }
  }
  db.exec(CHANGES_UPDATE_TRIGGER);
}

/** Exécute une fonction dans une transaction. */
export function tx<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export type Row = Record<string, string | number | null>;
