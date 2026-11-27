# État du projet au 27 novembre 2026

Note de passage pour reprendre le travail dans une nouvelle session. Les règles du projet sont dans `CLAUDE.md`, le format d'échange dans `docs/format-echange.md` et `shared/api.ts`.

## Ce qui existe

- **Serveur** (`server/`) : parcours des sites, grille de notation sur 100, inventaire par le sitemap et par type de page, lecture du catalogue Shopify (`/products.json`) pour les produits non ouverts, import de l'export Search Console, assistant (API Claude) et relevé des concurrents (API Firecrawl), protections (origine des requêtes, limites de taille et de débit, adresses internes refusées).
- **Interface** (`web/`) : huit sections, design system décrit dans `web/DESIGN.md`, progression d'analyse en direct, couverture de l'analyse par type de page, thème clair et sombre, mode de démonstration réservé au développement.
- **Équipe d'agents** : `.claude/agents/` (moteur, interface, QA et sécurité).

## Vérifié

- `npm --prefix server run typecheck` et `npm --prefix server run test` : 75 tests réussis.
- `npm --prefix web run typecheck` et `npm --prefix web run build`.
- Parcours complet dans Chrome sur des sites d'essai locaux (`server/test/helpers/fixture-site.ts`, variantes `boutique` et `vitrine-sans-sitemap`), sans erreur de console.
- Une revue QA et sécurité complète a été faite sur la première version ; ses corrections sont appliquées.

## Jamais vérifié en conditions réelles

L'environnement de développement d'origine bloquait l'accès aux sites externes et n'avait aucune clé.

- **Aucun vrai site public n'a été analysé.** Premier test à faire : `orluxjewelry.com` (boutique Shopify, 216 pages d'après son sitemap : 159 produits, 22 collections, 23 articles).
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
