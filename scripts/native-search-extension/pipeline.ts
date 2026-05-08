import {Buffer} from 'node:buffer'
import {existsSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {searchConcurrency} from './config.ts'
import {discoverSiteUrls} from './discover.ts'
import {fetchTextUrl} from './http.ts'
import {analyzeSearchQuality, parseZigSearchResults} from './results.ts'
import type {DiscoveredUrl, FetchedPage, ProgressEmitter, ToolTextResponse} from './types.ts'

const ZIG_SEARCH_BIN = process.env.TIA_NATIVE_SEARCH_ZIG_BIN ?? new URL('../../fast-tools/native-search-zig', import.meta.url).pathname

export type NativeFetchAndRankOptions = {
 query: string
 timeoutMs: number
 urls: DiscoveredUrl[]
 plannedUrlCount: number
 maxResults: number
 contentChars: number
 outputContent: boolean
 signal?: AbortSignal
 emit?: ProgressEmitter
 started: number
 discoveries: Awaited<ReturnType<typeof discoverSiteUrls>>[]
 discoveryRecords: {site: string; elapsedMs: number; discovery: Awaited<ReturnType<typeof discoverSiteUrls>>}[]
 timings: {discoveryMs: number; planningMs: number}
 directUrlMode: boolean
 includePlan: boolean
 plan: string | undefined
}

export function assertZigBackendExists() {
 if (!existsSync(ZIG_SEARCH_BIN)) {
  throw new Error(`native_search requires compiled Zig backend at ${ZIG_SEARCH_BIN}. Re-run install or bench/build-native-search-zig.sh.`)
 }
}

export async function runNativeFetchAndRank(options: NativeFetchAndRankOptions) {
 options.emit?.(`Fetching ${options.urls.length} bounded URL(s) with origin-aware concurrency.`)
 const fetchStarted = performance.now()
 const fetched = await mapLimited(options.urls, searchConcurrency(), async (item): Promise<FetchedPage | undefined> => {
  try {
   const result = await fetchTextUrl(item.url, {timeoutMs: options.timeoutMs, maxBytes: 2_000_000, signal: options.signal, allowHttpErrors: true})
   if (result.status < 200 || result.status >= 400 || !result.text.trim()) return undefined
   return {url: result.finalUrl || result.url, contentType: result.contentType, text: result.text}
  } catch {
   return undefined
  }
 })
 const fetchMs = performance.now() - fetchStarted
 return runZigExtractAndRank({...options, fetchedPages: fetched.filter(page => page !== undefined), fetchMs})
}

async function runZigExtractAndRank(options: NativeFetchAndRankOptions & {fetchedPages: FetchedPage[]; fetchMs: number}): Promise<ToolTextResponse> {
 options.emit?.(`Running Zig extract/rank for ${options.fetchedPages.length} fetched page(s).`)
 const zigStarted = performance.now()
 const corpusPath = join(tmpdir(), `tia-native-search-corpus-${process.pid}-${Date.now()}.tsv`)
 try {
  writeFileSync(corpusPath, encodeCorpus(options.fetchedPages))
  const proc = Bun.spawn([ZIG_SEARCH_BIN, options.query, String(options.maxResults), String(options.contentChars), corpusPath, options.outputContent ? '1' : '0'], {stdout: 'pipe', stderr: 'pipe', signal: options.signal})
  const [stdoutText, stderrText, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (exitCode !== 0) throw new Error(stderrText.trim() || `native-search-zig exited with code ${exitCode}`)
  const zigMs = performance.now() - zigStarted
  const totalMs = performance.now() - options.started
  return {
   content: [{type: 'text', text: options.includePlan ? `${options.plan}\n\n${stdoutText.trimEnd()}` : stdoutText.trimEnd()}],
   details: {
    backend: 'bun-fetch-zig-extract-rank',
    query: options.query,
    resultCount: options.maxResults,
    candidateUrlCount: options.plannedUrlCount,
    fetchedUrlCount: options.fetchedPages.length,
    results: parseZigSearchResults(stdoutText),
    elapsedMs: totalMs,
    directUrlMode: options.directUrlMode,
    outputContent: options.outputContent,
    plan: options.plan,
    timings: {discoveryMs: options.timings.discoveryMs, planningMs: options.timings.planningMs, fetchMs: options.fetchMs, zigMs, totalMs},
    quality: analyzeSearchQuality(stdoutText),
    perSite: options.discoveryRecords.map(record => ({site: record.site, elapsedMs: record.elapsedMs, discoveredUrlCount: record.discovery.urls.length, errorCount: record.discovery.errors.length})),
    discoveryErrors: options.discoveries.flatMap(discovery => discovery.errors)
   }
  }
 } finally {
  rmSync(corpusPath, {force: true})
 }
}

function encodeCorpus(pages: FetchedPage[]) {
 return (
  pages
   .map(page => {
    const url = Buffer.from(page.url, 'utf8').toString('base64')
    const contentType = Buffer.from(page.contentType || 'text/plain', 'utf8').toString('base64')
    const text = Buffer.from(page.text, 'utf8').toString('base64')
    return `${url}\t${contentType}\t${text}`
   })
   .join('\n') + '\n'
 )
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
