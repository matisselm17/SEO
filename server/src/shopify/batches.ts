/**
 * Lots de corrections (docs/format-echange.md, « Lots de corrections » et « Automatisation »).
 *
 * Un lot ne contourne aucun garde-fou : chaque ligne est écrite par `ShopifyService.applyLine`, le même chemin
 * qu'une modification isolée (SHOPIFY_WRITES_ENABLED, journal avant écriture, relecture, conflit par rapport à la
 * valeur `before` de la ligne). Les lignes partent une par une, en tâche de fond, au rythme de la limite de
 * 30 écritures par minute (cadence partagée avec les modifications isolées).
 * Un seul lot en écriture ou en annulation par site : la place est réservée de façon synchrone (marqueur en mémoire
 * ET passage conditionnel en base) avant tout appel à Shopify ; une ligne déjà écrite ou annulée ne change plus d'état.
 * Un lot en cours s'arrête à la demande (`stop`) après sa ligne en cours. Un arrêt du serveur laisse le lot en
 * « partial » ; il ne reprend jamais tout seul.
 * Les lots et leurs lignes ne sont jamais supprimés (déclencheurs en base).
 */
import type {
  ApiError,
  CreateBatchRequest,
  ProposalOrigin,
  ShopifyBatch,
  ShopifyBatchItem,
  ShopifyBatchSummary,
  ShopifyField,
  ShopifyResourceType,
  UpdateBatchItemRequest,
} from "../../../shared/api.ts";
import { addUsage, autoEnabled, autoGate, automationErrors, getPolicy, getUsage, ruleViolation, type AutoDecision } from "../automation/policy.ts";
import { newId, tx, type DB, type Row } from "../db.ts";
import { errors, HttpError } from "../errors.ts";
import type { EventHub } from "../events.ts";
import type { SiteRow, Store } from "../store.ts";
import { getChange } from "./repo.ts";
import type { LiveResource } from "./read.ts";
import { fromShopify, normalizeValue, sameValue, scrub, shopifyErrors, type LineRequest, type PreparedLine, type ShopifyService } from "./service.ts";

export const MAX_BATCH_ITEMS = 50;
const FIELDS: ShopifyField[] = ["seo_title", "seo_description", "image_alt"];

export const INTERRUPTED_BATCH: ApiError["error"] = {
  code: "internal",
  message: "Le serveur s'est arrêté pendant l'écriture du lot. Les lignes déjà écrites sont dans l'historique ; les autres n'ont pas été écrites.",
  action: "Relisez le lot, puis relancez l'écriture des lignes restantes si vous le souhaitez.",
};
/** Arrêt demandé par l'utilisateur (`stop`). */
export const STOPPED_BATCH: ApiError["error"] = {
  code: "internal",
  message: "L'écriture a été arrêtée à votre demande. Les lignes déjà écrites sont dans l'historique ; les autres n'ont pas été écrites.",
  action: "Relancez l'écriture des lignes restantes quand vous le souhaitez.",
};
const INTERRUPTED_PREP: ApiError["error"] = {
  code: "internal",
  message: "Le serveur s'est arrêté pendant la préparation des propositions.",
  action: "Relancez la préparation.",
};

export const batchErrors = {
  notEditable: () => new HttpError(409, "batch_not_editable", "Ce lot n'est plus un brouillon : il ne peut plus être modifié.", "Créez un nouveau lot si vous voulez proposer d'autres valeurs."),
  busy: () => new HttpError(409, "limit_reached", "Un lot est déjà en cours d'écriture ou d'annulation sur ce site.", "Attendez la fin de l'opération en cours (ou arrêtez-la), puis réessayez."),
  notRunning: () => new HttpError(409, "batch_not_editable", "Ce lot n'est pas en cours d'écriture ni d'annulation : il n'y a rien à arrêter.", null),
};

/** Lignes d'un lot automatique retenues par le filtre de contenu : le lot revient en brouillon. */
const heldForReview = (n: number) =>
  new HttpError(
    403,
    "automation_not_allowed",
    `${n} proposition${n > 1 ? "s n'ont" : " n'a"} pas été écrite${n > 1 ? "s" : ""} automatiquement (adresse web, coordonnées ou texte sans rapport avec l'élément) : ${n > 1 ? "elles attendent" : "elle attend"} votre validation.`,
    "Relisez les lignes signalées dans le lot, corrigez-les ou écartez-les, puis validez le lot.",
  ).toErrorObject();

// ───────── Stockage

interface BatchRow {
  id: string;
  site_host: string;
  title: string;
  origin: ProposalOrigin;
  created_at: string;
  state: ShopifyBatchSummary["state"];
  auto_applied: number;
  error_json: string | null;
  finished_at: string | null;
}

export interface ItemRow {
  id: string;
  batch_id: string;
  seq: number;
  resource_id: string;
  resource_gid: string;
  resource_type: ShopifyResourceType;
  resource_title: string;
  path: string;
  field: ShopifyField;
  image_id: string | null;
  image_url: string | null;
  locale: string | null;
  before_value: string | null;
  proposed: string;
  note: string | null;
  selected: number;
  state: ShopifyBatchItem["state"];
  change_id: string | null;
  error: string | null;
  auto_applied: number;
}

