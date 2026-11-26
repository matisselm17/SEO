import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { CircleAlert, CircleCheck, X } from "lucide-react";

type Tone = "success" | "error" | "neutral";
interface ToastItem {
  id: number;
  title: string;
  text?: string | null;
  tone: Tone;
  action?: { label: string; onClick: () => void };
}
interface ToastApi {
  show: (t: Omit<ToastItem, "id">) => void;
}

const Ctx = createContext<ToastApi>({ show: () => {} });
export const useToast = () => useContext(Ctx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const show = useCallback(
    (t: Omit<ToastItem, "id">) => {
      const id = ++seq.current;
      setItems((xs) => [...xs.slice(-2), { ...t, id }]);
      setTimeout(() => dismiss(id), t.tone === "error" ? 8000 : 4000);
    },
    [dismiss],
  );
  const api = useMemo(() => ({ show }), [show]);
  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toasts" aria-live="polite" aria-relevant="additions">
        {items.map((t) => (
          <div key={t.id} className={`toast toast--${t.tone}`} role={t.tone === "error" ? "alert" : "status"}>
            {t.tone === "error" ? <CircleAlert size={16} aria-hidden className="toast__icon" /> : <CircleCheck size={16} aria-hidden className="toast__icon" />}
            <div className="toast__body">
              <p className="toast__title">{t.title}</p>
              {t.text && <p className="toast__text">{t.text}</p>}
            </div>
            {t.action && (
              <button
                type="button"
                className="toast__action"
                onClick={() => {
                  t.action!.onClick();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
            <button type="button" className="toast__close" onClick={() => dismiss(t.id)} aria-label="Fermer la notification">
              <X size={14} aria-hidden />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
