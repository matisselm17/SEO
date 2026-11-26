import { useEffect, useRef, useState } from "react";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import type { SiteSummary } from "../lib/types";
import { navigate, sitePath, type SectionName } from "../lib/router";
import { ScorePill } from "../ui/Badge";

function Monogram({ name }: { name: string }) {
  const letter = (name.trim()[0] ?? "?").toUpperCase();
  return <span className="monogram" aria-hidden>{letter}</span>;
}

/** Sélecteur de site : nom, hôte, note ; liste des autres sites et ajout. */
export function SiteSwitcher({ sites, current, section, collapsed }: { sites: SiteSummary[]; current: SiteSummary | null; section: SectionName; collapsed?: boolean }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const go = (id: string) => {
    setOpen(false);
    navigate(sitePath(id, section === "settings" ? "settings" : section === "audit" || section === "pages" ? section : section));
  };

  return (
    <div className={`switcher ${collapsed ? "switcher--collapsed" : ""}`} ref={root}>
      <button
        type="button"
        className="switcher__button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        aria-label={current ? `Site : ${current.name}. Changer de site` : "Choisir un site"}
      >
        <Monogram name={current?.name ?? "?"} />
        <span className="switcher__text">
          <span className="switcher__name">{current?.name ?? "Choisir un site"}</span>
          {current && <span className="switcher__host">{current.host}</span>}
        </span>
        <ChevronsUpDown size={15} className="switcher__chev" aria-hidden />
      </button>
      {open && (
        <div className="switcher__menu" role="listbox" aria-label="Vos sites">
          <p className="switcher__menu-label">Vos sites</p>
          {sites.map((s) => (
            <button key={s.id} type="button" role="option" aria-selected={s.id === current?.id} className="switcher__item" onClick={() => go(s.id)}>
              <Monogram name={s.name} />
              <span className="switcher__text">
                <span className="switcher__name">{s.name}</span>
                <span className="switcher__host">
                  {s.audit?.state === "running" ? "Analyse en cours…" : s.host}
                </span>
              </span>
              {s.score !== null ? <ScorePill score={s.score} /> : null}
              {s.id === current?.id && <Check size={15} className="switcher__check" aria-hidden />}
            </button>
          ))}
          <div className="switcher__sep" />
          <button
            type="button"
            className="switcher__item switcher__add"
            onClick={() => {
              setOpen(false);
              navigate("/ajouter");
            }}
          >
            <span className="monogram monogram--ghost" aria-hidden><Plus size={15} /></span>
            <span className="switcher__name">Ajouter un site</span>
          </button>
        </div>
      )}
    </div>
  );
}
