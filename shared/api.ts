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
  | "shopify_not_configured" // les trois variables SHOPIFY_* ne sont pas renseignées côté serveur
  | "shopify_other_shop" // la boutique connectée n'est pas celle de ce site
  | "shopify_unavailable" // Shopify est injoignable ou a refusé la demande ; details.retryable
  | "shopify_not_synced" // la boutique n'a pas encore été lue : lancer une lecture d'abord
  | "shopify_writes_disabled" // les modifications ne sont pas autorisées côté serveur (SHOPIFY_WRITES_ENABLED)
  | "shopify_missing_scope" // l'application Shopify n'a pas la permission nécessaire ; details.scope
  | "shopify_conflict" // la valeur a changé dans Shopify depuis sa dernière lecture ; rien n'a été écrit
  | "shopify_invalid_value" // la valeur demandée est refusée telle quelle (trop longue, caractères < ou >) ; rien n'a été écrit
  | "search_console_not_configured" // pas de compte de service Google côté serveur
  | "search_console_no_access" // le compte de service n'a accès à aucune propriété de ce site ; details.account = son adresse e-mail
  | "search_console_unavailable" // Google est injoignable ou a refusé ; details.retryable
  | "analytics_not_configured" // pas de compte de service Google ou pas de GA4_PROPERTY_ID côté serveur
  | "analytics_no_access" // le compte de service n'a pas accès à cette propriété Google Analytics ; details.account
  | "analytics_other_site" // la propriété Google Analytics ne reçoit aucune visite sur l'hôte de ce site
  | "analytics_unavailable" // Google Analytics est injoignable ou a refusé ; details.retryable
  | "pagespeed_not_configured" // pas de clé GOOGLE_PAGESPEED_API_KEY côté serveur
  | "pagespeed_unavailable" // PageSpeed Insights est injoignable, a refusé ou n'a pas pu charger la page ; details.retryable
  | "automation_off" // l'automatisation est sur « arrêtée » pour ce site
  | "automation_not_allowed" // la règle d'autorisation refuse cette correction ; le message dit laquelle
  | "budget_exceeded" // plafond du jour atteint (modifications ou jetons d'IA) ; details.resetsAt
  | "batch_not_editable" // ce lot n'est plus un brouillon
  | "storefront_locked" // la boutique en ligne est protégée par un mot de passe : ses pages publiques ne peuvent pas être analysées
  | "unauthorized" // mode intégré : jeton de session Shopify absent, invalide ou expiré (statut 401)
  | "shop_not_allowed" // mode intégré : le jeton de session est valide mais le serveur ne sert plus cette boutique (statut 403 ; réservé à la désinstallation)
  | "not_in_embedded_mode" // mode intégré : cette action n'existe pas (ajout ou suppression d'un site, réglages du serveur, section masquée) ; statut 403
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
  /**
   * Le site limite les demandes : le parcours est en pause jusqu'à cette date, puis reprend plus lentement.
   * null hors pause. L'interface le dit au lieu de laisser croire que l'analyse est figée.
   */
  pausedUntil: string | null;
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
  /** Élément de la boutique Shopify qui correspond à cette page ; null sans boutique lue ou sans correspondance. */
  shopifyResourceId: string | null;
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
  /**
   * `Evidence.shopifyResourceId` n'est renseigné, pour ce problème, que si ce champ est réellement modifiable
   * sur l'élément (ex. jamais pour "image_alt" sur une page, dont les images viennent du thème).
   * Champ Shopify qui corrige ce problème, quand il y en a un : "title" et "duplicate_title" → "seo_title",
   * "meta_description" et "duplicate_description" → "seo_description", "image_alt" et
   * "catalogue_image_alt" → "image_alt". null pour les autres problèmes.
   */
  shopifyField: ShopifyField | null;
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
  /** Visites de cette page d'après Google Analytics ; null sans lecture ou si la page n'y figure pas. */
  visits: PageVisits | null;
  /** Dernières mesures de vitesse de cette page ; null si elle n'a jamais été mesurée. */
  speed: { mobile: SpeedMeasure | null; desktop: SpeedMeasure | null } | null;
  /** Élément de la boutique Shopify qui correspond à cette page ; null sans boutique lue ou sans correspondance. */
  shopifyResourceId: string | null;
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
      /** "file" : export déposé. "google" : lu directement dans la Search Console. */
      source: "file" | "google";
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

