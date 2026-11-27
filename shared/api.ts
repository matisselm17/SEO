/**
 * Format d'échange entre le serveur (server/) et l'interface (web/).
 * Seul l'agent principal modifie ce fichier. La description en clair est dans docs/format-echange.md.
 *
 * Conventions :
 * - Toutes les routes sont sous /api et répondent en JSON (sauf les flux SSE).
 * - Les dates sont des chaînes ISO 8601 en UTC ("2026-11-26T15:04:05.000Z"), les jours "2026-11-26".
 * - Une donnée absente vaut null. Jamais de valeur de remplissage.
 * - Tout texte tiré d'un site, d'un fichier ou de l'assistant est du texte brut, à afficher tel quel.
 */

// ───────────────────────── Erreurs ─────────────────────────

export type ErrorCode =
  | "invalid_url" // adresse vide, mal formée ou non publique
  | "site_unreachable" // le site ne répond pas ou refuse le chargement
  | "site_exists" // ce site est déjà suivi (details.siteId donne lequel)
  | "not_found"
  | "audit_running" // une analyse est déjà en cours pour ce site
  | "no_audit" // aucune analyse terminée ou en cours pour ce site
  | "invalid_file" // le fichier déposé n'est pas un export Search Console lisible
  | "file_too_large"
  | "chat_not_configured" // pas de clé d'API Claude côté serveur
  | "chat_unavailable" // l'API Claude est injoignable, saturée ou en quota dépassé
  | "competitors_not_configured"
  | "competitors_unavailable" // le service de recherche est injoignable ou en quota dépassé
  | "rate_limited" // trop de demandes en peu de temps ; details.retryAfterSeconds
  | "limit_reached" // plafond atteint (nombre de sites, analyses simultanées)
  | "bad_request"
  | "internal";

/** Corps de toute réponse en erreur (statut HTTP 4xx ou 5xx). */
export interface ApiError {
  error: {
    code: ErrorCode;
    /** Phrase en français, affichable telle quelle. */
    message: string;
    /** Ce que l'utilisateur peut faire, en français. null s'il n'y a rien à faire. */
    action: string | null;
    details?: Record<string, string | number | boolean | null>;
  };
}

// ───────────────────────── Sites et analyses ─────────────────────────

export type AuditState = "queued" | "running" | "done" | "failed" | "cancelled";

/** État réel d'une analyse. Aucun champ n'est estimé. */
export interface AuditStatus {
  id: string;
  state: AuditState;
  startedAt: string;
  finishedAt: string | null;
  /** Plafond de pages demandé pour cette analyse. */
  maxPages: number;
  /** Pages chargées et notées. */
  pagesDone: number;
  /** Pages qui n'ont pas pu être chargées. */
  pagesFailed: number;
  /** Pages découvertes qui attendent encore d'être chargées (dans la limite de maxPages). */
  pagesQueued: number;
  /** Adresse en cours de lecture : une page, ou pendant l'inventaire un sitemap ou le catalogue. null si aucune. */
  currentUrl: string | null;
  /** Renseigné quand state vaut "failed". */
  error: ApiError["error"] | null;
}

export interface SiteSummary {
  id: string;
  /** Adresse de départ normalisée, ex. "https://orluxjewelry.com/". */
  url: string;
  /** Hôte sans "www.", ex. "orluxjewelry.com". */
  host: string;
  /** Nom affiché : le titre du site s'il est connu, sinon l'hôte. */
  name: string;
  createdAt: string;
  /** Dernière analyse lancée, quel que soit son état. null si aucune. */
  audit: AuditStatus | null;
  /**
   * Analyse dont les résultats sont affichés (note, problèmes, pages, recommandations) :
   * la dernière analyse terminée ("done") ; à défaut, la plus récente qui a au moins une page notée.
   * Une analyse en cours, arrêtée ou en échec ne remplace jamais une analyse terminée :
   * pendant une relance, `results` reste l'analyse précédente alors que `audit` est la nouvelle.
   * null tant qu'aucune page n'a été notée.
   */
  results: { auditId: string; state: AuditState; finishedAt: string | null; pagesDone: number; pagesFailed: number } | null;
  /** Note sur 100 de l'analyse `results`. null si `results` est null. */
  score: number | null;
  /** Nombre de pages notées de l'analyse `results`. */
  pagesAnalyzed: number;
  searchConsole: { available: boolean; importedAt: string | null };
}

