/**
 * Mesure de vitesse en tâche de fond (docs/format-echange.md, « Vitesse des pages »).
 *
 * - Une page à la fois, mobile puis ordinateur, 60 s au plus par mesure ; `running` donne l'avancement réel.
 * - Une seule mesure en cours par site (`limit_reached`), 30 pages mesurées par heure et par site (`rate_limited`,
 *   les pages réservées par une demande arrêtée avant d'être tentées sont rendues), 10 pages au plus par demande.
 *   Seules des pages de l'analyse affichée, sur l'hôte du site : l'adresse mesurée est lue en base, jamais reçue
 *   du client.
 * - Une page en échec n'arrête pas les autres : elle est listée dans `failures` (page, appareil, raison), remis à
 *   zéro au début de chaque demande et jamais par une réussite. `lastError` est réservé à ce qui arrête toute la
 *   demande (clé refusée, non autorisée, quota épuisé). Les deux sont enregistrés en base.
 * - L'état « en cours » vit en mémoire : après un redémarrage, une mesure interrompue n'est pas reprise ; les
 *   pages déjà mesurées restent en base.
 * - Événement SSE `pagespeed` au départ, à chaque page terminée et à la fin.
 */
import type { ApiError, MeasureSpeedRequest, PageSpeedState, PageType, SpeedMeasure, SpeedPage } from "../../../shared/api.ts";
import { PAGE_TYPES } from "../crawl/inventory.ts";
import { bareHost } from "../crawl/url.ts";
import type { Row } from "../db.ts";
import { errors, HttpError } from "../errors.ts";
import type { EventHub } from "../events.ts";
import { PageSpeedError, pagespeedErrors, type PageSpeedClient, type Strategy } from "../google/pagespeed.ts";
import { pathKey } from "../shopify/repo.ts";
import { pageTypeOf, parseSpeedMeasure, type PageRow, type SiteRow, type Store } from "../store.ts";

export const MAX_SPEED_PAGES = 10;
/** Pages mesurées (mobile et ordinateur) par heure et par site. */
export const SPEED_PAGES_PER_HOUR = 30;
const HOUR_MS = 3_600_000;

interface Target {
  url: string;
  path: string;
  pageType: PageType;
}

type Failure = PageSpeedState["failures"][number];

/** Pages réservées par une demande dans la fenêtre d'une heure. */
interface Reservation {
  at: number;
  pages: number;
}

interface Running {
  done: number;
  /** Pages pour lesquelles au moins une mesure a été tentée. */
  attempted: number;
  total: number;
  currentUrl: string | null;
  controller: AbortController;
  promise: Promise<void>;
}

export class PageSpeedService {
  private running = new Map<string, Running>();
  private reservations = new Map<string, Reservation[]>();
  private readonly now: () => number;

  constructor(
    private store: Store,
    private hub: EventHub,
    private client: PageSpeedClient,
    opts: { now?: () => number } = {},
  ) {
    this.now = opts.now ?? client.now;
  }

  get configured(): boolean {
    return this.client.configured;
  }

  state(site: SiteRow): PageSpeedState {
    const r = this.running.get(site.id);
    return {
      configured: this.configured,
      running: r ? { done: r.done, total: r.total, currentUrl: r.currentUrl } : null,
      pages: this.pages(site.id),
      ...this.status(site.id),
    };
  }

  /** Pages mesurées, rapprochées de l'analyse affichée ; la plus lente sur mobile d'abord. */
  pages(siteId: string): SpeedPage[] {
    const byKey = this.store.pagesByPathKey(siteId);
    const rows = this.store.db.prepare("SELECT * FROM pagespeed_pages WHERE site_id = ? ORDER BY updated_at DESC").all(siteId) as Row[];
    const parse = (v: unknown) => parseSpeedMeasure(v, siteId);
    const pages: SpeedPage[] = rows
      .map((r) => {
        const page = byKey.get(r.path_key as string);
        return {
          pageId: page?.id ?? null,
          url: r.url as string,
          path: r.path as string,
          pageType: page ? pageTypeOf(page) : ((r.page_type as PageType | null) ?? null),
          mobile: parse(r.mobile_json),
          desktop: parse(r.desktop_json),
        };
      })
      .filter((p) => p.mobile || p.desktop);
    return pages.sort((a, b) => (a.mobile?.score ?? 101) - (b.mobile?.score ?? 101));
  }

  /** Dernière erreur bloquante et échecs page par page de la dernière demande, tels qu'enregistrés. */
  private status(siteId: string): { lastError: ApiError["error"] | null; failures: Failure[] } {
    const r = this.store.db.prepare("SELECT last_error_json, failures_json FROM pagespeed_status WHERE site_id = ?").get(siteId) as Row | undefined;
    let lastError: ApiError["error"] | null = null;
    let failures: Failure[] = [];
    if (r?.last_error_json) {
      try {
        lastError = JSON.parse(r.last_error_json as string) as ApiError["error"];
      } catch {
        console.warn(`[vitesse] Dernière erreur enregistrée illisible, ignorée (site ${siteId}).`);
      }
    }
    if (r?.failures_json) {
      try {
        const list = JSON.parse(r.failures_json as string) as unknown;
        if (Array.isArray(list)) failures = list.filter((f): f is Failure => !!f && typeof f === "object" && typeof f.path === "string" && (f.device === "mobile" || f.device === "desktop") && typeof f.message === "string");
      } catch {
        console.warn(`[vitesse] Échecs enregistrés illisibles, ignorés (site ${siteId}).`);
      }
    }
    return { lastError, failures };
  }

