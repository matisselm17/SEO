import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";

/**
 * Panneau latéral de détail. Se ferme avec Échap, un clic sur le voile ou le bouton.
 * Le focus est placé dans le panneau à l'ouverture et rendu à l'élément d'origine à la fermeture.
 */
export function Sheet({ open, onClose, title, subtitle, children, footer, labelledBy }: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  labelledBy?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const returnTo = useRef<Element | null>(null);
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (open) {
      returnTo.current = document.activeElement;
      setMounted(true);
      const r = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(r);
    }
    setVisible(false);
    const t = setTimeout(() => setMounted(false), 220);
    (returnTo.current as HTMLElement | null)?.focus?.();
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!visible) return;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
      if (e.key === "Tab" && panel.current) {
        const f = panel.current.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])');
        if (!f.length) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [visible, onClose]);

  if (!mounted) return null;
  return (
    <div className={`sheet ${visible ? "sheet--open" : ""}`}>
      <div className="sheet__overlay" onClick={onClose} aria-hidden />
      <div className="sheet__panel" role="dialog" aria-modal="true" aria-labelledby={labelledBy ?? "sheet-title"} tabIndex={-1} ref={panel}>
        <header className="sheet__head">
          <div className="sheet__titles">
            <h2 id={labelledBy ?? "sheet-title"} className="sheet__title">{title}</h2>
            {subtitle && <div className="sheet__subtitle">{subtitle}</div>}
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Fermer le détail">
            <X size={18} aria-hidden />
          </button>
        </header>
        <div className="sheet__body">{children}</div>
        {footer && <footer className="sheet__foot">{footer}</footer>}
      </div>
    </div>
  );
}
