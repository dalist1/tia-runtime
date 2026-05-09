import {describe, expect, test} from 'bun:test'
import {createSearchPlan, fetchPriority, likelyDocUrls} from './search-plan.ts'
import type {DiscoveredUrl} from './types.ts'

const candidates: DiscoveredUrl[] = [
 {url: 'https://a.example/docs/one', source: 'seed', priority: 100},
 {url: 'https://a.example/docs/two', source: 'page links', priority: 90},
 {url: 'https://b.example/docs/one', source: 'seed', priority: 100},
 {url: 'https://b.example/docs/two', source: 'page links', priority: 90},
 {url: 'https://c.example/docs/one', source: 'seed', priority: 100}
]

describe('SearchPlan candidate planning', () => {
 test('generates likely docs slugs from docs seeds and query terms', () => {
  const urls = likelyDocUrls(['https://playwright.dev/docs'], ['playwright', 'locator', 'getbyrole', 'auto', 'waiting', 'assertions', 'documentation'])

  expect(urls.map(item => item.url)).toContain('https://playwright.dev/docs/locators')
  expect(urls.map(item => item.url)).not.toContain('https://playwright.dev/docs/playwright')
  expect(urls.map(item => item.url)).not.toContain('https://playwright.dev/docs/auto-waiting')
  expect(fetchPriority(urls.find(item => item.url === 'https://playwright.dev/docs/locators')!, ['locator', 'getbyrole', 'auto', 'waiting', 'assertions'])).toBeGreaterThan(
   fetchPriority({url: 'https://playwright.dev/docs/api/class-locatorassertions', source: 'page links', priority: 126}, ['locator', 'getbyrole', 'auto', 'waiting', 'assertions'])
  )
 })

 test('prefers seed path query matches over unrelated llms product indexes', () => {
  const queryTerms = ['cloudflare', 'workers', 'nodejs', 'compatibility', 'module', 'not', 'found', 'error', 'fix']
  const workersSeed = {url: 'https://developers.cloudflare.com/workers', source: 'seed', priority: 100}
  const unrelatedLlms = {url: 'https://developers.cloudflare.com/cloudflare-challenges/llms.txt', source: 'llms', priority: 110}

  expect(fetchPriority(workersSeed, queryTerms)).toBeGreaterThan(fetchPriority(unrelatedLlms, queryTerms))
 })
})

describe('SearchPlan lifecycle', () => {
 test('direct URL planning fetches explicit URLs once and stops as caller-owned', () => {
  const plan = createSearchPlan({
   candidates: candidates.slice(0, 2),
   sites: ['https://a.example/docs/one', 'https://a.example/docs/two'],
   query: 'read urls',
   queryTerms: ['read', 'urls'],
   strategy: 'direct',
   directUrlMode: true,
   maxResults: 5,
   maxPages: 12,
   pagesPerSite: 8,
   explicitFetchPages: true,
   fetchPages: 1,
   adaptiveFetch: true
  })

  expect(plan.firstBatch().map(item => item.url)).toEqual(['https://a.example/docs/one', 'https://a.example/docs/two'])
  expect(plan.decideNext({quality: undefined, fetchedUrlCount: 0})).toMatchObject({done: true, stoppedReason: 'direct_url_mode', recover: false})
 })

 test('balanced planning batches and recovers after empty first batch', () => {
  const plan = createSearchPlan({
   candidates,
   sites: ['https://a.example', 'https://b.example', 'https://c.example'],
   query: 'docs one',
   queryTerms: ['docs', 'one'],
   strategy: 'balanced',
   directUrlMode: false,
   maxResults: 2,
   maxPages: 5,
   pagesPerSite: 2,
   explicitFetchPages: false,
   fetchPages: undefined,
   adaptiveFetch: undefined
  })

  expect(plan.plannedUrls).toHaveLength(5)
  expect(plan.firstBatch()).toHaveLength(5)
  const decision = plan.decideNext({quality: {resultCount: 0, topScore: 0, avgTop3Score: 0, goodResultCount: 0, scoreSpread: 0}, fetchedUrlCount: 0})
  expect(decision).toMatchObject({done: true, stoppedReason: 'exhausted_candidates'})
 })
})
