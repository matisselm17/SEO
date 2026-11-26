/**
 * Parcours d'un site et notation de ses pages.
 * - part de l'adresse du site, lit robots.txt et le sitemap, suit les liens internes ;
 * - plafonné à maxPages, quelques chargements en parallèle, avec un délai entre deux requêtes ;
 * - n'occupe jamais le serveur (tout est asynchrone) ; annulable ; chaque page notée est enregistrée
 *   tout de suite, donc lisible pendant le parcours.
 */
import type { ApiError, SiteEvent } from "../../../shared/api.ts";
import { analysePage } from "../analyse/grille.ts";
import type { EventHub } from "../events.ts";
import { decodeHtml, FetchError, ROBOTS_TOKEN, safeFetch } from "../net/fetch.ts";
import type { AuditRow, SiteRow, Store } from "../store.ts";
import { ALLOW_ALL, parseRobots, type Robots } from "./robots.ts";
import { collectSitemapUrls } from "./sitemap.ts";
import { displayPath, exclusionReason, normalizeUrl, sameSite, urlKey } from "./url.ts";

export interface CrawlOptions {
  concurrency: number;
  /** Délai minimal entre deux requêtes d'un même chargeur, en millisecondes. */
  delayMs: number;
  pageTimeoutMs: number;
  maxPageBytes: number;
}

export const DEFAULT_CRAWL: CrawlOptions = { concurrency: 3, delayMs: 300, pageTimeoutMs: 15_000, maxPageBytes: 5 * 1024 * 1024 };

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

/** Nom du site : og:site_name, sinon la partie du titre de l'accueil qui ressemble à une marque. */
export function siteNameFrom(title: string, siteName: string, host: string): string {
  if (siteName.trim()) return siteName.trim().slice(0, 80);
  const t = title.trim();
  if (!t) return host;
  const parts = t.split(/\s+[|–—·•:]\s+|\s+-\s+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1) {
    const label = host.split(".")[0].replace(/[-_]/g, "").toLowerCase();
    const flat = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
    const match = parts.find((p) => flat(p) && (label.includes(flat(p)) || flat(p).includes(label)));
    return (match ?? parts.reduce((a, b) => (b.length < a.length ? b : a))).slice(0, 80);
  }
  return t.length <= 60 ? t : host;
}

/** Erreur d'une analyse interrompue par l'arrêt ou le redémarrage du serveur. */
export const INTERRUPTED: ApiError["error"] = {
  code: "internal",
  message: "L'analyse a été interrompue par un redémarrage du serveur. Les pages déjà notées sont conservées.",
  action: "Relancez l'analyse.",
};