// ───────────────────────── Google Analytics ─────────────────────────

/** Ce que font les visiteurs une fois arrivés. Tous les nombres viennent de Google Analytics, sans estimation. */
export interface VisitTotals {
  /** Visites (sessions). */
  sessions: number;
  /** Visiteurs distincts. */
  users: number;
  /** Part des visites où le visiteur est resté actif, entre 0 et 1 (taux d'engagement). */
  engagementRate: number;
  /** Événements clés (achats, ajouts au panier… selon ce que le propriétaire a défini dans Google Analytics). */
  keyEvents: number;
  /** Chiffre d'affaires mesuré ; null si le suivi des ventes n'est pas en place dans Google Analytics. */
  revenue: number | null;
}

/** Visites dont cette page était la page d'arrivée. */
export interface PageVisits extends VisitTotals {
  /** Dont visites venues d'une recherche Google ou d'un autre moteur (canal « Organic Search »). */
  organicSessions: number;
}

export interface LandingPage extends PageVisits {
  path: string;
  /** Page correspondante dans l'analyse, null si elle n'a pas été analysée. */
  pageId: string | null;
  score: number | null;
}

export type AnalyticsData =
  | { available: false; reason: "not_configured" | "not_run" }
  | {
      available: true;
      syncedAt: string;
      period: { start: string; end: string };
      /** Code de devise de la propriété, ex. "EUR" ; null si inconnu. */
      currency: string | null;
      /** Toutes les visites du site. */
      totals: VisitTotals;
      /** Les seules visites venues des moteurs de recherche. */
      organic: VisitTotals;
      /** Par origine des visites, la plus importante d'abord. `channel` est le libellé de Google, ex. "Organic Search". */
      channels: Array<VisitTotals & { channel: string }>;
      /** Série quotidienne. */
      series: Array<{ date: string; sessions: number; organicSessions: number }>;
      /** Pages d'arrivée, triées par visites venues des moteurs de recherche. Au plus 200. */
      landingPages: LandingPage[];
      /** true si le site a plus de pages d'arrivée que la liste : une page absente n'est alors pas forcément sans visite. */
      landingPagesTruncated: boolean;
      /**
       * Pourquoi `revenue` vaut null, le cas échéant. "measured" : un chiffre d'affaires est mesuré.
       * "not_measured" : aucune vente mesurée sur la période. "restricted" : le compte de service n'a pas le
       * droit de voir le chiffre d'affaires dans Google Analytics.
       */
      revenueStatus: "measured" | "not_measured" | "restricted";
    };

// ───────────────────────── Vitesse des pages ─────────────────────────

/** Verdict de Google sur une mesure : "good" bon, "average" à améliorer, "poor" lent. */
export type SpeedRating = "good" | "average" | "poor";

export interface SpeedMetric {
  /** Valeur dans l'unité de la mesure : millisecondes, sauf `cls` (sans unité). */
  value: number;
  rating: SpeedRating;
}

/** Une mesure PageSpeed Insights d'une page, pour un type d'appareil. */
export interface SpeedMeasure {
  measuredAt: string;
  /** Note de performance de 0 à 100, mesurée en laboratoire par Google (Lighthouse). */
  score: number;
  /** Mesures de laboratoire : un chargement simulé, reproductible. */
  lab: {
    /** Affichage du plus grand élément visible (LCP), en ms. */
    lcp: SpeedMetric;
    /** Stabilité de la mise en page (CLS), sans unité. */
    cls: SpeedMetric;
    /** Temps de blocage pendant le chargement (TBT), en ms. */
    tbt: SpeedMetric;
    /** Premier affichage (FCP), en ms. */
    fcp: SpeedMetric;
  };
  /**
   * Mesures de terrain : ce que les vrais visiteurs ont vécu sur 28 jours (Chrome). null quand Google n'a pas
   * assez de visites pour cette page. `scope` dit si elles portent sur cette page ou sur tout le site.
   */
  field: {
    scope: "page" | "site";
    lcp: SpeedMetric | null;
    /** Réactivité aux interactions (INP), en ms. */
    inp: SpeedMetric | null;
    cls: SpeedMetric | null;
  } | null;
  /** Les améliorations les plus payantes d'après Google, au plus 5. Textes de Google, en français, texte brut. */
  opportunities: Array<{ title: string; detail: string | null; savingsMs: number | null }>;
}

