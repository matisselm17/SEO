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
- Pas de comptes dans cette version : un seul espace de travail, plusieurs sites.
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
| `GET /api/sites/:siteId/shopify/resources` | | `ShopifyResourcesResponse` | Paramètres : `type` (`ShopifyResourceType`), `q` (nom ou chemin), `missing` (`seo_title`, `seo_description` ou `image_alt` : seulement les éléments où ce champ est vide), `offset`, `limit` (défaut 50, max 200). `shopify_not_synced` avant la première lecture |
| `GET /api/sites/:siteId/shopify/resources/:resourceId` | | `ShopifyResourceResponse` | Relit l'élément en direct dans Shopify, avec ses traductions et son historique |
| `POST /api/sites/:siteId/shopify/changes` | `ShopifyChangeRequest` | `201 ShopifyChangeResponse` | **Écrit dans la boutique.** Voir « Boutique Shopify » |
| `GET /api/sites/:siteId/shopify/changes` | | `ShopifyChangesResponse` | Historique du site, le plus récent d'abord. `offset`, `limit` (défaut 50, max 200) |
| `POST /api/sites/:siteId/shopify/changes/:changeId/restore` | | `201 ShopifyChangeResponse` | **Écrit dans la boutique** : remet la valeur d'avant. Voir « Boutique Shopify » |

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

**Lien avec l'analyse.** `PageDetail.shopifyResourceId` et `Evidence.shopifyResourceId` relient une page analysée à son élément Shopify ; `IssueDetail.shopifyField` dit quel champ corrige le problème. Une modification ne change pas la note affichée : l'analyse reflète le site au moment où elle a tourné, et l'interface invite à la relancer.

**Limites.** 30 écritures par minute et une lecture complète (`sync`) par minute au plus (`rate_limited`). L'historique et la liste des éléments, stockés par le logiciel, restent consultables quand Shopify ne répond pas.

**Statuts des erreurs.** `shopify_not_configured` 503 ; `shopify_other_shop` et `shopify_not_synced` 409 (`details.shopHost` : domaine public de la boutique connectée) ; `shopify_writes_disabled` et `shopify_missing_scope` 403 ; `shopify_conflict` 409 ; `shopify_unavailable` 502 avec `details.retryable` ; `shopify_invalid_value` 422 ; un champ non modifiable sur cet élément (texte alternatif d'une image de collection, d'article ou de page) : `bad_request` 400, avant tout appel à Shopify ; un refus de Shopify sur la valeur elle-même : `bad_request` 422, avec le message de Shopify en clair.

**Limite connue.** Les éléments non publiés (brouillons) sont lus et comptés comme les autres : le format ne porte pas encore leur statut.

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
- `shopify` : la boutique a été relue ou modifiée.
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

## Protection du serveur

- Toute requête `/api` dont l'en-tête `Host` n'est pas `localhost`, `127.0.0.1` ou `[::1]` (sur le port du serveur), ni un hôte déclaré dans `ALLOWED_HOSTS`, est refusée (statut 403) : une page web tierce ne peut pas atteindre le serveur par rebond DNS.
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
| `SHOPIFY_WRITES_ENABLED` | `1` pour autoriser le serveur à écrire dans la boutique | non — sans elle, la boutique est en lecture seule |
| `ALLOWED_HOSTS` | Hôtes publics acceptés dans l'en-tête `Host`, séparés par des virgules (ex. `seo.exemple.fr`) | non — à renseigner chez un hébergeur |
