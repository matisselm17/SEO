import { useState } from "react";
import { Check, Copy } from "lucide-react";

const LANG_LABEL = { html: "HTML", text: "Texte", json: "JSON" } as const;

/** Code prêt à copier, affiché comme du texte. */
export function CodeBlock({ code, language = "text", label }: { code: string; language?: keyof typeof LANG_LABEL; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = code;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };
  return (
    <div className="code">
      <div className="code__head">
        <span className="code__lang">{label ?? LANG_LABEL[language]}</span>
        <button type="button" className={`code__copy ${copied ? "is-copied" : ""}`} onClick={copy}>
          {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
          <span>{copied ? "Copié" : "Copier"}</span>
        </button>
      </div>
      <pre className="code__pre" tabIndex={0}>
        <code>{code}</code>
      </pre>
      <span className="sr-only" aria-live="polite">{copied ? "Code copié dans le presse-papiers" : ""}</span>
    </div>
  );
}
