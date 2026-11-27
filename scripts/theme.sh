#!/bin/sh
# Travail sur une COPIE NON PUBLIÉE du thème, avec Shopify CLI et Theme Access.
# Ce script ne publie jamais un thème et refuse d'envoyer quoi que ce soit vers le thème en ligne.
#
#   scripts/theme.sh liste              liste les thèmes de la boutique (lecture)
#   scripts/theme.sh copie              duplique le thème en ligne en une copie non publiée
#   scripts/theme.sh recuperer <id>     télécharge la copie <id> dans themes/<id>/
#   scripts/theme.sh envoyer <id>       envoie themes/<id>/ vers la copie <id> (refusé hors « Copie SEO … »)
#   scripts/theme.sh apercu <id>        affiche le lien d'aperçu de la copie <id>
#
# Variables lues dans .env : SHOPIFY_STORE_DOMAIN, SHOPIFY_CLI_THEME_TOKEN (mot de passe Theme Access).
set -eu
cd "$(dirname "$0")/.."

lire() { grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'"; }
SHOPIFY_FLAG_STORE="$(lire SHOPIFY_STORE_DOMAIN)"
SHOPIFY_CLI_THEME_TOKEN="$(lire SHOPIFY_CLI_THEME_TOKEN)"
[ -n "$SHOPIFY_FLAG_STORE" ] || { echo "SHOPIFY_STORE_DOMAIN est vide dans .env." >&2; exit 1; }
[ -n "$SHOPIFY_CLI_THEME_TOKEN" ] || { echo "SHOPIFY_CLI_THEME_TOKEN est vide dans .env : générez un mot de passe dans l'application Theme Access (voir docs/theme-access.md)." >&2; exit 1; }
export SHOPIFY_FLAG_STORE SHOPIFY_CLI_THEME_TOKEN SHOPIFY_CLI_NO_ANALYTICS=1

# Version épinglée : aucune autre version n'est téléchargée ni exécutée avec le mot de passe dans l'environnement.
cli() { npx --yes @shopify/cli@5.1.0 "$@"; }

# Identifiant du thème en ligne, pour refuser d'y écrire.
# Lecture du JSON par node (pas par motif de texte) : un seul thème de rôle « live » est attendu, sinon rien.
champ_json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s);const l=(Array.isArray(a)?a:[]).filter(process.argv[1]==="live"?t=>t.role==="live":t=>String(t.id)===process.argv[2]);if(l.length===1)console.log(process.argv[1]==="live"?String(l[0].id):String(l[0].name??""))}catch{}})' "$@"; }
en_ligne() { cli theme list --role live --json | champ_json live; }
nom_de() { cli theme list --json | champ_json nom "$1"; }

exiger_copie() {
  case "${1:-}" in ''|*[!0-9]*) echo "Indiquez l'identifiant numérique de la copie (voir : scripts/theme.sh liste)." >&2; exit 1;; esac
  LIVE="$(en_ligne)"
  [ -n "$LIVE" ] || { echo "Impossible de déterminer le thème en ligne : par prudence, rien n'est fait." >&2; exit 1; }
  [ "$1" != "$LIVE" ] || { echo "Refusé : $1 est le thème EN LIGNE. Ce script ne travaille que sur une copie non publiée." >&2; exit 1; }
}

# L'envoi n'est permis que vers une copie créée par ce script (« Copie SEO … ») : les autres thèmes non publiés
# de la boutique (anciennes versions, préproduction) ne sont jamais écrasés.
exiger_copie_seo() {
  exiger_copie "$1"
  NOM="$(nom_de "$1")"
  case "$NOM" in "Copie SEO "*) ;; *) echo "Refusé : le thème $1 (« $NOM ») n'est pas une copie créée par ce script (« Copie SEO … »)." >&2; exit 1;; esac
}

case "${1:-}" in
  liste)     cli theme list ;;
  copie)     LIVE="$(en_ligne)"; [ -n "$LIVE" ] || { echo "Impossible de déterminer le thème en ligne : rien n'est fait." >&2; exit 1; }
             cli theme duplicate --theme "$LIVE" --name "Copie SEO $(date +%Y-%m-%d)" ;;
  recuperer) exiger_copie "${2:-}"; mkdir -p "themes/$2"; cli theme pull --theme "$2" --path "themes/$2" ;;
  envoyer)   exiger_copie_seo "${2:-}"; [ -d "themes/$2" ] || { echo "themes/$2 n'existe pas : lancez d'abord « recuperer $2 »." >&2; exit 1; }
             cli theme push --theme "$2" --path "themes/$2" --nodelete ;;
  apercu)    exiger_copie "${2:-}"; cli theme info --theme "$2" ;;
  *)         sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
