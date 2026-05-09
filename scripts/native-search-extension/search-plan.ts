import {DEFAULT_FETCH_PAGES} from './config.ts'
import type {SearchQuality} from './results.ts'
import {normalizeHttpUrl, unique} from './text.ts'
import type {DiscoveredUrl} from './types.ts'

export type SearchIntent = 'precise' | 'standard' | 'broad' | 'deep'
export type SearchStrategy = 'balanced' | 'deep' | 'direct'
export type FetchPolicy = {initialFetchCount: number; batchSize: number; adaptive: boolean; intent: SearchIntent; reason: string}
export type StopReason = 'direct_url_mode' | 'enough_quality' | 'exhausted_candidates' | 'fetch_more'

export type SearchPlanInput = {candidates: DiscoveredUrl[]; sites: string[]; query: string; queryTerms: string[]; strategy: SearchStrategy; directUrlMode: boolean; maxResults: number; maxPages: number; pagesPerSite: number; explicitFetchPages: boolean; fetchPages: number | undefined; adaptiveFetch: boolean | undefined}

export type SearchPlanAdaptiveDetails = {enabled: boolean; batchesFetched: number; initialFetchCount: number; policy: string; stoppedReason: StopReason; quality: SearchQuality | undefined; recover: boolean}
export type SearchPlanDecision = {done: boolean; urls: DiscoveredUrl[]; adaptive: SearchPlanAdaptiveDetails; batchesFetched: number; initialFetchCount: number; policy: string; stoppedReason: StopReason; recover: boolean; quality: SearchQuality | undefined}

export function createSearchPlan(input: SearchPlanInput) {
 const discovered = input.directUrlMode ? input.candidates : [...input.candidates, ...likelyDocUrls(input.sites, input.queryTerms)]
 const plannedUrls = planCandidateUrls(discovered, {strategy: input.strategy, maxPages: input.directUrlMode ? Math.min(input.maxPages, input.sites.length) : input.maxPages, perSiteCap: input.pagesPerSite})
 const rankedUrls = preRankFetchUrls(plannedUrls, input.queryTerms, plannedUrls.length)
 const fetchPolicy = resolveFetchPolicy({
  query: input.query,
  queryTerms: input.queryTerms,
  maxResults: input.maxResults,
  maxPages: input.maxPages,
  plannedUrlCount: rankedUrls.length,
  strategy: input.strategy,
  directUrlMode: input.directUrlMode,
  explicitFetchPages: input.explicitFetchPages,
  fetchPages: input.fetchPages,
  adaptiveFetch: input.adaptiveFetch
 })
 let fetchedCount = fetchPolicy.initialFetchCount
 let batchesFetched = 0

 return {
  plannedUrls,
  rankedUrls,
  fetchPolicy,
  firstBatch() {
   return rankedUrls.slice(0, fetchedCount)
  },
  decideNext(inputDecision: {quality: SearchQuality | undefined; fetchedUrlCount: number}) {
   batchesFetched += 1
   const quality = inputDecision.quality
   const enoughQuality = quality ? isEnoughQuality(quality, input.maxResults) : true
   const exhausted = fetchedCount >= rankedUrls.length
   const recover = shouldRecoverFetchBatch({directUrlMode: input.directUrlMode, adaptive: fetchPolicy.adaptive, enoughQuality, exhausted, fetchedUrlCount: inputDecision.fetchedUrlCount, batchesFetched})
   const stoppedReason: StopReason = input.directUrlMode ? 'direct_url_mode' : enoughQuality && !recover ? 'enough_quality' : exhausted ? 'exhausted_candidates' : fetchPolicy.adaptive || recover ? 'fetch_more' : 'exhausted_candidates'
   const done = input.directUrlMode || exhausted || (!fetchPolicy.adaptive && !recover) || (enoughQuality && !recover)
   if (!done) fetchedCount = Math.min(rankedUrls.length, fetchedCount + fetchPolicy.batchSize)
   const adaptive = {enabled: (fetchPolicy.adaptive || recover) && !input.directUrlMode, batchesFetched, initialFetchCount: fetchPolicy.initialFetchCount, policy: fetchPolicy.reason, stoppedReason, quality, recover}
   return {done, urls: rankedUrls.slice(0, fetchedCount), adaptive, batchesFetched, initialFetchCount: fetchPolicy.initialFetchCount, policy: fetchPolicy.reason, stoppedReason, recover, quality}
  }
 }
}

