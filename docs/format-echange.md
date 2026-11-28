# Format d'échange entre le moteur et l'interface

Ce document et `shared/api.ts` sont la référence. Seul l'agent principal les modifie. Si un champ manque ou gêne, le signaler plutôt que de le contourner.

- **Types** : `shared/api.ts` (importé par `server/` et par `web/`).
- **Exemples de données** : `docs/exemples/exemples.json`, une entrée par route, pour un site fictif (`atelier-lune.example`).

## Conventions

- Toutes les routes sont sous `/api`. Requêtes et réponses en JSON, sauf le dépôt de fichier (multipart) et les deux flux SSE.
- Dates en ISO 8601 UTC ; jours au format `AAAA-MM-JJ`.
- Une donnée absente vaut `null`. Une section sans données répond `available: false`. **Jamais de valeur de remplissage ni d'estimation.**
- Erreur : statut HTTP 4xx ou 5xx et corps `ApiError` — un `code` stable, un `message` en français affichable tel quel, une `action` (ce que l'utilisateur peut faire) ou `null`.
- Les textes venus d'un site, d'un fichier ou de l'assistant sont du texte brut. L'interface ne les interprète jamais comme du HTML.
- Pas de comptes dans cette version : un seul espace de travail, plusieurs sites. En mode intégré (`SHOPIFY_APP_MODE=embedded`), chaque requête est en plus identifiée par un jeton de session Shopify : voir « Application intégrée à Shopify ».
- Les réponses `GET` portent un en-tête `ETag` ; le serveur répond `304` à un `If-None-Match` identique.

## Routes

| Méthode et chemin | Corps envoyé | Réponse | Notes |
|---|---|---|---|
| `GET /api/health` | | `HealthResponse` | |
| `GET /api/settings` | | `Settings` | Ne renvoie jamais une clé |
| `PATCH /api/settings` | `UpdateSettingsRequest` | `Settings` | |
| `GET /api/sites` | | `SitesResponse` | Du plus récent au plus ancien |
| `POST /api/sites` | `CreateSiteRequest` | `201 SiteResponse` | Crée le site **et lance la première analyse**. L'adresse est acceptée sans `https://`. Le serveur vérifie que le site répond avant de créer (`site_unreachable` sinon). `site_exists` si l'hôte est déjà suivi |
| `GET /api/sites/:siteId` | | `SiteResponse` | |
| `DELETE /api/sites/:siteId` | | `204` | Supprime le site et toutes ses données |
| `POST /api/sites/:siteId/audits` | `StartAuditRequest` | `202 AuditResponse` | Relance une analyse. `audit_running` si une analyse tourne déjà |
| `POST /api/sites/:siteId/audits/cancel` | | `AuditResponse` | Arrête l'analyse en cours ; les pages déjà notées sont conservées |
| `GET /api/sites/:siteId/events` | | flux SSE de `SiteEvent` | Voir « Flux en direct » |
| `GET /api/sites/:siteId/overview` | | `Overview` | Lisible pendant l'analyse : reflète les pages déjà notées |
| `GET /api/sites/:siteId/progress` | | `ProgressResponse` | Évolution entre la première et la dernière analyse terminée, et bilan des corrections. Voir « Évolution et rapport » |
| `GET /api/sites/:siteId/issues` | | `IssuesResponse` | Problèmes triés par `pointsLost` décroissant |
| `GET /api/sites/:siteId/issues/:issueId` | | `IssueResponse` | Explication, solution, preuves page par page |
| `GET /api/sites/:siteId/pages` | | `PagesResponse` | Paramètres : `sort` (`PageSort`, défaut `score_asc`), `q` (filtre sur le chemin ou le titre), `offset` (défaut 0), `limit` (défaut 50, max 200) |
| `GET /api/sites/:siteId/pages/:pageId` | | `PageResponse` | |
| `GET /api/sites/:siteId/coverage` | | `CoverageResponse` | Inventaire du site par type de page et part réellement analysée |
| `GET /api/sites/:siteId/failed-pages` | | `FailedPagesResponse` | Pages non chargées de l'analyse affichée, avec leur raison |
| `GET /api/sites/:siteId/recommendations` | | `RecommendationsResponse` | Triées par `rank` |
| `GET /api/sites/:siteId/search-console` | | `SearchConsoleData` | |
| `POST /api/sites/:siteId/search-console` | multipart, champ `file` | `SearchConsoleData` | Accepte le `.zip` exporté depuis « Performances » de la Search Console, ou un `.csv` seul (requêtes, pages ou dates), en français ou en anglais. 20 Mo au plus. Remplace l'import précédent |
| `DELETE /api/sites/:siteId/search-console` | | `204` | |
| `GET /api/sites/:siteId/competitors` | | `CompetitorsData` | `available: false` avec sa raison tant que rien n'a été relevé |
| `POST /api/sites/:siteId/competitors` | | `CompetitorsData` | Lance un relevé réel. `competitors_not_configured` sans fournisseur de recherche côté serveur |
| `GET /api/sites/:siteId/chat` | | `ChatState` | |
| `POST /api/sites/:siteId/chat` | `ChatRequest` | flux SSE de `ChatEvent` | `chat_not_configured` (JSON, statut 503) sans clé d'API |
| `DELETE /api/sites/:siteId/chat` | | `204` | Efface la conversation |
| `GET /api/sites/:siteId/shopify` | | `ShopifyState` | Ne lit pas toute la boutique : état de la connexion (vérifiée auprès de Shopify, gardée 60 s) et résumé de la dernière lecture |
| `POST /api/sites/:siteId/shopify/sync` | | `ShopifyState` | Lit tous les produits, collections, pages et articles (lecture seule) et les rapproche des pages analysées. Répond quand c'est fini |
| `GET /api/sites/:siteId/shopify/resources` | | `ShopifyResourcesResponse` | Paramètres : `type` (`ShopifyResourceType`), `q` (nom ou chemin), `missing` (`seo_title`, `seo_description` ou `image_alt` : seulement les éléments où ce champ est vide), `fix` (`seo_title` ou `seo_description` : seulement les éléments dont la page analysée ne valide pas ce critère), `offset`, `limit` (défaut 50, max 200). `shopify_not_synced` avant la première lecture |
| `GET /api/sites/:siteId/shopify/resources/:resourceId` | | `ShopifyResourceResponse` | Relit l'élément en direct dans Shopify, avec ses traductions et son historique |
| `POST /api/sites/:siteId/shopify/changes` | `ShopifyChangeRequest` | `201 ShopifyChangeResponse` | **Écrit dans la boutique.** Voir « Boutique Shopify » |
| `GET /api/sites/:siteId/shopify/changes` | | `ShopifyChangesResponse` | Historique du site, le plus récent d'abord. `offset`, `limit` (défaut 50, max 200) |
| `POST /api/sites/:siteId/shopify/changes/:changeId/restore` | | `201 ShopifyChangeResponse` | **Écrit dans la boutique** : remet la valeur d'avant. Voir « Boutique Shopify » |
| `POST /api/sites/:siteId/search-console/sync` | `{ "days": 28 }` (28, 90 ou 480) | `SearchConsoleData` | Lit la Search Console chez Google par le compte de service. Remplace l'import précédent (`source: "google"`). `search_console_not_configured`, `search_console_no_access`, `search_console_unavailable` |
| `GET /api/sites/:siteId/analytics` | | `AnalyticsData` | Dernière lecture de Google Analytics |
| `POST /api/sites/:siteId/analytics/sync` | `{ "days": 28 }` (28 ou 90) | `AnalyticsData` | Lit Google Analytics (lecture seule). `analytics_not_configured`, `analytics_no_access`, `analytics_other_site`, `analytics_unavailable` |
| `GET /api/sites/:siteId/pagespeed` | | `PageSpeedState` | |
| `POST /api/sites/:siteId/pagespeed` | `MeasureSpeedRequest` | `202 PageSpeedState` | Lance une mesure de vitesse. `pagespeed_not_configured` ; `limit_reached` si une mesure tourne déjà |
| `POST /api/sites/:siteId/pagespeed/cancel` | | `PageSpeedState` | Arrête la mesure en cours ; les pages déjà mesurées sont gardées |
| `GET /api/sites/:siteId/shopify/batches` | | `ShopifyBatchesResponse` | Lots de corrections, le plus récent d'abord |
| `POST /api/sites/:siteId/shopify/batches` | `CreateBatchRequest` | `201 ShopifyBatchResponse` | Crée un brouillon. N'écrit rien dans la boutique |
| `GET /api/sites/:siteId/shopify/batches/:batchId` | | `ShopifyBatchResponse` | |
| `PATCH /api/sites/:siteId/shopify/batches/:batchId/items/:itemId` | `UpdateBatchItemRequest` | `ShopifyBatchResponse` | Brouillon seulement (`batch_not_editable` sinon) |
| `POST /api/sites/:siteId/shopify/batches/:batchId/apply` | | `202 ShopifyBatchResponse` | **Écrit dans la boutique** les lignes retenues, une par une. Voir « Lots de corrections » |
| `POST /api/sites/:siteId/shopify/batches/:batchId/restore` | | `202 ShopifyBatchResponse` | **Écrit dans la boutique** : annule chaque ligne écrite encore annulable |
| `POST /api/sites/:siteId/shopify/batches/:batchId/stop` | | `ShopifyBatchResponse` | Arrête une écriture ou une annulation en cours après la ligne en cours ; le lot passe `partial`, rien n'est perdu |
| `DELETE /api/sites/:siteId/shopify/batches/:batchId` | | `ShopifyBatchResponse` | Abandonne un brouillon (`cancelled`) ; le lot reste consultable |
| `POST /api/sites/:siteId/shopify/optimize` | `OptimizeRequest` | `202 ShopifyBatchResponse` | Demande à l'IA de préparer un lot. Voir « Automatisation » |
| `GET /api/sites/:siteId/automation` | | `AutomationState` | |
| `PUT /api/sites/:siteId/automation` | `UpdateAutomationRequest` | `AutomationState` | |

**Quelle analyse est affichée.** `overview`, `issues`, `pages`, `failed-pages` et `recommendations` portent toujours sur l'analyse désignée par `SiteSummary.results` : la dernière analyse terminée ; à défaut (première analyse en cours, ou jamais terminée), la plus récente qui a au moins une page notée. Une analyse en cours, arrêtée ou en échec ne remplace jamais une analyse terminée : pendant une relance, les résultats précédents restent affichés et `SiteSummary.audit` décrit la nouvelle analyse. Avant la première page notée, `results` et `overview.score` valent `null` et les listes sont vides — l'interface dit alors « aucune page analysée », jamais « aucun problème ».

**Couverture d'une analyse.** Avant de charger les pages, le serveur dresse l'inventaire du site à partir de son sitemap et classe chaque adresse par type (`PageType`). Seule la langue principale est analysée ; les autres versions de langue sont signalées dans `otherLocales`, ni analysées ni comptées. Quand le plafond est inférieur à l'inventaire, le parcours est équilibré : l'accueil d'abord, puis les types à tour de rôle, pour que chaque type soit représenté. Sur une boutique Shopify, les produits dont la page n'a pas été ouverte sont lus dans le catalogue public (`/products.json`) : titre, description, images, doublons. Ces constats portent `basis: "catalogue"`, n'entrent jamais dans la note et le disent. La note du site est la moyenne des pages ouvertes en entier ; `Coverage` dit toujours sur combien de pages elle repose, et `fullAuditMaxPages` donne le plafond à demander pour tout ouvrir. Une analyse ouvre au plus 100 pages (plafond par défaut et maximum) ; au-delà, `fullAuditMaxPages` vaut `null` et les produits restants sont lus dans le catalogue.

**Fin d'une analyse.** Arrêt demandé par l'utilisateur : `cancelled`, même avant la première page. Aucune page notée sans arrêt demandé : `failed`. Arrêt ou redémarrage du serveur : `failed` avec un message qui le dit. Sinon `done`, même avec des pages en échec ; l'interface signale une note peu fiable quand `pagesFailed > pagesDone`.

**Les points.** Seuls `Issue.scoreImpact` et `Recommendation.scoreGain` s'affichent : ce sont des points sur la note du site, sur 100. `pointsLost` et `pointsToGain` sont des sommes brutes réservées au tri.

## Boutique Shopify

Le serveur se connecte à une seule boutique, celle des variables `SHOPIFY_*`. Elle n'est proposée que sur le site dont l'hôte est le domaine public de cette boutique ; sur les autres sites, `connection.state` vaut `other_shop` (ou `not_configured`) et toutes les routes `shopify/…` sauf la première répondent par l'erreur correspondante.

**Lecture.** `sync` lit la boutique sans rien y écrire et garde en base, par élément : son type, son chemin public, son nom, son titre et sa description pour Google, le nombre d'images et celles sans texte alternatif. Chaque élément est rapproché de la page analysée de même chemin (`pageId`). Le détail d'un élément est toujours relu en direct : c'est la valeur actuelle de la boutique, pas une copie.

**Écriture : trois garde-fous.**

1. `SHOPIFY_WRITES_ENABLED=1` doit être présent côté serveur. Sans lui, les deux routes d'écriture répondent `shopify_writes_disabled` (statut 403) avant tout appel à Shopify. C'est l'état par défaut.
2. Une écriture ne part que d'une demande explicite de l'utilisateur pour **une** valeur. Il n'y a ni écriture en lot ni écriture automatique. L'interface montre l'avant et l'après et demande une confirmation.
3. Avant d'écrire, le serveur relit la valeur dans Shopify. Si elle diffère de `expectedBefore` (ou, pour une annulation, de la valeur que la modification avait écrite), il n'écrit rien et répond `shopify_conflict` (statut 409) ; `details.current` porte la valeur actuelle.

Après l'écriture, le serveur relit la valeur, enregistre la modification (`before`, `after` relu) et émet l'événement `shopify`. Si la valeur demandée est déjà en place, rien n'est écrit ni enregistré : la réponse est `bad_request` avec un message qui le dit.

**Ce qui est modifiable.** `seo_title` et `seo_description` sur les quatre types ; `image_alt` sur les images des produits seulement (l'image d'une collection ou d'un article est affichée mais non modifiable tant que son écriture n'a pas été vérifiée sur une boutique d'essai : Shopify peut remplacer ou retirer l'image ; `readOnlyReasons` le dit) ; les traductions de `seo_title` et `seo_description` dans les langues publiées, quand Shopify le permet (`ShopifyTranslation.editable`). Le texte est normalisé (espaces en trop retirés) et jamais transformé autrement : une valeur qui contient `<` ou `>`, un caractère de contrôle, ou qui dépasse la longueur maximale (255 caractères pour un titre, 500 pour une description, 512 pour un texte alternatif) est refusée par `shopify_invalid_value` (statut 422), rien n'est écrit. L'interface applique la même règle avant la confirmation : ce qu'elle montre est exactement ce qui sera écrit. Un champ dont la valeur actuelle n'a pas pu être lue en entier n'est pas modifiable (l'annulation ne serait pas fidèle).

