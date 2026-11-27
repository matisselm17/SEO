#!/bin/sh
# Copie datée de .env dans secrets/sauvegardes-env/ (dossier ignoré par git, lisible par le seul propriétaire).
# À lancer avant de modifier .env. Garde les 20 copies les plus récentes. N'affiche aucune valeur.
set -eu
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "Pas de fichier .env à sauvegarder." >&2; exit 1; }
umask 077
mkdir -p secrets/sauvegardes-env
chmod 700 secrets secrets/sauvegardes-env
cible="secrets/sauvegardes-env/env-$(date +%Y-%m-%dT%H-%M-%S).bak"
cp -p .env "$cible"
chmod 600 .env "$cible"
ls -1t secrets/sauvegardes-env/*.bak 2>/dev/null | tail -n +21 | while read -r f; do rm -f "$f"; done
echo "Copie faite : $cible ($(grep -c '^[A-Z_0-9]*=' .env) variables, noms seulement comptés)."
