/**
 * Sauvegarde de la boutique Shopify, en LECTURE SEULE, avant tout essai d'écriture réel.
 *   npm --prefix server run shopify:sauvegarde
 * Écrit data/sauvegardes/shopify-<date ISO>.json à la racine du dépôt (dossier ignoré par git).
 * Aucune mutation n'est possible ici : seul le lecteur GraphQL est construit (il refuse toute mutation).
 * Le fichier ne contient aucun secret (ni jeton, ni identifiants de l'application, ni domaine myshopify.com).
 */
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig, REPO_DIR } from "../src/config.ts";
import { ShopifyAuth } from "../src/shopify/auth.ts";
import { readBackup } from "../src/shopify/backup.ts";
import { readerFor, readShopInfo } from "../src/shopify/read.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.shopify) {
    console.error("Aucune boutique configurée (SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET).");
    process.exit(1);
  }
  const auth = new ShopifyAuth(config.shopify);
  const gql = readerFor(auth, fetch);
  const shop = await readShopInfo(gql);
  console.log(`Lecture de la boutique ${shop.name ?? ""} (${shop.host ?? "domaine public inconnu"})…`);
  const backup = await readBackup(gql, {
    shopHost: shop.host,
    onProgress: (done, total) => {
      if (done % 25 === 0 || done === total) console.log(`  traductions : ${done}/${total}`);
    },
  });
  const dir = path.join(REPO_DIR, "data", "sauvegardes");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `shopify-${backup.createdAt.replace(/[:.]/g, "-")}.json`);
  const text = JSON.stringify(backup, null, 2);
  if (/myshopify\.com/i.test(text) || text.includes(config.shopify.clientSecret) || text.includes(config.shopify.clientId)) {
    console.error("Sauvegarde refusée : elle contiendrait un identifiant de l'application ou le domaine technique.");
    process.exit(1);
  }
  writeFileSync(file, text, { mode: 0o600 });
  console.log(`Fichier : ${file}`);
  console.log(`Taille : ${statSync(file).size} octets`);
  console.log("Compteurs :", JSON.stringify(backup.counts));
}

main().catch((err) => {
  console.error("Sauvegarde impossible :", err instanceof Error ? err.message.replace(/[a-z0-9-]+\.myshopify\.com/gi, "la boutique") : "erreur");
  process.exit(1);
});
