export type NativeSearchParams = {
 query: string
 sites?: string[]
 maxResults?: number
 maxSites?: number
 maxPages?: number
 fetchPages?: number
 adaptiveFetch?: boolean
 pagesPerSite?: number
 strategy?: 'balanced' | 'deep' | 'direct'
 includePlan?: boolean
 fetchContent?: boolean
 contentChars?: number
 timeoutMs?: number
}

export type NativeSearchScoreBreakdown = {bm25: number; title: number; url: number; phrase: number; source: number}

export type NativeSearchResultMetadata = {rank: number; title: string; url: string; score: number; kind: string; contentType: string; snippet?: string; scoreBreakdown?: NativeSearchScoreBreakdown}

export type ToolTextResponse = {content: Array<{type: 'text'; text: string}>; details?: any}

export type ProgressEmitter = ((text: string, details?: any) => void) | undefined

export type FetchTextOptions = {accept?: string; timeoutMs: number; maxBytes: number; signal?: AbortSignal; allowHttpErrors?: boolean}

export type FetchTextResult = {url: string; finalUrl: string; status: number; contentType: string; text: string; bytes: number; truncated: boolean; fromCache: boolean}

export type FetchCacheEntry = FetchTextResult & {expiresAt: number}

export type FetchedPage = {url: string; contentType: string; text: string}

export type DiscoveredUrl = {url: string; source: string; priority: number}

export type SiteDiscovery = {site: string; urls: DiscoveredUrl[]; errors: string[]}
