import { useEffect, useRef } from "react";
import { navigate, parseRoute, sitePath, usePath, type Route, type SectionName } from "./lib/router";
import { useOverview, useSettings, useSites } from "./lib/queries";
import { sectionState, useFeatures } from "./lib/features";
import { useSiteEvents } from "./lib/live";
import { useAccessDenied } from "./lib/access";
import { AccessDeniedScreen } from "./screens/AccessDenied";
import { EmbeddedPreparing, EmbeddedProblem } from "./screens/EmbeddedStart";
import { isEmbedded } from "./lib/embedded";
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
import { ReportScreen } from "./screens/Report";
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
      return <ShopifyScreen site={site} resourceId={route.resourceId} view={route.view} batchId={route.batchId} />;
    case "assistant":
      return <AssistantScreen site={site} />;
    case "settings":
      return <SettingsScreen site={site} />;
    case "report":
      return <ReportScreen site={site} />;
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

/**
 * Accès refusé par le serveur (mode intégré à Shopify) : l'application entière est retirée,
 * ce qui ferme aussi le flux en direct et arrête les relectures en cours.
 */
export function App() {
  const denied = useAccessDenied();
  if (denied) return <AccessDeniedScreen reason={denied} />;
  return <AppContent />;
}

function AppContent() {
  const embedded = isEmbedded();
  const path = usePath();
  const route = parseRoute(path);
  const sitesQ = useSites();
  // Chargés tôt : les sections facultatives et certains boutons dépendent des réglages du serveur.
  const settingsQ = useSettings();
  const features = useFeatures();
  const siteId = siteIdOf(route);
  const sites = sitesQ.data?.sites;
  // Mode intégré : rien n'est lu pour un site tant que celui de la boutique n'est pas connu et identique.
  const liveSiteId = embedded && (!sites || siteId !== sites[0]?.id) ? null : siteId;
  useSiteEvents(liveSiteId);
  const overview = useOverview(liveSiteId);
  const site = siteId ? sites?.find((s) => s.id === siteId) ?? null : null;
  const lastPath = useRef(path);

  // Retour en haut à chaque changement d'écran (pas à l'ouverture d'un détail).
  useEffect(() => {
    const sectionOf = (p: string) => p.split("/").slice(0, 4).join("/");
    if (sectionOf(lastPath.current) !== sectionOf(path)) window.scrollTo(0, 0);
    lastPath.current = path;
  }, [path]);

  // Mode intégré à Shopify : un seul site, celui de la boutique. Toute adresse sans site, ou d'un
  // autre site, mène à ce site ; l'ajout d'un site n'existe pas.
  useEffect(() => {
    if (!embedded || !sites || sites.length === 0) return;
    const own = sites[0].id;
    if (route.name === "home" || route.name === "add") navigate(sitePath(own), { replace: true });
    else if (route.name === "settings" && !route.siteId) navigate(sitePath(own, "settings"), { replace: true });
    else if (siteId && siteId !== own) navigate(sitePath(own), { replace: true });
  }, [embedded, sites, route, siteId]);

  // Accueil : premier site, ou ajout du premier site.
  useEffect(() => {
    if (embedded || !sites) return;
    if (route.name === "home" && sites.length > 0) navigate(sitePath(sites[0].id), { replace: true });
    if (route.name === "settings" && !route.siteId && sites.length > 0) navigate(sitePath(sites[0].id, "settings"), { replace: true });
  }, [embedded, sites, route]);

  const section: SectionName | null = "siteId" in route && route.name !== "settings" ? (route.name as SectionName) : route.name === "settings" ? "settings" : null;
  // Section masquée par le serveur (Settings.features) : null tant que les réglages ne sont pas chargés.
  const allowed = section ? sectionState(section, features) : true;

  // Adresse directe d'une section masquée : retour à la Vue d'ensemble, sans entrée d'historique.
  useEffect(() => {
    if (allowed === false && siteId) navigate(sitePath(siteId), { replace: true });
  }, [allowed, siteId]);

  useEffect(() => {
    const nav = NAV.find((n) => n.id === section);
    const label = section === "report" ? "Rapport d'optimisation" : nav && allowed ? nav.label : null;
    document.title = site && label ? `${label} — ${site.name} — Chat SEO` : route.name === "add" ? "Ajouter un site — Chat SEO" : "Chat SEO";
  }, [site, section, route.name, allowed]);

  if (embedded) {
    if (!sites) {
      if (sitesQ.error) return <EmbeddedProblem error={sitesQ.error} onRetry={() => void sitesQ.refetch()} retrying={sitesQ.fetching} />;
      return <EmbeddedPreparing />;
    }
    if (sites.length === 0) return <EmbeddedProblem error={null} onRetry={() => void sitesQ.refetch()} retrying={sitesQ.fetching} />;
    // Redirection vers le site de la boutique en cours (effet ci-dessus).
    if (route.name === "home" || route.name === "add" || (route.name === "settings" && !route.siteId) || (siteId && siteId !== sites[0].id)) return <ShellSkeleton />;
  }

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
          actions={<ButtonLink to="/" variant="primary">{embedded ? "Revenir à l'accueil" : "Revenir à mes sites"}</ButtonLink>}
        >
          {route.name === "notfound" ? "L'adresse ne correspond à aucun écran." : "Il a peut-être été supprimé. Choisissez un autre site dans la liste."}
        </EmptyState>
      </Shell>
    );
  }

  if (!site || !section) return <ShellSkeleton />;
  const counts = overview.data && overview.data.site.id === site.id ? { critical: overview.data.counts.issues.critical } : undefined;
  // Le rapport n'a pas d'entrée dans la navigation : il est rattaché à la Vue d'ensemble.
  const navSection: SectionName = section === "report" ? "overview" : section;
  return (
    <Shell sites={sites} site={site} section={navSection} counts={counts}>
      <div className="screen" key={section}>
        {allowed === true ? (
          <Screen route={route} site={site} />
        ) : features.error && allowed === null ? (
          <ErrorState error={settingsQ.error!} onRetry={() => void settingsQ.refetch()} retrying={settingsQ.fetching} />
        ) : (
          // Réglages pas encore chargés, ou redirection en cours : rien de la section n'est affiché ni demandé.
          <div aria-hidden><Skeleton w={220} h={26} /><div style={{ height: 12 }} /><Skeleton w={380} h={12} /></div>
        )}
      </div>
    </Shell>
  );
}
