/**
 * Catalogue des problèmes : pour chaque critère, des textes compréhensibles sans connaissance du SEO
 * (titre, résumé, explication, étapes) et un code prêt à copier construit à partir des vraies valeurs
 * d'une page concernée. Les valeurs tirées des pages sont du texte brut ; l'interface ne les interprète pas.
 */
import type { Effort } from "../../../shared/api.ts";
import { cut, type PageFacts } from "./grille.ts";

export interface SamplePage {
  url: string;
  facts: PageFacts;
  siteName: string;
}

export interface IssueContext {
  affected: number;
  total: number;
  /** Nombre de pages où le critère vaut 0 (« fail »), parmi les pages concernées. */
  failing: number;
  sample: SamplePage | null;
}

interface Entry {
  title(c: IssueContext): string;
  summary: string;
  why: string;
  steps(c: IssueContext): string[];
  snippet?(c: IssueContext): { language: "html" | "text" | "json"; code: string } | null;
  /** Le code est construit avec les valeurs de la page la plus touchée (Fix.snippet.forPath). */
  snippetFromPage?: true;
  /** Nature du correctif : un réglage commun à tout le site, ou un travail page par page. */
  scope: "site" | "page" | "mixed";
  action(c: IssueContext): string;
  /** `title` quand toutes les pages valident le critère, `most` quand presque toutes (au moins 90 %). */
  strength: { title: string; most: string; detail: (passing: number, total: number) => string };
}

const n = (k: number, one: string, many: string) => `${k} ${k > 1 ? many : one}`;
const pagesTxt = (k: number) => n(k, "page", "pages");
const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const textNode = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Coupe à la limite d'un mot, sans points de suspension. */
function trimWords(s: string, max: number): string {
  if (s.length <= max) return s;
  const slice = s.slice(0, max + 1);
  const at = slice.lastIndexOf(" ");
  return (at > max * 0.6 ? slice.slice(0, at) : s.slice(0, max)).replace(/[\s,;:–—-]+$/, "");
}
function origin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}
const allPass = (passing: number, total: number) => (passing === total ? `Les ${pagesTxt(total)} analysées` : `${passing} pages sur ${total}`);
const where = "dans votre outil de gestion du site (WordPress, Shopify, Wix…), dans le réglage « Référencement » ou « SEO » de la page";
const headStep = "Collez ce code dans l'en-tête (<head>) commun à toutes les pages : dans le thème, ou via le réglage « Code personnalisé » / « Injection de code » de votre outil.";

