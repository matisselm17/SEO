/**
 * Règle d'automatisation (docs/format-echange.md, « Automatisation ») : stockage par site, validation stricte,
 * compteurs du jour, et LE contrôle des écritures sans validation humaine.
 *
 * Tout ce qui décide si l'IA a le droit de proposer une ligne (`ruleViolation`) ou de l'écrire seule (`autoGate`)
 * est ici, et seulement ici. Ces contrôles sont faits par le serveur APRÈS la génération : rien de ce que l'IA
 * produit (ni le texte de la boutique qu'elle a lu) ne peut élargir la règle, les plafonds ni les verrous.
 */
import type { AutomationPolicy, AutomationState, ProposalOrigin, ShopifyField, ShopifyResourceType } from "../../../shared/api.ts";
import type { DB, Row } from "../db.ts";
import { errors, HttpError } from "../errors.ts";
import type { ResourceAudit } from "../shopify/service.ts";

export const DEFAULT_POLICY: AutomationPolicy = {
  mode: "propose",
  fields: ["seo_description"],
  resourceTypes: ["product", "collection"],
  scope: "empty_only",
  translations: false,
  maxChangesPerRun: 10,
  maxAutoChangesPerDay: 20,
  aiTokensPerDay: 200_000,
};

/**
 * Bornes des trois plafonds.
 * - 50 lignes par lot : le plafond d'un lot.
 * - 0 à 200 écritures automatiques par jour : 0 interdit toute écriture sans validation même en « auto » ;
 *   200 reste sous ce que la limite de 30 écritures par minute permet, sans transformer la boutique en un jour.
 * - 10 000 à 2 000 000 jetons par jour : en dessous de 10 000, une seule proposition peut ne pas tenir ;
 *   2 millions correspondent à environ un millier de propositions.
 */
export const POLICY_LIMITS: AutomationState["limits"] = {
  maxChangesPerRun: { min: 1, max: 50 },
  maxAutoChangesPerDay: { min: 0, max: 200 },
  aiTokensPerDay: { min: 10_000, max: 2_000_000 },
};

const MODES = ["off", "propose", "auto"] as const;
const FIELDS: ShopifyField[] = ["seo_title", "seo_description", "image_alt"];
const TYPES: ShopifyResourceType[] = ["product", "collection", "page", "article"];
const SCOPES = ["empty_only", "failing", "any"] as const;
const KEYS = ["mode", "fields", "resourceTypes", "scope", "translations", "maxChangesPerRun", "maxAutoChangesPerDay", "aiTokensPerDay"] as const;

export const FIELD_LABEL: Record<ShopifyField, string> = {
  seo_title: "le titre pour Google",
  seo_description: "la description pour Google",
  image_alt: "le texte alternatif des images",
};
const TYPE_LABEL: Record<ShopifyResourceType, string> = { product: "les produits", collection: "les collections", page: "les pages", article: "les articles" };

// ───────── Erreurs

export const automationErrors = {
  off: () =>
    new HttpError(409, "automation_off", "L'automatisation est arrêtée pour ce site : l'IA ne prépare aucune correction.", "Choisissez « L'IA propose, je valide » dans les réglages d'automatisation, puis réessayez."),
  notAllowed: (message: string) =>
    new HttpError(403, "automation_not_allowed", message, "Élargissez la règle d'automatisation si vous le souhaitez, ou faites cette correction vous-même."),
  budget: (what: "tokens" | "changes", resetsAt: string) =>
    new HttpError(
      429,
      "budget_exceeded",
      what === "tokens"
        ? "Le plafond du jour de jetons d'IA pour préparer des corrections est atteint."
        : "Le plafond du jour d'écritures automatiques est atteint : le reste attend votre validation.",
      what === "tokens" ? "Attendez minuit (heure UTC) ou relevez le plafond dans les réglages d'automatisation." : "Relisez et validez le lot depuis la section Boutique Shopify, ou relevez le plafond.",
      { resetsAt },
    ),
};

// ───────── Validation stricte

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

function list<T extends string>(v: unknown, allowed: readonly T[], what: string): T[] {
  if (!Array.isArray(v)) throw errors.badRequest(`« ${what} » doit être une liste.`, null);
  const out: T[] = [];
  for (const x of v) {
    if (typeof x !== "string" || !(allowed as readonly string[]).includes(x)) throw errors.badRequest(`Valeur inconnue dans « ${what} » : ${String(x).slice(0, 30)}.`, `Valeurs possibles : ${allowed.join(", ")}.`);
    if (out.includes(x as T)) throw errors.badRequest(`Valeur en double dans « ${what} » : ${x}.`, null);
    out.push(x as T);
  }
  if (!out.length) throw errors.badRequest(`Choisissez au moins une valeur pour « ${what} ».`, null);
  return out;
}

