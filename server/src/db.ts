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
  return db;
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
  OR NEW.kind IS NOT OLD.kind OR NEW.restores_change_id IS NOT OLD.restores_change_id
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
    if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
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