/** Raison lisible d'un échec HTTP. */
export function httpFailureReason(status: number): string {
  if (status === 404 || status === 410) return `Page introuvable (${status})`;
  if (status === 401 || status === 403) return `Accès refusé par le site (${status})`;
  if (status === 429) return "Le site a refusé le chargement : trop de demandes (429)";
  if (status >= 500) return `Erreur du serveur du site (${status})`;
  return `Erreur HTTP (${status})`;
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

interface QueueItem {
  url: URL;
  key: string;
  depth: number;
}

export class Crawler {
  private running = new Map<string, AbortController>();
  private tasks = new Map<string, Promise<void>>();
  private pending: Array<{ site: SiteRow; audit: AuditRow; resolve: () => void }> = [];

  constructor(
    private store: Store,
    private hub: EventHub,
    private options: CrawlOptions = DEFAULT_CRAWL,
    private maxConcurrent = 2,
  ) {}

  isRunning(siteId: string): boolean {
    return this.running.has(siteId) || this.pending.some((p) => p.site.id === siteId);
  }

  /**
   * Lance l'analyse en arrière-plan, ou la met en attente (« queued ») si le plafond d'analyses
   * simultanées est atteint. La promesse se résout à la fin de l'analyse (utile aux tests).
   */
  start(site: SiteRow, audit: AuditRow): Promise<void> {
    let resolve!: () => void;
    const task = new Promise<void>((r) => (resolve = r));
    this.tasks.set(site.id, task);
    this.pending.push({ site, audit, resolve });
    this.pump();
    return task;
  }

  /** Démarre les analyses en attente tant qu'il reste des places. */
  private pump(): void {
    while (this.running.size < this.maxConcurrent && this.pending.length) {
      const { site, audit, resolve } = this.pending.shift()!;
      const controller = new AbortController();
      this.running.set(site.id, controller);
      this.run(site, audit, controller.signal)
        .catch((err) => {
          console.error("[analyse] Erreur inattendue :", err instanceof Error ? err.message : "inconnue");
          this.finish(site.id, audit.id, "failed", {
            code: "internal",
            message: "L'analyse s'est arrêtée sur une erreur inattendue.",
            action: "Relancez l'analyse.",
          });
        })
        .finally(() => {
          if (this.running.get(site.id) === controller) this.running.delete(site.id);
          if (this.tasks.get(site.id)) this.tasks.delete(site.id);
          resolve();
          this.pump();
        });
    }
  }

  /** Attend la fin de l'analyse d'un site (après une annulation, par exemple). */
  async wait(siteId: string): Promise<void> {
    await this.tasks.get(siteId);
  }

  /** Attend la fin de toutes les analyses (arrêt du serveur, tests). */
  async waitAll(): Promise<void> {
    while (this.tasks.size) await Promise.all([...this.tasks.values()]);
  }

  /** Arrêt demandé par l'utilisateur : « cancelled », pages notées conservées. */
  cancel(siteId: string): boolean {
    return this.stop(siteId, "user");
  }

  private stop(siteId: string, reason: "user" | "shutdown"): boolean {
    const idx = this.pending.findIndex((p) => p.site.id === siteId);
    if (idx >= 0) {
      const [p] = this.pending.splice(idx, 1);
      if (reason === "user") this.finish(siteId, p.audit.id, "cancelled", null);
      else this.finish(siteId, p.audit.id, "failed", INTERRUPTED);
      this.tasks.delete(siteId);
      p.resolve();
      return true;
    }
    const c = this.running.get(siteId);
    if (!c) return false;
    c.abort(reason);
    return true;
  }

  /** Arrêt du serveur : les analyses en cours ou en attente passent en échec, avec un message qui le dit. */
  stopAllForShutdown(): void {
    for (const p of [...this.pending]) this.stop(p.site.id, "shutdown");
    for (const id of [...this.running.keys()]) this.stop(id, "shutdown");
  }

  private emitAudit(siteId: string, auditId: string): void {
    this.hub.emitAudit(siteId, (): SiteEvent | null => {
      const a = this.store.getAudit(auditId);
      if (!a) return null;
      return { type: "audit", audit: this.store.auditStatus(a), score: this.store.auditScore(auditId) };
    });
  }

  private finish(siteId: string, auditId: string, state: "done" | "failed" | "cancelled", error: ApiError["error"] | null): void {
    const a = this.store.getAudit(auditId);
    if (!a || a.state === "done" || a.state === "failed" || a.state === "cancelled") return;
    this.store.updateAudit(auditId, {
      state,
      finished_at: new Date().toISOString(),
      current_url: null,
      pages_queued: 0,
      error_json: error ? JSON.stringify(error) : null,
    });
    this.emitAudit(siteId, auditId);
  }

  /** Fin après un arrêt : par l'utilisateur → « cancelled », même sans page notée ; par le serveur → « failed » avec un message. */
  private finishAborted(siteId: string, auditId: string, signal: AbortSignal): void {
    if (signal.reason === "shutdown") return this.finish(siteId, auditId, "failed", INTERRUPTED);
    this.finish(siteId, auditId, "cancelled", null);
  }

  private async run(site: SiteRow, audit: AuditRow, signal: AbortSignal): Promise<void> {
    const { store } = this;
    const opts = this.options;
    const start = new URL(site.url);
    const prefer = { host: start.hostname, protocol: start.protocol };
    store.updateAudit(audit.id, { state: "running", pages_queued: 1, current_url: start.href });
    this.emitAudit(site.id, audit.id);

    // robots.txt
    let robots: Robots = ALLOW_ALL;
    try {
      const res = await safeFetch(new URL("/robots.txt", start).href, {
        signal,
        timeoutMs: 8_000,
        maxBytes: 512 * 1024,
        accept: "text/plain,*/*;q=0.5",
      });
      if (res.status >= 200 && res.status < 300 && !/html/.test(res.contentType)) robots = parseRobots(res.body.toString("utf8"), ROBOTS_TOKEN);
    } catch {
      /* pas de robots.txt lisible : tout est permis */
    }
    if (signal.aborted) return this.finishAborted(site.id, audit.id, signal);

    const crawlDelayMs = robots.crawlDelay ? Math.min(robots.crawlDelay, 5) * 1000 : 0;
    const concurrency = crawlDelayMs ? 1 : opts.concurrency;
    const delayMs = Math.max(opts.delayMs, crawlDelayMs);

    const maxPages = audit.max_pages;
    const seen = new Set<string>();
    const buckets: QueueItem[][] = [];
    let queuedCount = 0;
    let done = 0;
    let failed = 0;
    let inflight = 0;
    let lastStarted: string | null = null;
    let sitemapPending = true;
    let wake: (() => void) | null = null;
    const notify = () => {
      const w = wake;
      wake = null;
      w?.();
    };

    const remainingSlots = () => Math.max(0, maxPages - done - failed - inflight);
    const sync = () => {
      store.updateAudit(audit.id, {
        pages_done: done,
        pages_failed: failed,
        pages_queued: Math.min(queuedCount, remainingSlots()),
        current_url: inflight > 0 ? lastStarted : null,
      });
      this.emitAudit(site.id, audit.id);
    };

    const enqueue = (raw: string, depth: number, base?: string): void => {
      const u = normalizeUrl(raw, base, prefer);
      if (!u || !sameSite(u, start.hostname)) return;
      if (exclusionReason(u)) return;
      const key = urlKey(u);
      if (!key || seen.has(key)) return;
      if (!robots.isAllowed(u.pathname + u.search)) return;
      seen.add(key);
      (buckets[depth] ??= []).push({ url: u, key, depth });
      queuedCount++;
    };
    const dequeue = (): QueueItem | null => {
      for (const b of buckets) {
        if (b?.length) {
          queuedCount--;
          return b.shift()!;
        }
      }
      return null;
    };

    // La page de départ passe toujours en premier, même si robots.txt l'interdit pour un chemin précis.
    const startNorm = normalizeUrl(start, undefined, prefer)!;
    seen.add(urlKey(startNorm)!);
    buckets[0] = [{ url: startNorm, key: urlKey(startNorm)!, depth: 0 }];
    queuedCount = 1;

    // Sitemaps, en parallèle du parcours.
    const sitemapStarts = robots.sitemaps.length ? robots.sitemaps.slice(0, 5) : [new URL("/sitemap.xml", start).href];
    const sitemapCtl = new AbortController();
    const sitemapTask = collectSitemapUrls(sitemapStarts, { signal: AbortSignal.any([signal, sitemapCtl.signal]), limit: Math.max(maxPages * 5, 200) })
      .then((urls) => {
        for (const u of urls) enqueue(u, 2);
      })
      .catch(() => undefined)
      .finally(() => {
        sitemapPending = false;
        sync();
        notify();
      });

    let startFailure: string | null = null;

    const processOne = async (item: QueueItem): Promise<void> => {
      let res;
      try {
        res = await safeFetch(item.url.href, {
          signal,
          timeoutMs: opts.pageTimeoutMs,
          maxBytes: opts.maxPageBytes,
          // Une redirection vers une page déjà connue (en file ou notée) n'est pas suivie : pas de double chargement.
          shouldFollow: (next) => {
            const n = normalizeUrl(next, undefined, prefer);
            if (!n || !sameSite(n, start.hostname)) return item.depth === 0;
            const k = urlKey(n);
            return !k || k === item.key || !seen.has(k);
          },
          acceptBody: (status, ct) => status < 400 && (/text\/html|application\/xhtml\+xml/.test(ct) || ct === ""),
        });
      } catch (err) {
        if (signal.aborted) return;
        const reason = err instanceof FetchError ? err.message : "Connexion impossible";
        failed++;
        store.insertFailure(audit.id, item.url.href, reason, null);
        if (item.depth === 0) startFailure = lowerFirst(reason);
        return;
      }
      const finalUrl = new URL(res.url);
      if (res.status >= 400) {
        failed++;
        store.insertFailure(audit.id, finalUrl.href, httpFailureReason(res.status), res.status);
        if (item.depth === 0) startFailure = lowerFirst(httpFailureReason(res.status));
        return;
      }
      if (!res.body.length) {
        // Pas une page HTML (image, PDF…) : ignorée, sans compter comme un échec.
        if (item.depth === 0) {
          failed++;
          startFailure = "la page d'accueil n'est pas une page HTML";
          store.insertFailure(audit.id, finalUrl.href, "Ce n'est pas une page HTML", res.status);
        }
        return;
      }
      // Redirection : la page finale doit rester sur le site et ne pas avoir déjà été vue.
      const finalNorm = normalizeUrl(finalUrl, undefined, prefer);
      if (!finalNorm || !sameSite(finalNorm, start.hostname)) {
        if (item.depth === 0) {
          failed++;
          startFailure = "la page d'accueil redirige vers un autre site";
          store.insertFailure(audit.id, finalUrl.href, "Redirection vers un autre site", res.status);
        }
        return;
      }
      const finalKey = urlKey(finalNorm)!;
      if (finalKey !== item.key) {
        if (store.hasPageKey(audit.id, finalKey) || (seen.has(finalKey) && item.depth > 0)) return;
        seen.add(finalKey);
      }
      if (store.hasPageKey(audit.id, finalKey)) return;

      const html = decodeHtml(res.body, res.contentType);
      const pageUrl = finalNorm.href;
      const analysis = analysePage(html, pageUrl);
      if (signal.aborted) return;
      for (const link of analysis.links) enqueue(link, item.depth + 1, pageUrl);

      const issues = analysis.checks.filter((c) => c.status !== "pass").length;
      const row = store.insertPage({
        audit_id: audit.id,
        site_id: site.id,
        url: pageUrl,
        url_key: finalKey,
        path: displayPath(finalNorm),
        title: analysis.facts.title || null,
        http_status: res.status,
        score: analysis.score,
        issues,
        words: analysis.facts.words,
        analyzed_at: new Date().toISOString(),
        checks_json: JSON.stringify(analysis.checks),
        facts_json: JSON.stringify(analysis.facts),
        categories_json: JSON.stringify(analysis.categories),
      });
      done++;
      if (item.depth === 0) {
        store.setSiteName(site.id, siteNameFrom(analysis.facts.title, analysis.facts.siteName, start.hostname.replace(/^www\./, "")));
      }
      this.hub.emit(site.id, { type: "page", page: store.pageSummary(row, store.gscIndex(site.id)) });
    };

    const worker = async (): Promise<void> => {
      while (!signal.aborted) {
        if (done + failed + inflight >= maxPages) return;
        const item = dequeue();
        if (!item) {
          if (inflight === 0 && !sitemapPending) return;
          await new Promise<void>((resolve) => {
            const prev = wake;
            wake = () => (prev?.(), resolve());
            setTimeout(resolve, 500);
          });
          continue;
        }
        inflight++;
        lastStarted = item.url.href;
        sync();
        try {
          await processOne(item);
        } finally {
          inflight--;
          sync();
          notify();
        }
        await sleep(delayMs, signal);
      }
    };

    // La page d'accueil d'abord, seule ; puis les chargeurs en parallèle.
    const first = dequeue()!;
    inflight++;
    lastStarted = first.url.href;
    sync();
    try {
      await processOne(first);
    } finally {
      inflight--;
    }
    sync();
    if (!signal.aborted && done > 0) {
      await sleep(delayMs, signal);
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
    }

    if (signal.aborted) {
      sitemapCtl.abort();
      sync();
      return this.finishAborted(site.id, audit.id, signal);
    }
    // On n'attend pas les sitemaps restants si le plafond est atteint.
    sitemapCtl.abort();
    void sitemapTask;
    sync();
    if (done === 0) {
      return this.finish(site.id, audit.id, "failed", {
        code: "site_unreachable",
        message: startFailure ? `Le site n'a pas pu être chargé : ${startFailure}.` : "Aucune page du site n'a pu être chargée.",
        action: "Vérifiez que le site est en ligne et accessible, puis relancez l'analyse.",
      });
    }
    this.finish(site.id, audit.id, "done", null);
  }
}
