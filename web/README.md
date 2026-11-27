# Interface — Chat SEO

Application React + TypeScript (Vite). Elle consomme le format d'échange de `docs/format-echange.md` ; les types sont importés depuis `../shared/api.ts` (import de types uniquement).

## Commandes (depuis `web/`)

```bash
npm install
npm run dev        # interface sur http://localhost:5173, /api relayé vers http://localhost:8787 (flux SSE compris)
npm run dev:demo   # mode démonstration : faux serveur en mémoire, aucun appel au vrai serveur (/api n'est pas relayé)
npm run typecheck
npm run build      # vérifie les types puis compile dans web/dist
```

## Mode démonstration (développement uniquement)

`npm run dev:demo` lance `vite --mode demo`. Ce mode s'active lui-même, sans aucun fichier `.env` : `vite.config.ts` définit `VITE_DEMO=1`, **désactive le relais `/api` vers le port 8787** et répond 503 à toute requête `/api` qui atteindrait quand même le serveur de développement (message « [démo] requête /api bloquée » dans le terminal). Dans le navigateur, `src/lib/transport.ts` remplace `fetch` par `src/demo/server.ts`, sans jamais se rabattre sur le vrai réseau (si le faux serveur ne charge pas, toute requête échoue). Il répond aux mêmes routes à partir de `docs/exemples/exemples.json`, étoffé par `src/demo/data.ts` (deux sites : 42 et 360 pages). Le badge « Données de démonstration » s'affiche en bas de la navigation. La condition est `import.meta.env.DEV && (MODE === "demo" || VITE_DEMO === "1")` : elle vaut `false` dans tout build de production, et le module n'est pas inclus dans `dist/` (vérifié par recherche dans les fichiers compilés).

**Ne lancez jamais `npm run dev` (sans démo) pour essayer l'interface** quand le serveur du port 8787 est relié à une vraie boutique : `/api` y est relayé et les écritures seraient réelles.

Scénarios, avec `?demo=…` dans l'adresse (mémorisé pour l'onglet) :

| Scénario | Ce qu'il montre |
|---|---|
| `complet` | Deux sites analysés, Search Console importée, concurrents relevés, assistant configuré. Atelier Lune : couverture partielle (42 pages ouvertes en entier, 74 produits lus dans le catalogue Shopify, version anglaise signalée, « Analyser les 116 pages ») ; Maison Orlux : couverture complète (360 pages) |
| `liens` | Atelier Lune sans sitemap : inventaire inconnu (`inventory: "links"`), aucun total inventé |
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

Boutique Shopify (`src/demo/shopify.ts`, boutique fictive du site Atelier Lune), avec `?boutique=…` dans l'adresse (mémorisé pour l'onglet, combinable avec `?demo=`) :

| État | Ce qu'il montre |
|---|---|
| `lecture` (défaut) | Boutique connectée et lue, modifications désactivées côté serveur, permission des images manquante |
| `ecriture` | Modifications activées, toutes les permissions |
| `ecriture-partielle` | Modifications activées, permission des images manquante |
| `jamais-lue` | Boutique connectée jamais lue : invitation à la lire (la lecture dure ~3 s) |
| `erreur` | Shopify ne répond pas (`connection.state: "error"`) |
| `non-configuree` | Aucune boutique configurée : la section disparaît du menu, reste joignable par son adresse |

Maison Orlux montre toujours « la boutique connectée est celle d'un autre site ». Saisies spéciales dans un champ, au moment d'appliquer : `conflit` → la valeur est changée « dans Shopify » puis `shopify_conflict` ; `rafale` → `rate_limited` (20 s) ; `permission` → `shopify_missing_scope` ; `panne` → `shopify_unavailable` ; `relecture` → écriture acceptée mais non relue (`afterVerified: false`). Les valeurs avec `<`, `>`, un caractère de contrôle ou trop longues sont bloquées par l'interface avant la confirmation (le faux serveur répond `shopify_invalid_value` s'il les reçoit). Les images des collections et des articles sont en lecture seule (`readOnlyReasons.image_alt`). Une lecture complète par minute au plus.

## Captures

```bash
python3 scripts/matrix.py [filtre]   # tous les écrans et états, 1440/834/390 px, clair et sombre
```

Les images vont dans `web/.captures/` (ignoré par git), avec une planche par écran dans `web/.captures/planches/`. Le serveur de démonstration doit tourner (`npm run dev:demo`).

## Organisation

- `src/styles/tokens.css` — les tokens ; `DESIGN.md` — le design system.
- `src/ui/` — composants de base. `src/layout/` — ossature. `src/screens/` — un fichier par écran.
- `src/lib/` — client d'API, cache de requêtes (ETag, données affichées puis rafraîchies), routeur, lecture SSE, flux en direct.
