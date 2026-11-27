# Design system — Chat SEO

Le parti pris : **un outil d'atelier, pas une vitrine.** L'interface ressemble à un bon logiciel de travail : du blanc, de l'encre, une seule couleur d'accent, et des couleurs de gravité qui ne servent qu'à signaler. Les espaces séparent ; une bordure ou un fond n'apparaît que lorsqu'il a un rôle (zone cliquable, panneau posé au-dessus du reste, bloc de code, résumé de la note).

Tout vit dans `src/styles/tokens.css` (valeurs) et `src/ui/` (composants). Aucun écran n'invente une couleur, une taille de texte ou un espacement.

## Couleurs

| Rôle | Clair | Sombre | Emploi |
|---|---|---|---|
| Fond | `#ffffff` | `#141518` | Zone de contenu |
| Fond discret | `#f6f6f4` | `#191a1e` | Navigation, survol des lignes |
| Fond atténué | `#efefec` | `#23252a` | Pistes de jauges, onglets, survol |
| Trait | `#e5e5e1` | `#2a2c32` | Séparateurs de lignes |
| Encre | `#16181d` | `#ececee` | Texte, bouton principal |
| Encre secondaire | `#5a5e67` | `#a4a7af` | Explications |
| **Accent outremer** | `#2337c6` | `#7f8fff` | Liens, focus, élément actif, série « clics » |
| Critique | `#c42f27` | `#ff7a6e` | Gravité critique, note < 50 |
| À améliorer | `#9a5b00` (texte), `#d98a12` (marque) | `#f0b250` | Gravité moyenne, note 50 à 69 |
| Bon | `#1b7547` (texte), `#23905a` (marque) | `#5cc98f` | Validé, note ≥ 70 |
| Mineur | `#555d6b` | `#a9b0bd` | Gravité mineure |

Règles :
- L'accent (bleu outremer) n'est **jamais** une couleur de gravité. Rouge, ambre et vert sont réservés à l'état.
- La gravité n'est jamais portée par la couleur seule : chaque badge a une icône et un mot (« Critique », « À améliorer », « Mineur ») ; la pastille de note change aussi de forme (rond, losange, carré).
- Le bouton principal est à l'encre (noir en clair, blanc en sombre), pas à l'accent : l'accent reste rare et garde sa valeur de signal.
- Le thème sombre n'est pas une inversion : chaque valeur est choisie pour le fond sombre (contrastes vérifiés sur les captures).
- Aucun dégradé décoratif, aucun effet de verre. Les seuls dégradés sont fonctionnels : l'éclat des skeletons et le fondu sous la zone de saisie de l'assistant.

## Typographie

