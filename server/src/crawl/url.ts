/**
 * Normalisation et filtrage des adresses d'un site.
 * Deux adresses qui désignent la même page doivent donner la même clé :
 * fragments, paramètres de suivi et de pagination, slash final, « www. », port par défaut.
 */

const TRACKING_PARAMS = new Set([
  "gclid", "gclsrc", "dclid", "gbraid", "wbraid", "fbclid", "msclkid", "yclid", "twclid", "ttclid", "li_fat_id",
  "mc_cid", "mc_eid", "_ga", "_gl", "_hsenc", "_hsmi", "hsctatracking", "igshid", "srsltid", "ref", "ref_src",
  "spm", "scid", "oly_anon_id", "oly_enc_id", "vero_id", "wickedid", "mkt_tok", "trk", "trkcampaign", "sc_campaign",
  "sessionid", "phpsessid", "jsessionid", "sid", "_pos", "_sid", "_ss", "variant",
]);
const PAGINATION_PARAMS = new Set(["page", "p", "pg", "paged", "pagenum", "page_number", "start", "offset"]);

export function isTrackingParam(name: string): boolean {
  const n = name.toLowerCase();
  return n.startsWith("utm_") || n.startsWith("pk_") || n.startsWith("mtm_") || TRACKING_PARAMS.has(n);
}

/** Hôte sans « www. », en minuscules. */
export function bareHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
}

/**
 * Accepte une saisie utilisateur (« monsite.fr », « https://monsite.fr/page ») et renvoie l'URL,
 * ou null si elle est inutilisable.
 */
export function parseUserUrl(input: string): URL | null {
  let s = (input ?? "").trim();
  if (!s || s.length > 2048 || /\s/.test(s)) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^:]+:\d+/.test(s)) return null; // mailto:, javascript:…
    s = "https://" + s.replace(/^\/+/, "");
  }
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname || u.username || u.password) return null;
    u.hash = "";
    return u;
  } catch {
    return null;
  }
}

/**
 * Normalise une adresse pour le parcours. `preferredHost` impose la forme de l'hôte (avec ou sans www)
 * et `preferredProtocol` le protocole, pour que les variantes d'une même page fusionnent.
 */
export function normalizeUrl(raw: string | URL, base?: string | URL, prefer?: { host: string; protocol: string }): URL | null {
  let u: URL;
  try {
    u = typeof raw === "string" ? new URL(raw.trim(), base) : new URL(raw.href);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = "";
  u.username = "";
  u.password = "";
  u.hostname = u.hostname.toLowerCase().replace(/\.$/, "");
  if (prefer && bareHost(u.hostname) === bareHost(prefer.host)) {
    u.hostname = prefer.host;
    u.protocol = prefer.protocol;
  }
  if ((u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443")) u.port = "";
  // Paramètres : on retire suivi et pagination, on trie le reste.
  const params = [...u.searchParams.entries()].filter(([k]) => !isTrackingParam(k) && !PAGINATION_PARAMS.has(k.toLowerCase()));
  params.sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  u.search = "";
  for (const [k, v] of params) u.searchParams.append(k, v);
  // Chemin : segments de pagination « /page/2 », slash final, doubles slashs.
  let p = u.pathname.replace(/\/{2,}/g, "/");
  p = p.replace(/\/page\/\d+\/?$/i, "/");
  p = p.replace(/\/index\.(html?|php)$/i, "/");
  if (p.length > 1 && p.endsWith("/")) p = p.replace(/\/+$/, "");
  if (!p) p = "/";
  u.pathname = p;
  return u;
}

/** Clé de dédoublonnage : hôte sans www + chemin + paramètres. Le protocole est ignoré. */
export function urlKey(raw: string | URL): string | null {
  const u = normalizeUrl(raw);
  if (!u) return null;
  let path = u.pathname;
  try {
    path = decodeURI(path);
  } catch {
    /* chemin laissé encodé */
  }
  return bareHost(u.host) + path.toLowerCase() + u.search;
}

/** Chemin décodé, pour l'affichage. */
export function displayPath(raw: string | URL): string {
  try {
    const u = typeof raw === "string" ? new URL(raw) : raw;
    let p = u.pathname;
    try {
      p = decodeURIComponent(p);
    } catch {
      /* laissé tel quel */
    }
    return p + u.search;
  } catch {
    return String(raw);
  }
}

export function sameSite(u: URL, siteHost: string): boolean {
  return bareHost(u.hostname) === bareHost(siteHost);
}

const FILE_EXT =
  /\.(pdf|jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|mp4|m4v|mov|avi|webm|mkv|mp3|wav|ogg|flac|zip|rar|7z|gz|tgz|tar|bz2|exe|dmg|msi|apk|iso|docx?|xlsx?|pptx?|odt|ods|odp|csv|txt|rtf|xml|json|rss|atom|css|js|mjs|map|woff2?|ttf|otf|eot|swf|ics|vcf|epub)$/i;

const EXCLUDED_SEGMENTS = [
  "cart", "panier", "checkout", "commande", "paiement", "payment", "basket",
  "account", "my-account", "mon-compte", "compte", "customer", "login", "logout", "signin", "sign-in", "signup",
  "register", "connexion", "deconnexion", "inscription", "password", "mot-de-passe", "wishlist", "favoris",
  "search", "recherche", "rechercher", "wp-admin", "wp-login.php", "wp-json", "admin", "feed", "cdn-cgi", "xmlrpc.php",
];
const EXCLUDED_PARAMS = ["s", "q", "query", "search", "add-to-cart", "add_to_cart", "replytocom", "orderby", "filter", "sort", "sort_by", "action"];

/** Pourquoi une adresse est exclue du parcours, ou null si elle peut être chargée. */
export function exclusionReason(u: URL): string | null {
  const path = u.pathname.toLowerCase();
  if (FILE_EXT.test(path)) return "fichier";
  const segments = path.split("/").filter(Boolean);
  if (segments.some((s) => EXCLUDED_SEGMENTS.includes(s))) return "panier, compte ou recherche";
  for (const k of u.searchParams.keys()) {
    const key = k.toLowerCase();
    if (EXCLUDED_PARAMS.includes(key) || key.startsWith("filter")) return "recherche ou filtre";
  }
  if (u.search.length > 200) return "paramètres trop longs";
  return null;
}
