import {setTimeout as delay} from 'node:timers/promises'
import {SEARCH_USER_AGENT, baseOriginIntervalMs, cacheTtlMs} from './config.ts'
import {isBlockedHost, normalizeHttpUrl, nowMs} from './text.ts'
import type {FetchCacheEntry, FetchTextOptions, FetchTextResult} from './types.ts'

const MAX_FETCH_CACHE_ENTRIES = 256
const MAX_REDIRECT_HOPS = 5
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
 if (cached && cached.expiresAt > nowMs()) return responseFromCache(cached)

 const url = new URL(normalized)
 if (isBlockedHost(url.hostname)) throw new Error(`Refusing to fetch private/loopback host ${url.hostname}`)
 return withOriginRateLimit(url.origin, options.signal, async () => {
  ensureNotAborted(options.signal)
  const timed = abortSignalWithTimeout(options.signal, options.timeoutMs)
  try {
   let current = normalized
   let response: Response | undefined
   for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
    const target = new URL(current)
    if (isBlockedHost(target.hostname)) throw new Error(`Refusing to fetch private/loopback host ${target.hostname}`)
    response = await fetch(current, {headers: {accept, 'accept-language': 'en-US,en;q=0.8', 'user-agent': SEARCH_USER_AGENT}, redirect: 'manual', signal: timed.signal})
    if (response.status < 300 || response.status >= 400) break
    const location = response.headers.get('location')
    if (!location) break
    await response.body?.cancel().catch(() => undefined)
    if (hop === MAX_REDIRECT_HOPS) throw new Error(`Too many redirects fetching ${normalized}`)
    current = normalizeHttpUrl(new URL(location, current).toString())
   }
   if (!response) throw new Error(`No response fetching ${normalized}`)
   const body = await responseBodyToText(response, options.maxBytes)
   const result: FetchTextResult = {url: normalized, finalUrl: normalizeHttpUrl(response.url || current), status: response.status, contentType: response.headers.get('content-type') ?? '', text: body.text, bytes: body.bytes, truncated: body.truncated, fromCache: false}
   if (!response.ok && !options.allowHttpErrors) throw new Error(`HTTP ${response.status} fetching ${normalized}`)
   const ttl = cacheTtlMs()
   if (ttl > 0 && response.ok) cacheFetchResult(key, {...result, expiresAt: nowMs() + ttl})
   return result
  } finally {
   timed.clear()
  }
 })
}

function cacheFetchResult(key: string, entry: FetchCacheEntry) {
 if (fetchCache.has(key)) fetchCache.delete(key)
 fetchCache.set(key, entry)
 while (fetchCache.size > MAX_FETCH_CACHE_ENTRIES) {
  const oldest = fetchCache.keys().next().value
  if (oldest === undefined) break
  fetchCache.delete(oldest)
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
