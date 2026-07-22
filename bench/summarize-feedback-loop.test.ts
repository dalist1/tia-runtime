import {expect, test} from 'bun:test'
import {strategyFor} from './summarize-feedback-loop.ts'

test('feedback strategies distinguish GCC comparisons from native stream commands', () => {
 expect(strategyFor('fast stream compiled/gcc read comparison')).toBe('gcc comparison helpers')
 expect(strategyFor('fast compiled/gcc comparison')).toBe('gcc comparison helpers')
 expect(strategyFor('fast stream compiled/native')).toBe('compiled runner + native helpers')
 expect(strategyFor('fast warm-daemon/native')).toBe('warm daemon + native helpers')
})