export const CATALOGUE: Record<string, Entry> = {
  title: {
    title: (c) => (c.failing === c.affected ? `${n(c.affected, "page n'a", "pages n'ont")} pas de titre` : `Le titre est à revoir sur ${pagesTxt(c.affected)}`),
    summary: "Le titre de la page est la ligne bleue cliquable affichée dans Google. Absent, trop court ou trop long, il donne moins envie de cliquer et dit mal à Google de quoi parle la page.",
    why: "Google s'appuie d'abord sur le titre pour comprendre le sujet d'une page, et l'internaute le lit avant tout le reste. Au-delà d'environ 60 caractères il est coupé ; trop court, il ne précise ni l'offre ni le lieu.",
    steps: () => [
      `Ouvrez la page ${where}.`,
      "Écrivez un titre de 30 à 60 caractères : le sujet de la page d'abord, puis votre marque.",
      "Chaque page doit avoir son propre titre, différent des autres.",
    ],
    snippet: (c) => {
      const f = c.sample?.facts;
      if (!f) return null;
      const subject = f.h1[0] || f.title;
      if (!subject) return null;
      let proposal = subject;
      const brand = c.sample!.siteName;
      if (brand && !subject.toLowerCase().includes(brand.toLowerCase()) && subject.length + brand.length + 3 <= 60) proposal = `${subject} | ${brand}`;
      proposal = trimWords(proposal, 60);
      return { language: "html", code: `<title>${textNode(proposal)}</title>` };
    },
    snippetFromPage: true,
    scope: "page",
    action: (c) => `Réécrire le titre de ${pagesTxt(c.affected)}`,
    strength: { title: "Les titres de page ont la bonne longueur", most: "Presque toutes les pages ont un titre de la bonne longueur", detail: (p, t) => `${allPass(p, t)} ont un titre de 30 à 60 caractères.` },
  },
  meta_description: {
    title: (c) =>
      c.failing === c.affected ? `${n(c.affected, "page n'a", "pages n'ont")} pas de description` : `La description est à revoir sur ${pagesTxt(c.affected)}`,
    summary: "La description est le texte affiché sous le titre dans Google. Sans elle, ou si elle est mal calibrée, Google choisit lui-même un extrait, rarement le plus vendeur.",
    why: "Une bonne description ne fait pas monter la page dans le classement, mais elle décide si l'internaute clique sur votre résultat plutôt que sur celui du dessus. C'est votre annonce gratuite dans Google.",
    steps: () => [
      "Commencez par les pages qui reçoivent le plus de visites.",
      `Ouvrez la page ${where}.`,
      "Écrivez 120 à 155 caractères, propres à cette page : ce qu'elle propose, un argument, une invitation à cliquer.",
    ],
    snippet: (c) => {
      const f = c.sample?.facts;
      if (!f) return null;
      let draft = "";
      if (f.description.length > 160) draft = trimWords(f.description, 155);
      else {
        const src = f.description.length ? `${f.description} ${f.excerpt}` : f.excerpt;
        draft = trimWords(src.replace(/…$/, ""), 155);
      }
      if (draft.length < 40) return null;
      return {
        language: "html",
        code: `<!-- Point de départ tiré du texte de ${c.sample!.url} : à reformuler -->\n<meta name="description" content="${attr(draft)}">`,
      };
    },
    snippetFromPage: true,
    scope: "page",
    action: (c) => (c.failing === c.affected ? `Rédiger une description pour ${pagesTxt(c.affected)}` : `Revoir la description de ${pagesTxt(c.affected)}`),
    strength: { title: "Les descriptions sont bien calibrées", most: "Presque toutes les descriptions sont bien calibrées", detail: (p, t) => `${allPass(p, t)} ont une description de 70 à 160 caractères.` },
  },
  h1: {
    title: (c) =>
      c.failing === c.affected
        ? `${n(c.affected, "page n'a", "pages n'ont")} pas de titre principal`
        : c.failing === 0
          ? `Le titre principal est en double sur ${pagesTxt(c.affected)}`
          : `Le titre principal manque ou est en double sur ${pagesTxt(c.affected)}`,
    summary: "Chaque page doit avoir un seul titre principal (H1), le grand titre visible en haut, qui annonce son sujet. Absent ou multiplié, il brouille ce signal.",
    why: "Le H1 est le repère que Google et les lecteurs d'écran utilisent pour savoir de quoi parle la page. Plusieurs H1 viennent souvent du thème (logo, bannière, bloc récurrent) : un seul réglage corrige alors toutes les pages.",
    steps: (c) =>
      c.failing === c.affected
        ? ["Ajoutez en haut de chaque page un grand titre qui annonce son sujet.", "Dans l'éditeur, choisissez le style « Titre 1 » (H1) pour ce titre, et lui seul."]
        : [
            "Repérez les H1 en trop : souvent le logo, une bannière ou un bloc répété sur toutes les pages.",
            "Dans le thème ou l'éditeur, passez ces titres en « Titre 2 » (H2) : la correction s'applique d'un coup à toutes les pages qui utilisent ce bloc.",
            "Gardez un seul H1 par page, celui qui annonce le sujet.",
          ],
    snippet: (c) => {
      const f = c.sample?.facts;
      if (!f) return null;
      if (f.h1.length > 1)
        return {
          language: "html",
          code: `<!-- À garder -->\n<h1>${textNode(cut(f.h1[0], 90))}</h1>\n<!-- À passer en H2 -->\n${f.h1
            .slice(1, 4)
            .map((h) => `<h2>${textNode(cut(h, 90))}</h2>`)
            .join("\n")}`,
        };
      const subject = f.title.split(/\s[|–—-]\s/)[0]?.trim();
      return subject ? { language: "html", code: `<h1>${textNode(cut(subject, 90))}</h1>` } : null;
    },
    snippetFromPage: true,
    scope: "mixed",
    action: (c) => (c.failing === c.affected ? `Ajouter un titre principal sur ${pagesTxt(c.affected)}` : `Garder un seul titre principal sur ${pagesTxt(c.affected)}`),
    strength: { title: "Chaque page a un titre principal unique", most: "Presque toutes les pages ont un titre principal unique", detail: (p, t) => `${allPass(p, t)} ont exactement un H1.` },
  },
  heading_hierarchy: {
    title: (c) => `Les intertitres sont mal organisés sur ${pagesTxt(c.affected)}`,
    summary: "Les intertitres (H2, H3…) forment le plan de la page. Des niveaux sautés ou l'absence de H2 rendent ce plan difficile à suivre.",
    why: "Un plan clair aide Google à comprendre les parties d'une page et à en afficher des extraits ; il aide aussi les visiteurs qui parcourent la page en diagonale et ceux qui utilisent un lecteur d'écran.",
    steps: () => [
      "Sous le titre principal, utilisez des « Titre 2 » (H2) pour les grandes parties.",
      "Utilisez des « Titre 3 » (H3) uniquement à l'intérieur d'une partie H2, et ainsi de suite, sans sauter de niveau.",
      "Si un style de titre sert seulement à grossir un texte, remplacez-le par du texte en gras.",
    ],
    scope: "mixed",
    action: (c) => `Remettre les intertitres dans l'ordre sur ${pagesTxt(c.affected)}`,
    strength: { title: "Les intertitres suivent un plan clair", most: "Les intertitres suivent un plan clair sur presque toutes les pages", detail: (p, t) => `${allPass(p, t)} ont des H2 et des niveaux qui s'enchaînent.` },
  },
  canonical: {
    title: (c) => `L'adresse de référence manque ou est invalide sur ${pagesTxt(c.affected)}`,
    summary: "La balise canonique indique à Google l'adresse officielle d'une page ; elle doit pointer vers une page de ce site. Sans elle, des variantes (avec paramètres, avec ou sans slash final) peuvent se faire concurrence.",
    why: "Quand plusieurs adresses affichent le même contenu, Google peut répartir la popularité entre elles ou choisir la mauvaise. La balise canonique règle la question une fois pour toutes ; la plupart des thèmes et extensions SEO l'ajoutent automatiquement.",
    steps: () => [
      "Activez l'option « URL canonique » de votre extension SEO ou de votre thème : elle s'applique à toutes les pages.",
      "À défaut, ajoutez dans l'en-tête (<head>) de chaque page une balise canonique qui pointe vers sa propre adresse.",
    ],
    snippet: (c) => (c.sample ? { language: "html", code: `<link rel="canonical" href="${attr(c.sample.url)}">` } : null),
    snippetFromPage: true,
    scope: "site",
    action: (c) => `Déclarer l'adresse de référence de ${pagesTxt(c.affected)}`,
    strength: { title: "Chaque page déclare son adresse de référence", most: "Presque toutes les pages déclarent leur adresse de référence", detail: (p, t) => `${allPass(p, t)} ont une balise canonique.` },
  },
  lang: {
    title: (c) => `La langue n'est pas déclarée sur ${pagesTxt(c.affected)}`,
    summary: "La langue de la page doit être indiquée dans son code. Sans elle, Google et les lecteurs d'écran doivent la deviner.",
    why: "Déclarer la langue aide Google à proposer la page aux bons internautes et permet aux lecteurs d'écran de prononcer correctement le texte.",
    steps: () => [
      "Dans les réglages de langue de votre site, choisissez la langue de vos pages : la plupart des outils l'ajoutent alors automatiquement.",
      "Sur un site codé à la main, ajoutez l'attribut lang à la balise <html> de chaque page (remplacez fr par la langue de vos pages si besoin).",
    ],
    snippet: () => ({ language: "html", code: '<html lang="fr">' }),
    scope: "site",
    action: (c) => `Déclarer la langue de ${pagesTxt(c.affected)}`,
    strength: { title: "La langue des pages est déclarée", most: "La langue est déclarée sur presque toutes les pages", detail: (p, t) => `${allPass(p, t)} indiquent leur langue.` },
  },
  word_count: {
    title: (c) => `${n(c.affected, "page a", "pages ont")} trop peu de texte`,
    summary: "Une page avec peu de texte donne peu d'éléments à Google pour comprendre ce qu'elle propose et la montrer sur les recherches de vos clients.",
    why: "Google classe les pages qui répondent le mieux à une recherche. Quelques lignes suffisent rarement : 300 mots utiles permettent de décrire l'offre, de répondre aux questions fréquentes et d'employer les mots que vos clients tapent.",
    steps: () => [
      "Commencez par les pages qui doivent attirer des visiteurs depuis Google (catégories, services, produits phares).",
      "Ajoutez un texte d'au moins 300 mots : ce que propose la page, pour qui, les questions fréquentes de vos clients.",
      "Écrivez pour vos visiteurs, avec les mots qu'ils emploient ; évitez les répétitions artificielles.",
    ],
    scope: "page",
    action: (c) => `Étoffer le texte de ${pagesTxt(c.affected)}`,
    strength: { title: "Les pages ont assez de texte", most: "Presque toutes les pages ont assez de texte", detail: (p, t) => `${allPass(p, t)} ont au moins 300 mots.` },
  },
  title_h1_match: {
    title: (c) => `Le titre et le titre principal ne parlent pas du même sujet sur ${pagesTxt(c.affected)}`,
    summary: "Le titre affiché dans Google et le grand titre visible sur la page (H1) doivent annoncer le même sujet, avec des mots en commun.",
    why: "Quand les deux titres concordent, Google comprend plus sûrement le sujet de la page, et l'internaute qui arrive retrouve ce qu'il a lu dans les résultats.",
    steps: () => [
      "Comparez le titre de la page (réglage SEO) et son grand titre visible (H1).",
      "Faites-leur partager le mot clé principal : par exemple « Cours de poterie à Nantes » dans les deux.",
    ],
    scope: "page",
    action: (c) => `Accorder titre et titre principal sur ${pagesTxt(c.affected)}`,
    strength: { title: "Titres et titres principaux concordent", most: "Titres et titres principaux concordent sur presque toutes les pages", detail: (p, t) => `${allPass(p, t)} partagent des mots clés entre titre et H1.` },
  },
  h2_sections: {
    title: (c) => `${n(c.affected, "page n'est", "pages ne sont")} pas découpées en sections`,
    summary: "Les intertitres H2 découpent une page en parties. Sans eux, le texte forme un bloc difficile à parcourir pour les visiteurs comme pour Google.",
    why: "Des intertitres qui reprennent les questions de vos clients rendent la page plus lisible et donnent à Google des repères sur les sujets traités.",
    steps: () => [
      "Découpez le texte de la page en au moins deux parties.",
      "Donnez à chaque partie un intertitre au style « Titre 2 » (H2) qui reprend une question de vos clients.",
    ],
    scope: "page",
    action: (c) => `Ajouter des intertitres sur ${pagesTxt(c.affected)}`,
    strength: { title: "Les pages sont découpées en sections", most: "Presque toutes les pages sont découpées en sections", detail: (p, t) => `${allPass(p, t)} ont au moins deux H2.` },
  },
  description_distinct: {
    title: (c) => `La description manque ou recopie le titre sur ${pagesTxt(c.affected)}`,
    summary: "La description doit compléter le titre, pas le répéter. Absente ou identique au titre, elle n'apporte rien de plus à l'internaute.",
    why: "Le titre et la description s'affichent l'un sous l'autre dans Google. Une description qui ajoute un argument (prix, délai, lieu, avis) augmente les chances de clic.",
    steps: () => [
      `Ouvrez la page ${where}.`,
      "Écrivez une description qui complète le titre : un bénéfice, une preuve, une invitation à cliquer.",
    ],
    scope: "page",
    action: (c) => `Écrire une description distincte du titre pour ${pagesTxt(c.affected)}`,
    strength: { title: "Les descriptions complètent les titres", most: "Presque toutes les descriptions complètent leur titre", detail: (p, t) => `${allPass(p, t)} ont une description différente du titre.` },
  },
  viewport: {
    title: (c) => `${n(c.affected, "page ne s'adapte", "pages ne s'adaptent")} pas aux téléphones`,
    summary: "Sans la balise « viewport », la page s'affiche sur téléphone comme une version d'ordinateur réduite, illisible sans zoomer.",
    why: "Google classe d'abord les sites d'après leur version mobile. Une page qui ne s'adapte pas aux téléphones est pénalisée et fait fuir les visiteurs mobiles, souvent majoritaires.",
    steps: () => [headStep, "Si votre thème est récent, vérifiez simplement qu'il est bien activé : il contient normalement cette balise."],
    snippet: () => ({ language: "html", code: '<meta name="viewport" content="width=device-width, initial-scale=1">' }),
    scope: "site",
    action: (c) => `Activer l'affichage mobile sur ${pagesTxt(c.affected)}`,
    strength: { title: "Le site s'affiche correctement sur mobile", most: "Presque toutes les pages s'affichent correctement sur mobile", detail: (p, t) => `${allPass(p, t)} déclarent l'affichage adapté aux téléphones.` },
  },
  https: {
    title: (c) => `${n(c.affected, "page n'est pas sécurisée", "pages ne sont pas sécurisées")} (HTTPS)`,
    summary: "Ces pages sont servies en http:// et non en https://. Les navigateurs les signalent comme « non sécurisées ».",
    why: "Google favorise les pages en HTTPS, et l'avertissement « non sécurisé » du navigateur fait fuir les visiteurs, surtout au moment de payer ou de remplir un formulaire.",
    steps: () => [
      "Activez le certificat de sécurité (SSL, souvent gratuit avec Let's Encrypt) dans l'espace client de votre hébergeur.",
      "Activez ensuite la redirection automatique de http:// vers https:// pour tout le site.",
      "Vérifiez que les liens internes pointent vers les adresses en https://.",
    ],
    scope: "site",
    action: (c) => `Passer ${pagesTxt(c.affected)} en HTTPS`,
    strength: { title: "Les pages sont sécurisées (HTTPS)", most: "Presque toutes les pages sont sécurisées (HTTPS)", detail: (p, t) => `${allPass(p, t)} sont servies en HTTPS.` },
  },
  indexable: {
    title: (c) => `${n(c.affected, "page demande", "pages demandent")} à ne pas apparaître dans Google`,
    summary: "Ces pages contiennent la consigne « noindex » : elles demandent explicitement à Google de ne pas les afficher dans ses résultats.",
    why: "Tant que cette consigne est présente, aucune autre amélioration ne sert : la page n'apparaîtra pas dans Google. Elle est parfois laissée par erreur après la mise en ligne, ou cochée dans une extension SEO.",
    steps: () => [
      "Vérifiez d'abord que ces pages doivent bien apparaître dans Google (une page de remerciement ou de compte peut rester masquée).",
      "Dans votre extension SEO ou les réglages de la page, décochez « Masquer des moteurs de recherche » / « noindex ».",
      "Sur WordPress, vérifiez aussi Réglages > Lecture : la case « Demander aux moteurs de recherche de ne pas indexer ce site » doit être décochée.",
    ],
    snippet: (c) => ({
      language: "html",
      code: `<!-- À supprimer du <head> de la page -->\n<meta name="robots" content="noindex">`,
    }),
    scope: "site",
    action: (c) => `Retirer la consigne noindex de ${pagesTxt(c.affected)}`,
    strength: { title: "Les pages peuvent apparaître dans Google", most: "Presque toutes les pages peuvent apparaître dans Google", detail: (p, t) => `${allPass(p, t)} n'ont aucune consigne noindex.` },
  },
  charset: {
    title: (c) => `L'encodage des caractères n'est pas déclaré sur ${pagesTxt(c.affected)}`,
    summary: "Sans déclaration d'encodage, les lettres accentuées peuvent s'afficher sous forme de symboles étranges (Ã©, �).",
    why: "Des caractères cassés donnent une impression de site négligé, dans la page comme dans le titre affiché par Google.",
    steps: () => [headStep.replace("Collez ce code", "Collez ce code tout en haut"), "Enregistrez vos fichiers au format UTF-8."],
    snippet: () => ({ language: "html", code: '<meta charset="utf-8">' }),
    scope: "site",
    action: (c) => `Déclarer l'encodage sur ${pagesTxt(c.affected)}`,
    strength: { title: "L'encodage des caractères est déclaré", most: "L'encodage est déclaré sur presque toutes les pages", detail: (p, t) => `${allPass(p, t)} déclarent leur encodage.` },
  },
  structured_data: {
    title: (c) =>
      c.failing === c.affected ? `${n(c.affected, "page n'a", "pages n'ont")} pas de données structurées` : `Les données structurées sont incomplètes ou illisibles sur ${pagesTxt(c.affected)}`,
    summary: "Les données structurées décrivent la page à Google dans un format qu'il lit directement (entreprise, produit, prix, avis, horaires).",
    why: "Elles permettent à Google d'afficher des résultats enrichis : étoiles d'avis, prix, disponibilité, horaires. Ces résultats attirent l'œil et sont plus cliqués. Un bloc mal écrit est ignoré.",
    steps: (c) => [
      "Installez ou activez une extension SEO qui génère les données structurées (la plupart le font pour les produits et l'entreprise).",
      "À défaut, adaptez le modèle ci-dessous et collez-le dans l'en-tête (<head>) de la page d'accueil. Pour une boutique ou un commerce local, remplacez Organization par le type adapté (Product, LocalBusiness).",
      "Vérifiez le résultat avec l'outil gratuit « Test des résultats enrichis » de Google.",
    ],
    snippet: (c) => {
      if (!c.sample) return null;
      const o = origin(c.sample.url);
      const json = { "@context": "https://schema.org", "@type": "Organization", name: cut(c.sample.siteName, 80), url: o };
      return { language: "html", code: `<script type="application/ld+json">\n${JSON.stringify(json, null, 2).replace(/</g, "\\u003c")}\n</script>` };
    },
    scope: "mixed",
    action: (c) => `Ajouter des données structurées sur ${pagesTxt(c.affected)}`,
    strength: { title: "Les pages décrivent leur contenu à Google", most: "Presque toutes les pages décrivent leur contenu à Google", detail: (p, t) => `${allPass(p, t)} contiennent des données structurées valides.` },
  },
  blocking_scripts: {
    title: (c) => `Des scripts retardent l'affichage de ${pagesTxt(c.affected)}`,
    summary: "Certains scripts placés en haut de la page doivent être téléchargés avant que quoi que ce soit s'affiche : la page paraît lente.",
    why: "La vitesse d'affichage compte pour Google et surtout pour les visiteurs : au-delà de quelques secondes, beaucoup repartent. Ajouter « defer » laisse la page s'afficher pendant que le script se charge.",
    steps: () => [
      "Repérez les scripts du <head> qui ne sont pas indispensables au premier affichage (statistiques, chat, widgets).",
      "Ajoutez-leur l'attribut defer, ou activez l'option « Différer le JavaScript » de votre extension de performance.",
      "Vérifiez ensuite que le site fonctionne toujours (menus, panier, formulaires).",
    ],
    snippet: (c) => {
      const src = c.sample?.facts.blockingScripts[0];
      return src ? { language: "html", code: `<script src="${attr(src)}" defer></script>` } : null;
    },
    snippetFromPage: true,
    scope: "site",
    action: (c) => `Différer les scripts bloquants sur ${pagesTxt(c.affected)}`,
    strength: { title: "Les scripts ne retardent pas l'affichage", most: "Les scripts ne retardent pas l'affichage de presque toutes les pages", detail: (p, t) => `${allPass(p, t)} ont au plus deux scripts bloquants.` },
  },
  image_alt: {
    title: (c) => `Des images n'ont pas de texte alternatif sur ${pagesTxt(c.affected)}`,
    summary: "Le texte alternatif décrit une image à Google et aux personnes malvoyantes. Sans lui, l'image ne peut pas ressortir dans Google Images.",
    why: "Google ne « voit » pas les images : il lit leur texte alternatif. C'est aussi une obligation d'accessibilité, lue à voix haute par les lecteurs d'écran.",
    steps: () => [
      "Ouvrez la médiathèque de votre site (ou la fiche produit) et cliquez sur chaque image concernée.",
      "Remplissez le champ « Texte alternatif » avec une courte description de ce que montre l'image (ex. « Bol en grès émaillé bleu »).",
      "Les images purement décoratives peuvent garder un texte alternatif vide.",
    ],
    snippet: (c) => {
      const src = c.sample?.facts.imagesWithoutAlt[0];
      return src ? { language: "html", code: `<img src="${attr(src)}" alt="Décrivez ici ce que montre l'image">` } : null;
    },
    snippetFromPage: true,
    scope: "page",
    action: (c) => `Décrire les images de ${pagesTxt(c.affected)}`,
    strength: { title: "Les images sont décrites", most: "Les images sont décrites sur presque toutes les pages", detail: (p, t) => `${allPass(p, t)} ont un texte alternatif sur toutes leurs images.` },
  },
  image_dimensions: {
    title: (c) => `Des images ne sont pas optimisées sur ${pagesTxt(c.affected)}`,
    summary: "Les images sans dimensions ni chargement différé font « sauter » la page pendant son affichage et la ralentissent.",
    why: "Indiquer la largeur et la hauteur réserve la place de l'image ; le chargement différé (loading=\"lazy\") ne télécharge les images qu'au moment où le visiteur s'en approche. Les deux améliorent la vitesse mesurée par Google.",
    steps: () => [
      "Activez l'option « Chargement différé des images » (lazy loading) de votre thème ou de votre extension de performance.",
      "Sur un site codé à la main, ajoutez width, height ou loading=\"lazy\" à chaque balise <img>.",
    ],
    snippet: (c) => {
      const src = c.sample?.facts.firstImage;
      return src ? { language: "html", code: `<img src="${attr(src)}" loading="lazy" alt="…">` } : null;
    },
    snippetFromPage: true,
    scope: "site",
    action: (c) => `Activer le chargement différé des images sur ${pagesTxt(c.affected)}`,
    strength: { title: "Les images sont optimisées", most: "Les images sont optimisées sur presque toutes les pages", detail: (p, t) => `${allPass(p, t)} précisent les dimensions ou le chargement différé de leurs images.` },
  },
  internal_links: {
    title: (c) => `${n(c.affected, "page a", "pages ont")} trop peu de liens vers le reste du site`,
    summary: "Les liens entre vos pages guident les visiteurs et aident Google à découvrir vos pages et à comprendre lesquelles sont importantes.",
    why: "Une page qui ne renvoie vers aucune autre est une impasse : le visiteur repart, et Google transmet moins de popularité à vos pages importantes.",
    steps: () => [
      "Dans le texte de chaque page concernée, ajoutez au moins trois liens vers des pages liées (catégorie, produits proches, page contact).",
      "Utilisez comme texte de lien les mots qui décrivent la page visée.",
    ],
    scope: "page",
    action: (c) => `Ajouter des liens internes sur ${pagesTxt(c.affected)}`,
    strength: { title: "Les pages sont bien reliées entre elles", most: "Presque toutes les pages sont bien reliées entre elles", detail: (p, t) => `${allPass(p, t)} ont au moins trois liens internes.` },
  },
  link_text: {
    title: (c) => `Des liens sont vides ou vagues sur ${pagesTxt(c.affected)}`,
    summary: "Des liens n'ont pas de texte, ou un texte comme « cliquez ici » ou « en savoir plus » qui ne dit pas où ils mènent.",
    why: "Google utilise le texte des liens pour comprendre le sujet de la page visée, et les lecteurs d'écran le lisent seul. « En savoir plus » répété dix fois n'apprend rien à personne.",
    steps: () => [
      "Remplacez les textes génériques par une description de la page visée (ex. « Voir nos cours de poterie » au lieu de « En savoir plus »).",
      "Pour une icône ou une image cliquable, ajoutez un texte alternatif ou un attribut aria-label qui décrit la destination.",
    ],
    snippet: (c) => {
      const href = c.sample?.facts.vagueLinks[0];
      return href ? { language: "html", code: `<a href="${attr(href)}">Décrivez ici la page visée</a>` } : null;
    },
    snippetFromPage: true,
    scope: "mixed",
    action: (c) => `Rendre explicites les liens de ${pagesTxt(c.affected)}`,
    strength: { title: "Les liens disent où ils mènent", most: "Les liens disent où ils mènent sur presque toutes les pages", detail: (p, t) => `${allPass(p, t)} n'ont aucun lien vide ou vague.` },
  },
  open_graph: {
    title: (c) => `L'aperçu lors d'un partage est incomplet sur ${pagesTxt(c.affected)}`,
    summary: "Les balises Open Graph choisissent le titre, le texte et l'image affichés quand une page est partagée sur Facebook, LinkedIn, WhatsApp ou Slack.",
    why: "Sans elles, le réseau social devine : l'aperçu peut être sans image ou avec un visuel au hasard. Un aperçu soigné est beaucoup plus cliqué.",
    steps: (c) => [
      "Activez les réglages « Réseaux sociaux » / « Open Graph » de votre extension SEO ou de votre thème : ils remplissent ces balises pour toutes les pages.",
      "À défaut, collez le code ci-dessous dans l'en-tête (<head>) de la page et adaptez-le.",
      c.sample && !(c.sample.facts.og.image || c.sample.facts.firstImage)
        ? "Remplacez l'adresse de l'image par un visuel de 1200 × 630 pixels hébergé sur votre site."
        : "Idéalement, utilisez une image de 1200 × 630 pixels.",
    ],
    snippet: (c) => {
      if (!c.sample) return null;
      const f = c.sample.facts;
      const image = f.og.image || f.firstImage || `${origin(c.sample.url)}/apercu-1200x630.jpg`;
      const t = f.og.title || f.title || f.h1[0] || c.sample.siteName;
      const d = f.og.description || f.description || trimWords(f.excerpt.replace(/…$/, ""), 155);
      return {
        language: "html",
        code: [
          '<meta property="og:type" content="website">',
          `<meta property="og:url" content="${attr(c.sample.url)}">`,
          `<meta property="og:title" content="${attr(t)}">`,
          `<meta property="og:description" content="${attr(d)}">`,
          `<meta property="og:image" content="${attr(image)}">`,
        ].join("\n"),
      };
    },
    snippetFromPage: true,
    scope: "site",
    action: (c) => `Compléter l'aperçu de partage de ${pagesTxt(c.affected)}`,
    strength: { title: "Les pages s'affichent bien quand on les partage", most: "Presque toutes les pages s'affichent bien quand on les partage", detail: (p, t) => `${allPass(p, t)} ont un titre, un texte et une image de partage.` },
  },
  twitter_card: {
    title: (c) => `L'aperçu sur X (Twitter) n'est pas configuré sur ${pagesTxt(c.affected)}`,
    summary: "La balise twitter:card choisit la forme de l'aperçu quand une page est partagée sur X (Twitter).",
    why: "Avec cette balise, un lien partagé s'affiche avec une grande image et un titre au lieu d'un simple lien texte.",
    steps: () => [headStep],
    snippet: () => ({ language: "html", code: '<meta name="twitter:card" content="summary_large_image">' }),
    scope: "site",
    action: (c) => `Configurer l'aperçu X (Twitter) de ${pagesTxt(c.affected)}`,
    strength: { title: "L'aperçu sur X (Twitter) est configuré", most: "L'aperçu sur X (Twitter) est configuré sur presque toutes les pages", detail: (p, t) => `${allPass(p, t)} ont une balise twitter:card.` },
  },
  favicon: {
    title: (c) => `L'icône du site n'est pas déclarée sur ${pagesTxt(c.affected)}`,
    summary: "Le favicon est la petite icône affichée dans l'onglet du navigateur et à côté de votre résultat dans Google sur mobile.",
    why: "Une icône reconnaissable rend votre résultat plus visible dans Google et votre onglet plus facile à retrouver.",
    steps: () => [
      "Dans les réglages de votre site (souvent « Identité du site » ou « Logo »), ajoutez une icône carrée d'au moins 48 × 48 pixels.",
      "Sur un site codé à la main, déposez un fichier favicon.ico à la racine et collez le code ci-dessous dans le <head>.",
    ],
    snippet: () => ({ language: "html", code: '<link rel="icon" href="/favicon.ico" sizes="any">' }),
    scope: "site",
    action: (c) => `Déclarer l'icône du site sur ${pagesTxt(c.affected)}`,
    strength: { title: "L'icône du site est déclarée", most: "L'icône du site est déclarée sur presque toutes les pages", detail: (p, t) => `${allPass(p, t)} déclarent un favicon.` },
  },
};