export function resolveFetchPolicy(input: {query: string; queryTerms: string[]; maxResults: number; maxPages: number; plannedUrlCount: number; strategy: SearchStrategy; directUrlMode: boolean; explicitFetchPages: boolean; fetchPages: number | undefined; adaptiveFetch: boolean | undefined}): FetchPolicy {
 if (input.directUrlMode) {
  return {initialFetchCount: input.plannedUrlCount, batchSize: input.plannedUrlCount, adaptive: false, intent: 'precise', reason: 'direct URLs fetch all explicit inputs'}
 }

 const intent = classifySearchIntent(input.query, input.queryTerms, input.strategy)
 const requested = input.explicitFetchPages ? input.fetchPages : undefined
 const base = Math.max(input.maxResults, DEFAULT_FETCH_PAGES)
 const initialFetchCount = Math.min(input.plannedUrlCount, requested ?? base)
 const batchSize = Math.max(input.maxResults, initialFetchCount)
 const adaptive = input.adaptiveFetch === true
 return {initialFetchCount, batchSize, adaptive, intent, reason: input.explicitFetchPages ? `explicit fetchPages=${input.fetchPages}` : `${intent} intent derived from query and maxResults`}
}

export function shouldRecoverFetchBatch(input: {directUrlMode: boolean; adaptive: boolean; enoughQuality: boolean; exhausted: boolean; fetchedUrlCount: number; batchesFetched: number}) {
 if (input.directUrlMode || input.exhausted || input.adaptive || input.batchesFetched > 2) return false
 if (input.fetchedUrlCount === 0) return true
 return !input.enoughQuality && input.fetchedUrlCount < 2
}

export function isEnoughQuality(quality: SearchQuality, maxResults: number) {
 const targetGoodResults = Math.min(maxResults, 3)
 return quality.goodResultCount >= targetGoodResults && quality.topScore >= 45 && quality.avgTop3Score >= 30
}

export function classifySearchIntent(query: string, queryTerms: string[], strategy: SearchStrategy): SearchIntent {
 if (strategy === 'deep') return 'deep'
 const normalized = ` ${query.toLowerCase()} `
 if (/\b(compare|comparison|landscape|alternatives|best|top|latest|news|market|pricing|companies|founders|people|papers|research|troubleshoot|error|fix|benchmark)\b/.test(normalized)) {
  return 'broad'
 }
 if (queryTerms.length >= 8) return 'standard'
 if (/\b(api|docs|documentation|reference|spec|example|how to|usage)\b/.test(normalized)) {
  return 'precise'
 }
 return 'standard'
}

export function preRankFetchUrls(items: DiscoveredUrl[], queryTerms: string[], fetchPages: number) {
 return [...items].sort((a, b) => fetchPriority(b, queryTerms) - fetchPriority(a, queryTerms) || a.url.localeCompare(b.url)).slice(0, fetchPages)
}

export function likelyDocUrls(sites: string[], queryTerms: string[]): DiscoveredUrl[] {
 const generated: DiscoveredUrl[] = []
 for (const site of sites) {
  const parsed = new URL(site)
  const prefix = docsPrefix(parsed.pathname)
  if (!prefix) continue
  const slugs = new Set<string>()
  for (const term of queryTerms) {
   for (const slug of termSlugs(term, parsed.hostname)) slugs.add(slug)
  }
  for (const slug of slugs) {
   generated.push({url: normalizeHttpUrl(`${parsed.origin}${prefix}/${slug}`), source: 'likely docs', priority: 132})
  }
 }
 return unique(generated.map(item => item.url)).map(url => generated.find(item => item.url === url)!)
}

