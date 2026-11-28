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
| `pause` | Relance en pause à 23 pages : le site limite les demandes (`pausedUntil` dans 4 min) |

Saisies spéciales, dans tous les scénarios :

- ajout d'un site : une adresse contenant `injoignable` → `site_unreachable`, `plafond` → `limit_reached`, `rafale` → `rate_limited` (20 s) ;
- assistant : une question contenant `clé` → clé refusée avant toute réponse (erreur définitive, champ désactivé), `panne` → échec avant toute réponse (la question n'est pas conservée), `limite` → `rate_limited` (45 s) ;
- Search Console : un fichier nommé `pas-un-export…` est refusé (`invalid_file`).

Accès refusé (mode intégré à Shopify), avec `?acces=…` (mémorisé pour l'onglet, combinable ; `?acces=normal` revient à l'accès normal) :

| État | Ce qu'il montre |
|---|---|
| `refuse` | Toute requête répond `401 unauthorized` (page ouverte hors de l'administration Shopify) : l'écran « accès refusé » remplace toute l'application, avec le message et l'action du serveur |
| `autre-boutique` | Toute requête répond `403 shop_not_allowed` (le serveur ne sert plus cette boutique : application désinstallée) : même écran, autre message |
| `illisible` | Toute requête répond 401 avec un corps illisible : l'écran affiche le texte de repli de l'interface |

Parcours intégré à Shopify (une boutique, un site), avec `?integre=…` (mémorisé pour l'onglet, combinable ; `?integre=non` revient au mode local) :

| État | Ce qu'il montre |
|---|---|
| `non` (défaut) | Mode local : plusieurs sites, ajout, suppression, plafond de pages dans les Paramètres |
| `oui` | Mode intégré : « Préparation de votre boutique… » pendant environ 2,6 s, puis le site d'Atelier Lune s'ouvre. Ni ajout, ni suppression, ni liste de sites, ni plafond de pages ; toute adresse sans site ou d'un autre site mène au site de la boutique. `POST /api/sites`, `DELETE /api/sites/:id` et `PATCH /api/settings` répondent `403 not_in_embedded_mode` |
| `echec` | La première lecture des sites échoue (`shopify_unavailable`) : message, action et « Réessayer », qui réussit |
| `vide` | La lecture des sites rend une liste vide : « Votre boutique n'est pas encore prête. » avec « Réessayer » |

Toute l'interface lit le mode intégré par `isEmbedded()` (`src/lib/embedded.ts`) : présence d'App Bridge hors démonstration, paramètre `?integre=` en démonstration.

Hors démonstration, quand App Bridge est présent (`window.shopify`, script injecté par le serveur en mode intégré), `src/lib/transport.ts` demande un jeton de session neuf avant chaque requête (`Authorization: Bearer …`, délai maximal 10 s) et rejoue une fois une requête refusée avec l'en-tête `X-Shopify-Retry-Invalid-Session-Request`. La démonstration n'envoie jamais de jeton.

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

Lots de corrections et automatisation (boutique d'Atelier Lune), règle choisie avec `?ia=…` (mémorisé pour l'onglet, combinable) :

| État | Ce qu'il montre |
|---|---|
| `propose` (défaut) | L'IA prépare, un humain valide ; mode automatique non autorisé côté serveur : il n'est pas proposé, l'encadré « Vous validez chaque proposition » remplace les quatre verrous |
| `auto` | Mode automatique autorisé et choisi : avec `?boutique=ecriture`, « Préparer des corrections avec l'IA » écrit sans validation les lignes conformes à la règle et au filtre de contenu (`autoApplied` par ligne) ; la section porte alors le signal « Écritures automatiques actives » |
| `auto-refuse` | « auto » enregistré mais non autorisé côté serveur : le niveau automatique n'est pas proposé ; l'écran dit qu'il se comporte comme « vous validez » et demande d'en choisir un autre avant d'enregistrer |
| `arret` | L'IA ne prépare rien (`automation_off`) |
| `sans-cle` | Aucune clé d'IA (`aiConfigured: false`, assistant non configuré) |
| `budget` | Plafond de jetons du jour atteint (`budget_exceeded`, heure de remise à zéro) |

Lots présents au chargement : un brouillon de l'assistant (4 lignes, dont une trop longue) ; « Descriptions vides de produits », préparé par l'optimisation automatique, dont trois lignes ont été écrites sans validation humaine (`ShopifyBatchItem.autoApplied`, mention par ligne) et une a été retenue par le filtre de contenu (elle cite un nom de domaine : « À relire par vous », le lot est repassé en brouillon) ; un lot appliqué en partie (une ligne en conflit, une refusée), un lot annulé, un abandonné, un en échec de préparation.

Écrire ou annuler un lot (avec `?boutique=ecriture`) avance d'une ligne toutes les 1,6 s ; le bouton « Arrêter après la ligne en cours » (route `stop`, sans confirmation) laisse un lot partiel, avec un bilan et « Reprendre l'écriture… ». Lancer un second lot pendant qu'un premier écrit répond `limit_reached` (« un autre lot est en cours », lien vers ce lot). Une proposition contenant `panne` est refusée, `conflit` provoque un conflit. Limites de débit simulées : un lot nommé `rafale`, plus de 5 préparations par l'IA ou plus de 10 enregistrements de la règle par minute répondent `rate_limited` (le bouton attend la fin du délai). La conversation d'Atelier Lune se termine par une réponse qui porte le lot de l'assistant ; une question contenant `corrige` ou `prépare` en crée un nouveau. **Un lot de l'assistant attend toujours une validation humaine**, même en `?ia=auto` : seule « Préparer des corrections avec l'IA » peut écrire seule.

Lecture directe de la Search Console, avec `?gsc=…` : `google` (défaut, compte de service présent), `non-configure`, `sans-acces` (`search_console_no_access` avec l'adresse du compte), `indispo` (`search_console_unavailable`). Une seule lecture par minute (`rate_limited`). Le sélecteur de période reprend celle des données affichées (l'export déposé couvre 91 jours : « 3 mois » ; une lecture directe, la période demandée), 28 jours sans données. Sous la liste des recherches, une ligne compare la somme des clics des recherches listées au total (en démo, environ deux tiers) : Google ne détaille pas les recherches trop rares.

Google Analytics (`src/demo/google.ts`), avec `?ga=…` (mémorisé pour l'onglet, combinable) :

| État | Ce qu'il montre |
|---|---|
| `lu` (défaut) | Visites lues il y a deux jours (28 jours). Atelier Lune mesure ses ventes (`revenueStatus: "measured"`, chiffre d'affaires en euros) ; Maison Orlux non (`not_measured`, `revenue: null` : « Non mesuré », jamais 0 €) |
| `tronque` | Comme `lu`, mais 12 pages d'arrivée seulement et `landingPagesTruncated: true` : note sous le tableau, et la fiche d'une page absente de la liste dit qu'elle n'est pas parmi les pages les plus visitées (au lieu de « aucune visite ») |
| `ca-masque` | Comme `lu`, mais `revenueStatus: "restricted"` : « Non visible », avec le rôle à demander dans Google Analytics |
| `jamais-lu` | Propriété configurée, jamais lue : invitation à lire (28 jours ou 3 mois) |
| `non-configure` | `integrations.analytics.configured` faux : explication de ce qu'il faut côté serveur |
| `sans-acces` | La lecture répond `analytics_no_access` avec l'adresse du compte de service et les étapes |
| `autre-site` | La lecture répond `analytics_other_site` |
| `indispo` | La lecture répond `analytics_unavailable` (`retryable`) |

Une lecture par minute au plus : une deuxième lecture dans la minute répond `rate_limited` (le bouton attend la fin du délai). « Réessayer » après une erreur relit la période choisie. Les fiches des pages analysées portent `visits` dès qu'une lecture existe.

Vitesse des pages, avec `?vitesse=…` (mémorisé pour l'onglet, combinable) :

| État | Ce qu'il montre |
|---|---|
| `mesure` (défaut) | Six pages mesurées il y a trois jours : vécu réel de la page pour l'accueil, de tout le site (`scope: "site"`) ou absent (`field: null`) pour les autres. `failures` de la dernière demande : `/collections` a échoué sur ordinateur (sa note précédente reste, marquée), `/pages/livraison` sur les deux appareils (ligne « Échec », raison dans la ligne ouverte et sur sa fiche) ; résumé en tête du bloc |
| `jamais` | Aucune page mesurée : invitation à mesurer |
| `en-cours` | Mesure en cours à 2 pages sur 7, qui avance d'une page toutes les 6 s (Google prend 10 à 40 s par page et par appareil) ; « Arrêter » garde les pages mesurées |
| `erreur` | Pages mesurées et `lastError` : la demande entière s'est arrêtée (quota de la clé épuisé) |
| `indispo` | Lancer une mesure répond `pagespeed_unavailable` |
| `rafale` | Lancer une mesure répond `rate_limited` (30 pages déjà mesurées dans l'heure, 21 min) |
| `non-configure` | `integrations.pageSpeed.configured` faux |

Lancer une mesure pendant qu'une autre tourne répond `limit_reached` ; au-delà de 30 pages mesurées dans l'heure, `rate_limited` avec le délai. Une nouvelle demande remet `failures` à zéro ; pendant la mesure, la 4ᵉ page échoue sur ordinateur (la mesure continue). « Mesurer cette page » (fiche d'une page) envoie `pageIds: [id]`. Une amélioration proposée contient « <script> » pour vérifier qu'elle s'affiche comme du texte. Le scénario `sans-config` désactive aussi Google Analytics et la vitesse.

Sections masquées (`Settings.features`), avec `?masquer=…` (liste séparée par des virgules, mémorisée pour l'onglet ; `?masquer=rien` revient à toutes les sections) :

| Valeur | Section masquée |
|---|---|
| `rien` (défaut) | Aucune : toutes les sections présentes, comme en mode local |
| `tout` | Toutes, comme le mode intégré sans `EMBEDDED_FEATURES` |
| `concurrents` | Concurrents (`competitors`) |
| `visites` | Visites Google Analytics (`analytics`) |
| `vitesse` | Vitesse des pages (`pageSpeed`) |
| `assistant` | Assistant IA et tout bouton « demander à l'assistant » (`assistant`) |
| `lecture-gsc` | Seulement « Lire depuis Google » (`searchConsoleSync`) ; le dépôt de l'export reste |

Exemple : `?masquer=assistant,vitesse`. En mode intégré (`?integre=oui`), `visites` et `lecture-gsc` sont toujours masquées, et le mode automatique n'est jamais autorisé, quel que soit `?ia=`. Les routes d'une section masquée répondent `403 not_in_embedded_mode` et le faux serveur écrit `[démo] route d'une section masquée appelée` dans la console : l'interface ne doit jamais l'afficher. Le point de vérité de l'interface est `src/lib/features.ts`.

Évolution d'Atelier Lune (`GET …/progress`, bloc « Évolution » de la Vue d'ensemble et « Rapport d'optimisation », `/sites/:id/rapport`), avec `?evolution=…` (mémorisé pour l'onglet) :

| État | Ce qu'il montre |
|---|---|
| `plusieurs` (défaut) | Six analyses terminées, du 20 au 26 novembre ; la précédente vaut 61 (comme `score.previous`). La première, plus faible, a deux pages qui n'existent plus : comparaison à périmètre égal sur 40 pages communes, calculée pour de vrai sur les critères des pages |
| `une` | Une seule analyse terminée : note actuelle et « La comparaison apparaîtra après la prochaine analyse. » |
| `sans-comparaison` | Six analyses, mais le détail des pages de la première n'est plus conservé : `comparison: null` |

« Aucune analyse terminée » (`available: false`) : `?demo=analyse-figee` (première analyse en cours) ou `?verrou=premiere`. Maison Orlux a toujours une seule analyse. Une relance qui se termine ajoute un point à la courbe. Le bilan des corrections est compté sur l'historique de la boutique de démonstration, comme la liste des corrections vérifiées du rapport : les compteurs et la liste concordent (vérifier une correction dans la boutique les met à jour ensemble). Sans boutique reliée au site (Maison Orlux, `?boutique=non-configuree` ou `erreur`), tout vaut 0.

Boutique protégée par un mot de passe (`storefront_locked`), avec `?verrou=…` (mémorisé pour l'onglet ; `?verrou=non` revient à la normale) :

| État | Ce qu'il montre |
|---|---|
| `premiere` | La première analyse d'Atelier Lune a échoué : état dédié dans la Vue d'ensemble, l'Audit, les Pages et les Recommandations (message et action de l'erreur, « Relancer l'analyse », « Ouvrir la section Boutique Shopify ») |
| `relance` | La dernière analyse a échoué ; les résultats précédents restent affichés et le bandeau d'analyse porte le même état, avec le lien vers la boutique |

Tant que le paramètre est actif, « Relancer l'analyse » échoue de nouveau après 1,5 s.

## Captures

```bash
python3 scripts/matrix.py [filtre]   # tous les écrans et états, 1440/834/390 px, clair et sombre
```

Les images vont dans `web/.captures/` (ignoré par git), avec une planche par écran dans `web/.captures/planches/`. Le serveur de démonstration doit tourner (`npm run dev:demo`).

## Organisation

- `src/styles/tokens.css` — les tokens ; `DESIGN.md` — le design system.
- `src/ui/` — composants de base. `src/layout/` — ossature. `src/screens/` — un fichier par écran.
- `src/lib/` — client d'API, cache de requêtes (ETag, données affichées puis rafraîchies), routeur, lecture SSE, flux en direct.

## Sécurité du serveur de développement

`vite.config.ts` ne sert par `/@fs/` que `web/`, `shared/` et `docs/exemples/` (`server.fs.allow`) et refuse en plus `.env*`, `secrets/**`, `data/**`, `themes/**`, `*.sqlite*`, `*.db`, `.git/**` (`server.fs.deny`) : la base SQLite, la sauvegarde de la boutique et le compte de service Google ne sont jamais lisibles depuis le port 5173. Vérification :

```
curl -s -o /dev/null -w '%{http_code}\n' "http://localhost:5173/@fs$PWD/data/chat-seo.sqlite"   # 403
```
