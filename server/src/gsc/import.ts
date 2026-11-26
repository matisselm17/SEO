/**
 * Lecture de l'export « Performances » de Google Search Console : le .zip complet ou un .csv seul
 * (requêtes, pages ou dates), en français ou en anglais. Le fichier déposé est une donnée non fiable :
 * il est seulement lu, avec des limites de taille.
 */
import { unzipSync } from "fflate";
import type { OrganicPoint, OrganicQuery, OrganicTotals } from "../../../shared/api.ts";
import { HttpError } from "../errors.ts";
import { bareHost } from "../crawl/url.ts";

export interface ImportedPage extends OrganicTotals {
  url: string;
}

/** Données stockées après import (le rapprochement avec les pages analysées se fait à la lecture). */
export interface GscImport {
  period: { start: string; end: string } | null;
  series: OrganicPoint[] | null;
  queries: OrganicQuery[] | null;
  pages: ImportedPage[] | null;
  /** Position moyenne pondérée de la série, quand elle existe (pour les totaux). */
  seriesPosition: number | null;
  files: string[];
}

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_ENTRY_BYTES = 40 * 1024 * 1024;
const MAX_TOTAL_BYTES = 80 * 1024 * 1024;
const MAX_ROWS = 50_000;

export const invalidFile = (
  message = "Ce fichier n'est pas un export Search Console lisible.",
  action = "Dans la Search Console, ouvrez « Performances », cliquez sur « Exporter » puis « Télécharger le fichier CSV », et déposez le .zip obtenu.",
) => new HttpError(422, "invalid_file", message, action);

// ───────── CSV

export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  const counts = { ",": 0, ";": 0, "\t": 0 } as Record<string, number>;
  let inQ = false;
  for (const ch of firstLine) {
    if (ch === '"') inQ = !inQ;
    else if (!inQ && ch in counts) counts[ch]++;
  }
  const delim = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] > 0 ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === "") quoted = true;
    else if (ch === delim) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
      if (rows.length > MAX_ROWS) break;
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    if (row.some((c) => c.trim() !== "")) rows.push(row);
  }
  return rows;
}

type Locale = "fr" | "en";

