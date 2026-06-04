export function nowMs() {
 return Date.now()
}

export function normalizeHttpUrl(urlString: string) {
 let url: URL
 try {
  url = new URL(urlString)
 } catch {
  throw new Error(`Invalid URL: ${urlString}`)
 }
 if (url.protocol !== 'http:' && url.protocol !== 'https:') {
  throw new Error(`Only http(s) URLs are supported: ${urlString}`)
 }
 url.username = ''
 url.password = ''
 url.hash = ''
 return url.toString()
}

export function extractUrls(text: string) {
 const urls: string[] = []
 const urlPattern = /https?:\/\/[^\s<>)"']+/gi
 for (const match of text.matchAll(urlPattern)) {
  let candidate = match[0].replace(/[),.;:!?]+$/g, '')
  try {
   candidate = normalizeHttpUrl(candidate)
   urls.push(candidate)
  } catch {
   // Ignore malformed URL-shaped text.
  }
 }
 return unique(urls)
}

export function unique<T>(items: T[]) {
 return Array.from(new Set(items))
}

export function allowPrivateHosts() {
 return process.env.TIA_NATIVE_SEARCH_ALLOW_PRIVATE === '1'
}

export function isBlockedHost(hostname: string) {
 if (allowPrivateHosts()) return false
 const host = hostname
  .trim()
  .replace(/^\[|\]$/g, '')
  .toLowerCase()
 if (!host || host === 'localhost' || host.endsWith('.localhost')) return true
 if (host.includes(':')) return isBlockedIpv6(host)
 const ipv4 = parseIpv4(host)
 if (ipv4) return isBlockedIpv4(ipv4)
 return false
}

function parseIpv4(host: string): number[] | undefined {
 const parts = host.split('.')
 if (parts.length !== 4) return undefined
 const octets: number[] = []
 for (const part of parts) {
  if (!/^\d{1,3}$/.test(part)) return undefined
  const value = Number(part)
  if (value > 255) return undefined
  octets.push(value)
 }
 return octets
}

function isBlockedIpv4(octets: number[]) {
 const [a, b] = octets
 if (a === 0) return true
 if (a === 127) return true
 if (a === 10) return true
 if (a === 172 && b >= 16 && b <= 31) return true
 if (a === 192 && b === 168) return true
 if (a === 169 && b === 254) return true
 return false
}

function isBlockedIpv6(host: string) {
 const bare = host.replace(/%.*$/, '')
 if (bare === '::1' || bare === '::') return true
 const dottedMapped = bare.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
 if (dottedMapped) {
  const octets = parseIpv4(dottedMapped[1])
  return octets ? isBlockedIpv4(octets) : true
 }
 const hexMapped = bare.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
 if (hexMapped) {
  const high = Number.parseInt(hexMapped[1], 16)
  const low = Number.parseInt(hexMapped[2], 16)
  return isBlockedIpv4([(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff])
 }
 if (/^fe[89ab][0-9a-f]:/.test(bare)) return true
 if (/^f[cd][0-9a-f]{2}:/.test(bare)) return true
 return false
}

export function decodeHtmlEntities(text: string) {
 const named: Record<string, string> = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', copy: '©', reg: '®', trade: '™'}
 return text.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/gi, (match, entity) => {
  const key = String(entity).toLowerCase()
  if (key.startsWith('#x')) {
   const codePoint = Number.parseInt(key.slice(2), 16)
   return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match
  }
  if (key.startsWith('#')) {
   const codePoint = Number.parseInt(key.slice(1), 10)
   return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match
  }
  return named[key] ?? match
 })
}

export function cleanInlineText(text: string) {
 return decodeHtmlEntities(text.replace(/<[^>]+>/g, ' '))
  .replace(/\s+/g, ' ')
  .trim()
}

export function tokenizeQuery(query: string) {
 const withoutUrls = query.replace(/https?:\/\/[^\s<>)"']+/gi, ' ')
 const tokens = withoutUrls
  .toLowerCase()
  .replace(/[^a-z0-9_+.#-]+/g, ' ')
  .split(/\s+/)
  .map(token => token.trim())
  .filter(token => token.length >= 2 && !STOP_WORDS.has(token))
 return unique(tokens).slice(0, 16)
}

export function absolutizeUrl(href: string, baseUrl: string) {
 if (!href || /^(javascript|mailto|tel):/i.test(href)) return ''
 try {
  return normalizeHttpUrl(new URL(href, baseUrl).toString())
 } catch {
  return ''
 }
}

const STOP_WORDS = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how', 'in', 'into', 'is', 'it', 'of', 'on', 'or', 'the', 'to', 'with'])
