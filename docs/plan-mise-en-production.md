# Plan de mise en production de la V1

Rédigé le 28 novembre 2026. Objectif : une première version stable, déployée, installable par des marchands Shopify depuis Shopify, sans aucun réglage technique de leur part. Le logiciel s'améliore ensuite.

Sources vérifiées le 28 novembre 2026 : exigences du Shopify App Store, documentation Shopify sur les jetons d'accès, partage de revenus Shopify, comparatifs de tarifs d'hébergement datés de septembre et octobre 2026. Les tarifs et les exigences changent : à revérifier le jour du choix.

## Le constat en trois phrases

Le cœur du produit (audit, note, corrections validées par un humain, lots, vérification, historique, restauration) existe et a été essayé en réel sur une boutique. Mais le logiciel est aujourd'hui un outil pour **une seule boutique, sur un seul ordinateur, sans connexion** : la boutique est désignée dans `.env`, le serveur n'écoute que la machine locale, et personne ne s'identifie. Le travail restant n'est donc presque pas du SEO : c'est l'installation depuis Shopify, l'identification de chaque marchand, la séparation des données et l'hébergement.

## 1. Fonctionnalités assez abouties pour la V1

| Fonctionnalité | État | Ce qui manque pour la V1 |
|---|---|---|
| Audit SEO, note sur 100, problèmes avec preuves | Essayé en réel (98 pages notées) | Comportement propre quand la vitrine est protégée par mot de passe (voir blocage 7) |
| Analyse individuelle des pages | Fait | Rien |
| Corrections dans Shopify, validation humaine | Huit tests réels conformes | Rien de fonctionnel ; passer sur le nouveau mode de connexion |
| Corrections groupées (lots de 50) | Essayé en réel | Rien |
| Rapport avant modification | L'aperçu du lot (avant → après, ligne par ligne) en tient lieu | Rien d'indispensable |
| Vérification des modifications | Faite le 27 novembre, 11 corrections sur 12 vérifiées en réel | Jamais vu en réel : un cas « échouée », la relecture automatique après écriture |
| Historique et restauration | Essayé en réel | Rien |
| Propositions de corrections par l'IA | Codé, **jamais essayé avec la vraie API** | Un essai réel, et un plafond de consommation par boutique |
| Rapport final après optimisation | Le résultat du lot existe, pas de rapport d'ensemble | Un écran de synthèse simple (petit) |
| Suivi de l'évolution SEO | Les audits successifs sont gardés en base ; rien n'est affiché | Note initiale, note actuelle, courbe, problèmes corrigés et restants (moyen) |

## 2. Les véritables blocages

Classés par ordre de dépendance. Tant que les quatre premiers ne sont pas levés, aucune deuxième boutique ne peut utiliser le logiciel.

1. **Connexion Shopify d'une application publique.** Aujourd'hui : « Client Credentials », qui ne fonctionne que pour les boutiques de votre propre organisation. Il faut le parcours des applications publiques : installation gérée par Shopify, échange du jeton de session contre un jeton d'accès, jeton hors ligne **à expiration** (1 heure) avec jeton de renouvellement (90 jours). Shopify l'impose aux nouvelles applications publiques (exigence 3.1.2).
2. **Application intégrée à l'administration Shopify.** Shopify exige une application affichée dans son administration, avec la dernière version d'App Bridge et l'identification par jeton de session, sans cookie tiers (exigences 1.1.1, 2.2.2, 2.2.3). Aujourd'hui le serveur interdit explicitement tout affichage dans un cadre.
3. **Identification et séparation des boutiques.** Aucune requête n'est rattachée à un marchand. Il faut : une table des boutiques installées, chaque requête identifiée par le jeton de session vérifié côté serveur, chaque donnée rattachée à une boutique, et des tests qui prouvent qu'une boutique ne peut ni lire ni modifier les données d'une autre.
4. **Stockage des jetons.** Les jetons de chaque boutique doivent être en base, chiffrés, avec une clé gardée chez l'hébergeur. Rien de tel n'existe (le jeton actuel vit en mémoire).
5. **Désinstallation et vie privée.** Shopify exige trois appels obligatoires (demande de données client, effacement client, effacement de la boutique) plus la désinstallation, tous vérifiés par signature. L'effacement de la boutique doit supprimer ses données ; or l'historique est aujourd'hui protégé contre toute suppression : il faut un chemin d'effacement unique, réservé à ce cas.
6. **Hébergement.** Serveur en HTTPS, disque persistant, sauvegardes automatiques, secrets chez l'hébergeur, journal d'erreurs. Rien n'est déployé.
7. **Boutiques dont la vitrine n'est pas publique.** L'audit charge les pages publiques. Une boutique d'essai Shopify est protégée par mot de passe par défaut, et c'est sur une boutique de ce type que Shopify examine l'application. L'application doit rester utile dans ce cas : s'appuyer sur les données lues par l'API (titres, descriptions, textes des images, déjà en base) et l'expliquer clairement.
8. **Limites par boutique.** Les limites de débit, la file des analyses et la file des vérifications sont communes à tout le serveur. Une boutique ne doit pas pouvoir bloquer les autres, ni consommer sans plafond l'API de l'IA que vous payez.
9. **Verrous d'écriture.** `SHOPIFY_WRITES_ENABLED` est un interrupteur pour tout le serveur. Il reste comme arrêt d'urgence ; la validation humaine de chaque modification reste obligatoire ; le mode automatique reste verrouillé et son écran masqué.

