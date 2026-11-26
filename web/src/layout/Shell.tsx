import { useEffect, useState, type ReactNode } from "react";
import { Menu, Moon, Sun, X } from "lucide-react";
import type { SiteSummary } from "../lib/types";
import { sitePath, usePath, type SectionName } from "../lib/router";
import { prefetch } from "../lib/cache";
import { keys } from "../lib/queries";
import { setTheme, useTheme } from "../lib/theme";
import { DEMO_ENABLED } from "../lib/transport";
import { Link } from "../ui/Button";
import { NAV } from "./nav";
import { SiteSwitcher } from "./SiteSwitcher";
import { AuditBar } from "./AuditBar";

const PREFETCH: Partial<Record<SectionName, (id: string) => string>> = {
  overview: keys.overview,
  audit: keys.issues,
  pages: keys.allPages,
  traffic: keys.searchConsole,
  competitors: keys.competitors,
  recommendations: keys.recommendations,
  assistant: keys.chat,
  settings: () => keys.settings,
};

export function Logo({ compact }: { compact?: boolean }) {
  return (
    <span className="logo">
      <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden>
        <rect width="32" height="32" rx="7" className="logo__bg" />
        <path d="M9 21.5a7 7 0 1 1 10.2-6.2" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="logo__fg" />
        <circle cx="21.5" cy="21" r="2.6" className="logo__dot" />
      </svg>
      {!compact && <span className="logo__word">Chat SEO</span>}
    </span>
  );
}

function ThemeToggle() {
  const theme = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button type="button" className="nav__item nav__item--btn" onClick={() => setTheme(next)} aria-label={next === "dark" ? "Passer en thème sombre" : "Passer en thème clair"} title={next === "dark" ? "Thème sombre" : "Thème clair"}>
      {theme === "dark" ? <Sun size={17} aria-hidden /> : <Moon size={17} aria-hidden />}
      <span className="nav__label">{theme === "dark" ? "Thème clair" : "Thème sombre"}</span>
    </button>
  );
}

function SidebarContent({ sites, site, section, counts, onNavigate }: {
  sites: SiteSummary[];
  site: SiteSummary | null;
  section: SectionName;
  counts?: { critical: number };
  onNavigate?: () => void;
}) {
  return (
    <>
      <div className="sidebar__top">
        <Link to="/" className="sidebar__brand" aria-label="Chat SEO, accueil">
          <Logo />
        </Link>
      </div>
      <SiteSwitcher sites={sites} current={site} section={section} />
      <nav className="nav" aria-label="Sections">
        {NAV.map((n) => {
          const to = site ? sitePath(site.id, n.id) : n.id === "settings" ? "/parametres" : "/";
          const active = n.id === section;
          const disabled = !site && n.id !== "settings";
          const pf = PREFETCH[n.id];
          return (
            <Link
              key={n.id}
              to={to}
              className={`nav__item ${active ? "is-active" : ""} ${disabled ? "is-disabled" : ""}`}
              aria-current={active ? "page" : undefined}
              aria-disabled={disabled || undefined}
              title={n.label}
              onMouseEnter={() => site && pf && prefetch(pf(site.id))}
              onFocus={() => site && pf && prefetch(pf(site.id))}
              onClick={() => onNavigate?.()}
            >
              <n.icon size={17} aria-hidden />
              <span className="nav__label">{n.label}</span>
              {n.id === "audit" && counts && counts.critical > 0 && (
                <span className="nav__count tnum" aria-label={`${counts.critical} problèmes critiques`}>{counts.critical}</span>
              )}
            </Link>
          );
        })}
      </nav>
      <div className="sidebar__foot">
        <ThemeToggle />
        {DEMO_ENABLED && <p className="demo-tag" title="Mode démonstration du développement : données fictives">Données de démonstration</p>}
      </div>
    </>
  );
}

export function Shell({ sites, site, section, counts, children }: {
  sites: SiteSummary[];
  site: SiteSummary | null;
  section: SectionName;
  counts?: { critical: number };
  children: ReactNode;
}) {
  const [drawer, setDrawer] = useState(false);
  const path = usePath();
  useEffect(() => setDrawer(false), [path]);
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setDrawer(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawer]);

  const running = site?.audit && (site.audit.state === "running" || site.audit.state === "queued");

  return (
    <div className={`shell ${drawer ? "shell--drawer" : ""}`}>
      <a href="#contenu" className="skip-link">Aller au contenu</a>
      <aside className="sidebar" aria-label="Navigation principale">
        <div className="sidebar__rail-toggle">
          <button type="button" className="icon-btn" onClick={() => setDrawer(true)} aria-label="Ouvrir le menu">
            <Menu size={18} aria-hidden />
          </button>
        </div>
        <SidebarContent sites={sites} site={site} section={section} counts={counts} />
      </aside>

      <div className="drawer" aria-hidden={!drawer}>
        <div className="drawer__overlay" onClick={() => setDrawer(false)} />
        <div className="drawer__panel" role="dialog" aria-modal="true" aria-label="Menu">
          <button type="button" className="icon-btn drawer__close" onClick={() => setDrawer(false)} aria-label="Fermer le menu">
            <X size={18} aria-hidden />
          </button>
          {drawer && <SidebarContent sites={sites} site={site} section={section} counts={counts} onNavigate={() => setDrawer(false)} />}
        </div>
      </div>

      <div className="main">
        <header className="topbar">
          <button type="button" className="icon-btn" onClick={() => setDrawer(true)} aria-label="Ouvrir le menu" aria-expanded={drawer}>
            <Menu size={19} aria-hidden />
          </button>
          <span className="topbar__title">{site?.name ?? "Chat SEO"}</span>
          {running && <span className="live-chip"><span className="live-dot" aria-hidden />Analyse</span>}
        </header>
        {site && <AuditBar site={site} />}
        <main id="contenu" className="content" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
