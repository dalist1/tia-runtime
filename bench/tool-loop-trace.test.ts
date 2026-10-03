import {expect, test} from 'bun:test'
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fastPatch} from '../scripts/fast-tools-extension'
import {defaultConfig, validateConfig} from './latency-config'
import {checkToolFiles, patchFixture, prepareToolFixture, toolCalls} from './latency-fixture'
import {traceMetrics, type LoopMark} from './tool-loop-trace'

test('tool workloads reject incompatible full/slim and FFF configurations', () => {
 const c = defaultConfig()
 c.scenarios = [{...c.scenarios[1], toolWorkload: 'patch'}]
 expect(() => validateConfig(c)).toThrow('requires fast tools')
 c.axes.fastTools = [true]
 expect(validateConfig(c)).toBe(c)
 c.targets[0].protocol = 'slim'
 expect(() => validateConfig(c)).toThrow()
 c.targets[0].protocol = 'rpc'
 c.scenarios[0].toolWorkload = 'search'
 expect(() => validateConfig(c)).toThrow('requires enabled FFF')
 c.fffExtension = '/isolated/fff.ts'
 c.axes.fffMode = ['override']
 expect(validateConfig(c)).toBe(c)
 c.axes.fffMode.push('disabled')
 expect(() => validateConfig(c)).toThrow('requires enabled FFF')
})

test('ten-file loop fixture composes across turns and detects byte corruption', async () => {
 const cwd = mkdtempSync(join(tmpdir(), 'tia-patch-loop-'))
 const scenario = {...defaultConfig().scenarios[1], toolWorkload: 'patch' as const}
 try {
  prepareToolFixture(cwd, scenario)
  for (let turn = 0; turn < 3; turn++) {
   const call = toolCalls(cwd, turn, scenario).find(call => call.name === 'edit')!
   expect('patch' in call.input).toBe(true)
   if (!('patch' in call.input) || typeof call.input.patch !== 'string') throw new Error('Missing patch fixture')
   await fastPatch(cwd, call.input.patch)
   writeFileSync(join(cwd, 'written.txt'), `verified-${turn}\ncafé😄\n`)
   expect(() => checkToolFiles(cwd, turn, scenario)).not.toThrow()
   expect(readFileSync(join(cwd, 'patch-9.txt'), 'utf8')).toBe(patchFixture(turn + 1))
  }
  writeFileSync(join(cwd, 'patch-7.txt'), 'corruption')
  expect(() => checkToolFiles(cwd, 2, scenario)).toThrow()
 } finally {
  rmSync(cwd, {recursive: true, force: true})
 }
})

test('trace stages use a single child clock and reject missing or reordered boundaries', () => {
 const stages = ['before_agent_start', 'context', 'before_provider_request', 'provider_start', 'provider_end', 'assistant_end', 'tool_execution_start', 'tool_call', 'execute_start', 'execute_end', 'tool_result', 'tool_execution_end', 'agent_settled']
 const marks: LoopMark[] = stages.map((stage, at) => ({stage, at, turn: 0, request: at < 2 ? 0 : 1, ...(at >= 6 && at <= 11 ? {id: 'read_0'} : {})}))
 const [turn] = traceMetrics(marks, 1)
 expect(turn.totalMs).toBe(12)
 expect(turn.tools).toEqual([{id: 'read_0', validationAndBeforeHookMs: 1, schedulingMs: 1, bodyMs: 1, resultHooksMs: 2, totalMs: 5}])
 expect(turn.requests).toEqual([{request: 1, contextAndRequestBuildMs: 1, responseHandlingMs: 1}])
 expect(() =>
  traceMetrics(
   marks.filter(mark => mark.stage !== 'execute_end'),
   1
  )
 ).toThrow('trace boundary')
 expect(() => traceMetrics(marks.slice(0, -1), 1)).toThrow()
 expect(() => traceMetrics([...marks].reverse(), 1)).toThrow('clock')
 expect(() => traceMetrics(marks, 2)).toThrow()
})
