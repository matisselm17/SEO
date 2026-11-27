/**
 * Parcours d'un site et notation de ses pages.
 * - lit robots.txt, dresse l'inventaire du site par son sitemap (types de pages, langue principale seulement),
 *   puis charge l'accueil, les types à tour de rôle (parcours équilibré), et enfin les liens découverts hors sitemap ;
 * - sur une boutique Shopify, lit le catalogue (/products.json) pour les produits dont la page n'a pas été ouverte ;
 * - plafonné à maxPages, quelques chargements en parallèle, avec un délai entre deux requêtes ;
 * - n'occupe jamais le serveur (tout est asynchrone) ; annulable ; chaque page notée est enregistrée
 *   tout de suite, donc lisible pendant le parcours.
 */
import type { ApiError, PageType, SiteEvent } from "../../../shared/api.ts";
import { analysePage } from "../analyse/grille.ts";
import type { CoverageState } from "../coverage.ts";
import type { EventHub } from "../events.ts";
import { decodeHtml, FetchError, ROBOTS_TOKEN, safeFetch } from "../net/fetch.ts";
import type { AuditRow, SiteRow, Store } from "../store.ts";
import { ALLOW_ALL, parseRobots, type Robots } from "./robots.ts";
import {
  buildInventory,
  classifyPath,
  detectShopify,
  hreflangAlternates,
  localeOf,
  localesFromHreflang,
  mainLocaleFrom,
} from "./inventory.ts";
import { readShopifyCatalogue, toCatalogueProduct, type CatalogueProduct } from "./shopify.ts";
import { DEFAULT_RETRY, isTransientStatus, parseRetryAfter, sleep, Throttle, type RetryPolicy } from "./throttle.ts";
import { displayPath, exclusionReason, normalizeUrl, sameSite, urlKey } from "./url.ts";

export interface CrawlOptions {
  concurrency: number;
  /** Délai minimal entre deux requêtes d'un même chargeur, en millisecondes. */
  delayMs: number;
  pageTimeoutMs: number;
  maxPageBytes: number;
  /** Produits par page de /products.json (250 sur une vraie boutique ; réduit dans les tests pour la pagination). */
  cataloguePageSize?: number;
  /** Conduite face aux refus passagers (429, 503) ; réduite dans les tests pour qu'ils restent rapides. */
  retry?: RetryPolicy;
}

export const DEFAULT_CRAWL: CrawlOptions = { concurrency: 3, delayMs: 300, pageTimeoutMs: 15_000, maxPageBytes: 5 * 1024 * 1024, retry: DEFAULT_RETRY };

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
  if (status === 503) return "Le site était momentanément indisponible (503)";
  if (status >= 500) return `Erreur du serveur du site (${status})`;
  return `Erreur HTTP (${status})`;
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

interface QueueItem {
  url: URL;
  key: string;
  depth: number;
  type: PageType;
  /** La page vient de l'inventaire (sitemap). */
  inv: boolean;
  /** Nouvelles tentatives déjà faites après un refus passager. */
  retries?: number;
}