export interface SpeedPage {
  pageId: string | null;
  url: string;
  path: string;
  pageType: PageType | null;
  mobile: SpeedMeasure | null;
  desktop: SpeedMeasure | null;
}

/** GET /api/sites/:siteId/pagespeed */
export interface PageSpeedState {
  configured: boolean;
  /** Mesure en cours ; null sinon. `done` et `total` comptent des pages. */
  running: { done: number; total: number; currentUrl: string | null } | null;
  /** Pages mesurées, la plus lente sur mobile d'abord. */
  pages: SpeedPage[];
  /** Erreur qui a empêché ou interrompu la dernière demande de mesure (clé refusée, quota…) ; null sinon. */
  lastError: ApiError["error"] | null;
  /**
   * Mesures de la dernière demande qui n'ont pas abouti, page par page et appareil par appareil.
   * Remis à zéro au début de chaque demande, jamais par une réussite.
   */
  failures: Array<{ path: string; device: "mobile" | "desktop"; message: string }>;
}
/**
 * POST /api/sites/:siteId/pagespeed — lance une mesure (mobile et ordinateur) et répond tout de suite (202).
 * `pageIds` : les pages à mesurer (10 au plus). Sans lui : l'accueil et, pour chaque type de page, la page qui
 * reçoit le plus de visites (à défaut, la première analysée).
 */
export interface MeasureSpeedRequest { pageIds?: string[] }

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

// ───────────────────────── Boutique Shopify ─────────────────────────

export type ShopifyResourceType = "product" | "collection" | "page" | "article";

/**
 * Ce que le logiciel sait modifier dans la boutique.
 * "seo_title" : le titre affiché dans Google (meta title). "seo_description" : la description affichée
 * dans Google (meta description). "image_alt" : le texte alternatif d'une image.
 */
export type ShopifyField = "seo_title" | "seo_description" | "image_alt";

export interface ShopifyConnection {
  /**
   * "not_configured" : les variables SHOPIFY_* manquent. "other_shop" : une boutique est connectée, mais
   * son domaine public n'est pas celui de ce site. "error" : Shopify a refusé ou n'a pas répondu (voir `error`).
   * "connected" : la boutique de ce site est connectée.
   */
  state: "not_configured" | "other_shop" | "error" | "connected";
  /** Nom de la boutique ; null hors "connected" et "other_shop". */
  shopName: string | null;
  /** Domaine public de la boutique, sans "www." ; null si inconnu. Le domaine myshopify.com n'est jamais renvoyé. */
  shopHost: string | null;
  /** Permissions réellement accordées à l'application, ex. "write_products". Vide hors "connected". */
  scopes: string[];
  /** Permissions dont le logiciel se sert et qui ne sont pas accordées. */
  missingScopes: ShopifyMissingScope[];
  /** Le serveur accepte d'écrire dans la boutique. false par défaut : tout est alors en lecture seule. */
  writesEnabled: boolean;
  /** Langue principale de la boutique, ex. "fr" ; null si inconnue. */
  primaryLocale: string | null;
  /** Autres langues publiées, ex. ["de", "en"]. */
  otherLocales: string[];
  /** Renseigné quand state vaut "error". */
  error: ApiError["error"] | null;
}

export interface ShopifyMissingScope {
  scope: string;
  /** Ce que cette absence empêche, en français, ex. "Modifier les titres et descriptions des pages et articles". */
  blocks: string;
}

/** GET /api/sites/:siteId/shopify — état de la connexion et de la dernière lecture de la boutique. */
export interface ShopifyState {
  connection: ShopifyConnection;
  /** Dernière lecture complète de la boutique ; null si elle n'a jamais été lue pour ce site. */
  sync: {
    syncedAt: string;
    counts: Record<ShopifyResourceType, number>;
    /** Sur l'ensemble des éléments lus. */
    missing: { seoTitle: number; seoDescription: number; imagesWithoutAlt: number; images: number };
    /**
     * Parmi les `audited` éléments dont la page a été ouverte par l'analyse affichée : ceux dont le titre ou la
     * description réellement affichés ne valident pas la grille ("warn" ou "fail").
     */
    toFix: { audited: number; title: number; description: number };
  } | null;
}

