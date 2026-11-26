import type { ReactNode } from "react";

/** En-tête d'écran : titre, phrase d'explication, actions à droite. */
export function PageHeader({ title, description, actions, meta }: { title: string; description?: ReactNode; actions?: ReactNode; meta?: ReactNode }) {
  return (
    <header className="page-head">
      <div className="page-head__text">
        <h1 className="page-head__title">{title}</h1>
        {description && <p className="page-head__desc">{description}</p>}
        {meta && <div className="page-head__meta">{meta}</div>}
      </div>
      {actions && <div className="page-head__actions">{actions}</div>}
    </header>
  );
}

/** Section d'écran, séparée par l'espace, pas par une carte. */
export function Section({ title, description, actions, children, id, className }: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  id?: string;
  className?: string;
}) {
  return (
    <section className={`section ${className ?? ""}`} aria-labelledby={id && title ? `${id}-t` : undefined}>
      {(title || actions) && (
        <div className="section__head">
          <div>
            {title && <h2 className="section__title" id={id ? `${id}-t` : undefined}>{title}</h2>}
            {description && <p className="section__desc">{description}</p>}
          </div>
          {actions && <div className="section__actions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}
