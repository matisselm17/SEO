/**
 * Vérification d'une correction (docs/format-echange.md, « Boutique Shopify », « Vérification d'une correction »).
 *
 * Après une écriture acceptée par Shopify, la page publique de l'élément est rechargée et notée avec la grille de
 * l'analyse (`analysePage`). Le résultat est ajouté au journal des vérifications (`shopify_verifications`, ajout
 * seul). Rien d'autre n'est écrit : ni les pages ni les analyses, et jamais la boutique (aucun appel à Shopify).
 *
 * - Une seule page chargée à la fois pour tout le serveur, au moins `gapMs` entre deux chargements.
 * - Un seul chargement par relecture : pas de nouvelle tentative immédiate (429, 503…).
 * - La page ne compte que si elle répond 200 en HTML et que son adresse canonique désigne le chemin de l'élément :
 *   une page de contrôle anti-robot, une redirection ou une erreur donnent `inconclusive` / `page_unavailable`.
 * - Le HTML relu est une donnée non fiable : lu par cheerio, jamais exécuté, jamais recopié dans un journal.
 * - File en mémoire, sans doublon par modification, plafonnée : un redémarrage la perd (la correction reste
 *   « applied » et se vérifie à la demande).
 */
import * as cheerio from "cheerio";
import type { CheckStatus, PageCheck } from "../../../shared/api.ts";
import { analysePage } from "../analyse/grille.ts";
import { DEFAULT_CRAWL } from "../crawl/crawler.ts";
import { errors, HttpError } from "../errors.ts";
import type { EventHub } from "../events.ts";
import { decodeHtml, safeFetch, type FetchResult } from "../net/fetch.ts";
import type { SiteRow, Store } from "../store.ts";
import { countVerifications, getChange, insertVerification, isLatestOfField, latestByField, pathKey, productAlias, type ChangeRow, type VerificationRow } from "./repo.ts";
import { scrub } from "./service.ts";

export interface VerifierOptions {
  /** Charge une page publique. Par défaut `safeFetch` (garde des adresses internes), délai et taille du parcours. */
  fetchPage?: (url: string, origin: string) => Promise<FetchResult>;
  now?: () => number;
  /** Programme une relecture différée. Par défaut setTimeout, sans retenir le processus. */
  setTimer?: (fn: () => void, ms: number) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Première relecture automatique après l'écriture. */
  firstDelayMs?: number;
  /** Seconde relecture quand la première ne trouve pas la valeur (`not_displayed`). */
  retryDelayMs?: number;
  /** Espacement minimal entre deux chargements de page. */
  gapMs?: number;
  /** Nombre maximal de relectures en attente. Au-delà, la modification reste « applied ». */
  maxQueue?: number;
  /** Relectures déjà en file au-delà desquelles une demande manuelle est refusée (elle attendrait trop). */
  maxWaiting?: number;
  /** Relectures conservées au plus par modification (le journal ne se purge pas). */
  maxPerChange?: number;
}

const HTML_RE = /text\/html|application\/xhtml\+xml/;

/** Chargement par défaut : garde des adresses internes, même délai et même taille maximale que le parcours. */
export function defaultFetchPage(url: string, origin: string): Promise<FetchResult> {
  return safeFetch(url, {
    timeoutMs: DEFAULT_CRAWL.pageTimeoutMs,
    maxBytes: DEFAULT_CRAWL.maxPageBytes,
    // Une redirection hors du site n'est pas suivie (la page finale n'est alors pas la bonne).
    shouldFollow: (next) => next.origin === origin,
    acceptBody: (status, ct) => status === 200 && HTML_RE.test(ct),
  });
}

const defaultTimer = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
};
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Espaces réduits et normalisation Unicode NFC, des deux côtés de chaque comparaison. */
export const norm = (s: string | null | undefined) => (s ?? "").normalize("NFC").replace(/\s+/g, " ").trim();

/** Texte lu sur la page, sans caractères de contrôle, 300 caractères au plus. */
function clean(s: string | null | undefined): string | null {
  if (s === null || s === undefined) return null;
  // eslint-disable-next-line no-control-regex
  const t = norm(s.replace(/[\u0000-\u001f\u007f-\u009f]/g, " "));
  if (!t) return null;
  return [...t].slice(0, 300).join("");
}

