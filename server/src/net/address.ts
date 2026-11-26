/**
 * Protection contre le chargement d'adresses internes (SSRF).
 * Une adresse n'est chargée que si son hôte est public : ni localhost, ni plage privée,
 * ni adresse réservée — vérifié sur le nom, puis sur chaque adresse IP obtenue par la résolution DNS,
 * à chaque connexion (donc aussi après une redirection).
 */
import net from "node:net";

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home", ".corp", ".localdomain", ".home.arpa"];

/** Vrai si le nom d'hôte désigne évidemment une machine interne, sans résolution DNS. */
export function isInternalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (h === "localhost" || h === "ip6-localhost" || h === "ip6-loopback") return true;
  if (BLOCKED_SUFFIXES.some((s) => h.endsWith(s))) return true;
  if (net.isIP(h)) return isPrivateIp(h);
  // Un nom sans point (ex. « intranet ») ne peut pas être un site public.
  if (!h.includes(".")) return true;
  // Formes numériques détournées (ex. 0x7f.1, 2130706433) : refusées.
  if (/^[0-9.]+$/.test(h) || /^0x[0-9a-f]+(\.|$)/i.test(h)) return true;
  return false;
}

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

const V4_BLOCKS: Array<[string, number]> = [
  ["0.0.0.0", 8], // « ce réseau »
  ["10.0.0.0", 8], // privé
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // boucle locale
  ["169.254.0.0", 16], // lien local (dont métadonnées cloud 169.254.169.254)
  ["172.16.0.0", 12], // privé
  ["192.0.0.0", 24], // réservé IETF
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // relais 6to4
  ["192.168.0.0", 16], // privé
  ["198.18.0.0", 15], // tests de performance
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multidiffusion
  ["240.0.0.0", 4], // réservé, dont 255.255.255.255
];

function isPrivateV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return V4_BLOCKS.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (ipv4ToInt(base) & mask);
  });
}

/** Développe une adresse IPv6 en 8 groupes de 16 bits. */
function expandV6(ip: string): number[] | null {
  let addr = ip.toLowerCase();
  const zone = addr.indexOf("%");
  if (zone >= 0) addr = addr.slice(0, zone);
  // Partie IPv4 finale (ex. ::ffff:127.0.0.1)
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (v4) {
    const n = ipv4ToInt(v4[1]);
    addr = addr.slice(0, -v4[1].length) + ((n >>> 16) & 0xffff).toString(16) + ":" + (n & 0xffff).toString(16);
  }
  const [head, tail] = addr.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined ? (tail ? tail.split(":") : []) : [];
  if (addr.includes("::")) {
    const fill = 8 - h.length - t.length;
    if (fill < 0) return null;
    const groups = [...h, ...Array(fill).fill("0"), ...t];
    return groups.map((g) => parseInt(g || "0", 16));
  }
  if (h.length !== 8) return null;
  return h.map((g) => parseInt(g, 16));
}

function isPrivateV6(ip: string): boolean {
  const g = expandV6(ip);
  if (!g || g.some((x) => Number.isNaN(x))) return true;
  const allZero = g.every((x) => x === 0);
  if (allZero) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  // IPv4 encapsulée : ::ffff:a.b.c.d, ::a.b.c.d, 64:ff9b::a.b.c.d
  const embedded = `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return isPrivateV4(embedded);
  if (g[0] === 0x64 && g[1] === 0xff9b) return isPrivateV4(embedded);
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 lien local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site local (obsolète)
  if ((g[0] & 0xff00) === 0xff00) return true; // multidiffusion
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x2002) return isPrivateV4(`${g[1] >> 8}.${g[1] & 255}.${g[2] >> 8}.${g[2] & 255}`); // 6to4
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo
  return false;
}

export function isPrivateIp(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return isPrivateV4(ip);
  if (kind === 6) return isPrivateV6(ip);
  return true;
}
