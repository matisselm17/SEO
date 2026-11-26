import type { ReactNode } from "react";
import { CircleAlert, RefreshCw } from "lucide-react";
import { Button } from "./Button";
import type { AppError } from "../lib/api";

/** Section sans données : ce qui manque, et comment l'obtenir. Aligné à gauche. */
export function EmptyState({
  icon, title, children, actions, tone = "plain",
}: { icon?: ReactNode; title: string; children?: ReactNode; actions?: ReactNode; tone?: "plain" | "framed" }) {
  return (
    <div className={`empty empty--${tone}`}>
      {icon && <div className="empty__icon" aria-hidden>{icon}</div>}
      <div className="empty__body">
        <h3 className="empty__title">{title}</h3>
        {children && <div className="empty__text">{children}</div>}
        {actions && <div className="empty__actions">{actions}</div>}
      </div>
    </div>
  );
}

/**
 * Erreur du serveur : son message, ce qu'on peut faire, et une relance.
 * `inline` : bandeau au-dessus d'un contenu qui reste affiché.
 */
export function ErrorState({ error, onRetry, inline, retrying }: { error: AppError; onRetry?: () => void; inline?: boolean; retrying?: boolean }) {
  return (
    <div className={inline ? "error-banner" : "error-block"} role="alert">
      <CircleAlert size={inline ? 16 : 20} className="error__icon" aria-hidden />
      <div className="error__body">
        <p className="error__message">{error.message}</p>
        {error.action && <p className="error__action">{error.action}</p>}
      </div>
      {onRetry && (
        <Button size="sm" variant="secondary" icon={<RefreshCw size={14} aria-hidden />} onClick={onRetry} loading={retrying}>
          Réessayer
        </Button>
      )}
    </div>
  );
}
