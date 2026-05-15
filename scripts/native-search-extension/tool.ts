import {existsSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {
 DEFAULT_CONTENT_CHARS,
 DEFAULT_MAX_PAGES,
 DEFAULT_MAX_RESULTS,
 DEFAULT_MAX_SITES,
 DEFAULT_OVERALL_TIMEOUT_MS,
 DEFAULT_PAGES_PER_SITE,
 DEFAULT_TIMEOUT_MS,
 HARD_MAX_CONTENT_CHARS,
 HARD_MAX_OVERALL_TIMEOUT_MS,
 HARD_MAX_PAGES,
 HARD_MAX_PAGES_PER_SITE,
 HARD_MAX_RESULTS,
 HARD_MAX_SITES,
 clampInteger,
 envSeedSites,
 searchConcurrency
} from './config.ts'
import {discoverSiteUrls} from './discover.ts'
import {originIntervalMs} from './http.ts'
import {SearchProgress, buildTimeoutSearchText, nonProgressStderr, readStreamText, readZigProgress} from './progress.ts'
import {extractUrls, normalizeHttpUrl, tokenizeQuery, unique} from './text.ts'
import type {DiscoveredUrl, NativeSearchParams, ProgressEmitter, ToolTextResponse} from './types.ts'

const ZIG_SEARCH_BIN = process.env.TIA_NATIVE_SEARCH_ZIG_BIN ?? new URL('../../fast-tools/native-search-zig', import.meta.url).pathname

export async function runNativeSearchTool(params: NativeSearchParams, signal?: AbortSignal, emit?: ProgressEmitter): Promise<ToolTextResponse> {
 const query = String(params.query ?? '').trim()
 if (!query) throw new Error('native_search requires a non-empty query.')

 const maxResults = clampInteger(params.maxResults, DEFAULT_MAX_RESULTS, 1, HARD_MAX_RESULTS)
 const maxSites = clampInteger(params.maxSites, DEFAULT_MAX_SITES, 1, HARD_MAX_SITES)
 const maxPages = clampInteger(params.maxPages, DEFAULT_MAX_PAGES, 1, HARD_MAX_PAGES)
 const pagesPerSite = clampInteger(params.pagesPerSite, DEFAULT_PAGES_PER_SITE, 1, HARD_MAX_PAGES_PER_SITE)
 const contentChars = clampInteger(params.contentChars, DEFAULT_CONTENT_CHARS, 1000, HARD_MAX_CONTENT_CHARS)
 const timeoutMs = clampInteger(params.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 30000)
 const fetchContent = params.fetchContent !== false
 const strategy = normalizeStrategy(params.strategy)
 const includePlan = params.includePlan !== false
 const queryTerms = tokenizeQuery(query)
 const queryUrls = extractUrls(query)
 const envSites = envSeedSites()
 const autoDirectUrlMode = queryUrls.length > 0 && !params.sites?.length && envSites.length === 0
 const directUrlMode = strategy === 'direct' || autoDirectUrlMode
 const sites = strategy === 'direct' ? seedSites(params.sites, queryUrls, envSites, maxSites) : autoDirectUrlMode ? queryUrls.slice(0, maxSites) : seedSites(params.sites, queryUrls, envSites, maxSites)
 const started = performance.now()
 const progress = new SearchProgress(emit, started)

 if (sites.length === 0) {
  return {content: [{type: 'text', text: 'Native search is intentionally site-bounded and does not call third-party search engines. ' + 'Provide one or more `sites`, include URLs in `query`, or set TIA_NATIVE_SEARCH_SEEDS.'}], details: {query, resultCount: 0, reason: 'missing_sites'}}
 }

 const discoveries = directUrlMode
  ? []
  : await mapLimited(sites, Math.min(searchConcurrency(), sites.length), async (site, index) => {
     progress.emit(`Discovering ${index + 1}/${sites.length}: ${site}`, {phase: 'discover', current: index + 1, total: sites.length, site})
     const discovery = await discoverSiteUrls({site, pagesPerSite, timeoutMs, queryTerms, signal})
     progress.emit(`Discovered ${discovery.urls.length} page(s): ${site}`, {phase: 'discover', current: index + 1, total: sites.length, site, discovered: discovery.urls.length})
     return discovery
    })
 const discovered = directUrlMode ? sites.map(url => ({url, source: 'direct URL', priority: 100})) : discoveries.flatMap(discovery => discovery.urls)
 const urls = planCandidateUrls(discovered, {strategy, maxPages: directUrlMode ? Math.min(maxPages, sites.length) : maxPages, perSiteCap: pagesPerSite})
 const overallTimeoutMs = backendTimeoutMs(params.overallTimeoutMs, timeoutMs, urls.length)
 progress.emit(`Planned ${urls.length} bounded URL(s) across ${countOrigins(urls)} origin(s).`, {phase: 'plan', candidateUrlCount: urls.length, overallTimeoutMs})

 if (!existsSync(ZIG_SEARCH_BIN)) {
  throw new Error(`native_search requires compiled Zig backend at ${ZIG_SEARCH_BIN}. Re-run install or bench/build-native-search-zig.sh.`)
 }
 return runZigNativeSearch({
  query,
  urls,
  maxResults,
  contentChars: fetchContent ? contentChars : Math.min(contentChars, 3000),
  outputContent: fetchContent,
  signal,
  progress,
  started,
  discoveries,
  directUrlMode,
  includePlan,
  overallTimeoutMs,
  plan: buildPlanText({query, sites, urls, maxPages, pagesPerSite, strategy, directUrlMode, discoveries})
 })
}

function truncateBlock(text: string, maxChars: number) {
 return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`
}

type ZigSearchOptions = {
 query: string
 urls: DiscoveredUrl[]
 maxResults: number
 contentChars: number
 outputContent: boolean
 signal?: AbortSignal
 progress: SearchProgress
 started: number
 discoveries: Awaited<ReturnType<typeof discoverSiteUrls>>[]
 directUrlMode: boolean
 includePlan: boolean
 overallTimeoutMs: number
 plan: string
}

async function runZigNativeSearch(options: ZigSearchOptions): Promise<ToolTextResponse> {
 options.progress.emit(`Running Zig fetch/extract/rank for ${options.urls.length} bounded URL(s).`, {phase: 'fetch', candidateUrlCount: options.urls.length, overallTimeoutMs: options.overallTimeoutMs})
 const urlPath = join(tmpdir(), `tia-native-search-urls-${process.pid}-${Date.now()}.txt`)
 let stdoutText = ''
 let timeoutTimer: ReturnType<typeof setTimeout> | undefined
 let hardKillTimer: ReturnType<typeof setTimeout> | undefined
 try {
  writeFileSync(urlPath, `${options.urls.map(item => item.url).join('\n')}\n`)
  const proc = Bun.spawn([ZIG_SEARCH_BIN, '--urls', options.query, String(options.maxResults), String(options.contentChars), urlPath, String(originIntervalMs()), options.outputContent ? '1' : '0'], {stdout: 'pipe', stderr: 'pipe', signal: options.signal})
  const readerAbort = new AbortController()
  const complete = Promise.all([readStreamText(proc.stdout, chunk => (stdoutText += chunk), readerAbort.signal), readZigProgress(proc.stderr, options.progress, readerAbort.signal), proc.exited])
   .then(([finalStdout, stderrText, exitCode]) => ({kind: 'complete' as const, stdoutText: finalStdout || stdoutText, stderrText, exitCode}))
   .catch(error => ({kind: 'error' as const, error}))
  const timeout = new Promise<{kind: 'timeout'}>(resolve => {
   timeoutTimer = setTimeout(() => {
    options.progress.emit(`Watchdog timeout after ${options.overallTimeoutMs} ms; returning recovered progress.`, {phase: 'timeout', status: 'timeout', timeoutMs: options.overallTimeoutMs})
    proc.kill('SIGTERM')
    readerAbort.abort()
    hardKillTimer = setTimeout(() => proc.kill('SIGKILL'), 1000)
    resolve({kind: 'timeout'})
   }, options.overallTimeoutMs)
  })

  const outcome = await Promise.race([complete, timeout])
  if (outcome.kind === 'timeout') return timeoutResponse(options, stdoutText)
  if (timeoutTimer) clearTimeout(timeoutTimer)
  if (hardKillTimer) clearTimeout(hardKillTimer)
  if (outcome.kind === 'error') throw outcome.error
  if (outcome.exitCode !== 0) throw new Error(nonProgressStderr(outcome.stderrText) || `native-search-zig exited with code ${outcome.exitCode}`)
  options.progress.emit('Ranking complete; rendering results.', {phase: 'rank', status: 'complete', candidateUrlCount: options.urls.length})
  return {
   content: [{type: 'text', text: options.includePlan ? `${options.plan}\n\n${outcome.stdoutText.trimEnd()}` : outcome.stdoutText.trimEnd()}],
   details: {
    backend: 'zig-fetch-extract-rank',
    status: 'complete',
    query: options.query,
    resultCount: resultCountFromOutput(outcome.stdoutText, options.maxResults),
    candidateUrlCount: options.urls.length,
    plannedUrls: plannedUrlDetails(options.urls),
    elapsedMs: performance.now() - options.started,
    timeoutMs: options.overallTimeoutMs,
    directUrlMode: options.directUrlMode,
    outputContent: options.outputContent,
    plan: options.plan,
    progress: options.progress.snapshot({status: 'complete'}),
    discoveryErrors: options.discoveries.flatMap(discovery => discovery.errors)
   }
  }
 } finally {
  if (timeoutTimer) clearTimeout(timeoutTimer)
  rmSync(urlPath, {force: true})
 }
}

function timeoutResponse(options: ZigSearchOptions, stdoutText: string): ToolTextResponse {
 const trimmedOutput = stdoutText.trim()
 const text = trimmedOutput
  ? `${buildTimeoutSearchText({query: options.query, timeoutMs: options.overallTimeoutMs, progress: options.progress})}\n\nPartial backend output:\n${truncateBlock(trimmedOutput, 1800)}`
  : buildTimeoutSearchText({query: options.query, timeoutMs: options.overallTimeoutMs, progress: options.progress})
 return {
  content: [{type: 'text', text}],
  details: {
   backend: 'zig-fetch-extract-rank',
   status: 'timeout',
   timedOut: true,
   partial: true,
   query: options.query,
   resultCount: resultCountFromOutput(stdoutText, options.progress.recoveredResults(10).length),
   candidateUrlCount: options.urls.length,
   plannedUrls: plannedUrlDetails(options.urls),
   elapsedMs: performance.now() - options.started,
   timeoutMs: options.overallTimeoutMs,
   directUrlMode: options.directUrlMode,
   outputContent: options.outputContent,
   plan: options.plan,
   progress: options.progress.snapshot({status: 'timeout'}),
   recoveredResults: options.progress.recoveredResults(10),
   discoveryErrors: options.discoveries.flatMap(discovery => discovery.errors)
  }
 }
}

function resultCountFromOutput(text: string, fallback: number) {
 const count = Number(text.match(/Native Zig search found\s+(\d+)\s+result/)?.[1] ?? NaN)
 return Number.isFinite(count) ? count : fallback
}

function plannedUrlDetails(urls: DiscoveredUrl[]) {
 return urls.map(({url, source, priority}) => ({url, source, priority}))
}

type SearchStrategy = 'balanced' | 'deep' | 'direct'

function normalizeStrategy(value: string | undefined): SearchStrategy {
 return value === 'deep' || value === 'direct' ? value : 'balanced'
}

function backendTimeoutMs(value: number | undefined, perRequestTimeoutMs: number, urlCount: number) {
 const delayBudget = originIntervalMs() * Math.max(0, urlCount - 1)
 const adaptiveDefault = Math.min(HARD_MAX_OVERALL_TIMEOUT_MS, Math.max(DEFAULT_OVERALL_TIMEOUT_MS, perRequestTimeoutMs * Math.max(1, Math.min(urlCount, 4)) + delayBudget + 5000))
 return clampInteger(value, adaptiveDefault, 1000, HARD_MAX_OVERALL_TIMEOUT_MS)
}

function seedSites(paramsSites: string[] | undefined, queryUrls: string[], envSites: string[], maxSites: number) {
 const raw = [...(paramsSites ?? []), ...queryUrls, ...envSites]
 const sites: string[] = []
 for (const item of raw) {
  const candidate = /^https?:\/\//i.test(item) ? item : `https://${item}`
  try {
   sites.push(normalizeHttpUrl(candidate))
  } catch {
   // Ignore invalid seeds; the tool response explains if none remain.
  }
 }
 return unique(sites).slice(0, maxSites)
}