/** Valide une règle reçue : toutes les clés, rien d'autre, chaque valeur dans ses bornes. */
export function parsePolicy(raw: unknown): AutomationPolicy {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw errors.badRequest("La règle d'automatisation manque.", "Envoyez { policy: { … } }.");
  const o = raw as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !(KEYS as readonly string[]).includes(k));
  if (extra.length) throw errors.badRequest(`Réglage inconnu : ${extra[0].slice(0, 40)}.`, null);
  const missing = KEYS.filter((k) => !(k in o));
  if (missing.length) throw errors.badRequest(`Réglage manquant : ${missing[0]}.`, null);
  if (typeof o.mode !== "string" || !(MODES as readonly string[]).includes(o.mode)) throw errors.badRequest("Le mode doit être off, propose ou auto.", null);
  if (typeof o.scope !== "string" || !(SCOPES as readonly string[]).includes(o.scope)) throw errors.badRequest("La portée doit être empty_only, failing ou any.", null);
  if (typeof o.translations !== "boolean") throw errors.badRequest("« translations » doit valoir true ou false.", null);
  const bounded = (k: keyof typeof POLICY_LIMITS, label: string) => {
    const v = o[k];
    const { min, max } = POLICY_LIMITS[k];
    if (!isInt(v) || v < min || v > max) throw errors.badRequest(`${label} doit être un entier entre ${min.toLocaleString("fr-FR")} et ${max.toLocaleString("fr-FR")}.`, "Choisissez une valeur dans cette fourchette.");
    return v;
  };
  return {
    mode: o.mode as AutomationPolicy["mode"],
    fields: list(o.fields, FIELDS, "fields"),
    resourceTypes: list(o.resourceTypes, TYPES, "resourceTypes"),
    scope: o.scope as AutomationPolicy["scope"],
    translations: o.translations,
    maxChangesPerRun: bounded("maxChangesPerRun", "Le nombre de lignes par lot"),
    maxAutoChangesPerDay: bounded("maxAutoChangesPerDay", "Le nombre d'écritures automatiques par jour"),
    aiTokensPerDay: bounded("aiTokensPerDay", "Le nombre de jetons d'IA par jour"),
  };
}

// ───────── Stockage

export function getPolicy(db: DB, siteId: string): AutomationPolicy {
  const r = db.prepare("SELECT policy_json FROM automation_policies WHERE site_id = ?").get(siteId) as Row | undefined;
  if (!r) return structuredClone(DEFAULT_POLICY);
  try {
    return parsePolicy(JSON.parse(r.policy_json as string));
  } catch {
    // Une règle enregistrée illisible ne donne jamais plus de droits : on revient à la règle par défaut.
    return structuredClone(DEFAULT_POLICY);
  }
}

export function setPolicy(db: DB, siteId: string, policy: AutomationPolicy, at: string): void {
  db.prepare("INSERT INTO automation_policies (site_id, policy_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(site_id) DO UPDATE SET policy_json = excluded.policy_json, updated_at = excluded.updated_at").run(
    siteId,
    JSON.stringify(policy),
    at,
  );
}

// ───────── Compteurs du jour (jour UTC)

export const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);
export const nextUtcMidnight = (t: number) => {
  const d = new Date(t);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
};

export type Usage = AutomationState["usage"];

export function getUsage(db: DB, siteHost: string, now: number): Usage {
  const day = utcDay(now);
  const r = db.prepare("SELECT auto_changes, ai_tokens FROM automation_usage WHERE site_host = ? AND day = ?").get(siteHost, day) as Row | undefined;
  return { day, autoChanges: (r?.auto_changes as number) ?? 0, aiTokens: (r?.ai_tokens as number) ?? 0, resetsAt: nextUtcMidnight(now) };
}