- **Schibsted Grotesk** (variable, servie depuis `@fontsource-variable`) pour toute l'interface : une grotesque de presse, nette et un peu dense, qui donne de la tenue aux chiffres et aux titres sans tomber dans l'Inter générique.
- **JetBrains Mono** pour ce qui est littéral : adresses de pages, code à copier, noms de variables. Jamais pour décorer des libellés.
- Échelle : 12 · 13 · 14 (courant) · 16 · 20 · 26 (titre d'écran) · 36 (chiffres clés) · 56 (note).
- Graisses : 400, 500 (libellés, liens), 600 (titres, chiffres). Pas de capitales espacées, pas de sur-titres.
- Les chiffres restent proportionnels : les chiffres tabulaires de la police élargissent la virgule française.

## Espacements, rayons, ombres, durées

- Base 4 px : 4, 8, 12, 16, 20, 24, 32, 40, 48, 64. Sections d'écran séparées par 48 px ; lignes de liste par un trait de 1 px.
- Rayons hiérarchisés : 4 (badges), 6 (boutons, champs), 8 (blocs de code, menus), 12 (seuls panneaux : résumé de la note, zones de dépôt).
- Ombres : quasi absentes. `shadow-sm` sous les contrôles posés (bouton secondaire, sélecteur de site), `shadow-lg` uniquement pour ce qui flotte (panneau latéral, menus, notifications).
- Durées : 150 ms (survol), 200 ms (apparition d'écran), 250 ms (panneau, tiroir). Toutes ramenées à 0 avec `prefers-reduced-motion`.

## Mise en page

- Navigation latérale de 256 px ; repliée en rail d'icônes de 64 px entre 768 et 1099 px ; tiroir sous 768 px.
- Contenu aligné à gauche, 1180 px au plus. Les textes courants ne dépassent pas ~72 caractères par ligne.
- Le bandeau d'analyse en cours est collé en haut du contenu, sur tous les écrans.
- Le détail d'un problème ou d'une page s'ouvre dans un panneau latéral (feuille montante sur mobile) avec sa propre adresse : il se partage, se ferme avec Échap et rend le focus.

## Composants (`src/ui/`)

| Composant | Rôle |
|---|---|
| `Button`, `ButtonLink`, `Link` | Primaire (encre), accent, secondaire, discret, danger ; tailles 30 et 36 px ; état de chargement |
| `TextField` | Libellé, aide, erreur reliée par `aria-describedby`, préfixe et suffixe |
| `SeverityBadge`, `CheckBadge`, `ScorePill`, `Tag` | Gravité, état d'un critère, note d'une page, étiquette neutre |
| `Tabs` | Onglets segmentés avec compteurs, flèches du clavier |
| `EmptyState`, `ErrorState` | Section sans données (ce qui manque, comment l'obtenir) ; erreur du serveur avec son message, son action et « Réessayer » |
| `Skeleton`, `SkeletonText`, `SkeletonRows` | Chargements à la forme du contenu |
| `ToastProvider` / `useToast` | Confirmations et erreurs d'actions |
| `Sheet` | Panneau latéral de détail |
| `ScoreGauge` | Jauge 240° avec repères aux seuils 50 et 70 |
| `CategoryBars`, `Meter` | Les cinq familles ; barres de proportion |
| `TrendChart` | Clics et impressions en petits multiples (deux graphiques, un seul axe chacun), survol synchronisé, clavier, vue en tableau |
| `CodeBlock` | Code à copier, affiché comme du texte |
| `Markdown` | Rendu sûr des réponses de l'assistant (aucun HTML interprété, liens http(s) uniquement) |
| `Dropzone` | Dépôt d'un fichier par glisser-déposer ou sélection |
| `SerpPreview` | Aperçu du résultat dans Google |
| `ConfirmButton` | Action destructive en deux temps |
| `useWindowVirtual` | Virtualisation des longues listes (pages analysées) |
| `Dialog` | Fenêtre de confirmation posée au-dessus de tout, panneau latéral compris (feuille montante sur mobile) ; Échap ne ferme qu'elle, le focus y reste |
| `CharCount` | Compteur de caractères avec repère de longueur (ceux de la grille d’audit : titre 30 à 60, description 70 à 160 ; un champ vide n’est pas compté comme un défaut) : un mot et une icône, pas la couleur seule |
| `.check` | Case à cocher du design system (coche dessinée en fond, thèmes clair et sombre) |
| `.selbar`, `.actionbar` | Barre d'action collée en bas de l'écran (sélection, brouillon, réglages non enregistrés) |
| `.seg` | Choix segmenté (période de lecture de la Search Console) |
| `.mode` | Choix exclusif détaillé (niveau d'automatisation, ce que l'IA peut remplacer) |
| `Pagination` | « 51 à 100 sur 240 », précédents, suivants, pour les listes servies par tranches |

## Boutique Shopify

- Toute écriture dans la boutique passe par une confirmation qui montre ce qui sera écrit : `ConfirmWrite` (`screens/ShopifyChanges.tsx`) pour une valeur ; `ApplyConfirm` / `RestoreConfirm` (`screens/ShopifyBatches.tsx`) pour un lot, avec le récapitulatif par champ et chaque valeur. Le focus initial est toujours sur « Ne rien… », jamais sur le bouton qui écrit.
- Lots de corrections : une valeur par ligne, jamais de valeur commune appliquée en masse. Le lot en préparation vit dans le navigateur (`lib/batchDraft.ts`) jusqu'à la création du brouillon ; le brouillon se relit ligne par ligne (avant, après, compteur, aperçu Google repliable, note de l'IA), puis se valide.
- Progression d'un lot : lignes traitées reçues du serveur ; aucune barre avant la première ligne traitée.
- Un lot appliqué sans validation humaine (`autoApplied`) est marqué partout : liseré d'accent dans la liste, mention « Sans validation humaine », bandeau sur son écran, étiquette dans l'historique.
- Verdict de l'analyse (`audit.*Status`) : « Correct », « À revoir », « Absent », avec une icône. Un champ vide dans Shopify est une information neutre (« Vide dans Shopify »), jamais un défaut en soi.
- Lecture seule (`writesEnabled` faux) : tout se consulte et se prépare ; les boutons d'application restent visibles, désactivés, avec la raison (une fois par section, bandeau `shop-readonly` auquel les boutons renvoient).
- Champ vide : on dit ce que Shopify montre à la place (« Vide : Shopify utilise le nom du produit »), jamais un simple tiret.
- Les images de la boutique ne s'affichent que si leur adresse est en https (`safeImageUrl`), sinon une vignette neutre.

## Contenu

- Tout en français, compréhensible sans connaître le SEO : « titre principal (H1) », « adresse de référence (canonical) », « taux de clic ».
- Un état vide dit ce qui manque et comment l'obtenir ; une erreur dit ce qui s'est passé et quoi faire. Jamais de donnée inventée.
- Tout texte venu d'un site, d'un fichier ou de l'assistant est rendu comme du texte (React l'échappe ; aucun `dangerouslySetInnerHTML` dans le code).
