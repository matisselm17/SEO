/**
 * Grille de notation sur 100, portée fidèlement depuis la fonction `analyse` de reference/sonde-seo.html.
 * Mêmes critères, mêmes seuils, mêmes points (30 + 20 + 25 + 15 + 10). Seuls les identifiants
 * (rendus lisibles et stables) et les textes (vouvoiement, preuves `found` / `expected`) changent.
 *
 * Correspondance des identifiants du prototype :
 * title→title, desc→meta_description, h1→h1, hier→heading_hierarchy, canon→canonical, lang→lang,
 * words→word_count, align→title_h1_match, h2→h2_sections, uniq→description_distinct,
 * viewport→viewport, https→https, index→indexable, charset→charset, ld→structured_data,
 * js→blocking_scripts, alt→image_alt, imgperf→image_dimensions, inlinks→internal_links,
 * anchors→link_text, og→open_graph, tw→twitter_card, fav→favicon.
 *
 * Le HTML analysé est une donnée non fiable : il est seulement lu, jamais exécuté.
 */
import * as cheerio from "cheerio";
import type { CategoryId, CheckStatus, PageCheck } from "../../../shared/api.ts";

export const CATEGORIES: Array<{ id: CategoryId; label: string; max: number }> = [
  { id: "balises", label: "Balises", max: 30 },
  { id: "contenu", label: "Contenu", max: 20 },
  { id: "technique", label: "Technique", max: 25 },
  { id: "medias", label: "Liens et images", max: 15 },
  { id: "partage", label: "Partage social", max: 10 },
];

/** Définition fixe de chaque critère (ordre de la grille). */
export const CRITERIA: Array<{ id: string; category: CategoryId; label: string; max: number }> = [
  { id: "title", category: "balises", label: "Titre de la page", max: 8 },
  { id: "meta_description", category: "balises", label: "Description", max: 7 },
  { id: "h1", category: "balises", label: "Titre principal (H1)", max: 6 },
  { id: "heading_hierarchy", category: "balises", label: "Hiérarchie des titres", max: 4 },
  { id: "canonical", category: "balises", label: "Adresse de référence (canonique)", max: 3 },
  { id: "lang", category: "balises", label: "Langue déclarée", max: 2 },
  { id: "word_count", category: "contenu", label: "Volume de texte", max: 8 },
  { id: "title_h1_match", category: "contenu", label: "Titre et H1 cohérents", max: 4 },
  { id: "h2_sections", category: "contenu", label: "Sections (H2)", max: 4 },
  { id: "description_distinct", category: "contenu", label: "Description distincte du titre", max: 4 },
  { id: "viewport", category: "technique", label: "Affichage mobile", max: 6 },
  { id: "https", category: "technique", label: "Connexion sécurisée (HTTPS)", max: 4 },
  { id: "indexable", category: "technique", label: "Page visible dans Google", max: 6 },
  { id: "charset", category: "technique", label: "Encodage des caractères", max: 2 },
  { id: "structured_data", category: "technique", label: "Données structurées", max: 5 },
  { id: "blocking_scripts", category: "technique", label: "Scripts qui retardent l'affichage", max: 2 },
  { id: "image_alt", category: "medias", label: "Texte alternatif des images", max: 6 },
  { id: "image_dimensions", category: "medias", label: "Images optimisées", max: 3 },
  { id: "internal_links", category: "medias", label: "Liens vers d'autres pages du site", max: 3 },
  { id: "link_text", category: "medias", label: "Textes des liens", max: 3 },
  { id: "open_graph", category: "partage", label: "Aperçu lors d'un partage (Open Graph)", max: 6 },
  { id: "twitter_card", category: "partage", label: "Carte X / Twitter", max: 2 },
  { id: "favicon", category: "partage", label: "Icône du site (favicon)", max: 2 },
];
export const CRITERIA_BY_ID = new Map(CRITERIA.map((c) => [c.id, c]));

const GENERIC = ["cliquez ici", "cliquer ici", "ici", "lire la suite", "en savoir plus", "voir plus", "click here", "read more", "learn more", "here", "more"];

