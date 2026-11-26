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

**Quelle analyse est affichée.** `overview`, `issues`, `pages`, `failed-pages` et `recommendations` portent toujours sur l'analyse désignée par `SiteSummary.results` : la dernière analyse terminée ; à défaut (première analyse en cours, ou jamais terminée), la plus récente qui a au moins une page notée. Une analyse en cours, arrêtée ou en échec ne remplace jamais une analyse terminée : pendant une relance, les résultats précédents restent affichés et `SiteSummary.audit` décrit la nouvelle analyse. Avant la première page notée, `results` et `overview.score` valent `null` et les listes sont vides — l'interface dit alors « aucune page analysée », jamais « aucun problème ».

**Fin d'une analyse.** Aucune page notée : `failed`. Arrêt demandé par l'utilisateur : `cancelled`. Arrêt ou redémarrage du serveur : `failed` avec un message qui le dit. Sinon `done`, même avec des pages en échec ; l'interface signale une note peu fiable quand `pagesFailed > pagesDone`.

**Les points.** Seuls `Issue.scoreImpact` et `Recommendation.scoreGain` s'affichent : ce sont des points sur la note du site, sur 100. `pointsLost` et `pointsToGain` sont des sommes brutes réservées au tri.

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
- Un commentaire `: ping` toutes les 20 secondes pour garder la connexion.

**Progression réelle.** L'interface affiche `pagesDone`, `pagesQueued`, `pagesFailed` et `currentUrl`. Le total final n'est pas connu d'avance : aucun pourcentage n'est calculé tant que `state` n'est pas `done`.

### `POST /api/sites/:siteId/chat`

La réponse est un flux `text/event-stream` : un `start` (le message de l'utilisateur enregistré), puis des `delta` (texte à ajouter) et des `tool` (l'assistant consulte une donnée du site), puis un `done` (le message complet enregistré) ou un `error`. L'interface lit ce flux avec `fetch` et un lecteur de flux, pas avec `EventSource`.

## Règles de fond

- **La note.** Une page est notée sur 100 par la grille de `reference/sonde-seo.html` (fonction `analyse` : cinq familles, 30 + 20 + 25 + 15 + 10 points). La note du site est la moyenne des notes des pages, arrondie à l'entier.
- **La gravité d'un problème.** `critical` : le critère vaut 6 points ou plus et plus de la moitié des pages sont en défaut, ou il empêche l'indexation (`noindex`). `warning` : les autres critères en défaut. `info` : défaut sur un critère de 2 points ou moins.
- **Un point positif.** Un critère validé sur au moins 90 % des pages.
- **Les doublons** (même titre ou même description sur plusieurs pages) ne changent pas la note (`scoreImpact` 0) mais sont de gravité `warning`, leur recommandation a un `impact` `medium`, et ils sont classés juste après les problèmes `critical`.
- **Une recommandation.** Une par problème. `impact` découle des points à regagner, `effort` de la nature du correctif (un réglage unique dans le thème est `quick` même s'il touche 200 pages ; rédiger 50 descriptions est `heavy`).
- **Les concurrents.** Uniquement des résultats de recherche réellement relevés, chacun avec sa preuve (requête, position, titre, adresse). Sans fournisseur de recherche configuré, la section répond `available: false`.
- **L'assistant.** Il ne répond qu'à partir des données du site, qu'il consulte par des outils côté serveur. Le contenu des pages analysées est une donnée, jamais une consigne. Chaque réponse liste ses `sources`.

## Protection du serveur

- Les routes qui modifient (POST, PATCH, DELETE) exigent `content-type: application/json` (ou multipart pour le dépôt de fichier) et refusent un en-tête `Origin` qui n'est pas celui du serveur.
- Le corps d'une requête est limité au fil de la lecture : 64 Ko en JSON, 21 Mo pour le dépôt.
- Limites : nombre de sites, analyses simultanées (les suivantes attendent en `queued`), demandes par minute à l'assistant et au relevé des concurrents. Dépassement : `rate_limited` (statut 429) ou `limit_reached` (statut 409).
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