// ───────────────────────── Notation ─────────────────────────

export type CategoryId = "balises" | "contenu" | "technique" | "medias" | "partage";

export interface CategoryScore {
  id: CategoryId;
  label: string;
  /** Points obtenus, moyenne sur les pages analysées, arrondie à une décimale. */
  score: number;
  max: number;
}

export type Severity = "critical" | "warning" | "info";
export type CheckStatus = "pass" | "warn" | "fail";

/** Un critère de la grille appliqué à une page. */
export interface PageCheck {
  /** Identifiant stable du critère, ex. "title", "meta_description", "h1". */
  id: string;
  category: CategoryId;
  label: string;
  status: CheckStatus;
  points: number;
  max: number;
  /** Ce qui a été relevé sur la page, ex. "Titre de 84 caractères". null si rien à citer. */
  found: string | null;
  /** Ce qui est attendu, ex. "Entre 30 et 60 caractères". */
  expected: string;
  /** Explication courte pour cette page. */
  message: string;
}

// ───────────────────────── Problèmes ─────────────────────────

/** Un problème = un critère en défaut sur au moins une page, regroupé à l'échelle du site. */
export interface Issue {
  /** Identifiant du critère concerné (PageCheck.id). */
  id: string;
  category: CategoryId;
  severity: Severity;
  /** Titre court, sans jargon, ex. "Des pages n'ont pas de description". */
  title: string;
  /** Une ou deux phrases : ce que c'est et pourquoi c'est gênant, pour un non-spécialiste. */
  summary: string;
  pagesAffected: number;
  pagesTotal: number;
  /**
   * Sur quoi repose le constat. "pages" : des pages ouvertes en entier et notées.
   * "catalogue" : des produits lus dans le catalogue de la boutique sans que leur page soit ouverte
   * (titre, description, images) ; ces constats ne changent jamais la note, et pagesTotal est alors
   * le nombre de produits lus dans le catalogue.
   */
  basis: "pages" | "catalogue";
  /**
   * Points perdus sur la note du site (sur 100) à cause de ce problème :
   * somme des points perdus par page ÷ nombre de pages, arrondie à une décimale.
   * C'est la seule valeur de points à afficher. 0 pour les doublons, qui ne changent pas la note.
   */
  scoreImpact: number;
  /** Somme brute sur les pages. Sert au tri uniquement : ne jamais l'afficher. */
  pointsLost: number;
}

export interface Evidence {
  /** Page analysée correspondante ; null pour un produit lu dans le catalogue sans que sa page soit ouverte. */
  pageId: string | null;
  url: string;
  path: string;
  /** Valeur relevée sur cette page. */
  found: string | null;
  expected: string;
}

export interface Fix {
  /** Étapes à suivre, dans l'ordre, rédigées pour un non-spécialiste. */
  steps: string[];
  /** Code ou texte prêt à copier, quand il y en a un. */
  snippet: {
    language: "html" | "text" | "json";
    code: string;
    /** Page pour laquelle ce code a été construit (ses vraies valeurs), null s'il vaut pour tout le site. */
    forPath: string | null;
  } | null;
}

export interface IssueDetail extends Issue {
  /** Explication plus complète : l'effet sur le référencement et sur les visiteurs. */
  why: string;
  fix: Fix;
  /** Pages concernées avec leur preuve, les plus touchées d'abord. Au plus 200. */
  evidence: Evidence[];
}

/** Un point positif : un critère validé sur toutes les pages, ou presque. */
export interface Strength {
  id: string;
  category: CategoryId;
  title: string;
  detail: string;
  pagesPassing: number;
  pagesTotal: number;
}

