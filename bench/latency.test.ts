import {expect, test} from 'bun:test'
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {buildPi} from '../scripts/build-pi.ts'
import {defaultConfig, parameters, plan, profiles, shuffle, sliceConfig, validateConfig} from './latency-config.ts'
import {JsonlReader, metrics, newTurn, textChunks} from './latency-fixture.ts'

function config() {
 const c = defaultConfig()
 c.axes = {session: [true, false], thinking: ['off', 'low', 'high'], transport: ['auto', 'sse']}
 c.rounds = 2
 return c
}

test('OAT includes a same-code control and changes exactly one parameter', () => {
 const c = config(),
  result = profiles(c, c.targets[0])
 expect(result.length).toBe(6)
 expect(result[0].values).toEqual(result[1].values)
 for (const profile of result.slice(2)) expect(Object.keys(profile.values).filter(k => profile.values[k] !== result[0].values[k]).length).toBe(1)
})

test('named slices preserve the baseline, vary only the requested axis, and reject empty selections', () => {
 const c = config()
 const sliced = sliceConfig(c, 'thinking', 'paced')
 expect(sliced.scenarios.map(s => s.name)).toEqual(['paced'])
 expect(sliced.axes.session).toEqual([true])
 expect(sliced.axes.thinking).toEqual(['off', 'low', 'high'])
 expect(plan(sliced).launches).toBe(12)
 expect(plan(sliceConfig(c, 'baseline', 'paced')).launches).toBe(6)
 expect(() => sliceConfig(c, 'flush')).toThrow('no applicable')
 expect(() => sliceConfig(c, 'thinking', 'unknown')).toThrow('no applicable')
 expect(() => sliceConfig(c, 'unknown')).toThrow('Unknown axis')
 expect(c.axes.session).toEqual([true, false])
})

test('two-factor design covers all value pairs; bounded grid covers every combination', () => {
 const c = config()
 c.design = 'pairs'
 const rows = profiles(c, c.targets[0])
 const axes = Object.entries(c.axes)
 for (let i = 0; i < axes.length; i++)
  for (let j = i + 1; j < axes.length; j++) {
   for (const a of axes[i][1]) for (const b of axes[j][1]) expect(rows.some(r => r.values[axes[i][0]] === a && r.values[axes[j][0]] === b)).toBe(true)
  }
 c.design = 'grid'
 expect(profiles(c, c.targets[0]).length).toBe(13)
 c.maxRuns = 10
 expect(() => plan(c)).toThrow('exceeds maxRuns')
})

test('scope separates slim from coding tools and reports ignored axes and exact process counts', () => {
 const c = config()
 c.targets.push({name: 'slim', command: ['/tmp/explicit-slim'], protocol: 'slim'})
 c.axes.flush = ['microtask', 'immediate']
 const p = plan(c)
 expect(p.cells.some(cell => cell.target.protocol === 'slim' && cell.scenario.tools)).toBe(false)
 expect(p.ignoredAxes[0].axes).toContain('flush')
 expect(p.ignoredAxes[1].axes).toContain('session')
 expect(p.launches).toBe(p.cells.length * (c.rounds + c.warmups))
 expect(p.prompts).toBe(p.cells.reduce((n, cell) => n + (cell.target.protocol === 'rpc' ? cell.scenario.turns : 1), 0) * (c.rounds + c.warmups))
})

test('unknown flags, unbounded settings, missing FFF and duplicate inputs fail closed', () => {
 for (const mutate of [
  (c: ReturnType<typeof config>) => {
   c.axes.TIA_UNSAFE = [true]
  },
  (c: ReturnType<typeof config>) => {
   c.axes.thinking = ['unvalidated']
  },
  (c: ReturnType<typeof config>) => {
   c.axes.fffMode = ['override']
  },
  (c: ReturnType<typeof config>) => {
   c.axes.thinking = ['off', 'off']
  },
  (c: ReturnType<typeof config>) => {
   c.rounds = 1
  },
  (c: ReturnType<typeof config>) => {
   c.targets.push(c.targets[0])
  },
  (c: ReturnType<typeof config>) => {
   c.scenarios[0].deltas = 1000000
  }
 ]) {
  const c = config()
  mutate(c)
  expect(() => validateConfig(c)).toThrow()
 }
 const c = config()
 c.maxRuns = 1
 expect(() => plan(c)).toThrow()
 expect(shuffle([1, 2, 3, 4, 5, 6], 123)).toEqual(shuffle([1, 2, 3, 4, 5, 6], 123))
 expect(shuffle([1, 2, 3, 4, 5, 6], 123).sort()).toEqual([1, 2, 3, 4, 5, 6])
})