**Écriture ciblée.** Titre et description passent, pour les quatre types, par les champs `global.title_tag` et `global.description_tag` avec écriture conditionnelle : Shopify refuse lui-même si la valeur a changé depuis la relecture, et l'autre champ n'est jamais touché.

**Journal avant écriture.** La valeur d'avant et la valeur demandée sont enregistrées avant l'appel à Shopify. Si Shopify refuse, l'entrée est marquée en échec et n'apparaît pas dans l'historique. Si Shopify accepte mais que la relecture échoue, la modification apparaît avec `afterVerified: false` et reste annulable : la réponse n'est jamais « rien n'a été fait » après une écriture acceptée. Une permission absente donne `shopify_missing_scope` et `ShopifyResourceDetail.editable` le dit d'avance.

**Historique et annulation.** Chaque écriture ajoute une ligne à l'historique ; aucune ligne n'est modifiée ni supprimée, même à la suppression du site de la boutique. Annuler une modification écrit sa valeur `before` et ajoute une ligne `kind: "restore"`. Seule la dernière modification d'un champ est annulable (`restorable`) ; annuler une annulation rétablit la valeur.

**Lien avec l'analyse.** `PageDetail.shopifyResourceId` et `Evidence.shopifyResourceId` relient une page analysée à son élément Shopify ; `IssueDetail.shopifyField` dit quel champ corrige le problème. Une modification ne change pas la note affichée : l'analyse reflète le site au moment où elle a tourné, et l'interface invite à la relancer. La vérification d'une correction (ci-dessous) relit une seule page et ne touche pas à l'analyse.

