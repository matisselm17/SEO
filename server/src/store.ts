/**
 * Accès aux données et construction des réponses au format de shared/api.ts.
 */
import type {
  AnalyticsData,
  ApiError,
  AuditState,
  AuditStatus,
  ChatMessage,
  CompetitorsData,
  OrganicPage,
  OrganicQuery,
  PageCheck,
  PageDetail,
  PageSummary,
  PageType,
  PageVisits,
  SearchConsoleData,
  SiteSummary,
  SpeedMeasure,
} from "../../shared/api.ts";
import { mergeLandingPages, MAX_LANDING_PAGES, type StoredAnalytics } from "./google/analytics.ts";
import { pathKey } from "./shopify/repo.ts";
import { aggregate, type PageRecord, type SiteAggregate } from "./analyse/aggregate.ts";
import type { PageFacts } from "./analyse/grille.ts";
import { cut } from "./analyse/grille.ts";
import { newId, type DB, type Row } from "./db.ts";
import { totalsOf, type GscImport } from "./gsc/import.ts";
import { displayPath, urlKey } from "./crawl/url.ts";
import { classifyPath, PAGE_TYPES } from "./crawl/inventory.ts";
import type { CatalogueProduct } from "./crawl/shopify.ts";
import { legacyState, type CoverageState, type TypeStats } from "./coverage.ts";

export interface SiteRow {
  id: string;
  url: string;
  host: string;
  name: string | null;
  created_at: string;
  /** Mode intégré : domaine `xxx.myshopify.com` de la boutique propriétaire ; null en mode local (jamais renvoyé). */
  shop_domain?: string | null;
}

export interface AuditRow {
  id: string;
  site_id: string;
  seq: number;
  state: AuditState;
  started_at: string;
  finished_at: string | null;
  max_pages: number;
  pages_done: number;
  pages_failed: number;
  pages_queued: number;
  current_url: string | null;
  error_json: string | null;
  /** Pause du parcours après un refus passager du site : date de reprise prévue ; NULL hors pause. */
  paused_until?: string | null;
  /** État de l'inventaire écrit par le parcours ; NULL pour une analyse antérieure à l'inventaire. */
  coverage_json?: string | null;
}

export interface PageRow {
  id: string;
  audit_id: string;
  site_id: string;
  seq: number;
  url: string;
  url_key: string;
  path: string;
  title: string | null;
  http_status: number;
  score: number;
  issues: number;
  words: number;
  analyzed_at: string;
  checks_json: string;
  facts_json: string;
  categories_json: string;
  /** NULL pour une page d'une analyse antérieure aux types : le type est alors déduit du chemin. */
  page_type: PageType | null;
}

const isPageType = (v: unknown): v is PageType => typeof v === "string" && (PAGE_TYPES as string[]).includes(v);
/** Type d'une page enregistrée ; pour les anciennes lignes (sans type), déduit de son chemin. */
export function pageTypeOf(r: { page_type: string | null; path: string }): PageType {
  return isPageType(r.page_type) ? r.page_type : classifyPath(r.path.split("?")[0]);
}

const now = () => new Date().toISOString();

/**
 * Mesure de vitesse enregistrée ; null si absente ou illisible. Une ligne corrompue est ignorée et journalisée
 * sans son contenu : elle ne fait pas échouer le reste de l'état.
 */
export function parseSpeedMeasure(v: unknown, siteId: string): SpeedMeasure | null {
  if (typeof v !== "string" || !v) return null;
  try {
    const m = JSON.parse(v) as SpeedMeasure;
    if (m && typeof m === "object" && typeof m.score === "number" && m.lab && typeof m.lab === "object") return m;
  } catch {
    /* journalisé ci-dessous */
  }
  console.warn(`[vitesse] Mesure enregistrée illisible, ignorée (site ${siteId}).`);
  return null;
}

/** Note et gravités des problèmes d'une analyse (résumé gardé pour la frise de l'évolution). */
export interface AuditSummary {
  score: number | null;
  severities: Array<"critical" | "warning" | "info">;
}

/** Analyses dont l'agrégat et les enregistrements des pages restent en mémoire (les plus récemment lues). */
export const AUDIT_CACHE_MAX = 16;
/** Résumés d'analyses gardés (quelques octets chacun). */
export const SUMMARY_CACHE_MAX = 512;