/**
 * Adresse publique de l'élément, sur l'hôte du site. null si le chemin ne commence pas par un seul « / », contient
 * une barre oblique inverse ou un caractère de contrôle, ou fait sortir de l'hôte. Aucun paramètre n'est ajouté.
 */
export function publicUrl(site: Pick<SiteRow, "url" | "host">, path: unknown): string | null {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f\s]/.test(path)) return null;
  let base: URL;
  try {
    base = new URL(site.url);
  } catch {
    return null;
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") return null;
  if (base.hostname.toLowerCase() !== site.host.toLowerCase()) return null;
  let u: URL;
  try {
    u = new URL(path, base.origin);
  } catch {
    return null;
  }
  if (u.origin !== base.origin || u.username || u.password) return null;
  return u.href;
}

const bareHost = (h: string) => h.toLowerCase().replace(/^www\./, "");

/** Dossier et nom de fichier d'une image Shopify (« files/bague »), sans requête, sans suffixe de taille (_800x, _800x600, _x600, @2x) ni extension. */
export function imageStem(raw: string, base?: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim(), base ?? "https://image.invalid/");
  } catch {
    return null;
  }
  const parts = u.pathname.split("/").filter(Boolean);
  let name = parts.pop() ?? "";
  // Le dossier (« files », « products »…) fait partie de l'identité : deux images de même nom ne se confondent pas.
  const dir = (parts.pop() ?? "").toLowerCase();
  try {
    name = decodeURIComponent(name);
  } catch {
    /* nom laissé tel quel */
  }
  name = name.toLowerCase().replace(/\.[a-z0-9]{2,5}$/, "");
  name = name.replace(/_(?:\d+x\d*|x\d+|pico|icon|thumb|small|compact|medium|large|grande|original|master)(?:_crop_[a-z]+)?(?:@\dx)?$/, "");
  name = name.replace(/@\dx$/, "");
  return name ? `${dir}/${name}` : null;
}

/** Adresses d'image d'une balise : src, data-src, srcset (et data-srcset). */
function imageSources(attrs: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  for (const k of ["src", "data-src"]) if (attrs[k]) out.push(attrs[k]!);
  for (const k of ["srcset", "data-srcset"]) {
    const v = attrs[k];
    if (!v) continue;
    for (const part of v.split(/,\s+/)) {
      const url = part.trim().split(/\s+/)[0];
      if (url) out.push(url);
    }
  }
  return out;
}

interface Verdict {
  outcome: VerificationRow["outcome"];
  reason: VerificationRow["reason"];
  message: string;
  url: string | null;
  displayed: boolean | null;
  rendered: string | null;
  criterion: { id: string; before: CheckStatus | null; after: CheckStatus; points: number; max: number; message: string } | null;
  pageScore: { before: number | null; after: number } | null;
}

const unavailable = (message: string, url: string | null): Verdict => ({
  outcome: "inconclusive",
  reason: "page_unavailable",
  message,
  url,
  displayed: null,
  rendered: null,
  criterion: null,
  pageScore: null,
});

const WHAT = { seo_title: "le nouveau titre", seo_description: "la nouvelle description", image_alt: "le nouveau texte alternatif" } as const;
const CRITERION = { seo_title: "title", seo_description: "meta_description", image_alt: "image_alt" } as const;

/** Une relecture en attente : différée (`timer`) ou dans la file des chargements. */
interface Pending {
  siteId: string;
  attempt: 1 | 2;
}

export class CorrectionVerifier {
  private readonly fetchPage: NonNullable<VerifierOptions["fetchPage"]>;
  private readonly now: () => number;
  private readonly setTimer: NonNullable<VerifierOptions["setTimer"]>;
  private readonly sleep: (ms: number) => Promise<void>;
  readonly firstDelayMs: number;
  readonly retryDelayMs: number;
  private readonly gapMs: number;
  private readonly maxQueue: number;
  private readonly maxWaiting: number;
  private readonly maxPerChange: number;
  /** Relectures automatiques en attente (différées ou en file), une par modification. */
  private pending = new Map<string, Pending>();
  /** Relectures (automatiques ou demandées) dans la file ou en cours, par modification. */
  private active = new Map<string, number>();
  private tail: Promise<unknown> = Promise.resolve();
  private lastLoad = -Infinity;