/** Lit un nombre « 1 234,5 », « 1,234.5 », « 3,01 % » ou « 3.01% ». Les pourcentages sont rendus entre 0 et 1. */
export function parseNumber(raw: string, locale: Locale): number | null {
  let s = (raw ?? "").trim();
  if (!s || s === "-" || s === "—") return null;
  const percent = s.includes("%");
  s = s.replace(/%/g, "").replace(/[\s   ']/g, "");
  if (!s) return null;
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  if (hasComma && hasDot) {
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (hasComma) {
    // Seule une virgule : décimale en français ; en anglais, séparateur de milliers si le motif l'indique.
    if (locale === "en" && /^-?\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, "");
    else s = s.replace(/,/g, ".");
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return percent ? n / 100 : n;
}

export function parseDate(raw: string, locale: Locale): string | null {
  const s = raw.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(s);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    const [day, month] = locale === "en" && a <= 12 ? [b, a] : [a, b];
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${m[3]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  const t = Date.parse(s);
  if (!Number.isNaN(t) && /\d{4}/.test(s)) return new Date(t).toISOString().slice(0, 10);
  return null;
}

type Kind = "queries" | "pages" | "dates" | "other";

const norm = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

function detectKind(header: string[], fileName: string): Kind {
  const first = norm(header[0] ?? "");
  const name = norm(fileName);
  if (/^(top )?quer|requete|^query|consulta|suchanfrage/.test(first)) return "queries";
  if (/^(top )?pages?$|^pages? |^url|plus populaires|^page|seite|pagina/.test(first)) return "pages";
  if (/^date|^datum|^fecha|^jour|^day/.test(first)) return "dates";
  if (/quer|requete/.test(name)) return "queries";
  if (/^pages?\b/.test(name)) return "pages";
  if (/^dates?\b/.test(name)) return "dates";
  return "other";
}

function detectLocale(header: string[], fileName: string): Locale {
  const h = norm(header.join(" ") + " " + fileName);
  return /clics|requete|taux|plus frequentes|plus populaires|appareil|pays/.test(h) ? "fr" : "en";
}

function columns(header: string[]) {
  const find = (re: RegExp) => header.findIndex((h) => re.test(norm(h)));
  return {
    clicks: find(/^(clicks?|clics?|klicks?)/),
    impressions: find(/^impr/),
    ctr: find(/^(ctr|taux de clic|click.?through)/),
    position: find(/^(position|posicion|pos\.)/),
  };
}

interface ParsedFile {
  kind: Kind;
  rows: string[][];
  header: string[];
  locale: Locale;
  name: string;
}

function readTable(name: string, text: string): ParsedFile {
  const rows = parseCsv(text);
  const header = rows[0] ?? [];
  return { kind: detectKind(header, name), rows: rows.slice(1), header, locale: detectLocale(header, name), name };
}

/** Vrai si la ligne a des clics ou des impressions lisibles comme des nombres. */
function hasNumbers(file: ParsedFile, r: string[]): boolean {
  const c = columns(file.header);
  return [c.clicks, c.impressions].some((i) => i >= 0 && parseNumber(r[i] ?? "", file.locale) !== null);
}

function metrics(file: ParsedFile, r: string[]) {
  const c = columns(file.header);
  const get = (i: number) => (i >= 0 ? parseNumber(r[i] ?? "", file.locale) : null);
  const clicks = get(c.clicks) ?? 0;
  const impressions = get(c.impressions) ?? 0;
  let ctr = get(c.ctr);
  // Certains exports écrivent le CTR sans « % » (ex. 3.01) : au-delà de 1, c'est un pourcentage.
  if (ctr !== null && ctr > 1) ctr = ctr / 100;
  if (ctr === null) ctr = impressions ? clicks / impressions : 0;
  const position = get(c.position) ?? 0;
  return { clicks, impressions, ctr: round4(ctr), position: round1(position) };
}

const round1 = (x: number) => Math.round(x * 10) / 10;
const round4 = (x: number) => Math.round(x * 10000) / 10000;

function hasMetrics(file: ParsedFile): boolean {
  const c = columns(file.header);
  return c.clicks >= 0 && c.impressions >= 0;
}

export function buildImport(files: Array<{ name: string; text: string }>, siteHost?: string): GscImport {
  const parsed = files.map((f) => readTable(f.name, f.text)).filter((f) => f.kind !== "other" && hasMetrics(f));
  const byKind = (k: Kind) => parsed.find((f) => f.kind === k);
  const q = byKind("queries");
  const p = byKind("pages");
  const d = byKind("dates");
  if (!q && !p && !d) throw invalidFile();
  if (![q, p, d].some((f) => f && f.rows.some((r) => hasNumbers(f, r)))) {
    throw invalidFile("Ce fichier ne contient aucun chiffre de clics ni d'impressions lisible : ce n'est pas un export « Performances » exploitable.");
  }
  // Les adresses d'un autre site sont écartées ; un export entièrement étranger est refusé.
  let pageRows = p ? p.rows.filter((r) => /^https?:\/\//i.test((r[0] ?? "").trim()) && hasNumbers(p, r)) : null;
  if (p && siteHost) {
    const own = bareHost(siteHost);
    const onSite = (u: string) => {
      try {
        return bareHost(new URL(u.trim()).hostname) === own;
      } catch {
        return false;
      }
    };
    const kept = pageRows!.filter((r) => onSite(r[0]));
    if (pageRows!.length && !kept.length) {
      const other = (() => {
        try {
          return bareHost(new URL(pageRows![0][0].trim()).hostname);
        } catch {
          return null;
        }
      })();
      throw invalidFile(
        `Cet export semble venir d'un autre site${other ? ` (${other})` : ""} : aucune de ses pages n'est sur ${own}.`,
        `Dans la Search Console, choisissez la propriété de ${own}, puis exportez « Performances » à nouveau.`,
      );
    }
    pageRows = kept;
  }

  const queries = q
    ? q.rows
        .filter((r) => (r[0] ?? "").trim() && hasNumbers(q, r))
        .map((r) => ({ query: r[0].trim(), ...metrics(q, r) }))
        .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
    : null;
  const pages = p && pageRows
    ? pageRows
        .map((r) => ({ url: r[0].trim(), ...metrics(p, r) }))
        .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
    : null;
  let series: OrganicPoint[] | null = null;
  let seriesPosition: number | null = null;
  if (d) {
    const points: Array<OrganicPoint & { position: number }> = [];
    for (const r of d.rows) {
      const date = parseDate(r[0] ?? "", d.locale);
      if (!date || !hasNumbers(d, r)) continue;
      const m = metrics(d, r);
      points.push({ date, clicks: m.clicks, impressions: m.impressions, position: m.position });
    }
    points.sort((a, b) => a.date.localeCompare(b.date));
    if (points.length) {
      series = points.map(({ date, clicks, impressions }) => ({ date, clicks, impressions }));
      const imp = points.reduce((a, x) => a + x.impressions, 0);
      seriesPosition = imp ? round1(points.reduce((a, x) => a + x.position * x.impressions, 0) / imp) : null;
    }
  }
  if (!queries?.length && !pages?.length && !series?.length) throw invalidFile("Ce fichier ne contient aucune donnée de performance.");
  return {
    period: series?.length ? { start: series[0].date, end: series[series.length - 1].date } : null,
    series,
    queries,
    pages,
    seriesPosition,
    files: parsed.map((f) => f.name),
  };
}

/** Totaux : série par date si elle existe, sinon somme des requêtes, sinon des pages. */
export function totalsOf(data: GscImport): OrganicTotals {
  if (data.series?.length) {
    const clicks = data.series.reduce((a, x) => a + x.clicks, 0);
    const impressions = data.series.reduce((a, x) => a + x.impressions, 0);
    return { clicks, impressions, ctr: impressions ? round4(clicks / impressions) : 0, position: data.seriesPosition ?? 0 };
  }
  const rows: OrganicTotals[] = data.queries?.length ? data.queries : (data.pages ?? []);
  const clicks = rows.reduce((a, x) => a + x.clicks, 0);
  const impressions = rows.reduce((a, x) => a + x.impressions, 0);
  const position = impressions ? round1(rows.reduce((a, x) => a + x.position * x.impressions, 0) / impressions) : 0;
  return { clicks, impressions, ctr: impressions ? round4(clicks / impressions) : 0, position };
}

function decodeText(bytes: Uint8Array): string {
  // Les exports sont en UTF-8 ; repli en Windows-1252 si le décodage strict échoue.
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/** Point d'entrée : un fichier déposé (.zip ou .csv). */
export function importFile(name: string, bytes: Uint8Array, siteHost?: string): GscImport {
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new HttpError(413, "file_too_large", "Ce fichier dépasse 20 Mo.", "Exportez une période plus courte, ou déposez seulement le .zip de l'onglet « Performances ».");
  }
  const isZip = bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (isZip) {
    let total = 0;
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(bytes, {
        filter: (f) => {
          if (!/\.csv$/i.test(f.name) || f.name.includes("__MACOSX")) return false;
          if (f.originalSize > MAX_ENTRY_BYTES) {
            throw invalidFile(`Le fichier « ${(f.name.split("/").pop() ?? f.name).slice(0, 80)} » de l'archive dépasse 40 Mo une fois décompressé.`);
          }
          total += f.originalSize;
          if (total > MAX_TOTAL_BYTES) throw invalidFile("Cette archive est trop volumineuse une fois décompressée.");
          return true;
        },
      });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw invalidFile("Cette archive .zip est illisible ou endommagée.");
    }
    const files = Object.entries(entries)
      .slice(0, 30)
      .map(([n, b]) => ({ name: n.split("/").pop() ?? n, text: decodeText(b) }));
    if (!files.length) throw invalidFile("Cette archive ne contient aucun fichier CSV.");
    return buildImport(files, siteHost);
  }
  if (!/\.(csv|txt)$/i.test(name) && bytes.includes(0)) throw invalidFile();
  return buildImport([{ name, text: decodeText(bytes) }], siteHost);
}