export function addUsage(db: DB, siteHost: string, now: number, add: { autoChanges?: number; aiTokens?: number }): void {
  const day = utcDay(now);
  db.prepare(
    `INSERT INTO automation_usage (site_host, day, auto_changes, ai_tokens) VALUES (?, ?, ?, ?)
     ON CONFLICT(site_host, day) DO UPDATE SET auto_changes = auto_changes + excluded.auto_changes, ai_tokens = ai_tokens + excluded.ai_tokens`,
  ).run(siteHost, day, Math.max(0, add.autoChanges ?? 0), Math.max(0, Math.round(add.aiTokens ?? 0)));
}

// ───────── La règle

/** Ce qu'une ligne préparée par l'IA vise, tel que le serveur l'a lu (jamais tel que l'IA le dit). */
export interface PolicyLine {
  type: ShopifyResourceType;
  field: ShopifyField;
  locale: string | null;
  /** Valeur actuelle lue dans Shopify. */
  before: string | null;
  /** Verdict de l'analyse affichée sur la page de l'élément ; null si la page n'a pas été ouverte. */
  audit: ResourceAudit | null;
}

const isEmpty = (v: string | null) => !v || !v.trim();

/** Le champ est-il jugé en défaut par l'analyse affichée ? (null : l'analyse ne permet pas de le dire) */
export function failingByAudit(line: Pick<PolicyLine, "field" | "locale" | "audit">): boolean | null {
  // L'analyse ne porte que sur la langue principale, et ne juge pas une image en particulier.
  if (line.locale || line.field === "image_alt" || !line.audit) return null;
  return (line.field === "seo_title" ? line.audit.titleStatus : line.audit.descriptionStatus) !== "pass";
}

/**
 * La ligne respecte-t-elle la règle (champ, type d'élément, traductions, portée) ? Renvoie la raison du refus,
 * en français, ou null. S'applique à tout ce que l'IA prépare, en « propose » comme en « auto ».
 */
export function ruleViolation(policy: AutomationPolicy, line: PolicyLine): string | null {
  if (!policy.fields.includes(line.field)) return `La règle d'automatisation n'autorise pas l'IA à modifier ${FIELD_LABEL[line.field]}.`;
  if (!policy.resourceTypes.includes(line.type)) return `La règle d'automatisation n'autorise pas l'IA à modifier ${TYPE_LABEL[line.type]}.`;
  if (line.locale && !policy.translations) return "La règle d'automatisation n'autorise pas l'IA à proposer des traductions.";
  if (policy.scope === "any" || isEmpty(line.before)) return null;
  if (policy.scope === "empty_only") return "Ce champ n'est pas vide dans Shopify : la règle n'autorise l'IA qu'à remplir les champs vides.";
  const failing = failingByAudit(line);
  if (failing === true) return null;
  if (failing === false) return "L'analyse juge déjà correcte la valeur affichée : la règle n'autorise l'IA à remplacer que les valeurs vides ou en défaut.";
  return "L'analyse ne permet pas de dire que cette valeur est en défaut : la règle n'autorise l'IA à remplacer que les valeurs vides ou en défaut.";
}

// ───────── Filtre de contenu des écritures automatiques

/** Mots trop courants pour prouver qu'un texte parle de l'élément (comparés sans accents, en minuscules). */
const STOP_WORDS = new Set(
  (
    "avec sans pour dans sous vers chez entre depuis pendant contre selon apres avant aussi ainsi alors donc mais comme " +
    "plus moins tres trop tout tous toute toutes cette celle celui ceux cela votre notre leur leurs vous nous elle elles " +
    "etre avoir fait faire sont etes sera quoi quel quelle quels quelles dont the and with from your this that for our " +
    "their into about"
  ).split(" "),
);

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();

/** Mots significatifs d'un texte : 4 lettres ou plus, hors mots vides ; pluriel simple (s, x) retiré. */
export function significantWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of fold(text).match(/\p{L}+/gu) ?? []) {
    if (w.length < 4 || STOP_WORDS.has(w)) continue;
    out.add(w.length > 4 && /[sx]$/.test(w) ? w.slice(0, -1) : w);
  }
  return out;
}

const URL_RE = /\b(?:https?|ftp):\/\/|\bwww\s*\.|\[\s*\.\s*\]|\(\s*\.\s*\)/i;
/** Un nom de domaine : mots séparés par des points et terminés par 2 à 24 lettres (exemple.fr, boutique.example.com). */
const DOMAIN_RE = /(?<![\p{L}\p{N}_-])[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,24}(?![\p{L}\p{N}])/u;
const EMAIL_RE = /[^\s@]+@[^\s@]+/;
/** Huit chiffres ou plus à la suite, avec espaces, points, tirets ou parenthèses entre eux : un numéro de téléphone. */
const PHONE_RE = /(?:\+|\b00)?\d(?:[\s.\-()/]*\d){7,}/;

