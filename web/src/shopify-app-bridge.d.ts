/**
 * App Bridge de Shopify, présent seulement quand l'interface est affichée dans l'administration Shopify
 * (le serveur injecte lui-même son script en mode intégré). Seul ce dont l'interface se sert est déclaré.
 */
export {};

declare global {
  interface ShopifyAppBridge {
    /** Jeton de session neuf (valable une minute), à envoyer dans `Authorization: Bearer …`. */
    idToken(): Promise<string>;
  }
  interface Window {
    shopify?: ShopifyAppBridge;
  }
}
