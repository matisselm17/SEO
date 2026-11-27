# État du projet au 27 novembre 2026 (soir)

Note de passage pour reprendre le travail dans une nouvelle session. Les règles du projet sont dans `CLAUDE.md`, le format d'échange dans `docs/format-echange.md` et `shared/api.ts`.

## Ce qui existe

- **Serveur** (`server/`) : parcours des sites, grille de notation sur 100, inventaire par le sitemap et par type de page, lecture du catalogue Shopify (`/products.json`) pour les produits non ouverts, import de l'export Search Console, assistant (API Claude) et relevé des concurrents (API Firecrawl), protections (origine des requêtes, limites de taille et de débit, adresses internes refusées).
- **Interface** (`web/`) : huit sections, design system décrit dans `web/DESIGN.md`, progression d'analyse en direct, couverture de l'analyse par type de page, thème clair et sombre, mode de démonstration réservé au développement.
- **Équipe d'agents** : `.claude/agents/` (moteur, interface, QA et sécurité).

## Ajouté le 27 novembre : connexion à la boutique Shopify

- **Connexion** (`server/src/shopify/auth.ts`) : Client Credentials Grant, jeton de 24 h gardé en mémoire et renouvelé tout seul. Variables `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`.
- **Lecture** : produits, collections, pages et articles, rapprochés des pages de l'audit. Section « Boutique Shopify » dans l'interface, lien depuis un problème de l'audit et depuis une page.
- **Écriture** : titre et description pour Google (quatre types), texte alternatif des images de produit, traductions. Une valeur à la fois, confirmation avant/après, relecture avant écriture, historique et annulation. Détail dans `docs/format-echange.md`, section « Boutique Shopify ».
- **Écritures désactivées par défaut** : `SHOPIFY_WRITES_ENABLED` est vide. Seul le client l'active. **Aucune écriture n'a jamais été envoyée à la vraie boutique** : tout le chemin d'écriture n'est vérifié que contre un faux Shopify (`server/test/helpers/fake-shopify.ts`).
- **Protection ajoutée** : le serveur refuse tout en-tête `Host` qui n'est pas local ou listé dans `ALLOWED_HOSTS` (rebond DNS).
- **Préparation Search Console** : `docs/integration-search-console.md` (rien de codé ; bloqué par la création d'un compte de service Google par le client).

### À vérifier lors de la première écriture réelle (une seule valeur, sous les yeux du client)

1. `metafieldsSet` accepte le type `string` des champs existants de cette boutique, et `compareDigest: null` signifie bien « ne doit pas exister ».
2. `metafieldsDelete` sur `global.title_tag` vide bien le titre pour Google d'un produit.
3. `fileUpdate` change le texte alternatif d'une image de produit sans toucher à l'image.
4. L'annulation remet exactement la valeur d'avant.

### Volontairement non fait

- Texte alternatif des images de collection et d'article : Shopify peut remplacer ou retirer l'image (bug reconnu côté article). À vérifier sur une boutique d'essai avant de l'ouvrir.
- Aucune écriture en lot, aucune écriture par l'assistant.
- Permission absente : `write_themes` (corriger le double H1 dans le thème). Shopify ne l'accorde que sur demande d'exemption.
- Les deux défauts du parcours trouvés le matin restent à corriger : catalogue public déclaré inaccessible à tort, pages refusées (429) sans nouvelle tentative. La connexion Shopify permettrait de lire le catalogue par l'API au lieu de `/products.json`.

## Ajouté le 27 novembre (soir) : vers une optimisation autonome

- **Parcours** : un refus passager (429, 503) est retenté avec ralentissement, le catalogue aussi ; l'analyse réelle donne 100 pages, 0 échec, catalogue lu. La nouvelle tentative n'a pas été observée en réel (aucun 429 pendant les essais).
- **Ce que voit Google** : la section Boutique s'appuie sur le verdict de l'analyse de la page affichée, pas sur les champs vides. Constats et origine des H1 dans `docs/analyse-titres-et-h1.md`.
- **Lots de corrections** : jusqu'à 50 propositions, aperçu avant/après, validation, écriture ligne par ligne, arrêt, annulation du lot.
- **Automatisation** : règle par site (niveau, champs, types, ce que l'IA peut remplacer, plafonds), « Préparer des corrections avec l'IA », outil de l'assistant qui prépare des lots. Quatre verrous pour une écriture sans validation humaine ; `SHOPIFY_AUTO_APPLY` est vide. Les lots de l'assistant sont toujours à valider.
- **Search Console directe** : codée, jamais essayée chez Google. Fichier attendu : `secrets/google-service-account.json`.
- **Préparé, non exécuté** : premier test d'écriture (`docs/premier-test-ecriture.md`), Theme Access (`docs/theme-access.md`, `scripts/theme.sh`), DataForSEO (`docs/integration-dataforseo.md`).
- **Sauvegarde** de la boutique en lecture seule : `npm --prefix server run shopify:sauvegarde` → `data/sauvegardes/`.

- **Search Console directe : fonctionne en réel** depuis le 27 novembre (fichier du compte de service dans `secrets/`, chemin dans `GOOGLE_APPLICATION_CREDENTIALS`).
- **Google Analytics 4** (visites, origines, pages d'arrivée, chiffre d'affaires) et **PageSpeed Insights** (vitesse sur téléphone et ordinateur, laboratoire et terrain séparés) : codés, testés contre un faux Google, **jamais essayés en réel** : `GA4_PROPERTY_ID` et `GOOGLE_PAGESPEED_API_KEY` sont vides. À confirmer au premier essai : forme réelle des réponses, clé PageSpeed envoyée en en-tête, stabilité de terrain divisée par 100, ligne de total d'un rapport sans dimension.

**Premier test réel d'écriture réussi le 27 novembre** (une description pour Google de produit, puis son annulation ; détail dans `docs/premier-test-ecriture.md`). La bonne description a ensuite été réappliquée : trois écritures en tout, sur ce seul produit. Un plan de huit tests a ensuite été exécuté sur dix éléments (création et modification de titres et de descriptions sur produit, collection, page et article, traduction, texte alternatif d'image de produit, lot) : tous conformes, détail dans `docs/plan-validation-corrections.md`. Restent vérifiés seulement contre un faux Shopify : le vidage d'un champ existant, le mode automatique et la préparation par l'IA et un client Claude simulé (trois appels réels à Claude ont seulement produit des propositions, non écrites).

### Prochaines corrections proposées, non faites

- H1 : `sections/faq.liquid` et `sections/contact-form.liquid` (`h1` → `h2`), H1 de l'accueil et des collections, sur une copie du thème.
- 19 articles dont le texte commence par un `<h1>` en double : demande un outil de modification du texte des articles, avec aperçu et restauration.
- Texte alternatif des images de collection et d'article : à vérifier sur une boutique d'essai.
- Le site public a renvoyé une page de vérification anti-robot après de nombreux chargements le 27 novembre : espacer les analyses.

## Vérifié

- `npm --prefix server run typecheck` et `npm --prefix server run test` : 108 tests réussis.
- `npm --prefix web run typecheck` et `npm --prefix web run build`.
- Parcours complet dans Chrome sur des sites d'essai locaux (`server/test/helpers/fixture-site.ts`, variantes `boutique` et `vitrine-sans-sitemap`), sans erreur de console.
- Une revue QA et sécurité complète a été faite sur la première version ; ses corrections sont appliquées.

## Jamais vérifié en conditions réelles

L'environnement de développement d'origine bloquait l'accès aux sites externes et n'avait aucune clé.

- **Analyse réelle faite le 27 novembre** sur `orluxjewelry.com` : 98 pages notées, note 88, inventaire de 212 pages. Deux défauts trouvés (voir ci-dessus).
- **L'assistant** n'a jamais appelé la vraie API Claude (clients simulés seulement).
- **Le relevé des concurrents** n'a jamais appelé la vraie API Firecrawl.
- **L'import Search Console** n'a été testé que sur des fichiers fabriqués, en français et en anglais.
- **Navigateurs** : Chrome seulement.
- La fonctionnalité de couverture (inventaire, catalogue) n'a pas eu de revue QA dédiée. Trois cas ne sont vus qu'en mode de démonstration : site de plus de 100 pages, catalogue inaccessible, analyse complète avec des pages non chargées.

## Décisions du client

- Une analyse ouvre **100 pages au plus** (plafond par défaut et maximum, `server/src/config.ts`). Au-delà, les produits restants sont lus dans le catalogue et n'entrent pas dans la note.
- Produit destiné à être **vendu** : interface de niveau premium, qualité avant quantité, aucune fausse donnée ni pourcentage fictif.
- Import Search Console **facultatif**, par dépôt de l'export (pas de connexion automatique).
- Ne commiter et ne pousser que sur demande.

## Reste à faire

1. Premier essai réel : `npm install`, `cp .env.example .env`, `npm run build`, `npm start`, puis analyser un vrai site ; corriger ce que cet essai révèle.
2. Essayer l'assistant avec une vraie clé `ANTHROPIC_API_KEY` et les concurrents avec `FIRECRAWL_API_KEY`.
3. Revue QA de la couverture.
4. Comptes clients et abonnement (rien n'est fait : un seul espace de travail, sans connexion).
5. Hébergement en ligne (`HOST=0.0.0.0` chez un hébergeur, base SQLite sur un volume persistant).

## Limites connues

- Les pages sont lues sans exécuter leur JavaScript : un site rendu entièrement côté navigateur paraîtra presque vide.
- Le catalogue Shopify donne le nom du produit, pas son titre de référencement : le constat porte sur le nom.
- Les limites de débit sont communes à tout le serveur (pas par client, puisqu'il n'y a pas encore de comptes).