  private writeStatus(siteId: string, lastError: ApiError["error"] | null, failures: Failure[]): void {
    if (!this.store.getSite(siteId)) return;
    this.store.db
      .prepare(
        "INSERT INTO pagespeed_status (site_id, last_error_json, failures_json) VALUES (?, ?, ?) ON CONFLICT(site_id) DO UPDATE SET last_error_json = excluded.last_error_json, failures_json = excluded.failures_json",
      )
      .run(siteId, lastError ? JSON.stringify(lastError) : null, JSON.stringify(failures));
  }

  isRunning(siteId: string): boolean {
    return this.running.has(siteId);
  }

  /** Pages à mesurer : celles demandées (de l'analyse affichée), sinon le choix par défaut du format. */
  targets(site: SiteRow, pageIds: string[] | undefined): Target[] {
    const audit = this.store.resultsAudit(site.id);
    if (!audit) throw errors.noAudit();
    const own = bareHost(site.host);
    const onSite = (r: PageRow) => {
      try {
        const u = new URL(r.url);
        return (u.protocol === "https:" || u.protocol === "http:") && bareHost(u.hostname) === own;
      } catch {
        return false;
      }
    };
    const rows = this.store.pageRows(audit.id);
    const toTarget = (r: PageRow): Target => ({ url: r.url, path: r.path, pageType: pageTypeOf(r) });

    if (pageIds !== undefined) {
      if (!Array.isArray(pageIds) || !pageIds.length || pageIds.some((id) => typeof id !== "string")) {
        throw errors.badRequest("La liste des pages à mesurer est invalide.", "Envoyez { pageIds: [\"pg_…\"] }, ou rien pour le choix par défaut.");
      }
      const unique = [...new Set(pageIds)];
      if (unique.length > MAX_SPEED_PAGES) throw errors.badRequest(`${MAX_SPEED_PAGES} pages au plus par mesure.`, `Choisissez ${MAX_SPEED_PAGES} pages au plus, puis relancez.`);
      const byId = new Map(rows.map((r) => [r.id, r]));
      const out: Target[] = [];
      for (const id of unique) {
        const r = byId.get(id);
        if (!r) throw errors.badRequest("Une des pages demandées ne fait pas partie de l'analyse affichée de ce site.", "Choisissez des pages dans la liste des pages analysées, puis relancez.");
        if (!onSite(r)) throw errors.badRequest("Une des pages demandées n'est pas sur l'adresse de ce site : elle ne peut pas être mesurée.", "Choisissez des pages du site, puis relancez.");
        out.push(toTarget(r));
      }
      return out;
    }

    // Choix par défaut : l'accueil, puis pour chaque type la page qui reçoit le plus de visites (Google Analytics,
    // à défaut clics Search Console), à défaut la première analysée.
    const usable = rows.filter((r) => onSite(r) && r.http_status < 400);
    const analytics = this.store.getAnalytics(site.id);
    const sessions = new Map<string, number>();
    for (const p of analytics?.landingPages ?? []) sessions.set(pathKey(p.path), (sessions.get(pathKey(p.path)) ?? 0) + p.sessions);
    const gsc = this.store.gscIndex(site.id);
    const visits = (r: PageRow) => (analytics ? (sessions.get(pathKey(r.path)) ?? 0) : (gsc?.get(r.url_key)?.clicks ?? 0));
    const chosen: PageRow[] = [];
    const home = usable.find((r) => r.path === "/") ?? null;
    if (home) chosen.push(home);
    for (const type of PAGE_TYPES) {
      if (chosen.length >= MAX_SPEED_PAGES) break;
      const candidates = usable.filter((r) => pageTypeOf(r) === type && !chosen.includes(r));
      if (!candidates.length) continue;
      // Tri stable : à visites égales, l'ordre d'analyse (seq) départage.
      const best = candidates.reduce((a, b) => (visits(b) > visits(a) ? b : a));
      chosen.push(best);
    }
    if (!chosen.length) throw errors.badRequest("Aucune page de l'analyse ne peut être mesurée.", "Relancez une analyse du site, puis réessayez.");
    return chosen.slice(0, MAX_SPEED_PAGES).map(toTarget);
  }