/** Problèmes à l'échelle du site, hors grille : ils ne changent pas la note. */
export const DUPLICATES = {
  duplicate_title: {
    category: "balises" as const,
    title: (affected: number, groups: number) =>
      `${n(affected, "page partage", "pages partagent")} le même titre${groups > 1 ? ` (${groups} groupes)` : ""}`,
    summary: "Plusieurs pages portent exactement le même titre. Dans Google, elles se ressemblent et se font concurrence au lieu de se compléter.",
    why: "Le titre doit dire ce qui distingue chaque page. Quand plusieurs pages ont le même, Google a du mal à choisir laquelle montrer et l'internaute ne sait pas sur laquelle cliquer. Ce problème ne change pas la note sur 100, mais il compte pour votre visibilité.",
    steps: [
      "Ouvrez chacune des pages listées ci-dessous.",
      "Donnez-leur un titre propre qui dit ce qui les distingue (le produit, la catégorie, la ville…).",
      "Si deux pages présentent vraiment le même contenu, gardez-en une et redirigez l'autre vers elle.",
    ],
    action: (affected: number) => `Donner un titre unique à ${pagesTxt(affected)}`,
  },
  duplicate_description: {
    category: "balises" as const,
    title: (affected: number, groups: number) =>
      `${n(affected, "page partage", "pages partagent")} la même description${groups > 1 ? ` (${groups} groupes)` : ""}`,
    summary: "Plusieurs pages ont exactement la même description. Dans Google, leurs résultats se ressemblent et l'internaute ne sait pas laquelle choisir.",
    why: "Une description recopiée sur plusieurs pages vient souvent d'un réglage par défaut du thème. Google l'ignore alors souvent et choisit lui-même un extrait. Ce problème ne change pas la note sur 100, mais il compte pour les clics.",
    steps: [
      "Vérifiez si un réglage du thème ou de l'extension SEO remplit la même description partout ; si oui, videz-le.",
      "Rédigez pour chaque page listée une description propre de 120 à 155 caractères.",
    ],
    action: (affected: number) => `Écrire une description unique pour ${pagesTxt(affected)}`,
  },
};