export interface ShopifyResourceSummary {
  /** Identifiant interne, stable d'une lecture à l'autre. */
  id: string;
  type: ShopifyResourceType;
  /** Chemin public dans la langue principale, ex. "/products/anneau-titane". */
  path: string;
  /** Nom de l'élément dans Shopify (nom du produit, de la collection, de la page, de l'article). */
  title: string;
  /** null : champ vide dans Shopify, qui utilise alors le nom de l'élément. */
  seoTitle: string | null;
  /** null : champ vide dans Shopify, qui utilise alors le début du texte de l'élément. */
  seoDescription: string | null;
  images: number;
  imagesWithoutAlt: number;
  /** Page correspondante dans l'analyse affichée ; null si elle n'a pas été ouverte. */
  pageId: string | null;
  /** Note de cette page ; null si pageId est null. */
  pageScore: number | null;
  /** Nombre de modifications faites par le logiciel sur cet élément. */
  changes: number;
  /**
   * Ce que l'analyse a constaté sur la page réellement affichée aux visiteurs et à Google ; null si la page
   * n'a pas été ouverte. C'est ce verdict, et non le fait qu'un champ soit vide dans Shopify, qui dit s'il y a
   * un problème : un titre vide dans Shopify est remplacé par le nom de l'élément, souvent correct.
   */
  audit: {
    renderedTitle: string | null;
    titleStatus: CheckStatus;
    renderedDescription: string | null;
    descriptionStatus: CheckStatus;
  } | null;
}

export interface ShopifyImage {
  id: string;
  /** Adresse de l'image chez Shopify (https). */
  url: string;
  alt: string | null;
}

/** Valeur d'un champ dans une autre langue que la langue principale. */
export interface ShopifyTranslation {
  locale: string;
  field: "seo_title" | "seo_description";
  value: string | null;
  /** La traduction date d'avant la dernière modification du texte d'origine. */
  outdated: boolean;
  /** false quand Shopify ne permet pas de traduire ce champ ici (ex. texte d'origine vide) ; `reason` dit pourquoi. */
  editable: boolean;
  reason: string | null;
}

/** Lu en direct dans Shopify à chaque demande : ce sont les valeurs actuelles de la boutique. */
export interface ShopifyResourceDetail extends ShopifyResourceSummary {
  /** Au plus 50 images, dans l'ordre de la boutique. */
  imageList: ShopifyImage[];
  translations: ShopifyTranslation[];
  /** Modifications faites par le logiciel sur cet élément, la plus récente d'abord. */
  history: ShopifyChange[];
  /** Champs que le logiciel peut modifier sur cet élément. */
  editable: Record<ShopifyField | "translations", boolean>;
  /**
   * Pour chaque champ non modifiable, la raison en français, affichable telle quelle
   * (permission absente, type d'élément non pris en charge, valeur trop longue pour être annulée fidèlement…).
   * Absente pour un champ modifiable. Le mode lecture seule du serveur n'y figure pas : voir `writesEnabled`.
   */
  readOnlyReasons: Partial<Record<ShopifyField | "translations", string>>;
}

