/**
 * Sauvegardes de la base (docs/format-echange.md, « Exploitation (lot D) », « Sauvegardes de la base »).
 *
 * - Copie cohérente par `VACUUM INTO` (la base reste utilisable pendant la copie), écrite sous un nom provisoire
 *   puis renommée : une copie inachevée n'est jamais comptée ni gardée.
 * - Dossier `<DATA_DIR>/backups/` (mode 700), fichiers en mode 600 créés vides avec ces droits avant la copie.
 *   Aucun chemin ne vient d'une requête : le dossier dérive de la configuration, le nom de l'horloge.
 * - Rotation : seules les `keep` copies les plus récentes restent.
 * - Un échec est journalisé (sans chemin ni contenu) et n'arrête jamais le serveur. Rien si la base est en mémoire.
 */
import { chmodSync, closeSync, mkdirSync, openSync, readdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import type { DB } from "./db.ts";

export const BACKUP_DIR = "backups";
const NAME_RE = /^chat-seo-(\d{8}T\d{6}Z)(?:-(\d+))?\.sqlite$/;
const PARTIAL_RE = /^chat-seo-.*\.sqlite\.partial$/;

/** Horodatage du nom : 20261128T101500Z. */
function stamp(t: number): string {
  return new Date(t).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** Date (ms) d'une copie d'après son nom ; null si le nom n'est pas celui d'une copie. */
function stampTime(name: string): number | null {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const s = m[1];
  const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** Copies présentes, de la plus récente à la plus ancienne. */
export function listBackups(dataDir: string): Array<{ name: string; at: number }> {
  let names: string[];
  try {
    names = readdirSync(path.join(dataDir, BACKUP_DIR));
  } catch {
    return [];
  }
  return names
    .map((name) => ({ name, at: stampTime(name), n: Number(NAME_RE.exec(name)?.[2] ?? 0) }))
    .filter((x): x is { name: string; at: number; n: number } => x.at !== null)
    .sort((a, b) => b.at - a.at || b.n - a.n)
    .map(({ name, at }) => ({ name, at }));
}

/**
 * Écrit une copie cohérente de la base dans `<dataDir>/backups/`, puis ne garde que les `keep` plus récentes.
 * Renvoie le nom du fichier écrit. Lève en cas d'échec (l'appelant journalise).
 */
export function backupDatabase(db: DB, dataDir: string, keep: number, now: number = Date.now()): string {
  const dir = path.join(dataDir, BACKUP_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const base = `chat-seo-${stamp(now)}`;
  let name = `${base}.sqlite`;
  const existing = new Set(readdirSync(dir));
  for (let i = 1; existing.has(name) || existing.has(`${name}.partial`); i++) name = `${base}-${i}.sqlite`;
  const final = path.join(dir, name);
  const partial = `${final}.partial`;
  // Fichier vide créé avec les droits du seul propriétaire : la copie n'est jamais lisible par d'autres, même un instant.
  closeSync(openSync(partial, "wx", 0o600));
  try {
    db.prepare("VACUUM INTO ?").run(partial);
    chmodSync(partial, 0o600);
    renameSync(partial, final);
  } catch (err) {
    rmSync(partial, { force: true });
    throw err;
  }
  rotate(dataDir, keep, now);
  return name;
}

/**
 * Ne garde que les `keep` copies les plus récentes ; retire aussi les copies inachevées laissées par un arrêt. Une
 * copie datée dans le futur (horloge reculée) est ignorée : ni comptée, ni retirée.
 */
export function rotate(dataDir: string, keep: number, now: number = Date.now()): void {
  const dir = path.join(dataDir, BACKUP_DIR);
  for (const b of listBackups(dataDir).filter((x) => x.at <= now).slice(Math.max(1, keep))) rmSync(path.join(dir, b.name), { force: true });
  try {
    for (const name of readdirSync(dir)) if (PARTIAL_RE.test(name)) rmSync(path.join(dir, name), { force: true });
  } catch {
    /* dossier absent : rien à retirer */
  }
}

export interface BackupScheduleOptions {
  db: DB;
  /** DATA_DIR ; `:memory:` : aucune sauvegarde. */
  dataDir: string;
  /** DB_BACKUP_HOURS ; 0 : jamais. */
  hours: number;
  /** DB_BACKUP_KEEP. */
  keep: number;
  now?: () => number;
  /** Fréquence des contrôles (une copie est faite quand la plus récente a `hours` heures ou plus). */
  checkEveryMs?: number;
  setInterval?: (fn: () => void, ms: number) => { unref?: () => void };
  clearInterval?: (t: unknown) => void;
  log?: (message: string) => void;
}

/**
 * Sauvegardes périodiques. Un contrôle tout de suite, puis toutes les `checkEveryMs` : une copie est écrite si la
 * plus récente date d'au moins `hours` heures (ou s'il n'y en a aucune), de sorte que des redémarrages fréquents ne
 * l'empêchent pas et ne la multiplient pas. Minuterie qui ne retient pas le processus ; la fonction rendue l'arrête.
 */
export function startBackups(o: BackupScheduleOptions): { stop: () => void; tick: () => boolean } {
  const noop = { stop: () => {}, tick: () => false };
  if (!o.hours || o.hours <= 0 || o.dataDir === ":memory:") return noop;
  const now = o.now ?? Date.now;
  const log = o.log ?? ((m: string) => console.warn(m));
  const intervalMs = o.hours * 3_600_000;
  let stopped = false;
  const tick = (): boolean => {
    if (stopped) return false;
    try {
      const t = now();
      // Une copie datée dans le futur est ignorée : elle ne bloque pas les suivantes.
      const last = listBackups(o.dataDir).find((b) => b.at <= t);
      if (last && t - last.at < intervalMs) return false;
      backupDatabase(o.db, o.dataDir, o.keep, t);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      log(`[sauvegarde] La sauvegarde de la base a échoué${code ? ` (${String(code).slice(0, 20)})` : ""} ; nouvel essai au prochain contrôle.`);
      return false;
    }
  };
  tick();
  const set = o.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clear = o.clearInterval ?? ((t: unknown) => clearInterval(t as NodeJS.Timeout));
  const timer = set(tick, o.checkEveryMs ?? Math.min(intervalMs, 15 * 60_000));
  timer.unref?.();
  return {
    stop: () => {
      stopped = true;
      clear(timer);
    },
    tick,
  };
}
