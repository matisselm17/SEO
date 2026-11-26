/**
 * Routes HTTP de docs/format-echange.md. Toutes sous /api ; erreurs au format ApiError ;
 * ETag sur les GET ; deux flux SSE (événements d'un site, réponse de l'assistant).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import type {
  ChatEvent,
  ChatRequest,
  ChatState,
  CompetitorsData,
  CreateSiteRequest,
  HealthResponse,
  IssueResponse,
  PageResponse,
  Settings,
  SiteEvent,
  SiteResponse,
  SitesResponse,
  StartAuditRequest,
  UpdateSettingsRequest,
} from "../../shared/api.ts";
import { chatNotConfigured, runChat, suggestions, type ChatClient } from "./chat/assistant.ts";
import {
  competitorsNotConfigured,
  countryFor,
  pickQueries,
  runCompetitorSurvey,
  type SearchProvider,
} from "./competitors/competitors.ts";
import type { Config } from "./config.ts";
import type { Crawler } from "./crawl/crawler.ts";
import { bareHost, normalizeUrl, parseUserUrl } from "./crawl/url.ts";
import { errors, HttpError, toHttpError } from "./errors.ts";
import type { EventHub } from "./events.ts";
import { importFile, MAX_UPLOAD_BYTES } from "./gsc/import.ts";
import { assertFetchable, FetchError, safeFetch } from "./net/fetch.ts";
import type { PageFacts } from "./analyse/grille.ts";
import type { SiteRow, Store } from "./store.ts";
import { isPageSort, issues, listPages, overview, recommendations } from "./views.ts";

export interface AppDeps {
  config: Config;
  store: Store;
  hub: EventHub;
  crawler: Crawler;
  /** Client de l'API Claude ; null sans clé. */
  chatClient: ChatClient | null;
  /** Fournisseur de recherche pour les concurrents ; null sans clé. */
  searchProvider: SearchProvider | null;
}

export const MAX_PAGES_LIMITS = { min: 1, max: 500 };
const DEFAULT_MAX_PAGES = 100;
const PING_MS = 20_000;

/** Réponse JSON d'un GET avec ETag ; 304 si l'interface a déjà cette version. */
function getJson(c: Context, data: unknown): Response {
  const body = JSON.stringify(data);
  const etag = `W/"${createHash("sha1").update(body).digest("base64url")}"`;
  const inm = c.req.header("if-none-match");
  if (inm && inm.split(",").map((s) => s.trim()).includes(etag)) {
    return new Response(null, { status: 304, headers: { etag, "cache-control": "no-cache" } });
  }
  return new Response(body, { status: 200, headers: { "content-type": "application/json; charset=utf-8", etag, "cache-control": "no-cache" } });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

async function readJson<T>(c: Context, optional = false): Promise<Partial<T>> {
  const raw = await c.req.text();
  if (raw.length > 64 * 1024) throw errors.badRequest("La requête est trop volumineuse.");
  if (!raw.trim()) {
    if (optional) return {};
    throw errors.badRequest("La requête est vide.");
  }
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v as Partial<T>;
  } catch {
    throw errors.badRequest("La requête n'est pas un JSON valide.");
  }
}

