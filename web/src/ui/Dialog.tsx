import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

/**
 * Fenêtre de confirmation, posée au-dessus de tout (y compris d'un panneau latéral).
 * Échap ferme la fenêtre seule, sans refermer le panneau dessous ; le focus reste dans la fenêtre
 * et revient à l'élément d'origine à la fermeture.
 */
export function Dialog({ open, onClose, title, children, footer, busy, size = "md" }: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** Pendant l'envoi : Échap et le voile ne ferment pas. */
  busy?: boolean;
  size?: "md" | "lg";
}) {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const returnTo = useRef<Element | null>(null);
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    if (open) {
      returnTo.current = document.activeElement;
      setMounted(true);
      // Une image plus tard, pour que la transition d'apparition joue (avec un filet si l'onglet est en arrière-plan).
      const r = requestAnimationFrame(() => setVisible(true));
      const t = setTimeout(() => setVisible(true), 60);
      return () => {
        cancelAnimationFrame(r);
        clearTimeout(t);
      };
    }
    setVisible(false);
    const t = setTimeout(() => setMounted(false), 180);
    (returnTo.current as HTMLElement | null)?.focus?.();
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!visible || !open) return;
    // Premier élément marqué data-autofocus, sinon la fenêtre elle-même.
    const auto = panel.current?.querySelector<HTMLElement>("[data-autofocus]");
    (auto ?? panel.current)?.focus();
    // Écoute en capture sur window : passe avant le panneau latéral, qui écoute sur document.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (!busyRef.current) closeRef.current();
      }
      if (e.key === "Tab" && panel.current) {
        e.stopPropagation();
        const f = panel.current.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])');
        if (!f.length) {
          e.preventDefault();
          return;
        }
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [visible, open]);

  if (!mounted) return null;
  return createPortal(
    <div className={`dialog ${visible ? "dialog--open" : ""}`}>
      <div className="dialog__overlay" onClick={() => !busy && onClose()} aria-hidden />
      <div className={`dialog__panel dialog__panel--${size}`} role="dialog" aria-modal="true" aria-labelledby={`${id}-t`} tabIndex={-1} ref={panel}>
        <header className="dialog__head">
          <h2 id={`${id}-t`} className="dialog__title">{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} disabled={busy} aria-label="Fermer">
            <X size={18} aria-hidden />
          </button>
        </header>
        <div className="dialog__body">{children}</div>
        {footer && <footer className="dialog__foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}