**Vérification d'une correction.** Une écriture acceptée par Shopify n'est pas une correction SEO vérifiée. Après chaque modification (`kind: "edit"`) de la langue principale, le serveur recharge la page publique de l'élément et lui applique la même grille que l'analyse (`analysePage`), sans rien écrire nulle part ailleurs que dans son journal de vérifications. `ShopifyChange.correctionStatus` porte l'état, `ShopifyChange.verification` la dernière relecture (type `ShopifyVerification`).

| Statut affiché | Source |
|---|---|
| Problème détecté | un problème de l'analyse (`IssueDetail`) |
| Correction proposée | une ligne de lot `state: "pending"` dans un lot `draft` |
| Correction appliquée | `correctionStatus: "applied"` (ou `"verifying"` : vérification en cours) |
| Correction vérifiée | `correctionStatus: "verified"` |
| Correction échouée | `correctionStatus: "failed"` |
| Correction annulée | `correctionStatus: "cancelled"` |

Règles de la relecture :

- **Quand.** Automatiquement, une quinzaine de secondes après l'écriture, une page à la fois et espacées. Si la page n'affiche pas encore la valeur (`not_displayed`), une seconde relecture a lieu environ deux minutes plus tard ; pendant cette attente le statut reste `"verifying"`. À la demande ensuite : `POST …/shopify/changes/:changeId/verify` (10 par minute au plus, et refusée tant que plus de cinq relectures attendent : `rate_limited` ; 20 relectures au plus par modification). Après un redémarrage du serveur, les relectures en attente sont perdues : la correction reste `"applied"` et se vérifie à la demande.
- **La bonne page.** La page chargée ne compte que si elle répond 200 en HTML et que son adresse de référence (canonique) désigne le chemin de l'élément. Sinon : `inconclusive` / `page_unavailable` (page de contrôle anti-robot, redirection, erreur) et la correction reste `"applied"`.
- **Titre et description.** `displayed` : le titre affiché contient la valeur écrite (un thème peut y ajouter le nom de la boutique) ; la description affichée est la valeur écrite. `verified` si `displayed` et si le critère (`title` ou `meta_description`) est `"pass"` sur la page relue. Valeur affichée mais critère non validé : `failed` / `criterion_failing`. Tant que la page affiche encore l'ancienne valeur à sa place (au début du titre, ou description identique) sans que la nouvelle l'explique, le résultat est `not_displayed` : rien ne prouve que la page est à jour. Pour un champ vidé dans ce cas, l'issue est `inconclusive` (Shopify peut afficher de lui-même le même texte) et la correction reste `"applied"`. Champ vidé (`after: null`) : `displayed` vaut null ; une fois l'ancienne valeur disparue, seul le critère décide.
- **Texte alternatif.** L'image est retrouvée dans la page par son dossier et son nom de fichier. `verified` si elle porte le texte écrit ; le critère `image_alt`, qui compte toutes les images de la page, est donné pour information dans `criterion` et ne décide pas. Image absente de la page : `inconclusive` / `image_not_found`.
- **Traduction.** Pas encore vérifiable (l'analyse ne lit pas les adresses des autres langues) : `inconclusive` / `not_supported`, sans charger de page.
- **Seule la dernière modification d'un champ se vérifie.** Une modification remplacée ou annulée n'est plus relue (`bad_request` à la demande). Une ligne `restore` n'a ni statut ni vérification.
- **Rien d'autre ne change.** La relecture ne modifie ni l'analyse affichée ni sa note : `criterion.before` et `pageScore.before` viennent de l'analyse affichée, `after` de la page relue. Le texte lu sur la page est une donnée non fiable, affichée comme du texte.
- Une relecture qui se termine après l'annulation ou le remplacement de la modification n'est pas enregistrée.
- Une ligne de lot écrite porte le même statut : `ShopifyBatchItem.correctionStatus`.
- Chaque relecture terminée émet l'événement `shopify`.

**Limites.** 30 écritures par minute et une lecture complète (`sync`) par minute au plus (`rate_limited`). L'historique et la liste des éléments, stockés par le logiciel, restent consultables quand Shopify ne répond pas.

**Statuts des erreurs.** `shopify_not_configured` 503 ; `shopify_other_shop` et `shopify_not_synced` 409 (`details.shopHost` : domaine public de la boutique connectée) ; `shopify_writes_disabled` et `shopify_missing_scope` 403 ; `shopify_conflict` 409 ; `shopify_unavailable` 502 avec `details.retryable` ; `shopify_invalid_value` 422 ; un champ non modifiable sur cet élément (texte alternatif d'une image de collection, d'article ou de page) : `bad_request` 400, avant tout appel à Shopify ; un refus de Shopify sur la valeur elle-même : `bad_request` 422, avec le message de Shopify en clair.

**Limite connue.** Les éléments non publiés (brouillons) sont lus et comptés comme les autres : le format ne porte pas encore leur statut.

## Lots de corrections

Un lot regroupe au plus 50 propositions (élément, champ, valeur proposée). Il existe pour relire et valider plusieurs corrections d'un coup, jamais pour contourner les garde-fous : chaque ligne passe par le même chemin d'écriture qu'une modification isolée.

- **Préparation.** À la création, le serveur lit la valeur actuelle de chaque champ (`before`) et valide la valeur proposée (mêmes règles : `shopify_invalid_value`). Une ligne dont la valeur proposée est déjà en place est refusée. Deux lignes ne peuvent pas viser le même champ.
- **Aperçu et validation.** Tant que le lot est un brouillon, chaque ligne montre l'avant et l'après, peut être corrigée (`proposed`) ou écartée (`selected: false`). Rien n'est écrit.
- **Application.** `apply` exige `SHOPIFY_WRITES_ENABLED=1`, répond tout de suite (`applying`) puis écrit les lignes retenues une par une, au rythme de la limite d'écriture. Avant chaque ligne, la valeur est relue : si elle n'est plus `before`, la ligne passe en `conflict` et le lot continue. Chaque ligne écrite devient une modification de l'historique (`ShopifyChange.batchId`). L'événement `shopify` est émis à chaque ligne. Un arrêt du serveur laisse le lot en `partial` : les lignes déjà écrites sont dans l'historique, les autres restent `pending`.
- **Annulation.** `restore` annule, une par une, les lignes écrites encore annulables ; une ligne dont la valeur a changé depuis reste telle quelle et le dit. Chaque modification d'un lot reste aussi annulable seule depuis l'historique.

## Automatisation

Trois niveaux, du plus prudent au plus autonome : l'IA ne prépare rien (`off`), l'IA prépare et un humain valide (`propose`), l'IA applique seule dans des limites (`auto`). La règle (`AutomationPolicy`) s'applique à tout ce que l'IA prépare : l'outil de l'assistant comme `optimize`. Elle ne s'applique pas aux lots que l'utilisateur compose lui-même.

**Quatre verrous pour qu'une écriture parte sans validation humaine**, tous nécessaires :

1. `SHOPIFY_WRITES_ENABLED=1` côté serveur ;
2. `SHOPIFY_AUTO_APPLY=1` côté serveur (`autoAllowed`) — sans lui, le mode `auto` se comporte comme `propose` ;
3. `policy.mode` vaut `auto` ;
4. la ligne respecte la règle (champ, type d'élément, `scope`, traductions), le filtre de contenu et le plafond d'écritures automatiques du jour.

Les quatre verrous sont revérifiés **juste avant chaque écriture**, après toute attente : passer la règle sur `off` arrête un lot automatique à la ligne suivante. Seuls les lots de `optimize` peuvent être appliqués sans validation ; **un lot préparé par l'assistant attend toujours une validation humaine**, parce que la conversation mêle des pages web et des requêtes de recherche, contenus non fiables.

**Filtre de contenu des écritures automatiques.** Une proposition de l'IA appliquée sans relecture est refusée (elle reste dans le lot, à valider par un humain) si elle contient une adresse web, un nom de domaine, une adresse e-mail ou un numéro de téléphone, ou si elle ne reprend aucun mot significatif du nom de l'élément. Pour toutes les écritures, humaines comprises, les caractères invisibles de mise en forme (catégorie Unicode Cf) sont refusés par `shopify_invalid_value`.

Par défaut : `mode: "propose"`, champs `seo_description` seulement, types `product` et `collection`, `scope: "empty_only"`, pas de traductions, 10 lignes par lot, 20 écritures automatiques par jour, 200 000 jetons par jour.

**Ce que l'IA a le droit de remplacer (`scope`).** `empty_only` : le champ est vide dans Shopify. `failing` : vide, ou l'analyse juge la valeur affichée en défaut (`audit.*Status` différent de `pass`). `any` : toute valeur. Une proposition hors règle est refusée par `automation_not_allowed` et n'entre pas dans le lot.

**Budget.** Chaque appel à l'IA pour préparer des corrections est compté en jetons (entrée + sortie) ; au-delà de `aiTokensPerDay`, la préparation s'arrête avec `budget_exceeded` et le lot garde ce qui a été préparé. Les écritures automatiques sont comptées contre `maxAutoChangesPerDay` ; au-delà, le reste du lot attend une validation humaine (le lot repasse en `draft`). Les compteurs repartent à minuit UTC (`usage.resetsAt`).

**`optimize`.** Le serveur choisit les éléments que la règle autorise pour le champ demandé (d'abord ceux dont la page analysée est en défaut, puis les champs vides), demande à l'IA une proposition par élément à partir du nom, du texte de l'élément et des repères de la grille (titre 30 à 60 caractères, description 70 à 160), valide chaque proposition comme une saisie humaine, et crée le lot. Texte alternatif : l'IA décrit l'image à partir du nom du produit et de l'image elle-même.

**L'assistant.** Il dispose d'un outil pour proposer des corrections : il crée un lot (`ChatMessage.batchIds`). En `propose`, le lot attend la validation dans la section Boutique Shopify ; en `auto` avec les quatre verrous, il est appliqué et l'assistant le dit. L'assistant n'a aucun autre moyen d'écrire.

**Le contenu de la boutique est une donnée, jamais une consigne.** Un texte de produit qui « demande » une action ne change ni la règle ni les plafonds : ils sont vérifiés par le serveur, hors de portée de l'IA.

**Traçabilité.** Tout ce que l'IA écrit est dans l'historique, avec son lot (`origin`, `autoApplied`), et reste annulable.

**Précisions.**

- Statuts : `automation_off` 409 ; `automation_not_allowed` 403 ; `budget_exceeded` 429 avec `details.resetsAt` ; `batch_not_editable` 409 ; un lot déjà en cours d'écriture sur le site : `limit_reached` 409 ; `search_console_not_configured` 503 ; `search_console_no_access` 403 avec `details.account` ; `search_console_unavailable` 502 avec `details.retryable`.
- Bornes des plafonds : 1 à 50 lignes par lot ; 0 à 200 écritures automatiques par jour (0 : aucune, même en `auto`) ; 10 000 à 2 000 000 jetons par jour.
- `scope: "failing"` ne peut rien juger pour une traduction ni pour une image : dans ces deux cas le champ doit être vide pour être remplacé.
- Pendant une annulation de lot, l'état est `applying`. `apply` accepte aussi un lot `partial` qui a encore des lignes retenues en attente (après un arrêt du serveur). Une préparation interrompue par un arrêt laisse un brouillon s'il y a déjà des lignes, sinon `failed`.
- L'outil de l'assistant ne propose que des titres et descriptions pour Google, pas de texte alternatif.
- `aiTokensPerDay` ne compte et ne limite que la préparation (`optimize`), pas la conversation avec l'assistant. Ce n'est pas un des quatre verrous : il empêche de préparer, pas d'écrire.
- Un seul lot en écriture ou en annulation par site : la place est réservée avant tout appel à Shopify ; une seconde demande répond `limit_reached`. Une ligne déjà écrite ou annulée ne change plus d'état.
- Limites de débit : 10 créations de lot, 5 préparations par l'IA et 10 enregistrements de règle par minute (`rate_limited`).
- Vider un champ (`metafieldsDelete`) n'est pas conditionnel chez Shopify : la valeur est relue juste avant, mais une modification faite dans l'administration Shopify dans la même seconde serait effacée.
- Search Console : la période lue se termine deux jours avant la date du jour (retard de publication de Google). Avec `source: "google"`, `PageDetail.queries` vaut `[]` pour une page sans requête ; avec un export déposé, `null`.

## Search Console

Deux sources, la plus récente remplace l'autre : l'export déposé (`source: "file"`) ou la lecture directe (`source: "google"`). La lecture directe utilise un compte de service Google dont le fichier JSON est sur le serveur (`GOOGLE_SERVICE_ACCOUNT_FILE`, par défaut `secrets/google-service-account.json` à la racine du dépôt, dossier ignoré par git). Accès en lecture seule (`webmasters.readonly`). La propriété lue est celle de `GSC_PROPERTY`, sinon celle du compte de service qui correspond à l'hôte du site (`sc-domain:hôte`, puis `https://hôte/`). La lecture directe relie les requêtes aux pages : `PageDetail.queries` est alors renseigné. Une lecture par minute au plus.

## Google Analytics

Lecture seule de la propriété Google Analytics 4 désignée par `GA4_PROPERTY_ID`, avec le même compte de service que la Search Console (`GOOGLE_APPLICATION_CREDENTIALS`, portée `analytics.readonly`). Le propriétaire doit avoir ajouté l'adresse du compte de service comme **Lecteur** de la propriété ; sinon `analytics_no_access` (statut 403) avec `details.account`. La Search Console dit ce qui se passe dans Google (impressions, clics) ; Google Analytics dit ce qui se passe après le clic (visites, engagement, événements clés, chiffre d'affaires).

- Une lecture couvre 28 ou 90 jours et se termine la veille. Elle remplace la précédente.
- Seules les visites sur l'hôte du site sont lues (`hostName`). Si la propriété a des visites mais aucune sur cet hôte : `analytics_other_site` (statut 409), rien n'est enregistré. Si la propriété n'a aucune visite du tout sur la période (site neuf), la lecture réussit avec des zéros.
- La série quotidienne contient tous les jours de la période, à 0 les jours sans visite.
- Les pages d'arrivée de même chemin (casse, slash final, paramètres) sont additionnées. Au-delà de 200 pages, `landingPagesTruncated` vaut `true` et une page absente de la liste n'est pas déclarée sans visite.
- Les pages d'arrivée sont rapprochées des pages analysées par leur chemin (`LandingPage.pageId`, `PageDetail.visits`).
- `revenue` vaut `null`, jamais 0, quand aucune vente n'est mesurée ou quand le compte de service n'a pas le droit de la voir ; `revenueStatus` dit lequel des deux.
- Statuts : `analytics_not_configured` 503, `analytics_unavailable` 502 avec `details.retryable`. Une lecture par minute.

## Vitesse des pages

Mesures de PageSpeed Insights (Google), avec la clé `GOOGLE_PAGESPEED_API_KEY`. Chaque page est mesurée pour un téléphone et pour un ordinateur ; une mesure prend 10 à 40 secondes, d'où un travail en tâche de fond : `POST` répond tout de suite, l'événement `pagespeed` signale chaque page terminée, `running` donne l'avancement réel.

- 10 pages au plus par demande, une page à la fois, une seule mesure en cours par site, 30 pages mesurées par heure et par site. Seules des pages de l'analyse affichée, sur l'hôte du site, peuvent être mesurées.
- Deux natures de chiffres, à ne jamais confondre : **laboratoire** (`score`, `lab` : un chargement simulé par Google) et **terrain** (`field` : ce que les vrais visiteurs ont vécu sur 28 jours ; `null` quand Google n'a pas assez de données, `scope: "site"` quand elles portent sur tout le site et non sur la page).
- Les verdicts (`SpeedRating`) sont ceux de Google, pas recalculés.
- La clé n'apparaît jamais dans une erreur, un journal ni une réponse. Une page que Google n'a pas pu mesurer est listée dans `failures` (page, appareil, raison) et la mesure continue ; `failures` repart de zéro à chaque demande, jamais à une réussite. `lastError` est réservé à ce qui arrête toute la demande (clé refusée, quota épuisé).
- La note de vitesse n'entre pas dans la note SEO du site : la grille de notation ne change pas.
- Précisions : la clé est envoyée à Google dans un en-tête, jamais dans l'adresse ; sans lecture de Google Analytics, les pages mesurées par défaut sont choisies d'après les clics de la Search Console, à défaut la première analysée ; une mesure interrompue par un redémarrage du serveur n'est pas reprise ; `403` « API non activée » chez Google donne `…_unavailable` avec `details.retryable: false`, pas `…_no_access`.
- `revenue` (Google Analytics) vaut `null` dès que le chiffre d'affaires d'achat est nul sur tout le site pour la période : un site qui mesure ses ventes mais n'en a eu aucune affiche donc aussi « non mesuré ».

## Évolution et rapport

`GET /api/sites/:siteId/progress` rend `Progress`. Les deux modes.

- **Analyses** : seules les analyses terminées (`done`) avec au moins une page notée comptent. `initial` est la première, `current` la dernière.
- **Comparaison à périmètre égal** : deux analyses n'ouvrent pas forcément les mêmes pages (plafond de pages, pages ajoutées ou retirées). `comparison` ne porte donc que sur les pages présentes dans les deux, reconnues par leur chemin normalisé. Un problème est un critère de la grille en défaut sur une page ; un critère absent de l'une des deux analyses n'est pas compté. « Corrigé » : en défaut dans la première, validé dans la dernière. « Restant » : en défaut dans les deux. « Nouveau » : validé dans la première, en défaut dans la dernière. Si le détail des pages de la première analyse n'est plus en base, `comparison` vaut `null` : rien n'est reconstitué.
- **Coût** : la route ne garde pas en mémoire le détail des pages des analyses anciennes ; les caches du serveur sont bornés.
- **Corrections** : comptées par statut actuel, avec les mêmes règles que `ShopifyChange.correctionStatus`. Sans boutique reliée, tous les compteurs valent 0.
- L'interface présente ces données dans la Vue d'ensemble (bloc « Évolution ») et dans un rapport imprimable (« Rapport d'optimisation »), qui ajoute la liste des corrections vérifiées lue par `GET …/shopify/changes`. Elle dit toujours sur combien de pages communes porte la comparaison, et n'affiche aucun pourcentage qui ne vienne pas de ces champs.

**Boutique protégée par un mot de passe.** Quand la page de départ d'une analyse redirige vers la page du mot de passe de la boutique (`/password`), et que le site est celui d'une boutique Shopify (site rattaché à une boutique, ou site reconnu comme Shopify par l'analyse), l'analyse s'arrête en `failed` avec l'erreur `storefront_locked` : message « Votre boutique en ligne est protégée par un mot de passe : ses pages publiques ne peuvent pas être analysées. », action « Retirez le mot de passe (Boutique en ligne > Préférences), puis relancez l'analyse. En attendant, les titres, descriptions et textes d'images lus dans Shopify restent disponibles dans la section Boutique Shopify. » L'interface affiche alors cet état, avec un lien vers la section Boutique Shopify et un bouton pour relancer l'analyse, au lieu de l'état d'erreur ordinaire. En mode intégré, à la création du site d'une boutique, le serveur lance aussi la première lecture de la boutique (un échec ne bloque rien), pour que cette section soit utile même sans analyse.

## Flux en direct

### `GET /api/sites/:siteId/events`

Flux `text/event-stream` qui reste ouvert. Chaque message :

```
event: audit
data: {"type":"audit","audit":{…AuditStatus},"score":71}

```

- À la connexion : un message `site` avec l'état courant, pour que l'interface se resynchronise après une coupure.
- `audit` : à chaque changement réel (page terminée, page mise en file, changement d'état), au plus 4 par seconde.
- `page` : une page vient d'être notée (`PageSummary`).
- `search_console` : un import a été ajouté ou supprimé.
- `shopify` : la boutique a été relue ou modifiée, ou un lot de corrections a avancé.
- `analytics` : les visites Google Analytics ont été relues.
- `pagespeed` : une mesure de vitesse a avancé ou s'est terminée.
- Un commentaire `: ping` toutes les 20 secondes pour garder la connexion.

**Progression réelle.** L'interface affiche `pagesDone`, `pagesQueued`, `pagesFailed` et `currentUrl`. Le total final n'est pas connu d'avance : aucun pourcentage n'est calculé tant que `state` n'est pas `done`.

### `POST /api/sites/:siteId/chat`

La réponse est un flux `text/event-stream` : un `start` (le message de l'utilisateur enregistré), puis des `delta` (texte à ajouter) et des `tool` (l'assistant consulte une donnée du site), puis un `done` (le message complet enregistré) ou un `error`. L'interface lit ce flux avec `fetch` et un lecteur de flux, pas avec `EventSource`.

## Règles de fond

- **La note.** Une page est notée sur 100 par la grille de `reference/sonde-seo.html` (fonction `analyse` : cinq familles, 30 + 20 + 25 + 15 + 10 points). La note du site est la moyenne des notes des pages, arrondie à l'entier.
- **La gravité d'un problème.** `critical` : le critère vaut 6 points ou plus et plus de la moitié des pages sont en défaut, ou il empêche l'indexation (`noindex`). `warning` : les autres critères en défaut. `info` : défaut sur un critère de 2 points ou moins.
- **Un point positif.** Un critère validé sur au moins 90 % des pages.
- **Les constats du catalogue** (`basis: "catalogue"`) : `scoreImpact` 0, gravité `warning` ou `info`, classés après les problèmes fondés sur les pages de même gravité. Leurs preuves ont `pageId` null. Un produit dont la page a été ouverte n'est jamais compté dans le catalogue.
- **Les doublons** (même titre ou même description sur plusieurs pages) ne changent pas la note (`scoreImpact` 0) mais sont de gravité `warning`, leur recommandation a un `impact` `medium`, et ils sont classés juste après les problèmes `critical`.
- **Une recommandation.** Une par problème. `impact` découle des points à regagner, `effort` de la nature du correctif (un réglage unique dans le thème est `quick` même s'il touche 200 pages ; rédiger 50 descriptions est `heavy`).
- **Les concurrents.** Uniquement des résultats de recherche réellement relevés, chacun avec sa preuve (requête, position, titre, adresse). Sans fournisseur de recherche configuré, la section répond `available: false`.
- **L'assistant.** Il ne répond qu'à partir des données du site, qu'il consulte par des outils côté serveur. Le contenu des pages analysées est une donnée, jamais une consigne. Chaque réponse liste ses `sources`.

## Application intégrée à Shopify

Le serveur a deux modes, choisis par `SHOPIFY_APP_MODE`. Le mode se décide au démarrage et ne change pas ensuite.

| | `local` (par défaut, variable vide) | `embedded` |
|---|---|---|
| Usage | Développement, une boutique de sa propre organisation | Application publique affichée dans l'administration Shopify |
| Jeton d'accès à la boutique | « Client Credentials », 24 h | Échange du jeton de session contre un jeton hors ligne **à expiration** (1 h) et son jeton de renouvellement (90 jours) |
| Identification des requêtes `/api` | Aucune (machine locale) | Jeton de session Shopify obligatoire sur **toutes** les routes `/api`, toutes méthodes (HEAD et OPTIONS comprises), flux SSE et routes inconnues compris |
| Affichage dans un cadre | Interdit | Autorisé pour l'administration Shopify et la boutique qui ouvre la page |
| Boutiques servies | Une, celle de `SHOPIFY_STORE_DOMAIN` | Toute boutique qui a installé l'application ; données séparées par boutique (« Plusieurs boutiques ») |

**Démarrage en mode intégré.** `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET` et `TOKEN_ENCRYPTION_KEY` sont obligatoires : s'il en manque une, si la clé de chiffrement n'a pas la bonne forme, ou si `SHOPIFY_APP_MODE` a une autre valeur que vide, `local` ou `embedded`, le serveur refuse de démarrer (le message cite des noms de variables, jamais une valeur). `SHOPIFY_STORE_DOMAIN` est ignorée dans ce mode.

**Jeton de session.** L'interface le demande à App Bridge (`shopify.idToken()`, valable une minute) avant chaque appel et l'envoie dans `Authorization: Bearer <jeton>`. Le serveur le vérifie avant tout autre traitement de la route :

- trois segments, en-tête `alg` égal à `HS256` exactement et sans champ `crit`, signature en base64url canonique, HMAC-SHA256 avec le secret de l'application, comparée en temps constant ;
- `exp` dans le futur et `nbf` dans le passé, avec 10 secondes de tolérance d'horloge ;
- `aud` égal à l'identifiant de l'application ;
- `iss` et `dest` sont des adresses `https://` dont l'hôte est le même et a la forme `xxx.myshopify.com`. Cet hôte est **la boutique de la requête** : tout le reste du traitement en dépend, et rien d'autre dans la requête (adresse, corps, en-tête) ne peut désigner une boutique.

| Cas | Réponse |
|---|---|
| En-tête absent, jeton mal formé, signature fausse, expiré, `aud` ou `iss`/`dest` invalides | `401 unauthorized`, avec l'en-tête `X-Shopify-Retry-Invalid-Session-Request: 1` (App Bridge redemande un jeton et rejoue la requête une fois) |
| Jeton valide d'une boutique que le serveur ne sert plus | `403 shop_not_allowed`, sans l'en-tête de relance. Réservé à la désinstallation (lot C) : non émis pour l'instant |

Le message d'un refus ne dit jamais quelle vérification a échoué, et ne recopie ni le jeton ni le secret. Les gardes d'hôte et d'origine restent en place, avant la vérification du jeton. Le jeton de session n'est jamais accepté dans l'adresse (paramètre `id_token`) : seulement dans l'en-tête.

**Jetons d'accès (mode intégré).** Un couple par boutique (jeton d'accès, jeton de renouvellement), enregistré dans la table `shops`, **chiffré** (AES-256-GCM, clé `TOKEN_ENCRYPTION_KEY`, vecteur aléatoire par valeur, domaine de la boutique en donnée authentifiée : une valeur copiée d'une ligne à une autre ne se déchiffre pas). Le nouveau couple est enregistré avant d'être utilisé. Une valeur illisible (clé changée, ligne altérée) est traitée comme une absence de jeton, sans erreur visible : le prochain échange la remplace. Les règles ci-dessous valent boutique par boutique ; une demande à la fois par boutique.

- Après une vérification réussie, si le serveur n'a ni jeton d'accès valide ni jeton de renouvellement utilisable, il échange le jeton de session reçu (`grant_type=urn:ietf:params:oauth:grant-type:token-exchange`, `subject_token_type=urn:ietf:params:oauth:token-type:id_token`, `requested_token_type=urn:shopify:params:oauth:token-type:offline-access-token`, `expiring=1`). Une seule demande à la fois.
- Shopify répond 400 à l'échange (jeton de session périmé) : `401 unauthorized` avec l'en-tête de relance. Tout autre échec de l'échange ne bloque pas la requête : les routes qui n'appellent pas Shopify répondent normalement, les autres répondent `shopify_unavailable`. Après un tel échec, aucun nouvel échange n'est tenté pendant 30 secondes.
- Jeton d'accès proche de l'expiration (moins de 5 minutes) : renouvelé avec le jeton de renouvellement (`grant_type=refresh_token`), une seule demande à la fois ; le nouveau couple remplace l'ancien. Échec passager (réseau, délai, 5xx, 429) : le jeton de renouvellement est gardé et resservira. Après tout échec non définitif du renouvellement (réponse mal formée comprise), le jeton d'accès sert encore tant qu'il n'a pas réellement expiré. Tout autre refus (401, et par prudence tout 4xx hors 429) : définitif, les deux jetons sont oubliés et le prochain échange se fera à la prochaine requête identifiée.
- Sans jeton utilisable et sans requête identifiée (tâche de fond) : `shopify_unavailable` (statut 502, comme les autres) avec `details.retryable: true` et l'action « Ouvrez l'application depuis votre administration Shopify. »
- Aucun jeton (session, accès, renouvellement) ni le secret n'apparaît dans une réponse, un message d'erreur ou un journal.

**Page de l'application (mode intégré).** Le serveur ajoute à `index.html`, en tête de `<head>` et avant tout autre script, `<meta name="shopify-api-key" content="…">` (l'identifiant de l'application, qui n'est pas un secret) puis `<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>`. L'interface sait qu'elle est en mode intégré à la présence de `window.shopify`. Les en-têtes de sécurité changent : `script-src 'self' https://cdn.shopify.com` et `X-Frame-Options` n'est plus envoyé. `frame-ancestors` dépend de la réponse : pour la page de l'application, `https://<boutique> https://admin.shopify.com`, où la boutique vient du paramètre `shop` de l'adresse s'il a la forme `xxx.myshopify.com` (ce paramètre ne sert qu'à cet en-tête, jamais à identifier la requête), sinon `https://admin.shopify.com` seul ; pour toutes les autres réponses (`/api`, fichiers), `frame-ancestors 'none'`. En mode local, rien ne change (`frame-ancestors 'none'`, `X-Frame-Options: DENY`).

**Côté interface.** En mode intégré, l'interface n'affiche ni l'ajout d'un site, ni sa suppression, ni le choix entre plusieurs sites, ni le réglage du nombre de pages par défaut : elle ouvre directement le site rendu par `GET /api/sites`, et si cette lecture échoue elle affiche l'erreur avec un bouton « Réessayer ». Si App Bridge ne fournit pas de jeton (échec ou plus de 10 secondes), aucune requête ne part et l'erreur est ordinaire et réessayable : l'application reste affichée. Un `401 unauthorized` qui persiste après une nouvelle tentative avec un jeton neuf, ou reçu sans App Bridge (page ouverte hors de Shopify), et un `403 shop_not_allowed`, affichent un écran entier qui remplace l'application : le message et l'action de l'erreur, sans navigation. En mode local, l'interface n'envoie aucun en-tête `Authorization`.

### Plusieurs boutiques (mode intégré)

**Une boutique, un site.** À la première requête identifiée d'une boutique, le serveur l'enregistre (`shops`) et, dès qu'il a un jeton d'accès, lit chez Shopify son nom et son domaine principal (pour une boutique sans domaine public, par exemple une boutique d'essai, c'est son domaine `xxx.myshopify.com`, montré à son seul marchand ; en mode local ce domaine reste masqué) puis crée son site, rattaché à la boutique, et lance la première analyse (un échec de ce lancement n'empêche pas la création). Si un site de même hôte existe sans boutique (données d'avant le mode intégré), il est rattaché à la boutique au lieu d'être recréé, sans nouvelle analyse. Si un site de même hôte appartient déjà à une autre boutique, rien n'est créé : `409 site_exists`, sans `details`.

**Séparation.** En mode intégré, la boutique de la requête est celle du jeton de session, et :

- `GET /api/sites` ne rend que le site de cette boutique. Il attend la création du site si elle n'a pas encore eu lieu ; si Shopify ne répond pas, `shopify_unavailable`.
- Toute route `/api/sites/:siteId/…` dont le site n'appartient pas à la boutique de la requête (ou n'appartient à aucune) répond `404 not_found`, exactement comme pour un site inexistant. Cela vaut pour le flux `/events` et pour toute ressource désignée dans l'adresse ou le corps (page, problème, élément, modification, lot, ligne de lot) : elle doit appartenir à ce site, sinon `404`.
- `POST /api/sites`, `DELETE /api/sites/:siteId` et `PATCH /api/settings` répondent `403 not_in_embedded_mode`.
- Les appels à Shopify d'une boutique n'utilisent que les jetons de cette boutique ; les états gardés en mémoire (connexion, files, verrous) sont séparés par boutique. Garde de propriété (`shopify_other_shop` sinon) : en mode local, l'hôte du site doit être le domaine principal de la boutique ; en mode intégré, le site doit être rattaché à la boutique du service (`shop_domain`), ce qui reste vrai si la boutique change de domaine principal après la création du site. Dans ce cas l'adresse du site n'est pas encore mise à jour (analyse et vérification continuent sur l'ancienne adresse) : à traiter avec le lot E.
- Toutes les réponses `/api` portent `Cache-Control: private, no-cache` et `Vary: Authorization` : une réponse d'une boutique n'est jamais resservie à une autre depuis un cache.
- Les limites par minute et les plafonds restent communs au serveur dans ce lot (lot D).

En mode local, rien de cette section ne s'applique : les sites n'ont pas de boutique et toutes les routes se comportent comme avant.

**Base.** Les évolutions du schéma passent par des migrations numérotées (`schema_migrations`), chacune appliquée une seule fois dans une transaction ; une base existante est mise à niveau sans perte.

### Appels de Shopify : désinstallation et vie privée (mode intégré)

Une seule route, hors de `/api` : `POST /webhooks/shopify`. Elle n'existe qu'en mode intégré (404 en mode local). Elle n'a ni jeton de session ni garde d'origine : sa seule preuve est la signature.

**Vérification, avant tout traitement.**

- Le corps est lu brut, limité à 256 Ko (au-delà : 413).
- `X-Shopify-Hmac-SHA256` doit être le HMAC-SHA256 du corps brut avec le secret de l'application, en base64, comparé en temps constant. Absent ou faux : `401`, corps vide de toute précision, rien n'est enregistré.
- Le sujet (`X-Shopify-Topic`) doit être l'un des quatre ci-dessous ; sinon `200` sans traitement.
- La boutique vient **du corps signé**, jamais d'un en-tête : `shop_domain` pour les trois appels de vie privée, `myshopify_domain` pour la désinstallation. Elle doit avoir la forme `xxx.myshopify.com`, et l'en-tête `X-Shopify-Shop-Domain`, s'il est présent, doit lui être égal. Corps illisible, champ absent ou discordance : `200` sans traitement, avec une ligne de journal sans valeur.
- **La forme du corps doit être celle du sujet**, sinon `200` sans traitement : l'en-tête de sujet n'est pas signé, et un corps signé ne doit jamais pouvoir être rejoué sous un autre sujet.

  | Sujet | Corps exigé | Corps refusé s'il contient |
  |---|---|---|
  | `shop/redact` | `shop_id` (nombre) et `shop_domain`, rien d'autre | tout autre champ (`customer`, `orders_to_redact`, `data_request`, `orders_requested`…) |
  | `customers/redact` | `shop_domain` et un objet `customer` | `data_request`, `myshopify_domain` |
  | `customers/data_request` | `shop_domain`, un objet `customer` et un objet `data_request` | `myshopify_domain` |
  | `app/uninstalled` | `myshopify_domain` | `shop_domain`, `customer` |
- **Un avis de désinstallation n'est jamais cru sur parole.** Il peut être rejoué, ou arriver après une réinstallation. Après la réponse `200`, le serveur demande à Shopify si les jetons de la boutique sont encore acceptés (lecture de son identité). Jetons acceptés : l'application est installée, l'avis est ignoré. Jetons refusés définitivement : la désinstallation est **confirmée**. Dans tous les autres cas (Shopify injoignable, réponse inattendue, jetons absents, expirés ou illisibles), rien n'est marqué ni effacé : l'avis reste en attente, la question est reposée au démarrage puis au plus une fois par heure, et l'avis est abandonné sans effet au bout de 48 heures.
- Doublons : `X-Shopify-Webhook-Id` est noté dans `webhook_events` (identifiant, sujet, date ; pas le corps, pas la boutique en clair au-delà du nécessaire) ; un identifiant déjà vu répond `200` sans retraitement. Les traitements sont de toute façon rejouables sans effet. Les identifiants de plus de 30 jours sont supprimés.
- La réponse part vite (`200`, corps vide) : le travail long se fait après la réponse. Au plus 20 corps sont lus en même temps sur cette route ; au-delà, `503`. Un corps qui n'est pas arrivé en entier en 10 secondes est abandonné (`408`), pour qu'une connexion lente ne garde pas une place.

| Sujet | Traitement |
|---|---|
| `app/uninstalled` | Une fois la désinstallation confirmée (règle ci-dessus) : la boutique est marquée désinstallée (`shops.uninstalled_at`), ses jetons sont effacés de la base et de la mémoire, ses travaux en cours sont arrêtés (analyse, lot en cours d'écriture : arrêt propre, jamais de reprise), ses flux `/events` sont fermés, son jeu de services est libéré. **Ses données sont gardées** jusqu'à l'effacement. |
| `shop/redact` | Demande d'effacement, notée de façon durable (`shop_redactions`) puis exécutée après la réponse. Voir ci-dessous. |
| `customers/data_request`, `customers/redact` | Le logiciel ne garde aucune donnée de client final : rien à fournir, rien à effacer. Reçu, noté, `200`. |

**Effacement d'une boutique (`shop/redact`).** Shopify l'envoie 48 heures après une désinstallation.

- **Effacement immédiat, sur preuve seulement.** La seule preuve est un refus définitif de Shopify : soit la désinstallation a été confirmée (`uninstalled_at` rempli, aucun jeton enregistré et aucune requête identifiée depuis), soit, au moment de traiter la demande, la boutique a des jetons lisibles et Shopify les refuse définitivement. « Refusés définitivement » veut dire : le renouvellement du jeton reçoit de Shopify un refus `401` dont le code est `invalid_request`, pour le jeton de renouvellement qui est toujours celui enregistré en base. Tout autre refus (identifiants de l'application refusés, autre code, autre statut) n'est pas une preuve. Et un refus définitif constaté au moment de traiter la demande ne déclenche pas l'effacement si une requête identifiée de la boutique est arrivée depuis la demande : elle attend alors comme les autres.
- Si la boutique a des jetons lisibles et que Shopify les accepte, l'application est installée : la demande est close sans rien effacer, et c'est journalisé.
- **Sans preuve, l'effacement attend 25 jours.** Dans tous les autres cas (jetons absents, expirés ou illisibles, Shopify injoignable, réponse inattendue), la demande reste en attente et est réessayée au démarrage puis au plus une fois par heure. Au bout de 25 jours (Shopify en accorde 30), elle est exécutée, avec un avertissement dans le journal, à une condition : aucune requête identifiée de la boutique n'est arrivée depuis la demande. Une boutique désinstallée ne peut plus envoyer de requête identifiée ; elle est donc toujours effacée dans le délai. Si une requête identifiée est arrivée depuis la demande, l'application est vraisemblablement installée : la demande reste en attente, avec un avertissement quotidien, jusqu'à ce que Shopify accepte les jetons (close) ou les refuse définitivement (effacement).
- `uninstalled_at` n'est jamais rempli sans confirmation, et n'est jamais à lui seul une raison d'effacer si des jetons ont été enregistrés depuis.
- Après l'effacement, la base ne garde pas les lignes supprimées dans ses pages libres ni dans son journal (`secure_delete`, puis vidage du journal).
- L'effacement supprime, dans une seule transaction : le site de la boutique et tout ce qui en dépend (analyses, pages, Search Console, conversation, concurrents, inventaire, éléments Shopify, réglages d'automatisation, visites, vitesse), l'historique rangé par adresse du site (modifications, vérifications, lots et lignes de lots, compteurs d'automatisation) et la ligne `shops`. Rien d'une autre boutique n'est touché. Si le site avait été rattaché à la boutique à partir de données du mode local (« Plusieurs boutiques »), cet historique d'avant le rattachement est effacé aussi : c'est celui de la même boutique.
- L'historique reste protégé contre toute suppression ordinaire. Seul ce chemin peut supprimer, pour une seule adresse de site à la fois, par une autorisation posée et retirée dans la même transaction ; une suppression directe reste refusée par la base, avant comme après.
- Une demande pour une boutique inconnue est close sans rien faire.

**Réinstallation.** Rien n'interdit une boutique désinstallée : une requête identifiée par un jeton de session valide, suivie d'un échange réussi (ou un renouvellement de jeton accepté par Shopify), prouve que l'application est installée ; `uninstalled_at` est alors remis à vide. Si les données n'ont pas encore été effacées, la boutique les retrouve ; sinon elle repart d'un état neuf (nouveau site, première analyse). Un avis de désinstallation arrivé en retard, après une réinstallation, est ignoré : Shopify accepte les jetons de la boutique. Une réponse de Shopify à une demande de jeton partie avant une désinstallation n'est jamais enregistrée après elle. `shop_not_allowed` reste réservé et n'est pas émis.

### Exploitation (lot D)

**Sections masquées.** `Settings.features` dit quelles sections facultatives existent : `competitors`, `analytics`, `pageSpeed`, `assistant`, `searchConsoleSync`. En mode local, toutes valent `true` (c'est `integrations.*.configured` qui dit si elles sont utilisables). En mode intégré, toutes valent `false`, sauf celles nommées dans `EMBEDDED_FEATURES` (liste séparée par des virgules ; valeurs acceptées : `assistant`, `competitors`, `pagespeed` ; toute autre valeur fait refuser le démarrage). `analytics` et `searchConsoleSync` ne peuvent jamais être activées en mode intégré : elles liraient le compte Google de l'exploitant. Une section à `false` n'apparaît pas dans l'interface, ses routes répondent `403 not_in_embedded_mode`, lectures comprises, ses données ne sortent par aucune autre route (le détail d'une page rend `visits: null` et `speed: null`) et l'assistant n'a pas les outils qui la lisent :

| Section | Routes fermées |
|---|---|
| `competitors` | `GET` et `POST …/competitors` |
| `analytics` | `GET …/analytics`, `POST …/analytics/sync` |
| `pageSpeed` | `GET` et `POST …/pagespeed`, `POST …/pagespeed/cancel` |
| `assistant` | `GET`, `POST` et `DELETE …/chat` |
| `searchConsoleSync` | `POST …/search-console/sync` seulement (la lecture et le dépôt manuel de l'export restent ouverts) |

**Automatisation.** En mode intégré, `AutomationState.autoAllowed` vaut toujours `false`, quelle que soit `SHOPIFY_AUTO_APPLY` : un `PUT …/automation` avec `mode: "auto"` répond `403 automation_not_allowed`, et aucun lot n'est jamais appliqué sans validation humaine. Une règle « auto » déjà en base (données d'avant le mode intégré) est lue comme « propose ». Le plafond réglable de jetons d'IA par jour (`limits.aiTokensPerDay.max`) est borné par `AI_TOKENS_PER_DAY_MAX` (200 000 par défaut en mode intégré) ; une règle enregistrée au-dessus est ramenée à ce plafond à la lecture.

**Limites par boutique (mode intégré).** Chaque limite par minute est comptée par site, plus jamais pour tout le serveur : lecture de la boutique, écritures (limite propre à chaque boutique), création de lots, préparation par l'IA, vérification, règle d'automatisation, assistant, concurrents. S'y ajoutent :

- un plafond commun à tout le serveur pour les demandes à l'IA (assistant et préparation), 60 par minute : au-delà, `rate_limited` ;
- le plafond de jetons d'IA par jour du site (`aiTokensPerDay`) compte aussi la conversation avec l'assistant quand elle est ouverte : au-delà, `budget_exceeded` ;
- 6 analyses lancées par heure et par site (`rate_limited`, `details.retryAfterSeconds`) ; le nombre d'analyses simultanées reste commun, les suivantes attendent.

En mode local, les limites restent celles d'avant.

**Reprise après un redémarrage.** Au démarrage, les corrections appliquées depuis moins de 24 heures, dans la langue principale, dernières de leur champ et sans aucune relecture enregistrée, sont remises dans la file de vérification (mêmes règles de cadence). Les jeux de services d'une boutique sans travail en cours ni requête depuis 30 minutes sont libérés de la mémoire.

**Surveillance.** `GET /healthz`, hors de `/api`, sans identification, dans les deux modes : `200 {"ok":true}` si la base répond à une vraie lecture (une ligne de `schema_migrations`), `503 {"ok":false}` sinon. Rien d'autre n'y figure (ni version, ni nombre de boutiques).

**Sauvegardes de la base.** Toutes les `DB_BACKUP_HOURS` heures (24 par défaut en mode intégré, 0 = jamais, valeur par défaut du mode local), le serveur écrit une copie cohérente de la base dans `<DATA_DIR>/backups/`, lisible par le seul propriétaire, et ne garde que les `DB_BACKUP_KEEP` plus récentes (7 par défaut). Un échec est journalisé et n'arrête jamais le serveur. Une copie datée dans le futur est ignorée. La copie fige le serveur le temps de l'écriture (quelques instants sur une base ordinaire). Les jetons y restent chiffrés. Une boutique effacée (`shop/redact`) disparaît des sauvegardes au fil de leur rotation, donc en 7 jours avec les valeurs par défaut.

**Transport.** En mode intégré, toutes les réponses portent `Strict-Transport-Security: max-age=31536000`.

## Protection du serveur

- Toute requête `/api` dont l'en-tête `Host` n'est pas `localhost`, `127.0.0.1` ou `[::1]` (sur le port du serveur, ou 5173 pour le relais de l'interface en développement), ni un hôte déclaré dans `ALLOWED_HOSTS`, est refusée (statut 403) : une page web tierce ne peut pas atteindre le serveur par rebond DNS.
- Les routes qui modifient (POST, PATCH, DELETE) exigent `content-type: application/json` (ou multipart pour le dépôt de fichier) et refusent un en-tête `Origin` qui n'est pas celui du serveur.
- Le corps d'une requête est limité au fil de la lecture : 64 Ko en JSON, 21 Mo pour le dépôt.
- Limites : nombre de sites, analyses simultanées (les suivantes attendent en `queued`), demandes par minute à l'assistant et au relevé des concurrents. Dépassement : `rate_limited` (statut 429) ou `limit_reached` (statut 409).
- Une erreur `chat_unavailable` qui ne se résoudra pas en réessayant (clé refusée, modèle refusé) porte `details.retryable: false` : l'interface désactive alors la saisie.
- À la suppression d'un site, le serveur ferme ses flux `/events` ouverts ; la reconnexion reçoit un 404.
- L'assistant : si l'API échoue avant toute réponse, la question n'est pas conservée (une relance ne crée pas de doublon) ; si le navigateur coupe le flux, la génération s'arrête côté serveur.

## Variables d'environnement (côté serveur uniquement)

| Variable | Rôle | Obligatoire |
|---|---|---|
| `PORT` | Port du serveur, 8787 par défaut | non |
| `HOST` | Adresse d'écoute, `127.0.0.1` par défaut | non |
| `DATA_DIR` | Dossier de la base SQLite, `./data` par défaut | non |
| `ANTHROPIC_API_KEY` | Clé de l'API Claude pour l'assistant | non — sans elle, `ChatState.available` vaut `false` |
| `ANTHROPIC_MODEL` | Modèle de l'assistant, `claude-sonnet-5-5` par défaut | non |
| `FIRECRAWL_API_KEY` | Recherche Google pour le relevé des concurrents | non — sans elle, la section Concurrents est désactivée |
| `SHOPIFY_STORE_DOMAIN` | Domaine `xxx.myshopify.com` de la boutique | non — sans les trois variables `SHOPIFY_*`, `connection.state` vaut `not_configured` |
| `SHOPIFY_CLIENT_ID` | Identifiant de l'application Shopify | non |
| `SHOPIFY_CLIENT_SECRET` | Secret de l'application Shopify | non |
| `SHOPIFY_APP_MODE` | `embedded` pour l'application publique intégrée à Shopify ; vide ou `local` pour le mode de développement | non — en `embedded`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET` et `TOKEN_ENCRYPTION_KEY` deviennent obligatoires |
| `EMBEDDED_FEATURES` | Sections facultatives ouvertes en mode intégré : `assistant`, `competitors`, `pagespeed`, séparées par des virgules | non — vide : toutes masquées |
| `AI_TOKENS_PER_DAY_MAX` | Plafond du réglage « jetons d'IA par jour » d'une boutique (mode intégré) | non — 200 000 |
| `DB_BACKUP_HOURS`, `DB_BACKUP_KEEP` | Intervalle des sauvegardes de la base en heures (0 = jamais) et nombre de copies gardées | non — 24 et 7 en mode intégré, 0 en mode local |
| `TOKEN_ENCRYPTION_KEY` | Clé de chiffrement des jetons des boutiques : 32 octets en base64 (`openssl rand -base64 32`). La perdre ou la changer oblige chaque boutique à rouvrir l'application | en `embedded` seulement |
| `SHOPIFY_WRITES_ENABLED` | `1` pour autoriser le serveur à écrire dans la boutique | non — sans elle, la boutique est en lecture seule |
| `ALLOWED_HOSTS` | Hôtes publics acceptés dans l'en-tête `Host`, séparés par des virgules (ex. `seo.exemple.fr`) | non — à renseigner chez un hébergeur |
| `SHOPIFY_AUTO_APPLY` | `1` pour autoriser le mode d'automatisation « auto » (écritures sans validation humaine) | non — sans elle, l'IA propose, un humain valide |
| `GOOGLE_APPLICATION_CREDENTIALS` | Chemin du fichier JSON du compte de service Google (Search Console et Google Analytics) ; `GOOGLE_SERVICE_ACCOUNT_FILE` est accepté aussi | non — par défaut `secrets/google-service-account.json` s'il existe |
| `GA4_PROPERTY_ID` | Identifiant numérique de la propriété Google Analytics 4 | non — sans lui, pas de lecture des visites |
| `GOOGLE_PAGESPEED_API_KEY` | Clé d'API Google pour PageSpeed Insights | non — sans elle, pas de mesure de vitesse |
| `GSC_PROPERTY` | Propriété Search Console à lire, ex. `sc-domain:exemple.fr` | non — déduite de l'hôte du site |
| `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD` | Identifiants de l'API DataForSEO | non — aucune fonctionnalité ne s'en sert encore |