/** Fin de la raison d'un échec après un refus passager, selon la raison de l'abandon. */
function giveUpSuffix(why: "max_retries" | "budget" | "retry_after_too_long", retries: number): string {
  if (why === "retry_after_too_long") return ", le site demande d'attendre trop longtemps avant de réessayer";
  if (why === "budget") return retries ? `, toujours refusé après ${retries} nouvelle${retries > 1 ? "s" : ""} tentative${retries > 1 ? "s" : ""} (temps d'attente maximal atteint)` : " (temps d'attente maximal atteint)";
  return `, toujours refusé après ${retries} nouvelle${retries > 1 ? "s" : ""} tentative${retries > 1 ? "s" : ""}`;
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
    /** Rythme adaptatif : ralentit dès le premier refus passager du site, partagé avec la lecture du catalogue. */
    const throttle = new Throttle(opts.retry ?? DEFAULT_RETRY, concurrency, delayMs);

    const maxPages = audit.max_pages;
    const startNorm = normalizeUrl(start, undefined, prefer)!;
    const startKey = urlKey(startNorm)!;
    /** Préfixe de langue de l'adresse de départ : la langue principale ; les autres préfixes sont écartés. */
    const startPrefix = localeOf(startNorm.pathname);
    const accept = (u: URL) => !exclusionReason(u) && robots.isAllowed(u.pathname + u.search);

    const seen = new Set<string>();
    /** Pages de l'inventaire (langue principale, chargeables) et leur type ; l'accueil en fait toujours partie. */
    const invKeys = new Map<string, PageType>();
    /** Pages connues hors inventaire, par type : notées après un lien, ou produits du catalogue absents du sitemap. */
    const extra = new Map<PageType, Set<string>>();
    const typeQueues = new Map<PageType, QueueItem[]>();
    const linkBuckets: QueueItem[][] = [];
    /** Pages refusées passagèrement, à retenter en priorité (après la pause). */
    const retryQueue: QueueItem[] = [];
    /** Le site refuse encore alors que le temps d'attente maximal est atteint : plus aucune nouvelle page n'est chargée. */
    let stopNew = false;
    const attemptedInv = new Set<string>();
    const analyzedKeys = new Set<string>();
    const failedKeys = new Set<string>();
    let queuedCount = 0;
    let done = 0;
    let failed = 0;
    let inflight = 0;
    let lastStarted: string | null = null;
    /** Fichier lu hors chargement de page (sitemap, catalogue) : la progression le montre tel quel. */
    let phaseUrl: string | null = null;
    let wake: (() => void) | null = null;
    const notify = () => {
      const w = wake;
      wake = null;
      w?.();
    };

    // ── 1. Inventaire par le sitemap, avant le parcours.
    const sitemapStarts = robots.sitemaps.length ? robots.sitemaps.slice(0, 5) : [new URL("/sitemap.xml", start).href];
    const inventory = await buildInventory(sitemapStarts, {
      signal,
      start: startNorm,
      startPrefix,
      prefer,
      accept,
      onFile: (u) => {
        phaseUrl = u;
        store.updateAudit(audit.id, { current_url: u });
        this.emitAudit(site.id, audit.id);
      },
    });
    phaseUrl = null;
    if (signal.aborted) return this.finishAborted(site.id, audit.id, signal);

    const sitemapMode = inventory.found;
    const knownLocales = new Set(inventory.locales);
    const otherLocales = new Set(inventory.locales);
    let platform: "shopify" | null = inventory.shopifyHint ? "shopify" : null;
    let mainLocale: string | null = startPrefix ? startPrefix.split("-")[0] : null;
    let viaCatalogue = 0;
    let catalogueStatus: CoverageState["catalogue"] = null;

    let lastCoverage = "";
    const writeCoverage = () => {
      const counts: CoverageState["counts"] = {};
      for (const [, t] of invKeys) counts[t] = (counts[t] ?? 0) + 1;
      for (const [t, set] of extra) if (set.size) counts[t] = (counts[t] ?? 0) + set.size;
      const state: CoverageState = {
        platform,
        inventory: sitemapMode ? "sitemap" : "links",
        mainLocale,
        otherLocales: [...otherLocales].sort(),
        counts,
        unknown: !sitemapMode || inventory.unknown === "all" ? "all" : [...inventory.unknown],
        inventoryTotal: sitemapMode ? invKeys.size : null,
        pending: sitemapMode ? invKeys.size - attemptedInv.size : null,
        viaCatalogue,
        catalogue: platform === "shopify" ? catalogueStatus : null,
      };
      const json = JSON.stringify(state);
      if (json === lastCoverage) return;
      lastCoverage = json;
      store.setCoverageState(audit.id, state);
    };

    const remainingSlots = () => Math.max(0, maxPages - done - failed - inflight);
    const sync = () => {
      store.updateAudit(audit.id, {
        pages_done: done,
        pages_failed: failed,
        pages_queued: Math.min(queuedCount, remainingSlots()),
        current_url: inflight > 0 ? lastStarted : phaseUrl,
      });
      writeCoverage();
      this.emitAudit(site.id, audit.id);
    };

    // L'accueil passe toujours en premier, même si robots.txt l'interdit pour un chemin précis.
    seen.add(startKey);
    const homeItem: QueueItem = { url: startNorm, key: startKey, depth: 0, type: "home", inv: sitemapMode };
    if (sitemapMode) invKeys.set(startKey, "home");
    queuedCount = 1;
    // Les pages inventoriées, rangées par type ; elles passent avant les liens découverts hors sitemap.
    for (const e of inventory.entries) {
      if (seen.has(e.key)) continue;
      seen.add(e.key);
      const type: PageType = e.type === "home" ? "other" : e.type;
      invKeys.set(e.key, type);
      let q = typeQueues.get(type);
      if (!q) typeQueues.set(type, (q = []));
      q.push({ url: e.url, key: e.key, depth: 1, type, inv: true });
      queuedCount++;
    }

    const enqueueLink = (raw: string, depth: number, base: string): void => {
      const u = normalizeUrl(raw, base, prefer);
      if (!u || !sameSite(u, start.hostname)) return;
      if (platform === "shopify") {
        // Shopify relie souvent les produits par « /collections/<c>/products/<h> », qui renvoie à « /products/<h> » :
        // une seule page, chargée une seule fois.
        const m = /^((?:\/[^/]+)?)\/collections\/[^/]+\/products\/([^/]+)$/.exec(u.pathname);
        if (m && (!m[1] || m[1].slice(1).toLowerCase() === startPrefix)) u.pathname = `${m[1]}/products/${m[2]}`;
      }
      if (exclusionReason(u)) return;
      const key = urlKey(u);
      if (!key || seen.has(key)) return;
      const loc = localeOf(u.pathname, knownLocales);
      if (loc && loc !== startPrefix) {
        // Autre version de langue : signalée, ni chargée ni comptée.
        otherLocales.add(loc);
        seen.add(key);
        return;
      }
      if (!robots.isAllowed(u.pathname + u.search)) return;
      seen.add(key);
      (linkBuckets[depth] ??= []).push({ url: u, key, depth, type: classifyPath(u.pathname, { prefix: startPrefix }), inv: false });
      queuedCount++;
    };

    /** Parcours équilibré : les types de l'inventaire à tour de rôle, puis les liens découverts, du plus proche au plus lointain. */
    let turn = 0;
    const dequeue = (): QueueItem | null => {
      if (retryQueue.length) {
        queuedCount--;
        return retryQueue.shift()!;
      }
      for (let i = 0; i < ROUND_ROBIN.length; i++) {
        const t = ROUND_ROBIN[(turn + i) % ROUND_ROBIN.length];
        const q = typeQueues.get(t);
        if (q?.length) {
          turn = (turn + i + 1) % ROUND_ROBIN.length;
          queuedCount--;
          return q.shift()!;
        }
      }
      for (const b of linkBuckets) {
        if (b?.length) {
          queuedCount--;
          return b.shift()!;
        }
      }
      return null;
    };

    let startFailure: string | null = null;
    const fail = (item: QueueItem, url: string, reason: string, status: number | null) => {
      failed++;
      failedKeys.add(item.key);
      store.insertFailure(audit.id, url, reason, status, item.type);
    };

    /** Renvoie "retry" si la page a été remise en file après un refus passager. */
    const processOne = async (item: QueueItem): Promise<"retry" | void> => {
      let res;
      const epoch = throttle.epoch;
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
        fail(item, item.url.href, reason, null);
        if (item.depth === 0) startFailure = lowerFirst(reason);
        return;
      }
      const finalUrl = new URL(res.url);
      if (isTransientStatus(res.status)) {
        const retries = item.retries ?? 0;
        const d = throttle.onRefusal({ attempt: retries, retryAfterMs: parseRetryAfter(res.headers["retry-after"]), startedEpoch: epoch, pool: "pages" });
        if (d.retry) {
          console.info(`[analyse] ${start.host} : refus passager (${res.status}), page remise en file (nouvelle tentative ${retries + 1}/${throttle.policy.maxRetries}) ; rythme : ${throttle.concurrency} à la fois, ${throttle.delayMs} ms`);
          retryQueue.push({ ...item, retries: retries + 1 });
          queuedCount++;
          return "retry";
        }
        console.warn(`[analyse] ${start.host} : refus passager (${res.status}), page abandonnée (${d.why}, ${retries} nouvelle(s) tentative(s))`);
        if (d.why === "budget") stopNew = true;
        fail(item, finalUrl.href, httpFailureReason(res.status) + giveUpSuffix(d.why, retries), res.status);
        if (item.depth === 0) startFailure = lowerFirst(httpFailureReason(res.status));
        return;
      }
      if (res.status >= 400) {
        fail(item, finalUrl.href, httpFailureReason(res.status), res.status);
        if (item.depth === 0) startFailure = lowerFirst(httpFailureReason(res.status));
        return;
      }
      if (!res.body.length) {
        // Pas une page HTML (image, PDF…) : ignorée, sans compter comme un échec.
        if (item.depth === 0) {
          startFailure = "la page d'accueil n'est pas une page HTML";
          fail(item, finalUrl.href, "Ce n'est pas une page HTML", res.status);
        }
        return;
      }
      // Redirection : la page finale doit rester sur le site et ne pas avoir déjà été vue.
      const finalNorm = normalizeUrl(finalUrl, undefined, prefer);
      if (!finalNorm || !sameSite(finalNorm, start.hostname)) {
        if (item.depth === 0) {
          startFailure = "la page d'accueil redirige vers un autre site";
          fail(item, finalUrl.href, "Redirection vers un autre site", res.status);
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
      if (item.depth === 0) {
        // L'accueil donne la langue principale, la plateforme et les autres versions de langue (hreflang).
        mainLocale = mainLocaleFrom(analysis.facts.lang, startPrefix);
        if (!platform && detectShopify(html, res.headers)) platform = "shopify";
        for (const loc of localesFromHreflang(hreflangAlternates(html, pageUrl), { host: start.hostname, startPrefix, mainLocale })) {
          otherLocales.add(loc);
          knownLocales.add(loc);
        }
      }
      for (const link of analysis.links) enqueueLink(link, item.depth + 1, pageUrl);

      const type: PageType =
        item.depth === 0 ? "home" : (invKeys.get(finalKey) ?? (finalKey === item.key ? item.type : classifyPath(finalNorm.pathname, { prefix: startPrefix })));
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
        page_type: type,
      });
      done++;
      analyzedKeys.add(finalKey);
      if (!item.inv && !invKeys.has(finalKey)) {
        let set = extra.get(type);
        if (!set) extra.set(type, (set = new Set()));
        set.add(finalKey);
      }
      if (item.depth === 0) {
        store.setSiteName(site.id, siteNameFrom(analysis.facts.title, analysis.facts.siteName, start.hostname.replace(/^www\./, "")));
      }
      this.hub.emit(site.id, { type: "page", page: store.pageSummary(row, store.gscIndex(site.id)) });
    };

    const runItem = async (item: QueueItem): Promise<void> => {
      inflight++;
      lastStarted = item.url.href;
      sync();
      try {
        const outcome = await processOne(item);
        if (item.inv && !signal.aborted && outcome !== "retry") attemptedInv.add(item.key);
      } finally {
        inflight--;
        sync();
        notify();
      }
    };

    const worker = async (index: number): Promise<void> => {
      while (!signal.aborted && !stopNew) {
        // Après un refus passager, un seul chargeur continue (le premier) ; les autres s'arrêtent.
        if (index >= throttle.concurrency) return;
        if (throttle.pauseLeftMs() > 0) {
          sync();
          await throttle.waitPause(signal);
          if (signal.aborted || stopNew) return;
        }
        if (done + failed + inflight >= maxPages) return;
        const item = dequeue();
        if (!item) {
          if (inflight === 0) return;
          await new Promise<void>((resolve) => {
            const prev = wake;
            wake = () => (prev?.(), resolve());
            setTimeout(resolve, 500);
          });
          continue;
        }
        await runItem(item);
        await sleep(throttle.nextDelay(), signal);
      }
    };

    // ── 2. L'accueil d'abord, seul (retenté s'il est refusé passagèrement) ; puis les chargeurs en parallèle.
    queuedCount--;
    let first: QueueItem | undefined = homeItem;
    while (first && !signal.aborted) {
      await runItem(first);
      first = undefined;
      if (done === 0 && retryQueue.length) {
        sync();
        await throttle.waitPause(signal);
        first = dequeue() ?? undefined;
      }
    }
    if (!signal.aborted && done > 0) {
      await sleep(throttle.nextDelay(), signal);
      await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));
      // Une page remise en file juste après l'arrêt du dernier chargeur (plafond presque atteint) est retentée quand même.
      while (retryQueue.length && !signal.aborted && !stopNew && done + failed < maxPages) await worker(0);
    }
    if (signal.aborted) {
      sync();
      return this.finishAborted(site.id, audit.id, signal);
    }

    // ── 3. Boutique Shopify : les produits dont la page n'a pas été ouverte sont lus dans le catalogue.
    if (done > 0 && platform === "shopify") {
      const productKeys = [...invKeys].filter(([, t]) => t === "product").map(([k]) => k);
      const productsUnknown = !sitemapMode || inventory.unknown === "all" || inventory.unknown.has("product");
      const unopened = productKeys.some((k) => !analyzedKeys.has(k) && !failedKeys.has(k));
      if (!productsUnknown && !unopened) catalogueStatus = "not_needed";
      else if (!robots.isAllowed("/products.json")) catalogueStatus = "unavailable";
      else {
        // Le catalogue suit le dernier chargement de page : on observe d'abord le délai courant (et la pause en cours).
        await sleep(throttle.delayMs, signal);
        const result = await readShopifyCatalogue(start.origin, {
          signal,
          pageSize: opts.cataloguePageSize,
          throttle,
          onPage: (u) => {
            phaseUrl = u;
            sync();
          },
        });
        phaseUrl = null;
        if (signal.aborted) {
          sync();
          return this.finishAborted(site.id, audit.id, signal);
        }
        if (!result.ok || !result.products.length) {
          // Illisible (cause journalisée par la lecture), désactivé ou vide : les produits non ouverts ne sont pas couverts.
          if (result.ok) console.warn(`[catalogue] ${start.host} : catalogue vide`);
          catalogueStatus = "unavailable";
        } else {
          const prefixPath = startPrefix ? `/${startPrefix}` : "";
          const list: CatalogueProduct[] = [];
          const listed = new Set<string>();
          for (const p of result.products) {
            const u = normalizeUrl(`${prefixPath}/products/${p.handle}`, start.origin, prefer);
            const key = u ? urlKey(u) : null;
            if (!u || !key || listed.has(key)) continue;
            // Un produit ouvert en entier (ou dont la page a été tentée) n'est jamais compté dans le catalogue.
            if (analyzedKeys.has(key) || failedKeys.has(key) || !accept(u)) continue;
            listed.add(key);
            list.push(toCatalogueProduct(p, u.href, displayPath(u)));
            if (!invKeys.has(key)) {
              let set = extra.get("product");
              if (!set) extra.set("product", (set = new Set()));
              set.add(key);
            }
          }
          store.setCatalogue(audit.id, list);
          viaCatalogue = list.length;
          catalogueStatus = list.length ? "read" : unopened ? "unavailable" : "not_needed";
        }
      }
    }

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

/** Ordre de passage des types dans le parcours équilibré (l'accueil est toujours chargé avant). */
const ROUND_ROBIN: PageType[] = ["product", "collection", "article", "blog", "page", "policy", "other", "home"];