/** Une modification écrite dans la boutique par le logiciel. Rien n'est jamais effacé de cet historique. */
export interface ShopifyChange {
  id: string;
  resourceId: string;
  resourceType: ShopifyResourceType;
  resourceTitle: string;
  path: string;
  field: ShopifyField;
  /** Image concernée quand field vaut "image_alt" ; null sinon. */
  image: { id: string; url: string } | null;
  /** Langue modifiée ; null pour la langue principale. */
  locale: string | null;
  /** Valeur lue dans Shopify juste avant l'écriture. null : le champ était vide. */
  before: string | null;
  /** Valeur écrite, relue dans Shopify après l'écriture. null : le champ a été vidé. */
  after: string | null;
  /**
   * false quand Shopify a accepté l'écriture mais que la relecture a échoué : `after` est alors la valeur
   * envoyée, pas une valeur relue. L'interface le signale.
   */
  afterVerified: boolean;
  appliedAt: string;
  /** "edit" : une modification demandée. "restore" : le retour à la valeur d'avant d'une modification précédente. */
  kind: "edit" | "restore";
  /** Pour un "restore", la modification annulée. */
  restoresChangeId: string | null;
  /** Modification qui a annulé celle-ci ; null si elle est toujours en place. */
  restoredByChangeId: string | null;
  /** Lot de corrections auquel cette modification appartient ; null pour une modification isolée. */
  batchId: string | null;
  /**
   * true si cette modification peut être annulée : c'est la dernière faite sur ce champ (même élément,
   * même image, même langue) et elle n'a pas déjà été annulée.
   */
  restorable: boolean;
  /**
   * Où en est cette correction. null pour une ligne "restore" (une annulation n'est pas une correction).
   * "applied" : écrite dans Shopify, pas encore vérifiée sur la page publique, ou vérification sans conclusion
   * (voir `verification`). "verifying" : la page publique va être ou est en train d'être relue.
   * "verified" : la page publique affiche la valeur et le critère de l'analyse est validé.
   * "failed" : la page publique a été relue, et la valeur n'y est pas ou le critère n'est toujours pas validé.
   * "cancelled" : la modification a été annulée (`restoredByChangeId`).
   * Une écriture acceptée par Shopify n'est jamais "verified" d'office.
   */
  correctionStatus: ShopifyCorrectionStatus | null;
  /** Dernière relecture de la page publique pour cette correction ; null si aucune n'a eu lieu. */
  verification: ShopifyVerification | null;
}

export type ShopifyCorrectionStatus = "applied" | "verifying" | "verified" | "failed" | "cancelled";

/**
 * Résultat d'une relecture de la page publique après une correction, avec la même grille que l'analyse.
 * Chaque relecture est conservée ; seule la plus récente est renvoyée ici.
 */
export interface ShopifyVerification {
  checkedAt: string;
  /** "inconclusive" : la relecture n'a pas pu conclure (page non chargée, langue non relue…). La correction reste "applied". */
  outcome: "verified" | "failed" | "inconclusive";
  /**
   * "ok" : valeur affichée et critère validé. "not_displayed" : la page n'affiche pas la valeur écrite (souvent un
   * délai de mise à jour de la boutique, ou un thème qui n'utilise pas ce champ). "criterion_failing" : la valeur
   * est affichée mais le critère n'est pas validé. "page_unavailable" : la page n'a pas pu être chargée, ou ce
   * n'est pas la page attendue. "not_supported" : ce type de correction n'est pas encore vérifiable (traduction).
   * "image_not_found" : l'image n'a pas été retrouvée dans la page.
   */
  reason: "ok" | "not_displayed" | "criterion_failing" | "page_unavailable" | "not_supported" | "image_not_found";
  /** Explication en français, affichable telle quelle. */
  message: string;
  /** Adresse publique relue ; null si aucune page n'a été chargée. */
  url: string | null;
  /** La page affiche-t-elle la valeur écrite ? null si la question ne se pose pas (champ vidé, page non chargée). */
  displayed: boolean | null;
  /** Ce que la page affiche réellement pour ce champ (titre, description ou texte alternatif), 300 caractères au plus. */
  rendered: string | null;
  /**
   * Le critère de la grille visé par la correction ("title", "meta_description" ou "image_alt") : son verdict dans
   * l'analyse affichée au moment de la relecture (`before`, null si la page n'y figurait pas) et sur la page relue.
   * null si aucune page n'a été analysée.
   */
  criterion: { id: string; label: string; before: CheckStatus | null; after: CheckStatus; points: number; max: number; message: string } | null;
  /** Note de la page : dans l'analyse affichée (`before`, null si absente) et sur la page relue. null si non analysée. */
  pageScore: { before: number | null; after: number } | null;
}

/** GET /api/sites/:siteId/shopify/resources?type=&q=&missing=&offset=&limit= */
export interface ShopifyResourcesResponse { resources: ShopifyResourceSummary[]; total: number; offset: number; limit: number }
export interface ShopifyResourceResponse { resource: ShopifyResourceDetail }

