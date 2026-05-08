import {existsSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DEFAULT_CONTENT_CHARS, DEFAULT_MAX_PAGES, DEFAULT_MAX_RESULTS, DEFAULT_MAX_SITES, DEFAULT_PAGES_PER_SITE, DEFAULT_TIMEOUT_MS, HARD_MAX_CONTENT_CHARS, HARD_MAX_PAGES, HARD_MAX_PAGES_PER_SITE, HARD_MAX_RESULTS, HARD_MAX_SITES, clampInteger, envSeedSites, searchConcurrency} from './config.ts'
import {discoverSiteUrls} from './discover.ts'
import {originIntervalMs} from './http.ts'
import {extractUrls, normalizeHttpUrl, tokenizeQuery, unique} from './text.ts'
import type {DiscoveredUrl, NativeSearchParams, ProgressEmitter, ToolTextResponse} from './types.ts'

const COLLAPSED_RESULT_LIMIT = 3
const EXPANDED_RESULT_LIMIT = 8
const COLLAPSED_SNIPPET_CHARS = 140
const EXPANDED_SNIPPET_CHARS = 260
const COLLAPSED_TOTAL_CHARS = 500
const COLLAPSED_COMPACT_RESULT_CHARS = 120
const EXPANDED_TOTAL_CHARS = 1200
const ZIG_SEARCH_BIN = process.env.TIA_NATIVE_SEARCH_ZIG_BIN ?? new URL('../../fast-tools/native-search-zig', import.meta.url).pathname

type RenderOptions = {expanded?: boolean; expandHint?: string; isPartial?: boolean}
type ParsedSearchResult = {title: string; url: string; snippet?: string}

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

 if (sites.length === 0) {
  return {content: [{type: 'text', text: 'Native search is intentionally site-bounded and does not call third-party search engines. ' + 'Provide one or more `sites`, include URLs in `query`, or set TIA_NATIVE_SEARCH_SEEDS.'}], details: {query, resultCount: 0, reason: 'missing_sites'}}
 }

 const discoveries = directUrlMode
  ? []
  : await mapLimited(sites, Math.min(searchConcurrency(), sites.length), async site => {
     emit?.(`Discovering up to ${pagesPerSite} page(s): ${site}`)
     return discoverSiteUrls({site, pagesPerSite, timeoutMs, queryTerms, signal})
    })
 const discovered = directUrlMode ? sites.map(url => ({url, source: 'direct URL', priority: 100})) : discoveries.flatMap(discovery => discovery.urls)
 const urls = planCandidateUrls(discovered, {strategy, maxPages: directUrlMode ? Math.min(maxPages, sites.length) : maxPages, perSiteCap: pagesPerSite})

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
  emit,
  started,
  discoveries,
  directUrlMode,
  includePlan,
  plan: buildPlanText({query, sites, urls, maxPages, pagesPerSite, strategy, directUrlMode, discoveries})
 })
}

export function buildNativeSearchRenderText(result: ToolTextResponse, options: RenderOptions = {}) {
 if (options.isPartial) return 'Searching…'

 const fullText = textContent(result)
 const parsed = parseNativeSearchText(fullText)
 const detailCount = typeof result.details?.resultCount === 'number' ? result.details.resultCount : undefined
 const shownCount = parsed.resultCount ?? (parsed.results.length || detailCount || 0)
 const resultLabel = shownCount === 1 ? '1 result' : `${shownCount} results`
 const hasFullContent = result.details?.outputContent === true
 const limit = options.expanded ? EXPANDED_RESULT_LIMIT : COLLAPSED_RESULT_LIMIT
 const snippetLimit = options.expanded ? EXPANDED_SNIPPET_CHARS : COLLAPSED_SNIPPET_CHARS
 const totalLimit = options.expanded ? EXPANDED_TOTAL_CHARS : COLLAPSED_TOTAL_CHARS
 const lines = [`Native search: ${resultLabel}`]

 if (options.expanded && parsed.plan.length > 0) {
  lines.push(...parsed.plan.slice(0, 3).map(line => truncateLine(line, 180)))
 }

 const renderedResults = parsed.results.slice(0, limit)
 const compactResults = !options.expanded && renderedResults.length > 1
 for (const [index, item] of renderedResults.entries()) {
  if (compactResults) {
   const display = `${item.title || item.url} — ${item.url}`
   const deduped = item.title ? display : item.url
   lines.push(`${index + 1}. ${truncateLine(deduped, COLLAPSED_COMPACT_RESULT_CHARS)}`)
  } else {
   lines.push(`${index + 1}. ${truncateLine(item.title || item.url, 120)}`)
   if (item.url) lines.push(`   ${truncateLine(item.url, 180)}`)
   if (item.snippet) lines.push(`   ${truncateLine(squashWhitespace(item.snippet), snippetLimit)}`)
  }
 }

 const hiddenCount = parsed.results.length - renderedResults.length
 if (hiddenCount > 0) {
  const hint = options.expandHint ? `, ${options.expandHint}` : ''
  lines.push(`… ${hiddenCount} more result(s) hidden in terminal render${hint}`)
 }

 if (parsed.results.length === 0 && fullText.trim()) {
  lines.push(truncateLine(squashWhitespace(fullText), options.expanded ? 700 : 260))
 }

 if (hasFullContent) {
  const expandHint = options.expandHint ?? 'expand tool output'
  lines.push(options.expanded ? 'Full output remains truncated in UI; full data stays in tool context.' : `Full output truncated. ${expandHint}.`)
 }

 return truncateBlock(lines.join('\n'), totalLimit)
}

