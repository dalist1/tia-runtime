import {setTimeout as delay} from 'node:timers/promises'
import {SEARCH_USER_AGENT, baseOriginIntervalMs, cacheTtlMs} from './config.ts'
import {logFetchEvent} from './observability.ts'
import {normalizeHttpUrl, nowMs} from './text.ts'
import type {FetchCacheEntry, FetchTextOptions, FetchTextResult} from './types.ts'

const fetchCache = new Map<string, FetchCacheEntry>()
const originQueues = new Map<string, Promise<void>>()
const originLastFetchAt = new Map<string, number>()

function ensureNotAborted(signal?: AbortSignal) {
 if (signal?.aborted) throw new Error('Operation aborted')
}

export function originIntervalMs() {
 return baseOriginIntervalMs()
}

export async function fetchTextUrl(urlString: string, options: FetchTextOptions) {
 const normalized = normalizeHttpUrl(urlString)
 const accept = options.accept ?? 'text/markdown,text/plain;q=0.95,text/html;q=0.9,application/xhtml+xml;q=0.8,*/*;q=0.2'
 const key = `${normalized}\n${accept}`
 const cached = fetchCache.get(key)
 if (cached && cached.expiresAt > nowMs()) {
  const origin = new URL(normalized).origin
  logFetchEvent({url: normalized, origin, cacheStatus: 'hit', fetchMs: 0})
  return responseFromCache(cached)
 }

 const url = new URL(normalized)
 validateUrlNotPrivate(url)
 const origin = url.origin
 return withOriginRateLimit(origin, options.signal, async () => {
  ensureNotAborted(options.signal)
  const timed = abortSignalWithTimeout(options.signal, options.timeoutMs)
  const fetchStarted = performance.now()
  try {
   const response = await fetch(normalized, {headers: {accept, 'accept-language': 'en-US,en;q=0.8', 'user-agent': SEARCH_USER_AGENT}, redirect: 'follow', signal: timed.signal})
   const fetchMs = performance.now() - fetchStarted
   // Validate final URL after redirect to prevent SSRF via redirect chains.
   const finalUrl = normalizeHttpUrl(response.url || normalized)
   const finalParsed = new URL(finalUrl)
   if (finalParsed.origin !== url.origin) validateUrlNotPrivate(finalParsed)
   const body = await responseBodyToText(response, options.maxBytes)
   const result: FetchTextResult = {url: normalized, finalUrl, status: response.status, contentType: response.headers.get('content-type') ?? '', text: body.text, bytes: body.bytes, truncated: body.truncated, fromCache: false}
   logFetchEvent({url: normalized, origin, cacheStatus: 'miss', fetchMs, status: response.status, truncated: body.truncated, bytes: body.bytes})
   if (!response.ok && !options.allowHttpErrors) throw new Error(`HTTP ${response.status} fetching ${normalized}`)
   const ttl = cacheTtlMs()
   if (ttl > 0 && response.ok) fetchCache.set(key, {...result, expiresAt: nowMs() + ttl})
   return result
  } catch (error) {
   const fetchMs = performance.now() - fetchStarted
   logFetchEvent({url: normalized, origin, cacheStatus: 'miss', fetchMs, error: error instanceof Error ? error.message : String(error)})
   throw error
  } finally {
   timed.clear()
  }
 })
}