Ce qui n'est **pas** un blocage : la qualité de l'audit, l'interface, la base SQLite (voir point 5), la facturation si la V1 est gratuite au lancement.

## 3. À masquer ou à reporter

Le code reste en place. Un réglage côté serveur masque la section et ferme ses routes.

| Élément | Raison | Décision proposée |
|---|---|---|
| Concurrents (Firecrawl) | Jamais essayé en réel, coût par relevé | Masqué |
| Mots-clés avancés (DataForSEO) | Non branché | Masqué |
| Visites (Google Analytics) | Demande un compte Google Cloud au client | Masqué |
| Mots-clés et trafic (Search Console directe) | Idem ; à refaire plus tard avec une connexion Google en un clic | Masqué ; le dépôt manuel de l'export peut rester |
| Vitesse des pages (PageSpeed) | Jamais essayé en réel | Masqué |
| Automatisation | Doit rester désactivée | Écran masqué, routes fermées |
| Modification des thèmes | Demande une permission soumise à dérogation chez Shopify | Reporté, scripts non livrés |
| Assistant IA (conversation) | Jamais essayé en réel, coût non plafonné | À décider : masqué au lancement (recommandé) |
| Écran « Ajouter un site » | Remplacé par la boutique installée | Retiré du parcours |
| Traductions | Vérification non prise en charge | Gardées, statut « appliquée » |

## 4. Modifications techniques nécessaires

