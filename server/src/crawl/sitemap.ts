/**
 * Analyse des sitemaps XML (simples ou index). Le XML est lu par expressions régulières :
 * seules les balises <loc> et les alternatives hreflang sont extraites. Le chargement est dans inventory.ts.
 */

const decodeEntities = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim();

export function parseSitemap(xml: string): { pages: string[]; sitemaps: string[] } {
  const full = parseSitemapFull(xml);
  return { pages: full.pages.map((p) => p.loc), sitemaps: full.sitemaps };
}

/**
 * Adresses d'un sitemap, avec pour chaque page ses alternatives de langue (<xhtml:link hreflang>),
 * et les sous-sitemaps d'un index.
 */
export function parseSitemapFull(xml: string): { pages: Array<{ loc: string; alternates: string[] }>; sitemaps: string[] } {
  const pages: Array<{ loc: string; alternates: string[] }> = [];
  const sitemaps: string[] = [];
  const blockRe = /<(sitemap|url)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(xml))) {
    const loc = /<loc>([\s\S]*?)<\/loc>/i.exec(m[2]);
    if (!loc) continue;
    const value = decodeEntities(loc[1]);
    if (!value) continue;
    if (m[1].toLowerCase() === "sitemap") {
      sitemaps.push(value);
      continue;
    }
    const alternates: string[] = [];
    const altRe = /<(?:xhtml:)?link\b[^>]*\bhreflang=["'][^"']+["'][^>]*>/gi;
    let a: RegExpExecArray | null;
    while ((a = altRe.exec(m[2])) && alternates.length < 50) {
      const href = /\bhref=["']([^"']+)["']/i.exec(a[0]);
      if (href) alternates.push(decodeEntities(href[1]));
    }
    pages.push({ loc: value, alternates });
  }
  return { pages, sitemaps };
}
