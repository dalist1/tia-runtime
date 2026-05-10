import {existsSync, readFileSync} from 'node:fs'
import {join, resolve} from 'node:path'
import {normalizeHttpUrl} from './text.ts'
import type {DiscoveredUrl, FetchedPage} from './types.ts'

export type SourcePackEntry = {url: string; contentType?: string; text?: string; path?: string; priority?: number; updatedAt?: string; ttlMs?: number}

type SourcePackManifest = {name?: string; generatedAt?: string; ttlMs?: number; entries?: SourcePackEntry[]}

export type SourcePackPage = FetchedPage & {source: string}
export type SourcePackStats = {roots: number; freshEntries: number; staleEntries: number; skippedEntries: number; errors: string[]}
export type SourcePackSnapshot = {candidates: DiscoveredUrl[]; pages: Map<string, SourcePackPage>; stats: SourcePackStats}

export function loadSourcePackSnapshot(options: {roots: string[]; sites: string[]; now?: number}): SourcePackSnapshot {
 const pages = new Map<string, SourcePackPage>()
 const candidates: DiscoveredUrl[] = []
 const stats: SourcePackStats = {roots: options.roots.length, freshEntries: 0, staleEntries: 0, skippedEntries: 0, errors: []}
 const allowedOrigins = new Set(options.sites.map(originOf).filter(Boolean))
 const now = options.now ?? Date.now()

 for (const rawRoot of options.roots) {
  const root = resolve(rawRoot)
  const manifestPath = join(root, 'manifest.json')
  if (!existsSync(manifestPath)) {
   stats.errors.push(`${root}: missing manifest.json`)
   continue
  }
  try {
   const manifest: SourcePackManifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
   const label = `source-pack:${manifest.name?.trim() || basenameLabel(root)}`
   for (const entry of manifest.entries ?? []) {
    const normalized = normalizeEntryUrl(entry.url)
    if (!normalized || !isAllowedOrigin(normalized, allowedOrigins)) {
     stats.skippedEntries += 1
     continue
    }
    if (isStaleEntry(entry, manifest, now)) {
     stats.staleEntries += 1
     continue
    }
    const text = entry.text ?? readEntryText(root, entry.path)
    if (!text?.trim()) {
     stats.skippedEntries += 1
     continue
    }
    const page: SourcePackPage = {url: normalized, contentType: entry.contentType ?? inferContentType(entry.path), text, source: label}
    pages.set(normalized, page)
    candidates.push({url: normalized, source: label, priority: entry.priority ?? 145})
    stats.freshEntries += 1
   }
  } catch (error) {
   stats.errors.push(`${root}: ${error instanceof Error ? error.message : String(error)}`)
  }
 }

 return {candidates, pages, stats}
}

export function resolveSourcePackPage(snapshot: SourcePackSnapshot | undefined, url: string): SourcePackPage | undefined {
 if (!snapshot) return undefined
 const normalized = normalizeEntryUrl(url)
 return normalized ? snapshot.pages.get(normalized) : undefined
}

function normalizeEntryUrl(url: string | undefined) {
 if (!url) return ''
 try {
  return normalizeHttpUrl(url)
 } catch {
  return ''
 }
}

function originOf(url: string) {
 try {
  return new URL(url).origin
 } catch {
  return ''
 }
}

function isAllowedOrigin(url: string, allowedOrigins: Set<string>) {
 if (allowedOrigins.size === 0) return false
 return allowedOrigins.has(originOf(url))
}

function isStaleEntry(entry: SourcePackEntry, manifest: SourcePackManifest, now: number) {
 const ttlMs = entry.ttlMs ?? manifest.ttlMs
 if (!ttlMs || ttlMs <= 0) return false
 const timestamp = Date.parse(entry.updatedAt ?? manifest.generatedAt ?? '')
 if (!Number.isFinite(timestamp)) return false
 return timestamp + ttlMs <= now
}

function readEntryText(root: string, relativePath: string | undefined) {
 if (!relativePath) return undefined
 const absolute = resolve(root, relativePath)
 if (!absolute.startsWith(`${resolve(root)}/`) || !existsSync(absolute)) return undefined
 return readFileSync(absolute, 'utf8')
}

function inferContentType(path: string | undefined) {
 if (path && /\.(md|mdx|markdown)$/i.test(path)) return 'text/markdown'
 if (path && /\.html?$/i.test(path)) return 'text/html'
 return 'text/plain'
}

function basenameLabel(root: string) {
 const parts = root.split(/[\\/]+/).filter(Boolean)
 return parts.at(-1) ?? 'local'
}
