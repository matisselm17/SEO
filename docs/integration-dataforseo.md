# DataForSEO : préparation

État au 27 novembre 2026 : **variables prêtes, rien de codé.** `DATAFORSEO_LOGIN` et `DATAFORSEO_PASSWORD` sont lues par le serveur, qui indique seulement dans les Paramètres si elles sont renseignées. Aucun appel n'est fait à DataForSEO, donc aucun coût.

## Ce que le propriétaire doit faire

1. Créer un compte sur dataforseo.com et le créditer (paiement à l'usage, dépôt minimal demandé par DataForSEO).
2. Dans le tableau de bord : « API Access ». L'identifiant de l'API est l'adresse e-mail du compte ; le **mot de passe de l'API est généré sur cette page et n'est pas celui du site**.
3. Renseigner dans `.env` les lignes `DATAFORSEO_LOGIN=` et `DATAFORSEO_PASSWORD=`.

## À quoi cela servira, par ordre d'utilité

| Besoin du produit | Ce que DataForSEO apporte | Ce qui existe aujourd'hui |
|---|---|---|
| Savoir quoi écrire dans un titre ou une description | Volume de recherche et mots proches pour le sujet d'une page (Keywords Data, Labs) | Rien : l'IA rédige sans connaître la demande réelle |
| Section Concurrents | Résultats Google réels par requête et par pays (SERP) | Firecrawl (non configuré) |
| Mesurer l'effet d'une correction | Position d'une page sur une requête, avant et après | Search Console seulement, avec 2 à 3 jours de retard |

## Plan technique

- Authentification HTTP Basic, identifiants côté serveur uniquement, jamais dans une erreur ni un journal.
- Premier appel à écrire : `GET /v3/appendix/user_data` (gratuit) pour vérifier les identifiants et lire le solde.
- **Budget obligatoire avant tout appel payant** : chaque réponse de DataForSEO donne son coût ; le serveur le cumule par jour et refuse au-delà d'un plafond réglable, sur le modèle du budget de jetons de l'automatisation (`budget_exceeded`). Les tarifs sont à relever sur le site de DataForSEO au moment du développement : aucun chiffre n'est repris ici.
- Résultats mis en cache en base (une requête payée n'est pas repayée le même mois).
- Format d'échange à faire évoluer par l'agent principal avant de déléguer : volumes par requête dans `OrganicQuery`, source des concurrents, solde et consommation dans les Paramètres.

## Décision à prendre avant de coder

Quel premier usage financer : les volumes de recherche pour guider la rédaction (recommandé, coût faible et prévisible), ou le relevé des concurrents.
