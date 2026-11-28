import { useEffect, type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { Logo } from "../layout/Shell";
import { ErrorState } from "../ui/States";
import type { AppError } from "../lib/api";

/**
 * Ouverture dans l'administration Shopify (mode intégré) : le serveur rend le site de la boutique,
 * et le crée à la première ouverture (quelques secondes). Ces écrans couvrent l'attente et l'échec.
 */
function Frame({ title, children }: { title: string; children: ReactNode }) {
  useEffect(() => {
    document.title = `${title} — Chat SEO`;
  }, [title]);
  return (
    <div className="onboard">
      <header className="onboard__bar">
        <Logo />
      </header>
      <main className="denied">{children}</main>
    </div>
  );
}

export function EmbeddedPreparing() {
  return (
    <Frame title="Préparation">
      <p className="preparing" role="status">
        <LoaderCircle size={18} className="btn__spin" aria-hidden />
        Préparation de votre boutique…
      </p>
    </Frame>
  );
}

/** Lecture du site en échec (message et action de l'erreur) ou boutique sans site : « Réessayer ». */
export function EmbeddedProblem({ error, onRetry, retrying }: { error: AppError | null; onRetry: () => void; retrying: boolean }) {
  const shown: AppError = error ?? { code: "not_found", status: 0, message: "Votre boutique n'est pas encore prête.", action: "Réessayez dans un instant." };
  return (
    <Frame title="Boutique indisponible">
      <ErrorState error={shown} onRetry={onRetry} retrying={retrying} />
    </Frame>
  );
}