const CODE_REFS: Array<[RegExp, string]> = [
  [/Collez ce code tout en haut/g, "Collez le code fourni dans le détail du problème tout en haut"],
  [/Collez ce code/g, "Collez le code fourni dans le détail du problème"],
  [/le code ci-dessous/g, "le code fourni dans le détail du problème"],
  [/le modèle ci-dessous/g, "le modèle fourni dans le détail du problème"],
  [/les pages listées ci-dessous/g, "les pages concernées, listées dans le détail du problème"],
  [/des pages listées ci-dessous/g, "des pages concernées, listées dans le détail du problème"],
];
const mentionsCode = (s: string) => /ce code|code ci-dessous|modèle ci-dessous/.test(s);

/** Étapes du détail d'un problème : sans code à copier, les étapes qui y renvoient sont retirées. */
export function issueSteps(steps: string[], hasSnippet: boolean): string[] {
  return hasSnippet ? steps : steps.filter((s) => !mentionsCode(s));
}

/** Étapes d'une recommandation (qui ne porte pas de code) : le renvoi pointe vers le détail du problème. */
export function recommendationSteps(steps: string[], hasSnippet: boolean): string[] {
  const kept = hasSnippet ? steps : steps.filter((s) => !mentionsCode(s));
  return kept.map((s) => CODE_REFS.reduce((acc, [re, rep]) => acc.replace(re, rep), s));
}