  constructor(
    private store: Store,
    private hub: EventHub,
    opts: VerifierOptions = {},
  ) {
    this.fetchPage = opts.fetchPage ?? defaultFetchPage;
    this.now = opts.now ?? Date.now;
    this.setTimer = opts.setTimer ?? defaultTimer;
    this.sleep = opts.sleep ?? defaultSleep;
    this.firstDelayMs = opts.firstDelayMs ?? 15_000;
    this.retryDelayMs = opts.retryDelayMs ?? 120_000;
    this.gapMs = opts.gapMs ?? 2_000;
    this.maxQueue = opts.maxQueue ?? 200;
    this.maxWaiting = opts.maxWaiting ?? 5;
    this.maxPerChange = opts.maxPerChange ?? 20;
  }

  /** Contrôles d'une demande manuelle, sans rien charger : 404 ou bad_request si la modification n'est pas vérifiable. */
  assertVerifiable(site: SiteRow, changeId: string): void {
    this.eligible(site, changeId, true);
    // Une demande ne reste jamais suspendue derrière une longue file (lot en cours de vérification).
    let waiting = 0;
    for (const n of this.active.values()) waiting += n;
    if (waiting > this.maxWaiting) {
      throw new HttpError(429, "rate_limited", "D'autres vérifications sont déjà en cours.", "Elles se terminent d'elles-mêmes : réessayez dans quelques minutes si besoin.");
    }
    if (countVerifications(this.store.db, changeId) + (this.active.get(changeId) ?? 0) >= this.maxPerChange) {
      throw errors.badRequest("Cette correction a déjà été vérifiée de nombreuses fois.", "Consultez le dernier résultat affiché.");
    }
  }

  /** Une relecture de cette modification est-elle en attente ou en cours ? */
  isVerifying(changeId: string): boolean {
    return this.pending.has(changeId) || (this.active.get(changeId) ?? 0) > 0;
  }

  /** Une relecture est-elle programmée, en file ou en cours ? */
  busy(): boolean {
    return this.pending.size > 0 || this.active.size > 0;
  }

  /** Attend que la file soit vide (tests). */
  async idle(): Promise<void> {
    for (;;) {
      const t = this.tail;
      await t;
      if (t === this.tail) return;
    }
  }

  /**
   * Programme la relecture automatique d'une modification qui vient d'être écrite. Sans doublon ; false si la file
   * est pleine (la modification reste alors « applied »). Ne lève jamais.
   */
  schedule(siteId: string, changeId: string, attempt: 1 | 2 = 1): boolean {
    if (attempt === 1 && this.pending.has(changeId)) return false;
    if (attempt === 1 && this.pending.size >= this.maxQueue) return false;
    this.pending.set(changeId, { siteId, attempt });
    const c = getChange(this.store.db, changeId);
    // Traduction : rien à charger, la relecture conclut tout de suite (not_supported).
    const delay = c?.locale ? 0 : attempt === 1 ? this.firstDelayMs : this.retryDelayMs;
    this.setTimer(() => {
      let again = false;
      void this.enqueue(
        changeId,
        async () => {
          again = await this.runAuto(siteId, changeId, attempt);
        },
        () => {
          // Après la relecture : la modification sort de la file (ou y revient pour la seconde), puis l'événement.
          if (this.pending.get(changeId)?.attempt === attempt) this.pending.delete(changeId);
          if (again) this.schedule(siteId, changeId, 2);
          this.emit(siteId);
        },
      ).catch(() => undefined);
    }, delay);
    return true;
  }

  /**
   * Relecture demandée : refuse (404, bad_request) une modification introuvable ou non vérifiable, sinon relit tout
   * de suite (toujours une page à la fois) et renvoie la relecture enregistrée.
   */
  async verifyNow(site: SiteRow, changeId: string): Promise<VerificationRow> {
    this.assertVerifiable(site, changeId);
    return this.enqueue(
      changeId,
      async () => {
        // L'état a pu changer pendant l'attente (annulation, nouvelle modification).
        const c = this.eligible(site, changeId, true)!;
        const v = await this.record(site, c);
        if (!v && !this.store.getSite(site.id)) throw errors.siteNotFound();
        if (!v) throw errors.badRequest("Cette modification a changé pendant la vérification : le résultat n'a pas été retenu.", "Rechargez l'historique.");
        return v;
      },
      () => this.emit(site.id),
    );
  }