/** Lecture d'un cache borné : une entrée lue redevient la plus récente ; une version périmée est oubliée. */
function cacheGet<T extends { version: number }>(cache: Map<string, T>, key: string, version: number): T | null {
  const v = cache.get(key);
  if (!v) return null;
  cache.delete(key);
  if (v.version !== version) return null;
  cache.set(key, v);
  return v;
}

/** Écriture dans un cache borné : au-delà de `max` entrées, les moins récemment lues sont oubliées. */
function cacheSet<T>(cache: Map<string, T>, key: string, value: T, max: number): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > max) cache.delete(cache.keys().next().value as string);
}

export class Store {
  /**
   * Caches par analyse, invalidés à chaque page ajoutée et bornés (`AUDIT_CACHE_MAX`, les moins récemment lus sont
   * oubliés) : le détail des pages des analyses anciennes ne reste pas en mémoire.
   */
  private aggCache = new Map<string, { version: number; agg: SiteAggregate }>();
  private recordCache = new Map<string, { version: number; records: PageRecord[] }>();
  /** Note et compteurs d'une analyse (frise de l'évolution), sans les enregistrements des pages. */
  private summaryCache = new Map<string, { version: number; summary: AuditSummary }>();
  private versions = new Map<string, number>();

  constructor(public db: DB) {}

  // ───────── Sites

  insertSite(url: string, host: string, name: string | null, shopDomain: string | null = null): SiteRow {
    const row: SiteRow = { id: newId("site"), url, host, name, created_at: now(), shop_domain: shopDomain };
    this.db.prepare("INSERT INTO sites (id, url, host, name, created_at, shop_domain) VALUES (?, ?, ?, ?, ?, ?)").run(row.id, row.url, row.host, row.name, row.created_at, shopDomain);
    return row;
  }
  /** Mode intégré : site de la boutique (au plus un, index unique). */
  siteByShop(shopDomain: string): SiteRow | null {
    return (this.db.prepare("SELECT * FROM sites WHERE shop_domain = ?").get(shopDomain) as unknown as SiteRow) ?? null;
  }
  /** Rattache à une boutique un site qui n'en a pas encore. Renvoie false si le site a déjà une boutique (ou n'existe plus). */
  attachSiteToShop(siteId: string, shopDomain: string): boolean {
    const res = this.db.prepare("UPDATE sites SET shop_domain = ? WHERE id = ? AND shop_domain IS NULL").run(shopDomain, siteId);
    return Number(res.changes) === 1;
  }
  getSite(id: string): SiteRow | null {
    return (this.db.prepare("SELECT * FROM sites WHERE id = ?").get(id) as unknown as SiteRow) ?? null;
  }
  siteByHost(host: string): SiteRow | null {
    return (this.db.prepare("SELECT * FROM sites WHERE host = ?").get(host) as unknown as SiteRow) ?? null;
  }
  listSites(): SiteRow[] {
    return this.db.prepare("SELECT * FROM sites ORDER BY created_at DESC, rowid DESC").all() as unknown as SiteRow[];
  }
  setSiteName(id: string, name: string): void {
    this.db.prepare("UPDATE sites SET name = ? WHERE id = ?").run(name, id);
  }
  deleteSite(id: string): void {
    const audits = this.db.prepare("SELECT id FROM audits WHERE site_id = ?").all(id) as Array<{ id: string }>;
    for (const a of audits) this.invalidate(a.id, true);
    this.db.prepare("DELETE FROM sites WHERE id = ?").run(id);
  }

  // ───────── Analyses

