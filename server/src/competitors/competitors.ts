/**
 * Relevé des concurrents : des recherches réelles (API de recherche Firecrawl), et pour chaque site
 * qui apparaît, la preuve (requête, position, titre, adresse). Aucune estimation.
 * Les résultats de recherche sont des données non fiables : stockées et affichées comme du texte.
 */
import type { Competitor, CompetitorsData } from "../../../shared/api.ts";
import { HttpError } from "../errors.ts";
import { bareHost } from "../crawl/url.ts";

export interface SearchResult {
  url: string;
  title: string;
}

export interface SearchProvider {
  search(query: string, opts: { country: string; signal?: AbortSignal }): Promise<SearchResult[]>;
}

export const FIRECRAWL_SEARCH_URL = "https://api.firecrawl.dev/v2/search";

/** Fournisseur Firecrawl : POST /v2/search, authentification Bearer, résultats dans data.web. */
export class FirecrawlSearch implements SearchProvider {
  constructor(
    private apiKey: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async search(query: string, opts: { country: string; signal?: AbortSignal }): Promise<SearchResult[]> {
    let res: Response;
    try {
      res = await this.fetchImpl(FIRECRAWL_SEARCH_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ query: query.slice(0, 500), limit: 10, sources: ["web"], country: opts.country }),
        signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
      });
    } catch {
      throw searchUnavailable();
    }
    if (res.status === 401 || res.status === 403) throw searchUnavailable("La clé du service de recherche est refusée.", "Vérifiez la clé FIRECRAWL_API_KEY configurée sur le serveur.");
    if (res.status === 402 || res.status === 429) throw searchUnavailable("Le quota du service de recherche est atteint.", "Réessayez plus tard ou augmentez le quota du compte Firecrawl.");
    if (!res.ok) throw searchUnavailable();
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw searchUnavailable();
    }
    const web = (body as { data?: { web?: unknown } })?.data?.web;
    // Ancien format (v1) : data est directement la liste des résultats.
    const list = Array.isArray(web) ? web : Array.isArray((body as { data?: unknown })?.data) ? ((body as { data: unknown[] }).data) : [];
    return list
      .map((r) => {
        const o = r as Record<string, unknown>;
        const meta = (o.metadata ?? {}) as Record<string, unknown>;
        return { url: String(o.url ?? meta.url ?? meta.sourceURL ?? ""), title: String(o.title ?? meta.title ?? "") };
      })
      .filter((r) => /^https?:\/\//i.test(r.url));
  }
}

export function searchUnavailable(message = "Le service de recherche ne répond pas.", action = "Réessayez dans quelques minutes.") {
  return new HttpError(502, "competitors_unavailable", message, action);
}

export const competitorsNotConfigured = () =>
  new HttpError(
    503,
    "competitors_not_configured",
    "Le relevé des concurrents n'est pas configuré sur ce serveur.",
    "Ajoutez une clé FIRECRAWL_API_KEY dans la configuration du serveur, puis redémarrez-le.",
  );

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Mots de la marque : nom du site et libellé de l'hôte. */
export function brandTokens(host: string, siteName: string): string[] {
  const label = bareHost(host).split(".")[0];
  const tokens = new Set<string>();
  const add = (s: string) => {
    const f = fold(s);
    if (f.length >= 3) tokens.add(f);
    if (f.replace(/ /g, "").length >= 3) tokens.add(f.replace(/ /g, ""));
  };
  add(label.replace(/[-_]/g, " "));
  if (siteName && fold(siteName) !== fold(host)) add(siteName);
  return [...tokens];
}

export function isBrandQuery(query: string, brands: string[]): boolean {
  const q = fold(query);
  const compact = q.replace(/ /g, "");
  return brands.some((b) => q.includes(b) || compact.includes(b.replace(/ /g, "")));
}

/**
 * Requêtes à rechercher : les requêtes Search Console hors marque (les plus vues),
 * à défaut les titres des pages principales, nettoyés du nom de la marque.
 */
export function pickQueries(input: {
  host: string;
  siteName: string;
  gscQueries: Array<{ query: string; impressions: number }> | null;
  pages: Array<{ path: string; title: string | null }>;
  max?: number;
}): string[] {
  const max = input.max ?? 5;
  const brands = brandTokens(input.host, input.siteName);
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (q: string) => {
    const clean = q.replace(/\s+/g, " ").trim();
    const k = fold(clean);
    if (!clean || k.length < 3 || seen.has(k) || out.length >= max) return;
    seen.add(k);
    out.push(clean.slice(0, 120));
  };
  if (input.gscQueries?.length) {
    [...input.gscQueries]
      .filter((q) => !isBrandQuery(q.query, brands))
      .sort((a, b) => b.impressions - a.impressions)
      .forEach((q) => push(q.query));
  }
  if (out.length < max) {
    const depth = (p: string) => p.split("/").filter(Boolean).length;
    const ranked = [...input.pages].filter((p) => p.title).sort((a, b) => depth(a.path) - depth(b.path) || a.path.length - b.path.length);
    for (const p of ranked) {
      const parts = p
        .title!.split(/\s+[|–—·•:]\s+|\s+-\s+/)
        .map((x) => x.trim())
        .filter((x) => x && !isBrandQuery(x, brands));
      if (parts[0]) push(parts[0]);
      if (out.length >= max) break;
    }
  }
  return out;
}

export async function runCompetitorSurvey(input: {
  provider: SearchProvider;
  queries: string[];
  ownHost: string;
  country: string;
  signal?: AbortSignal;
}): Promise<Extract<CompetitorsData, { available: true }>> {
  const own = bareHost(input.ownHost);
  const byHost = new Map<string, Competitor>();
  const searched: string[] = [];
  for (const query of input.queries) {
    const results = await input.provider.search(query, { country: input.country, signal: input.signal });
    searched.push(query);
    const counted = new Set<string>();
    results.forEach((r, i) => {
      let host: string;
      try {
        host = bareHost(new URL(r.url).hostname);
      } catch {
        return;
      }
      if (!host || host === own || host.endsWith("." + own)) return;
      const position = i + 1;
      const title = (r.title || host).slice(0, 300);
      const existing = byHost.get(host);
      if (!existing) {
        byHost.set(host, { host, queriesMatched: 1, bestPosition: position, example: { query, position, title, url: r.url } });
        counted.add(host);
        return;
      }
      if (!counted.has(host)) {
        existing.queriesMatched++;
        counted.add(host);
      }
      if (position < existing.bestPosition) {
        existing.bestPosition = position;
        existing.example = { query, position, title, url: r.url };
      }
    });
  }
  const competitors = [...byHost.values()]
    .sort((a, b) => b.queriesMatched - a.queriesMatched || a.bestPosition - b.bestPosition || a.host.localeCompare(b.host))
    .slice(0, 20);
  return { available: true, checkedAt: new Date().toISOString(), queries: searched, competitors };
}

/** Pays de recherche déduit de la langue des pages (fr → FR), FR par défaut. */
export function countryFor(lang: string | null | undefined): string {
  const l = (lang ?? "").toLowerCase();
  const region = /^[a-z]{2}[-_]([a-z]{2})$/.exec(l)?.[1];
  if (region) return region.toUpperCase();
  const map: Record<string, string> = { fr: "FR", en: "US", de: "DE", es: "ES", it: "IT", nl: "NL", pt: "PT", pl: "PL", sv: "SE", da: "DK", ja: "JP" };
  return map[l.slice(0, 2)] ?? "FR";
}
