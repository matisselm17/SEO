# Connexion directe à Google Search Console : préparation

État au 27 novembre 2026 (soir) : **la lecture directe est codée (`server/src/gsc/google.ts`) et testée contre un faux Google ; elle n'a jamais été essayée chez Google**, faute de compte de service. Le dépôt manuel de l'export reste disponible. La description du contrat est dans `docs/format-echange.md`, section « Search Console ».

**Où placer le fichier du compte de service :** `secrets/google-service-account.json` à la racine du dépôt (le dossier `secrets/` existe, il est ignoré par git et lisible par le seul propriétaire de la machine). Aucun autre réglage n'est nécessaire ; `GOOGLE_SERVICE_ACCOUNT_FILE` ne sert que pour un autre emplacement.

Cela revient sur une décision du client notée dans `docs/etat-du-projet.md` (« pas de connexion automatique »). Le dépôt manuel reste disponible : la connexion directe s'y ajoute, elle ne le remplace pas.

## Ce que la connexion apporte de plus que l'export

| | Export déposé | Connexion directe |
|---|---|---|
| Fraîcheur | Celle du jour de l'export | À la demande (Google publie avec 2 à 3 jours de retard) |
| Requêtes par page | Non : l'export sépare requêtes et pages | Oui : dimensions `page` + `query` |
| Lignes | 1 000 par fichier | 25 000 par appel, paginé |
| Historique | La période choisie à l'export | 16 mois |
| État d'indexation d'une page | Non | Oui, API d'inspection d'URL (2 000 pages par jour et par site) |
| Sitemaps déclarés | Non | Oui |

Le troisième point débloque ce qui manque le plus au produit : `PageDetail.queries` (les recherches qui mènent à une page) est presque toujours `null` avec l'export.

## Mode de connexion retenu : compte de service

Même principe que Shopify : un identifiant rangé côté serveur, pas de fenêtre de connexion Google dans le logiciel.

- Convient tant qu'il n'y a pas de comptes clients (un seul espace de travail).
- Lecture seule garantie par le droit donné dans la Search Console, pas par le logiciel.
- Quand les comptes clients arriveront, il faudra passer à OAuth (chaque client autorise son propre compte Google) ; cela demande un écran de consentement validé par Google. À prévoir à ce moment-là, pas avant.

### Ce que le propriétaire du site doit faire (une fois)

1. Dans Google Cloud (console.cloud.google.com) : créer un projet, activer l'API « Google Search Console API ».
2. Créer un compte de service, puis une clé au format JSON. Le fichier téléchargé est un secret.
3. Dans la Search Console du site : Paramètres → Utilisateurs et autorisations → ajouter l'adresse e-mail du compte de service avec le droit **Limité** (lecture seule).
4. Renommer le fichier JSON en `google-service-account.json` et le déposer dans le dossier `secrets/` du projet, puis redémarrer le serveur.

Aucune de ces étapes ne peut être faite par le logiciel ni par un agent : elles engagent le compte Google du propriétaire.

### Variables (facultatives)

| Variable | Rôle |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_FILE` | Chemin du fichier JSON du compte de service |
| `GSC_PROPERTY` | Propriété à lire, ex. `sc-domain:orluxjewelry.com` ou `https://orluxjewelry.com/` |


## Plan technique

**Authentification.** Jeton OAuth 2.0 obtenu par assertion JWT signée avec la clé du compte de service (RS256, `node:crypto`, sans dépendance), portée `https://www.googleapis.com/auth/webmasters.readonly`, valable 1 heure. Même mécanique que `server/src/shopify/auth.ts` : jeton en mémoire, renouvelé avant expiration et après un refus 401, une seule demande à la fois, aucun secret dans les erreurs ni les journaux.

**Lecture.** `POST https://www.googleapis.com/webmasters/v3/sites/{propriété}/searchAnalytics/query`, quatre lectures sur la période choisie (28 jours par défaut, 16 mois au plus) :

| Dimensions | Remplit |
|---|---|
| `date` | `SearchConsoleData.series` et `totals` |
| `query` | `SearchConsoleData.queries` |
| `page` | `SearchConsoleData.pages` |
| `page`, `query` | `PageDetail.queries` |

**Rangement.** Le résultat est converti dans la structure `GscImport` que produit déjà l'import de fichier, puis enregistré par le même chemin : le reste du serveur (rapprochement avec les pages, vue d'ensemble, outils de l'assistant) ne change pas.

**Format d'échange à faire évoluer** (par l'agent principal, avant de déléguer) :

- `SearchConsoleData` : un champ `source: "file" | "google"`, et la date de dernière lecture.
- `Settings.integrations.searchConsole: { configured: boolean }`.
- Une route `POST /api/sites/:siteId/search-console/sync` (lecture chez Google) ; `search_console_not_configured` et `search_console_unavailable` parmi les codes d'erreur.
- Dans l'interface, section « Mots-clés et trafic organique » : un bouton « Lire depuis Google » à côté du dépôt de fichier quand la connexion est configurée.

**Limites à respecter.** 1 200 requêtes par minute et par site chez Google ; une limite propre au serveur d'une lecture par minute suffit. La propriété lue doit correspondre à l'hôte du site (même règle que pour la boutique Shopify : `other_shop`).

**Deuxième temps, à décider après usage.** Inspection d'URL (page indexée ou non, raison) pour les pages de l'audit, et lecture des sitemaps déclarés pour compléter l'inventaire.

## Lien avec les corrections Shopify

Les deux connexions se complètent : la Search Console dit quelles pages reçoivent des impressions sans clics (titre ou description à revoir en priorité), la boutique Shopify permet de corriger ces champs. Le tri « par où commencer » de la section Boutique Shopify pourra alors s'appuyer sur les impressions réelles au lieu du seul nombre de champs vides.

## Ce qui reste

Les quatre étapes du propriétaire ci-dessus, puis un premier essai réel : Mots-clés et trafic organique → « Lire depuis Google ». L'inspection d'URL et la lecture des sitemaps déclarés ne sont pas codées.
