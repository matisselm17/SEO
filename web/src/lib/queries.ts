/** Clés de cache et accès typés aux routes du format d'échange. */
import { useQuery } from "./cache";
import { getJSON } from "./api";
import type {
  ChatState, CompetitorsData, IssueResponse, IssuesResponse, Overview, PageResponse, PageSummary, PagesResponse,
  FailedPagesResponse, RecommendationsResponse, SearchConsoleData, Settings, SiteResponse, SitesResponse,
} from "./types";

const s = (id: string) => `/sites/${encodeURIComponent(id)}`;

export const keys = {
  settings: "/settings",
  sites: "/sites",
  site: (id: string) => s(id),
  overview: (id: string) => `${s(id)}/overview`,
  issues: (id: string) => `${s(id)}/issues`,
  issue: (id: string, issueId: string) => `${s(id)}/issues/${encodeURIComponent(issueId)}`,
  /** Toutes les pages de l'analyse (chargées par tranches de 200), pour un tri et un filtre instantanés. */
  allPages: (id: string) => `${s(id)}/pages#all`,
  page: (id: string, pageId: string) => `${s(id)}/pages/${encodeURIComponent(pageId)}`,
  recommendations: (id: string) => `${s(id)}/recommendations`,
  failedPages: (id: string) => `${s(id)}/failed-pages`,
  searchConsole: (id: string) => `${s(id)}/search-console`,
  competitors: (id: string) => `${s(id)}/competitors`,
  chat: (id: string) => `${s(id)}/chat`,
  events: (id: string) => `${s(id)}/events`,
  audits: (id: string) => `${s(id)}/audits`,
};

export interface AllPages {
  pages: PageSummary[];
  total: number;
}

const PAGE_CHUNK = 200;

function allPagesFetcher(siteId: string) {
  return async ({ signal }: { signal: AbortSignal }) => {
    const pages: PageSummary[] = [];
    let total = 0;
    let offset = 0;
    // Au plus 500 pages par analyse (plafond du serveur) : trois requêtes au plus.
    for (let guard = 0; guard < 20; guard++) {
      const { data } = await getJSON<PagesResponse>(`${s(siteId)}/pages?sort=score_asc&offset=${offset}&limit=${PAGE_CHUNK}`, undefined, signal);
      if (!data) break;
      pages.push(...data.pages);
      total = data.total;
      offset += data.pages.length;
      if (data.pages.length === 0 || offset >= data.total) break;
    }
    return { data: { pages, total } satisfies AllPages, etag: null, notModified: false };
  };
}

const fetchers = new Map<string, ReturnType<typeof allPagesFetcher>>();
function getAllPagesFetcher(siteId: string) {
  let f = fetchers.get(siteId);
  if (!f) fetchers.set(siteId, (f = allPagesFetcher(siteId)));
  return f;
}

export const useSettings = () => useQuery<Settings>(keys.settings);
export const useSites = () => useQuery<SitesResponse>(keys.sites);
export const useSite = (id: string | null) => useQuery<SiteResponse>(id ? keys.site(id) : null);
export const useOverview = (id: string | null) => useQuery<Overview>(id ? keys.overview(id) : null);
export const useIssues = (id: string) => useQuery<IssuesResponse>(keys.issues(id));
export const useIssue = (id: string, issueId: string | null) => useQuery<IssueResponse>(issueId ? keys.issue(id, issueId) : null);
export const useAllPages = (id: string) => useQuery<AllPages>(keys.allPages(id), getAllPagesFetcher(id));
export const usePage = (id: string, pageId: string | null) => useQuery<PageResponse>(pageId ? keys.page(id, pageId) : null);
export const useRecommendations = (id: string) => useQuery<RecommendationsResponse>(keys.recommendations(id));
export const useFailedPages = (id: string, enabled = true) => useQuery<FailedPagesResponse>(enabled ? keys.failedPages(id) : null);
export const useSearchConsole = (id: string) => useQuery<SearchConsoleData>(keys.searchConsole(id));
export const useCompetitors = (id: string) => useQuery<CompetitorsData>(keys.competitors(id));
export const useChat = (id: string) => useQuery<ChatState>(keys.chat(id));
