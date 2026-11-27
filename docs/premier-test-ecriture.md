# Premier test réel d'écriture : une seule description pour Google

État au 27 novembre 2026, 17 h 04 : **exécuté avec succès**, avec l'autorisation du propriétaire. Ce sont les deux seules écritures jamais envoyées à la boutique.

| Vérification | Résultat |
|---|---|
| Écriture conditionnelle sur un champ existant de type `string` | acceptée par Shopify, type conservé |
| Valeur relue identique à la valeur envoyée | oui |
| Reste du produit (titre, texte, images, textes alternatifs, prix, titre pour Google) | identique, même empreinte avant et après |
| Annulation depuis l'historique | la valeur est revenue à `llo` |
| État final comparé à l'état d'avant le test | strictement identique |
| Historique | deux lignes : la modification (marquée annulée) et l'annulation |
| Écritures automatiques | aucune, `SHOPIFY_AUTO_APPLY` vide |

Fait par l'interface (fiche du produit, confirmation avant/après, puis Historique → Annuler). La description fautive `llo` est donc toujours en place : la bonne description reste à réappliquer, sur décision du propriétaire.

Toujours non vérifié en réel : la création d'un champ qui n'existe pas encore, le vidage d'un champ, le titre pour Google, le texte alternatif d'une image, les traductions, les pages et articles, les lots et le mode automatique.

## Élément choisi

| | |
|---|---|
| Produit | Piercing Barrette Or 18K • Hélix |
| Adresse | `/products/piercing-barrette-or-18k-helix-lobe` |
| Champ | Description pour Google (meta description) |
| Valeur actuelle | `llo` (3 caractères, datée du 27 juin 2025 : une erreur de saisie) |
| Valeur proposée | `Piercing barrette en argent 925 plaqué or 18 carats, pour hélix ou lobe. Hypoallergénique, sans nickel, résistant à l'eau. Tige droite à vis de 10 mm.` (150 caractères) |

Pourquoi lui : la valeur actuelle est manifestement fautive, donc le test ne peut que l'améliorer ; et le champ existe déjà sous l'ancien type `string`, le cas le plus incertain du chemin d'écriture. La valeur proposée ne reprend que des faits du texte du produit ; le propriétaire peut la réécrire avant d'appliquer.

## Ce que le test doit confirmer

1. Shopify accepte l'écriture conditionnelle sur un champ existant de type `string`.
2. Seule la description change : titre, texte, images et prix du produit sont identiques avant et après.
3. La valeur relue est exactement la valeur envoyée, et la page publique l'affiche.
4. L'annulation remet exactement `llo`.
5. L'historique contient les deux lignes (modification, annulation).

## Déroulé

**Avant (lecture seule, peut être fait sans autorisation).**

1. Sauvegarde complète : `npm --prefix server run shopify:sauvegarde` écrit `data/sauvegardes/shopify-<date>.json` (tous les titres, descriptions, textes alternatifs et traductions de la boutique).
2. Noter pour ce produit : titre, description, nombre d'images, date de modification.

**Écriture (demande l'autorisation du propriétaire).**

3. Le propriétaire met `SHOPIFY_WRITES_ENABLED=1` dans `.env` ; le serveur est redémarré. `SHOPIFY_AUTO_APPLY` reste vide.
4. Dans Chat SEO : Boutique Shopify → rechercher « Barrette » → ouvrir le produit → saisir la description → « Vérifier et appliquer » → contrôler l'avant et l'après → confirmer.
5. Vérifications : la fiche relue affiche la nouvelle valeur ; l'historique a une ligne ; dans l'administration Shopify, « Référencement » du produit montre la même description ; relecture par l'API du titre, du texte et des images, comparés à la sauvegarde.

**Restauration.**

6. Historique → « Annuler » sur la ligne → confirmer. Vérifier que la valeur est de nouveau `llo`, dans Chat SEO et dans Shopify.
7. Si tout est conforme : réappliquer la bonne description (la laisser à `llo` n'a pas d'intérêt), puis décider de laisser les écritures activées ou de vider `SHOPIFY_WRITES_ENABLED`.

## Si quelque chose ne se passe pas comme prévu

- **Shopify refuse l'écriture** : rien n'est modifié, le message de Shopify s'affiche, l'historique reste vide. On s'arrête et on corrige le code avant tout autre essai.
- **Écriture acceptée mais relecture impossible** : l'historique l'indique (« valeur non relue ») et l'annulation reste possible.
- **L'annulation échoue** : la valeur d'origine est dans la sauvegarde et dans l'historique ; elle se ressaisit à la main dans Shopify (Produits → le produit → Référencement).

## Ce que ce test ne couvre pas

Le titre pour Google, le texte alternatif d'une image, les traductions, les pages et les articles, la création d'un champ qui n'existe pas encore, les lots et le mode automatique. Chacun demandera son propre premier essai, sur un seul élément.
