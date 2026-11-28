# Déployer Chat SEO

Préparé le 28 novembre 2026. **Rien de ce document n'a encore été exécuté** : l'image n'a jamais été construite (pas de Docker sur la machine de développement) et aucun serveur n'est en ligne. Le premier déploiement sert aussi à valider ces étapes.

## Ce qu'il faut

- Un hébergeur qui lance une image Docker, avec **un disque persistant** et HTTPS automatique (Render recommandé, voir `docs/plan-mise-en-production.md`).
- Une seule instance du serveur à la fois : la base SQLite ne se partage pas entre deux serveurs.
- 1 à 2 Go de mémoire.
- Un nom de domaine pointé sur le serveur.
- L'application publique créée dans le tableau de bord Shopify (identifiant et secret).

## Variables à régler chez l'hébergeur

Jamais dans le dépôt, jamais dans l'image. Les noms et leur rôle sont dans `.env.example`.

| Variable | Valeur |
|---|---|
| `SHOPIFY_APP_MODE` | `embedded` |
| `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET` | Ceux de l'application publique |
| `TOKEN_ENCRYPTION_KEY` | À générer une fois : `openssl rand -base64 32`. À conserver aussi hors de l'hébergeur : la perdre oblige chaque boutique à rouvrir l'application |
| `ALLOWED_HOSTS` | Le nom de domaine du serveur, par exemple `app.exemple.fr` |
| `HOST` | `0.0.0.0` (déjà réglé dans l'image) |
| `DATA_DIR` | `/data` (déjà réglé dans l'image) : le disque persistant doit être monté à cet endroit |
| `ANTHROPIC_API_KEY` | La clé de l'IA pour la production, pour les propositions de corrections |
| `SHOPIFY_WRITES_ENABLED` | `1` pour que les marchands puissent appliquer des corrections. Vide : tout le serveur est en lecture seule (arrêt d'urgence) |
| `SHOPIFY_AUTO_APPLY` | Laisser vide. Sans effet en mode intégré de toute façon |
| `EMBEDDED_FEATURES` | Laisser vide au lancement |

Ne pas régler en production : `SHOPIFY_STORE_DOMAIN`, `GOOGLE_APPLICATION_CREDENTIALS`, `GA4_PROPERTY_ID`, `ALLOW_PRIVATE_HOSTS`.

## Étapes

1. Créer le service chez l'hébergeur à partir du dépôt GitHub (branche à déployer), type « Docker », avec le `Dockerfile` de la racine.
2. Ajouter un disque persistant monté sur `/data` (1 Go suffit au départ).
3. Régler les variables ci-dessus.
4. Régler la vérification de santé sur `GET /healthz`.
5. Déployer, puis vérifier dans le journal : « Mode Shopify : intégré », et aucune ligne « ATTENTION ».
6. Associer le nom de domaine et vérifier que `https://<domaine>/healthz` répond `{"ok":true}`.
7. Dans `shopify.app.toml` : renseigner `client_id`, `application_url` et `redirect_urls` avec ce domaine, puis `shopify app deploy` (Shopify CLI, avec votre compte).
8. Installer l'application sur une boutique d'essai et dérouler le parcours complet (voir `docs/plan-mise-en-production.md`, point 6).

## Mises à jour

Un nouveau déploiement remplace l'image ; le disque `/data` reste. Au démarrage, le serveur applique seul les migrations de la base qui manquent, chacune une seule fois. Avec un disque persistant, l'hébergeur arrête l'ancienne instance avant de lancer la nouvelle : quelques secondes d'indisponibilité à chaque mise à jour.

Avant une mise à jour qui change la base : vérifier qu'une sauvegarde récente existe dans `/data/backups`.

## Sauvegardes

- Le serveur écrit une copie de la base chaque jour dans `/data/backups` et garde les 7 dernières. **Elles sont sur le même disque que la base** : elles protègent d'une erreur de manipulation ou d'une mise à jour ratée, pas de la perte du disque.
- Contre la perte du disque : activer les instantanés du disque chez l'hébergeur.
- Restaurer : arrêter le service, remplacer `/data/chat-seo.sqlite` par la copie voulue (supprimer aussi `chat-seo.sqlite-wal` et `chat-seo.sqlite-shm`), redémarrer.

## En cas de problème

| Symptôme | Cause probable |
|---|---|
| Le serveur ne démarre pas, message sur une variable | Variable obligatoire absente ou mal formée ; le message donne son nom |
| Toutes les requêtes répondent 403 | `ALLOWED_HOSTS` ne contient pas le domaine |
| L'application s'affiche vide dans Shopify | Politique de sécurité de la page à ajuster : point jamais vérifié en réel |
| « Accès refusé » dans l'application | Le secret de l'application ne correspond pas à l'identifiant, ou l'horloge du serveur est fausse |
| Les boutiques doivent toutes se reconnecter | `TOKEN_ENCRYPTION_KEY` a changé |

Arrêt d'urgence des écritures pour toutes les boutiques : vider `SHOPIFY_WRITES_ENABLED` et redémarrer.