/**
 * POST /api/sites/:siteId/shopify/changes — écrit une valeur dans la boutique.
 * `expectedBefore` est la valeur que l'utilisateur avait sous les yeux : si Shopify en contient une autre
 * au moment d'écrire, rien n'est écrit et le serveur répond "shopify_conflict".
 */
export interface ShopifyChangeRequest {
  resourceId: string;
  field: ShopifyField;
  /** Obligatoire quand field vaut "image_alt". */
  imageId?: string;
  /** Langue à modifier ; absente ou null pour la langue principale. Jamais avec "image_alt". */
  locale?: string | null;
  /** Texte brut. null ou vide : vider le champ. */
  value: string | null;
  expectedBefore: string | null;
}
/** Réponse à une écriture ou à une annulation : la modification enregistrée et l'élément relu dans Shopify. */
export interface ShopifyChangeResponse { change: ShopifyChange; resource: ShopifyResourceDetail }
/** GET /api/sites/:siteId/shopify/changes?offset=&limit= — la plus récente d'abord. */
// ───────────────────────── Évolution et rapport ─────────────────────────

/** Une analyse terminée, telle qu'elle compte dans l'évolution. */
export interface ProgressPoint {
  auditId: string;
  finishedAt: string;
  /** Note sur 100 de cette analyse, sur toutes ses pages. */
  score: number;
  pagesAnalyzed: number;
  maxPages: number;
  issues: { critical: number; warning: number; info: number };
}

/**
 * GET /api/sites/:siteId/progress — évolution du site entre sa première analyse terminée et la dernière.
 * Rien n'est estimé : ce qui ne peut pas être calculé vaut null.
 */
export interface Progress {
  /** false tant qu'aucune analyse n'est terminée : tous les autres champs sont alors null ou vides. */
  available: boolean;
  /** Première analyse terminée du site. */
  initial: ProgressPoint | null;
  /** Dernière analyse terminée. Égale à `initial` s'il n'y en a qu'une. */
  current: ProgressPoint | null;
  /** Toutes les analyses terminées, de la plus ancienne à la plus récente, 50 au plus (les plus récentes). */
  timeline: ProgressPoint[];
  /**
   * Comparaison à périmètre égal entre `initial` et `current` : seulement les pages présentes dans les deux
   * analyses, avec la même grille. null s'il n'y a qu'une analyse terminée, si aucune page n'est commune, ou si
   * le détail des pages de la première analyse n'est plus en base.
   */
  comparison: {
    pagesInCommon: number;
    /** Pages de `initial` absentes de `current`, et l'inverse : elles n'entrent pas dans la comparaison. */
    pagesOnlyInitial: number;
    pagesOnlyCurrent: number;
    /** Note moyenne des pages communes, dans chaque analyse. */
    scoreInitial: number;
    scoreCurrent: number;
    /** Un problème = un critère en défaut (« à améliorer » ou « en échec ») sur une page commune. */
    issuesFixed: number;
    issuesRemaining: number;
    /** En défaut dans `current` alors que le critère était validé dans `initial`. */
    issuesNew: number;
  } | null;
  /** Corrections appliquées dans la boutique depuis la création du site (lignes « restore » exclues). */
  corrections: {
    /** Statut de correction actuel de chaque modification (`ShopifyChange.correctionStatus`). */
    verified: number;
    /** « Appliquée » ou « en cours de vérification » : en place mais sans preuve sur la page publique. */
    applied: number;
    failed: number;
    cancelled: number;
    /** Éléments de la boutique (produits, collections, pages, articles) qui ont au moins une correction vérifiée. */
    resourcesOptimized: number;
    /** Date de la première et de la dernière correction encore en place. null s'il n'y en a aucune. */
    firstAt: string | null;
    lastAt: string | null;
  };
}
export interface ProgressResponse { progress: Progress }

export interface ShopifyChangesResponse { changes: ShopifyChange[]; total: number; offset: number; limit: number }
/**
 * POST /api/sites/:siteId/shopify/changes/:changeId/verify — relit la page publique de cette correction.
 * Aucune écriture dans la boutique : la route fonctionne aussi quand les écritures sont désactivées.
 * La réponse arrive quand la relecture est terminée.
 */
export interface ShopifyVerifyResponse { change: ShopifyChange }

// ───────────────────────── Lots de corrections ─────────────────────────

