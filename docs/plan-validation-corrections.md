# Plan de validation des corrections Shopify sur un échantillon

État au 27 novembre 2026 : **plan proposé, en attente de validation. Aucune de ces écritures n'a été faite.** Le mode automatique reste désactivé (`SHOPIFY_AUTO_APPLY` vide).

Déjà validé en réel : modifier une description pour Google existante sur un produit, puis l'annuler (`docs/premier-test-ecriture.md`).

## Déroulé de chaque test

1. Relever l'état complet de l'élément par l'API (empreinte de tout ce qui ne doit pas changer).
2. Écrire par l'interface, après contrôle de la confirmation avant/après.
3. Vérifier : valeur relue identique à la valeur envoyée, reste de l'élément identique, ligne dans l'historique.
4. Annuler depuis l'historique, vérifier le retour exact à l'état d'origine.
5. Si tout est conforme, réappliquer la valeur (elle reste annulable).

Arrêt au premier écart : on ne passe pas au test suivant.

## Les huit tests, dans l'ordre

| # | Ce que le test vérifie | Élément | Champ | Avant | Après |
|---|---|---|---|---|---|
| 1 | Créer une description qui n'existe pas | Produit « Piercing Nombril Soleil • Titane • Style Fin » `/products/piercing-nombril-soleil-titane-style-fin` | Description pour Google | vide | Piercing nombril soleil en titane ASTM F-136, sans nickel et serti de zircones, idéal pour les peaux sensibles. Découvrez ce bijou fin et lumineux. (147) |
| 2 | Écrire un titre pour Google | Produit « Set Piercing Hoops Or • Chic » `/products/set-piercing-hoops-or-chic` | Titre pour Google | vide (Google voit le nom, 28 caractères, jugé trop court) | Set de 3 piercings hoops plaqué or 18K • Lobe et hélix (54) |
| 3 | Modifier le SEO d'une collection | Collection « Titane ASTM-F136 » (95 produits) `/collections/titane-astm-f136` | Titre pour Google | Piercings en Titane ASTM-F136 (29, jugé trop court) | Piercings en titane ASTM F-136 : anneaux, labrets et bijoux (59) |
| 4 | Modifier une traduction | Produit « Piercing Barrette Or 18K • Hélix », anglais | Description pour Google | Hello (périmée) | Bar piercing in 925 silver with 18K gold plating, for helix or lobe. Hypoallergenic, nickel-free, water-resistant. 10 mm straight screw post. (141) |
| 5 | Modifier le texte alternatif d'une image de produit | Produit « Piercing Barrette Or 18K • Hélix », image 1 | Texte alternatif | vide | Piercing barrette plaqué or 18 carats pour hélix ou lobe, sur fond blanc (72) |
| 6 | Modifier le SEO d'une page | Page « Contact » `/pages/contact` | Description pour Google | vide | Contactez Orlux Jewelry par e-mail : réponse sous 24 h les jours ouvrés, du lundi au vendredi de 10 h à 18 h, pour toute question ou collaboration. (147) |
| 7 | Modifier le SEO d'un article | Article « Tendance piercing 2026 » `/blogs/infos/tendance-piercing-2026` | Titre pour Google | vide (Google voit le nom, 22 caractères, jugé trop court) | Tendance piercing 2026 : les styles à ne pas manquer (52) |
| 8 | Corrections groupées (un lot de 4 lignes) | 4 produits, description pour Google | | | |

Lot du test 8, quatre descriptions aujourd'hui vides :

| Produit | Après |
|---|---|
| « Set Piercings Gold • Pendants Élégants » | Set de 3 piercings pendants en argent 925 ou plaqué or 18K, sans nickel, pour lobe, hélix ou tragus. Composez un look d'oreille élégant. (136) |
| « Set Piercings Or 3pcs • Style Minimaliste » | Set de 3 piercings en argent 925 ou plaqué or 18K, hypoallergéniques et sans nickel, pour lobe, hélix ou tragus. Un style minimaliste au quotidien. (147) |
| « Set piercing oreilles 4 pcs • Lobe, Hélix, Rook » | Set de 4 piercings d'oreille en argent 925 ou plaqué or 18K pour lobe, hélix et rook. Hypoallergéniques, sans nickel, résistants à l'eau. (137) |
| « Piercing Barrette Or 18K • Hélix ou Lobe » | Puce d'oreille barrette plaquée or 18 carats sur argent 925, pour lobe, hélix, tragus ou conque. Sans nickel et résistante à l'eau, pour un port quotidien. (155) |

Toutes les valeurs ne reprennent que des faits lus dans le texte des éléments. Le texte alternatif du test 5 est à contrôler par le propriétaire : l'image n'a été vue qu'en vignette.

## Pourquoi cet ordre

Du moins incertain au plus incertain. Les tests 1 et 2 créent un champ sur un produit (le chemin déjà éprouvé, moins l'existence préalable du champ). Le test 3 modifie un champ existant sur une collection. Le test 4 passe par une autre écriture (`translationsRegister`). Le test 5 est le premier `fileUpdate` réel : on vérifie que l'image elle-même ne change pas. Les tests 6 et 7 créent un champ sur une page et un article, jamais essayé. Le lot vient en dernier : il enchaîne des écritures déjà validées une à une.

## Ce que ces tests ne couvrent pas

- Vider un champ (remettre à vide une valeur qui existait avant).
- Le texte alternatif d'une image de collection ou d'article : toujours bloqué, Shopify peut remplacer l'image.
- Le mode automatique et la préparation par l'IA.
- La traduction allemande du même produit (« Hallo », périmée elle aussi) : à corriger après le test 4, hors plan.

## Ce qui manque au logiciel, constaté en préparant ce plan

**Vérifier une correction par le moteur.** Aujourd'hui une écriture relue dans Shopify est « appliquée » ; rien ne dit si le problème SEO est résolu. Il manque : la nouvelle analyse d'une seule page après une écriture ; le lien entre une correction et le critère de l'audit qu'elle visait ; les statuts « vérifiée » (le critère passe sur la page rechargée) et « échouée » (la valeur est écrite mais la page ne valide toujours pas, ou n'affiche pas la valeur). Existent déjà : détecté (audit), proposé (lot en brouillon), appliqué et annulé (historique). Limites à prévoir : le cache de Shopify peut retarder l'affichage ; une traduction se vérifie sur l'adresse de la langue, que l'audit ne lit pas encore.

**Suivre l'évolution.** L'interface montre la note actuelle, la note précédente, les problèmes actuels, l'avant/après et l'historique des modifications. Il manque : la note initiale, la courbe des notes, les problèmes corrigés et restants, les pages optimisées, les résultats des nouvelles analyses.

**Comparer des notes comparables.** Les deux analyses terminées (94 et 98 pages) n'ont que **29 pages en commun** : l'échantillon de 100 pages change d'une analyse à l'autre. Deux notes de 88 ne se comparent donc pas. Il faut un périmètre stable (les mêmes pages réanalysées, ou une note calculée sur les pages communes) et la version de la grille enregistrée avec chaque note.
