import type { PageType } from "./types";

/** Libellés des types de page (le serveur donne aussi le libellé pluriel dans la couverture). */
export const PAGE_TYPE_LABEL: Record<PageType, { one: string; many: string }> = {
  home: { one: "Accueil", many: "Accueil" },
  product: { one: "Produit", many: "Produits" },
  collection: { one: "Collection", many: "Collections" },
  article: { one: "Article", many: "Articles de blog" },
  blog: { one: "Blog", many: "Blog" },
  page: { one: "Page", many: "Pages" },
  policy: { one: "Politique", many: "Politiques et mentions" },
  other: { one: "Autre", many: "Autres" },
};

export const PAGE_TYPE_ORDER: PageType[] = ["home", "product", "collection", "article", "blog", "page", "policy", "other"];

/** Nom d'une langue à partir de son code (« en » → « anglais »). */
export function localeName(code: string): string {
  try {
    const n = new Intl.DisplayNames(["fr"], { type: "language" }).of(code);
    return n && n !== code ? n : code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}
