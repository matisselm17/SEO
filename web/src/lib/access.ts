/**
 * Accès refusé par le serveur (mode intégré à Shopify) : jeton de session refusé même après
 * une nouvelle tentative, page ouverte hors de Shopify, ou boutique qui n'est pas celle servie.
 * Une fois signalé, l'application entière laisse la place à un écran d'explication.
 */
import { useSyncExternalStore } from "react";

export interface AccessDenied {
  message: string;
  action: string | null;
}

export const ACCESS_FALLBACK: AccessDenied = {
  message: "Cette page s'ouvre depuis votre administration Shopify.",
  action: "Ouvrez l'application depuis la section Applications de votre boutique.",
};

let denied: AccessDenied | null = null;
const listeners = new Set<() => void>();

/** Le premier refus fixe le texte affiché ; les suivants ne le changent pas. */
export function denyAccess(reason: AccessDenied = ACCESS_FALLBACK) {
  if (denied) return;
  denied = { message: reason.message || ACCESS_FALLBACK.message, action: reason.action };
  listeners.forEach((l) => l());
}

export function useAccessDenied(): AccessDenied | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => denied,
  );
}
