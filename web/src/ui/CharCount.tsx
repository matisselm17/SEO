import { CircleCheck, TriangleAlert } from "lucide-react";
import { fmtInt } from "../lib/format";

/**
 * Compteur de caractères avec repère de longueur (ex. 30 à 60 pour un titre).
 * L'état est dit par un mot et une icône, pas par la couleur seule.
 */
export function CharCount({ length, guide, max, id }: { length: number; guide?: { min: number; max: number }; max: number; id?: string }) {
  // Champ vide : pas un défaut en soi (Shopify se rabat sur le nom ou le texte) ; seul le repère s'affiche.
  if (length === 0) {
    return guide ? <span className="charcount charcount--neutral" id={id}><span className="charcount__hint">Repère : {guide.min} à {guide.max} caractères</span></span> : null;
  }
  let tone: "good" | "warning" | "neutral" = "neutral";
  let text: string | null = null;
  if (length > max) {
    tone = "warning";
    text = `${fmtInt(max)} au plus`;
  } else if (guide && length > 0) {
    if (length < guide.min) { tone = "warning"; text = `Court : visez ${guide.min} à ${guide.max}`; }
    else if (length > guide.max) { tone = "warning"; text = `Long : Google coupera après ~${guide.max}`; }
    else { tone = "good"; text = `Bonne longueur (${guide.min} à ${guide.max})`; }
  }
  return (
    <span className={`charcount charcount--${tone}`} id={id} aria-live="polite">
      {tone === "good" && <CircleCheck size={13} aria-hidden />}
      {tone === "warning" && <TriangleAlert size={13} aria-hidden />}
      <span className="tnum">{fmtInt(length)} {length > 1 ? "caractères" : "caractère"}</span>
      {text && <span className="charcount__hint">· {text}</span>}
    </span>
  );
}
