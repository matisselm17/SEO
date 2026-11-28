/**
 * Chiffrement des secrets enregistrés en base (jetons des boutiques, mode intégré).
 *
 * AES-256-GCM (node:crypto), vecteur aléatoire de 12 octets par valeur, étiquette d'authentification de 16 octets.
 * La donnée authentifiée (`aad`) lie la valeur à son emplacement (domaine de la boutique + nom du champ) : une valeur
 * copiée d'une ligne ou d'un champ à un autre ne se déchiffre pas.
 *
 * Format versionné : `v1.<vecteur>.<chiffré>.<étiquette>`, chaque partie en base64url.
 * Aucune fonction de ce module ne journalise ni ne recopie une valeur, claire ou chiffrée, ni la clé.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = "v1";

/** Clé de chiffrement invalide (taille). Le message ne contient jamais la clé. */
export class SecretboxKeyError extends Error {
  constructor() {
    super("Clé de chiffrement invalide : 32 octets attendus.");
    this.name = "SecretboxKeyError";
  }
}

/**
 * TOKEN_ENCRYPTION_KEY : 32 octets exactement, en base64 standard (avec ou sans « = » final). Toute autre forme
 * (taille, caractères, base64 non canonique) renvoie null.
 */
export function parseEncryptionKey(raw: string | null | undefined): Buffer | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!/^[A-Za-z0-9+/]{43}=?$/.test(s)) return null;
  const buf = Buffer.from(s, "base64");
  if (buf.length !== KEY_BYTES) return null;
  // Forme canonique : réencodée, la clé redonne la même chaîne (le dernier caractère ne cache pas de bits ignorés).
  if (buf.toString("base64").replace(/=+$/, "") !== s.replace(/=+$/, "")) return null;
  return buf;
}

function checkKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new SecretboxKeyError();
}

/** Chiffre `plaintext` ; `aad` (donnée authentifiée) doit être redonnée à l'identique pour déchiffrer. */
export function seal(key: Buffer, plaintext: string, aad: string): string {
  checkKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}.${iv.toString("base64url")}.${ct.toString("base64url")}.${tag.toString("base64url")}`;
}

const B64URL = /^[A-Za-z0-9_-]*$/;

/**
 * Déchiffre une valeur produite par `seal`. Renvoie null si elle est illisible : format ou version inconnus, valeur
 * altérée, autre clé, autre donnée authentifiée. Ne lève que pour une clé de mauvaise taille.
 */
export function open(key: Buffer, sealed: string | null | undefined, aad: string): string | null {
  checkKey(key);
  if (typeof sealed !== "string") return null;
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION || !parts.slice(1).every((p) => B64URL.test(p))) return null;
  const iv = Buffer.from(parts[1], "base64url");
  const ct = Buffer.from(parts[2], "base64url");
  const tag = Buffer.from(parts[3], "base64url");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
