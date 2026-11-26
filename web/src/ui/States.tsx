import { useEffect, useState, type ReactNode } from "react";
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

/** Secondes restantes avant de pouvoir réessayer (`rate_limited` : details.retryAfterSeconds). */
export function useRetryCountdown(error: AppError | null): number {
  const total = error && error.code === "rate_limited" && typeof error.details?.retryAfterSeconds === "number" ? Math.ceil(error.details.retryAfterSeconds) : 0;
  const [left, setLeft] = useState(total);
  useEffect(() => {
    setLeft(total);
    if (!total) return;
    const started = Date.now();
    const t = setInterval(() => {
      const l = Math.max(0, total - Math.floor((Date.now() - started) / 1000));
      setLeft(l);
      if (!l) clearInterval(t);
    }, 1000);
    return () => clearInterval(t);
  }, [error, total]);
  return left;
}

export function fmtWait(s: number): string {
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m} min ${r} s` : `${m} min`;
}

/**
 * Erreur du serveur : son message, ce qu'on peut faire, et une relance.
 * `inline` : bandeau au-dessus d'un contenu qui reste affiché.
 * Une erreur `rate_limited` indique le délai et n'autorise la relance qu'à son terme.
 */
export function ErrorState({ error, onRetry, inline, retrying, retryLabel = "Réessayer", retryIcon }: {
  error: AppError;
  onRetry?: () => void;
  inline?: boolean;
  retrying?: boolean;
  retryLabel?: string;
  retryIcon?: ReactNode;
}) {
  const wait = useRetryCountdown(error);
  return (
    <div className={inline ? "error-banner" : "error-block"} role="alert">
      <CircleAlert size={inline ? 16 : 20} className="error__icon" aria-hidden />
      <div className="error__body">
        <p className="error__message">{error.message}</p>
        {error.action && <p className="error__action">{error.action}</p>}
        {wait > 0 && !onRetry && <p className="error__action tnum">Nouvel essai possible dans {fmtWait(wait)}.</p>}
      </div>
      {onRetry && (
        <Button size="sm" variant="secondary" icon={retryIcon ?? <RefreshCw size={14} aria-hidden />} onClick={onRetry} loading={retrying} disabled={wait > 0} className="error__retry">
          {wait > 0 ? `${retryLabel} (${fmtWait(wait)})` : retryLabel}
        </Button>
      )}
    </div>
  );
}
