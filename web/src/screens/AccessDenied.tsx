import { useEffect } from "react";
import { Lock } from "lucide-react";
import { Logo } from "../layout/Shell";
import type { AccessDenied } from "../lib/access";

/**
 * Écran entier qui remplace l'application quand le serveur refuse l'accès (mode intégré à Shopify) :
 * le message et l'action de l'erreur, sans navigation. Le texte vient du serveur : affiché comme du texte.
 */
export function AccessDeniedScreen({ reason }: { reason: AccessDenied }) {
  useEffect(() => {
    document.title = "Accès refusé — Chat SEO";
  }, []);
  return (
    <div className="onboard">
      <header className="onboard__bar">
        <Logo />
      </header>
      <main className="denied">
        <div className="empty" role="alert">
          <div className="empty__icon" aria-hidden><Lock size={20} /></div>
          <div className="empty__body">
            <h1 className="empty__title">{reason.message}</h1>
            {reason.action && <p className="empty__text">{reason.action}</p>}
          </div>
        </div>
      </main>
    </div>
  );
}