function validateUrlNotPrivate(url: URL) {
 const hostname = url.hostname.toLowerCase()
 // Pattern-based URL validation — blocks private/reserved addresses before fetching.
 // DNS-based IP resolution adds latency and complexity; hostname patterns cover real-world SSRF attack surface.
 const PRIVATE_PATTERNS: Array<{label: string; test: (host: string) => boolean}> = [
  {label: 'loopback', test: h => h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0' || h.endsWith('.localhost')},
  {label: 'private-10', test: h => h.startsWith('10.')},
  {label: 'private-172', test: h => /^172\.(1[6-9]|2\d|3[01])\./.test(h)},
  {label: 'private-192', test: h => h.startsWith('192.168.') || h === '192.168'},
  {label: 'link-local', test: h => h.startsWith('169.254.')},
  {label: 'carrier-grade-nat', test: h => /^100\.(6[4-9]|\d{2}|1[0-1]\d|12[0-7])\./.test(h)},
  {label: 'mDNS', test: h => h.endsWith('.local')},
  {label: 'reserved', test: h => h.endsWith('.internal') || h.endsWith('.localdomain') || h.endsWith('.home.arpa')}
 ]
 for (const rule of PRIVATE_PATTERNS) {
  if (rule.test(hostname)) throw new Error(`SSRF blocked: ${rule.label} address (${hostname})`)
 }
}

async function withOriginRateLimit<T>(origin: string, signal: AbortSignal | undefined, task: () => Promise<T>) {
 const previous = originQueues.get(origin) ?? Promise.resolve()
 let release = () => {}
 const current = new Promise<void>(resolve => {
  release = resolve
 })
 const queued = previous.catch(() => undefined).then(() => current)
 originQueues.set(origin, queued)

 await previous.catch(() => undefined)
 try {
  ensureNotAborted(signal)
  const waitMs = (originLastFetchAt.get(origin) ?? 0) + originIntervalMs() - nowMs()
  if (waitMs > 0) await sleep(waitMs, signal)
  originLastFetchAt.set(origin, nowMs())
  return await task()
 } finally {
  release()
  if (originQueues.get(origin) === queued) originQueues.delete(origin)
 }
}

async function sleep(ms: number, signal?: AbortSignal) {
 await delay(ms, undefined, {signal}).catch(error => {
  if (signal?.aborted) throw new Error('Operation aborted')
  throw error
 })
}

function abortSignalWithTimeout(parent: AbortSignal | undefined, timeoutMs: number) {
 const controller = new AbortController()
 let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
  controller.abort(new Error(`Timed out after ${timeoutMs} ms`))
 }, timeoutMs)
 const abortFromParent = () => controller.abort(parent?.reason ?? new Error('Operation aborted'))
 if (parent) {
  if (parent.aborted) abortFromParent()
  else parent.addEventListener('abort', abortFromParent, {once: true})
 }
 return {
  signal: controller.signal,
  clear() {
   if (timer) {
    clearTimeout(timer)
    timer = undefined
   }
   parent?.removeEventListener('abort', abortFromParent)
  }
 }
}

function responseFromCache(entry: FetchCacheEntry): FetchTextResult {
 return {url: entry.url, finalUrl: entry.finalUrl, status: entry.status, contentType: entry.contentType, text: entry.text, bytes: entry.bytes, truncated: entry.truncated, fromCache: true}
}

async function responseBodyToText(response: Response, maxBytes: number) {
 if (!response.body) return {text: '', bytes: 0, truncated: false}
 const reader = response.body.getReader()
 const chunks: Buffer[] = []
 let total = 0
 let truncated = false

 while (true) {
  const {value, done} = await reader.read()
  if (done) break
  if (!value) continue
  const chunk = Buffer.from(value)
  if (total + chunk.length > maxBytes) {
   const remaining = Math.max(0, maxBytes - total)
   if (remaining > 0) chunks.push(chunk.subarray(0, remaining))
   total += remaining
   truncated = true
   await reader.cancel().catch(() => undefined)
   break
  }
  chunks.push(chunk)
  total += chunk.length
 }

 const contentType = response.headers.get('content-type') ?? ''
 const charset = parseCharset(contentType)
 const buffer = Buffer.concat(chunks, total)
 try {
  return {text: new TextDecoder(charset).decode(buffer), bytes: total, truncated}
 } catch {
  return {text: new TextDecoder('utf-8').decode(buffer), bytes: total, truncated}
 }
}

function parseCharset(contentType: string) {
 const match = contentType.match(/charset=([^;]+)/i)
 if (!match) return 'utf-8'
 return match[1].trim().replace(/^"|"$/g, '') || 'utf-8'
}
