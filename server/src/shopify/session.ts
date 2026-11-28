/**
 * Vérification du jeton de session Shopify (mode intégré, docs/format-echange.md, « Application intégrée à Shopify »).
 *
 * Fonction pure : aucune entrée-sortie, horloge injectable. Le jeton est un JWT HS256 signé avec le secret de
 * l'application. Le résultat ne dit jamais à l'appelant quelle vérification a échoué (l'interface ne doit pas
 * l'apprendre), et rien ici ne journalise le jeton ni le secret.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { parseShopDomain } from "./auth.ts";

/** Tolérance d'horloge sur `exp` et `nbf`, en millisecondes. */
export const CLOCK_SKEW_MS = 10_000;
/** Un jeton de session réel fait moins d'un kilo-octet ; au-delà, il n'est même pas décodé. */
export const MAX_SESSION_TOKEN_LENGTH = 4096;

export interface SessionVerifyOptions {
  /** Secret de l'application (SHOPIFY_CLIENT_SECRET). */
  secret: string;
  /** Identifiant de l'application (SHOPIFY_CLIENT_ID), attendu dans `aud`. */
  clientId: string;
  now?: () => number;
}

/** `shop` : domaine `xxx.myshopify.com` de `dest`, validé ; à comparer ensuite avec la boutique servie. */
export type SessionCheck = { ok: true; shop: string } | { ok: false };

const SEGMENT = /^[A-Za-z0-9_-]+$/;
const INVALID: SessionCheck = { ok: false };

function decodeJsonObject(segment: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Hôte d'une adresse `https://xxx.myshopify.com[/chemin]`, sans port ni identifiants ; null sinon. */
function shopHostOf(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 300) return null;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  return parseShopDomain(host) === host ? host : null;
}

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Vérifie un jeton de session. Ordre : forme, en-tête, signature, puis seulement les revendications. */
export function verifySessionToken(token: string, opts: SessionVerifyOptions): SessionCheck {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_SESSION_TOKEN_LENGTH) return INVALID;
  if (!opts.secret || !opts.clientId) return INVALID;
  const parts = token.split(".");
  if (parts.length !== 3 || !parts.every((p) => SEGMENT.test(p))) return INVALID;
  const [h, p, s] = parts;

  const header = decodeJsonObject(h);
  if (!header || header.alg !== "HS256" || "crit" in header) return INVALID;

  const expected = createHmac("sha256", opts.secret).update(`${h}.${p}`).digest();
  const given = Buffer.from(s, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return INVALID;
  // Une seule écriture de la signature est acceptée (base64url canonique).
  if (given.toString("base64url") !== s) return INVALID;

  const claims = decodeJsonObject(p);
  if (!claims) return INVALID;
  const now = (opts.now ?? Date.now)();
  if (!isNumber(claims.exp) || !isNumber(claims.nbf)) return INVALID;
  if (claims.exp * 1000 + CLOCK_SKEW_MS <= now) return INVALID;
  if (claims.nbf * 1000 - CLOCK_SKEW_MS > now) return INVALID;
  if (typeof claims.aud !== "string" || claims.aud !== opts.clientId) return INVALID;

  const iss = shopHostOf(claims.iss);
  const dest = shopHostOf(claims.dest);
  if (!iss || !dest || iss !== dest) return INVALID;
  return { ok: true, shop: dest };
}