/** Qui a préparé une proposition : l'utilisateur, l'assistant dans la conversation, ou l'optimisation automatique. */
export type ProposalOrigin = "manual" | "assistant" | "automation";

export interface ShopifyBatchItem {
  id: string;
  resourceId: string;
  resourceType: ShopifyResourceType;
  resourceTitle: string;
  path: string;
  field: ShopifyField;
  image: { id: string; url: string } | null;
  locale: string | null;
  /** Valeur lue dans Shopify quand la proposition a été préparée. C'est elle qui sera comparée avant d'écrire. */
  before: string | null;
  /** Valeur proposée, modifiable tant que le lot est un brouillon. */
  proposed: string;
  /** Pourquoi cette proposition, en une phrase (rédigée par l'IA pour "assistant" et "automation") ; null sinon. */
  note: string | null;
  /** false : l'utilisateur a écarté cette ligne, elle ne sera pas écrite. */
  selected: boolean;
  /**
   * "pending" : pas encore écrite. "applied" : écrite (voir changeId). "conflict" : la valeur avait changé dans
   * Shopify, rien n'a été écrit. "failed" : Shopify a refusé (voir error). "skipped" : écartée. "restored" : écrite puis annulée.
   */
  state: "pending" | "applied" | "conflict" | "failed" | "skipped" | "restored";
  changeId: string | null;
  /** Statut de la correction écrite par cette ligne (celui de `ShopifyChange.correctionStatus`) ; null tant que rien n'est écrit. */
  correctionStatus: ShopifyCorrectionStatus | null;
  error: string | null;
  /** true si cette ligne a été écrite sans validation humaine, par la règle d'automatisation. */
  autoApplied: boolean;
}

export interface ShopifyBatchSummary {
  id: string;
  title: string;
  origin: ProposalOrigin;
  createdAt: string;
  /**
   * "preparing" : l'IA rédige les propositions. "draft" : à relire et valider. "applying" : écriture en cours,
   * une valeur après l'autre. "applied" : toutes les lignes retenues sont écrites. "partial" : certaines lignes
   * sont en conflit ou en échec. "cancelled" : abandonné sans rien écrire. "restored" : tout a été annulé.
   * "failed" : la préparation a échoué (voir error).
   */
  state: "preparing" | "draft" | "applying" | "applied" | "partial" | "cancelled" | "restored" | "failed";
  /** true si au moins une ligne du lot a été écrite sans validation humaine (voir `ShopifyBatchItem.autoApplied`). */
  autoApplied: boolean;
  counts: { total: number; selected: number; applied: number; conflict: number; failed: number; restored: number };
  error: ApiError["error"] | null;
  finishedAt: string | null;
}

export interface ShopifyBatch extends ShopifyBatchSummary {
  /** Au plus 50 lignes. */
  items: ShopifyBatchItem[];
}

/** GET /api/sites/:siteId/shopify/batches — le plus récent d'abord. */
export interface ShopifyBatchesResponse { batches: ShopifyBatchSummary[] }
export interface ShopifyBatchResponse { batch: ShopifyBatch }
/** POST /api/sites/:siteId/shopify/batches — crée un brouillon ; le serveur lit lui-même les valeurs actuelles. */
export interface CreateBatchRequest {
  title?: string;
  items: Array<{ resourceId: string; field: ShopifyField; imageId?: string; locale?: string | null; value: string }>;
}
/** PATCH /api/sites/:siteId/shopify/batches/:batchId/items/:itemId — brouillon seulement. */
export interface UpdateBatchItemRequest { proposed?: string; selected?: boolean }
/**
 * POST /api/sites/:siteId/shopify/optimize — demande à l'IA de préparer un lot pour un champ.
 * Répond tout de suite (202) avec le lot en "preparing" ; la suite arrive par l'événement `shopify`.
 */
export interface OptimizeRequest {
  field: "seo_title" | "seo_description" | "image_alt";
  resourceType?: ShopifyResourceType;
  /** Nombre de propositions demandé ; borné par la règle d'automatisation. */
  limit?: number;
}

// ───────────────────────── Automatisation ─────────────────────────