  /** File unique des relectures. `after` s'exécute une fois la relecture sortie de la file (statut à jour). */
  private enqueue<T>(changeId: string, fn: () => Promise<T>, after: () => void): Promise<T> {
    this.active.set(changeId, (this.active.get(changeId) ?? 0) + 1);
    const run = async () => {
      try {
        return await fn();
      } finally {
        const n = (this.active.get(changeId) ?? 1) - 1;
        if (n > 0) this.active.set(changeId, n);
        else this.active.delete(changeId);
        try {
          after();
        } catch {
          /* sans effet sur la relecture enregistrée */
        }
      }
    };
    const p = this.tail.then(run, run);
    this.tail = p.catch(() => undefined);
    return p;
  }

  /** Relecture automatique ; true si une seconde relecture doit suivre (valeur pas encore affichée). */
  private async runAuto(siteId: string, changeId: string, attempt: 1 | 2): Promise<boolean> {
    try {
      const site = this.store.getSite(siteId);
      const c = site ? this.eligible(site, changeId, false) : null;
      if (!site || !c) return false;
      const v = await this.record(site, c);
      return attempt === 1 && v?.reason === "not_displayed";
    } catch (err) {
      console.error("[vérification] relecture interrompue :", err instanceof Error ? scrub(err.message).slice(0, 200) : "erreur");
      return false;
    }
  }

  /**
   * La modification peut-elle être relue ? Elle doit exister pour ce site, être appliquée, de type « edit », non
   * annulée, et la dernière de son champ. `strict` : lève l'erreur affichable ; sinon renvoie null.
   */
  private eligible(site: SiteRow, changeId: string, strict: boolean): ChangeRow | null {
    const c = getChange(this.store.db, changeId);
    if (!c || c.site_host !== site.host || c.status === "failed") {
      if (strict) throw errors.notFound("Cette modification");
      return null;
    }
    let why: string | null = null;
    if (c.kind !== "edit") why = "Une annulation n'est pas une correction : il n'y a rien à vérifier.";
    else if (c.restored_by_change_id) why = "Cette modification a été annulée : il n'y a plus rien à vérifier.";
    else if (c.status !== "applied") why = "Cette modification n'est pas encore confirmée par Shopify : elle ne peut pas être vérifiée.";
    else if (!isLatestOfField(c, latestByField(this.store.db, site.host, c.resource_id))) why = "Une modification plus récente de ce champ l'a remplacée : seule la dernière se vérifie.";
    if (why) {
      if (strict) throw errors.badRequest(why, why.includes("plus récente") ? "Vérifiez la modification la plus récente de ce champ." : null);
      return null;
    }
    return c;
  }

  /** Relit la page et enregistre le résultat (ajout seul). L'événement « shopify » suit, une fois la file à jour. */
  private async record(site: SiteRow, c: ChangeRow): Promise<VerificationRow | null> {
    const v = await this.check(site, c);
    // Annulée ou remplacée pendant le chargement : la page relue ne parle plus de cette modification.
    if (!this.store.getSite(site.id) || !this.eligible(site, c.id, false)) return null;
    const row = insertVerification(this.store.db, {
      change_id: c.id,
      site_host: site.host,
      checked_at: new Date(this.now()).toISOString(),
      outcome: v.outcome,
      reason: v.reason,
      message: scrub(v.message),
      url: v.url,
      displayed: v.displayed === null ? null : v.displayed ? 1 : 0,
      rendered: v.rendered === null ? null : scrub(v.rendered),
      criterion_id: v.criterion?.id ?? null,
      criterion_before: v.criterion?.before ?? null,
      criterion_after: v.criterion?.after ?? null,
      criterion_points: v.criterion?.points ?? null,
      criterion_max: v.criterion?.max ?? null,
      criterion_message: v.criterion ? scrub(v.criterion.message) : null,
      page_score_before: v.pageScore?.before ?? null,
      page_score_after: v.pageScore?.after ?? null,
    });
    return row;
  }

  private emit(siteId: string): void {
    try {
      this.hub.emit(siteId, { type: "shopify" });
    } catch {
      /* un abonné défaillant n'empêche pas la relecture */
    }
  }