Toutes au niveau critique (connexion, secrets, base, format d'échange).

**Lot A. Connexion et identification**
- Fichier `shopify.app.toml` : permissions, adresses, appels obligatoires, installation gérée par Shopify.
- `server/src/shopify/auth.ts` : vérification du jeton de session, échange contre un jeton hors ligne à expiration, renouvellement une boutique à la fois, arrêt propre quand Shopify répond que le jeton n'est plus valable. L'ancien mode reste disponible pour le développement local.
- `server/src/http.ts` : affichage autorisé uniquement dans l'administration de la boutique concernée ; l'identification par jeton remplace la garde d'origine actuelle.
- Interface : chargement d'App Bridge, jeton joint à chaque appel, flux en direct lus avec une requête authentifiée.

**Lot B. Plusieurs boutiques**
- Table `shops` (domaine, jetons chiffrés, permissions, dates d'installation et de désinstallation), `sites` rattaché à une boutique, création automatique du site à l'installation à partir du domaine principal lu chez Shopify.
- `ShopifyService`, lots et vérification : une connexion par boutique au lieu d'une connexion globale.
- Toutes les lectures et écritures filtrées par boutique ; tests d'isolation croisés sur chaque route.
- Chiffrement des jetons (AES-256-GCM, clé en variable d'environnement chez l'hébergeur).
- Migrations numérotées et rejouables, pour que les mises à jour ne perdent rien.

**Lot C. Cycle de vie**
- Routes des appels Shopify (désinstallation, trois appels de vie privée), signature vérifiée, traitement sans doublon.
- Effacement des données d'une boutique sur demande de Shopify.
- Réinstallation : la boutique retrouve un état propre.

**Lot D. Exploitation**
- Limites et files par boutique ; plafond quotidien de propositions de l'IA par boutique.
- Reprise après redémarrage (la file des vérifications est aujourd'hui en mémoire).
- Image de déploiement, vérification de santé, sauvegarde quotidienne de la base, journal d'erreurs sans secret.
- Masquage des sections du point 3.

**Lot E. Finition V1**
- Audit utilisable quand la vitrine est protégée.
- Suivi de l'évolution et rapport final (simples).
- Pages publiques obligatoires : politique de confidentialité, contact d'assistance.

**Base de données.** Recommandation : garder SQLite pour la V1, sur un disque persistant avec sauvegarde quotidienne. C'est suffisant pour quelques dizaines de boutiques et évite une réécriture. Limite assumée : un seul serveur à la fois. Le passage à PostgreSQL se fera quand le nombre de boutiques le demandera ; les migrations numérotées le préparent.

**Facturation.** Si l'application est payante, Shopify impose sa propre facturation (exigence 1.2.1). Le plus simple est la tarification gérée par Shopify : les formules se règlent dans le tableau de bord, le code se limite à lire la formule active. Lancer gratuitement évite ce travail pour la V1.

## 5. Hébergement et coûts

Besoin : un serveur Node toujours allumé, 1 à 2 Go de mémoire (l'analyse de 100 pages en consomme), un disque persistant, HTTPS automatique.

| Solution | Coût mensuel estimé | Pour | Contre |
|---|---|---|---|
| **Render** (recommandé) | Environ 25 $ (1 processeur, 2 Go) + 0,25 $ par Go de disque | Prix fixe, déploiement depuis GitHub, HTTPS automatique, peu de réglages | Plus cher ; la formule à 7 $ (512 Mo) est trop juste |
| Fly.io | Environ 7 à 13 $ (1 à 2 Go) + 0,15 $ par Go de disque | Le moins cher, région Paris | Plus de configuration, facture à l'usage |
| Railway | Environ 10 à 15 $ | Simple | Facture à l'usage, moins prévisible |
| Serveur privé virtuel | Quelques euros (non vérifié) | Le moins cher | Tout à administrer soi-même : déconseillé |

Autres coûts : inscription au Shopify App Store 19 $ une seule fois ; Shopify ne prélève rien sur le premier million de dollars de revenus, puis 15 % ; nom de domaine, une dizaine d'euros par an ; API de l'IA à la consommation, à mesurer lors de l'essai réel avant de fixer un prix de vente.

## 6. Installer l'application sur une deuxième boutique

Tant que l'application n'est pas approuvée, une application publique ne s'installe que sur des **boutiques d'essai** de votre compte partenaire. Une vraie deuxième boutique cliente passe donc par l'approbation.

1. Créer l'application publique dans votre tableau de bord Shopify (nouvelle application, distincte de l'actuelle).
2. Déployer le serveur et déclarer son adresse dans l'application.
3. Créer une boutique d'essai gratuite, y mettre quelques produits.
4. Installer l'application sur cette boutique par le lien d'installation de Shopify.
5. Dérouler le parcours complet : installation, audit, correction, lot, vérification, restauration, désinstallation, réinstallation.
6. Vérifier qu'aucune donnée d'Orlux n'est visible depuis la boutique d'essai, et l'inverse.
7. Installer la même application sur Orlux, qui devient la première boutique réelle.

## 7. Soumettre au Shopify App Store

1. Payer l'inscription (19 $) et compléter le profil partenaire.
2. Passer les contrôles automatiques de Shopify (connexion, appels obligatoires, certificat HTTPS).
3. Préparer la fiche : nom unique, icône, captures d'écran sans prix ni témoignage, description sans chiffre ni promesse non prouvée, langues réellement prises en charge, prix exacts.
4. Publier une politique de confidentialité et une adresse d'assistance ; fournir un contact d'urgence.
5. Enregistrer une vidéo de démonstration du parcours complet et rédiger les instructions de test.
6. Soumettre, puis répondre aux demandes de l'examinateur. Le délai n'est pas garanti par Shopify : prévoir plusieurs semaines avec les allers-retours.

Points d'attention propres à ce produit : l'application modifie les données de la boutique, donc la validation humaine et la restauration doivent être visibles dans la vidéo ; aucune promesse de classement dans la fiche ; l'application n'accède à aucune donnée de client final, ce qui simplifie la partie vie privée.

## 8. Estimation du travail restant

En journées de développement au niveau critique (développement, tests, revue), hors attente de vos actions et de Shopify.

| Lot | Estimation |
|---|---|
| A. Connexion et identification | 2 à 3 jours |
| B. Plusieurs boutiques | 3 à 4 jours |
| C. Cycle de vie | 1 à 2 jours |
| D. Exploitation et déploiement | 2 jours |
| E. Finition V1 | 2 à 3 jours |
| Essais sur boutique d'essai, corrections | 2 jours |
| **Total** | **12 à 16 jours** |

Puis l'examen de Shopify. C'est une estimation : le lot B est le plus incertain, car il touche presque toutes les routes.

Ordre : A et B d'abord (rien d'autre ne se teste sans eux), puis D pour déployer tôt sur une boutique d'essai, puis C et E, puis la soumission.

## 9. Ce qui demande votre intervention

1. Créer ou confirmer votre compte Shopify Partner et y créer l'application publique.
2. Choisir l'hébergeur, y créer un compte avec votre moyen de paiement.
3. Choisir le nom de l'application et acheter un nom de domaine.
4. Décider : gratuit au lancement ou payant, et à quel prix.
5. Décider : assistant IA masqué ou présent dans la V1.
6. Fournir la clé de l'API de l'IA pour la production et fixer un budget mensuel.
7. Créer une boutique d'essai.
8. Fournir ou valider la politique de confidentialité et l'adresse d'assistance.
9. Enregistrer la vidéo de démonstration (ou valider un scénario que je prépare).
10. Payer les 19 $ et cliquer sur « Soumettre ».
11. Autoriser l'installation de la nouvelle application sur Orlux.

Aucune de ces étapes ne peut être faite par un agent : elles engagent vos comptes, votre argent ou votre signature.

## Avancement

**Lot A, fait le 28 novembre 2026 (non commité, jamais essayé dans une vraie administration Shopify).**

- Deux modes de serveur, choisis par `SHOPIFY_APP_MODE` : `local` (inchangé, par défaut) et `embedded`.
- Mode intégré : jeton de session Shopify exigé et vérifié sur toutes les routes `/api` ; échange contre un jeton hors ligne à expiration ; renouvellement ; répit de 30 secondes après un échange échoué ; affichage autorisé seulement dans l'administration de la boutique servie ; App Bridge ajouté à la page par le serveur.
- Interface : jeton neuf sur chaque appel quand App Bridge est présent, une relance sur refus, écran « accès refusé ».
- `shopify.app.toml` préparé à la racine, à compléter (identifiant de l'application, adresse du serveur) et jamais validé par Shopify CLI.
- Limite voulue de ce lot : une seule boutique servie (celle de `SHOPIFY_STORE_DOMAIN`) et jetons gardés en mémoire. Le lot B lève les deux.
- 257 tests, types et compilation verts ; une revue QA et sécurité sans bloquant, corrections faites.

Points mineurs laissés ouverts par la seconde revue : pas de répit pour le renouvellement quand Shopify ne répond plus (lenteur, pas de boucle) ; tout refus 400 de l'échange est lu comme un jeton de session périmé, même si la cause est un identifiant mal réglé ; pendant le répit de 30 secondes, le message invite à rouvrir l'application alors que Shopify est seulement indisponible ; pas de test côté interface (aucun outillage de test web).

À vérifier au premier essai réel (boutique d'essai et serveur en HTTPS nécessaires) : le comportement d'App Bridge (il ajoute peut-être lui-même le jeton et rejoue les refus, ce qui doublerait la relance de l'interface), les besoins éventuels de la politique de sécurité de la page (`connect-src`, `style-src`), les codes réels de Shopify à l'échange et au renouvellement, le rendu de l'application dans le cadre.

**Lot B, fait le 28 novembre 2026 (non commité, jamais essayé dans une vraie administration Shopify).**

- Le mode intégré sert toute boutique qui a installé l'application. `SHOPIFY_STORE_DOMAIN` n'y sert plus ; une nouvelle variable `TOKEN_ENCRYPTION_KEY` y est obligatoire.
- Table `shops` ; jetons de chaque boutique chiffrés en base (AES-256-GCM), relus après un redémarrage.
- Une boutique = un site, créé à la première ouverture avec sa première analyse. Une boutique sans domaine public (boutique d'essai) obtient un site sur son domaine Shopify.
- Séparation : toute route d'un site répond « introuvable » à une autre boutique ; un test parcourt toutes les routes d'un site déclarées par l'application (liste construite automatiquement, plus de 45) et vérifie que rien n'est lu ni écrit ; les services Shopify, files et verrous sont séparés par boutique.
- Migrations numérotées de la base, testées sur une base à l'ancien schéma.
- Interface : en mode intégré, ouverture directe du site de la boutique, sans ajout, suppression ni choix de site.
- 280 tests, types et compilation verts ; revue QA et sécurité sans bloquant.

Laissé ouvert par la revue du lot B :
- Limites par minute communes à toutes les boutiques : une boutique peut retarder les autres (lecture de la boutique limitée à une par minute pour tout le serveur). **À traiter au lot D, avant d'ouvrir à plusieurs marchands.**
- Si une boutique change de domaine principal, elle garde l'accès à ses corrections, mais l'adresse analysée reste l'ancienne (lot E).
- L'historique est rangé par adresse du site, pas par boutique : à revoir avec l'effacement des données (lot C).
- Mémoire : un jeu de services par boutique vue, sans libération (lot D).
- Mineurs : une page inconnue ne répond pas « introuvable » sur la mesure de vitesse ; pas de contrôle d'adresse publique à la création du site (le parcours des pages a sa propre garde, non revérifiée ici).

**Lot C, fait le 28 novembre 2026 (non commité, jamais reçu un vrai appel de Shopify).**

- Une route signée, `POST /webhooks/shopify`, reçoit la désinstallation et les trois appels de vie privée. Sans signature valide, rien ne se passe.
- Un avis de désinstallation n'est jamais cru sur parole : le serveur demande à Shopify si les jetons de la boutique sont encore acceptés. Acceptés, l'avis est ignoré. Refusés, la boutique est marquée désinstallée, ses jetons effacés, ses travaux arrêtés ; ses données sont gardées.
- Effacement (`shop/redact`, 48 heures après la désinstallation) : immédiat quand Shopify refuse définitivement les jetons de la boutique ; sinon au bout de 25 jours, à condition que le marchand n'ait pas rouvert l'application depuis la demande. Une seule transaction ; rien d'une autre boutique. L'historique reste protégé contre toute suppression ordinaire.
- Réinstallation : la boutique retrouve ses données si elles n'ont pas encore été effacées, sinon elle repart d'un état neuf.
- Quatre revues QA. Les trois premières ont trouvé des chemins d'effacement à tort (corps rejoué sous un autre sujet, avis tardif ou rejoué) ou d'effacement jamais fait ; les règles ont été simplifiées et chaque cas a son test.
- Cas résiduel assumé : une boutique installée que son marchand n'ouvre pas pendant 25 jours, dont les jetons sont devenus inutilisables, et pour laquelle une demande d'effacement signée arrive, est effacée ; elle repart d'un site neuf à sa prochaine ouverture.

**Lot D, fait le 28 novembre 2026 (non commité, jamais déployé).**

- Sections masquées en mode intégré : concurrents, Google Analytics, vitesse des pages, assistant, lecture directe de la Search Console. Leurs routes sont fermées. `EMBEDDED_FEATURES` peut rouvrir l'assistant, les concurrents ou la vitesse.
- Mode automatique impossible en mode intégré, quelle que soit la configuration du serveur.
- Limites par boutique ; plafond commun pour l'IA ; plafond quotidien de jetons d'IA par boutique, assistant compris ; 6 analyses par heure et par boutique.
- Reprise des vérifications après un redémarrage ; libération de la mémoire des boutiques inactives.
- `GET /healthz`, sauvegarde quotidienne de la base (7 copies), `Dockerfile` et `docs/deploiement.md`. **L'image n'a jamais été construite** (pas de Docker sur la machine de développement).

**Lot E, fait le 28 novembre 2026 (non commité).**

- Évolution : note initiale et actuelle, courbe, comparaison à périmètre égal (pages communes aux deux analyses), bilan des corrections. Dans la Vue d'ensemble, et dans un « Rapport d'optimisation » imprimable.
- Boutique protégée par un mot de passe : l'analyse le dit clairement, et la section Boutique Shopify reste utilisable (première lecture de la boutique lancée à l'installation).
- Modèles à valider, non publiés : `docs/modeles/politique-de-confidentialite.md`, `docs/modeles/assistance.md`.
- Non fait : la mise à jour de l'adresse du site quand une boutique change de domaine principal.

État d'ensemble après les lots A à E : 373 tests, types et compilation verts. Tout est testé avec un faux Shopify ; **rien n'a tourné dans une vraie administration Shopify ni sur un serveur en ligne**.

Restes connus, à traiter avant d'ouvrir à des marchands :
- Premier déploiement et premier essai sur une boutique d'essai : c'est lui qui validera App Bridge, la politique de sécurité de la page, les codes de réponse réels de Shopify (en particulier le refus `401 invalid_request` qui sert de preuve de désinstallation), l'image Docker.
- Deux analyses simultanées au plus pour tout le serveur : plusieurs boutiques attendent leur tour.
- Les propositions de l'IA n'ont jamais été essayées avec la vraie API.
- Aucun test automatique côté interface.
- Changer `TOKEN_ENCRYPTION_KEY` déconnecte toutes les boutiques : ne jamais la changer sans plan.

## Ce qui ne change pas

- Validation humaine avant toute écriture dans une boutique.
- Mode automatique désactivé.
- Aucune clé dans le code, le navigateur ou les journaux.
- Aucune écriture réelle sans votre accord pendant ce chantier ; les essais se font sur une boutique d'essai.
