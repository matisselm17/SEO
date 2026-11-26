/**
 * MODE DÉMONSTRATION (développement uniquement).
 * Fabrique des sites fictifs cohérents avec la grille : chaque page reçoit ses critères,
 * et tout le reste (note, problèmes, points positifs, recommandations) en est calculé.
 * Part des exemples de docs/exemples/exemples.json, étoffés.
 */
import type {
  CategoryId, CategoryScore, Competitor, CompetitorsData, Evidence, Issue, IssueDetail, OrganicPage, OrganicPoint, OrganicQuery,
  PageCheck, PageDetail, PageSummary, Recommendation, SearchConsoleData, Severity, Strength,
} from "../lib/types";
import { CATEGORY_LABELS, CRITERIA, type PageFacts } from "./criteria";

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface DemoPage {
  summary: PageSummary;
  detail: PageDetail;
}

export interface SiteProfile {
  host: string;
  seed: number;
  /** Probabilité d'échec par critère (0 à 1) ; les autres ont 5 %. */
  fail: Record<string, number>;
  paths: { path: string; title: string | null; h1: string; words: number }[];
}

const CAT_ORDER: CategoryId[] = ["balises", "contenu", "technique", "medias", "partage"];

export function buildPages(profile: SiteProfile, analyzedAt: string): DemoPage[] {
  const r = rng(profile.seed);
  return profile.paths.map((p, idx) => {
    const url = `https://${profile.host}${p.path === "/" ? "/" : p.path}`;
    const checks: PageCheck[] = [];
    const descFail = r() < (profile.fail.meta_description ?? 0.05);
    const descLen = descFail ? 0 : r() < 0.2 ? 210 + Math.floor(r() * 120) : 90 + Math.floor(r() * 60);
    const images = 2 + Math.floor(r() * 14);
    const imagesNoAlt = Math.floor(r() * images * 0.7);
    const facts: PageFacts = {
      url, path: p.path, title: p.title,
      description: descLen ? "x".repeat(descLen) : null,
      h1: [p.h1], words: p.words, images, imagesNoAlt,
    };
    for (const c of CRITERIA) {
      let status: "pass" | "warn" | "fail";
      const f = profile.fail[c.id] ?? 0.05;
      if (c.id === "title") {
        const tl = p.title?.length ?? 0;
        status = !tl ? "fail" : tl >= 30 && tl <= 60 ? "pass" : "warn";
      } else if (c.id === "meta_description") {
        status = !descLen ? "fail" : descLen <= 160 ? "pass" : "warn";
      } else if (c.id === "words") {
        status = p.words >= 300 ? "pass" : p.words >= 150 ? "warn" : "fail";
      } else if (c.id === "description_unique") {
        status = !descLen ? "fail" : r() < f ? "fail" : "pass";
      } else if (c.id === "image_alt") {
        status = imagesNoAlt === 0 ? "pass" : r() < f ? (imagesNoAlt > images / 2 ? "fail" : "warn") : "pass";
        if (status === "pass") facts.imagesNoAlt = 0;
      } else if (c.id === "https") {
        status = "pass";
      } else {
        const x = r();
        status = x < f ? (c.partial > 0 && x < f * 0.6 ? "warn" : "fail") : "pass";
      }
      if (c.id === "h1" && status === "warn") facts.h1 = [p.h1, "Questions fréquentes"];
      if (c.id === "h1" && status === "fail") facts.h1 = [];
      const points = status === "pass" ? c.max : status === "warn" ? c.partial || Math.round(c.max / 2) : 0;
      checks.push({
        id: c.id, category: c.category, label: c.label, status: status === "warn" && points === 0 ? "fail" : status,
        points, max: c.max, found: c.found(facts, status), expected: c.expected, message: c.message(facts, status),
      });
    }
    const score = checks.reduce((s, c) => s + c.points, 0);
    const descText = descLen
      ? `${p.h1} : ${["pièces tournées à la main dans notre atelier", "créations uniques en grès et porcelaine", "conseils, horaires et réservation en ligne"][idx % 3]}. Livraison soignée partout en France, retrait possible à l'atelier.`.slice(0, descLen > 160 ? 400 : 155)
      : null;
    const summary: PageSummary = {
      id: `pg_${idx + 1}`, url, path: p.path, title: p.title, httpStatus: 200, score,
      issues: checks.filter((c) => c.status !== "pass").length, words: p.words, organic: null,
    };
    const detail: PageDetail = {
      ...summary,
      description: descText,
      h1: facts.h1,
      canonical: checks.find((c) => c.id === "canonical")!.status === "pass" ? url : null,
      lang: checks.find((c) => c.id === "lang")!.status === "pass" ? "fr" : null,
      analyzedAt,
      checks,
      serpPreview: {
        url,
        title: p.title ? (p.title.length > 60 ? p.title.slice(0, 57).trimEnd() + "…" : p.title) : null,
        description: descText ? (descText.length > 155 ? descText.slice(0, 152).trimEnd() + "…" : descText) : null,
      },
      queries: null,
    };
    return { summary, detail };
  });
}

