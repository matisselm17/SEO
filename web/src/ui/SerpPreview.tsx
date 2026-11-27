import { Globe } from "lucide-react";

function crumbs(url: string) {
  try {
    const u = new URL(url);
    const parts = decodeURIComponent(u.pathname).split("/").filter(Boolean);
    return { host: u.host.replace(/^www\./, ""), origin: `${u.protocol}//${u.host}`, path: parts };
  } catch {
    return { host: url, origin: url, path: [] as string[] };
  }
}

/** Aperçu du résultat dans Google, à partir de serpPreview (déjà coupé par le serveur). */
export function SerpPreview({ url, title, description, siteName, missingDescription }: { url: string; title: string | null; description: string | null; siteName?: string; missingDescription?: string }) {
  const c = crumbs(url);
  return (
    <figure className="serp" aria-label="Aperçu du résultat dans Google">
      <div className="serp__site">
        <span className="serp__favicon" aria-hidden><Globe size={14} /></span>
        <span className="serp__names">
          <span className="serp__name">{siteName ?? c.host}</span>
          <span className="serp__url">
            {c.origin}
            {c.path.length > 0 && ` › ${c.path.join(" › ")}`}
          </span>
        </span>
      </div>
      <p className={`serp__title ${title ? "" : "is-missing"}`}>{title ?? "Sans titre : Google en choisira un"}</p>
      <p className={`serp__desc ${description ? "" : "is-missing"}`}>
        {description ?? missingDescription ?? "Pas de description : Google affichera un extrait de la page choisi par lui-même."}
      </p>
    </figure>
  );
}
