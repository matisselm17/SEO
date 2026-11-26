import { useRef, useState, type FormEvent } from "react";
import { ArrowLeft } from "lucide-react";
import { sendJSON, toAppError, type AppError } from "../lib/api";
import { setQueryData } from "../lib/cache";
import { keys, useSettings } from "../lib/queries";
import { navigate, sitePath } from "../lib/router";
import type { CreateSiteRequest, SiteResponse, SitesResponse } from "../lib/types";
import { Button, Link } from "../ui/Button";
import { TextField } from "../ui/Field";
import { ErrorState } from "../ui/States";
import { Logo } from "../layout/Shell";
import { fmtInt } from "../lib/format";

/** Vérification locale, avant l'envoi. Le serveur reste juge (adresse publique, site joignable). */
export function checkAddress(raw: string): { ok: true; url: string } | { ok: false; message: string } {
  const v = raw.trim();
  if (!v) return { ok: false, message: "Saisissez l'adresse de votre site." };
  if (/\s/.test(v)) return { ok: false, message: "Une adresse ne contient pas d'espace. Exemple : monsite.fr" };
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`);
  } catch {
    return { ok: false, message: "Cette adresse ne semble pas valide. Exemple : monsite.fr" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, message: "L'adresse doit être celle d'un site web, par exemple monsite.fr" };
  const host = u.hostname;
  if (!host.includes(".") || host.endsWith(".") || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host === "localhost") {
    return { ok: false, message: "Saisissez l'adresse publique du site, avec son extension (.fr, .com…)." };
  }
  return { ok: true, url: v };
}

// Même ordre que le serveur : balises, contenu, technique, liens et images, partage social.
const GRID = [
  { id: "balises", label: "Balises", max: 30, hint: "Titre, description, titres de la page" },
  { id: "contenu", label: "Contenu", max: 20, hint: "Quantité et organisation du texte" },
  { id: "technique", label: "Technique", max: 25, hint: "Mobile, sécurité, visibilité dans Google" },
  { id: "medias", label: "Liens et images", max: 15, hint: "Images décrites, liens entre les pages" },
  { id: "partage", label: "Partage social", max: 10, hint: "Aperçu sur les réseaux" },
];

export function AddSite({ hasSites }: { hasSites: boolean }) {
  const settings = useSettings();
  const [value, setValue] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<AppError | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const maxPages = settings.data?.maxPagesDefault;

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    setServerError(null);
    const check = checkAddress(value);
    if (!check.ok) {
      setFieldError(check.message);
      input.current?.focus();
      return;
    }
    setFieldError(null);
    setBusy(true);
    try {
      const res = await sendJSON<SiteResponse>("POST", keys.sites, { url: check.url } satisfies CreateSiteRequest);
      setQueryData<SitesResponse>(keys.sites, (prev) => ({ sites: [res.site, ...(prev?.sites ?? []).filter((s) => s.id !== res.site.id)] }));
      setQueryData<SiteResponse>(keys.site(res.site.id), res);
      navigate(sitePath(res.site.id));
    } catch (err) {
      const ae = toAppError(err);
      if (ae.code === "invalid_url" || ae.code === "site_unreachable") {
        setFieldError([ae.message, ae.action].filter(Boolean).join(" "));
        input.current?.focus();
      } else {
        setServerError(ae);
      }
    } finally {
      setBusy(false);
    }
  };

  const existingId = serverError?.code === "site_exists" ? String(serverError.details?.siteId ?? "") : "";

  return (
    <div className="onboard">
      <header className="onboard__bar">
        <Logo />
        {hasSites && (
          <Link to="/" className="onboard__back">
            <ArrowLeft size={15} aria-hidden /> Retour à mes sites
          </Link>
        )}
      </header>

      <main className="onboard__main" id="contenu">
        <section className="onboard__intro">
          <h1 className="onboard__title">{hasSites ? "Ajouter un site" : "Quel site voulez-vous analyser ?"}</h1>
          <p className="onboard__lead">
            Indiquez son adresse. Chaque page est lue et notée sur 100, puis vous obtenez les problèmes expliqués, les actions à mener en priorité et un assistant qui connaît votre site.
          </p>

          <form className="onboard__form" onSubmit={submit} noValidate>
            <TextField
              ref={input}
              label="Adresse du site"
              size="lg"
              placeholder="monsite.fr"
              autoComplete="url"
              inputMode="url"
              autoCapitalize="none"
              spellCheck={false}
              autoFocus
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                if (fieldError) setFieldError(null);
              }}
              error={fieldError}
              hint="Avec ou sans https://. Vous pourrez ajouter votre export Search Console ensuite, si vous le souhaitez."
              disabled={busy}
            />
            <Button type="submit" variant="primary" size="md" loading={busy} className="onboard__submit">
              {busy ? "Vérification du site…" : "Lancer l'analyse"}
            </Button>
          </form>

          {serverError && (
            <div className="onboard__error">
              {existingId ? (
                <div className="error-banner" role="alert">
                  <div className="error__body">
                    <p className="error__message">{serverError.message}</p>
                    {serverError.action && <p className="error__action">{serverError.action}</p>}
                  </div>
                  <Button size="sm" className="error__retry" onClick={() => navigate(sitePath(existingId))}>Ouvrir ce site</Button>
                </div>
              ) : serverError.code === "limit_reached" ? (
                // Plafond atteint : réessayer ne servirait à rien, on mène là où l'on peut libérer une place.
                <div className="error-banner" role="alert">
                  <div className="error__body">
                    <p className="error__message">{serverError.message}</p>
                    {serverError.action && <p className="error__action">{serverError.action}</p>}
                  </div>
                  {hasSites && <Button size="sm" className="error__retry" onClick={() => navigate("/")}>Voir mes sites</Button>}
                </div>
              ) : (
                <ErrorState error={serverError} inline onRetry={() => void submit()} retrying={busy} />
              )}
            </div>
          )}

          <ol className="onboard__steps">
            <li>
              <strong>Lecture des pages</strong>
              <span>{maxPages ? `Jusqu'à ${fmtInt(maxPages)} pages, en suivant les liens de votre site.` : "En suivant les liens de votre site."} Vous voyez l'avancée en direct et pouvez naviguer pendant ce temps.</span>
            </li>
            <li>
              <strong>Note et problèmes</strong>
              <span>Chaque problème est expliqué simplement, avec les pages concernées et la correction à appliquer.</span>
            </li>
            <li>
              <strong>Plan d'action et assistant</strong>
              <span>Les actions sont classées par effet et par effort. Posez vos questions à l'assistant à partir de vos données.</span>
            </li>
          </ol>
        </section>

        <aside className="onboard__grid" aria-labelledby="grid-title">
          <h2 id="grid-title" className="onboard__grid-title">Comment la note sur 100 est calculée</h2>
          <p className="onboard__grid-lead">Chaque page est évaluée sur une grille de critères répartis en cinq familles. La note du site est la moyenne de ses pages.</p>
          <div className="grid-bar" aria-hidden>
            {GRID.map((g) => (
              <span key={g.id} className={`grid-bar__seg grid-bar__seg--${g.id}`} style={{ flexGrow: g.max }} />
            ))}
          </div>
          <ul className="grid-list">
            {GRID.map((g) => (
              <li key={g.id}>
                <span className={`grid-list__key grid-bar__seg--${g.id}`} aria-hidden />
                <span className="grid-list__label">{g.label}</span>
                <span className="grid-list__hint">{g.hint}</span>
                <span className="grid-list__pts tnum">{g.max} pts</span>
              </li>
            ))}
          </ul>
        </aside>
      </main>
    </div>
  );
}