/** Règle d'autorisation de tout ce que l'IA prépare ou applique (assistant et optimisation automatique). */
export interface AutomationPolicy {
  /**
   * "off" : l'IA ne prépare aucune correction. "propose" : elle prépare des lots, un humain les valide.
   * "auto" : les lots de « Préparer des corrections avec l'IA » (`optimize`) sont appliqués seuls, dans les
   * limites ci-dessous ; exige en plus l'accord du serveur (`autoAllowed`). Les lots préparés par l'assistant
   * dans la conversation attendent toujours une validation humaine, quel que soit le mode.
   */
  mode: "off" | "propose" | "auto";
  /** Champs que l'IA a le droit de proposer. */
  fields: ShopifyField[];
  resourceTypes: ShopifyResourceType[];
  /**
   * Ce que l'IA a le droit de remplacer. "empty_only" : seulement un champ vide. "failing" : un champ vide ou
   * jugé en défaut par l'analyse. "any" : n'importe quelle valeur.
   */
  scope: "empty_only" | "failing" | "any";
  /** L'IA peut-elle proposer des traductions. */
  translations: boolean;
  /** Lignes au plus par lot préparé par l'IA. */
  maxChangesPerRun: number;
  /** Écritures au plus par jour appliquées sans validation humaine (mode "auto"). */
  maxAutoChangesPerDay: number;
  /** Jetons d'IA au plus par jour pour « Préparer des corrections avec l'IA » (entrée + sortie). Ne limite pas la conversation avec l'assistant. */
  aiTokensPerDay: number;
}

/** GET /api/sites/:siteId/automation */
export interface AutomationState {
  policy: AutomationPolicy;
  /** Bornes acceptées pour les trois plafonds. */
  limits: { maxChangesPerRun: { min: number; max: number }; maxAutoChangesPerDay: { min: number; max: number }; aiTokensPerDay: { min: number; max: number } };
  /** Le serveur autorise le mode "auto" (SHOPIFY_AUTO_APPLY=1). Sans lui, "auto" se comporte comme "propose". */
  autoAllowed: boolean;
  /** Le serveur accepte d'écrire dans la boutique (SHOPIFY_WRITES_ENABLED=1). */
  writesEnabled: boolean;
  /** Une clé d'API Claude est configurée : sans elle, l'IA ne peut rien préparer. */
  aiConfigured: boolean;
  /** Consommation du jour (jour UTC). */
  usage: { day: string; autoChanges: number; aiTokens: number; resetsAt: string };
}
/** PUT /api/sites/:siteId/automation */
export interface UpdateAutomationRequest { policy: AutomationPolicy }

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
  /** Lots de corrections que l'assistant a préparés (ou appliqués) dans cette réponse. Vide le plus souvent. */
  batchIds: string[];
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
    /** `writesEnabled` : le serveur accepte d'écrire dans la boutique (SHOPIFY_WRITES_ENABLED=1). */
    shopify: { configured: boolean; writesEnabled: boolean };
    /** Compte de service Google présent côté serveur : la Search Console peut être lue directement. */
    searchConsole: { configured: boolean };
    /** Identifiants DataForSEO présents côté serveur. Aucune fonctionnalité ne s'en sert encore. */
    dataForSeo: { configured: boolean };
    /** Compte de service Google et identifiant de propriété GA4 présents : les visites peuvent être lues. */
    analytics: { configured: boolean };
    /** Clé PageSpeed Insights présente : la vitesse des pages peut être mesurée. */
    pageSpeed: { configured: boolean };
  };
  /**
   * Sections facultatives présentes. Mode local : toutes `true`. Mode intégré : `false` sauf celles ouvertes par
   * `EMBEDDED_FEATURES` ; une section à `false` n'est pas affichée et ses routes répondent `not_in_embedded_mode`.
   */
  features: { competitors: boolean; analytics: boolean; pageSpeed: boolean; assistant: boolean; searchConsoleSync: boolean };
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
  | { type: "search_console"; available: boolean }
  /** La boutique Shopify a été relue ou modifiée, ou une correction vient d'être vérifiée : l'interface recharge ce qu'elle affiche de la boutique. */
  | { type: "shopify" }
  /** Les visites Google Analytics ont été relues. */
  | { type: "analytics" }
  /** Une mesure de vitesse a avancé ou s'est terminée. */
  | { type: "pagespeed" };

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