  private async load(url: string, origin: string): Promise<FetchResult> {
    const wait = this.lastLoad + this.gapMs - this.now();
    if (wait > 0) await this.sleep(wait);
    try {
      return await this.fetchPage(url, origin);
    } finally {
      this.lastLoad = this.now();
    }
  }

  /** Page de même chemin dans l'analyse affichée (avec la variante produit vu depuis une collection). */
  private shownPage(siteId: string, key: string): { score: number; checks: PageCheck[] } | null {
    const audit = this.store.resultsAudit(siteId);
    if (!audit) return null;
    const records = this.store.records(audit.id);
    const direct = records.find((r) => pathKey(r.path) === key);
    if (direct) return direct;
    return records.find((r) => productAlias(pathKey(r.path)) === key) ?? null;
  }

  private async check(site: SiteRow, c: ChangeRow): Promise<Verdict> {
    if (c.locale) {
      return {
        ...unavailable("Les traductions ne se vérifient pas encore : seule la page dans la langue principale est relue.", null),
        reason: "not_supported",
      };
    }
    const url = publicUrl(site, c.path);
    if (!url) return unavailable("L'adresse publique de cette page n'a pas pu être déterminée : elle n'a pas été relue.", null);
    const origin = new URL(url).origin;

    let res: FetchResult;
    try {
      res = await this.load(url, origin);
    } catch {
      return unavailable("La page publique n'a pas pu être chargée (site injoignable, trop lent ou trop lourd). Réessayez la vérification plus tard.", url);
    }
    if (res.status === 429 || res.status === 503) {
      return unavailable("La boutique demande de patienter : trop de demandes en peu de temps. Réessayez la vérification dans quelques minutes.", url);
    }
    if (res.status >= 300 && res.status < 400) {
      return unavailable("La page publique renvoie vers une autre adresse : elle n'a pas été relue. Réessayez la vérification plus tard.", url);
    }
    if (res.status !== 200) return unavailable(`La page publique a répondu avec une erreur (code ${res.status}). Réessayez la vérification plus tard.`, url);
    let finalOrigin: string | null = null;
    try {
      finalOrigin = new URL(res.url).origin;
    } catch {
      /* adresse finale illisible */
    }
    if (finalOrigin !== origin || !HTML_RE.test(res.contentType) || !res.body.length) {
      return unavailable("La page chargée n'est pas celle de cet élément (redirection ou contenu inattendu). Réessayez la vérification plus tard.", url);
    }
    const html = decodeHtml(res.body, res.contentType);
    const analysis = analysePage(html, res.url);
    const key = pathKey(c.path);
    let canonical: URL | null = null;
    try {
      canonical = analysis.facts.canonical ? new URL(analysis.facts.canonical, res.url) : null;
    } catch {
      canonical = null;
    }
    if (!canonical || bareHost(canonical.hostname) !== bareHost(site.host) || pathKey(canonical.pathname) !== key) {
      return unavailable(
        "La page chargée n'est pas celle de cet élément : la boutique a peut-être affiché une page de contrôle ou une redirection. Réessayez la vérification plus tard.",
        url,
      );
    }

    const shown = this.shownPage(site.id, key);
    const critId = CRITERION[c.field];
    const after = analysis.checks.find((x) => x.id === critId);
    const before = shown?.checks.find((x) => x.id === critId);
    const criterion = after
      ? { id: critId, before: (before?.status as CheckStatus | undefined) ?? null, after: after.status, points: after.points, max: after.max, message: after.message }
      : null;
    const pageScore = { before: shown?.score ?? null, after: analysis.score };
    const base = { url, criterion, pageScore };
    const what = WHAT[c.field];
    const label = after?.label ?? "";
    const value = c.after_value;

    if (c.field === "image_alt") {
      const target = c.image_url ? imageStem(c.image_url) : null;
      const $ = cheerio.load(html);
      const matched: Array<string | null> = [];
      $("img").each((_, el) => {
        const attrs = (el as { attribs?: Record<string, string> }).attribs ?? {};
        if (target && imageSources(attrs).some((s) => imageStem(s, res.url) === target)) matched.push(attrs.alt ?? null);
      });
      if (!matched.length) {
        return {
          ...base,
          outcome: "inconclusive",
          reason: "image_not_found",
          message: "L'image modifiée n'a pas été retrouvée sur la page publique : le thème l'affiche peut-être autrement, ou ailleurs.",
          displayed: null,
          rendered: null,
        };
      }
      const want = norm(value);
      const hit = matched.find((a) => norm(a) === want);
      const displayed = value === null ? null : hit !== undefined;
      const ok = value === null ? hit !== undefined : displayed === true;
      const rendered = clean(hit ?? matched.find((a) => norm(a)) ?? null);
      return ok
        ? { ...base, outcome: "verified", reason: "ok", message: value === null ? "L'image n'a plus de texte alternatif sur la page publique, comme demandé." : "L'image affiche bien le nouveau texte alternatif sur la page publique.", displayed, rendered }
        : { ...base, outcome: "failed", reason: "not_displayed", message: `La page publique n'affiche pas encore ${what}. La boutique peut mettre quelques minutes à se mettre à jour.`, displayed, rendered };
    }

    const renderedRaw = c.field === "seo_title" ? analysis.facts.title : analysis.facts.description;
    const rendered = clean(renderedRaw);
    const shown_ = norm(renderedRaw);
    const isTitle = c.field === "seo_title";
    const shows = (x: string) => (isTitle ? shown_.includes(norm(x)) : shown_ === norm(x));
    // Ce que la page affichait avant l'écriture : l'ancienne valeur, ou pour un titre vide le nom de l'élément.
    const old = c.before_value ?? (isTitle ? c.resource_title : null);
    // « Encore affichée » : à la place où la valeur est attendue. Pour un titre, au début (un mot retrouvé ailleurs,
    // par exemple dans le nom de la boutique ajouté par le thème, ne prouve rien) ; pour une description, à l'identique.
    const stillShows = (x: string) => (isTitle ? shown_.startsWith(norm(x)) : shown_ === norm(x));
    let stale = false;
    if (old && norm(old)) {
      if (value !== null) {
        // L'ancienne valeur est encore là, et la nouvelle n'explique pas sa présence : la page n'est pas à jour.
        stale = norm(old) !== norm(value) && stillShows(old) && !norm(value).includes(norm(old));
      } else if (c.before_value) {
        // Champ vidé : tant que l'ancienne valeur est affichée, rien ne prouve que la page a changé. Si le nom de
        // l'élément, qui la remplace, commence lui-même par elle, c'est le nom complet qui doit apparaître.
        const name = norm(c.resource_title);
        stale = stillShows(c.before_value) && !(isTitle && name.startsWith(norm(c.before_value)) && shown_.startsWith(name));
      }
    }
    const displayed = value === null ? null : shows(value) && !stale;
    if (value === null && stale) {
      // Champ vidé et ancienne valeur toujours là : Shopify peut aussi l'afficher de lui-même à la place du champ
      // (début du texte de l'élément). Sans preuve dans un sens ni dans l'autre, la correction reste « appliquée ».
      return {
        ...base,
        outcome: "inconclusive",
        reason: "not_displayed",
        message: "La page publique affiche encore l'ancienne valeur. La boutique peut mettre quelques minutes à se mettre à jour, ou afficher d'elle-même ce texte à la place du champ vidé.",
        displayed,
        rendered,
      };
    }
    if (displayed === false) {
      return {
        ...base,
        outcome: "failed",
        reason: "not_displayed",
        message: `La page publique n'affiche pas encore ${what}. La boutique peut mettre quelques minutes à se mettre à jour, ou le thème n'utilise pas ce champ.`,
        displayed,
        rendered,
      };
    }
    if (criterion?.after === "pass") {
      const message = value === null ? `Le champ a été vidé et le critère « ${label} » est validé sur la page publique.` : `La page affiche ${what} et le critère « ${label} » est validé.`;
      return { ...base, outcome: "verified", reason: "ok", message, displayed, rendered };
    }
    const detail = after ? ` : ${lowerFirst(after.message)}` : "";
    const message =
      value === null ? `Le champ a été vidé, mais le critère « ${label} » n'est pas validé sur la page publique${detail}` : `La page affiche bien ${what}, mais le critère « ${label} » n'est pas encore validé${detail}`;
    return { ...base, outcome: "failed", reason: "criterion_failing", message, displayed, rendered };
  }
}

const lowerFirst = (s: string) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
