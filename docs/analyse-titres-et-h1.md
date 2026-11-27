# Titres pour Google vides et doubles H1 : ce que montre le HTML réel

Analyse du 27 novembre 2026 sur orluxjewelry.com, en lecture seule : pages de l'audit (98 pages ouvertes), boutique lue par l'API, fichiers du thème publié (Focal 12.7.1) lus par l'API.

## 1. Un titre pour Google vide dans Shopify n'est pas un problème en soi

Quand le champ est vide, Shopify affiche le nom de l'élément dans la balise `<title>`. C'est ce texte que Google lit.

| Type | Titre vide dans Shopify (pages ouvertes) | Titre affiché validé par la grille | À revoir |
|---|---|---|---|
| Produits | 46 | 45 | 1 (« Set Piercing Hoops Or • Chic », 28 caractères) |
| Articles | 23 | 15 | 8 (trop courts, ex. « Tendance piercing 2026 », 22 caractères) |
| Collections | 4 | 0 | 4 (ex. « Piercings Anneaux », 17 caractères) |
| Pages | 3 | 0 | 3 (ex. « Contact », 7 caractères) |

Sur les 196 titres vides de la boutique, la grande majorité est donc correcte : les noms de produits font déjà 30 à 60 caractères. Les vrais défauts de titre sont 16 pages sur 98, plus 2 collections dont le titre renseigné est trop court.

**Conséquence pour le logiciel.** Le chiffre « sans titre pour Google » ne doit pas être présenté comme un défaut. Le logiciel s'appuie désormais sur le verdict de l'analyse de la page affichée (`ShopifyResourceSummary.audit`, `sync.toFix`), pas sur le fait que le champ soit vide.

## 2. Les descriptions vides, elles, sont un vrai problème

Quand la description est vide, Shopify prend le début du texte de l'élément, coupé à 320 caractères. Résultat réel :

- 27 produits ouverts sur 46 : description de 320 caractères qui commence par « Matériaux … », trop longue et peu vendeuse.
- 23 articles sur 23 : début de l'article, 319 caractères.
- 4 collections et 1 page : aucune description du tout.

Les 18 produits dont la description est renseignée valident tous la grille, sauf un : **« Piercing Barrette Or 18K • Hélix », dont la description pour Google vaut « llo » (3 caractères).** C'est une erreur de saisie visible dans Google.

## 3. Les 89 pages « titre principal manquant ou en double » ont trois origines différentes

| Pages | Constat | Origine | Où corriger |
|---|---|---|---|
| 46 produits | 2 H1 : le nom du produit, puis « FAQ » | `sections/faq.liquid`, ligne 42 : le titre de la section est balisé `<h1 class="heading h2">` | Thème : remplacer `h1` par `h2` sur cette ligne |
| 19 articles sur 23 | 2 H1 identiques | Le premier vient du thème (`sections/blog-post-banner.liquid`, ligne 116). Le second est **dans le texte de l'article** : 19 articles commencent par un `<h1>` qui répète leur titre | Contenu : retirer ce `<h1>` du texte des 19 articles (ou le passer en `<h2>`). Aucun changement de thème |
| 22 collections | Aucun H1 | La section `collection-banner`, qui porte le H1 du titre de la collection, est **désactivée** dans `templates/collection.json` | Thème : réactiver la section, ou baliser le titre de la collection en `<h1>` dans la section qui le remplace |
| Accueil | 3 H1 : le logo, « Les plus grosses offres de l'année ! », « FAQ » | `sections/header.liquid` ligne 173 (comportement d'origine de Focal sur l'accueil), `sections/banierre-hero-V2.liquid` ligne 235 (section ajoutée), `sections/faq.liquid` ligne 42 | Thème : garder un seul H1 ; passer les deux autres en `h2` |
| Contact | 2 H1 : « Contact », « Contact Us » | `sections/main-page.liquid` ligne 18 et `sections/contact-form.liquid` ligne 102 | Thème : `h2` dans `contact-form.liquid` |

Le total fait bien 89 (46 + 19 + 22 + 1 + 1).

Au passage : le modèle des collections contient encore une section « Rich text » avec le texte d'exemple du thème (« Talk about your brand »). À vérifier dans l'éditeur de thème : si elle est visible, ce texte anglais s'affiche sur les 22 collections.

## Corrections proposées (aucune n'est appliquée)

1. **`sections/faq.liquid` : `h1` → `h2`.** Une ligne. Corrige 46 produits et retire un H1 de l'accueil. Aucun effet visuel : la classe CSS `heading h2` ne change pas.
2. **`sections/contact-form.liquid` : `h1` → `h2`.** Une ligne.
3. **Accueil : choisir le H1.** Recommandation : garder le titre de la bannière (à réécrire pour décrire la boutique plutôt qu'une promotion), et ne plus baliser le logo en H1.
4. **Collections : rendre un H1.** À décider en regardant la page : réactiver la bannière change l'apparence.
5. **19 articles : retirer le `<h1>` en tête du texte.** Faisable par l'API avec la permission déjà accordée (`write_content`), mais c'est une modification du texte des articles : à faire avec aperçu et restauration, pas à la main dans 19 articles.

Les corrections 1 à 4 touchent le thème. Elles se font sur une copie non publiée (voir `docs/theme-access.md`), jamais sur le thème en ligne.