export const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const quote = (s: string, n = 80) => "« " + cut(s, n) + " »";
const plural = (n: number, one: string, many: string) => (n > 1 ? many : one);

/** Faits relevés sur la page, utiles aux preuves, aux correctifs et à l'assistant. */
export interface PageFacts {
  title: string;
  description: string;
  h1: string[];
  h2: string[];
  canonical: string;
  lang: string;
  words: number;
  /** Début du texte lisible, pour l'aperçu Google et les brouillons de description. */
  excerpt: string;
  noindex: boolean;
  og: { title: string; description: string; image: string };
  siteName: string;
  twitterCard: string;
  images: number;
  imagesWithoutAlt: string[];
  firstImage: string;
  internalLinks: number;
  externalLinks: number;
  vagueLinks: string[];
  blockingScripts: string[];
  jsonLdTypes: string[];
  jsonLdInvalid: number;
}

export interface PageAnalysis {
  checks: PageCheck[];
  score: number;
  categories: Array<{ id: CategoryId; score: number; max: number }>;
  facts: PageFacts;
  /** Toutes les adresses des liens (résolues), pour la découverte des pages. */
  links: string[];
}

export function analysePage(html: string, url: string): PageAnalysis {
  const $ = cheerio.load(html);
  const meta = (n: string) => ($(`meta[name="${n}" i]`).first().attr("content") ?? "").trim();
  const prop = (n: string) => ($(`meta[property="${n}" i]`).first().attr("content") ?? "").trim();
  const checks: PageCheck[] = [];
  const add = (id: string, got: number, found: string | null, expected: string, message: string) => {
    const def = CRITERIA_BY_ID.get(id)!;
    const points = Math.max(0, Math.min(def.max, Math.round(got)));
    const status: CheckStatus = points === def.max ? "pass" : points === 0 ? "fail" : "warn";
    checks.push({ id, category: def.category, label: def.label, status, points, max: def.max, found, expected, message });
  };
  const squash = (s: string) => s.replace(/\s+/g, " ").trim();

  const title = squash($("title").first().text());
  const desc = meta("description");
  const heads = $("h1,h2,h3,h4,h5,h6")
    .toArray()
    .map((h) => ({ l: Number((h as { tagName: string }).tagName[1]), t: squash($(h).text()) }));
  const h1 = heads.filter((h) => h.l === 1);
  const h2 = heads.filter((h) => h.l === 2);
  const canonical = ($('link[rel~="canonical" i]').first().attr("href") ?? "").trim();
  const lang = ($("html").first().attr("lang") ?? "").trim();
  const body = $("body").first().clone();
  body.find("script,style,noscript,svg,template").remove();
  const text = squash(body.text());
  const words = text ? text.split(" ").filter((w) => /[\p{L}\p{N}]/u.test(w)).length : 0;

  // ── Balises (30)
  const tl = title.length;
  add(
    "title",
    !tl ? 0 : tl >= 30 && tl <= 60 ? 8 : tl >= 15 && tl <= 70 ? 5 : 3,
    tl ? `${quote(title)} (${tl} caractères)` : "Aucun titre",
    "Entre 30 et 60 caractères",
    !tl
      ? "Aucun titre. C'est la ligne bleue affichée dans Google : la page part avec un handicap majeur."
      : tl > 60
        ? `Le titre fait ${tl} caractères. Google le coupe vers 60 : placez l'essentiel au début.`
        : tl < 30
          ? `Le titre fait ${tl} caractères. Vous avez de la place pour préciser l'offre et le lieu (visez 30 à 60).`
          : `Le titre fait ${tl} caractères, dans la bonne fourchette.`,
  );
  const dl = desc.length;
  add(
    "meta_description",
    !dl ? 0 : dl >= 70 && dl <= 160 ? 7 : 4,
    dl ? `Description de ${dl} caractères` : "Aucune description",
    "Entre 70 et 160 caractères",
    !dl
      ? "Aucune description. Google choisira lui-même un extrait, rarement le plus vendeur."
      : dl > 160
        ? `La description fait ${dl} caractères. Au-delà de 160 environ, elle est coupée dans Google.`
        : dl < 70
          ? `La description fait ${dl} caractères. Développez-la (70 à 160) : bénéfice, preuve, invitation à cliquer.`
          : `La description fait ${dl} caractères, dans la bonne fourchette.`,
  );
  add(
    "h1",
    h1.length === 1 ? 6 : h1.length > 1 ? 3 : 0,
    h1.length === 0 ? "Aucun H1" : h1.length === 1 ? `Un H1 : ${quote(h1[0].t, 70)}` : `${h1.length} H1 : ${h1.slice(0, 3).map((h) => quote(h.t, 40)).join(", ")}`,
    "Un seul H1",
    h1.length === 1
      ? `Un seul titre principal : ${quote(h1[0].t, 70)}.`
      : h1.length > 1
        ? `${h1.length} titres principaux (H1) sur la page. Gardez-en un seul et passez les autres en H2.`
        : "Aucun titre principal (H1). Ajoutez un titre qui annonce le sujet de la page.",
  );
  let jump: { from: number; to: number } | null = null;
  for (let i = 1; i < heads.length; i++) if (heads[i].l - heads[i - 1].l > 1 && !jump) jump = { from: heads[i - 1].l, to: heads[i].l };
  add(
    "heading_hierarchy",
    (h2.length ? 2 : 0) + (!jump && heads.length ? 2 : 0),
    !heads.length
      ? "Aucun titre H1 à H6"
      : [`${heads.length} ${plural(heads.length, "titre", "titres")}, ${h2.length} H2`, jump ? `saut de H${jump.from} à H${jump.to}` : null].filter(Boolean).join(", "),
    "Des H2, et des niveaux qui s'enchaînent sans saut",
    !heads.length
      ? "Aucun titre H1 à H6 dans la page."
      : jump
        ? `Des niveaux sont sautés (un H${jump.to} juste après un H${jump.from}). Les titres doivent s'emboîter dans l'ordre.`
        : !h2.length
          ? "Pas de H2 : le contenu n'est pas découpé en sections."
          : `${heads.length} titres, emboîtés dans l'ordre.`,
  );
  // Écart assumé avec le prototype : la canonique ne compte que si elle pointe, en http(s), vers le même site.
  let canonicalOk = false;
  if (canonical) {
    try {
      const cu = new URL(canonical, url);
      const host = (h: string) => h.toLowerCase().replace(/^www\./, "");
      canonicalOk = (cu.protocol === "http:" || cu.protocol === "https:") && host(cu.hostname) === host(new URL(url).hostname);
    } catch {
      canonicalOk = false;
    }
  }
  add(
    "canonical",
    canonicalOk ? 3 : 0,
    canonical ? (canonicalOk ? cut(canonical, 120) : `Adresse canonique invalide : ${cut(canonical, 100)}`) : "Aucune adresse canonique",
    "Une balise canonical vers une adresse http(s) du même site",
    canonicalOk
      ? `Adresse de référence déclarée : ${cut(canonical, 80)}`
      : canonical
        ? "La balise canonical pointe vers une adresse qui n'est pas une page web de ce site : Google l'ignorera ou, pire, suivra l'autre site."
        : "Pas de balise canonical. Elle évite que des variantes d'adresse (paramètres, slash final) se fassent concurrence.",
  );
  add(
    "lang",
    lang ? 2 : 0,
    lang ? `lang="${cut(lang, 20)}"` : "Aucune langue déclarée",
    "Un attribut lang sur la balise html",
    lang ? `Langue : ${cut(lang, 20)}.` : "L'attribut lang manque sur la balise html.",
  );

  // ── Contenu (20)
  add(
    "word_count",
    words >= 300 ? 8 : words >= 150 ? 5 : words >= 50 ? 2 : 0,
    `${words} ${plural(words, "mot", "mots")}`,
    "Au moins 300 mots",
    `${words} ${plural(words, "mot lisible", "mots lisibles")}. ` +
      (words >= 300 ? "Assez de matière pour se positionner." : "Visez au moins 300 mots utiles sur une page qui doit se classer."),
  );
  const sig = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3);
  const h1Sig = sig(h1.map((h) => h.t).join(" "));
  const common = title && h1.length ? sig(title).filter((w) => h1Sig.includes(w)) : [];
  add(
    "title_h1_match",
    common.length ? 4 : 0,
    !title || !h1.length ? (!title ? "Pas de titre" : "Pas de H1") : common.length ? `Mots communs : ${[...new Set(common)].slice(0, 3).join(", ")}` : "Aucun mot en commun",
    "Le titre et le H1 partagent des mots clés",
    !title || !h1.length
      ? "Impossible à vérifier sans titre de page et sans H1."
      : common.length
        ? `Le titre et le H1 partagent les mêmes termes (${[...new Set(common)].slice(0, 3).join(", ")}).`
        : "Le titre et le H1 ne partagent aucun mot clé. Ils doivent annoncer le même sujet.",
  );
  add(
    "h2_sections",
    h2.length >= 2 ? 4 : h2.length === 1 ? 2 : 0,
    `${h2.length} ${plural(h2.length, "section H2", "sections H2")}`,
    "Au moins 2 sections H2",
    h2.length >= 2
      ? `${h2.length} sections H2.`
      : "Découpez le texte en au moins deux sections H2 qui reprennent les questions de vos clients.",
  );
  const same = !!desc && !!title && desc.toLowerCase() === title.toLowerCase();
  add(
    "description_distinct",
    desc && !same ? 4 : 0,
    !desc ? "Pas de description" : same ? "La description est identique au titre" : "Description différente du titre",
    "Une description qui complète le titre",
    !desc ? "Pas de description à comparer." : same ? "La description recopie le titre. Elle doit le compléter." : "La description complète le titre.",
  );

  // ── Technique (25)
  const viewport = meta("viewport");
  add(
    "viewport",
    viewport ? 6 : 0,
    viewport ? "Balise viewport présente" : "Aucune balise viewport",
    "Balise viewport présente",
    viewport
      ? "La page s'adapte aux téléphones."
      : "Pas de balise viewport : la page s'affichera en version ordinateur réduite sur téléphone, ce que Google pénalise.",
  );
  const https = /^https:\/\//i.test(url);
  add(
    "https",
    https ? 4 : url ? 0 : 2,
    https ? "Adresse en https://" : "Adresse en http://",
    "Adresse en https://",
    https ? "Adresse en HTTPS." : "L'adresse n'est pas en HTTPS. Activez le certificat de sécurité (SSL) chez votre hébergeur.",
  );
  const robots = (meta("robots") + " " + meta("googlebot")).toLowerCase();
  const noindex = robots.includes("noindex");
  add(
    "indexable",
    noindex ? 0 : 6,
    noindex ? `Consigne robots : « ${cut(robots.trim(), 60)} »` : "Aucune consigne noindex",
    "Aucune consigne noindex",
    noindex ? "La page contient noindex : elle demande à Google de ne pas l'afficher dans les résultats." : "Aucune consigne noindex.",
  );
  const charset = $("meta[charset]").length > 0 || $('meta[http-equiv="content-type" i]').length > 0;
  add(
    "charset",
    charset ? 2 : 0,
    charset ? "Encodage déclaré" : "Aucun encodage déclaré",
    'Une balise <meta charset="utf-8">',
    charset ? "Encodage déclaré." : "Pas de meta charset : risque de caractères accentués cassés.",
  );
  const ld = $('script[type="application/ld+json" i]').toArray();
  let ldOk = 0;
  const types: string[] = [];
  for (const s of ld) {
    try {
      const j = JSON.parse($(s).text());
      ldOk++;
      const items = ([] as unknown[]).concat((j && (j as Record<string, unknown>)["@graph"]) || j);
      for (const o of items) {
        const t = o && typeof o === "object" ? (o as Record<string, unknown>)["@type"] : undefined;
        if (t) types.push(([] as unknown[]).concat(t).map(String).join("/"));
      }
    } catch {
      /* bloc illisible, compté plus bas */
    }
  }
  const uniqTypes = [...new Set(types)];
  add(
    "structured_data",
    !ld.length ? 0 : ldOk === ld.length ? 5 : 2,
    !ld.length
      ? "Aucun bloc JSON-LD"
      : ldOk < ld.length
        ? `${ld.length - ldOk} ${plural(ld.length - ldOk, "bloc illisible", "blocs illisibles")} sur ${ld.length}`
        : `JSON-LD valide${uniqTypes.length ? " : " + uniqTypes.slice(0, 5).join(", ") : ""}`,
    "Des données structurées JSON-LD valides",
    !ld.length
      ? "Aucun bloc JSON-LD. Les données structurées permettent les résultats enrichis (avis, prix, horaires)."
      : ldOk < ld.length
        ? `${ld.length - ldOk} bloc(s) JSON-LD illisible(s) : erreur de syntaxe.`
        : "JSON-LD valide" + (uniqTypes.length ? " : " + uniqTypes.slice(0, 5).join(", ") + "." : "."),
  );
  const blockingEls = $("head script[src]")
    .toArray()
    .filter((s) => {
      const el = $(s);
      return el.attr("async") === undefined && el.attr("defer") === undefined && el.attr("type") !== "module";
    });
  const blocking = blockingEls.length;
  add(
    "blocking_scripts",
    blocking <= 2 ? 2 : blocking <= 4 ? 1 : 0,
    `${blocking} ${plural(blocking, "script bloquant", "scripts bloquants")} dans le head`,
    "2 scripts bloquants au plus",
    `${blocking} script(s) dans le head sans async ni defer.` + (blocking > 2 ? " Ils retardent l'affichage." : ""),
  );

  // ── Liens et images (15)
  const imgs = $("img").toArray();
  const noAlt = imgs.filter((i) => !($(i).attr("alt") ?? "").trim());
  add(
    "image_alt",
    imgs.length ? 6 * (1 - noAlt.length / imgs.length) : 6,
    !imgs.length ? "Aucune image" : `${noAlt.length} ${plural(noAlt.length, "image", "images")} sans texte alternatif sur ${imgs.length}`,
    "Toutes les images ont un texte alternatif",
    !imgs.length
      ? "Aucune image dans la page."
      : noAlt.length
        ? `${noAlt.length} image(s) sur ${imgs.length} sans texte alternatif.`
        : `Les ${imgs.length} images ont un texte alternatif.`,
  );
  const sized = imgs.filter((i) => {
    const el = $(i);
    return (el.attr("width") !== undefined && el.attr("height") !== undefined) || el.attr("loading") !== undefined;
  }).length;
  add(
    "image_dimensions",
    imgs.length ? (3 * sized) / imgs.length : 3,
    !imgs.length ? "Aucune image" : `${sized} ${plural(sized, "image", "images")} sur ${imgs.length} avec dimensions ou chargement différé`,
    "Dimensions ou chargement différé sur chaque image",
    !imgs.length ? "Aucune image à vérifier." : `${sized} image(s) sur ${imgs.length} avec dimensions ou chargement différé.`,
  );
  let base: URL | null = null;
  try {
    base = new URL(url);
  } catch {
    base = null;
  }
  const anchors = $("a[href]")
    .toArray()
    .filter((a) => !/^(#|mailto:|tel:|javascript:)/i.test(($(a).attr("href") ?? "").trim()));
  const inUrls: string[] = [];
  const allLinks: string[] = [];
  for (const a of anchors) {
    try {
      const u = new URL(($(a).attr("href") ?? "").trim(), base ?? "https://page.invalid/");
      allLinks.push(u.href);
      if (u.host === (base ? base.host : "page.invalid")) {
        u.hash = "";
        inUrls.push(u.href);
      }
    } catch {
      /* lien mal formé ignoré */
    }
  }
  const internal = inUrls.length;
  add(
    "internal_links",
    internal >= 3 ? 3 : internal >= 1 ? 1 : 0,
    `${internal} ${plural(internal, "lien interne", "liens internes")}, ${anchors.length - internal} ${plural(anchors.length - internal, "lien externe", "liens externes")}`,
    "Au moins 3 liens vers d'autres pages du site",
    `${internal} lien(s) vers d'autres pages du site` +
      (internal < 3 ? ". Ajoutez-en vers vos pages importantes." : `, ${anchors.length - internal} vers l'extérieur.`),
  );
  const vagueEls = anchors.filter((a) => {
    const el = $(a);
    const t = (squash(el.text()) || el.attr("aria-label") || el.find("img").first().attr("alt") || "").trim().toLowerCase();
    return !t || GENERIC.includes(t);
  });
  const vague = vagueEls.length;
  add(
    "link_text",
    vague === 0 ? 3 : vague <= 2 ? 2 : 0,
    vague ? `${vague} ${plural(vague, "lien vide ou vague", "liens vides ou vagues")}` : "Tous les liens ont un texte descriptif",
    "Chaque lien décrit la page visée",
    vague
      ? `${vague} lien(s) vide(s) ou du type « cliquez ici ». Le texte d'un lien doit décrire la page visée.`
      : "Tous les liens ont un texte descriptif.",
  );

  // ── Partage (10)
  const og = { title: prop("og:title"), description: prop("og:description"), image: prop("og:image") };
  const ogMiss = (Object.keys(og) as Array<keyof typeof og>).filter((k) => !og[k]);
  add(
    "open_graph",
    2 * (3 - ogMiss.length),
    ogMiss.length ? `Manquant : ${ogMiss.map((k) => "og:" + k).join(", ")}` : "og:title, og:description et og:image présentes",
    "og:title, og:description et og:image",
    ogMiss.length
      ? `Il manque : ${ogMiss.map((k) => "og:" + k).join(", ")}. Sans elles, le lien partagé s'affiche sans visuel soigné.`
      : "og:title, og:description et og:image présentes.",
  );
  const tw = meta("twitter:card");
  add(
    "twitter_card",
    tw ? 2 : 0,
    tw ? `twitter:card « ${cut(tw, 30)} »` : "Aucune balise twitter:card",
    "Une balise twitter:card",
    tw ? `twitter:card : ${cut(tw, 30)}.` : "Pas de balise twitter:card.",
  );
  const fav = $('link[rel~="icon" i]').length > 0;
  add(
    "favicon",
    fav ? 2 : 0,
    fav ? "Favicon déclaré" : "Aucun favicon déclaré",
    'Une balise <link rel="icon">',
    fav ? "Favicon déclaré." : "Pas de favicon déclaré : c'est la petite icône visible à côté du résultat dans Google sur mobile.",
  );

  const categories = CATEGORIES.map((c) => {
    const cs = checks.filter((k) => k.category === c.id);
    return { id: c.id, max: cs.reduce((a, k) => a + k.max, 0), score: cs.reduce((a, k) => a + k.points, 0) };
  });

  const firstImg = imgs.map((i) => ($(i).attr("src") ?? "").trim()).find(Boolean) ?? "";
  const resolve = (s: string) => {
    try {
      return new URL(s, base ?? undefined).href;
    } catch {
      return s;
    }
  };

  return {
    checks,
    categories,
    score: categories.reduce((a, c) => a + c.score, 0),
    links: allLinks,
    facts: {
      title,
      description: desc,
      h1: h1.map((h) => h.t),
      h2: h2.map((h) => h.t).slice(0, 20),
      canonical,
      lang,
      words,
      excerpt: cut(text, 400),
      noindex,
      og,
      siteName: prop("og:site_name") || meta("application-name"),
      twitterCard: tw,
      images: imgs.length,
      imagesWithoutAlt: noAlt.map((i) => ($(i).attr("src") ?? "").trim()).filter(Boolean).slice(0, 10).map(resolve),
      firstImage: firstImg ? resolve(firstImg) : "",
      internalLinks: internal,
      externalLinks: anchors.length - internal,
      vagueLinks: vagueEls.map((a) => ($(a).attr("href") ?? "").trim()).slice(0, 10),
      blockingScripts: blockingEls.map((s) => ($(s).attr("src") ?? "").trim()).slice(0, 10),
      jsonLdTypes: uniqTypes.slice(0, 10),
      jsonLdInvalid: ld.length - ldOk,
    },
  };
}