const getBatch = (db: DB, id: string) => (db.prepare("SELECT * FROM shopify_batches WHERE id = ?").get(id) as unknown as BatchRow) ?? null;
const itemsOf = (db: DB, batchId: string) => db.prepare("SELECT * FROM shopify_batch_items WHERE batch_id = ? ORDER BY seq").all(batchId) as unknown as ItemRow[];
const setBatch = (db: DB, id: string, patch: Partial<Pick<BatchRow, "state" | "auto_applied" | "error_json" | "finished_at" | "title">>) => {
  const keys = Object.keys(patch) as Array<keyof typeof patch>;
  if (!keys.length) return;
  db.prepare(`UPDATE shopify_batches SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((k) => (patch[k] ?? null) as string | number | null), id);
};
type ItemPatch = Partial<Pick<ItemRow, "state" | "change_id" | "error" | "proposed" | "selected" | "auto_applied">>;
/** Met à jour une ligne ; avec `from`, seulement si elle est encore dans l'un de ces états (renvoie false sinon). */
const setItem = (db: DB, id: string, patch: ItemPatch, from?: Array<ItemRow["state"]>): boolean => {
  const keys = Object.keys(patch) as Array<keyof typeof patch>;
  if (!keys.length) return false;
  const cond = from ? ` AND state IN (${from.map(() => "?").join(", ")})` : "";
  const res = db.prepare(`UPDATE shopify_batch_items SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?${cond}`).run(...keys.map((k) => (patch[k] ?? null) as string | number | null), id, ...(from ?? []));
  return Number(res.changes) === 1;
};
const getItem = (db: DB, id: string) => (db.prepare("SELECT * FROM shopify_batch_items WHERE id = ?").get(id) as unknown as ItemRow) ?? null;

/** Écriture ou annulation en cours (ou réservée) sur un site. */
interface Run {
  batchId: string;
  mode: "apply" | "restore";
  abort: AbortController;
  /** Résolue quand la boucle est finie (ou la réservation libérée). */
  done: Promise<void>;
  resolve: () => void;
  /** État du lot avant la réservation : rétabli si l'écriture ne démarre pas. */
  prev: Pick<BatchRow, "state" | "finished_at" | "error_json">;
}

/**
 * Au démarrage : un lot resté « applying » passe « partial » (jamais de reprise automatique) ; un lot resté
 * « preparing » passe « draft » s'il a déjà des lignes, « failed » sinon. Renvoie le nombre de lots touchés.
 */
export function recoverInterruptedBatches(db: DB, at = new Date().toISOString()): number {
  let n = 0;
  tx(db, () => {
    n += Number(db.prepare("UPDATE shopify_batches SET state = 'partial', finished_at = ?, error_json = ? WHERE state = 'applying'").run(at, JSON.stringify(INTERRUPTED_BATCH)).changes);
    for (const b of db.prepare("SELECT id FROM shopify_batches WHERE state = 'preparing'").all() as Array<{ id: string }>) {
      const count = (db.prepare("SELECT COUNT(*) AS n FROM shopify_batch_items WHERE batch_id = ?").get(b.id) as Row).n as number;
      setBatch(db, b.id, count ? { state: "draft", error_json: JSON.stringify(INTERRUPTED_PREP) } : { state: "failed", finished_at: at, error_json: JSON.stringify(INTERRUPTED_PREP) });
      n++;
    }
  });
  return n;
}

/** Une proposition de l'IA (assistant ou optimisation), avant tout contrôle. */
export interface Proposal extends LineRequest {
  note: string | null;
}

export interface Refusal {
  index: number;
  code: string;
  message: string;
}

export interface BatchServiceOptions {
  /** SHOPIFY_AUTO_APPLY=1 : le deuxième verrou. */
  autoAllowed: boolean;
  now?: () => number;
  /** Attente entre deux écritures quand la cadence est atteinte (les tests la remplacent). */
  sleep?: (ms: number) => Promise<void>;
}

export class BatchService {
  readonly autoAllowed: boolean;
  private readonly now: () => number;
  private readonly sleep?: (ms: number) => Promise<void>;
  /** Écriture (ou annulation) en cours ou réservée, par site. */
  private running = new Map<string, Run>();

  constructor(
    private store: Store,
    private hub: EventHub,
    private shopify: ShopifyService,
    opts: BatchServiceOptions,
  ) {
    this.autoAllowed = opts.autoAllowed === true;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep;
  }

  private get db(): DB {
    return this.store.db;
  }
  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  // ───── Vues

  private itemView(r: ItemRow): ShopifyBatchItem {
    let state = r.state;
    // Une ligne écrite puis annulée depuis l'historique (seule) est montrée annulée.
    if (state === "applied" && r.change_id && getChange(this.db, r.change_id)?.restored_by_change_id) state = "restored";
    return {
      id: r.id,
      resourceId: r.resource_id,
      resourceType: r.resource_type,
      resourceTitle: r.resource_title,
      path: r.path,
      field: r.field,
      image: r.image_id && r.image_url ? { id: r.image_id, url: r.image_url } : null,
      locale: r.locale,
      before: r.before_value,
      proposed: r.proposed,
      note: r.note,
      selected: r.selected === 1,
      state,
      changeId: r.change_id,
      error: r.error,
      autoApplied: r.auto_applied === 1,
    };
  }

  private view(b: BatchRow): ShopifyBatch {
    const items = itemsOf(this.db, b.id).map((r) => this.itemView(r));
    const counts = { total: items.length, selected: 0, applied: 0, conflict: 0, failed: 0, restored: 0 };
    for (const i of items) {
      if (i.selected) counts.selected++;
      if (i.state === "applied") counts.applied++;
      else if (i.state === "conflict") counts.conflict++;
      else if (i.state === "failed") counts.failed++;
      else if (i.state === "restored") counts.restored++;
    }
    let state = b.state;
    if ((state === "applied" || state === "partial") && counts.applied === 0 && counts.restored > 0 && !items.some((i) => i.state === "pending" && i.selected)) state = "restored";
    return {
      id: b.id,
      title: b.title,
      origin: b.origin,
      createdAt: b.created_at,
      state,
      // Au moins une ligne écrite sans validation humaine (un lot automatique validé ensuite à la main n'est pas
      // « automatique » pour ses autres lignes).
      autoApplied: items.some((i) => i.autoApplied),
      counts,
      error: b.error_json ? (JSON.parse(b.error_json) as ApiError["error"]) : null,
      finishedAt: b.finished_at,
      items,
    };
  }

  list(site: SiteRow): ShopifyBatchSummary[] {
    const rows = this.db.prepare("SELECT * FROM shopify_batches WHERE site_host = ? ORDER BY rowid DESC").all(site.host) as unknown as BatchRow[];
    return rows.map((b) => {
      const { items: _items, ...summary } = this.view(b);
      return summary;
    });
  }

  get(site: SiteRow, id: string): ShopifyBatch {
    return this.view(this.row(site, id));
  }

  private row(site: SiteRow, id: string): BatchRow {
    const b = typeof id === "string" ? getBatch(this.db, id) : null;
    if (!b || b.site_host !== site.host) throw errors.notFound("Ce lot de corrections");
    return b;
  }

  /** Attend la fin de l'écriture en cours sur ce site (tests, arrêt du serveur). */
  async wait(siteId: string): Promise<void> {
    await this.running.get(siteId)?.done;
  }

  /** Arrêt du serveur : chaque écriture en cours s'arrête après sa ligne en cours ; le lot passe « partial ». */
  stopAll(): Promise<void> {
    const runs = [...this.running.values()];
    for (const r of runs) r.abort.abort("shutdown");
    return Promise.all(runs.map((r) => r.done)).then(() => undefined);
  }

  /**
   * Arrêt demandé par l'utilisateur : l'écriture (ou l'annulation, ou l'écriture automatique) s'arrête après la
   * ligne en cours ; le lot passe « partial », les lignes restantes restent « pending ». Attend la fin de la ligne
   * en cours (15 s au plus) avant de répondre.
   */
  async stop(site: SiteRow, batchId: string): Promise<ShopifyBatch> {
    const b = this.row(site, batchId);
    const run = this.running.get(site.id);
    if (!run || run.batchId !== b.id) throw batchErrors.notRunning();
    run.abort.abort("stop");
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([run.done, new Promise<void>((r) => (timer = setTimeout(r, 15_000)))]);
    clearTimeout(timer);
    return this.get(site, b.id);
  }

  // ───── Création

  private insert(site: SiteRow, title: string, origin: ProposalOrigin, state: BatchRow["state"]): BatchRow {
    const id = newId("lot");
    this.db.prepare("INSERT INTO shopify_batches (id, site_host, title, origin, created_at, state, auto_applied) VALUES (?, ?, ?, ?, ?, ?, 0)").run(id, site.host, title, origin, this.iso(), state);
    return getBatch(this.db, id)!;
  }

  private insertItem(batchId: string, seq: number, p: PreparedLine, note: string | null): void {
    this.db
      .prepare(
        `INSERT INTO shopify_batch_items (id, batch_id, seq, resource_id, resource_gid, resource_type, resource_title, path, field, image_id, image_url, locale, before_value, proposed, note, selected, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'pending')`,
      )
      .run(newId("lig"), batchId, seq, p.resourceId, p.gid, p.type, p.title, p.path, p.field, p.imageId, p.imageUrl, p.locale, p.before, p.proposed, note);
  }

  private async guard(site: SiteRow): Promise<void> {
    this.shopify.assertConfigured();
    await this.shopify.connectedInfo(site);
    if (!this.shopify.isSynced(site.id)) throw shopifyErrors.notSynced();
  }

  /** Garde des routes de lots (lecture comme écriture) : boutique configurée, celle du site, déjà lue. */
  async assertReady(site: SiteRow): Promise<void> {
    await this.guard(site);
  }

  /**
   * Lot composé par l'utilisateur : chaque ligne est préparée (valeur actuelle relue, champ modifiable, valeur
   * validée) ; la première ligne invalide refuse toute la demande et le dit. N'écrit rien dans la boutique.
   */
  async createManual(site: SiteRow, body: Partial<CreateBatchRequest>): Promise<ShopifyBatch> {
    await this.guard(site);
    const items = Array.isArray(body.items) ? body.items : null;
    if (!items || !items.length) throw errors.badRequest("Le lot ne contient aucune ligne.", "Ajoutez au moins une correction.");
    if (items.length > MAX_BATCH_ITEMS) throw errors.badRequest(`Un lot compte au plus ${MAX_BATCH_ITEMS} lignes (${items.length} reçues).`, "Répartissez ces corrections sur plusieurs lots.");
    let title = typeof body.title === "string" ? body.title.replace(/\s+/g, " ").trim().slice(0, 120) : "";
    if (/[<>]/.test(title)) throw errors.badRequest("Le titre du lot contient « < » ou « > ».", null);
    const prepared: PreparedLine[] = [];
    const cache = new Map<string, LiveResource>();
    for (const [i, raw] of items.entries()) {
      const it = (raw && typeof raw === "object" ? raw : {}) as Partial<CreateBatchRequest["items"][number]>;
      try {
        if (typeof it.value !== "string") throw errors.badRequest("La valeur proposée doit être un texte.", null);
        if (!FIELDS.includes(it.field as ShopifyField)) throw errors.badRequest("Ce champ ne peut pas être modifié.", "Champs possibles : seo_title, seo_description, image_alt.");
        const p = await this.shopify.prepareLine(site, { resourceId: String(it.resourceId ?? ""), field: it.field as ShopifyField, imageId: it.imageId ?? null, locale: it.locale ?? null, value: it.value }, cache);
        if (prepared.some((q) => sameTarget(q, p))) throw errors.badRequest("Deux lignes visent le même champ.", "Gardez une seule ligne par champ.");
        prepared.push(p);
      } catch (err) {
        throw lineError(err, i, it.resourceId);
      }
    }
    if (!title) title = `Lot de ${prepared.length} correction${prepared.length > 1 ? "s" : ""}`;
    const b = this.insert(site, title, "manual", "draft");
    tx(this.db, () => prepared.forEach((p, i) => this.insertItem(b.id, i + 1, p, null)));
    this.hub.emit(site.id, { type: "shopify" });
    return this.get(site, b.id);
  }

  /** Lot vide en préparation (optimisation par l'IA). */
  startPreparing(site: SiteRow, title: string): ShopifyBatch {
    const b = this.insert(site, title, "automation", "preparing");
    this.hub.emit(site.id, { type: "shopify" });
    return this.get(site, b.id);
  }

  /**
   * Ajoute à un lot des propositions de l'IA, chacune contrôlée par le serveur : champ modifiable et valeur
   * validés comme une saisie humaine, puis la règle d'automatisation (`ruleViolation`) et le plafond de lignes.
   * Une proposition refusée n'entre pas dans le lot (elle n'est jamais corrigée en silence).
   */
  async addProposals(site: SiteRow, batchId: string | null, origin: ProposalOrigin, proposals: Proposal[], opts: { title?: string } = {}): Promise<{ batch: ShopifyBatch | null; refused: Refusal[] }> {
    const policy = getPolicy(this.db, site.id);
    if (policy.mode === "off") throw automationErrors.off();
    // Un lot de l'IA ne reçoit des propositions que pendant sa préparation (jamais après un abandon).
    const stillPreparing = () => !batchId || getBatch(this.db, batchId)?.state === "preparing";
    if (!stillPreparing()) throw batchErrors.notEditable();
    const existing = batchId ? itemsOf(this.db, batchId) : [];
    const accepted: Array<{ p: PreparedLine; note: string | null }> = [];
    const refused: Refusal[] = [];
    const cache = new Map<string, LiveResource>();
    const cap = Math.min(policy.maxChangesPerRun, MAX_BATCH_ITEMS);
    for (const [index, prop] of proposals.entries()) {
      const refuse = (e: HttpError) => refused.push({ index, code: e.code, message: e.message });
      if (existing.length + accepted.length >= cap) {
        refuse(automationErrors.notAllowed(`La règle d'automatisation limite un lot préparé par l'IA à ${cap} ligne${cap > 1 ? "s" : ""}.`));
        continue;
      }
      // La règle d'abord, sur ce que le serveur sait de l'élément (jamais sur ce que l'IA en dit).
      const row = typeof prop.resourceId === "string" ? this.shopify.storedRow(site.id, prop.resourceId) : null;
      if (!row) {
        refuse(errors.notFound("Cet élément de la boutique"));
        continue;
      }
      const early = FIELDS.includes(prop.field)
        ? ruleViolation(policy, { type: row.type, field: prop.field, locale: prop.locale ?? null, before: null, audit: null })
        : "Ce champ ne peut pas être modifié.";
      if (early) {
        refuse(automationErrors.notAllowed(early));
        continue;
      }
      let p: PreparedLine;
      try {
        p = await this.shopify.prepareLine(site, prop, cache);
      } catch (err) {
        refuse(err instanceof HttpError ? err : fromShopify(err));
        continue;
      }
      const violation = ruleViolation(policy, { type: p.type, field: p.field, locale: p.locale, before: p.before, audit: this.shopify.auditFor(site.id, p.resourceId) });
      if (violation) {
        refuse(automationErrors.notAllowed(violation));
        continue;
      }
      if (existing.some((q) => sameTarget(fromItem(q), p)) || accepted.some((q) => sameTarget(q.p, p))) {
        refuse(errors.badRequest("Ce champ est déjà proposé dans ce lot.", null));
        continue;
      }
      const note = typeof prop.note === "string" ? prop.note.replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 300) || null : null;
      accepted.push({ p, note });
    }
    let id = batchId;
    if (!id) {
      if (!accepted.length) return { batch: null, refused };
      id = this.insert(site, opts.title ?? "Corrections proposées par l'assistant", origin, "draft").id;
    }
    const start = existing.length;
    // Relu juste avant d'insérer : le lot a pu être abandonné pendant la relecture dans Shopify.
    if (!stillPreparing()) throw batchErrors.notEditable();
    tx(this.db, () => accepted.forEach((a, i) => this.insertItem(id!, start + i + 1, a.p, a.note)));
    this.hub.emit(site.id, { type: "shopify" });
    return { batch: this.get(site, id), refused };
  }

  /**
   * Fin de préparation d'un lot de l'IA : « draft », ou écriture automatique si les trois premiers verrous sont
   * réunis (le quatrième est vérifié ligne par ligne par `autoGate`, juste avant chaque écriture).
   */
  finishPreparation(site: SiteRow, batchId: string, error: ApiError["error"] | null): ShopifyBatch {
    const b = this.row(site, batchId);
    if (b.state !== "preparing" && b.state !== "draft") return this.view(b);
    const count = itemsOf(this.db, batchId).length;
    if (!count) {
      setBatch(this.db, batchId, { state: "failed", finished_at: this.iso(), error_json: JSON.stringify(error ?? { code: "bad_request", message: "L'IA n'a préparé aucune proposition valable.", action: "Élargissez la règle d'automatisation ou relancez plus tard." }) });
      this.hub.emit(site.id, { type: "shopify" });
      return this.get(site, batchId);
    }
    setBatch(this.db, batchId, { state: "draft", error_json: error ? JSON.stringify(error) : null });
    this.hub.emit(site.id, { type: "shopify" });
    this.maybeAutoApply(site, batchId);
    return this.get(site, batchId);
  }

  /**
   * Démarre l'écriture automatique d'un lot de `optimize` si les verrous du serveur et du site le permettent.
   * Un lot de l'assistant (ou composé à la main) n'est jamais appliqué sans validation, quel que soit le mode.
   */
  maybeAutoApply(site: SiteRow, batchId: string): boolean {
    const b = this.row(site, batchId);
    if (b.origin !== "automation" || b.state !== "draft") return false;
    const policy = getPolicy(this.db, site.id);
    if (!autoEnabled({ writesEnabled: this.shopify.writesEnabled, autoAllowed: this.autoAllowed, policy, origin: b.origin })) return false;
    if (this.running.has(site.id) || this.applyingIn(site)) return false;
    let run: Run;
    try {
      run = this.reserve(site, b, ["draft"]);
    } catch {
      return false;
    }
    this.start(site, run, true);
    return true;
  }

  // ───── Brouillon

  async updateItem(site: SiteRow, batchId: string, itemId: string, body: Partial<UpdateBatchItemRequest>): Promise<ShopifyBatch> {
    const b = this.row(site, batchId);
    const item = itemsOf(this.db, b.id).find((i) => i.id === itemId);
    if (!item) throw errors.notFound("Cette ligne du lot");
    const keys = Object.keys(body);
    if (!keys.length || keys.some((k) => k !== "proposed" && k !== "selected")) throw errors.badRequest("Seuls « proposed » et « selected » peuvent être modifiés.", null);
    if (b.state !== "draft") throw batchErrors.notEditable();
    const patch: Partial<ItemRow> = {};
    if ("selected" in body) {
      if (typeof body.selected !== "boolean") throw errors.badRequest("« selected » doit valoir true ou false.", null);
      patch.selected = body.selected ? 1 : 0;
    }
    if ("proposed" in body) {
      if (typeof body.proposed !== "string") throw errors.badRequest("La valeur proposée doit être un texte.", null);
      const value = normalizeValue(body.proposed, item.field);
      if (value === null) throw new HttpError(422, "shopify_invalid_value", "La valeur proposée est vide. Rien n'a été écrit.", "Saisissez un texte, ou écartez cette ligne.");
      if (sameValue(item.before_value, value)) throw errors.badRequest("Cette valeur est déjà celle de la boutique.", "Proposez une autre valeur ou écartez cette ligne.");
      patch.proposed = value;
      if (value !== item.proposed) patch.error = null;
    }
    setItem(this.db, item.id, patch);
    this.hub.emit(site.id, { type: "shopify" });
    return this.get(site, b.id);
  }

  cancel(site: SiteRow, batchId: string): ShopifyBatch {
    const b = this.row(site, batchId);
    if (b.state !== "draft" && b.state !== "preparing") throw batchErrors.notEditable();
    setBatch(this.db, b.id, { state: "cancelled", finished_at: this.iso() });
    tx(this.db, () => {
      for (const i of itemsOf(this.db, b.id)) if (i.state === "pending") setItem(this.db, i.id, { state: "skipped" });
    });
    this.hub.emit(site.id, { type: "shopify" });
    return this.get(site, b.id);
  }

  /** Le lot a-t-il été abandonné (préparation à interrompre) ? */
  isCancelled(batchId: string): boolean {
    return getBatch(this.db, batchId)?.state === "cancelled";
  }

  // ───── Écriture

  private applyingIn(site: SiteRow): boolean {
    return !!this.db.prepare("SELECT 1 FROM shopify_batches WHERE site_host = ? AND state = 'applying'").get(site.host);
  }

  /**
   * Réserve la place d'écriture du site, de façon SYNCHRONE (aucun await) : marqueur en mémoire et passage
   * conditionnel du lot en « applying » en base, seulement s'il est dans l'un des états `from` et qu'aucun lot du
   * même hôte n'est déjà en cours. Deux demandes simultanées : la seconde reçoit `limit_reached`.
   */
  private reserve(site: SiteRow, b: BatchRow, from: Array<BatchRow["state"]>): Run {
    if (this.running.has(site.id) || this.applyingIn(site)) throw batchErrors.busy();
    const res = this.db
      .prepare(
        `UPDATE shopify_batches SET state = 'applying', finished_at = NULL, error_json = NULL
         WHERE id = ? AND state IN (${from.map(() => "?").join(", ")})
           AND NOT EXISTS (SELECT 1 FROM shopify_batches o WHERE o.site_host = ? AND o.state = 'applying')`,
      )
      .run(b.id, ...from, site.host);
    if (Number(res.changes) !== 1) throw this.applyingIn(site) ? batchErrors.busy() : batchErrors.notEditable();
    let resolve: () => void = () => {};
    const done = new Promise<void>((r) => (resolve = r));
    const run: Run = { batchId: b.id, mode: "apply", abort: new AbortController(), done, resolve, prev: { state: b.state, finished_at: b.finished_at, error_json: b.error_json } };
    this.running.set(site.id, run);
    this.hub.emit(site.id, { type: "shopify" });
    return run;
  }

  /** L'écriture réservée ne démarre pas (Shopify injoignable…) : le lot retrouve son état d'avant. */
  private release(site: SiteRow, run: Run): void {
    this.db.prepare("UPDATE shopify_batches SET state = ?, finished_at = ?, error_json = ? WHERE id = ? AND state = 'applying'").run(run.prev.state, run.prev.finished_at, run.prev.error_json, run.batchId);
    if (this.running.get(site.id) === run) this.running.delete(site.id);
    run.resolve();
    this.hub.emit(site.id, { type: "shopify" });
  }

  /** Validation humaine : écrit les lignes retenues (brouillon, ou lignes restées en attente d'un lot partiel). */
  async apply(site: SiteRow, batchId: string): Promise<ShopifyBatch> {
    this.shopify.assertWritable();
    const b = this.row(site, batchId);
    if (this.running.has(site.id) || this.applyingIn(site)) throw batchErrors.busy();
    const pending = itemsOf(this.db, b.id).filter((i) => i.state === "pending" && i.selected === 1);
    if (b.state !== "draft" && !(b.state === "partial" && pending.length)) throw batchErrors.notEditable();
    if (!pending.length) throw errors.badRequest("Aucune ligne retenue à écrire.", "Cochez au moins une ligne, puis réessayez.");
    const run = this.reserve(site, b, ["draft", "partial"]);
    try {
      await this.shopify.connectedInfo(site);
    } catch (err) {
      this.release(site, run);
      throw err;
    }
    this.start(site, run, false);
    return this.get(site, b.id);
  }

  /** Annule, une par une, les lignes écrites encore annulables. */
  async restore(site: SiteRow, batchId: string): Promise<ShopifyBatch> {
    this.shopify.assertWritable();
    const b = this.row(site, batchId);
    if (b.state === "applying" || this.running.has(site.id) || this.applyingIn(site)) throw batchErrors.busy();
    const view = this.view(b);
    if (!view.items.some((i) => i.state === "applied")) throw errors.badRequest("Aucune ligne de ce lot n'est à annuler.", null);
    const run = this.reserve(site, b, ["draft", "applied", "partial", "restored"]);
    run.mode = "restore";
    try {
      await this.shopify.connectedInfo(site);
    } catch (err) {
      this.release(site, run);
      throw err;
    }
    this.start(site, run, false);
    return this.get(site, b.id);
  }

  /** Lance la boucle d'une place réservée (`reserve`) ; la place est libérée à la fin, quoi qu'il arrive. */
  private start(site: SiteRow, run: Run, auto: boolean): void {
    const batchId = run.batchId;
    if (run.mode === "apply") {
      tx(this.db, () => {
        for (const i of itemsOf(this.db, batchId)) if (i.state === "pending" && i.selected === 0) setItem(this.db, i.id, { state: "skipped" }, ["pending"]);
      });
    }
    this.hub.emit(site.id, { type: "shopify" });
    const signal = run.abort.signal;
    void (run.mode === "apply" ? this.applyLoop(site, batchId, auto, signal) : this.restoreLoop(site, batchId, signal, run.prev.state))
      .catch((err) => {
        console.error("[lots] écriture interrompue :", err instanceof Error ? scrub(err.message).slice(0, 200) : "erreur");
        setBatch(this.db, batchId, { state: "partial", finished_at: this.iso(), error_json: JSON.stringify(fromShopify(err).toErrorObject()) });
      })
      .finally(() => {
        if (this.running.get(site.id) === run) this.running.delete(site.id);
        run.resolve();
        this.hub.emit(site.id, { type: "shopify" });
      });
  }

  /** Une place dans la limite de 30 écritures par minute ; false si l'écriture du lot doit s'arrêter. */
  private async slot(signal: AbortSignal): Promise<boolean> {
    return this.shopify.writeLimiter.acquire("shopify", signal, this.sleep);
  }

  /** Les quatre verrous et le filtre de contenu pour une ligne d'un lot automatique, sur l'état présent en base. */
  private gate(site: SiteRow, batchId: string, item: ItemRow): AutoDecision {
    return autoGate({
      writesEnabled: this.shopify.writesEnabled,
      autoAllowed: this.autoAllowed,
      policy: getPolicy(this.db, site.id),
      origin: getBatch(this.db, batchId)?.origin ?? "manual",
      line: { type: item.resource_type, field: item.field, locale: item.locale, before: item.before_value, audit: this.shopify.auditFor(site.id, item.resource_id), proposed: item.proposed, resourceTitle: item.resource_title },
      usage: getUsage(this.db, site.host, this.now()),
    });
  }

  private stopError(signal: AbortSignal): ApiError["error"] {
    return signal.reason === "stop" ? STOPPED_BATCH : INTERRUPTED_BATCH;
  }

  private async applyLoop(site: SiteRow, batchId: string, auto: boolean, signal: AbortSignal): Promise<void> {
    let stoppedForReview: ApiError["error"] | null = null;
    let held = 0;
    for (const { id } of itemsOf(this.db, batchId)) {
      if (signal.aborted) break;
      // Toujours l'état présent en base : une ligne déjà écrite ou annulée n'est jamais reprise.
      let item = getItem(this.db, id);
      if (!item || item.state !== "pending" || item.selected !== 1) continue;
      if (auto) {
        // Les verrous, à chaque ligne, avant l'attente de cadence…
        const decision = this.gate(site, batchId, item);
        if (!decision.ok && decision.content) {
          held++;
          setItem(this.db, item.id, { error: `Pas écrite automatiquement : ${decision.reason} Relisez-la, puis validez le lot si elle vous convient.` }, ["pending"]);
          this.hub.emit(site.id, { type: "shopify" });
          continue;
        }
        if (!decision.ok) {
          stoppedForReview = this.reviewError(site, decision);
          break;
        }
      }
      if (!(await this.slot(signal))) break;
      if (signal.aborted) break;
      item = getItem(this.db, id);
      if (!item || item.state !== "pending" || item.selected !== 1) continue;
      if (auto) {
        // … et de nouveau juste avant l'écriture : la règle a pu passer sur « off » pendant l'attente.
        const decision = this.gate(site, batchId, item);
        if (!decision.ok) {
          stoppedForReview = this.reviewError(site, decision);
          break;
        }
      }
      try {
        const change = await this.shopify.applyLine(
          site,
          { type: item.resource_type, gid: item.resource_gid, field: item.field, imageId: item.image_id, locale: item.locale, before: item.before_value, proposed: item.proposed },
          batchId,
        );
        setItem(this.db, item.id, { state: "applied", change_id: change.id, error: null, ...(auto ? { auto_applied: 1 } : {}) }, ["pending"]);
        if (auto) {
          addUsage(this.db, site.host, this.now(), { autoChanges: 1 });
          setBatch(this.db, batchId, { auto_applied: 1 });
        }
      } catch (err) {
        const e = fromShopify(err);
        if (e.code === "shopify_conflict") setItem(this.db, item.id, { state: "conflict", error: "La valeur a changé dans Shopify depuis la préparation du lot : rien n'a été écrit pour cette ligne." }, ["pending"]);
        else if (e.code === "shopify_writes_disabled" || e.code === "shopify_not_configured" || e.code === "shopify_other_shop") {
          stoppedForReview = e.toErrorObject();
          break;
        } else setItem(this.db, item.id, { state: "failed", error: e.message }, ["pending"]);
      }
      this.hub.emit(site.id, { type: "shopify" });
    }
    const items = itemsOf(this.db, batchId);
    const left = items.some((i) => i.state === "pending" && i.selected === 1);
    const troubled = items.some((i) => i.state === "conflict" || i.state === "failed");
    if (left && auto && !signal.aborted && (stoppedForReview || held)) {
      // Écriture automatique interrompue par un verrou, un plafond ou le filtre de contenu : le reste attend une
      // validation humaine.
      setBatch(this.db, batchId, { state: "draft", error_json: JSON.stringify(stoppedForReview ?? heldForReview(held)) });
      return;
    }
    if (left) {
      setBatch(this.db, batchId, { state: "partial", finished_at: this.iso(), error_json: JSON.stringify(signal.aborted ? this.stopError(signal) : (stoppedForReview ?? INTERRUPTED_BATCH)) });
      return;
    }
    setBatch(this.db, batchId, { state: troubled ? "partial" : "applied", finished_at: this.iso(), error_json: null });
  }

  private reviewError(site: SiteRow, decision: Extract<AutoDecision, { ok: false }>): ApiError["error"] {
    return decision.budget
      ? automationErrors.budget("changes", getUsage(this.db, site.host, this.now()).resetsAt).toErrorObject()
      : automationErrors.notAllowed(`${decision.reason} Le reste du lot attend votre validation.`).toErrorObject();
  }

  private async restoreLoop(site: SiteRow, batchId: string, signal: AbortSignal, prevState: BatchRow["state"]): Promise<void> {
    // Du plus récent au plus ancien : chaque ligne est la dernière modification de son champ.
    const targets = itemsOf(this.db, batchId)
      .map((r) => ({ r, v: this.itemView(r) }))
      .filter((x) => x.v.state === "applied" && x.r.change_id)
      .reverse();
    for (const { r } of targets) {
      if (signal.aborted) break;
      if (!(await this.slot(signal))) break;
      if (signal.aborted) break;
      const cur = getItem(this.db, r.id);
      if (!cur || cur.state !== "applied") continue;
      try {
        await this.shopify.restoreChange(site, r.change_id!, batchId);
        setItem(this.db, r.id, { state: "restored", error: null }, ["applied"]);
      } catch (err) {
        const e = fromShopify(err);
        const why =
          e.code === "shopify_conflict"
            ? "La valeur a changé dans Shopify depuis l'écriture : cette ligne n'a pas été annulée."
            : e.code === "bad_request"
              ? `${e.message} Cette ligne n'a pas été annulée.`
              : `Annulation impossible : ${e.message}`;
        setItem(this.db, r.id, { error: why }, ["applied"]);
        if (e.code === "shopify_writes_disabled") break;
      }
      this.hub.emit(site.id, { type: "shopify" });
    }
    const items = itemsOf(this.db, batchId);
    const still = items.some((x) => this.itemView(x).state === "applied");
    const waiting = items.some((x) => x.state === "pending" && x.selected === 1);
    const error = signal.aborted ? JSON.stringify(this.stopError(signal)) : null;
    // Un brouillon (lot automatique arrêté par un plafond) dont on annule les lignes écrites reste à valider.
    if (prevState === "draft" && waiting) setBatch(this.db, batchId, { state: "draft", finished_at: null, error_json: error });
    else setBatch(this.db, batchId, { state: still ? "partial" : "restored", finished_at: this.iso(), error_json: error });
  }
}

const sameTarget = (a: Pick<PreparedLine, "resourceId" | "field" | "imageId" | "locale">, b: Pick<PreparedLine, "resourceId" | "field" | "imageId" | "locale">) =>
  a.resourceId === b.resourceId && a.field === b.field && (a.imageId ?? null) === (b.imageId ?? null) && (a.locale ?? null) === (b.locale ?? null);

const fromItem = (i: ItemRow) => ({ resourceId: i.resource_id, field: i.field, imageId: i.image_id, locale: i.locale });

/** Erreur d'une ligne d'un lot composé : la même erreur, préfixée du numéro de ligne. */
function lineError(err: unknown, index: number, resourceId: unknown): HttpError {
  const e = err instanceof HttpError ? err : fromShopify(err);
  return new HttpError(e.status, e.code, `Ligne ${index + 1} : ${e.message}`, e.action, { ...(e.details ?? {}), line: index + 1, resourceId: typeof resourceId === "string" ? resourceId.slice(0, 60) : null });
}
