# Modifier le thème sans risque : Shopify CLI et Theme Access

État au 27 novembre 2026 : **préparé, jamais exécuté.** Le script `scripts/theme.sh` existe ; il n'a pas pu être essayé faute de mot de passe Theme Access. Les options de Shopify CLI (version 5) qu'il utilise sont à vérifier au premier lancement.

## Pourquoi

L'application « SEO auto » n'a pas la permission `write_themes` (Shopify ne l'accorde que sur demande d'exemption). Or quatre des cinq corrections de titres principaux (H1) touchent le thème : voir `docs/analyse-titres-et-h1.md`. Theme Access donne un accès limité aux thèmes, sans passer par cette exemption.

## Règle

On ne modifie jamais le thème en ligne. On travaille sur une copie non publiée, on la regarde par son lien d'aperçu, et **la publication reste un geste du propriétaire dans l'administration Shopify**. Le script refuse d'écrire sur le thème en ligne et ne contient aucune commande de publication.

## Ce que le propriétaire doit faire (une fois)

1. Dans l'administration Shopify : Applications → rechercher **Theme Access** (application gratuite de Shopify) → Installer.
2. Ouvrir Theme Access → « Créer un mot de passe de thème » → saisir son nom et son adresse e-mail.
3. Le mot de passe arrive par e-mail (lien valable 7 jours, affichable une seule fois). Il commence par `shptka_`.
4. Le coller dans `.env`, à la ligne `SHOPIFY_CLI_THEME_TOKEN=`. Ne pas le coller dans une conversation.

## Déroulé prévu

```
scripts/theme.sh liste              # vérifier la connexion (lecture seule)
scripts/theme.sh copie              # créer « Copie SEO AAAA-MM-JJ », non publiée
scripts/theme.sh recuperer <id>     # télécharger la copie dans themes/<id>/
# … corrections dans themes/<id>/ (ex. sections/faq.liquid ligne 42 : h1 → h2) …
scripts/theme.sh envoyer <id>       # envoyer vers la copie uniquement
scripts/theme.sh apercu <id>        # lien d'aperçu à ouvrir pour comparer
```

- `themes/` est ignoré par git : un thème acheté ne se publie pas dans un dépôt.
- `envoyer` n'efface aucun fichier distant (`--nodelete`).
- `envoyer` n'accepte qu'une copie créée par ce script (nom « Copie SEO … ») : les autres thèmes non publiés de la boutique ne peuvent pas être écrasés.
- La version de Shopify CLI est épinglée (5.1.0) : aucune autre version n'est téléchargée avec le mot de passe dans l'environnement.
- La première exécution télécharge Shopify CLI par `npx` (aucune installation globale).
- La boutique compte déjà 8 thèmes dont 7 non publiés ; Shopify en autorise 20.

## Vérification après correction

Relancer une analyse du site sur l'aperçu n'est pas possible (l'aperçu demande une session). La vérification se fait donc en deux temps : contrôle visuel de l'aperçu par le propriétaire, puis, après publication par lui, nouvelle analyse dans Chat SEO : le problème « titre principal » doit passer de 89 pages à 19 (les articles, qui se corrigent dans leur texte).
