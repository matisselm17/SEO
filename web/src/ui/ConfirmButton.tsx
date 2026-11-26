import { useEffect, useState, type ReactNode } from "react";
import { Button } from "./Button";

/** Action destructive en deux temps : un premier clic arme, un second confirme. */
export function ConfirmButton({ children, confirmLabel, onConfirm, icon, size = "md", loading }: {
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  icon?: ReactNode;
  size?: "sm" | "md";
  loading?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 5000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <>
      <Button
        size={size}
        variant={armed ? "danger" : "secondary"}
        icon={icon}
        loading={loading}
        onClick={() => (armed ? (setArmed(false), onConfirm()) : setArmed(true))}
        onBlur={() => setArmed(false)}
      >
        {armed ? confirmLabel : children}
      </Button>
      <span className="sr-only" aria-live="assertive">{armed ? `${confirmLabel} : appuyez de nouveau pour confirmer.` : ""}</span>
    </>
  );
}
