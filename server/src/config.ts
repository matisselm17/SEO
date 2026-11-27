/**
 * Configuration du serveur, lue depuis l'environnement et, s'il existe, depuis le fichier `.env`
 * à la racine du dépôt. Les variables déjà présentes dans l'environnement gardent la priorité.
 * Les clés d'API ne sont jamais journalisées ni renvoyées au navigateur.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseShopDomain, type ShopifyCredentials } from "./shopify/auth.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Dossier `server/`, que le code tourne depuis `src/` (tsx) ou depuis `dist/server/src/` (compilé). */
export const SERVER_DIR = findServerDir(here);
export const REPO_DIR = path.resolve(SERVER_DIR, "..");

function findServerDir(start: string): string {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    const pkg = path.join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        const name = JSON.parse(readFileSync(pkg, "utf8")).name;
        if (name === "chat-seo-server") return dir;
      } catch {
        /* on continue de remonter */
      }
    }
    dir = path.dirname(dir);
  }
  return path.resolve(start, "..");
}

/** Lecture minimale d'un fichier .env : `CLE=valeur`, commentaires `#`, guillemets facultatifs. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash);
      value = value.trim();
    }
    out[m[1]] = value;
  }
  return out;
}

function loadDotenv(): void {
  const file = path.join(REPO_DIR, ".env");
  if (!existsSync(file)) return;
  try {
    const vars = parseDotenv(readFileSync(file, "utf8"));
    for (const [k, v] of Object.entries(vars)) {
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch {
    // Un .env illisible n'empêche pas le démarrage ; on ne journalise pas son contenu.
    console.warn("[config] Le fichier .env n'a pas pu être lu ; il est ignoré.");
  }
}

/**
 * Noms des variables décrites dans `.env.example` et absentes de `.env` (ni renseignées ni même listées).
 * Sert à signaler au démarrage un `.env` écrasé par une ancienne version. Ne lit et ne renvoie aucune valeur.
 */
export function envNamesMissing(): string[] {
  const names = (file: string): Set<string> | null => {
    try {
      return new Set(Object.keys(parseDotenv(readFileSync(path.join(REPO_DIR, file), "utf8"))));
    } catch {
      return null;
    }
  };
  const expected = names(".env.example");
  const present = names(".env");
  if (!expected || !present) return [];
  return [...expected].filter((n) => !present.has(n)).sort();
}

/** Bornes du plafond de pages d'une analyse, et plafond par défaut d'une nouvelle analyse. */
export const MAX_PAGES_LIMITS = { min: 1, max: 100 };
export const DEFAULT_MAX_PAGES = 100;

export interface Limits {
  /** Nombre maximal de sites suivis. */
  maxSites: number;
  /** Analyses qui tournent en même temps ; les suivantes attendent en « queued ». */
  maxConcurrentAudits: number;
  /** Questions à l'assistant par minute (tout l'espace de travail). */
  chatPerMinute: number;
  /** Relevés de concurrents par minute. */
  competitorsPerMinute: number;
}

export const DEFAULT_LIMITS: Limits = { maxSites: 50, maxConcurrentAudits: 2, chatPerMinute: 10, competitorsPerMinute: 3 };

export interface Config {
  port: number;
  /** Adresse d'écoute, 127.0.0.1 par défaut. */
  host: string;
  limits: Limits;
  dataDir: string;
  anthropicApiKey: string | null;
  anthropicModel: string;
  firecrawlApiKey: string | null;
  /** Connexion à la boutique Shopify ; null si l'une des trois variables manque ou si le domaine est invalide. */
  shopify: ShopifyCredentials | null;
  /** Écritures dans la boutique autorisées : vrai seulement si SHOPIFY_WRITES_ENABLED vaut exactement « 1 ». */
  shopifyWritesEnabled: boolean;
  /** Mode d'automatisation « auto » autorisé : vrai seulement si SHOPIFY_AUTO_APPLY vaut exactement « 1 ». */
  shopifyAutoApply: boolean;
  /**
   * Chemin du fichier JSON du compte de service Google (GOOGLE_APPLICATION_CREDENTIALS ou GOOGLE_SERVICE_ACCOUNT_FILE, sinon
   * secrets/google-service-account.json à la racine du dépôt). Le fichier peut ne pas exister : la Search Console
   * n'est alors pas configurée. Son contenu n'est jamais journalisé ni renvoyé.
   */
  googleServiceAccountFile: string;
  /** Propriété Search Console à lire (GSC_PROPERTY) ; null : déduite de l'hôte du site. */
  gscProperty: string | null;
  /** Identifiant de la propriété Google Analytics 4 (GA4_PROPERTY_ID), purement numérique ; null sinon. */
  ga4PropertyId: string | null;
  /** Clé d'API PageSpeed Insights (GOOGLE_PAGESPEED_API_KEY) ; null sans clé. Jamais journalisée ni renvoyée. */
  pageSpeedApiKey: string | null;
  /** Identifiants DataForSEO ; null si l'un manque. Aucune fonctionnalité ne s'en sert encore. */
  dataForSeo: { login: string; password: string } | null;
  /** Hôtes acceptés dans l'en-tête Host en plus de localhost (ALLOWED_HOSTS, séparés par des virgules), en minuscules. */
  allowedHosts: string[];
  /** Réservé au développement et aux tests : autorise le chargement d'adresses privées (localhost…). */
  allowPrivateHosts: boolean;
  version: string;
  webDist: string;
}