// ───────────────────────── Recommandations ─────────────────────────

export type Impact = "high" | "medium" | "low";
export type Effort = "quick" | "medium" | "heavy";

export interface Recommendation {
  id: string;
  /** Problème que cette action résout. */
  issueId: string;
  /** Verbe d'action, ex. "Rédiger une description pour 12 pages". */
  title: string;
  impact: Impact;
  effort: Effort;
  pagesAffected: number;
  /** Points à regagner sur la note du site (sur 100), arrondis à une décimale. La seule valeur de points à afficher. */
  scoreGain: number;
  /** Somme brute sur les pages. Sert au tri uniquement : ne jamais l'afficher. */
  pointsToGain: number;
  /** Rang de priorité, 1 = à faire en premier. */
  rank: number;
  steps: string[];
}

// ───────────────────────── Pages ─────────────────────────

/** Type d'une page, déduit de son adresse et du sitemap. */
export type PageType = "home" | "product" | "collection" | "article" | "blog" | "page" | "policy" | "other";

export interface PageSummary {
  id: string;
  url: string;
  pageType: PageType;
  /** Chemin décodé, ex. "/collections/piercing-nombril". */
  path: string;
  title: string | null;
  /** Code HTTP obtenu. */
  httpStatus: number;
  score: number;
  /** Nombre de critères en "warn" ou "fail". */
  issues: number;
  words: number;
  /** Données Search Console de cette page ; null si pas d'import ou page absente de l'export. */
  organic: { clicks: number; impressions: number; position: number } | null;
}

export interface PageDetail extends PageSummary {
  description: string | null;
  h1: string[];
  canonical: string | null;
  lang: string | null;
  analyzedAt: string;
  checks: PageCheck[];
  /** Ce que Google afficherait : titre et description tels qu'ils seraient coupés. */
  serpPreview: { url: string; title: string | null; description: string | null };
  /** Requêtes Search Console qui mènent à cette page ; null si l'export ne les relie pas à une page. */
  queries: OrganicQuery[] | null;
}

/** Une page qui n'a pas pu être chargée pendant l'analyse `results`. */
export interface FailedPage {
  url: string;
  path: string;
  /** Code HTTP obtenu, null si aucune réponse. */
  httpStatus: number | null;
  /** Raison en français, affichable telle quelle, ex. "Page introuvable (404)". */
  reason: string;
}

export type PageSort = "score_asc" | "score_desc" | "issues_desc" | "clicks_desc" | "path_asc";

// ───────────────────────── Search Console ─────────────────────────

export interface OrganicTotals {
  clicks: number;
  impressions: number;
  /** Taux de clic entre 0 et 1. */
  ctr: number;
  /** Position moyenne. */
  position: number;
}

export interface OrganicQuery extends OrganicTotals {
  query: string;
}

export interface OrganicPage extends OrganicTotals {
  url: string;
  path: string;
  /** Page correspondante dans l'analyse, null si elle n'a pas été analysée. */
  pageId: string | null;
  score: number | null;
}

export interface OrganicPoint {
  date: string;
  clicks: number;
  impressions: number;
}

export type SearchConsoleData =
  | { available: false }
  | {
      available: true;
      importedAt: string;
      /**
       * Rapprochement avec l'analyse : pages de l'export retrouvées parmi les pages notées.
       * null si l'export ne contient pas le fichier des pages. Les adresses d'un autre site sont écartées à l'import.
       */
      matching: { matched: number; total: number } | null;
      /** Période couverte, quand l'export la donne. */
      period: { start: string; end: string } | null;
      /** Totaux, quand l'export contient la série par date ; sinon somme des requêtes. */
      totals: OrganicTotals;
      /** Série quotidienne ; null si l'export ne contient pas le fichier des dates. */
      series: OrganicPoint[] | null;
      /** Requêtes, triées par clics décroissants. null si le fichier des requêtes manque. */
      queries: OrganicQuery[] | null;
      /** Pages, triées par clics décroissants. null si le fichier des pages manque. */
      pages: OrganicPage[] | null;
    };

