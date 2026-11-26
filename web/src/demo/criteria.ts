/**
 * MODE DÉMONSTRATION (développement uniquement).
 * La grille de reference/sonde-seo.html (5 familles, 30 + 20 + 25 + 15 + 10 points),
 * avec les textes nécessaires pour fabriquer des problèmes, des points positifs et des recommandations.
 */
import type { CategoryId, Effort, Fix } from "../lib/types";

export interface PageFacts {
  url: string;
  path: string;
  title: string | null;
  description: string | null;
  h1: string[];
  words: number;
  images: number;
  imagesNoAlt: number;
}

export interface Crit {
  id: string;
  category: CategoryId;
  label: string;
  max: number;
  expected: string;
  /** Points partiels quand le critère est « à revoir ». */
  partial: number;
  found: (f: PageFacts, status: "pass" | "warn" | "fail") => string | null;
  message: (f: PageFacts, status: "pass" | "warn" | "fail") => string;
  issueTitle: (n: number) => string;
  summary: string;
  why: string;
  fix: (host: string) => Fix;
  recTitle: (n: number) => string;
  effort: Effort;
  recSteps: string[];
  strength: { title: string; detail: (n: number) => string };
}

const s = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

export const CRITERIA: Crit[] = [
  // ───────── Balises (30)
  {
    id: "title", category: "balises", label: "Titre de la page", max: 8, partial: 4, expected: "Entre 30 et 60 caractères",
    found: (f, st) => (st === "fail" ? "Aucun titre" : `« ${f.title} » (${f.title?.length ?? 0} caractères)`),
    message: (f, st) => st === "pass" ? "Le titre est dans la bonne longueur." : st === "fail" ? "Sans titre, Google en invente un à partir de la page." : (f.title?.length ?? 0) > 60 ? "Le titre est trop long : Google le coupe vers 60 caractères." : "Le titre est trop court pour dire ce que propose la page.",
    issueTitle: (n) => `${s(n, "page a", "pages ont")} un titre trop court ou trop long`,
    summary: "Le titre est la ligne cliquable affichée dans Google. Trop court, il ne dit pas ce que propose la page ; trop long, il est coupé.",
    why: "C'est l'élément qui compte le plus pour Google et pour l'internaute qui choisit sur quel résultat cliquer. Un bon titre annonce l'offre et, si c'est utile, le lieu.",
    fix: () => ({ steps: ["Ouvrez la page dans votre outil de gestion du site.", "Dans le réglage « Référencement » ou « SEO », modifiez le titre.", "Visez 30 à 60 caractères : l'offre d'abord, puis la marque."], snippet: { language: "html", code: "<title>Bols en grès faits main à Nantes | Atelier Lune</title>" } }),
    recTitle: (n) => `Réécrire le titre de ${s(n, "page", "pages")}`, effort: "medium",
    recSteps: ["Commencez par les pages qui reçoivent le plus de visites.", "Mettez l'offre au début du titre et la marque à la fin.", "Restez entre 30 et 60 caractères."],
    strength: { title: "Les titres ont la bonne longueur", detail: (n) => `${n} pages ont un titre entre 30 et 60 caractères.` },
  },
  {
    id: "meta_description", category: "balises", label: "Description", max: 7, partial: 4, expected: "Entre 70 et 160 caractères",
    found: (f, st) => (st === "fail" ? "Aucune description" : `Description de ${f.description?.length ?? 0} caractères`),
    message: (_f, st) => st === "pass" ? "La description est dans la bonne longueur." : st === "fail" ? "Google choisira lui-même un extrait de la page." : "La description sera coupée dans Google.",
    issueTitle: (n) => `${s(n, "page n'a", "pages n'ont")} pas de bonne description`,
    summary: "La description est le texte affiché sous le titre dans Google. Sans elle, Google choisit lui-même un extrait, rarement le plus vendeur.",
    why: "Une bonne description ne fait pas monter la page dans le classement, mais elle décide si l'internaute clique sur votre résultat plutôt que sur celui du dessus. C'est votre annonce gratuite dans Google.",
    fix: () => ({ steps: ["Ouvrez la page dans votre outil de gestion du site.", "Trouvez le réglage « Référencement » ou « SEO ».", "Écrivez une description de 120 à 155 caractères, propre à cette page."], snippet: { language: "html", code: "<meta name=\"description\" content=\"Vaisselle en grès tournée à la main à Nantes : bols, assiettes et tasses. Livraison offerte dès 60 €.\">" } }),
    recTitle: (n) => `Rédiger une description pour ${s(n, "page", "pages")}`, effort: "heavy",
    recSteps: ["Commencez par les pages qui reçoivent le plus de visites.", "Écrivez 120 à 155 caractères : ce que propose la page, un argument, une invitation à cliquer.", "Collez le texte dans le champ « Description » du réglage de référencement de la page."],
    strength: { title: "Chaque page a sa description", detail: (n) => `${n} pages ont une description de bonne longueur.` },
  },
  {
    id: "h1", category: "balises", label: "Titre principal (H1)", max: 6, partial: 3, expected: "Un seul titre principal",
    found: (f, st) => (st === "fail" ? "Aucun titre principal" : st === "warn" ? `${Math.max(2, f.h1.length)} titres principaux` : `« ${f.h1[0] ?? ""} »`),
    message: (_f, st) => st === "pass" ? "Un seul titre principal, qui annonce le sujet." : st === "fail" ? "La page n'a pas de titre principal." : "Plusieurs titres principaux brouillent le sujet de la page.",
    issueTitle: (n) => `Le titre principal est absent ou en double sur ${s(n, "page", "pages")}`,
    summary: "Chaque page doit avoir un seul titre principal (H1) qui annonce son sujet. Plusieurs H1, ou aucun, brouillent ce signal.",
    why: "Google lit le titre principal pour comprendre le sujet de la page. Les lecteurs d'écran s'en servent aussi pour annoncer la page aux personnes malvoyantes.",
    fix: () => ({ steps: ["Repérez le bloc qui ajoute un second H1 (souvent un bloc du thème : bannière, FAQ, pied de page).", "Dans les réglages de ce bloc, passez son titre de « Titre 1 » à « Titre 2 ».", "Vérifiez qu'il reste un seul H1 par page, qui reprend le sujet du titre."], snippet: { language: "html", code: "<h1>Bols en grès faits main</h1>\n<!-- Les autres titres de la page en H2 -->\n<h2>Questions fréquentes</h2>" } }),
    recTitle: () => "Garder un seul titre principal par page", effort: "quick",
    recSteps: ["Le second H1 vient le plus souvent d'un bloc du thème.", "Dans le thème, passez ce titre de H1 à H2 : la correction s'applique d'un coup à toutes les pages."],
    strength: { title: "Un seul titre principal par page", detail: (n) => `${n} pages ont exactement un H1.` },
  },
  {
    id: "headings", category: "balises", label: "Ordre des intertitres", max: 4, partial: 2, expected: "Des intertitres H2, emboîtés dans l'ordre",
    found: (_f, st) => (st === "fail" ? "Aucun intertitre" : st === "warn" ? "Un niveau sauté (H2 puis H4)" : "Intertitres dans l'ordre"),
    message: (_f, st) => st === "pass" ? "Les intertitres s'emboîtent dans l'ordre." : st === "fail" ? "Le texte n'est pas découpé par des intertitres." : "Des niveaux d'intertitres sont sautés.",
    issueTitle: (n) => `Les intertitres sont mal ordonnés sur ${s(n, "page", "pages")}`,
    summary: "Les intertitres (H2, H3…) découpent la page en parties. Ils doivent s'emboîter dans l'ordre, comme le plan d'un document.",
    why: "Un plan clair aide Google à comprendre chaque partie de la page, et aide le visiteur à la parcourir.",
    fix: () => ({ steps: ["Ouvrez la page dans l'éditeur.", "Utilisez « Titre 2 » pour les grandes parties et « Titre 3 » pour leurs sous-parties.", "Ne sautez pas de niveau (pas de Titre 4 juste après un Titre 2)."], snippet: null }),
    recTitle: (n) => `Remettre en ordre les intertitres de ${s(n, "page", "pages")}`, effort: "medium",
    recSteps: ["Corrigez d'abord les modèles de page communs (fiche produit, article).", "Gardez un ordre H2 puis H3, sans saut."],
    strength: { title: "Les intertitres suivent un plan clair", detail: (n) => `${n} pages ont des intertitres dans l'ordre.` },
  },
  {
    id: "canonical", category: "balises", label: "Adresse de référence", max: 3, partial: 0, expected: "Une balise canonical déclarée",
    found: (f, st) => (st === "pass" ? f.url : "Aucune adresse de référence"),
    message: (_f, st) => st === "pass" ? "L'adresse de référence est déclarée." : "Sans adresse de référence, des variantes de la même page peuvent se concurrencer.",
    issueTitle: (n) => `${s(n, "page ne déclare", "pages ne déclarent")} pas d'adresse de référence`,
    summary: "L'adresse de référence (balise canonical) indique à Google quelle adresse retenir quand une page est accessible de plusieurs façons.",
    why: "Sans elle, une même page avec ou sans paramètres (?tri=prix, ?page=2) peut être vue comme plusieurs pages qui se partagent les visites.",
    fix: (host) => ({ steps: ["Activez l'adresse canonique dans les réglages SEO de votre outil (souvent automatique).", "Sinon, ajoutez la balise ci-dessous dans l'en-tête de chaque page, avec sa propre adresse."], snippet: { language: "html", code: `<link rel="canonical" href="https://${host}/boutique">` } }),
    recTitle: () => "Déclarer l'adresse de référence dans le thème", effort: "quick",
    recSteps: ["Activez l'option canonical dans les réglages SEO, ou ajoutez la balise au modèle de page du thème."],
    strength: { title: "Chaque page déclare son adresse de référence", detail: (n) => `${n} pages ont une balise canonical.` },
  },
  {
    id: "lang", category: "balises", label: "Langue déclarée", max: 2, partial: 0, expected: "Attribut lang sur la balise html",
    found: (_f, st) => (st === "pass" ? "fr" : "Aucune langue déclarée"),
    message: (_f, st) => st === "pass" ? "La langue de la page est déclarée." : "La langue de la page n'est pas déclarée.",
    issueTitle: (n) => `La langue n'est pas déclarée sur ${s(n, "page", "pages")}`,
    summary: "Déclarer la langue aide Google à proposer la page aux bons internautes et permet aux lecteurs d'écran de la prononcer correctement.",
    why: "C'est un réglage unique, sans effort, qui évite des erreurs de langue dans les résultats et pour les visiteurs malvoyants.",
    fix: () => ({ steps: ["Choisissez « Français » dans les réglages de langue du site : l'outil l'ajoute à chaque page."], snippet: { language: "html", code: "<html lang=\"fr\">" } }),
    recTitle: () => "Déclarer la langue du site", effort: "quick",
    recSteps: ["Réglez la langue du site sur « Français » dans les paramètres généraux."],
    strength: { title: "La langue est déclarée partout", detail: (n) => `${n} pages déclarent leur langue.` },
  },
  // ───────── Contenu (20)
  {
    id: "words", category: "contenu", label: "Quantité de texte", max: 8, partial: 4, expected: "Au moins 300 mots utiles",
    found: (f) => `${f.words} mots`,
    message: (f, st) => st === "pass" ? "Assez de texte pour que Google comprenne la page." : `${f.words} mots seulement : la page a peu de matière pour se positionner.`,
    issueTitle: (n) => `${s(n, "page a", "pages ont")} trop peu de texte`,
    summary: "Une page avec très peu de texte donne peu d'indices à Google sur ce qu'elle propose.",
    why: "Les pages qui doivent attirer des visites depuis Google (catégories, services) ont besoin d'un texte utile : à qui s'adresse l'offre, ce qu'elle comprend, les questions fréquentes.",
    fix: () => ({ steps: ["Ajoutez un paragraphe d'introduction sous le titre principal.", "Répondez aux deux ou trois questions que vos clients posent le plus souvent.", "Visez au moins 300 mots sur les pages importantes."], snippet: null }),
    recTitle: (n) => `Étoffer le texte de ${s(n, "page", "pages")}`, effort: "heavy",
    recSteps: ["Commencez par les pages de catégorie et de service.", "Ajoutez une introduction et une courte foire aux questions."],
    strength: { title: "Les pages ont assez de texte", detail: (n) => `${n} pages comptent au moins 300 mots.` },
  },
  {
    id: "title_h1", category: "contenu", label: "Titre et titre principal cohérents", max: 4, partial: 0, expected: "Le titre et le H1 partagent leurs mots importants",
    found: (_f, st) => (st === "pass" ? "Mots en commun" : "Aucun mot en commun"),
    message: (_f, st) => st === "pass" ? "Le titre et le titre principal annoncent le même sujet." : "Le titre et le titre principal n'annoncent pas le même sujet.",
    issueTitle: (n) => `Le titre et le titre principal ne concordent pas sur ${s(n, "page", "pages")}`,
    summary: "Le titre affiché dans Google et le titre principal de la page doivent annoncer le même sujet, avec des mots en commun.",
    why: "Quand les deux concordent, Google est plus sûr du sujet de la page, et l'internaute retrouve ce qu'il a lu dans les résultats.",
    fix: () => ({ steps: ["Reprenez les mots importants du titre dans le titre principal de la page."], snippet: null }),
    recTitle: (n) => `Aligner titre et titre principal sur ${s(n, "page", "pages")}`, effort: "medium",
    recSteps: ["Pour chaque page, reprenez dans le H1 les mots clés du titre."],
    strength: { title: "Titres et titres principaux concordent", detail: (n) => `${n} pages ont un titre et un H1 cohérents.` },
  },
  {
    id: "h2", category: "contenu", label: "Parties de la page", max: 4, partial: 2, expected: "Au moins deux intertitres H2",
    found: (_f, st) => (st === "pass" ? "3 intertitres H2" : st === "warn" ? "1 intertitre H2" : "Aucun intertitre H2"),
    message: (_f, st) => st === "pass" ? "Le contenu est découpé en parties." : "Le contenu gagnerait à être découpé en parties.",
    issueTitle: (n) => `${s(n, "page n'est", "pages ne sont")} pas découpées en parties`,
    summary: "Des intertitres H2 découpent le texte en parties lisibles, qui reprennent les questions de vos clients.",
    why: "Google peut afficher une partie précise d'une page en réponse à une question. Sans intertitres, il a plus de mal à les repérer.",
    fix: () => ({ steps: ["Découpez le texte en au moins deux parties.", "Donnez à chaque partie un intertitre « Titre 2 » qui reprend une question de client."], snippet: null }),
    recTitle: (n) => `Découper en parties ${s(n, "page", "pages")}`, effort: "medium",
    recSteps: ["Ajoutez deux intertitres H2 sur chaque page importante."],
    strength: { title: "Les pages sont découpées en parties", detail: (n) => `${n} pages ont au moins deux intertitres H2.` },
  },
  {
    id: "description_unique", category: "contenu", label: "Description distincte du titre", max: 4, partial: 0, expected: "Une description qui complète le titre",
    found: (_f, st) => (st === "pass" ? "Description distincte" : "Pas de description, ou copie du titre"),
    message: (_f, st) => st === "pass" ? "La description complète le titre." : "La description manque ou recopie le titre.",
    issueTitle: (n) => `La description recopie le titre ou manque sur ${s(n, "page", "pages")}`,
    summary: "La description doit compléter le titre, pas le répéter : c'est la place pour un argument et une invitation à cliquer.",
    why: "Répéter le titre gâche la seule ligne de texte libre dont vous disposez dans les résultats.",
    fix: () => ({ steps: ["Écrivez une description qui ajoute un argument au titre (livraison, prix, savoir-faire)."], snippet: null }),
    recTitle: (n) => `Différencier la description du titre sur ${s(n, "page", "pages")}`, effort: "heavy",
    recSteps: ["Pour chaque page, ajoutez un argument concret à la description."],
    strength: { title: "Les descriptions complètent les titres", detail: (n) => `${n} pages ont une description différente du titre.` },
  },
  // ───────── Technique (25)
  {
    id: "viewport", category: "technique", label: "Affichage mobile", max: 6, partial: 0, expected: "Balise viewport présente",
    found: (_f, st) => (st === "pass" ? "Balise viewport présente" : "Pas de balise viewport"),
    message: (_f, st) => st === "pass" ? "La page s'adapte aux téléphones." : "La page s'affichera en version ordinateur réduite sur téléphone.",
    issueTitle: (n) => `${s(n, "page ne s'adapte", "pages ne s'adaptent")} pas aux téléphones`,
    summary: "Sans réglage d'affichage mobile, la page apparaît en tout petit sur téléphone. Google classe d'abord la version mobile.",
    why: "Plus de la moitié des recherches se font sur téléphone, et Google juge votre site sur sa version mobile.",
    fix: () => ({ steps: ["Ajoutez la balise ci-dessous dans l'en-tête de toutes les pages (souvent dans le modèle du thème)."], snippet: { language: "html", code: "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" } }),
    recTitle: () => "Activer l'affichage mobile dans le thème", effort: "quick",
    recSteps: ["Ajoutez la balise viewport au modèle commun des pages."],
    strength: { title: "Le site s'affiche correctement sur mobile", detail: () => "Toutes les pages déclarent l'affichage adapté aux téléphones." },
  },
  {
    id: "https", category: "technique", label: "Connexion sécurisée (HTTPS)", max: 4, partial: 0, expected: "Adresse en https://",
    found: (f, st) => (st === "pass" ? "https://" : f.url.replace("https://", "http://")),
    message: (_f, st) => st === "pass" ? "La page est servie en HTTPS." : "La page n'est pas sécurisée.",
    issueTitle: (n) => `${s(n, "page n'est", "pages ne sont")} pas sécurisées (HTTPS)`,
    summary: "Les navigateurs signalent comme « non sécurisée » une page sans HTTPS, ce qui fait fuir les visiteurs.",
    why: "Google favorise les pages sécurisées, et un avertissement du navigateur fait chuter la confiance.",
    fix: () => ({ steps: ["Activez le certificat SSL gratuit chez votre hébergeur.", "Redirigez toutes les adresses http:// vers https://."], snippet: null }),
    recTitle: () => "Activer le HTTPS sur tout le site", effort: "quick",
    recSteps: ["Activez le certificat chez l'hébergeur, puis la redirection automatique."],
    strength: { title: "Toutes les pages sont sécurisées (HTTPS)", detail: (n) => `Les ${n} pages sont servies en HTTPS.` },
  },
  {
    id: "indexable", category: "technique", label: "Visible dans Google", max: 6, partial: 0, expected: "Aucune consigne noindex",
    found: (_f, st) => (st === "pass" ? "Aucune consigne noindex" : "Consigne noindex présente"),
    message: (_f, st) => st === "pass" ? "Rien n'empêche Google d'afficher la page." : "La page demande à Google de ne pas l'afficher dans les résultats.",
    issueTitle: (n) => `${s(n, "page est cachée", "pages sont cachées")} à Google`,
    summary: "Ces pages contiennent une consigne « noindex » qui demande à Google de ne pas les afficher. Elles ne recevront aucune visite depuis Google.",
    why: "Tant que cette consigne est là, aucune autre amélioration ne sert. Elle est souvent restée après la mise en ligne d'un site en construction.",
    fix: () => ({ steps: ["Dans les réglages SEO de chaque page, décochez « Masquer des moteurs de recherche ».", "Vérifiez aussi le réglage général « Visibilité pour les moteurs de recherche »."], snippet: { language: "html", code: "<!-- À supprimer de l'en-tête de la page -->\n<meta name=\"robots\" content=\"noindex\">" } }),
    recTitle: (n) => `Rendre visibles à Google ${s(n, "page cachée", "pages cachées")}`, effort: "quick",
    recSteps: ["Retirez la consigne noindex des pages qui doivent apparaître dans Google."],
    strength: { title: "Toutes les pages sont visibles dans Google", detail: (n) => `${n} pages n'ont aucune consigne noindex.` },
  },
  {
    id: "charset", category: "technique", label: "Encodage des caractères", max: 2, partial: 0, expected: "Encodage déclaré (UTF-8)",
    found: (_f, st) => (st === "pass" ? "UTF-8" : "Aucun encodage déclaré"),
    message: (_f, st) => st === "pass" ? "L'encodage est déclaré." : "Les accents risquent de s'afficher mal.",
    issueTitle: (n) => `L'encodage n'est pas déclaré sur ${s(n, "page", "pages")}`,
    summary: "Sans encodage déclaré, les lettres accentuées peuvent s'afficher sous forme de symboles étranges.",
    why: "Un texte illisible fait fuir les visiteurs et peut être mal compris par Google.",
    fix: () => ({ steps: ["Ajoutez la balise ci-dessous en tout début d'en-tête, dans le modèle du thème."], snippet: { language: "html", code: "<meta charset=\"utf-8\">" } }),
    recTitle: () => "Déclarer l'encodage dans le thème", effort: "quick",
    recSteps: ["Ajoutez la balise charset au modèle commun."],
    strength: { title: "L'encodage est déclaré", detail: (n) => `${n} pages déclarent leur encodage.` },
  },
  {
    id: "structured_data", category: "technique", label: "Données structurées", max: 5, partial: 2, expected: "Un bloc JSON-LD valide",
    found: (_f, st) => (st === "pass" ? "JSON-LD valide : Organization" : st === "warn" ? "1 bloc JSON-LD illisible" : "Aucune donnée structurée"),
    message: (_f, st) => st === "pass" ? "Des données structurées valides sont présentes." : st === "warn" ? "Un bloc de données structurées contient une erreur." : "Aucune donnée structurée : pas de résultat enrichi possible.",
    issueTitle: (n) => `${s(n, "page n'a", "pages n'ont")} pas de données structurées valides`,
    summary: "Les données structurées décrivent la page à Google dans un format qu'il comprend : produit, prix, avis, horaires.",
    why: "Elles permettent les résultats enrichis (étoiles, prix, disponibilité), qui attirent nettement plus le regard dans Google.",
    fix: (host) => ({ steps: ["Ajoutez le bloc ci-dessous dans l'en-tête de la page d'accueil.", "Pour les fiches produits, utilisez le type Product (souvent proposé par une extension SEO)."], snippet: { language: "html", code: `<script type="application/ld+json">\n{\n  "@context": "https://schema.org",\n  "@type": "Organization",\n  "name": "Atelier Lune",\n  "url": "https://${host}",\n  "logo": "https://${host}/logo.png"\n}\n</script>` } }),
    recTitle: () => "Ajouter des données structurées au thème", effort: "medium",
    recSteps: ["Installez ou activez une extension qui génère les données structurées.", "Vérifiez le résultat avec l'outil de test des résultats enrichis de Google."],
    strength: { title: "Des données structurées valides", detail: (n) => `${n} pages ont un bloc JSON-LD valide.` },
  },
  {
    id: "blocking_scripts", category: "technique", label: "Scripts qui ralentissent l'affichage", max: 2, partial: 1, expected: "Au plus 2 scripts bloquants",
    found: (_f, st) => (st === "pass" ? "1 script bloquant" : st === "warn" ? "4 scripts bloquants" : "7 scripts bloquants"),
    message: (_f, st) => st === "pass" ? "Peu de scripts retardent l'affichage." : "Des scripts retardent l'affichage de la page.",
    issueTitle: (n) => `Des scripts ralentissent l'affichage de ${s(n, "page", "pages")}`,
    summary: "Certains scripts chargés en haut de la page bloquent son affichage le temps d'être téléchargés.",
    why: "Une page qui s'affiche lentement perd des visiteurs, surtout sur téléphone.",
    fix: () => ({ steps: ["Ajoutez l'attribut defer aux scripts qui ne sont pas indispensables au premier affichage."], snippet: { language: "html", code: "<script src=\"/js/avis-clients.js\" defer></script>" } }),
    recTitle: () => "Différer les scripts non indispensables", effort: "quick",
    recSteps: ["Repérez les scripts d'extensions dans le modèle du thème.", "Ajoutez-leur l'attribut defer."],
    strength: { title: "Peu de scripts bloquants", detail: (n) => `${n} pages ont au plus deux scripts bloquants.` },
  },
  // ───────── Liens et images (15)
  {
    id: "image_alt", category: "medias", label: "Texte alternatif des images", max: 6, partial: 3, expected: "Toutes les images décrites",
    found: (f, st) => (st === "pass" ? `${f.images} images décrites` : `${f.imagesNoAlt} images sur ${f.images} sans texte alternatif`),
    message: (_f, st) => st === "pass" ? "Toutes les images ont un texte alternatif." : "Des images n'ont pas de texte alternatif.",
    issueTitle: (n) => `Des images n'ont pas de texte alternatif sur ${s(n, "page", "pages")}`,
    summary: "Le texte alternatif décrit une image à Google et aux lecteurs d'écran. Sans lui, l'image ne peut pas ressortir dans Google Images.",
    why: "Google Images est une source de visites importante pour un site qui vend des objets. Le texte alternatif rend aussi le site utilisable par les personnes malvoyantes.",
    fix: () => ({ steps: ["Dans la médiathèque de votre outil, ouvrez chaque image.", "Remplissez le champ « Texte alternatif » avec une courte description de ce qu'on voit."], snippet: { language: "html", code: "<img src=\"bol-gres-bleu.jpg\" alt=\"Bol en grès émaillé bleu nuit, tourné à la main\">" } }),
    recTitle: (n) => `Décrire les images de ${s(n, "page", "pages")}`, effort: "medium",
    recSteps: ["Commencez par les photos de produits.", "Décrivez ce qu'on voit en une phrase courte."],
    strength: { title: "Les images sont décrites", detail: (n) => `${n} pages ont toutes leurs images décrites.` },
  },
  {
    id: "image_size", category: "medias", label: "Images optimisées", max: 3, partial: 1, expected: "Dimensions ou chargement différé déclarés",
    found: (f, st) => (st === "pass" ? `${f.images} images optimisées` : `${Math.max(1, f.images - 2)} images sur ${f.images} sans dimensions`),
    message: (_f, st) => st === "pass" ? "Les images ne font pas sauter la page au chargement." : "Des images sans dimensions font sauter la page au chargement.",
    issueTitle: (n) => `Des images ralentissent ${s(n, "page", "pages")}`,
    summary: "Des images sans dimensions déclarées font « sauter » la page pendant son chargement et la ralentissent.",
    why: "Google mesure la stabilité de l'affichage. Une page qui bouge pendant le chargement est jugée moins agréable.",
    fix: () => ({ steps: ["Indiquez la largeur et la hauteur de chaque image.", "Ajoutez loading=\"lazy\" aux images situées plus bas dans la page."], snippet: { language: "html", code: "<img src=\"vase.jpg\" alt=\"Vase en grès\" width=\"800\" height=\"600\" loading=\"lazy\">" } }),
    recTitle: () => "Déclarer les dimensions des images dans le thème", effort: "quick",
    recSteps: ["Activez le chargement différé des images dans le thème ou une extension."],
    strength: { title: "Les images sont optimisées", detail: (n) => `${n} pages ont des images avec dimensions.` },
  },
  {
    id: "internal_links", category: "medias", label: "Liens vers vos autres pages", max: 3, partial: 1, expected: "Au moins 3 liens internes",
    found: (_f, st) => (st === "pass" ? "14 liens internes" : st === "warn" ? "2 liens internes" : "Aucun lien interne"),
    message: (_f, st) => st === "pass" ? "La page renvoie vers d'autres pages du site." : "La page renvoie trop peu vers vos autres pages.",
    issueTitle: (n) => `${s(n, "page renvoie", "pages renvoient")} trop peu vers vos autres pages`,
    summary: "Les liens entre vos pages aident Google à découvrir tout le site et les visiteurs à continuer leur visite.",
    why: "Une page isolée reçoit moins de visites : Google la trouve moins facilement et la juge moins importante.",
    fix: () => ({ steps: ["Ajoutez dans le texte des liens vers vos pages importantes (catégories, cours, contact)."], snippet: null }),
    recTitle: (n) => `Ajouter des liens internes sur ${s(n, "page", "pages")}`, effort: "medium",
    recSteps: ["Ajoutez un bloc « Voir aussi » ou des liens dans le texte."],
    strength: { title: "Les pages sont bien reliées entre elles", detail: (n) => `${n} pages ont au moins trois liens internes.` },
  },
  {
    id: "link_text", category: "medias", label: "Texte des liens", max: 3, partial: 2, expected: "Des liens qui décrivent la page visée",
    found: (_f, st) => (st === "pass" ? "Liens descriptifs" : st === "warn" ? "2 liens « cliquez ici »" : "5 liens vides ou « en savoir plus »"),
    message: (_f, st) => st === "pass" ? "Les liens décrivent la page visée." : "Des liens ne disent pas où ils mènent.",
    issueTitle: (n) => `Des liens peu clairs sur ${s(n, "page", "pages")}`,
    summary: "Un lien « cliquez ici » ou « en savoir plus » ne dit ni à Google ni au visiteur où il mène.",
    why: "Le texte d'un lien est un indice fort sur le sujet de la page visée.",
    fix: () => ({ steps: ["Remplacez « en savoir plus » par ce que contient la page visée, par exemple « voir les cours d'initiation »."], snippet: null }),
    recTitle: () => "Rendre explicites les textes des liens", effort: "medium",
    recSteps: ["Corrigez d'abord les boutons répétés dans le thème."],
    strength: { title: "Les liens sont explicites", detail: (n) => `${n} pages n'ont que des liens descriptifs.` },
  },
  // ───────── Partage (10)
  {
    id: "open_graph", category: "partage", label: "Aperçu lors d'un partage", max: 6, partial: 2, expected: "og:title, og:description et og:image",
    found: (_f, st) => (st === "pass" ? "Les trois balises présentes" : st === "warn" ? "Il manque og:image" : "Aucune balise Open Graph"),
    message: (_f, st) => st === "pass" ? "Le lien partagé s'affichera avec un visuel." : "Le lien partagé s'affichera sans visuel soigné.",
    issueTitle: (n) => `L'aperçu de partage est incomplet sur ${s(n, "page", "pages")}`,
    summary: "Quand on partage un lien sur les réseaux sociaux ou une messagerie, ces balises décident du titre, du texte et de l'image affichés.",
    why: "Un aperçu soigné, avec une belle image, donne nettement plus envie de cliquer sur un lien partagé.",
    fix: (host) => ({ steps: ["Dans les réglages SEO, renseignez l'image de partage (1200 × 630 px).", "Sinon, ajoutez ces balises à l'en-tête du thème."], snippet: { language: "html", code: `<meta property="og:title" content="Atelier Lune — Poterie artisanale à Nantes">\n<meta property="og:description" content="Vaisselle en grès tournée à la main et cours de poterie.">\n<meta property="og:image" content="https://${host}/partage-1200x630.jpg">` } }),
    recTitle: () => "Compléter l'aperçu de partage", effort: "quick",
    recSteps: ["Choisissez une image de partage par défaut dans les réglages SEO."],
    strength: { title: "L'aperçu de partage est complet", detail: (n) => `${n} pages ont un aperçu de partage complet.` },
  },
  {
    id: "twitter_card", category: "partage", label: "Carte X (Twitter)", max: 2, partial: 0, expected: "Balise twitter:card",
    found: (_f, st) => (st === "pass" ? "summary_large_image" : "Pas de balise twitter:card"),
    message: (_f, st) => st === "pass" ? "La carte X est déclarée." : "Pas de carte X déclarée.",
    issueTitle: (n) => `Pas de carte X (Twitter) sur ${s(n, "page", "pages")}`,
    summary: "Cette balise choisit la forme de l'aperçu quand un lien est partagé sur X (anciennement Twitter).",
    why: "Sans elle, l'aperçu sur X est réduit à un petit encart.",
    fix: () => ({ steps: ["Ajoutez la balise à l'en-tête du thème."], snippet: { language: "html", code: "<meta name=\"twitter:card\" content=\"summary_large_image\">" } }),
    recTitle: () => "Déclarer la carte X dans le thème", effort: "quick",
    recSteps: ["Ajoutez la balise twitter:card au modèle commun."],
    strength: { title: "La carte X est déclarée", detail: (n) => `${n} pages déclarent une carte X.` },
  },
  {
    id: "favicon", category: "partage", label: "Icône du site", max: 2, partial: 0, expected: "Un favicon déclaré",
    found: (_f, st) => (st === "pass" ? "/favicon.ico" : "Aucun favicon"),
    message: (_f, st) => st === "pass" ? "L'icône du site est déclarée." : "L'icône du site n'est pas déclarée.",
    issueTitle: (n) => `L'icône du site manque sur ${s(n, "page", "pages")}`,
    summary: "Le favicon est la petite icône affichée à côté de votre résultat dans Google sur mobile et dans les onglets.",
    why: "Il rend votre résultat reconnaissable d'un coup d'œil.",
    fix: () => ({ steps: ["Téléversez votre logo carré dans les réglages « Icône du site »."], snippet: { language: "html", code: "<link rel=\"icon\" href=\"/favicon.ico\" sizes=\"any\">" } }),
    recTitle: () => "Ajouter l'icône du site", effort: "quick",
    recSteps: ["Téléversez un logo carré de 512 × 512 px."],
    strength: { title: "L'icône du site est déclarée", detail: (n) => `${n} pages déclarent un favicon.` },
  },
];

export const CATEGORY_LABELS: Record<CategoryId, string> = {
  balises: "Balises", contenu: "Contenu", technique: "Technique", medias: "Liens et images", partage: "Partage social",
};
