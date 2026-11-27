import { useEffect, useRef } from "react";
import { navigate, parseRoute, sitePath, usePath, type Route, type SectionName } from "./lib/router";
import { useOverview, useSettings, useSites } from "./lib/queries";
import { useSiteEvents } from "./lib/live";
import { Shell } from "./layout/Shell";
import { NAV } from "./layout/nav";
import { ErrorState, EmptyState } from "./ui/States";
import { ButtonLink } from "./ui/Button";
import { Skeleton } from "./ui/Skeleton";
import { AddSite } from "./screens/AddSite";
import { OverviewScreen } from "./screens/Overview";
import { AuditScreen } from "./screens/Audit";
import { PagesScreen } from "./screens/Pages";
import { TrafficScreen } from "./screens/Traffic";
import { CompetitorsScreen } from "./screens/Competitors";
import { RecommendationsScreen } from "./screens/Recommendations";
import { ShopifyScreen } from "./screens/Shopify";
import { AssistantScreen } from "./screens/Assistant";
import { SettingsScreen } from "./screens/Settings";
import type { SiteSummary } from "./lib/types";

function siteIdOf(r: Route): string | null {
  return "siteId" in r ? r.siteId : null;
}

function Screen({ route, site }: { route: Route; site: SiteSummary }) {
  switch (route.name) {
    case "overview":
      return <OverviewScreen site={site} />;
    case "audit":
      return <AuditScreen site={site} issueId={route.issueId} />;
    case "pages":
      return <PagesScreen site={site} pageId={route.pageId} />;
    case "traffic":
      return <TrafficScreen site={site} />;
    case "competitors":
      return <CompetitorsScreen site={site} />;
    case "recommendations":
      return <RecommendationsScreen site={site} />;
    case "shopify":
      return <ShopifyScreen site={site} resourceId={route.resourceId} />;
    case "assistant":
      return <AssistantScreen site={site} />;
    case "settings":
      return <SettingsScreen site={site} />;
    default:
      return null;
  }
}

function ShellSkeleton() {
  return (
    <div className="shell">
      <aside className="sidebar" aria-hidden>
        <div className="sidebar__top"><Skeleton w={110} h={18} /></div>
        <div style={{ padding: "0 12px" }}><Skeleton h={44} r={8} /></div>
        <div className="nav">
          {NAV.filter((n) => n.id !== "shopify").map((n) => (
            <div key={n.id} className="nav__item"><Skeleton w={18} h={18} r={4} /><Skeleton w="60%" h={10} /></div>
          ))}
        </div>
      </aside>
      <div className="main">
        <main className="content">
          <Skeleton w={220} h={26} />
          <div style={{ height: 12 }} />
          <Skeleton w={380} h={12} />
        </main>
      </div>
    </div>
  );
}

export function App() {
  const path = usePath();
  const route = parseRoute(path);
  const sitesQ = useSites();
  // Chargés tôt : certains boutons dépendent de ce qui est configuré côté serveur (assistant).
  useSettings();
  const siteId = siteIdOf(route);
  useSiteEvents(siteId);
  const overview = useOverview(siteId);
  const sites = sitesQ.data?.sites;
  const site = siteId ? sites?.find((s) => s.id === siteId) ?? null : null;
  const lastPath = useRef(path);

  // Retour en haut à chaque changement d'écran (pas à l'ouverture d'un détail).
  useEffect(() => {
    const sectionOf = (p: string) => p.split("/").slice(0, 4).join("/");
    if (sectionOf(lastPath.current) !== sectionOf(path)) window.scrollTo(0, 0);
    lastPath.current = path;
  }, [path]);

  // Accueil : premier site, ou ajout du premier site.
  useEffect(() => {
    if (!sites) return;
    if (route.name === "home" && sites.length > 0) navigate(sitePath(sites[0].id), { replace: true });
    if (route.name === "settings" && !route.siteId && sites.length > 0) navigate(sitePath(sites[0].id, "settings"), { replace: true });
  }, [sites, route]);

  const section: SectionName | null = "siteId" in route && route.name !== "settings" ? (route.name as SectionName) : route.name === "settings" ? "settings" : null;

  useEffect(() => {
    const nav = NAV.find((n) => n.id === section);
    document.title = site && nav ? `${nav.label} — ${site.name} — Chat SEO` : route.name === "add" ? "Ajouter un site — Chat SEO" : "Chat SEO";
  }, [site, section, route.name]);

  if (!sites) {
    if (sitesQ.error) {
      return (
        <div className="solo">
          <ErrorState error={sitesQ.error} onRetry={() => void sitesQ.refetch()} retrying={sitesQ.fetching} />
        </div>
      );
    }
    return <ShellSkeleton />;
  }

  if (route.name === "home" || route.name === "add" || (route.name === "settings" && !route.siteId && sites.length === 0)) {
    if (route.name === "home" && sites.length > 0) return <ShellSkeleton />;
    return <AddSite hasSites={sites.length > 0} />;
  }

  if (route.name === "notfound" || (siteId && !site)) {
    return (
      <Shell sites={sites} site={null} section="overview">
        <EmptyState
          title={route.name === "notfound" ? "Cette page n'existe pas" : "Ce site n'est plus suivi"}
          actions={<ButtonLink to="/" variant="primary">Revenir à mes sites</ButtonLink>}
        >
          {route.name === "notfound" ? "L'adresse ne correspond à aucun écran." : "Il a peut-être été supprimé. Choisissez un autre site dans la liste."}
        </EmptyState>
      </Shell>
    );
  }

  if (!site || !section) return <ShellSkeleton />;
  const counts = overview.data && overview.data.site.id === site.id ? { critical: overview.data.counts.issues.critical } : undefined;
  return (
    <Shell sites={sites} site={site} section={section} counts={counts}>
      <div className="screen" key={section}>
        <Screen route={route} site={site} />
      </div>
    </Shell>
  );
}
