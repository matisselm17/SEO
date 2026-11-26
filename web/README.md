# Interface — Chat SEO

Application React + TypeScript (Vite). Elle consomme le format d'échange de `docs/format-echange.md` ; les types sont importés depuis `../shared/api.ts` (import de types uniquement).

## Commandes (depuis `web/`)

```bash
npm install
npm run dev        # interface sur http://localhost:5173, /api relayé vers http://localhost:8787 (flux SSE compris)
npm run dev:demo   # mode démonstration : faux serveur en mémoire, aucun serveur nécessaire
npm run typecheck
npm run build      # vérifie les types puis compile dans web/dist
```

## Mode démonstration (développement uniquement)

`npm run dev:demo` charge `.env.demo` (`VITE_DEMO=1`). `src/lib/transport.ts` remplace alors `fetch` par `src/demo/server.ts`, qui répond aux mêmes routes à partir de `docs/exemples/exemples.json`, étoffé par `src/demo/data.ts` (deux sites : 42 et 360 pages). La condition est `import.meta.env.DEV && VITE_DEMO === "1"` : elle vaut `false` dans tout build de production, et le module n'est pas inclus dans `dist/` (vérifié par recherche dans les fichiers compilés).

Scénarios, avec `?demo=…` dans l'adresse (mémorisé pour l'onglet) :

| Scénario | Ce qu'il montre |
|---|---|
| `complet` | Deux sites analysés, Search Console importée, concurrents relevés, assistant configuré |
| `vide` | Aucun site : accueil et ajout. Une adresse contenant `injoignable` renvoie `site_unreachable` |
| `sans-gsc` | Pas d'export Search Console, conversation vide |
| `sans-config` | Assistant et concurrents non configurés côté serveur |
| `analyse` | Une analyse qui progresse en direct (flux `/events`) |
| `analyse-figee` | Une première analyse figée à 17 pages, pour les captures |
| `relance` | Relance d'une analyse terminée : les résultats précédents restent affichés, puis basculent à la fin |
| `relance-figee` | La même relance, figée à 9 pages |
| `echec` | `boutique-sable.example` : première analyse en échec (aucune page) ; Atelier Lune : relance interrompue par un redémarrage du serveur ; Maison Orlux : 4 pages notées pour 9 non chargées (note peu fiable) |
| `coupure` | Le flux en direct se coupe après 2,5 s et ne revient pas (indicateur de connexion perdue) |
| `erreurs` | Les lectures échouent pendant 2 s puis réussissent à la relance ; l'assistant s'interrompt après un début de réponse ; le relevé des concurrents répond `competitors_unavailable` |
| `lent` | Les écrans restent en chargement (skeletons) |

Saisies spéciales, dans tous les scénarios :

- ajout d'un site : une adresse contenant `injoignable` → `site_unreachable`, `plafond` → `limit_reached`, `rafale` → `rate_limited` (20 s) ;
- assistant : une question contenant `clé` → clé refusée avant toute réponse (erreur définitive, champ désactivé), `panne` → échec avant toute réponse (la question n'est pas conservée), `limite` → `rate_limited` (45 s) ;
- Search Console : un fichier nommé `pas-un-export…` est refusé (`invalid_file`).

## Captures

```bash
python3 scripts/matrix.py [filtre]   # tous les écrans et états, 1440/834/390 px, clair et sombre
```

Les images vont dans `web/.captures/` (ignoré par git), avec une planche par écran dans `web/.captures/planches/`. Le serveur de démonstration doit tourner (`npm run dev:demo`).

## Organisation

- `src/styles/tokens.css` — les tokens ; `DESIGN.md` — le design system.
- `src/ui/` — composants de base. `src/layout/` — ossature. `src/screens/` — un fichier par écran.
- `src/lib/` — client d'API, cache de requêtes (ETag, données affichées puis rafraîchies), routeur, lecture SSE, flux en direct.
