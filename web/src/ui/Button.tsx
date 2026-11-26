import { forwardRef, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { onLinkClick } from "../lib/router";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "accent";
export type ButtonSize = "sm" | "md";

interface Common {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  iconRight?: ReactNode;
  loading?: boolean;
}

const cls = (v: ButtonVariant, s: ButtonSize, extra?: string, iconOnly?: boolean) =>
  ["btn", `btn--${v}`, `btn--${s}`, iconOnly ? "btn--icon" : "", extra ?? ""].filter(Boolean).join(" ");

export const Button = forwardRef<HTMLButtonElement, Common & ButtonHTMLAttributes<HTMLButtonElement>>(function Button(
  { variant = "secondary", size = "md", icon, iconRight, loading, children, className, disabled, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cls(variant, size, className, !children)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <LoaderCircle className="btn__spin" size={16} aria-hidden /> : icon}
      {children && <span className="btn__label">{children}</span>}
      {iconRight}
    </button>
  );
});

/** Lien interne avec l'allure d'un bouton (navigation sans rechargement). */
export function ButtonLink({
  to, variant = "secondary", size = "md", icon, iconRight, children, className, onClick, ...rest
}: Common & { to: string } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a {...rest} href={to} className={cls(variant, size, className, !children)} onClick={(e) => { onClick?.(e); onLinkClick(e, to); }}>
      {icon}
      {children && <span className="btn__label">{children}</span>}
      {iconRight}
    </a>
  );
}

/** Lien interne simple. */
export function Link({ to, children, className, replace, onClick, ...rest }: { to: string; replace?: boolean } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a {...rest} href={to} className={className} onClick={(e) => { onClick?.(e); onLinkClick(e, to, replace); }}>
      {children}
    </a>
  );
}