/**
 * Filtre de contenu d'une proposition de l'IA écrite SANS relecture humaine (docs/format-echange.md, « Filtre de
 * contenu des écritures automatiques »). Renvoie la raison, en français, pour laquelle elle doit être relue par un
 * humain, ou null. Prudent par construction : un faux positif ne fait qu'attendre une validation.
 */
export function contentViolation(proposed: string, resourceTitle: string): string | null {
  if (URL_RE.test(proposed)) return "La proposition contient une adresse web.";
  if (EMAIL_RE.test(proposed)) return "La proposition contient une adresse e-mail.";
  if (DOMAIN_RE.test(proposed)) return "La proposition contient un nom de domaine.";
  if (PHONE_RE.test(proposed)) return "La proposition contient un numéro de téléphone.";
  const title = significantWords(resourceTitle);
  if (!title.size) return "Le nom de l'élément ne contient aucun mot assez long pour vérifier que la proposition en parle.";
  const words = significantWords(proposed);
  if (![...title].some((w) => words.has(w))) return "La proposition ne reprend aucun mot du nom de l'élément : elle pourrait parler d'autre chose.";
  return null;
}

export type AutoDecision = { ok: true } | { ok: false; lock: 1 | 2 | 3 | 4; reason: string; budget: boolean; content: boolean };

/** Ce qu'une ligne écrite sans validation humaine vise et propose (lu en base, jamais tel que l'IA le dit). */
export interface AutoLine extends PolicyLine {
  /** Valeur qui serait écrite. */
  proposed: string;
  /** Nom de l'élément, tel que lu dans Shopify à la préparation. */
  resourceTitle: string;
}

/**
 * LES QUATRE VERROUS d'une écriture sans validation humaine, tous nécessaires, vérifiés par le serveur juste
 * avant chaque ligne écrite automatiquement (après toute attente). C'est le seul endroit du code qui en décide.
 * 1. SHOPIFY_WRITES_ENABLED=1 ; 2. SHOPIFY_AUTO_APPLY=1 ;
 * 3. policy.mode = "auto", et le lot vient de `optimize` (un lot de l'assistant attend toujours une validation) ;
 * 4. la ligne respecte la règle, le filtre de contenu, et le plafond d'écritures automatiques du jour n'est pas atteint.
 */
export function autoGate(o: { writesEnabled: boolean; autoAllowed: boolean; policy: AutomationPolicy; origin: ProposalOrigin; line: AutoLine; usage: Usage }): AutoDecision {
  const no = (lock: 1 | 2 | 3 | 4, reason: string, extra: { budget?: boolean; content?: boolean } = {}): AutoDecision => ({ ok: false, lock, reason, budget: extra.budget === true, content: extra.content === true });
  if (o.writesEnabled !== true) return no(1, "Les modifications de la boutique ne sont pas activées sur ce serveur (SHOPIFY_WRITES_ENABLED).");
  if (o.autoAllowed !== true) return no(2, "Le serveur n'autorise pas les écritures automatiques (SHOPIFY_AUTO_APPLY).");
  if (o.policy.mode !== "auto") return no(3, "La règle d'automatisation de ce site n'est pas en mode « auto ».");
  if (o.origin !== "automation") return no(3, "Seuls les lots de « Préparer des corrections avec l'IA » peuvent être appliqués sans validation : ce lot attend la vôtre.");
  const violation = ruleViolation(o.policy, o.line);
  if (violation) return no(4, violation);
  const content = contentViolation(o.line.proposed, o.line.resourceTitle);
  if (content) return no(4, content, { content: true });
  if (o.usage.autoChanges >= o.policy.maxAutoChangesPerDay) return no(4, "Le plafond du jour d'écritures automatiques est atteint.", { budget: true });
  return { ok: true };
}

/** Les trois premiers verrous (ceux qui ne dépendent pas de la ligne) : un lot préparé par l'IA part-il seul ? */
export function autoEnabled(o: { writesEnabled: boolean; autoAllowed: boolean; policy: AutomationPolicy; origin: ProposalOrigin }): boolean {
  return o.writesEnabled === true && o.autoAllowed === true && o.policy.mode === "auto" && o.origin === "automation";
}
