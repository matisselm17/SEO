/** Sauvegarde de la boutique : lecture seule, valeurs exactes, traductions, aucun secret. Faux Shopify. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ShopifyAuth } from "../src/shopify/auth.ts";
import { readBackup } from "../src/shopify/backup.ts";
import { readerFor } from "../src/shopify/read.ts";
import { defaultState, FAKE_CREDS, fakeShopify } from "./helpers/fake-shopify.ts";

test("sauvegarde : chaque élément avec ses metafields exacts, ses images et ses traductions ; aucune écriture, aucun secret", async () => {
  const state = defaultState();
  state.products[0].meta.title_tag!.value = "  Bague en or 18 carats  ";
  const fake = fakeShopify(state);
  const backup = await readBackup(readerFor(new ShopifyAuth(FAKE_CREDS, fake.impl), fake.impl), { shopHost: "boutique-essai.example" });
  assert.equal(fake.calls.mutations.length, 0);
  assert.deepEqual({ ...backup.counts }, { product: 2, collection: 1, page: 1, article: 1, images: 4, imagesWithoutAlt: 3, seoTitlePresent: 2, seoDescriptionPresent: 1, translations: 1 });
  const ring = backup.items.find((i) => i.path === "/products/bague-or")!;
  assert.deepEqual(ring.seoTitle, { present: true, value: "  Bague en or 18 carats  ", type: "string", metafieldId: "gid://shopify/Metafield/81" }, "valeur exacte, espaces compris");
  assert.deepEqual(ring.seoDescription, { present: false, value: null, type: null, metafieldId: null });
  assert.deepEqual(ring.images.map((i) => i.alt), ["Bague vue de face", null]);
  assert.deepEqual(ring.translations.en, { seoTitle: { value: "18k gold ring", outdated: false }, seoDescription: null });
  assert.equal(backup.primaryLocale, "fr");
  assert.deepEqual(backup.otherLocales, ["en"]);
  const text = JSON.stringify(backup);
  assert.ok(!text.includes("myshopify") && !text.includes(FAKE_CREDS.clientSecret) && !text.includes("jeton-secret"));
});