function textContent(result: ToolTextResponse) {
 return result.content
  .filter(part => part.type === 'text')
  .map(part => part.text)
  .join('\n')
}

function parseNativeSearchText(text: string) {
 const resultCount = Number(text.match(/Native Zig search found\s+(\d+)\s+result/)?.[1] ?? NaN)
 const lines = text.split('\n')
 const results: ParsedSearchResult[] = []
 let firstResultLine = -1

 for (let index = 0; index < lines.length; index += 1) {
  const heading = lines[index].match(/^##\s+\d+\.\s+(.+?)\s*$/)
  if (!heading) continue

  const urlLine = nextNonEmptyLine(lines, index + 1)
  const scoreLine = urlLine ? nextNonEmptyLine(lines, urlLine.index + 1) : undefined
  if (!urlLine?.text.match(/^https?:\/\/\S+/) || !scoreLine?.text.startsWith('Score:')) continue

  if (firstResultLine < 0) firstResultLine = index
  results.push({title: heading[1].trim(), url: urlLine.text.replace(/[).,;]+$/, ''), snippet: snippetAfterScore(lines, scoreLine.index + 1)})
 }

 const plan = (firstResultLine >= 0 ? lines.slice(0, firstResultLine) : []).map(line => line.trim()).filter(line => line && !line.startsWith('Native Zig search found'))

 return {plan, results, resultCount: Number.isFinite(resultCount) ? resultCount : undefined}
}

function nextNonEmptyLine(lines: string[], start: number) {
 for (let index = start; index < lines.length; index += 1) {
  const text = lines[index].trim()
  if (text) return {index, text}
 }
 return undefined
}

function snippetAfterScore(lines: string[], start: number) {
 const snippetLine = nextNonEmptyLine(lines, start)
 if (!snippetLine?.text.startsWith('Snippet:')) return undefined
 const snippetLines = [snippetLine.text.slice('Snippet:'.length).trim()]
 for (let index = snippetLine.index + 1; index < lines.length; index += 1) {
  const line = lines[index].trim()
  if (!line) break
  snippetLines.push(line)
 }
 const snippet = snippetLines.join(' ').trim()
 return snippet || undefined
}

function squashWhitespace(text: string) {
 return text.replace(/\s+/g, ' ').trim()
}

function truncateLine(text: string, maxChars: number) {
 const clean = text.replace(/\n/g, ' ')
 return clean.length <= maxChars ? clean : `${clean.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`
}

function truncateBlock(text: string, maxChars: number) {
 return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`
}

async function runZigNativeSearch(options: {
 query: string
 urls: DiscoveredUrl[]
 maxResults: number
 contentChars: number
 outputContent: boolean
 signal?: AbortSignal
 emit?: ProgressEmitter
 started: number
 discoveries: Awaited<ReturnType<typeof discoverSiteUrls>>[]
 directUrlMode: boolean
 includePlan: boolean
 plan: string
}): Promise<ToolTextResponse> {
 options.emit?.(`Running Zig fetch/extract/rank for ${options.urls.length} bounded URL(s).`)
 const urlPath = join(tmpdir(), `tia-native-search-urls-${process.pid}-${Date.now()}.txt`)
 try {
  writeFileSync(urlPath, `${options.urls.map(item => item.url).join('\n')}\n`)
  const proc = Bun.spawn([ZIG_SEARCH_BIN, '--urls', options.query, String(options.maxResults), String(options.contentChars), urlPath, String(originIntervalMs()), options.outputContent ? '1' : '0'], {stdout: 'pipe', stderr: 'pipe', signal: options.signal})
  const [stdoutText, stderrText, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (exitCode !== 0) throw new Error(stderrText.trim() || `native-search-zig exited with code ${exitCode}`)
  return {
   content: [{type: 'text', text: options.includePlan ? `${options.plan}\n\n${stdoutText.trimEnd()}` : stdoutText.trimEnd()}],
   details: {
    backend: 'zig-fetch-extract-rank',
    query: options.query,
    resultCount: options.maxResults,
    candidateUrlCount: options.urls.length,
    elapsedMs: performance.now() - options.started,
    directUrlMode: options.directUrlMode,
    outputContent: options.outputContent,
    plan: options.plan,
    discoveryErrors: options.discoveries.flatMap(discovery => discovery.errors)
   }
  }
 } finally {
  rmSync(urlPath, {force: true})
 }
}

type SearchStrategy = 'balanced' | 'deep' | 'direct'

function normalizeStrategy(value: string | undefined): SearchStrategy {
 return value === 'deep' || value === 'direct' ? value : 'balanced'
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