// ───────── Agrégats calculés à partir des pages

export function categoriesOf(pages: DemoPage[]): CategoryScore[] {
  return CAT_ORDER.map((id) => {
    const crits = CRITERIA.filter((c) => c.category === id);
    const max = crits.reduce((s, c) => s + c.max, 0);
    const total = pages.reduce((s, p) => s + p.detail.checks.filter((c) => c.category === id).reduce((a, c) => a + c.points, 0), 0);
    return { id, label: CATEGORY_LABELS[id], score: pages.length ? Math.round((total / pages.length) * 10) / 10 : 0, max };
  });
}

export function siteScore(pages: DemoPage[]): number | null {
  if (!pages.length) return null;
  return Math.round(pages.reduce((s, p) => s + p.summary.score, 0) / pages.length);
}

function severityOf(max: number, id: string, affected: number, total: number): Severity {
  if (id === "indexable") return "critical";
  if (max >= 6 && affected > total / 2) return "critical";
  if (max <= 2) return "info";
  return "warning";
}

export function issuesOf(pages: DemoPage[]): IssueDetail[] {
  const total = pages.length;
  const out: IssueDetail[] = [];
  for (const c of CRITERIA) {
    const failing = pages.filter((p) => p.detail.checks.find((k) => k.id === c.id)!.status !== "pass");
    if (!failing.length) continue;
    const lost = failing.reduce((s, p) => s + (c.max - p.detail.checks.find((k) => k.id === c.id)!.points), 0);
    const evidence: Evidence[] = failing
      .map((p) => ({ p, k: p.detail.checks.find((k) => k.id === c.id)! }))
      .sort((a, b) => a.k.points - b.k.points || (b.p.summary.organic?.clicks ?? 0) - (a.p.summary.organic?.clicks ?? 0))
      .slice(0, 200)
      .map(({ p, k }) => ({ pageId: p.summary.id, url: p.summary.url, path: p.summary.path, found: k.found, expected: k.expected }));
    out.push({
      id: c.id, category: c.category, severity: severityOf(c.max, c.id, failing.length, total),
      title: c.issueTitle(failing.length), summary: c.summary, pagesAffected: failing.length, pagesTotal: total, pointsLost: lost,
      why: c.why, fix: c.fix(pages[0]?.summary.url.replace(/^https:\/\//, "").replace(/\/.*$/, "") ?? "exemple.fr"), evidence,
    });
  }
  return out.sort((a, b) => b.pointsLost - a.pointsLost);
}

export function toIssue(d: IssueDetail): Issue {
  const { why: _w, fix: _f, evidence: _e, ...rest } = d;
  void _w; void _f; void _e;
  return rest;
}

export function strengthsOf(pages: DemoPage[]): Strength[] {
  const total = pages.length;
  if (!total) return [];
  const out: Strength[] = [];
  for (const c of CRITERIA) {
    const passing = pages.filter((p) => p.detail.checks.find((k) => k.id === c.id)!.status === "pass").length;
    if (passing / total >= 0.9) out.push({ id: c.id, category: c.category, title: c.strength.title, detail: c.strength.detail(passing), pagesPassing: passing, pagesTotal: total });
  }
  return out.sort((a, b) => (CRITERIA.find((c) => c.id === b.id)!.max - CRITERIA.find((c) => c.id === a.id)!.max));
}

export function recommendationsOf(issues: IssueDetail[]): Recommendation[] {
  const recs = issues.map((i) => {
    const c = CRITERIA.find((x) => x.id === i.id)!;
    const perPage = i.pointsLost / Math.max(1, i.pagesTotal);
    const impact = perPage >= 2.5 ? "high" : perPage >= 0.8 ? "medium" : "low";
    return {
      id: `rec_${i.id}`, issueId: i.id, title: c.recTitle(i.pagesAffected), impact, effort: c.effort,
      pagesAffected: i.pagesAffected, pointsToGain: i.pointsLost, rank: 0, steps: c.recSteps,
    } as Recommendation;
  });
  const effortW = { quick: 1, medium: 2, heavy: 3 } as const;
  recs.sort((a, b) => b.pointsToGain / effortW[b.effort] - a.pointsToGain / effortW[a.effort]);
  recs.forEach((r, i) => (r.rank = i + 1));
  return recs;
}

// ───────── Search Console

export function buildSearchConsole(pages: DemoPage[], seed: number, importedAt: string, opts: { queries: string[]; extraPages: { path: string; clicks: number; impressions: number; position: number }[]; host: string; clicksPerDay: number }): Extract<SearchConsoleData, { available: true }> {
  const r = rng(seed);
  const end = new Date(Date.UTC(2026, 10, 25));
  const series: OrganicPoint[] = [];
  for (let i = 90; i >= 0; i--) {
    const d = new Date(end.getTime() - i * 86400000);
    const dow = d.getUTCDay();
    const trend = 0.75 + (0.45 * (90 - i)) / 90;
    const weekly = dow === 0 || dow === 6 ? 0.72 : 1.06;
    const noise = 0.8 + r() * 0.4;
    const clicks = Math.round(opts.clicksPerDay * trend * weekly * noise);
    const impressions = Math.round(clicks * (28 + r() * 10));
    series.push({ date: d.toISOString().slice(0, 10), clicks, impressions });
  }
  // Les trois derniers jours des exemples
  const last = [{ clicks: 22, impressions: 701 }, { clicks: 31, impressions: 812 }, { clicks: 27, impressions: 764 }];
  if (opts.clicksPerDay < 40) last.forEach((v, k) => Object.assign(series[series.length - 3 + k], v));
  const clicks = series.reduce((s, p) => s + p.clicks, 0);
  const impressions = series.reduce((s, p) => s + p.impressions, 0);

  const queries: OrganicQuery[] = opts.queries.map((q, i) => {
    const qc = Math.max(0, Math.round((clicks * 0.22) / (i + 1.4) * (0.7 + r() * 0.6)));
    const qi = Math.round(qc * (i === 0 ? 2.4 : 12 + r() * 40)) + Math.round(r() * 400);
    const pos = i === 0 ? 1.2 : Math.round((3 + r() * 25 + i * 0.4) * 10) / 10;
    return { query: q, clicks: qc, impressions: qi, ctr: qi ? qc / qi : 0, position: pos };
  }).sort((a, b) => b.clicks - a.clicks);

  const ranked = [...pages].sort((a, b) => a.summary.path.length - b.summary.path.length);
  const gscPages: OrganicPage[] = ranked.slice(0, Math.min(ranked.length, 30)).map((p, i) => {
    const pc = Math.max(1, Math.round((clicks * 0.35) / (i + 1) * (0.6 + r() * 0.5)));
    const pi = Math.round(pc * (18 + r() * 30));
    const pos = Math.round((2 + r() * 22 + i * 0.3) * 10) / 10;
    return { url: p.summary.url, path: p.summary.path, pageId: p.summary.id, score: p.summary.score, clicks: pc, impressions: pi, ctr: pc / pi, position: pos };
  });
  for (const e of opts.extraPages) {
    gscPages.push({ url: `https://${opts.host}${e.path}`, path: e.path, pageId: null, score: null, clicks: e.clicks, impressions: e.impressions, ctr: e.clicks / e.impressions, position: e.position });
  }
  gscPages.sort((a, b) => b.clicks - a.clicks);

  return {
    available: true, importedAt,
    period: { start: series[0].date, end: series[series.length - 1].date },
    totals: { clicks, impressions, ctr: clicks / impressions, position: Math.round((queries.reduce((s, q) => s + q.position * q.impressions, 0) / Math.max(1, queries.reduce((s, q) => s + q.impressions, 0))) * 10) / 10 },
    series, queries, pages: gscPages,
  };
}

/** Relie les données Search Console aux pages analysées. */
export function attachOrganic(pages: DemoPage[], gsc: Extract<SearchConsoleData, { available: true }> | null) {
  for (const p of pages) {
    const o = gsc?.pages?.find((g) => g.pageId === p.summary.id) ?? null;
    const organic = o ? { clicks: o.clicks, impressions: o.impressions, position: o.position } : null;
    p.summary = { ...p.summary, organic };
    p.detail = { ...p.detail, organic, queries: null };
    if (gsc?.queries && o) {
      const words = p.summary.path.split(/[/-]/).filter((w) => w.length > 3);
      const qs = gsc.queries.filter((q) => words.some((w) => q.query.includes(w.slice(0, 5)))).slice(0, 6);
      p.detail.queries = qs;
    }
  }
}

export function buildCompetitors(host: string): CompetitorsData {
  const queries = ["cours de poterie nantes", "vaisselle grès artisanale", "atelier céramique nantes", "bol en grès fait main", "stage poterie week-end"];
  const list: Competitor[] = [
    { host: "terre-et-feu.example", queriesMatched: 4, bestPosition: 2, example: { query: "cours de poterie nantes", position: 2, title: "Cours de poterie à Nantes — Terre et Feu", url: "https://terre-et-feu.example/cours" } },
    { host: "la-main-qui-tourne.example", queriesMatched: 3, bestPosition: 1, example: { query: "stage poterie week-end", position: 1, title: "Stage de poterie le temps d'un week-end", url: "https://la-main-qui-tourne.example/stages" } },
    { host: "gres-et-cie.example", queriesMatched: 3, bestPosition: 3, example: { query: "vaisselle grès artisanale", position: 3, title: "Vaisselle en grès artisanale, faite en France", url: "https://gres-et-cie.example/vaisselle" } },
    { host: "marche-createurs.example", queriesMatched: 2, bestPosition: 4, example: { query: "bol en grès fait main", position: 4, title: "Bols en grès faits main — 240 créateurs", url: "https://marche-createurs.example/bols-gres" } },
    { host: "atelier-argile-nantes.example", queriesMatched: 2, bestPosition: 5, example: { query: "atelier céramique nantes", position: 5, title: "Atelier Argile : céramique et modelage à Nantes", url: "https://atelier-argile-nantes.example/" } },
    { host: "ceramique-mag.example", queriesMatched: 1, bestPosition: 7, example: { query: "vaisselle grès artisanale", position: 7, title: "Les 15 plus belles marques de vaisselle artisanale", url: "https://ceramique-mag.example/selection-vaisselle" } },
  ];
  void host;
  return { available: true, checkedAt: "2026-11-26T14:10:00.000Z", queries, competitors: list };
}

// ───────── Les deux sites fictifs

const lunePaths: SiteProfile["paths"] = [
  { path: "/", title: "Atelier Lune | Poterie artisanale à Nantes", h1: "Poterie artisanale à Nantes", words: 412 },
  { path: "/boutique", title: "Produits", h1: "Boutique", words: 96 },
  { path: "/cours", title: "Cours de poterie à Nantes, tous niveaux | Atelier Lune", h1: "Cours de poterie", words: 520 },
  { path: "/cours/initiation", title: "Cours d'initiation au tour de potier | Atelier Lune", h1: "Initiation au tour", words: 640 },
  { path: "/cours/tournage-avance", title: "Tournage avancé : perfectionnement", h1: "Tournage avancé", words: 380 },
  { path: "/cours/stage-week-end", title: "Stage de poterie le temps d'un week-end à Nantes", h1: "Stage week-end", words: 450 },
  { path: "/cours/enfants", title: "Atelier poterie pour enfants", h1: "Poterie pour les enfants", words: 210 },
  { path: "/cours/carte-cadeau", title: "Offrir un cours de poterie : carte cadeau", h1: "Carte cadeau", words: 180 },
  { path: "/atelier", title: "L'atelier", h1: "Notre atelier", words: 330 },
  { path: "/a-propos", title: "À propos d'Atelier Lune, céramiste à Nantes", h1: "Qui sommes-nous", words: 520 },
  { path: "/contact", title: "Contact et accès à l'atelier | Atelier Lune", h1: "Nous trouver", words: 140 },
  { path: "/boutique/bols", title: "Bols en grès faits main | Atelier Lune", h1: "Bols", words: 160 },
  { path: "/boutique/assiettes", title: "Assiettes en grès émaillé, faites à Nantes", h1: "Assiettes", words: 150 },
  { path: "/boutique/tasses", title: "Tasses et mugs en céramique artisanale", h1: "Tasses et mugs", words: 120 },
  { path: "/boutique/vases", title: "Vases", h1: "Vases", words: 80 },
  { path: "/boutique/plats", title: "Plats de service en grès | Atelier Lune", h1: "Plats", words: 110 },
  { path: "/boutique/nouveautes", title: "Nouveautés de l'atelier", h1: "Nouveautés", words: 90 },
  { path: "/produits/bol-lune-bleu-nuit", title: "Bol Lune bleu nuit, grès émaillé tourné main", h1: "Bol Lune bleu nuit", words: 260 },
  { path: "/produits/bol-lune-sable", title: "Bol Lune sable, grès tourné à la main", h1: "Bol Lune sable", words: 240 },
  { path: "/produits/assiette-plate-ecume", title: "Assiette plate Écume — grès émaillé blanc", h1: "Assiette plate Écume", words: 230 },
  { path: "/produits/assiette-creuse-ecume", title: "Assiette creuse Écume, grès émaillé", h1: "Assiette creuse Écume", words: 220 },
  { path: "/produits/tasse-galet", title: "Tasse Galet", h1: "Tasse Galet", words: 150 },
  { path: "/produits/mug-marée", title: "Mug Marée en grès, anse tournée à la main", h1: "Mug Marée", words: 210 },
  { path: "/produits/vase-dune-grand", title: "Grand vase Dune en grès chamotté, pièce unique faite à la main à Nantes", h1: "Grand vase Dune", words: 300 },
  { path: "/produits/vase-dune-petit", title: "Petit vase Dune en grès chamotté", h1: "Petit vase Dune", words: 190 },
  { path: "/produits/plat-ovale-sel", title: "Plat ovale Sel, grès émaillé", h1: "Plat ovale Sel", words: 200 },
  { path: "/produits/saladier-lune", title: "Saladier Lune, grès émaillé bleu", h1: "Saladier Lune", words: 210 },
  { path: "/produits/theiere-brume", title: "Théière Brume en grès, 80 cl", h1: "Théière Brume", words: 280 },
  { path: "/produits/coffret-4-bols", title: "Coffret de 4 bols Lune — idée cadeau", h1: "Coffret 4 bols", words: 230 },
  { path: "/produits/carte-cadeau", title: "Carte cadeau Atelier Lune", h1: "Carte cadeau", words: 120 },
  { path: "/blog", title: "Blog", h1: "Le blog de l'atelier", words: 140 },
  { path: "/blog/entretenir-sa-vaisselle-en-gres", title: "Comment entretenir sa vaisselle en grès ?", h1: "Entretenir sa vaisselle en grès", words: 980 },
  { path: "/blog/gres-faience-porcelaine", title: "Grès, faïence ou porcelaine : quelles différences ?", h1: "Grès, faïence ou porcelaine", words: 1240 },
  { path: "/blog/premier-cours-de-tour", title: "Mon premier cours de tour : ce qui vous attend", h1: "Votre premier cours de tour", words: 860 },
  { path: "/blog/cuisson-raku", title: "La cuisson raku expliquée simplement", h1: "La cuisson raku", words: 720 },
  { path: "/blog/choisir-son-argile", title: "Bien choisir son argile pour débuter", h1: "Choisir son argile", words: 650 },
  { path: "/livraison", title: "Livraison et retours | Atelier Lune", h1: "Livraison et retours", words: 310 },
  { path: "/faq", title: "Questions fréquentes", h1: "Questions fréquentes", words: 540 },
  { path: "/mentions-legales", title: "Mentions légales", h1: "Mentions légales", words: 620 },
  { path: "/cgv", title: "Conditions générales de vente", h1: "Conditions générales de vente", words: 1800 },
  { path: "/revendeurs", title: "Revendeurs et boutiques partenaires", h1: "Où trouver nos pièces", words: 190 },
  { path: "/presse", title: "Atelier Lune dans la presse", h1: "Presse", words: 160 },
];

export const LUNE: SiteProfile = {
  host: "atelier-lune.example",
  seed: 7,
  fail: { meta_description: 0.62, h1: 0.66, image_alt: 0.7, canonical: 0.25, headings: 0.5, structured_data: 0.7, open_graph: 0.6, twitter_card: 0.8, internal_links: 0.3, link_text: 0.45, image_size: 0.5, title_h1: 0.3, h2: 0.55, description_unique: 0.2, viewport: 0, lang: 0, charset: 0, indexable: 0.03, blocking_scripts: 0.4, favicon: 0 },
  paths: lunePaths,
};

const bijouxCats = ["bagues", "colliers", "boucles-d-oreilles", "bracelets", "piercings", "chevilleres"];
const bijouxNames = ["Aube", "Céleste", "Iris", "Lys", "Mira", "Nova", "Opale", "Perle", "Sable", "Saphir", "Selene", "Stella", "Vega", "Ondine", "Ambre", "Jade", "Luna", "Mila", "Nacre", "Orée"];
const metals = ["or 18 carats", "argent 925", "plaqué or", "or rose", "or blanc", "vermeil"];

function bijouxPaths(count: number): SiteProfile["paths"] {
  const r = rng(99);
  const out: SiteProfile["paths"] = [
    { path: "/", title: "Maison Orlux — Bijoux fins en or et argent", h1: "Bijoux fins faits en France", words: 380 },
    { path: "/collections", title: "Toutes nos collections", h1: "Collections", words: 120 },
    { path: "/a-propos", title: "Notre histoire", h1: "La maison", words: 450 },
    { path: "/contact", title: "Contact", h1: "Contact", words: 90 },
    { path: "/guide-des-tailles", title: "Guide des tailles de bagues et bracelets", h1: "Guide des tailles", words: 720 },
  ];
  for (const c of bijouxCats) {
    out.push({ path: `/collections/${c}`, title: `${c[0].toUpperCase()}${c.slice(1).replace(/-/g, " ")} en or et argent | Maison Orlux`, h1: c.replace(/-/g, " "), words: 60 + Math.floor(r() * 200) });
  }
  let i = 0;
  while (out.length < count) {
    const cat = bijouxCats[i % bijouxCats.length];
    const name = bijouxNames[Math.floor(r() * bijouxNames.length)];
    const metal = metals[Math.floor(r() * metals.length)];
    const slug = `${cat.replace(/s$/, "").replace(/-d-oreille$/, "")}-${name.toLowerCase()}-${metal.split(" ")[0]}-${i}`;
    const t = r();
    const title = t < 0.18 ? null : t < 0.45 ? `${name}` : `${cat.replace(/s$/, "").replace(/-/g, " ")} ${name} en ${metal} — Maison Orlux`;
    out.push({ path: `/produits/${slug}`, title: title ? title[0].toUpperCase() + title.slice(1) : null, h1: `${name} ${metal}`, words: 40 + Math.floor(r() * 380) });
    i++;
  }
  return out;
}

export const ORLUX: SiteProfile = {
  host: "maison-orlux.example",
  seed: 31,
  fail: { meta_description: 0.7, h1: 0.45, image_alt: 0.75, canonical: 0.3, headings: 0.6, structured_data: 0.55, open_graph: 0.5, twitter_card: 0.9, internal_links: 0.4, link_text: 0.6, image_size: 0.6, title_h1: 0.5, h2: 0.7, description_unique: 0.3, viewport: 0, lang: 0.1, charset: 0, indexable: 0.04, blocking_scripts: 0.6, favicon: 0 },
  paths: bijouxPaths(360),
};

export const LUNE_QUERIES = [
  "atelier lune", "cours de poterie nantes", "vaisselle grès nantes", "poterie nantes", "stage poterie week-end nantes", "bol en grès fait main",
  "cours tour de potier nantes", "atelier céramique nantes", "carte cadeau poterie", "assiette grès artisanale", "entretenir vaisselle grès",
  "différence grès faïence porcelaine", "cuisson raku", "théière en grès", "mug céramique artisanal", "poterie enfant nantes",
  "choisir argile débutant", "vase grès chamotté", "saladier grès", "premier cours de poterie",
];