export function createApp(deps: AppDeps): Hono {
  const { config, store, hub, crawler } = deps;
  const app = new Hono();

  const settings = (): Settings => ({
    maxPagesDefault: Number(store.getSetting("maxPagesDefault") ?? DEFAULT_MAX_PAGES),
    maxPagesLimits: MAX_PAGES_LIMITS,
    integrations: {
      chat: { configured: !!deps.chatClient, model: deps.chatClient ? config.anthropicModel : null },
      competitors: { configured: !!deps.searchProvider },
    },
    version: config.version,
  });

  const site = (c: Context): SiteRow => {
    const s = store.getSite(c.req.param("siteId") ?? "");
    if (!s) throw errors.siteNotFound();
    return s;
  };

  const maxPagesFrom = (v: unknown): number => {
    if (v === undefined || v === null) return settings().maxPagesDefault;
    if (typeof v !== "number" || !Number.isInteger(v) || v < MAX_PAGES_LIMITS.min || v > MAX_PAGES_LIMITS.max) {
      throw errors.badRequest(
        `Le nombre de pages doit être un entier entre ${MAX_PAGES_LIMITS.min} et ${MAX_PAGES_LIMITS.max}.`,
        "Choisissez une valeur dans cette fourchette.",
      );
    }
    return v;
  };

  const startAudit = (s: SiteRow, maxPages: number) => {
    const audit = store.insertAudit(s.id, maxPages);
    void crawler.start(s, audit);
    hub.emitAudit(s.id, () => {
      const a = store.getAudit(audit.id);
      return a ? { type: "audit", audit: store.auditStatus(a), score: store.auditScore(audit.id) } : null;
    });
    return audit;
  };

  app.onError((err, c) => {
    const e = toHttpError(err);
    if (!(err instanceof HttpError)) console.error(`[api] ${c.req.method} ${new URL(c.req.url).pathname} :`, err instanceof Error ? err.message : "erreur");
    return json(e.toBody(), e.status);
  });

  // ───────── Santé et paramètres

  app.get("/api/health", (c) => getJson(c, { ok: true, version: config.version } satisfies HealthResponse));
  app.get("/api/settings", (c) => getJson(c, settings()));
  app.patch("/api/settings", async (c) => {
    const body = await readJson<UpdateSettingsRequest>(c);
    if (body.maxPagesDefault !== undefined) store.setSetting("maxPagesDefault", String(maxPagesFrom(body.maxPagesDefault)));
    return json(settings());
  });

  // ───────── Sites

  app.get("/api/sites", (c) => getJson(c, { sites: store.listSites().map((s) => store.siteSummary(s)) } satisfies SitesResponse));

  app.post("/api/sites", async (c) => {
    const body = await readJson<CreateSiteRequest>(c);
    const raw = typeof body.url === "string" ? body.url : "";
    if (!raw.trim()) throw errors.invalidUrl("Indiquez l'adresse de votre site.");
    const parsed = parseUserUrl(raw);
    if (!parsed) throw errors.invalidUrl("Cette adresse n'est pas valide.", raw.slice(0, 200));
    try {
      assertFetchable(parsed);
    } catch {
      throw errors.invalidUrl("Cette adresse n'est pas publique : seuls les sites accessibles sur Internet peuvent être analysés.", parsed.href);
    }
    const maxPages = maxPagesFrom(body.maxPages);
    const existing = store.siteByHost(bareHost(parsed.hostname));
    if (existing) throw errors.siteExists(existing.id);

    // Le site doit répondre avant d'être créé.
    let finalUrl: URL;
    const probe = (u: string) => safeFetch(u, { timeoutMs: 15_000, maxBytes: 5 * 1024 * 1024, acceptBody: () => false });
    const typedScheme = /^https?:\/\//i.test(raw.trim());
    try {
      let res;
      try {
        res = await probe(parsed.href);
      } catch (err) {
        // Adresse saisie sans « https:// » : si le HTTPS échoue, on essaie en HTTP.
        if (typedScheme || !(err instanceof FetchError) || err.kind === "blocked" || err.kind === "invalid" || parsed.protocol !== "https:") throw err;
        const httpUrl = new URL(parsed.href);
        httpUrl.protocol = "http:";
        try {
          res = await probe(httpUrl.href);
        } catch {
          throw err;
        }
      }
      if (res.status >= 400) throw errors.unreachable(parsed.href, `il renvoie une erreur ${res.status}.`);
      finalUrl = new URL(res.url);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (err instanceof FetchError && (err.kind === "blocked" || err.kind === "invalid"))
        throw errors.invalidUrl("Cette adresse mène à une adresse non publique et ne peut pas être analysée.", parsed.href);
      const reason =
        err instanceof FetchError
          ? err.kind === "timeout"
            ? "il met trop de temps à répondre."
            : err.message === "Nom de domaine introuvable"
              ? "ce nom de domaine est introuvable."
              : err.message === "Certificat de sécurité invalide"
                ? "son certificat de sécurité est invalide."
                : undefined
          : undefined;
      throw errors.unreachable(parsed.href, reason);
    }
    // Une redirection vers un autre domaine (ex. ancien nom) : on suit le site final.
    const start = normalizeUrl(finalUrl) ?? normalizeUrl(parsed)!;
    const host = bareHost(start.hostname);
    const dup = store.siteByHost(host);
    if (dup) throw errors.siteExists(dup.id);
    let row: SiteRow;
    try {
      row = store.insertSite(start.href, host, null);
    } catch {
      const again = store.siteByHost(host);
      if (again) throw errors.siteExists(again.id);
      throw errors.internal();
    }
    startAudit(row, maxPages);
    return json({ site: store.siteSummary(row) } satisfies SiteResponse, 201);
  });

  app.get("/api/sites/:siteId", (c) => getJson(c, { site: store.siteSummary(site(c)) } satisfies SiteResponse));

  app.delete("/api/sites/:siteId", async (c) => {
    const s = site(c);
    if (crawler.cancel(s.id)) await crawler.wait(s.id);
    hub.forget(s.id);
    store.deleteSite(s.id);
    return new Response(null, { status: 204 });
  });

  // ───────── Analyses

  app.post("/api/sites/:siteId/audits", async (c) => {
    const s = site(c);
    const body = await readJson<StartAuditRequest>(c, true);
    const latest = store.latestAudit(s.id);
    if (crawler.isRunning(s.id) || latest?.state === "running" || latest?.state === "queued") throw errors.auditRunning();
    const audit = startAudit(s, maxPagesFrom(body.maxPages));
    return json({ audit: store.auditStatus(store.getAudit(audit.id)!) }, 202);
  });

  app.post("/api/sites/:siteId/audits/cancel", async (c) => {
    const s = site(c);
    if (crawler.cancel(s.id)) await crawler.wait(s.id);
    const latest = store.latestAudit(s.id);
    if (!latest) throw errors.noAudit();
    return json({ audit: store.auditStatus(latest) });
  });

  app.get("/api/sites/:siteId/events", (c) => {
    const s = site(c);
    return streamSSE(c, async (stream) => {
      let chain: Promise<void> = Promise.resolve();
      const send = (ev: SiteEvent) => {
        chain = chain.then(() => stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) })).catch(() => undefined);
        return chain;
      };
      const current = store.getSite(s.id);
      if (current) await send({ type: "site", site: store.siteSummary(current) });
      const unsubscribe = hub.subscribe(s.id, (ev) => void send(ev));
      const ping = setInterval(() => {
        chain = chain.then(() => stream.write(": ping\n\n")).then(() => undefined).catch(() => undefined);
      }, PING_MS);
      await new Promise<void>((resolve) => {
        stream.onAbort(() => resolve());
        c.req.raw.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      clearInterval(ping);
      unsubscribe();
    });
  });

  // ───────── Résultats

  app.get("/api/sites/:siteId/overview", (c) => getJson(c, overview(store, site(c))));
  app.get("/api/sites/:siteId/issues", (c) => getJson(c, issues(store, site(c))));
  app.get("/api/sites/:siteId/issues/:issueId", (c) => {
    const s = site(c);
    const audit = store.dataAudit(s.id);
    if (!audit) throw errors.noAudit();
    const issue = store.aggregate(audit.id, s.name || s.host).issues.find((i) => i.id === c.req.param("issueId"));
    if (!issue) throw errors.notFound("Ce problème");
    return getJson(c, { issue } satisfies IssueResponse);
  });
  app.get("/api/sites/:siteId/pages", (c) => {
    const s = site(c);
    const sort = c.req.query("sort") ?? "score_asc";
    if (!isPageSort(sort)) throw errors.badRequest("Ce tri n'existe pas.", "Utilisez score_asc, score_desc, issues_desc, clicks_desc ou path_asc.");
    const offset = Math.max(0, Number.parseInt(c.req.query("offset") ?? "0", 10) || 0);
    const limitRaw = Number.parseInt(c.req.query("limit") ?? "50", 10);
    const limit = Math.min(200, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 50));
    return getJson(c, listPages(store, s.id, { sort, q: (c.req.query("q") ?? "").slice(0, 200), offset, limit }));
  });
  app.get("/api/sites/:siteId/pages/:pageId", (c) => {
    const s = site(c);
    const row = store.getPage(c.req.param("pageId"));
    if (!row || row.site_id !== s.id) throw errors.notFound("Cette page");
    return getJson(c, { page: store.pageDetail(row, store.gscIndex(s.id)) } satisfies PageResponse);
  });
  app.get("/api/sites/:siteId/recommendations", (c) => getJson(c, recommendations(store, site(c))));

  // ───────── Search Console

  app.get("/api/sites/:siteId/search-console", (c) => getJson(c, store.searchConsole(site(c).id)));
  app.post("/api/sites/:siteId/search-console", async (c) => {
    const s = site(c);
    const tooLarge = () =>
      new HttpError(413, "file_too_large", "Ce fichier dépasse 20 Mo.", "Exportez une période plus courte, ou déposez seulement le .zip de l'onglet « Performances ».");
    const declared = Number(c.req.header("content-length") ?? "0");
    if (declared > MAX_UPLOAD_BYTES + 1024 * 1024) throw tooLarge();
    if (!(c.req.header("content-type") ?? "").includes("multipart/form-data"))
      throw errors.badRequest("Le fichier doit être envoyé dans un formulaire (champ « file »).");
    let form: FormData;
    try {
      form = await c.req.raw.formData();
    } catch {
      throw errors.badRequest("Le fichier n'a pas pu être lu.", "Réessayez de déposer le fichier.");
    }
    const file = form.get("file");
    if (!file || typeof file === "string") throw errors.badRequest("Aucun fichier reçu.", "Déposez le .zip ou le .csv exporté depuis la Search Console.");
    if (file.size > MAX_UPLOAD_BYTES) throw tooLarge();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const data = importFile(file.name || "export.csv", bytes);
    store.setGsc(s.id, data);
    hub.emit(s.id, { type: "search_console", available: true });
    return json(store.searchConsole(s.id));
  });
  app.delete("/api/sites/:siteId/search-console", (c) => {
    const s = site(c);
    store.deleteGsc(s.id);
    hub.emit(s.id, { type: "search_console", available: false });
    return new Response(null, { status: 204 });
  });

  // ───────── Concurrents

  app.get("/api/sites/:siteId/competitors", (c) => {
    const s = site(c);
    const stored = store.getCompetitors(s.id);
    let data: CompetitorsData;
    if (stored) data = stored;
    else if (!deps.searchProvider) data = { available: false, reason: "not_configured" };
    else if (!store.latestAuditWithPages(s.id)) data = { available: false, reason: "no_audit" };
    else data = { available: false, reason: "not_run" };
    return getJson(c, data);
  });
  app.post("/api/sites/:siteId/competitors", async (c) => {
    const s = site(c);
    if (!deps.searchProvider) throw competitorsNotConfigured();
    const audit = store.latestAuditWithPages(s.id);
    if (!audit) throw errors.noAudit();
    const rows = store.pageRows(audit.id);
    const gsc = store.getGsc(s.id);
    const queries = pickQueries({
      host: s.host,
      siteName: s.name || s.host,
      gscQueries: gsc?.data.queries ?? null,
      pages: rows.map((r) => ({ path: r.path, title: r.title })),
    });
    if (!queries.length)
      throw errors.badRequest(
        "Aucune requête exploitable n'a été trouvée pour rechercher vos concurrents.",
        "Importez votre export Search Console, ou donnez un titre à vos pages principales, puis réessayez.",
      );
    const home = rows.find((r) => r.path === "/") ?? rows[0];
    const lang = home ? (JSON.parse(home.facts_json) as PageFacts).lang : null;
    const data = await runCompetitorSurvey({
      provider: deps.searchProvider,
      queries,
      ownHost: s.host,
      country: countryFor(lang),
      signal: c.req.raw.signal,
    });
    store.setCompetitors(s.id, data);
    return json(data);
  });

  // ───────── Assistant

  app.get("/api/sites/:siteId/chat", (c) => {
    const s = site(c);
    return getJson(c, { available: !!deps.chatClient, messages: store.chatMessages(s.id), suggestions: suggestions(store, s) } satisfies ChatState);
  });
  app.post("/api/sites/:siteId/chat", async (c) => {
    const s = site(c);
    if (!deps.chatClient) throw chatNotConfigured();
    const body = await readJson<ChatRequest>(c);
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) throw errors.badRequest("Votre message est vide.", "Écrivez une question, puis envoyez-la.");
    if (message.length > 4000) throw errors.badRequest("Votre message est trop long (4 000 caractères au plus).", "Raccourcissez-le, puis réessayez.");
    const client = deps.chatClient;
    return streamSSE(c, async (stream) => {
      const controller = new AbortController();
      stream.onAbort(() => controller.abort());
      c.req.raw.signal.addEventListener("abort", () => controller.abort(), { once: true });
      // Les écritures sont enchaînées et attendues avant de fermer le flux, pour que « done » ou « error » arrive toujours.
      let chain: Promise<void> = Promise.resolve();
      const send = (ev: ChatEvent) => {
        chain = chain.then(() => stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) })).catch(() => undefined);
      };
      await runChat({ client, model: config.anthropicModel, store, site: s, message, send, signal: controller.signal });
      await chain;
    });
  });
  app.delete("/api/sites/:siteId/chat", (c) => {
    store.clearChat(site(c).id);
    return new Response(null, { status: 204 });
  });

  // ───────── Routes inconnues et interface compilée

  app.all("/api/*", () => {
    throw errors.notFound("Cette adresse de l'API");
  });

  if (existsSync(config.webDist)) mountStatic(app, config.webDist);
  return app;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/** Sert web/dist ; toute route de l'interface sans fichier renvoie index.html. */
function mountStatic(app: Hono, root: string): void {
  const rootAbs = path.resolve(root);
  app.get("*", (c) => {
    let rel: string;
    try {
      rel = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      rel = "/";
    }
    const file = path.resolve(rootAbs, "." + path.posix.normalize("/" + rel));
    const inside = file === rootAbs || file.startsWith(rootAbs + path.sep);
    let target = path.join(rootAbs, "index.html");
    if (inside && existsSync(file) && statSync(file).isFile()) target = file;
    else if (path.extname(rel)) return c.text("Fichier introuvable", 404);
    if (!existsSync(target)) return c.text("Interface introuvable", 404);
    const ext = path.extname(target).toLowerCase();
    const immutable = target.includes(`${path.sep}assets${path.sep}`);
    return new Response(readFileSync(target), {
      headers: {
        "content-type": MIME[ext] ?? "application/octet-stream",
        "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
        "x-content-type-options": "nosniff",
      },
    });
  });
}
