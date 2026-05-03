import {DEFAULT_MAX_FETCH_BYTES, MAX_DISCOVERY_DOCS_PER_SITE} from './config.ts'
import {fetchTextUrl} from './http.ts'
import {absolutizeUrl, cleanInlineText, decodeHtmlEntities, extractUrls, normalizeHttpUrl, unique} from './text.ts'
import type {DiscoveredUrl, SiteDiscovery} from './types.ts'

export async function discoverSiteUrls(options: {site: string; pagesPerSite: number; timeoutMs: number; queryTerms?: string[]; signal?: AbortSignal}) {
 const seed = normalizeSite(options.site)
 const seedUrl = new URL(seed)
 const origin = seedUrl.origin
 const errors: string[] = []
 const found: DiscoveredUrl[] = [{url: seed, source: 'seed', priority: 100}]
 const docs = defaultDiscoveryDocs(seed)

 const queue = unique(docs).slice(0, MAX_DISCOVERY_DOCS_PER_SITE)
 for (let index = 0; index < queue.length && index < MAX_DISCOVERY_DOCS_PER_SITE; index += 1) {
  const docUrl = queue[index]
  try {
   const fetched = await fetchTextUrl(docUrl, {timeoutMs: options.timeoutMs, maxBytes: DEFAULT_MAX_FETCH_BYTES, signal: options.signal, allowHttpErrors: true})
   if (fetched.status >= 400) {
    errors.push(`${docUrl}: HTTP ${fetched.status}`)
    continue
   }
   const parsed = parseDiscoveryDocument(fetched.text, fetched.finalUrl, fetched.contentType)
   for (const url of parsed.urls) {
    if (!sameOrigin(origin, url)) continue
    found.push({url, source: labelFor(docUrl), priority: priorityFor(url, parsed.kind, options.queryTerms ?? [])})
   }
   for (const sitemap of parsed.sitemaps) {
    if (queue.length >= MAX_DISCOVERY_DOCS_PER_SITE) break
    if (sameOrigin(origin, sitemap) && !queue.includes(sitemap)) queue.push(sitemap)
   }
  } catch (error) {
   errors.push(`${docUrl}: ${error instanceof Error ? error.message : String(error)}`)
  }
 }

 return compactDiscovery(seed, found, errors, options.pagesPerSite)
}

function normalizeSite(site: string) {
 const withProtocol = /^https?:\/\//i.test(site) ? site : `https://${site}`
 return normalizeHttpUrl(withProtocol)
}

function defaultDiscoveryDocs(seed: string) {
 const url = new URL(seed)
 const docs = [seed]
 docs.push(`${url.origin}/llms.txt`)
 docs.push(`${url.origin}/llms-full.txt`)
 docs.push(`${url.origin}/sitemap.xml`)
 docs.push(`${url.origin}/sitemap_index.xml`)
 if (url.pathname !== '/') docs.push(url.origin)
 return docs
}

function sameOrigin(origin: string, url: string) {
 try {
  return new URL(url).origin === origin
 } catch {
  return false
 }
}

function labelFor(url: string) {
 const path = new URL(url).pathname
 if (path.endsWith('llms.txt') || path.endsWith('llms-full.txt')) return 'llms'
 if (path.endsWith('.xml')) return 'sitemap'
 return 'page links'
}

function priorityFor(url: string, kind: string, queryTerms: string[]) {
 const parsed = new URL(url)
 const haystack = `${parsed.pathname} ${parsed.search}`.toLowerCase()
 let score = kind === 'llms' ? 90 : kind === 'sitemap' ? 70 : 50
 if (/\.(md|mdx|markdown|txt)$/i.test(parsed.pathname)) score += 20
 if (/docs|guide|manual|reference|api|learn|tutorial|examples/i.test(url)) score += 8
 for (const term of queryTerms) {
  if (term.length >= 2 && haystack.includes(term.toLowerCase())) score += 12
 }
 return score
}

function compactDiscovery(site: string, urls: DiscoveredUrl[], errors: string[], limit: number): SiteDiscovery {
 const best = new Map<string, DiscoveredUrl>()
 for (const item of urls) {
  let normalized = ''
  try {
   normalized = normalizeHttpUrl(item.url)
  } catch {
   continue
  }
  const current = best.get(normalized)
  if (!current || item.priority > current.priority) best.set(normalized, {...item, url: normalized})
 }
 const sorted = Array.from(best.values()).sort((a, b) => b.priority - a.priority || a.url.localeCompare(b.url))
 return {site, urls: sorted.slice(0, limit), errors}
}

function parseDiscoveryDocument(text: string, baseUrl: string, contentType: string) {
 const looksXml = /xml|sitemap/i.test(contentType) || /<\s*(urlset|sitemapindex)\b/i.test(text)
 if (looksXml) return parseSitemap(text, baseUrl)
 const path = new URL(baseUrl).pathname
 if (/llms(?:-full)?\.txt$/i.test(path)) return parseLlms(text, baseUrl)
 return parsePageLinks(text, baseUrl, contentType)
}

function parseSitemap(text: string, baseUrl: string) {
 const urls: string[] = []
 const sitemaps: string[] = []
 for (const match of text.matchAll(/<loc[^>]*>([\s\S]*?)<\/loc>/gi)) {
  const loc = normalizeMaybeUrl(decodeHtmlEntities(cleanInlineText(match[1])), baseUrl)
  if (!loc) continue
  if (/\.xml(?:\.gz)?(?:$|[?#])/i.test(new URL(loc).pathname)) sitemaps.push(loc)
  else urls.push(loc)
 }
 return {kind: 'sitemap', urls: unique(urls), sitemaps: unique(sitemaps)}
}

function parseLlms(text: string, baseUrl: string) {
 const urls = markdownLinks(text, baseUrl)
 urls.push(...extractUrls(text))
 return {kind: 'llms', urls: unique(urls), sitemaps: []}
}

function parsePageLinks(text: string, baseUrl: string, contentType: string) {
 const urls = /html/i.test(contentType) || /<a\b/i.test(text) ? htmlLinks(text, baseUrl) : markdownLinks(text, baseUrl)
 urls.push(...extractUrls(text))
 return {kind: 'page', urls: unique(urls), sitemaps: []}
}

function markdownLinks(text: string, baseUrl: string) {
 const urls: string[] = []
 for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
  const url = normalizeMaybeUrl(match[1], baseUrl)
  if (url) urls.push(url)
 }
 return urls
}

function htmlLinks(text: string, baseUrl: string) {
 const urls: string[] = []
 for (const match of text.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi)) {
  const url = absolutizeUrl(decodeHtmlEntities(match[1]), baseUrl)
  if (url) urls.push(url)
 }
 return urls
}

function normalizeMaybeUrl(raw: string, baseUrl: string) {
 const cleaned = raw.trim().replace(/[),.;:!?]+$/g, '')
 if (!cleaned || /^(mailto|tel|javascript):/i.test(cleaned)) return ''
 try {
  return normalizeHttpUrl(new URL(cleaned, baseUrl).toString())
 } catch {
  return ''
 }
}