test('LF-only JSONL decoding preserves split UTF-8 and Unicode separators and rejects truncated/malformed/oversized streams', () => {
 const result: any[] = []
 const reader = new JsonlReader(event => result.push(event))
 const bytes = Buffer.from(JSON.stringify({text: 'café😄\u2028\u2029\r\n'}) + '\r\n')
 for (const byte of bytes) reader.push(Uint8Array.of(byte), 1)
 reader.end()
 expect(result).toEqual([{text: 'café😄\u2028\u2029\r\n'}])
 expect(() => new JsonlReader(() => {}).push(Buffer.from('oops\n'), 1)).toThrow()
 const truncated = new JsonlReader(() => {})
 truncated.push(Buffer.from('{"x":1}'), 1)
 expect(() => truncated.end()).toThrow('Truncated')
 expect(() => new JsonlReader(() => {}, 3).push(Buffer.from('12345'), 1)).toThrow('limit')
 expect(() => new JsonlReader(() => {}).push(Uint8Array.of(0xff), 1)).toThrow()
})

test('per-delta latency remains accurate under coalescing; loss, duplication, final mismatch and negative clocks fail', () => {
 const s = {...config().scenarios[0], deltas: 3, thinkingDeltas: 0}
 const trace = newTurn(),
  chunks = textChunks(s)
 trace.promptAt = 10
 trace.requests = [{at: 11, firstFrameAt: 12, body: '{}', sha256: '', bytes: 2}]
 trace.sent = chunks.map((text, i) => ({at: 20 + i, text}))
 trace.received = [{at: 30, text: chunks.join('')}]
 trace.doneAt = 31
 trace.authoritative = chunks.join('')
 expect(metrics(trace, s, 0).deliveryMs).toEqual([10, 9, 8])
 expect(metrics(trace, s, 0).scalar.promptToFirstTextMs).toBe(20)
 trace.received[0].text += 'duplicate'
 expect(() => metrics(trace, s, 0)).toThrow('delta bytes')
 trace.received[0].text = chunks.join('')
 trace.authoritative = 'mismatch'
 expect(() => metrics(trace, s, 0)).toThrow('Final message')
 trace.authoritative = chunks.join('')
 trace.received[0].at = 19
 expect(() => metrics(trace, s, 0)).toThrow('Invalid')
})

test('new low-level controls are independently registered rather than hidden in presets', () => {
 for (const control of ['TIA_STREAM_FLUSH', 'TIA_STREAM_DELTA_CHARS', 'TIA_STREAM_OUTPUT_CHARS', 'TIA_STREAM_CONTROL_DELAY_MS']) expect(Object.values(parameters).some(p => p.control === control && p.values.length > 1)).toBe(true)
})

