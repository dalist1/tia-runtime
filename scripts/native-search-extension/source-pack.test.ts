import {describe, expect, test} from 'bun:test'
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createSearchPlan} from './search-plan.ts'
import {loadSourcePackSnapshot, resolveSourcePackPage} from './source-pack.ts'
import type {DiscoveredUrl} from './types.ts'

function withPack<T>(manifest: unknown, run: (root: string) => T) {
 const root = mkdtempSync(join(tmpdir(), 'native-search-source-pack-'))
 try {
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2))
  return run(root)
 } finally {
  rmSync(root, {recursive: true, force: true})
 }
}

describe('native search source-pack cache seam', () => {
 test('loads fresh filesystem fixtures as cache hits with provenance labels', () => {
  withPack({name: 'fixture-docs', generatedAt: '2026-05-09T00:00:00.000Z', ttlMs: 60_000, entries: [{url: 'https://docs.example.com/guide', contentType: 'text/markdown', text: '# Guide\nCached source pack text.', priority: 150}]}, root => {
   const snapshot = loadSourcePackSnapshot({roots: [root], sites: ['https://docs.example.com'], now: Date.parse('2026-05-09T00:00:30.000Z')})
   const page = resolveSourcePackPage(snapshot, 'https://docs.example.com/guide')

   expect(snapshot.candidates).toEqual([{url: 'https://docs.example.com/guide', source: 'source-pack:fixture-docs', priority: 150}])
   expect(page).toMatchObject({url: 'https://docs.example.com/guide', contentType: 'text/markdown', text: '# Guide\nCached source pack text.', source: 'source-pack:fixture-docs'})
   expect(snapshot.stats).toMatchObject({roots: 1, freshEntries: 1, staleEntries: 0, skippedEntries: 0})
  })
 })

 test('treats absent entries as cache misses without fabricating pages', () => {
  withPack({name: 'fixture-docs', entries: [{url: 'https://docs.example.com/guide', text: 'Cached'}]}, root => {
   const snapshot = loadSourcePackSnapshot({roots: [root], sites: ['https://docs.example.com'], now: Date.parse('2026-05-09T00:00:00.000Z')})

   expect(resolveSourcePackPage(snapshot, 'https://docs.example.com/missing')).toBeUndefined()
   expect(snapshot.stats).toMatchObject({freshEntries: 1, staleEntries: 0})
  })
 })

 test('excludes stale fixture entries from candidates and cache hits', () => {
  withPack({name: 'fixture-docs', generatedAt: '2026-05-09T00:00:00.000Z', ttlMs: 1_000, entries: [{url: 'https://docs.example.com/stale', text: 'stale text'}]}, root => {
   const snapshot = loadSourcePackSnapshot({roots: [root], sites: ['https://docs.example.com'], now: Date.parse('2026-05-09T00:00:02.000Z')})

   expect(snapshot.candidates).toEqual([])
   expect(resolveSourcePackPage(snapshot, 'https://docs.example.com/stale')).toBeUndefined()
   expect(snapshot.stats).toMatchObject({freshEntries: 0, staleEntries: 1})
  })
 })

 test('merges source-pack candidates with live discovery under explicit site bounds', () => {
  withPack(
   {
    name: 'fixture-docs',
    entries: [
     {url: 'https://docs.example.com/cached-api', text: 'cached api', priority: 160},
     {url: 'https://other.example.com/out-of-scope', text: 'skip me', priority: 200}
    ]
   },
   root => {
    const live: DiscoveredUrl[] = [{url: 'https://docs.example.com/live-api', source: 'page links', priority: 90}]
    const snapshot = loadSourcePackSnapshot({roots: [root], sites: ['https://docs.example.com'], now: Date.parse('2026-05-09T00:00:00.000Z')})
    const plan = createSearchPlan({
     candidates: [...live, ...snapshot.candidates],
     sites: ['https://docs.example.com'],
     query: 'api docs',
     queryTerms: ['api', 'docs'],
     strategy: 'balanced',
     directUrlMode: false,
     maxResults: 2,
     maxPages: 3,
     pagesPerSite: 3,
     explicitFetchPages: false,
     fetchPages: undefined,
     adaptiveFetch: undefined
    })

    expect(plan.plannedUrls.map(item => item.url)).toContain('https://docs.example.com/cached-api')
    expect(plan.plannedUrls.map(item => item.url)).toContain('https://docs.example.com/live-api')
    expect(plan.plannedUrls.map(item => item.url)).not.toContain('https://other.example.com/out-of-scope')
    expect(plan.rankedUrls[0]).toMatchObject({url: 'https://docs.example.com/cached-api', source: 'source-pack:fixture-docs'})
   }
  )
 })
})