  insertAudit(siteId: string, maxPages: number): AuditRow {
    const seq = ((this.db.prepare("SELECT MAX(seq) AS m FROM audits WHERE site_id = ?").get(siteId) as Row).m as number | null) ?? 0;
    const row: AuditRow = {
      id: newId("aud"),
      site_id: siteId,
      seq: seq + 1,
      state: "queued",
      started_at: now(),
      finished_at: null,
      max_pages: maxPages,
      pages_done: 0,
      pages_failed: 0,
      pages_queued: 1,
      current_url: null,
      error_json: null,
    };
    this.db
      .prepare(
        "INSERT INTO audits (id, site_id, seq, state, started_at, max_pages, pages_done, pages_failed, pages_queued) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 1)",
      )
      .run(row.id, siteId, row.seq, row.state, row.started_at, maxPages);
    return row;
  }
  getAudit(id: string): AuditRow | null {
    return (this.db.prepare("SELECT * FROM audits WHERE id = ?").get(id) as unknown as AuditRow) ?? null;
  }
  updateAudit(id: string, patch: Partial<Pick<AuditRow, "state" | "finished_at" | "pages_done" | "pages_failed" | "pages_queued" | "current_url" | "error_json" | "paused_until">>): void {
    const keys = Object.keys(patch) as Array<keyof typeof patch>;
    if (!keys.length) return;
    const sql = `UPDATE audits SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`;
    this.db.prepare(sql).run(...keys.map((k) => (patch[k] ?? null) as string | number | null), id);
  }
  latestAudit(siteId: string): AuditRow | null {
    return (this.db.prepare("SELECT * FROM audits WHERE site_id = ? ORDER BY seq DESC LIMIT 1").get(siteId) as unknown as AuditRow) ?? null;
  }
  /** Dernière analyse qui a au moins une page notée. */
  latestAuditWithPages(siteId: string): AuditRow | null {
    return (
      (this.db.prepare("SELECT * FROM audits WHERE site_id = ? AND pages_done > 0 ORDER BY seq DESC LIMIT 1").get(siteId) as unknown as AuditRow) ?? null
    );
  }
  /**
   * Analyse dont les résultats sont affichés (SiteSummary.results) : la dernière terminée ;
   * à défaut, la plus récente qui a au moins une page notée. null sans page notée.
   */
  resultsAudit(siteId: string): AuditRow | null {
    const done = this.db
      .prepare("SELECT * FROM audits WHERE site_id = ? AND state = 'done' AND pages_done > 0 ORDER BY seq DESC LIMIT 1")
      .get(siteId) as unknown as AuditRow | undefined;
    return done ?? this.latestAuditWithPages(siteId);
  }
  previousDoneAudit(siteId: string, beforeSeq: number): AuditRow | null {
    return (
      (this.db
        .prepare("SELECT * FROM audits WHERE site_id = ? AND seq < ? AND state = 'done' AND pages_done > 0 ORDER BY seq DESC LIMIT 1")
        .get(siteId, beforeSeq) as unknown as AuditRow) ?? null
    );
  }
  /** Analyses terminées avec au moins une page notée, de la plus ancienne à la plus récente. */
  doneAudits(siteId: string): AuditRow[] {
    return this.db.prepare("SELECT * FROM audits WHERE site_id = ? AND state = 'done' AND pages_done > 0 ORDER BY seq").all(siteId) as unknown as AuditRow[];
  }
  runningAudits(): AuditRow[] {
    return this.db.prepare("SELECT * FROM audits WHERE state IN ('queued', 'running')").all() as unknown as AuditRow[];
  }
  /** Note moyenne d'une analyse (pages déjà notées), null sans page. */
  auditScore(auditId: string): number | null {
    const r = this.db.prepare("SELECT AVG(score) AS s, COUNT(*) AS n FROM pages WHERE audit_id = ?").get(auditId) as Row;
    return (r.n as number) > 0 ? Math.round(r.s as number) : null;
  }

  // ───────── Pages