test('offline harness validates full coding-tool continuations, cold and warm turns, provenance and paired control', async () => {
 const work = mkdtempSync(join(tmpdir(), 'tia-latency-test-'))
 try {
  const c = config()
  c.packageDir = resolve('node_modules/@earendil-works/pi-coding-agent')
  const binary = join(work, 'pi')
  await buildPi(c.packageDir, binary, join(work, 'full-runtime'))
  c.targets = [{name: 'compiled-rpc', command: [binary], protocol: 'rpc'}]
  c.axes = {fastTools: [true, false], transformCache: ['warm', 'cold', 'disabled']}
  c.scenarios = [{...c.scenarios[1], turns: 2, deltas: 3, cadenceMs: 1, firstDelayMs: 1}]
  c.timeoutMs = 30000
  const path = join(work, 'config.json'),
   output = join(work, 'run')
  writeFileSync(path, JSON.stringify(c))
  const child = Bun.spawn([process.execPath, resolve('bench/latency.ts'), '--run', path, output], {stdout: 'pipe', stderr: 'pipe'})
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()])
  expect(code, stderr).toBe(0)
  const summary = JSON.parse(readFileSync(join(output, 'summary.json'), 'utf8'))
  expect(summary.checkedProcesses).toBe(15)
  expect(summary.checkedPrompts).toBe(30)
  expect(summary.checkedToolCalls).toBe(120)
  expect(summary.samplesSha256).toMatch(/^[a-f0-9]{64}$/)
  expect(summary.summary.some((row: any) => row.phase === 'warm-1')).toBe(true)
  const samples = readFileSync(join(output, 'samples.jsonl'), 'utf8')
   .trim()
   .split('\n')
   .map(line => JSON.parse(line))
  expect(samples.every(s => s.turns.every((t: any) => t.trace.requests.length === 2))).toBe(true)
  for (const sample of samples) {
   if (sample.cache.mode === 'cold') {
    expect(sample.cache.beforeFiles).toBe(0)
    expect(sample.cache.afterFiles).toBeGreaterThan(0)
   }
   if (sample.cache.mode === 'disabled') expect(sample.cache.afterFiles).toBe(0)
   if (sample.cache.mode === 'warm' && !sample.warmup && sample.profile !== 'fastTools=false') expect(sample.cache.beforeFiles).toBeGreaterThan(0)
  }
  const request = JSON.parse(samples[0].turns[0].trace.requests[0].body)
  expect(request.tools.map((tool: any) => tool.name)).toEqual(expect.arrayContaining(['read', 'write', 'edit', 'bash']))
 } finally {
  rmSync(work, {recursive: true, force: true})
 }
}, 90000)

for (const deadline of ['process', 'run'])
 test(`${deadline} budget archives failure without a success summary, leaking credentials, or reusing an output directory`, async () => {
  const work = mkdtempSync(join(tmpdir(), 'tia-latency-timeout-'))
  try {
   const c = config(),
    script = join(work, 'hung.ts')
   writeFileSync(script, 'if(process.env.ANTHROPIC_API_KEY || process.env.HTTPS_PROXY || process.env.PI_TELEMETRY !== "0" || process.env.PI_OFFLINE !== "1") throw new Error("Unsafe environment"); setInterval(() => {}, 1000)')
   c.targets = [{name: 'hung', command: [process.execPath, script], protocol: 'rpc'}]
   c.axes = {}
   c.timeoutMs = deadline === 'process' ? 100 : 10000
   c.maxDurationMs = deadline === 'run' ? 100 : 10000
   c.scenarios = [c.scenarios[0]]
   const path = join(work, 'config.json'),
    output = join(work, 'run')
   writeFileSync(path, JSON.stringify(c))
   const child = Bun.spawn([process.execPath, resolve('bench/latency.ts'), '--run', path, output], {stdout: 'pipe', stderr: 'pipe', env: {...process.env, ANTHROPIC_API_KEY: 'must-not-inherit'}})
   const [code] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()])
   expect(code).not.toBe(0)
   const failure = JSON.parse(readFileSync(join(output, 'failure.json'), 'utf8'))
   expect(failure.status).toBe('failed')
   expect(failure.error).toContain(deadline === 'process' ? 'deadline' : 'maxDurationMs budget')
   expect(failure.error).not.toContain('must-not-inherit')
   expect(() => readFileSync(join(output, 'summary.json'))).toThrow()
   const before = readFileSync(join(output, 'samples.jsonl'), 'utf8')
   const retry = Bun.spawn([process.execPath, resolve('bench/latency.ts'), '--run', path, output], {stdout: 'pipe', stderr: 'pipe'})
   const [retryCode, diagnostics] = await Promise.all([retry.exited, new Response(retry.stderr).text(), new Response(retry.stdout).text()])
   expect(retryCode).not.toBe(0)
   expect(diagnostics).toContain('already exists')
   expect(readFileSync(join(output, 'samples.jsonl'), 'utf8')).toBe(before)
  } finally {
   rmSync(work, {recursive: true, force: true})
  }
 }, 30000)
