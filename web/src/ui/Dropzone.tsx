import { useRef, useState, type DragEvent, type ReactNode } from "react";
import { FileUp } from "lucide-react";

/** Dépôt d'un fichier par glisser-déposer ou par sélection. */
export function Dropzone({ onFile, accept, busy, title, hint, compact }: {
  onFile: (f: File) => void;
  accept: string;
  busy?: boolean;
  title: ReactNode;
  hint?: ReactNode;
  compact?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const drop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f && !busy) onFile(f);
  };
  return (
    <div
      className={`drop ${over ? "is-over" : ""} ${busy ? "is-busy" : ""} ${compact ? "drop--compact" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
    >
      <FileUp size={compact ? 18 : 22} className="drop__icon" aria-hidden />
      <div className="drop__text">
        <p className="drop__title">{title}</p>
        {hint && <p className="drop__hint">{hint}</p>}
      </div>
      <button type="button" className="btn btn--secondary btn--sm" onClick={() => input.current?.click()} disabled={busy}>
        <span className="btn__label">{busy ? "Import en cours…" : "Choisir un fichier"}</span>
      </button>
      <input
        ref={input}
        type="file"
        accept={accept}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}
