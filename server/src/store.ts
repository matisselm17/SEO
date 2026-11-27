/**
 * Accès aux données et construction des réponses au format de shared/api.ts.
 */
import type {
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
  SearchConsoleData,
  SiteSummary,
} from "../../shared/api.ts";
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

export class Store {
  /** Cache des agrégats par analyse, invalidé à chaque page ajoutée. */
  private aggCache = new Map<string, { version: number; agg: SiteAggregate }>();
  private recordCache = new Map<string, { version: number; records: PageRecord[] }>();
  private versions = new Map<string, number>();

  constructor(public db: DB) {}

  // ───────── Sites

  insertSite(url: string, host: string, name: string | null): SiteRow {
    const row: SiteRow = { id: newId("site"), url, host, name, created_at: now() };
    this.db.prepare("INSERT INTO sites (id, url, host, name, created_at) VALUES (?, ?, ?, ?, ?)").run(row.id, row.url, row.host, row.name, row.created_at);
    return row;
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

  private invalidate(auditId: string, drop = false): void {
    this.versions.set(auditId, (this.versions.get(auditId) ?? 0) + 1);
    if (drop) {
      this.aggCache.delete(auditId);
      this.recordCache.delete(auditId);
    }
  }

  records(auditId: string): PageRecord[] {
    const version = this.versions.get(auditId) ?? 0;
    const cached = this.recordCache.get(auditId);
    if (cached && cached.version === version) return cached.records;
    const records = this.pageRows(auditId).map(toRecord);
    this.recordCache.set(auditId, { version, records });
    return records;
  }

  aggregate(auditId: string, siteName: string): SiteAggregate {
    const version = this.versions.get(auditId) ?? 0;
    const cached = this.aggCache.get(auditId);
    if (cached && cached.version === version) return cached.agg;
    const agg = aggregate(this.records(auditId), siteName, this.catalogue(auditId));
    this.aggCache.set(auditId, { version, agg });
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

  pageDetail(r: PageRow, gsc: Map<string, { clicks: number; impressions: number; position: number }> | null): PageDetail {
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