  insertPage(p: Omit<PageRow, "id" | "seq">): PageRow {
    const seq = ((this.db.prepare("SELECT COUNT(*) AS n FROM pages WHERE audit_id = ?").get(p.audit_id) as Row).n as number) + 1;
    const row: PageRow = { ...p, id: newId("pg"), seq };
    this.db
      .prepare(
        `INSERT INTO pages (id, audit_id, site_id, seq, url, url_key, path, title, http_status, score, issues, words, analyzed_at, checks_json, facts_json, categories_json, page_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.audit_id, row.site_id, row.seq, row.url, row.url_key, row.path, row.title, row.http_status, row.score, row.issues, row.words, row.analyzed_at, row.checks_json, row.facts_json, row.categories_json, row.page_type);
    this.invalidate(p.audit_id);
    return row;
  }
  hasPageKey(auditId: string, key: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM pages WHERE audit_id = ? AND url_key = ?").get(auditId, key);
  }
  pageRows(auditId: string): PageRow[] {
    return this.db.prepare("SELECT * FROM pages WHERE audit_id = ? ORDER BY seq").all(auditId) as unknown as PageRow[];
  }
  getPage(id: string): PageRow | null {
    return (this.db.prepare("SELECT * FROM pages WHERE id = ?").get(id) as unknown as PageRow) ?? null;
  }
  countSites(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM sites").get() as Row).n as number;
  }
  deleteChatMessage(id: string): void {
    this.db.prepare("DELETE FROM chat_messages WHERE id = ?").run(id);
  }
  insertFailure(auditId: string, url: string, reason: string, status: number | null, pageType: PageType | null = null): void {
    this.db.prepare("INSERT INTO page_failures (audit_id, url, reason, http_status, page_type) VALUES (?, ?, ?, ?, ?)").run(auditId, url, reason, status, pageType);
  }
  failures(auditId: string): Array<{ url: string; reason: string; http_status: number | null }> {
    return this.db.prepare("SELECT url, reason, http_status FROM page_failures WHERE audit_id = ? ORDER BY rowid LIMIT 500").all(auditId) as never;
  }

  // ───────── Couverture et catalogue

  setCoverageState(auditId: string, state: CoverageState): void {
    this.db.prepare("UPDATE audits SET coverage_json = ? WHERE id = ?").run(JSON.stringify(state), auditId);
  }
  /** État de l'inventaire d'une analyse ; valeurs par défaut pour une analyse antérieure à l'inventaire. */
  coverageState(audit: AuditRow): CoverageState {
    const raw = (this.db.prepare("SELECT coverage_json FROM audits WHERE id = ?").get(audit.id) as Row | undefined)?.coverage_json;
    if (typeof raw === "string" && raw) {
      try {
        return JSON.parse(raw) as CoverageState;
      } catch {
        /* état illisible : valeurs par défaut */
      }
    }
    const home = this.db.prepare("SELECT facts_json FROM pages WHERE audit_id = ? AND path = '/' LIMIT 1").get(audit.id) as Row | undefined;
    const lang = home ? ((JSON.parse(home.facts_json as string) as PageFacts).lang ?? "") : "";
    const primary = /^([a-z]{2,3})\b/i.exec(lang)?.[1]?.toLowerCase() ?? null;
    return legacyState(primary);
  }
  /** Pages notées (nombre, somme des notes) et pages en échec, par type. */
  typeStats(auditId: string): TypeStats {
    const analyzed = new Map<PageType, { count: number; scoreSum: number }>();
    for (const r of this.db.prepare("SELECT page_type, path, score FROM pages WHERE audit_id = ?").all(auditId) as Array<{ page_type: string | null; path: string; score: number }>) {
      const t = pageTypeOf(r);
      const cur = analyzed.get(t) ?? { count: 0, scoreSum: 0 };
      cur.count++;
      cur.scoreSum += r.score;
      analyzed.set(t, cur);
    }
    const failed = new Map<PageType, number>();
    for (const r of this.db.prepare("SELECT page_type, url FROM page_failures WHERE audit_id = ?").all(auditId) as Array<{ page_type: string | null; url: string }>) {
      const t = pageTypeOf({ page_type: r.page_type, path: displayPath(r.url) });
      failed.set(t, (failed.get(t) ?? 0) + 1);
    }
    return { analyzed, failed };
  }
  setCatalogue(auditId: string, products: CatalogueProduct[]): void {
    this.db
      .prepare("INSERT INTO audit_catalogue (audit_id, read_at, data_json) VALUES (?, ?, ?) ON CONFLICT(audit_id) DO UPDATE SET read_at = excluded.read_at, data_json = excluded.data_json")
      .run(auditId, now(), JSON.stringify(products));
    this.invalidate(auditId);
  }
  /** Produits lus dans le catalogue sans que leur page soit ouverte ; null si le catalogue n'a pas été lu. */
  catalogue(auditId: string): CatalogueProduct[] | null {
    const r = this.db.prepare("SELECT data_json FROM audit_catalogue WHERE audit_id = ?").get(auditId) as Row | undefined;
    return r ? (JSON.parse(r.data_json as string) as CatalogueProduct[]) : null;
  }

  /** Après un effacement fait directement en base (shopify/redact.ts) : oublie les caches de ces analyses. */
  forgetAudits(auditIds: string[]): void {
    for (const id of auditIds) this.invalidate(id, true);
  }

  private invalidate(auditId: string, drop = false): void {
    this.versions.set(auditId, (this.versions.get(auditId) ?? 0) + 1);
    if (drop) {
      this.aggCache.delete(auditId);
      this.recordCache.delete(auditId);
      this.summaryCache.delete(auditId);
    }
  }

  /** Taille des caches par analyse (tests). */
  cacheSizes(): { aggregates: number; records: number; summaries: number } {
    return { aggregates: this.aggCache.size, records: this.recordCache.size, summaries: this.summaryCache.size };
  }

  /**
   * Note et compteurs de problèmes d'une analyse, calculés comme `aggregate` mais sans garder les enregistrements des
   * pages ni l'agrégat complet (seul ce résumé, de quelques octets, est gardé).
   */
  auditSummary(auditId: string, siteName: string): AuditSummary {
    const version = this.versions.get(auditId) ?? 0;
    const hit = cacheGet(this.summaryCache, auditId, version);
    if (hit) return hit.summary;
    const agg = cacheGet(this.aggCache, auditId, version)?.agg ?? aggregate(cacheGet(this.recordCache, auditId, version)?.records ?? this.pageRows(auditId).map(toRecord), siteName, this.catalogue(auditId));
    const summary: AuditSummary = { score: agg.score, severities: agg.issues.map((i) => i.severity) };
    cacheSet(this.summaryCache, auditId, { version, summary }, SUMMARY_CACHE_MAX);
    return summary;
  }

  records(auditId: string): PageRecord[] {
    const version = this.versions.get(auditId) ?? 0;
    const cached = cacheGet(this.recordCache, auditId, version);
    if (cached) return cached.records;
    const records = this.pageRows(auditId).map(toRecord);
    cacheSet(this.recordCache, auditId, { version, records }, AUDIT_CACHE_MAX);
    return records;
  }

  aggregate(auditId: string, siteName: string): SiteAggregate {
    const version = this.versions.get(auditId) ?? 0;
    const cached = cacheGet(this.aggCache, auditId, version);
    if (cached) return cached.agg;
    const agg = aggregate(this.records(auditId), siteName, this.catalogue(auditId));
    cacheSet(this.aggCache, auditId, { version, agg }, AUDIT_CACHE_MAX);
    return agg;
  }

  // ───────── Search Console

  getGsc(siteId: string): { importedAt: string; source: "file" | "google"; data: GscImport } | null {
    const r = this.db.prepare("SELECT imported_at, data_json, source FROM search_console WHERE site_id = ?").get(siteId) as Row | undefined;
    if (!r) return null;
    return { importedAt: r.imported_at as string, source: r.source === "google" ? "google" : "file", data: JSON.parse(r.data_json as string) };
  }
  /** Enregistre un import (fichier déposé ou lecture directe chez Google) ; remplace le précédent. */
  setGsc(siteId: string, data: GscImport, source: "file" | "google" = "file"): string {
    const at = now();
    this.db
      .prepare(
        "INSERT INTO search_console (site_id, imported_at, data_json, source) VALUES (?, ?, ?, ?) ON CONFLICT(site_id) DO UPDATE SET imported_at = excluded.imported_at, data_json = excluded.data_json, source = excluded.source",
      )
      .run(siteId, at, JSON.stringify(data), source);
    this.gscIndexCache.delete(siteId);
    this.gscQueriesCache.delete(siteId);
    return at;
  }
  private gscQueriesCache = new Map<string, { importedAt: string; index: Map<string, OrganicQuery[]> | null }>();
  /**
   * Requêtes Search Console d'une page (par clé d'adresse) : seulement quand l'import relie les requêtes aux pages
   * (lecture directe chez Google). null sinon ; [] si l'import les relie mais qu'aucune ne mène à cette page.
   */
  gscQueriesFor(siteId: string, key: string): OrganicQuery[] | null {
    const at = this.getGscMeta(siteId);
    if (!at) return null;
    let cached = this.gscQueriesCache.get(siteId);
    if (!cached || cached.importedAt !== at) {
      const data = this.getGsc(siteId)!.data;
      let index: Map<string, OrganicQuery[]> | null = null;
      if (data.pageQueries) {
        index = new Map();
        for (const [k, list] of Object.entries(data.pageQueries)) index.set(k, list);
      }
      cached = { importedAt: at, index };
      this.gscQueriesCache.set(siteId, cached);
    }
    if (!cached.index) return null;
    return cached.index.get(key) ?? [];
  }
  deleteGsc(siteId: string): void {
    this.db.prepare("DELETE FROM search_console WHERE site_id = ?").run(siteId);
    this.gscIndexCache.delete(siteId);
    this.gscQueriesCache.delete(siteId);
  }
  private gscIndexCache = new Map<string, { importedAt: string; index: Map<string, { clicks: number; impressions: number; position: number }> }>();
  /** Données Search Console par clé d'adresse, pour rapprocher les pages analysées. */
  gscIndex(siteId: string): Map<string, { clicks: number; impressions: number; position: number }> | null {
    const gsc = this.getGscMeta(siteId);
    if (!gsc) return null;
    const cached = this.gscIndexCache.get(siteId);
    if (cached && cached.importedAt === gsc) return cached.index;
    const data = this.getGsc(siteId)!.data;
    const index = new Map<string, { clicks: number; impressions: number; position: number }>();
    for (const p of data.pages ?? []) {
      const key = urlKey(p.url);
      if (!key) continue;
      const prev = index.get(key);
      if (prev) {
        // Variantes d'une même page (http/https, www) : on additionne.
        const imp = prev.impressions + p.impressions;
        index.set(key, {
          clicks: prev.clicks + p.clicks,
          impressions: imp,
          position: imp ? Math.round(((prev.position * prev.impressions + p.position * p.impressions) / imp) * 10) / 10 : p.position,
        });
      } else index.set(key, { clicks: p.clicks, impressions: p.impressions, position: p.position });
    }
    this.gscIndexCache.set(siteId, { importedAt: gsc, index });
    return index;
  }
  getGscMeta(siteId: string): string | null {
    const r = this.db.prepare("SELECT imported_at FROM search_console WHERE site_id = ?").get(siteId) as Row | undefined;
    return r ? (r.imported_at as string) : null;
  }

  // ───────── Google Analytics

  getAnalytics(siteId: string): StoredAnalytics | null {
    const r = this.db.prepare("SELECT synced_at, data_json FROM analytics WHERE site_id = ?").get(siteId) as Row | undefined;
    if (!r) return null;
    let a: Partial<Omit<StoredAnalytics, "syncedAt">>;
    try {
      a = JSON.parse(r.data_json as string) as Partial<Omit<StoredAnalytics, "syncedAt">>;
    } catch {
      console.warn(`[analytics] Lecture Google Analytics enregistrée illisible, ignorée (site ${siteId}).`);
      return null;
    }
    if (!a || typeof a !== "object" || !a.period || !a.totals) return null;
    const stored = Array.isArray(a.landingPages) ? a.landingPages : [];
    // Lectures enregistrées avant l'addition des chemins de même clé : additionnées ici, comme à la lecture.
    const landingPages = mergeLandingPages(stored).sort((x, y) => y.organicSessions - x.organicSessions || y.sessions - x.sessions);
    return {
      period: a.period,
      currency: a.currency ?? null,
      totals: a.totals,
      organic: a.organic ?? a.totals,
      channels: a.channels ?? [],
      series: a.series ?? [],
      landingPages,
      landingPagesTruncated: a.landingPagesTruncated ?? stored.length >= MAX_LANDING_PAGES,
      revenueStatus: a.revenueStatus ?? (a.totals.revenue === null ? "not_measured" : "measured"),
      syncedAt: r.synced_at as string,
    };
  }
  /** Enregistre une lecture de Google Analytics ; remplace la précédente. */
  setAnalytics(siteId: string, data: Omit<StoredAnalytics, "syncedAt">): string {
    const at = now();
    this.db
      .prepare("INSERT INTO analytics (site_id, synced_at, data_json) VALUES (?, ?, ?) ON CONFLICT(site_id) DO UPDATE SET synced_at = excluded.synced_at, data_json = excluded.data_json")
      .run(siteId, at, JSON.stringify(data));
    return at;
  }
  /**
   * Lecture au format de l'API ; pages d'arrivée rapprochées des pages de l'analyse affichée par leur chemin
   * (même clé que le rapprochement Shopify : sans paramètres, sans slash final, en minuscules), à chaque affichage.
   */
  analytics(siteId: string, configured: boolean): AnalyticsData {
    const a = this.getAnalytics(siteId);
    if (!a) return { available: false, reason: configured ? "not_run" : "not_configured" };
    const byKey = this.pagesByPathKey(siteId);
    return {
      available: true,
      syncedAt: a.syncedAt,
      period: a.period,
      currency: a.currency,
      totals: a.totals,
      organic: a.organic,
      channels: a.channels,
      series: a.series,
      landingPages: a.landingPages.map((p) => {
        const row = byKey.get(pathKey(p.path));
        return { ...p, pageId: row?.id ?? null, score: row?.score ?? null };
      }),
      landingPagesTruncated: a.landingPagesTruncated,
      revenueStatus: a.revenueStatus,
    };
  }
  /** Pages de l'analyse affichée, par clé de chemin (la première analysée l'emporte). */
  pagesByPathKey(siteId: string): Map<string, PageRow> {
    const out = new Map<string, PageRow>();
    const audit = this.resultsAudit(siteId);
    if (audit) for (const p of this.pageRows(audit.id)) if (!out.has(pathKey(p.path))) out.set(pathKey(p.path), p);
    return out;
  }
  /**
   * Visites d'une page d'après la dernière lecture de Google Analytics ; null sans lecture ou sans correspondance.
   * Les pages d'arrivée sont déjà additionnées par clé de chemin (getAnalytics) : même chiffre que la liste.
   */
  visitsFor(siteId: string, path: string): PageVisits | null {
    const a = this.getAnalytics(siteId);
    if (!a) return null;
    const key = pathKey(path);
    const hit = a.landingPages.find((p) => pathKey(p.path) === key);
    if (!hit) return null;
    const { path: _p, ...visits } = hit;
    return visits;
  }

  // ───────── Vitesse des pages

  /** Dernières mesures de vitesse d'une page (par chemin) ; null si elle n'a jamais été mesurée. */
  speedFor(siteId: string, path: string): { mobile: SpeedMeasure | null; desktop: SpeedMeasure | null } | null {
    const r = this.db.prepare("SELECT mobile_json, desktop_json FROM pagespeed_pages WHERE site_id = ? AND path_key = ?").get(siteId, pathKey(path)) as Row | undefined;
    if (!r || (!r.mobile_json && !r.desktop_json)) return null;
    const mobile = parseSpeedMeasure(r.mobile_json, siteId);
    const desktop = parseSpeedMeasure(r.desktop_json, siteId);
    return mobile || desktop ? { mobile, desktop } : null;
  }

  // ───────── Assistant

  chatMessages(siteId: string): ChatMessage[] {
    return (this.db.prepare("SELECT * FROM chat_messages WHERE site_id = ? ORDER BY seq").all(siteId) as Row[]).map((r) => ({
      id: r.id as string,
      role: r.role as "user" | "assistant",
      content: r.content as string,
      createdAt: r.created_at as string,
      sources: JSON.parse(r.sources_json as string),
      batchIds: r.batch_ids_json ? (JSON.parse(r.batch_ids_json as string) as string[]) : [],
    }));
  }
  insertChatMessage(siteId: string, role: "user" | "assistant", content: string, sources: string[], batchIds: string[] = []): ChatMessage {
    const seq = ((this.db.prepare("SELECT MAX(seq) AS m FROM chat_messages WHERE site_id = ?").get(siteId) as Row).m as number | null) ?? 0;
    const msg: ChatMessage = { id: newId("msg"), role, content, createdAt: now(), sources, batchIds };
    this.db
      .prepare("INSERT INTO chat_messages (id, site_id, seq, role, content, created_at, sources_json, batch_ids_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(msg.id, siteId, seq + 1, role, content, msg.createdAt, JSON.stringify(sources), JSON.stringify(batchIds));
    return msg;
  }
  clearChat(siteId: string): void {
    this.db.prepare("DELETE FROM chat_messages WHERE site_id = ?").run(siteId);
  }

  // ───────── Concurrents

  getCompetitors(siteId: string): Extract<CompetitorsData, { available: true }> | null {
    const r = this.db.prepare("SELECT data_json FROM competitors WHERE site_id = ?").get(siteId) as Row | undefined;
    return r ? JSON.parse(r.data_json as string) : null;
  }
  setCompetitors(siteId: string, data: Extract<CompetitorsData, { available: true }>): void {
    this.db
      .prepare("INSERT INTO competitors (site_id, checked_at, data_json) VALUES (?, ?, ?) ON CONFLICT(site_id) DO UPDATE SET checked_at = excluded.checked_at, data_json = excluded.data_json")
      .run(siteId, data.checkedAt, JSON.stringify(data));
  }

  // ───────── Paramètres

  getSetting(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as Row | undefined;
    return r ? (r.value as string) : null;
  }
  setSetting(key: string, value: string): void {
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  // ───────── Vues au format de l'API

  auditStatus(a: AuditRow): AuditStatus {
    return {
      id: a.id,
      state: a.state,
      startedAt: a.started_at,
      finishedAt: a.finished_at,
      maxPages: a.max_pages,
      pagesDone: a.pages_done,
      pagesFailed: a.pages_failed,
      pagesQueued: a.pages_queued,
      currentUrl: a.current_url,
      // Seule une analyse en cours peut être en pause ; la date est celle prévue par le parcours, pas une estimation.
      pausedUntil: a.state === "running" ? (a.paused_until ?? null) : null,
      error: a.error_json ? (JSON.parse(a.error_json) as ApiError["error"]) : null,
    };
  }

  siteSummary(s: SiteRow): SiteSummary {
    const latest = this.latestAudit(s.id);
    const results = this.resultsAudit(s.id);
    const gscAt = this.getGscMeta(s.id);
    return {
      id: s.id,
      url: s.url,
      host: s.host,
      name: s.name || s.host,
      createdAt: s.created_at,
      audit: latest ? this.auditStatus(latest) : null,
      results: results
        ? { auditId: results.id, state: results.state, finishedAt: results.finished_at, pagesDone: results.pages_done, pagesFailed: results.pages_failed }
        : null,
      score: results ? this.auditScore(results.id) : null,
      pagesAnalyzed: results ? results.pages_done : 0,
      searchConsole: { available: !!gscAt, importedAt: gscAt },
    };
  }

  pageSummary(r: PageRow, gsc: Map<string, { clicks: number; impressions: number; position: number }> | null): PageSummary {
    return {
      id: r.id,
      url: r.url,
      pageType: pageTypeOf(r),
      path: r.path,
      title: r.title,
      httpStatus: r.http_status,
      score: r.score,
      issues: r.issues,
      words: r.words,
      organic: gsc ? (gsc.get(r.url_key) ?? null) : null,
    };
  }

  /** `hidden` : sections masquées (mode intégré) ; leurs données valent null. */
  pageDetail(r: PageRow, gsc: Map<string, { clicks: number; impressions: number; position: number }> | null, hidden?: { analytics?: boolean; pageSpeed?: boolean }): PageDetail {
    const facts = JSON.parse(r.facts_json) as PageFacts;
    const checks = JSON.parse(r.checks_json) as PageCheck[];
    return {
      ...this.pageSummary(r, gsc),
      description: facts.description || null,
      h1: facts.h1,
      canonical: facts.canonical || null,
      lang: facts.lang || null,
      analyzedAt: r.analyzed_at,
      checks,
      serpPreview: {
        url: r.url,
        title: facts.title ? cut(facts.title, 60) : null,
        description: facts.description ? cut(facts.description, 158) : null,
      },
      // L'export « Performances » ne relie pas les requêtes aux pages ; la lecture directe chez Google, si.
      queries: this.gscQueriesFor(r.site_id, r.url_key),
      visits: hidden?.analytics ? null : this.visitsFor(r.site_id, r.path),
      speed: hidden?.pageSpeed ? null : this.speedFor(r.site_id, r.path),
      // Renseigné par la route (ShopifyService.resourceIdForPage) : dépend de la boutique configurée et lue.
      shopifyResourceId: null,
    };
  }

  searchConsole(siteId: string): SearchConsoleData {
    const gsc = this.getGsc(siteId);
    if (!gsc) return { available: false };
    const audit = this.resultsAudit(siteId);
    const byKey = new Map<string, PageRow>();
    if (audit) for (const p of this.pageRows(audit.id)) byKey.set(p.url_key, p);
    const pages: OrganicPage[] | null = gsc.data.pages
      ? gsc.data.pages.map((p) => {
          const key = urlKey(p.url);
          const match = key ? byKey.get(key) : undefined;
          return {
            url: p.url,
            path: displayPath(p.url),
            pageId: match?.id ?? null,
            score: match?.score ?? null,
            clicks: p.clicks,
            impressions: p.impressions,
            ctr: p.ctr,
            position: p.position,
          };
        })
      : null;
    return {
      available: true,
      importedAt: gsc.importedAt,
      source: gsc.source,
      matching: pages ? { matched: pages.filter((p) => p.pageId !== null).length, total: pages.length } : null,
      period: gsc.data.period,
      totals: totalsOf(gsc.data),
      series: gsc.data.series,
      queries: gsc.data.queries,
      pages,
    };
  }
}

export function toRecord(r: PageRow): PageRecord {
  return {
    id: r.id,
    url: r.url,
    path: r.path,
    score: r.score,
    checks: JSON.parse(r.checks_json),
    facts: JSON.parse(r.facts_json),
    categories: JSON.parse(r.categories_json),
  };
}
