# Serveur Chat SEO

Paquet npm indépendant (Node 22, TypeScript) : API HTTP de `docs/format-echange.md`, parcours des sites, notation, SQLite (`node:sqlite`), import Search Console, assistant (API Claude), concurrents (Firecrawl).

```bash
npm install
npm run dev        # rechargement à chaud, port 8787
npm run typecheck
npm test
npm run build && npm start   # sert aussi ../web/dist s'il existe
```

La configuration est lue depuis l'environnement, puis depuis `../.env` s'il existe (voir `docs/format-echange.md`). Un `DATA_DIR` relatif est compris depuis la racine du dépôt. Le serveur écoute sur `HOST` (127.0.0.1 par défaut).

Limites (dans `src/config.ts`, `DEFAULT_LIMITS`) : 50 sites, 2 analyses simultanées (les suivantes attendent en `queued`), 10 questions par minute à l'assistant, 3 relevés de concurrents par minute.

Protection : les requêtes POST, PATCH et DELETE exigent `content-type: application/json` (multipart pour le dépôt Search Console), même sans corps, et refusent un en-tête `Origin` d'un autre hôte. Corps limités au fil de la lecture : 64 Ko en JSON, 21 Mo pour le dépôt.

## Variable réservée au développement

`ALLOW_PRIVATE_HOSTS=1` autorise le chargement d'adresses internes (localhost, plages privées). **Désactivée par défaut, à ne jamais activer en production** : elle sert uniquement à analyser le site d'essai local.

```bash
npx tsx test/helpers/fixture-site.ts 8790                        # site vitrine sur http://localhost:8790
npx tsx test/helpers/fixture-site.ts 8791 0 boutique             # boutique qui imite Shopify (sitemap index par type et par langue, /products.json)
npx tsx test/helpers/fixture-site.ts 8792 0 vitrine-sans-sitemap # site sans sitemap
ALLOW_PRIVATE_HOSTS=1 npm run dev                                # puis POST /api/sites {"url":"http://localhost:8791"}
```

Le deuxième argument est un délai en millisecondes par réponse (pour observer la progression).

## Organisation

- `src/app.ts` — routes ; `src/views.ts` — réponses composées ; `src/store.ts` — accès SQLite.
- `src/crawl/` — parcours (robots.txt, normalisation des adresses) ; `inventory.ts` — inventaire par le sitemap, types de pages, langues ; `shopify.ts` — catalogue `/products.json` ; `src/net/` — chargement protégé (adresses internes refusées avant et après résolution DNS, à chaque redirection).
- `src/coverage.ts` — couverture d'une analyse (`Coverage`).
- `src/analyse/grille.ts` — grille sur 100 portée depuis `reference/sonde-seo.html` ; `catalogue.ts` — textes et correctifs ; `aggregate.ts` — problèmes, doublons, points forts, recommandations.
- `src/gsc/import.ts` — export Search Console (.zip ou .csv, FR ou EN).
- `src/chat/` — assistant et ses outils ; `src/competitors/` — relevé des concurrents.

## Couverture d'une analyse

1. **Inventaire** : le sitemap (index, sous-sitemaps, `?from=…&to=…`, `.gz`) est lu en entier avant le parcours (60 fichiers, 50 000 adresses, 90 s au plus). Chaque adresse est classée par type (`PageType`) d'après son chemin (Shopify, WooCommerce, WordPress, chemins courants), puis d'après le nom du sitemap. Les adresses exclues (panier, compte, recherche) ou interdites par robots.txt ne sont pas inventoriées. Un sitemap illisible rend inconnu le décompte de son type (`onSite: null`), ou de tous les types s'il n'a pas de type reconnaissable.
2. **Langue principale seulement** : les préfixes de langue (`/en/`, `/de-de/`…) différents de celui de l'adresse de départ, les sitemaps rangés sous ces préfixes et les alternatives hreflang (sitemap et accueil) sont signalés dans `otherLocales`, jamais chargés. Les codes courts ambigus (`it`, `id`, `no`…) ne comptent comme langue que confirmés par une autre source.
3. **Parcours équilibré** : l'accueil, puis les types de l'inventaire à tour de rôle, puis les liens découverts hors sitemap (du plus proche au plus lointain). Sur Shopify, `/collections/<c>/products/<h>` est ramené à `/products/<h>`.
4. **Catalogue Shopify** : si des produits inventoriés n'ont pas été ouverts, `/products.json?limit=250&page=N` est lu (40 pages au plus, 12 Mo et 20 s par page, sans suivre de redirection). Les produits ni ouverts ni en échec donnent des constats `basis: "catalogue"` (nom, description, images, doublons), sans effet sur la note.
5. **Plafond pour tout ouvrir** (`fullAuditMaxPages`) : le nombre de pages inventoriées, accueil compris ; les pages inventoriées passent avant les liens, donc ce plafond suffit à toutes les ouvrir. `complete` vaut `true` quand toutes les pages inventoriées ont été chargées (ouvertes ou en échec). `catalogue` : `read` (des produits non ouverts viennent du catalogue), `not_needed` (tous les produits inventoriés ont été ouverts), `unavailable` (des produits n'ont pas été ouverts et `/products.json` est illisible, vide ou interdit par robots.txt), `null` hors Shopify.

Base existante : les colonnes `pages.page_type`, `page_failures.page_type` et `audits.coverage_json` sont ajoutées à l'ouverture. Les anciennes lignes gardent `NULL` : le type est déduit du chemin, la couverture vaut « par les liens » (`onSite: null`).

Pendant l'inventaire et la lecture du catalogue, `AuditStatus.currentUrl` désigne le fichier en cours de lecture (sitemap ou `/products.json`), pas une page.