/** Effort d'un correctif : un réglage commun est rapide même sur 200 pages ; un travail page par page grandit avec le nombre de pages. */
export function effortFor(scope: Entry["scope"] | "page", affected: number): Effort {
  if (scope === "site") return "quick";
  if (scope === "mixed") return affected > 15 ? "medium" : "quick";
  if (affected <= 3) return "quick";
  if (affected <= 15) return "medium";
  return "heavy";
}

// ───────── Constats du catalogue (produits lus dans /products.json, pages non ouvertes)

const products = (k: number) => n(k, "produit", "produits");
const productsRead = (k: number) => n(k, "produit lu", "produits lus");
const shopifyProduct = "Dans l'administration Shopify, ouvrez « Produits », puis chacun des produits listés dans le détail du problème.";
const catalogueNote =
  "Ces produits ont été lus dans le catalogue de la boutique : leur page n'a pas été ouverte, et ce constat ne change pas la note sur 100.";

/** Seuils appliqués aux produits du catalogue. */
export const CATALOGUE_THRESHOLDS = {
  titleMin: 15,
  titleMax: 70,
  descMinWords: 50,
};

export interface CatalogueEntry {
  severity: "warning" | "info";
  category: "balises" | "contenu" | "medias";
  title(affected: number, groups?: number): string;
  summary: string;
  why: string;
  steps: string[];
  action(affected: number): string;
  /** Les doublons ont une recommandation d'impact « medium », comme ceux des pages. */
  duplicate?: true;
}

