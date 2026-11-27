/**
 * Écritures dans la boutique. Chaque fonction envoie UNE mutation pour UNE valeur, via `shopifyMutate`,
 * qui refuse de partir si SHOPIFY_WRITES_ENABLED n'est pas activé.
 *
 * Les `userErrors` de Shopify sont remontées en `ShopifyUserError` : l'appelant n'enregistre rien.
 * Les formes des mutations ont été vérifiées par introspection du schéma 2026-07 (arguments et types),
 * jamais par un envoi réel.
 */
import { shopifyMutate, type ShopifyAuth } from "./auth.ts";
import type { LiveImage, LiveMeta } from "./read.ts";

export class ShopifyUserError extends Error {
  /** true si Shopify signale que la valeur a changé entre la lecture et l'écriture (compareDigest). */
  readonly stale: boolean;
  constructor(message: string, stale = false) {
    super(message);
    this.name = "ShopifyUserError";
    this.stale = stale;
  }
}

export type Mutate = (mutation: string, variables: Record<string, unknown>) => Promise<Record<string, unknown>>;

export function writerFor(auth: ShopifyAuth, writesEnabled: boolean, fetchImpl: typeof fetch): Mutate {
  return (mutation, variables) => shopifyMutate<Record<string, unknown>>(auth, writesEnabled, mutation, variables, fetchImpl);
}

type UserErrors = Array<{ field?: string[] | null; message?: string; code?: string | null }>;

function check(data: Record<string, unknown>, root: string): void {
  const payload = data[root] as { userErrors?: UserErrors } | null | undefined;
  if (!payload) throw new ShopifyUserError("Shopify n'a pas confirmé la modification.");
  const errs = payload.userErrors ?? [];
  if (errs.length) {
    const stale = errs.some((e) => e.code === "STALE_OBJECT");
    const msg = errs
      .map((e) => (typeof e.message === "string" ? e.message : ""))
      .filter(Boolean)
      .join(" ; ")
      .slice(0, 300);
    throw new ShopifyUserError(msg || "Shopify a refusé la modification.", stale);
  }
}

export const M = {
  metafieldsSet: "mutation MetaSet($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { metafields { id } userErrors { field message code } } }",
  metafieldsDelete: "mutation MetaDelete($metafields: [MetafieldIdentifierInput!]!) { metafieldsDelete(metafields: $metafields) { deletedMetafields { key } userErrors { field message } } }",
  fileUpdate: "mutation AltImage($files: [FileUpdateInput!]!) { fileUpdate(files: $files) { files { id } userErrors { field message code } } }",
  translationsRegister:
    "mutation Traduire($resourceId: ID!, $translations: [TranslationInput!]!) { translationsRegister(resourceId: $resourceId, translations: $translations) { translations { key locale } userErrors { field message code } } }",
  translationsRemove:
    "mutation RetirerTraduction($resourceId: ID!, $translationKeys: [String!]!, $locales: [String!]!) { translationsRemove(resourceId: $resourceId, translationKeys: $translationKeys, locales: $locales) { translations { key } userErrors { field message code } } }",
};

/** Clés des metafields qui portent le titre et la description pour Google, pour les quatre types. */
const META_KEY = { seo_title: "title_tag", seo_description: "description_tag" } as const;
/** Type d'un metafield créé par le logiciel (documentation Shopify) ; s'il existe déjà, son type est conservé. */
const META_DEFAULT_TYPE = "single_line_text_field";

/**
 * Titre ou description pour Google, pour les quatre types : une seule clé global.title_tag ou
 * global.description_tag par écriture (l'autre champ n'est jamais touché), avec écriture conditionnelle
 * (compareDigest : Shopify refuse si la valeur a changé depuis la relecture ; null : le metafield ne doit pas exister).
 * `value` null : supprimer le metafield.
 */
export async function writeSeo(mutate: Mutate, gid: string, field: "seo_title" | "seo_description", value: string | null, current: LiveMeta | null): Promise<void> {
  const key = META_KEY[field];
  if (value === null) {
    if (!current) return; // déjà vide : l'appelant l'a refusé avant
    check(await mutate(M.metafieldsDelete, { metafields: [{ ownerId: gid, namespace: "global", key }] }), "metafieldsDelete");
    return;
  }
  check(
    await mutate(M.metafieldsSet, {
      metafields: [{ ownerId: gid, namespace: "global", key, value, type: current?.type || META_DEFAULT_TYPE, compareDigest: current?.compareDigest || null }],
    }),
    "metafieldsSet",
  );
}

/**
 * Texte alternatif d'une image de PRODUIT (fileUpdate sur le MediaImage). Les images de collection et d'article
 * ne sont pas modifiables : leur écriture peut remplacer ou retirer l'image chez Shopify.
 */
export async function writeProductImageAlt(mutate: Mutate, image: LiveImage, value: string | null): Promise<void> {
  if (!image.gid) throw new ShopifyUserError("Cette image n'a pas d'identifiant Shopify.");
  check(await mutate(M.fileUpdate, { files: [{ id: image.gid, alt: value ?? "" }] }), "fileUpdate");
}

/** Traduction du titre ou de la description pour Google. `value` null : retirer la traduction. */
export async function writeTranslation(mutate: Mutate, gid: string, key: string, locale: string, value: string | null, digest: string): Promise<void> {
  if (value === null) {
    check(await mutate(M.translationsRemove, { resourceId: gid, translationKeys: [key], locales: [locale] }), "translationsRemove");
    return;
  }
  check(await mutate(M.translationsRegister, { resourceId: gid, translations: [{ locale, key, value, translatableContentDigest: digest }] }), "translationsRegister");
}
