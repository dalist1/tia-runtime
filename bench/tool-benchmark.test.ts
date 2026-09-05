import {expect, test} from 'bun:test'
import {existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pairedSpeedup, quantile} from './tool-benchmark.ts'
import {referenceRead} from './tool-read-reference.ts'

test('tool benchmark quantiles interpolate without mutating raw samples', () => {
 const values = [9, 1, 5, 3]
 expect(quantile(values, 0)).toBe(1)
 expect(quantile(values, 0.5)).toBe(4)
 expect(quantile(values, 1)).toBe(9)
 expect(quantile([3], 0.95)).toBe(3)
 expect(values).toEqual([9, 1, 5, 3])
 expect(() => quantile([], 0.5)).toThrow()
 expect(() => quantile([NaN], 0.5)).toThrow()
 expect(() => quantile([1], 2)).toThrow()
})

test('paired speedups preserve pairing and report deterministic confidence intervals', () => {
 const constant = pairedSpeedup([10, 20, 30, 40], [1, 2, 3, 4])
 expect(constant.ratio).toBeCloseTo(10)
 for (const bound of constant.ci95) expect(bound).toBeCloseTo(10)
 const before = [1, 4, 8, 10]
 const after = [2, 3, 5, 15]
 const forward = pairedSpeedup(before, after)
 const reverse = pairedSpeedup(after, before)
 expect(forward).toEqual(pairedSpeedup(before, after))
 expect(forward.ratio * reverse.ratio).toBeCloseTo(1)
 expect(forward.ci95[0] * reverse.ci95[1]).toBeCloseTo(1)
 expect(() => pairedSpeedup([1], [1])).toThrow()
 expect(() => pairedSpeedup([1, 2], [1, 0])).toThrow()
 expect(() => pairedSpeedup([1, 2], [1, 2, 3])).toThrow()
})

test('independent read oracle handles empty files, exact limits, UTF-8 byte caps and skills', () => {
 expect(referenceRead('').content[0].text).toBe('')
 expect(referenceRead('one\ntwo\n', 2, 1).content[0].text).toBe('two\n')
 expect(() => referenceRead('one\ntwo\n', 3)).toThrow('2 lines total')
 expect(referenceRead('😄'.repeat(12800)).details).toBeUndefined()
 expect(referenceRead('😄'.repeat(12800) + '\n').details.truncation.firstLineExceedsLimit).toBe(true)
 expect(referenceRead('x\n'.repeat(3000), 1, 1, true).content[0].text).toBe('x\n'.repeat(3000))
})

test('tool benchmark fails closed on incorrect worker results and invalid run counts', async () => {
 const work = mkdtempSync(join(tmpdir(), 'tia-bench-test-'))
 try {
  const source = join(work, 'broken.ts')
  const output = join(work, 'result.json')
  symlinkSync(join(import.meta.dir, '../node_modules'), join(work, 'node_modules'), 'dir')
  writeFileSync(source, 'export async function fastRead() { return {content: [{type: "text", text: "WRONG"}]}; }')
  for (const rounds of ['1', '2', 'NaN', '2.5']) {
   const child = Bun.spawn([process.execPath, join(import.meta.dir, 'tool-benchmark.ts'), source, output, rounds, '1', '0'], {stdout: 'pipe', stderr: 'pipe'})
   const [code, , stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
   expect(code).not.toBe(0)
   expect(stderr).toContain(rounds === '2' ? 'Benchmark worker failed' : 'AssertionError')
   expect(existsSync(output)).toBe(false)
  }
 } finally {
  rmSync(work, {recursive: true, force: true})
 }
}, 30000)

test('tool benchmark rejects mismatched dependency trees before timing', async () => {
 const work = mkdtempSync(join(tmpdir(), 'tia-bench-dependencies-'))
 try {
  const source = join(work, 'extension.ts')
  const output = join(work, 'result.json')
  writeFileSync(source, 'throw new Error("worker must not start")')
  for (const name of ['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', '@sinclair/typebox']) {
   const directory = join(work, 'node_modules', name)
   mkdirSync(directory, {recursive: true})
   writeFileSync(join(directory, 'package.json'), JSON.stringify({name, main: 'index.js'}))
   writeFileSync(join(directory, 'index.js'), 'module.exports = {}')
  }
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'tool-benchmark.ts'), source, output, '2', '1', '0'], {stdout: 'pipe', stderr: 'pipe'})
  const [code, , stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect(code).not.toBe(0)
  expect(stderr).toContain('Candidates must resolve the same dependency files')
  expect(stderr).not.toContain('worker must not start')
  expect(existsSync(output)).toBe(false)
 } finally {
  rmSync(work, {recursive: true, force: true})
 }
}, 30000)