function planCandidateUrls(items: DiscoveredUrl[], options: {strategy: SearchStrategy; maxPages: number; perSiteCap: number}) {
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

function originOf(url: string) {
 try {
  return new URL(url).origin
 } catch {
  return ''
 }
}

function countOrigins(items: DiscoveredUrl[]) {
 return new Set(items.map(item => originOf(item.url)).filter(Boolean)).size
}

function buildPlanText(input: {query: string; sites: string[]; urls: DiscoveredUrl[]; maxPages: number; pagesPerSite: number; strategy: SearchStrategy; directUrlMode: boolean; discoveries: Awaited<ReturnType<typeof discoverSiteUrls>>[]}) {
 const originCounts = new Map<string, number>()
 for (const item of input.urls) originCounts.set(originOf(item.url), (originCounts.get(originOf(item.url)) ?? 0) + 1)
 const lines = [
  `Search plan: ${input.directUrlMode ? 'direct URL' : `${input.strategy} divide-and-conquer`} strategy for \`${input.query}\`.`,
  `Scope: ${input.sites.length} site seed(s), ${input.urls.length}/${input.maxPages} final candidate URL(s), cap ${input.pagesPerSite} per site.`,
  `Breadth: ${
   Array.from(originCounts.entries())
    .map(([origin, count]) => `${origin}=${count}`)
    .join(', ') || 'n/a'
  }.`
 ]
 const errors = input.discoveries.flatMap(discovery => discovery.errors.map(error => `${discovery.site}: ${error}`))
 if (errors.length > 0) lines.push(`Discovery notes: ${errors.slice(0, 6).join('; ')}`)
 return lines.join('\n')
}

async function mapLimited<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>) {
 const output: R[] = []
 output.length = items.length
 let cursor = 0
 const runners = Array.from({length: Math.min(concurrency, Math.max(1, items.length))}, async () => {
  while (cursor < items.length) {
   const index = cursor
   cursor += 1
   output[index] = await worker(items[index], index)
  }
 })
 await Promise.all(runners)
 return output
}
