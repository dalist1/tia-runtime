import {describe, expect, test} from 'bun:test'
import {chmodSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import type {SourcePackSnapshot} from './source-pack.ts'

function withFakeZig<T>(run: (binPath: string) => Promise<T>) {
 const root = mkdtempSync(join(tmpdir(), 'native-search-zig-test-'))
 const binPath = join(root, 'fake-zig.js')
 writeFileSync(
  binPath,
  `#!/usr/bin/env bun
import {readFileSync} from 'node:fs'
const corpus = readFileSync(process.argv[5], 'utf8').trim()
const rows = corpus ? corpus.split('\\n') : []
const first = rows[0]?.split('\t') ?? []
const url = first[0] ? Buffer.from(first[0], 'base64').toString('utf8') : 'https://example.com/missing'
const text = first[2] ? Buffer.from(first[2], 'base64').toString('utf8') : ''
console.log([
 'Native Zig search found ' + rows.length + ' result(s).',
 '',
 '## 1. Cached Result',
 '',
 url,
 '',
 'Score: 72; kind=markdown; contentType=text/markdown',
 '',
 'Snippet: ' + text.slice(0, 80)
].join('\\n'))
`
 )
 chmodSync(binPath, 0o755)
 return run(binPath).finally(() => rmSync(root, {recursive: true, force: true}))
}

describe('native search pipeline source packs', () => {
 test('uses source-pack cache hits without live fetching them', async () => {
  await withFakeZig(async binPath => {
   process.env.TIA_NATIVE_SEARCH_ZIG_BIN = binPath
   const {runNativeFetchAndRank} = await import(`./pipeline.ts?source-pack-test=${Date.now()}`)
   const snapshot: SourcePackSnapshot = {
    candidates: [],
    pages: new Map([['https://docs.example.com/cached-api', {url: 'https://docs.example.com/cached-api', contentType: 'text/markdown', text: 'Cached source-pack API text', source: 'source-pack:fixture-docs'}]]),
    stats: {roots: 1, freshEntries: 1, staleEntries: 0, skippedEntries: 0, errors: []}
   }

   const response = await runNativeFetchAndRank({
    query: 'cached api',
    timeoutMs: 1000,
    urls: [{url: 'https://docs.example.com/cached-api', source: 'source-pack:fixture-docs', priority: 160}],
    plannedUrlCount: 1,
    maxResults: 1,
    contentChars: 1000,
    outputContent: false,
    started: performance.now(),
    discoveries: [],
    discoveryRecords: [],
    timings: {discoveryMs: 0, planningMs: 0},
    directUrlMode: false,
    includePlan: false,
    plan: undefined,
    sourcePackSnapshot: snapshot
   })

   expect(response.details?.resultCount).toBe(1)
   expect(response.details?.requestedResultCount).toBe(1)
   expect(response.details?.sourcePackUrlCount).toBe(1)
   expect(response.details?.liveFetchedUrlCount).toBe(0)
   expect(response.details?.fetchedUrlCount).toBe(1)
   expect(response.details?.results?.[0]?.url).toBe('https://docs.example.com/cached-api')
   expect(response.content[0]?.text).toContain('Cached source-pack API text')
  })
 })
})
