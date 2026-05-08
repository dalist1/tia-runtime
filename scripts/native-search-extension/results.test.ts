import {describe, expect, test} from 'bun:test'
import {analyzeSearchQuality, parseZigSearchResults, searchQualityFromDetails} from './results.ts'

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
})