function docsPrefix(pathname: string) {
 const match = pathname.match(/^\/(docs|documentation|guide|guides|learn|reference|api)(?:\/|$)/i)
 if (!match) return ''
 return `/${match[1].toLowerCase()}`
}

function termSlugs(term: string, hostname: string) {
 const slug = slugToken(term)
 if (!slug || slug.length < 4 || DOC_SLUG_STOP_WORDS.has(slug) || hostname.toLowerCase().includes(slug)) return []
 const slugs = [slug]
 if (slug.endsWith('y')) slugs.push(`${slug.slice(0, -1)}ies`)
 else if (!slug.endsWith('s')) slugs.push(`${slug}s`)
 return slugs
}

function slugToken(term: string) {
 return term
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
}

const DOC_SLUG_STOP_WORDS = new Set(['documentation', 'documentations', 'docs', 'guide', 'guides', 'example', 'examples', 'auto', 'waiting'])

export function fetchPriority(item: DiscoveredUrl, queryTerms: string[]) {
 let score = item.priority
 const parsed = new URL(item.url)
 const path = `${parsed.pathname} ${parsed.search}`.toLowerCase()
 if (/\.(md|mdx|markdown|txt)(?:$|[?#])/i.test(item.url)) score += 12
 if (item.source === 'seed') score += 8
 if (item.source === 'llms') score += 6
 if (item.source === 'likely docs') score += 10
 if (/docs|guide|manual|reference|api|learn|tutorial|examples|spec/i.test(item.url)) score += 10
 if (/\/($|[?#])/.test(parsed.pathname)) score -= 12
 let specificPathMatches = 0
 for (const term of queryTerms) {
  if (term.length >= 2 && path.includes(term.toLowerCase())) score += 12
  if (term.length >= 4 && path.includes(term.toLowerCase()) && !parsed.hostname.toLowerCase().includes(term.toLowerCase())) specificPathMatches += 1
 }
 if (item.source === 'llms' && !/^\/llms(?:-full)?\.txt$/i.test(parsed.pathname) && specificPathMatches === 0) score -= 48
 return score
}

export function planCandidateUrls(items: DiscoveredUrl[], options: {strategy: SearchStrategy; maxPages: number; perSiteCap: number}) {
 const deduped = compactDiscovered(items)
 if (options.strategy === 'deep' || options.strategy === 'direct') {
  return deduped.slice(0, options.maxPages)
 }

 const groups = new Map<string, DiscoveredUrl[]>()
 for (const item of deduped) {
  const origin = originOf(item.url)
  if (!origin) continue
  const group = groups.get(origin) ?? []
  if (group.length < options.perSiteCap) group.push(item)
  groups.set(origin, group)
 }

 const origins = Array.from(groups.keys()).sort()
 const planned: DiscoveredUrl[] = []
 for (let round = 0; planned.length < options.maxPages; round += 1) {
  let added = false
  for (const origin of origins) {
   const item = groups.get(origin)?.[round]
   if (!item) continue
   planned.push(item)
   added = true
   if (planned.length >= options.maxPages) break
  }
  if (!added) break
 }
 return planned
}

function compactDiscovered(items: DiscoveredUrl[]) {
 const best = new Map<string, DiscoveredUrl>()
 for (const item of items) {
  const current = best.get(item.url)
  if (!current || item.priority > current.priority) best.set(item.url, item)
 }
 return Array.from(best.values()).sort((a, b) => b.priority - a.priority || originOf(a.url).localeCompare(originOf(b.url)) || a.url.localeCompare(b.url))
}

export function originOf(url: string) {
 try {
  return new URL(url).origin
 } catch {
  return ''
 }
}