// ───────────────────────── Concurrents ─────────────────────────

export interface Competitor {
  host: string;
  /** Requêtes sur lesquelles ce site apparaît, parmi celles relevées. */
  queriesMatched: number;
  bestPosition: number;
  /** Exemple de résultat relevé : la preuve. */
  example: { query: string; position: number; title: string; url: string };
}

export type CompetitorsData =
  | { available: false; reason: "not_configured" | "no_audit" | "not_run" }
  | {
      available: true;
      checkedAt: string;
      /** Requêtes réellement recherchées. */
      queries: string[];
      competitors: Competitor[];
    };

// ───────────────────────── Couverture ─────────────────────────

/** Une ligne par type de page présent sur le site ou dans l'analyse. */
export interface CoverageRow {
  type: PageType;
  /** Libellé au pluriel, ex. "Produits", "Collections", "Articles de blog". */
  label: string;
  /** Nombre de pages de ce type sur le site d'après l'inventaire ; null si l'inventaire ne permet pas de le dire. */
  onSite: number | null;
  /** Pages ouvertes en entier et notées. */
  analyzed: number;
  /** Produits lus dans le catalogue sans que leur page soit ouverte. 0 hors produits. */
  viaCatalogue: number;
  /** Pages qui n'ont pas pu être chargées. */
  failed: number;
  /** Note moyenne des pages notées de ce type, arrondie à l'entier ; null si aucune. */
  score: number | null;
}

/** Ce que l'analyse affichée couvre réellement, par rapport à ce que le site contient. */
export interface Coverage {
  /** Plateforme reconnue. Seule "shopify" donne accès au catalogue. */
  platform: "shopify" | null;
  /**
   * Lecture du catalogue de la boutique. "read" : lu, des produits non ouverts en viennent.
   * "not_needed" : tous les produits inventoriés ont été ouverts en entier. "unavailable" : la boutique
   * ne le rend pas accessible, les produits non ouverts ne sont donc pas couverts. null hors Shopify.
   */
  catalogue: "read" | "not_needed" | "unavailable" | null;
  /** D'où vient l'inventaire : le sitemap du site, ou à défaut les seuls liens suivis (alors onSite vaut null). */
  inventory: "sitemap" | "links";
  rows: CoverageRow[];
  totals: { onSite: number | null; analyzed: number; viaCatalogue: number; failed: number };
  /**
   * true quand toutes les pages inventoriées de la langue principale ont été traitées (ouvertes, ou tentées
   * et en échec : voir `failed`). Les pages trouvées seulement par des liens ne font pas partie de l'inventaire.
   */
  complete: boolean;
  /** Langue principale analysée, ex. "fr" ; null si inconnue. */
  mainLocale: string | null;
  /** Autres versions de langue détectées, par code (ex. ["en", "de"]). Elles ne sont ni analysées ni comptées. */
  otherLocales: string[];
  /**
   * Plafond à demander pour ouvrir toutes les pages inventoriées en entier ;
   * null si c'est déjà fait, si l'inventaire est inconnu ou s'il dépasse la limite autorisée.
   */
  fullAuditMaxPages: number | null;
}

// ───────────────────────── Vue d'ensemble ─────────────────────────

export interface Overview {
  site: SiteSummary;
  /** null tant qu'aucune page n'a été analysée. */
  score: {
    value: number;
    /** Note de l'analyse terminée précédente, null s'il n'y en a pas. */
    previous: number | null;
    categories: CategoryScore[];
  } | null;
  counts: {
    pages: number;
    issues: { critical: number; warning: number; info: number };
  };
  /** Les problèmes les plus coûteux, au plus 5. */
  topIssues: Issue[];
  /** Au plus 5. */
  strengths: Strength[];
  /** Les premières actions à mener, au plus 5. */
  actions: Recommendation[];
  /** Ce que l'analyse couvre. null tant qu'aucune page n'a été notée. */
  coverage: Coverage | null;
  /** null sans import Search Console. */
  organic: {
    period: { start: string; end: string } | null;
    totals: OrganicTotals;
    series: OrganicPoint[] | null;
  } | null;
}

