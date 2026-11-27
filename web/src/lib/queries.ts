/** Clés de cache et accès typés aux routes du format d'échange. */
import { useQuery } from "./cache";
import { getJSON } from "./api";
import type {
  ChatState, CompetitorsData, IssueResponse, IssuesResponse, Overview, PageResponse, PageSummary, PagesResponse,
  FailedPagesResponse, RecommendationsResponse, SearchConsoleData, Settings, ShopifyChangesResponse, ShopifyField, ShopifyResourceResponse,
  ShopifyResourceType, ShopifyResourcesResponse, ShopifyState, SiteResponse, SitesResponse, ShopifyBatchesResponse, ShopifyBatchResponse,
  AutomationState,
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
  /** Préfixe de tout ce qui vient de la boutique (rechargé à l'événement « shopify »). */
  shopifyAll: (id: string) => `${s(id)}/shopify`,
  shopify: (id: string) => `${s(id)}/shopify`,
  shopifySync: (id: string) => `${s(id)}/shopify/sync`,
  shopifyResources: (id: string, f: ShopifyResourceFilter) => {
    const p = new URLSearchParams();
    if (f.type) p.set("type", f.type);
    if (f.q) p.set("q", f.q);
    if (f.missing) p.set("missing", f.missing);
    if (f.fix) p.set("fix", f.fix);
    p.set("offset", String(f.offset));
    p.set("limit", String(SHOPIFY_PAGE));
    return `${s(id)}/shopify/resources?${p.toString()}`;
  },
  shopifyResource: (id: string, rid: string) => `${s(id)}/shopify/resources/${encodeURIComponent(rid)}`,
  shopifyChanges: (id: string, offset: number) => `${s(id)}/shopify/changes?offset=${offset}&limit=${SHOPIFY_PAGE}`,
  shopifyChangesPost: (id: string) => `${s(id)}/shopify/changes`,
  shopifyRestore: (id: string, changeId: string) => `${s(id)}/shopify/changes/${encodeURIComponent(changeId)}/restore`,
  /** Lots de corrections (sous le préfixe de la boutique : relus à l'événement « shopify »). */
  shopifyBatches: (id: string) => `${s(id)}/shopify/batches`,
  shopifyBatch: (id: string, batchId: string) => `${s(id)}/shopify/batches/${encodeURIComponent(batchId)}`,
  shopifyBatchItem: (id: string, batchId: string, itemId: string) => `${s(id)}/shopify/batches/${encodeURIComponent(batchId)}/items/${encodeURIComponent(itemId)}`,
  shopifyBatchApply: (id: string, batchId: string) => `${s(id)}/shopify/batches/${encodeURIComponent(batchId)}/apply`,
  shopifyBatchRestore: (id: string, batchId: string) => `${s(id)}/shopify/batches/${encodeURIComponent(batchId)}/restore`,
  shopifyBatchStop: (id: string, batchId: string) => `${s(id)}/shopify/batches/${encodeURIComponent(batchId)}/stop`,
  shopifyOptimize: (id: string) => `${s(id)}/shopify/optimize`,
  automation: (id: string) => `${s(id)}/automation`,
  searchConsoleSync: (id: string) => `${s(id)}/search-console/sync`,
};

/** Taille d'une page de liste de la boutique (éléments, historique). */
export const SHOPIFY_PAGE = 50;

export interface ShopifyResourceFilter {
  type: ShopifyResourceType | null;
  q: string;
  missing: ShopifyField | null;
  /** Seulement les éléments dont la page analysée est en défaut sur ce champ (titre ou description affichés). */
  fix: "seo_title" | "seo_description" | null;
  offset: number;
}

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
    // Une analyse ouvre peu de pages (plafond du serveur) : une ou deux requêtes suffisent.
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
export const useShopify = (id: string, enabled = true) => useQuery<ShopifyState>(enabled ? keys.shopify(id) : null);
export const useShopifyResources = (id: string, f: ShopifyResourceFilter | null) => useQuery<ShopifyResourcesResponse>(f ? keys.shopifyResources(id, f) : null);
export const useShopifyResource = (id: string, rid: string | null) => useQuery<ShopifyResourceResponse>(rid ? keys.shopifyResource(id, rid) : null);
export const useShopifyChanges = (id: string, offset: number | null) => useQuery<ShopifyChangesResponse>(offset === null ? null : keys.shopifyChanges(id, offset));
export const useShopifyBatches = (id: string, enabled = true) => useQuery<ShopifyBatchesResponse>(enabled ? keys.shopifyBatches(id) : null);
export const useShopifyBatch = (id: string, batchId: string | null) => useQuery<ShopifyBatchResponse>(batchId ? keys.shopifyBatch(id, batchId) : null);
export const useAutomation = (id: string, enabled = true) => useQuery<AutomationState>(enabled ? keys.automation(id) : null);
