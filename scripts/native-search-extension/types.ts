export type NativeSearchParams = {
  query: string;
  sites?: string[];
  maxResults?: number;
  maxSites?: number;
  maxPages?: number;
  pagesPerSite?: number;
  strategy?: "balanced" | "deep" | "direct";
  includePlan?: boolean;
  fetchContent?: boolean;
  contentChars?: number;
  timeoutMs?: number;
};

export type ToolTextResponse = {
  content: Array<{ type: "text"; text: string }>;
  details?: any;
};

export type ProgressEmitter = ((text: string, details?: any) => void) | undefined;

export type FetchTextOptions = {
  accept?: string;
  timeoutMs: number;
  maxBytes: number;
  signal?: AbortSignal;
  allowHttpErrors?: boolean;
};

export type FetchTextResult = {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  text: string;
  bytes: number;
  truncated: boolean;
  fromCache: boolean;
};

export type FetchCacheEntry = FetchTextResult & {
  expiresAt: number;
};

export type DiscoveredUrl = {
  url: string;
  source: string;
  priority: number;
};

export type SiteDiscovery = {
  site: string;
  urls: DiscoveredUrl[];
  errors: string[];
};
