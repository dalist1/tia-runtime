import {describe, expect, test} from 'bun:test'
import {analyzeSearchQuality, nativeSearchRoutingFromDetails, parseZigSearchResults, searchQualityFromDetails} from './results.ts'

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
   {rank: 2, title: 'API Reference', url: 'https://example.com/api', score: 41, kind: 'markdown', contentType: 'text/markdown', snippet: 'Reference docs for the API.', scoreBreakdown: undefined}
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

 test('analyzes score quality from Zig output', () => {
  const quality = analyzeSearchQuality(['Score: 72; kind=html; contentType=text/html', 'Score: 41; kind=markdown; contentType=text/markdown', 'Score: 12; kind=html; contentType=text/html'].join('\n'))

  expect(quality).toEqual({resultCount: 3, topScore: 72, avgTop3Score: 42, goodResultCount: 2, scoreSpread: 31})
  expect(searchQualityFromDetails({quality})).toEqual(quality)
 })

 test('routes strong native results as good enough', () => {
  expect(nativeSearchRoutingFromDetails({directUrlMode: false, candidateUrlCount: 8, fetchedUrlCount: 5, resultCount: 4, maxResults: 5, quality: {resultCount: 4, topScore: 72, avgTop3Score: 45, goodResultCount: 3, scoreSpread: 20}, adaptive: {stoppedReason: 'enough_quality'}})).toEqual({
   label: 'native_good',
   reason: 'quality threshold met'
  })
 })

 test('routes quality using requested maxResults instead of default fallback', () => {
  expect(nativeSearchRoutingFromDetails({directUrlMode: false, candidateUrlCount: 8, fetchedUrlCount: 2, resultCount: 2, maxResults: 2, quality: {resultCount: 2, topScore: 72, avgTop3Score: 45, goodResultCount: 2, scoreSpread: 20}, adaptive: {stoppedReason: 'enough_quality'}})).toEqual({
   label: 'native_good',
   reason: 'quality threshold met'
  })
 })

 test('routes planner fetch-more decisions explicitly', () => {
  expect(nativeSearchRoutingFromDetails({directUrlMode: false, candidateUrlCount: 12, fetchedUrlCount: 1, resultCount: 1, quality: {resultCount: 1, topScore: 12, avgTop3Score: 12, goodResultCount: 0, scoreSpread: 0}, adaptive: {stoppedReason: 'fetch_more'}})).toEqual({
   label: 'fetch_more',
   reason: 'planner requested another fetch batch'
  })
 })

 test('routes weak bounded results toward source packs before escalation', () => {
  expect(nativeSearchRoutingFromDetails({directUrlMode: false, candidateUrlCount: 8, fetchedUrlCount: 0, resultCount: 0, quality: {resultCount: 0, topScore: 0, avgTop3Score: 0, goodResultCount: 0, scoreSpread: 0}, adaptive: {stoppedReason: 'exhausted_candidates'}})).toEqual({
   label: 'try_source_pack',
   reason: 'bounded search returned weak or empty results'
  })
 })

 test('routes direct URL mode as done', () => {
  expect(nativeSearchRoutingFromDetails({directUrlMode: true, candidateUrlCount: 1, fetchedUrlCount: 1, resultCount: 1, quality: {resultCount: 1, topScore: 10, avgTop3Score: 10, goodResultCount: 0, scoreSpread: 0}, adaptive: {stoppedReason: 'direct_url_mode'}})).toEqual({
   label: 'direct_url_done',
   reason: 'direct URL mode is caller-owned'
  })
 })
})
