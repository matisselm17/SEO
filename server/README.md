# Serveur Chat SEO

Paquet npm indépendant (Node 22, TypeScript) : API HTTP de `docs/format-echange.md`, parcours des sites, notation, SQLite (`node:sqlite`), import Search Console, assistant (API Claude), concurrents (Firecrawl).

```bash
npm install
npm run dev        # rechargement à chaud, port 8787
npm run typecheck
npm test
npm run build && npm start   # sert aussi ../web/dist s'il existe
```

La configuration est lue depuis l'environnement, puis depuis `../.env` s'il existe (voir `docs/format-echange.md`). Un `DATA_DIR` relatif est compris depuis la racine du dépôt.

## Variable réservée au développement

`ALLOW_PRIVATE_HOSTS=1` autorise le chargement d'adresses internes (localhost, plages privées). **Désactivée par défaut, à ne jamais activer en production** : elle sert uniquement à analyser le site d'essai local.

```bash
npx tsx test/helpers/fixture-site.ts 8790            # site d'essai sur http://localhost:8790
ALLOW_PRIVATE_HOSTS=1 npm run dev                    # puis POST /api/sites {"url":"http://localhost:8790"}
```

## Organisation

- `src/app.ts` — routes ; `src/views.ts` — réponses composées ; `src/store.ts` — accès SQLite.
- `src/crawl/` — parcours (robots.txt, sitemap, normalisation des adresses) ; `src/net/` — chargement protégé (adresses internes refusées avant et après résolution DNS, à chaque redirection).
- `src/analyse/grille.ts` — grille sur 100 portée depuis `reference/sonde-seo.html` ; `catalogue.ts` — textes et correctifs ; `aggregate.ts` — problèmes, doublons, points forts, recommandations.
- `src/gsc/import.ts` — export Search Console (.zip ou .csv, FR ou EN).
- `src/chat/` — assistant et ses outils ; `src/competitors/` — relevé des concurrents.