function readVersion(): string {
  try {
    return JSON.parse(readFileSync(path.join(SERVER_DIR, "package.json"), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const nonEmpty = (v: string | undefined) => (v && v.trim() ? v.trim() : null);

/** GA4_PROPERTY_ID : chiffres seulement (« properties/123 » ou « G-XXXX » ne sont pas acceptés) ; null sinon. */
export function parseGa4PropertyId(v: string | undefined): string | null {
  const s = nonEmpty(v);
  return s && /^\d{1,20}$/.test(s) ? s : null;
}

export function loadConfig(): Config {
  loadDotenv();
  const env = process.env;
  const port = Number.parseInt(env.PORT ?? "", 10);
  const dataDirRaw = nonEmpty(env.DATA_DIR) ?? "./data";
  const shopDomain = parseShopDomain(env.SHOPIFY_STORE_DOMAIN);
  const shopId = nonEmpty(env.SHOPIFY_CLIENT_ID);
  const shopSecret = nonEmpty(env.SHOPIFY_CLIENT_SECRET);
  return {
    port: Number.isFinite(port) && port > 0 ? port : 8787,
    host: nonEmpty(env.HOST) ?? "127.0.0.1",
    limits: DEFAULT_LIMITS,
    // Un chemin relatif est compris depuis la racine du dépôt, comme le .env qui le déclare.
    dataDir: path.isAbsolute(dataDirRaw) ? dataDirRaw : path.resolve(REPO_DIR, dataDirRaw),
    anthropicApiKey: nonEmpty(env.ANTHROPIC_API_KEY),
    anthropicModel: nonEmpty(env.ANTHROPIC_MODEL) ?? "claude-sonnet-5-5",
    firecrawlApiKey: nonEmpty(env.FIRECRAWL_API_KEY),
    shopify: shopDomain && shopId && shopSecret ? { storeDomain: shopDomain, clientId: shopId, clientSecret: shopSecret } : null,
    shopifyWritesEnabled: env.SHOPIFY_WRITES_ENABLED === "1",
    shopifyAutoApply: env.SHOPIFY_AUTO_APPLY === "1",
    googleServiceAccountFile: (() => {
      // GOOGLE_APPLICATION_CREDENTIALS est le nom habituel chez Google ; GOOGLE_SERVICE_ACCOUNT_FILE reste accepté.
      const raw = nonEmpty(env.GOOGLE_APPLICATION_CREDENTIALS) ?? nonEmpty(env.GOOGLE_SERVICE_ACCOUNT_FILE);
      if (!raw) return path.join(REPO_DIR, "secrets", "google-service-account.json");
      return path.isAbsolute(raw) ? raw : path.resolve(REPO_DIR, raw);
    })(),
    gscProperty: nonEmpty(env.GSC_PROPERTY),
    ga4PropertyId: parseGa4PropertyId(env.GA4_PROPERTY_ID),
    pageSpeedApiKey: nonEmpty(env.GOOGLE_PAGESPEED_API_KEY),
    dataForSeo: nonEmpty(env.DATAFORSEO_LOGIN) && nonEmpty(env.DATAFORSEO_PASSWORD) ? { login: nonEmpty(env.DATAFORSEO_LOGIN)!, password: nonEmpty(env.DATAFORSEO_PASSWORD)! } : null,
    allowedHosts: (env.ALLOWED_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, ""))
      .filter(Boolean),
    allowPrivateHosts: env.ALLOW_PRIVATE_HOSTS === "1",
    version: readVersion(),
    webDist: path.resolve(REPO_DIR, "web", "dist"),
  };
}
