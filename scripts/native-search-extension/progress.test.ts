import {describe, expect, test} from 'bun:test'
import {SearchProgress, buildTimeoutSearchText} from './progress.ts'

describe('native_search progress recovery', () => {
 test('timeout text includes recovered fetched pages', () => {
  const progress = new SearchProgress(undefined, performance.now())
  progress.applyZigLine('progress: fetching 1/2 https://example.com/docs')
  progress.applyZigLine('progress: fetched 1/2 score=42 Example Guide — https://example.com/docs')
  progress.applyZigLine('progress: fetching 2/2 https://example.com/slow')

  const text = buildTimeoutSearchText({query: 'agent docs', timeoutMs: 5000, progress})
  const snapshot = progress.snapshot()

  expect(text).toContain('timed out')
  expect(text).toContain('Recovered: 1 fetched')
  expect(text).toContain('Example Guide')
  expect(snapshot.current).toEqual({current: 2, total: 2, url: 'https://example.com/slow'})
  expect(snapshot.fetchedCount).toBe(1)
 })
})
