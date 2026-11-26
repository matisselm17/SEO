/**
 * Lecture de robots.txt (RFC 9309) : groupes par User-agent, Allow / Disallow avec * et $,
 * la règle la plus longue l'emporte, Allow gagne à égalité. Crawl-delay et Sitemap sont relevés.
 */

interface Rule {
  allow: boolean;
  pattern: string;
  regex: RegExp;
}
interface Group {
  agents: string[];
  rules: Rule[];
  crawlDelay: number | null;
}

export interface Robots {
  isAllowed(pathAndQuery: string): boolean;
  crawlDelay: number | null;
  sitemaps: string[];
}

function toRegex(pattern: string): RegExp {
  let src = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") src += ".*";
    else if (ch === "$" && i === pattern.length - 1) src += "$";
    else src += ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + src);
}

function normalizePattern(p: string): string {
  try {
    // Les règles peuvent être encodées ou non : on compare sur la forme décodée.
    return decodeURI(p);
  } catch {
    return p;
  }
}

export function parseRobots(text: string, agentToken: string): Robots {
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/).slice(0, 5000)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (field === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (!current) continue;
    if (field === "allow" || field === "disallow") {
      if (!value) continue; // « Disallow: » vide = tout est permis
      const pattern = normalizePattern(value);
      current.rules.push({ allow: field === "allow", pattern, regex: toRegex(pattern) });
    } else if (field === "crawl-delay") {
      const n = Number(value.replace(",", "."));
      if (Number.isFinite(n) && n >= 0) current.crawlDelay = n;
    }
  }
  const token = agentToken.toLowerCase();
  let chosen = groups.filter((g) => g.agents.some((a) => a !== "*" && token.includes(a)));
  if (!chosen.length) chosen = groups.filter((g) => g.agents.includes("*"));
  const rules = chosen.flatMap((g) => g.rules);
  const delays = chosen.map((g) => g.crawlDelay).filter((d): d is number => d !== null);
  return {
    crawlDelay: delays.length ? Math.max(...delays) : null,
    sitemaps,
    isAllowed(pathAndQuery: string) {
      let target = pathAndQuery || "/";
      try {
        target = decodeURI(target);
      } catch {
        /* comparé tel quel */
      }
      if (target === "/robots.txt") return true;
      let best: Rule | null = null;
      for (const r of rules) {
        if (!r.regex.test(target)) continue;
        if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow)) best = r;
      }
      return best ? best.allow : true;
    },
  };
}

export const ALLOW_ALL: Robots = { isAllowed: () => true, crawlDelay: null, sitemaps: [] };
