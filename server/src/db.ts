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
];

function migrate(db: DB): void {
  for (const [table, column, type] of ADDED_COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
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