export const CATALOGUE_ISSUES: Record<
  "catalogue_title" | "catalogue_description" | "catalogue_image_alt" | "catalogue_duplicate_title" | "catalogue_duplicate_description",
  CatalogueEntry
> = {
  catalogue_title: {
    severity: "warning",
    category: "balises",
    title: (k) => `Le nom est trop court ou trop long sur ${productsRead(k)} dans le catalogue`,
    summary: `Sauf si un titre de référencement a été saisi pour le produit, Shopify se sert de son nom comme titre dans Google. Trop court, il ne dit pas ce qui est vendu ; trop long, il est coupé. ${catalogueNote}`,
    why: "Le titre est la ligne bleue cliquable dans Google : c'est le premier texte que l'internaute lit. Un nom de produit très court (« Bague Luna ») ne dit ni la matière ni la catégorie ; au-delà de 70 caractères, Google le coupe. Le thème ajoute souvent le nom de la boutique à la fin, ce qui laisse moins de place.",
    steps: [
      shopifyProduct,
      "En bas de la fiche, dans « Référencement naturel » (ou « Aperçu des résultats sur les moteurs de recherche »), cliquez sur « Modifier ».",
      "Écrivez un titre de 30 à 60 caractères : le type de produit, sa particularité (matière, couleur), puis la marque si la place le permet.",
      "Vous pouvez aussi allonger ou raccourcir le nom du produit lui-même s'il est affiché tel quel sur la boutique.",
    ],
    action: (k) => `Revoir le titre de ${products(k)}`,
  },
  catalogue_description: {
    severity: "warning",
    category: "contenu",
    title: (k) => `${n(k, "produit lu", "produits lus")} dans le catalogue ${k > 1 ? "ont" : "a"} une description absente ou trop courte`,
    summary: `La description est le texte qui présente le produit sur sa page. Absente ou de quelques mots, elle ne donne à Google presque rien à comprendre ni à montrer. ${catalogueNote}`,
    why: "Google classe une page d'après son texte. Une fiche produit sans description, ou avec une seule phrase, a peu de chances d'apparaître sur les recherches précises de vos clients (matière, usage, taille). Sans description de référencement saisie, Shopify reprend aussi le début de ce texte sous le titre dans Google.",
    steps: [
      shopifyProduct,
      "Dans le champ « Description », écrivez au moins 50 mots propres au produit : ce que c'est, la matière, les dimensions, l'usage, l'entretien.",
      "Évitez de recopier le même texte d'un produit à l'autre : chaque fiche doit dire ce qui la distingue.",
    ],
    action: (k) => `Rédiger une description pour ${products(k)}`,
  },
  catalogue_image_alt: {
    severity: "info",
    category: "medias",
    title: (k) => `Des images n'ont pas de texte alternatif sur ${productsRead(k)} dans le catalogue`,
    summary: `Le texte alternatif décrit une image à Google et aux personnes malvoyantes. Il n'est pas renseigné sur ces images dans les fiches produits ; certains thèmes affichent alors le nom du produit à la place. ${catalogueNote}`,
    why: "Google ne « voit » pas les images : il lit leur texte alternatif. Bien rempli, il permet aux photos de vos produits de ressortir dans Google Images, et il est lu à voix haute par les lecteurs d'écran.",
    steps: [
      shopifyProduct,
      "Cliquez sur chaque image du produit, puis sur « Ajouter un texte alternatif ».",
      "Décrivez en quelques mots ce que montre la photo (ex. « Bague en argent avec pierre de lune, vue de profil »).",
    ],
    action: (k) => `Décrire les images de ${products(k)}`,
  },
  catalogue_duplicate_title: {
    severity: "warning",
    category: "balises",
    duplicate: true,
    title: (k, g = 1) => `${n(k, "produit lu", "produits lus")} dans le catalogue ${k > 1 ? "portent" : "porte"} le même nom${g > 1 ? ` (${g} groupes)` : ""}`,
    summary: `Plusieurs produits ont exactement le même nom. Dans Google, leurs pages se ressemblent et se font concurrence. ${catalogueNote}`,
    why: "Quand plusieurs fiches portent le même nom, Google a du mal à choisir laquelle montrer, et l'internaute ne sait pas sur laquelle cliquer. Précisez ce qui les distingue : la couleur, la taille, la matière.",
    steps: [
      shopifyProduct,
      "Ajoutez au nom (ou au titre de référencement) ce qui distingue chaque produit : couleur, taille, matière, modèle.",
      "Si ce sont des déclinaisons d'un même article, regroupez-les en un seul produit avec des variantes.",
    ],
    action: (k) => `Donner un nom unique à ${products(k)}`,
  },
  catalogue_duplicate_description: {
    severity: "warning",
    category: "contenu",
    duplicate: true,
    title: (k, g = 1) => `${n(k, "produit lu", "produits lus")} dans le catalogue ${k > 1 ? "partagent" : "partage"} la même description${g > 1 ? ` (${g} groupes)` : ""}`,
    summary: `Plusieurs produits ont exactement le même texte de description. Google voit alors des pages presque identiques et n'en met souvent qu'une en avant. ${catalogueNote}`,
    why: "Un texte recopié d'une fiche à l'autre n'apporte rien de nouveau à Google : il risque de n'afficher qu'une de ces pages. Une description propre à chaque produit aide aussi le client à choisir.",
    steps: [
      shopifyProduct,
      "Réécrivez la description de chacun : gardez au besoin un paragraphe commun (entretien, livraison), mais ajoutez ce qui est propre au produit.",
    ],
    action: (k) => `Écrire une description unique pour ${products(k)}`,
  },
};