  /** Réserve `pages` pages dans la limite de 30 par heure et par site ; lève rate_limited au-delà. */
  private reserve(siteId: string, pages: number): Reservation {
    const t = this.now();
    const list = (this.reservations.get(siteId) ?? []).filter((x) => t - x.at < HOUR_MS && x.pages > 0);
    this.reservations.set(siteId, list);
    const used = list.reduce((a, x) => a + x.pages, 0);
    const excess = used + pages - SPEED_PAGES_PER_HOUR;
    if (excess > 0) {
      // Attendre que les plus anciennes réservations sortent de la fenêtre et libèrent assez de pages.
      let freed = 0;
      let until = t + HOUR_MS;
      for (const x of [...list].sort((a, b) => a.at - b.at)) {
        freed += x.pages;
        if (freed >= excess) {
          until = x.at + HOUR_MS;
          break;
        }
      }
      const retry = Math.max(1, Math.ceil((until - t) / 1000));
      const minutes = Math.ceil(retry / 60);
      const left = Math.max(0, SPEED_PAGES_PER_HOUR - used);
      const wait = `Patientez ${minutes} minute${minutes > 1 ? "s" : ""}`;
      throw new HttpError(
        429,
        "rate_limited",
        `${SPEED_PAGES_PER_HOUR} pages mesurées par heure au plus pour un site : ${left === 0 ? "la limite est atteinte" : `il en reste ${left} pour le moment, la demande en compte ${pages}`}.`,
        left > 0 ? `${wait}, ou mesurez ${left} page${left > 1 ? "s" : ""} au plus.` : `${wait}, puis relancez.`,
        { retryAfterSeconds: retry },
      );
    }
    const r: Reservation = { at: t, pages };
    list.push(r);
    return r;
  }

  /** Lance une mesure ; répond tout de suite avec l'état (202 côté route). */
  start(site: SiteRow, body: Partial<MeasureSpeedRequest>): PageSpeedState {
    if (!this.configured) throw pagespeedErrors.notConfigured();
    if (this.running.has(site.id)) {
      throw new HttpError(409, "limit_reached", "Une mesure de vitesse est déjà en cours pour ce site.", "Attendez qu'elle se termine ou arrêtez-la, puis relancez.");
    }
    const targets = this.targets(site, body.pageIds);
    const reservation = this.reserve(site.id, targets.length);
    // Nouvelle demande : la dernière erreur bloquante et les échecs de la précédente sont effacés.
    this.writeStatus(site.id, null, []);
    const controller = new AbortController();
    const entry: Running = { done: 0, attempted: 0, total: targets.length, currentUrl: null, controller, promise: Promise.resolve() };
    this.running.set(site.id, entry);
    entry.promise = this.run(site.id, targets, entry).finally(() => {
      // Les pages jamais tentées (arrêt, clé refusée) sont rendues à la limite horaire.
      reservation.pages = entry.attempted;
      if (this.running.get(site.id) === entry) this.running.delete(site.id);
      this.hub.emit(site.id, { type: "pagespeed" });
    });
    this.hub.emit(site.id, { type: "pagespeed" });
    return this.state(site);
  }

  private save(siteId: string, t: Target, strategy: Strategy, m: SpeedMeasure): void {
    if (!this.store.getSite(siteId)) return;
    const col = strategy === "mobile" ? "mobile_json" : "desktop_json";
    this.store.db
      .prepare(
        `INSERT INTO pagespeed_pages (site_id, path_key, url, path, page_type, ${col}, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(site_id, path_key) DO UPDATE SET url = excluded.url, path = excluded.path, page_type = excluded.page_type, ${col} = excluded.${col}, updated_at = excluded.updated_at`,
      )
      .run(siteId, pathKey(t.path), t.url, t.path, t.pageType, JSON.stringify(m), new Date(this.now()).toISOString());
  }

  private async run(siteId: string, targets: Target[], entry: Running): Promise<void> {
    const signal = entry.controller.signal;
    const failures: Failure[] = [];
    outer: for (const t of targets) {
      if (signal.aborted) break;
      entry.attempted++;
      entry.currentUrl = t.url;
      this.hub.emit(siteId, { type: "pagespeed" });
      for (const strategy of ["mobile", "desktop"] as const) {
        if (signal.aborted) break outer;
        try {
          const m = await this.client.measure(t.url, strategy, signal);
          if (signal.aborted) break outer;
          this.save(siteId, t, strategy, m);
        } catch (err) {
          if (signal.aborted) break outer;
          const e = err instanceof HttpError ? err : new PageSpeedError("La mesure de cette page a échoué.", true);
          // Clé refusée, non autorisée, quota épuisé : toute la demande s'arrête.
          if (!(e instanceof PageSpeedError) || e.fatal) {
            this.writeStatus(siteId, e.toErrorObject(), failures);
            break outer;
          }
          failures.push({ path: t.path, device: strategy, message: e.message });
          this.writeStatus(siteId, null, failures);
        }
      }
      entry.done++;
      entry.currentUrl = null;
      this.hub.emit(siteId, { type: "pagespeed" });
    }
    entry.currentUrl = null;
  }

  /** Arrête la mesure en cours ; les pages déjà mesurées sont gardées. */
  async cancel(siteId: string): Promise<void> {
    const r = this.running.get(siteId);
    if (!r) return;
    r.controller.abort();
    await r.promise.catch(() => undefined);
  }

  /** Attend la fin de la mesure en cours (tests, arrêt). */
  async wait(siteId: string): Promise<void> {
    await this.running.get(siteId)?.promise.catch(() => undefined);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.running.keys()].map((id) => this.cancel(id)));
  }
}
