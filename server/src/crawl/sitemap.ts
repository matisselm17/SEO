/**
 * Lecture des sitemaps XML (simples ou index, éventuellement compressés en .gz).
 * Le XML est lu par expressions régulières : seules les balises <loc> sont extraites.
 */
import { gunzipSync } from "node:zlib";
import { safeFetch } from "../net/fetch.ts";

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
  const pages: string[] = [];
  const sitemaps: string[] = [];
  const blockRe = /<(sitemap|url)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(xml))) {
    const loc = /<loc>([\s\S]*?)<\/loc>/i.exec(m[2]);
    if (!loc) continue;
    const value = decodeEntities(loc[1]);
    if (!value) continue;
    (m[1].toLowerCase() === "sitemap" ? sitemaps : pages).push(value);
  }
  return { pages, sitemaps };
}

/** Parcourt les sitemaps donnés (index compris) et renvoie au plus `limit` adresses de pages. */
export async function collectSitemapUrls(starts: string[], opts: { signal: AbortSignal; limit: number; maxFiles?: number }): Promise<string[]> {
  const queue = [...new Set(starts)];
  const seen = new Set<string>();
  const out: string[] = [];
  const maxFiles = opts.maxFiles ?? 10;
  while (queue.length && seen.size < maxFiles && out.length < opts.limit && !opts.signal.aborted) {
    const url = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      const res = await safeFetch(url, {
        signal: opts.signal,
        timeoutMs: 15_000,
        maxBytes: 15 * 1024 * 1024,
        accept: "application/xml,text/xml;q=0.9,*/*;q=0.5",
      });
      if (res.status >= 400) continue;
      let body = res.body;
      if (body[0] === 0x1f && body[1] === 0x8b) {
        body = gunzipSync(body, { maxOutputLength: 50 * 1024 * 1024 });
      }
      const text = body.toString("utf8");
      if (!/<(urlset|sitemapindex)\b/i.test(text)) continue;
      const { pages, sitemaps } = parseSitemap(text);
      for (const p of pages) {
        if (out.length >= opts.limit) break;
        out.push(p);
      }
      queue.push(...sitemaps);
    } catch {
      /* sitemap illisible : on continue sans lui */
    }
  }
  return out;
}