// ───────────────────────── Assistant ─────────────────────────

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  /** Texte en Markdown simple (paragraphes, listes, gras, code). À rendre sans HTML brut. */
  content: string;
  createdAt: string;
  /** Données consultées par l'assistant pour répondre, ex. ["Problèmes du site", "Page /collections/all"]. */
  sources: string[];
}

export interface ChatState {
  /** false si aucune clé d'API Claude n'est configurée côté serveur. */
  available: boolean;
  messages: ChatMessage[];
  /** Questions de départ adaptées au site, au plus 4. Vide si aucune analyse. */
  suggestions: string[];
}

// ───────────────────────── Paramètres ─────────────────────────

export interface Settings {
  /** Plafond de pages par défaut d'une nouvelle analyse. */
  maxPagesDefault: number;
  /** Bornes acceptées pour maxPages. */
  maxPagesLimits: { min: number; max: number };
  /** Ce qui est configuré côté serveur. Les clés elles-mêmes ne sont jamais renvoyées. */
  integrations: {
    chat: { configured: boolean; model: string | null };
    competitors: { configured: boolean };
  };
  version: string;
}

// ───────────────────────── Requêtes et réponses ─────────────────────────

export interface HealthResponse { ok: true; version: string }

export interface SitesResponse { sites: SiteSummary[] }
export interface SiteResponse { site: SiteSummary }
/** POST /api/sites — crée le site et lance sa première analyse. */
export interface CreateSiteRequest { url: string; maxPages?: number }

/** POST /api/sites/:siteId/audits */
export interface StartAuditRequest { maxPages?: number }
export interface AuditResponse { audit: AuditStatus }

export interface IssuesResponse { issues: Issue[]; strengths: Strength[]; categories: CategoryScore[] }
export interface IssueResponse { issue: IssueDetail }

/** GET /api/sites/:siteId/pages?sort=&q=&offset=&limit= */
export interface PagesResponse { pages: PageSummary[]; total: number; offset: number; limit: number }
export interface PageResponse { page: PageDetail }
/** GET /api/sites/:siteId/coverage */
export interface CoverageResponse { coverage: Coverage | null }
/** GET /api/sites/:siteId/failed-pages */
export interface FailedPagesResponse { pages: FailedPage[] }

export interface RecommendationsResponse { recommendations: Recommendation[] }

/** POST /api/sites/:siteId/chat */
export interface ChatRequest { message: string }

export interface UpdateSettingsRequest { maxPagesDefault?: number }

// ───────────────────────── Flux en direct (SSE) ─────────────────────────

/**
 * GET /api/sites/:siteId/events — flux permanent des changements d'un site.
 * Chaque message SSE a un champ `event` (le type) et un champ `data` (le JSON ci-dessous).
 * À la connexion, le serveur envoie toujours un "site" avec l'état courant.
 */
export type SiteEvent =
  | { type: "site"; site: SiteSummary }
  /** L'analyse avance : émis à chaque changement d'état réel, au plus 4 fois par seconde. */
  | { type: "audit"; audit: AuditStatus; score: number | null }
  /** Une page vient d'être notée. */
  | { type: "page"; page: PageSummary }
  /** L'import Search Console a changé (ajout ou suppression). */
  | { type: "search_console"; available: boolean };

/**
 * POST /api/sites/:siteId/chat — la réponse est un flux SSE.
 * Suite : un "start", des "delta" et "tool" entremêlés, puis un "done" ou un "error".
 */
export type ChatEvent =
  | { type: "start"; userMessage: ChatMessage }
  | { type: "delta"; text: string }
  /** L'assistant consulte des données du site ; label est affichable, ex. "Lecture des problèmes du site". */
  | { type: "tool"; label: string }
  | { type: "done"; message: ChatMessage }
  | { type: "error"; error: ApiError["error"] };
