import {describe, expect, test} from 'bun:test'
import {parseZigSearchResults} from './results.ts'
import {classifySearchIntent, fetchPriority, resolveFetchPolicy} from './tool.ts'

describe('native search result metadata', () => {
 test('parses structured result metadata from Zig text output', () => {
  const results = parseZigSearchResults(
   [
    'Native Zig search found 2 result(s) for `native search`.',
    '',
    '## 1. Native Search Guide',
    '',
    'https://example.com/native-search',
    '',
    'Score: 72; kind=html; contentType=text/html',
    'ScoreBreakdown: bm25=52; title=14; url=3; phrase=0; source=3',
    '',
    'Snippet: Native search keeps bounded sources fast.',
    '',
    'Full body content that should not be included in metadata.',
    '',
    '## 2. API Reference',
    '',
    'https://example.com/api',
    '',
    'Score: 41; kind=markdown; contentType=text/markdown',
    '',
    'Snippet: Reference docs for the API.'
   ].join('\n')
  )

  expect(results).toEqual([
   {rank: 1, title: 'Native Search Guide', url: 'https://example.com/native-search', score: 72, kind: 'html', contentType: 'text/html', snippet: 'Native search keeps bounded sources fast.', scoreBreakdown: {bm25: 52, title: 14, url: 3, phrase: 0, source: 3}},
   {rank: 2, title: 'API Reference', url: 'https://example.com/api', score: 41, kind: 'markdown', contentType: 'text/markdown', snippet: 'Reference docs for the API.'}
  ])
 })

 test('ignores markdown headings inside fetched result bodies', () => {
  const results = parseZigSearchResults(
   [
    'Native Zig search found 1 result(s) for `docs`.',
    '',
    '## 1. Actual Result',
    '',
    'https://example.com/docs',
    '',
    'Score: 33; kind=markdown; contentType=text/markdown',
    '',
    'Snippet: actual snippet',
    '',
    'Fetched body starts here.',
    '',
    '## 1. Installation',
    '',
    'This body heading is not followed by URL and score metadata.'
   ].join('\n')
  )

  expect(results).toHaveLength(1)
  expect(results[0].title).toBe('Actual Result')
 })
})

describe('native search URL pre-ranking', () => {
 test('prefers seed path query matches over unrelated llms product indexes', () => {
  const queryTerms = ['cloudflare', 'workers', 'nodejs', 'compatibility', 'module', 'not', 'found', 'error', 'fix']
  const workersSeed = {url: 'https://developers.cloudflare.com/workers', source: 'seed', priority: 100}
  const unrelatedLlms = {url: 'https://developers.cloudflare.com/cloudflare-challenges/llms.txt', source: 'llms', priority: 110}

  expect(fetchPriority(workersSeed, queryTerms)).toBeGreaterThan(fetchPriority(unrelatedLlms, queryTerms))
 })
})

describe('native search fetch policy', () => {
 test('direct URL mode fetches all planned URLs and disables adaptive fetch', () => {
  const policy = resolveFetchPolicy({query: 'read https://example.com/a https://example.com/b', queryTerms: ['read'], maxResults: 5, maxPages: 12, plannedUrlCount: 2, strategy: 'direct', directUrlMode: true, explicitFetchPages: true, fetchPages: 1, adaptiveFetch: true})

  expect(policy.initialFetchCount).toBe(2)
  expect(policy.batchSize).toBe(2)
  expect(policy.adaptive).toBe(false)
 })

 test('precise docs queries start with maxResults-sized fetch and avoid adaptive by default', () => {
  const intent = classifySearchIntent('React ViewTransition API documentation example', ['react', 'viewtransition', 'api', 'documentation', 'example'], 'balanced')
  const policy = resolveFetchPolicy({
   query: 'React ViewTransition API documentation example',
   queryTerms: ['react', 'viewtransition', 'api', 'documentation', 'example'],
   maxResults: 5,
   maxPages: 12,
   plannedUrlCount: 12,
   strategy: 'balanced',
   directUrlMode: false,
   explicitFetchPages: false,
   fetchPages: undefined,
   adaptiveFetch: undefined
  })

  expect(intent).toBe('precise')
  expect(policy.initialFetchCount).toBe(5)
  expect(policy.adaptive).toBe(false)
 })

 test('broad research queries keep adaptive fetch off unless requested', () => {
  const policy = resolveFetchPolicy({
   query: 'compare latest companies building AI browser automation tools pricing',
   queryTerms: ['compare', 'latest', 'companies', 'ai', 'browser', 'automation', 'tools', 'pricing'],
   maxResults: 5,
   maxPages: 12,
   plannedUrlCount: 12,
   strategy: 'balanced',
   directUrlMode: false,
   explicitFetchPages: false,
   fetchPages: undefined,
   adaptiveFetch: undefined
  })

  expect(policy.intent).toBe('broad')
  expect(policy.initialFetchCount).toBe(5)
  expect(policy.adaptive).toBe(false)
 })

 test('adaptive fetch can be explicitly enabled for broad research queries', () => {
  const policy = resolveFetchPolicy({
   query: 'compare latest companies building AI browser automation tools pricing',
   queryTerms: ['compare', 'latest', 'companies', 'ai', 'browser', 'automation', 'tools', 'pricing'],
   maxResults: 5,
   maxPages: 12,
   plannedUrlCount: 12,
   strategy: 'balanced',
   directUrlMode: false,
   explicitFetchPages: false,
   fetchPages: undefined,
   adaptiveFetch: true
  })

  expect(policy.intent).toBe('broad')
  expect(policy.adaptive).toBe(true)
 })

 test('explicit fetchPages remains caller-owned', () => {
  const policy = resolveFetchPolicy({
   query: 'compare latest companies building AI browser automation tools pricing',
   queryTerms: ['compare', 'latest', 'companies', 'ai', 'browser', 'automation', 'tools', 'pricing'],
   maxResults: 5,
   maxPages: 12,
   plannedUrlCount: 12,
   strategy: 'balanced',
   directUrlMode: false,
   explicitFetchPages: true,
   fetchPages: 3,
   adaptiveFetch: false
  })

  expect(policy.initialFetchCount).toBe(3)
  expect(policy.adaptive).toBe(false)
  expect(policy.reason).toContain('explicit fetchPages=3')
 })
})
