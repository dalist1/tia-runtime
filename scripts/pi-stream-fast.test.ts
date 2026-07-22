import {expect, test} from 'bun:test'
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {resolve} from 'node:path'
import {createModelMap, resolveOAuth, selectModel, SlimStreamWriter} from './pi-stream-fast.ts'

type Frame = {t: string; i: number; s?: string}

function createCapture() {
 let captured = ''
 const sink = (chunk: string, callback: () => void) => {
  captured += chunk
  queueMicrotask(callback)
  return true
 }
 return {sink, read: () => captured}
}

function parseFrames(jsonl: string): Frame[] {
 const frames: Frame[] = []
 for (const line of jsonl.split('\n')) {
  if (line.length === 0) continue
  const frame: Frame = JSON.parse(line)
  frames.push(frame)
 }
 return frames
}

test('SlimStreamWriter preserves per-index delta bytes, order, and framing across interleaved streams', async () => {
 const capture = createCapture()
 const writer = new SlimStreamWriter(capture.sink)

 const expected = new Map<number, string>([
  [0, ''],
  [1, '']
 ])

 const emit = (index: number, delta: string) => {
  expected.set(index, `${expected.get(index) ?? ''}${delta}`)
  writer.enqueueDelta(index, delta)
 }

 writer.enqueueTextStart(0)
 writer.enqueueTextStart(1)

 emit(0, 'alpha ')
 emit(1, 'beta ')
 emit(0, 'x'.repeat(120))
 emit(1, 'y'.repeat(40))
 emit(0, 'gamma ')
 emit(1, 'z'.repeat(20))
 emit(0, 'q'.repeat(16 * 1024 + 7))
 emit(1, 'tail-1 ')
 emit(0, 'tail-0 ')

 writer.enqueueTextEnd(0)
 writer.enqueueTextEnd(1)

 await writer.drain()

 const captured = capture.read()
 const frames = parseFrames(captured)

 expect(captured.length).toBeGreaterThan(16 * 1024)
 expect(frames.length).toBeGreaterThan(0)
 expect(frames[0]).toEqual({t: 's', i: 0})
 expect(frames[1]).toEqual({t: 's', i: 1})
 expect(frames.some(frame => frame.t === 'd' && (frame.s?.length ?? 0) > 96)).toBe(true)

 const lastDeltaSeen: Record<number, boolean> = {0: false, 1: false}
 const endSeen: Record<number, boolean> = {0: false, 1: false}
 const startSeen: Record<number, boolean> = {0: false, 1: false}
 const rebuilt = new Map<number, string>([
  [0, ''],
  [1, '']
 ])

 for (const frame of frames) {
  expect([0, 1]).toContain(frame.i)
  if (frame.t === 's') {
   expect(startSeen[frame.i]).toBe(false)
   expect(lastDeltaSeen[frame.i]).toBe(false)
   startSeen[frame.i] = true
   continue
  }
  if (frame.t === 'd') {
   expect(startSeen[frame.i]).toBe(true)
   expect(endSeen[frame.i]).toBe(false)
   expect(typeof frame.s).toBe('string')
   rebuilt.set(frame.i, `${rebuilt.get(frame.i) ?? ''}${frame.s ?? ''}`)
   lastDeltaSeen[frame.i] = true
   continue
  }
  if (frame.t === 'e') {
   expect(startSeen[frame.i]).toBe(true)
   expect(endSeen[frame.i]).toBe(false)
   endSeen[frame.i] = true
   continue
  }
  throw new Error(`unexpected frame type: ${frame.t}`)
 }

 expect(endSeen[0]).toBe(true)
 expect(endSeen[1]).toBe(true)
 expect(rebuilt.get(0)).toBe(expected.get(0))
 expect(rebuilt.get(1)).toBe(expected.get(1))
})

test('SlimStreamWriter leaves nothing buffered after drain', async () => {
 const capture = createCapture()
 const writer = new SlimStreamWriter(capture.sink)

 writer.enqueueTextStart(0)
 writer.enqueueDelta(0, 'pending without explicit end ')
 writer.enqueueDelta(0, 'w'.repeat(200))

 await writer.drain()

 const before = capture.read()
 expect(before.endsWith('\n')).toBe(true)

 await writer.drain()
 const after = capture.read()
 expect(after).toBe(before)

 const frames = parseFrames(after)
 const rebuilt = frames
  .filter(frame => frame.t === 'd' && frame.i === 0)
  .map(frame => frame.s ?? '')
  .join('')
 expect(rebuilt).toBe(`pending without explicit end ${'w'.repeat(200)}`)
})

test('drain() resolves and delivers all bytes even when the sink applies backpressure (returns false)', async () => {
 let captured = ''
 const sink = (chunk: string, callback: () => void) => {
  captured += chunk
  setTimeout(callback, 1)
  return false
 }
 const writer = new SlimStreamWriter(sink)
 writer.enqueueTextStart(0)
 writer.enqueueDelta(0, 'x'.repeat(200))
 writer.enqueueTextEnd(0)
 await writer.drain()
 const frames = parseFrames(captured)
 const delta = frames
  .filter(frame => frame.t === 'd' && frame.i === 0)
  .map(frame => frame.s)
  .join('')
 expect(delta).toBe('x'.repeat(200))
 expect(frames.some(frame => frame.t === 'e' && frame.i === 0)).toBe(true)
})

test('the first text delta is emitted without the batching timer delay', async () => {
 const capture = createCapture()
 const writer = new SlimStreamWriter(capture.sink)
 writer.enqueueTextStart(0)
 writer.enqueueDelta(0, 'first')
 await new Promise<void>(resolve => queueMicrotask(resolve))
 const frames = parseFrames(capture.read())
 expect(frames).toEqual([
  {t: 's', i: 0},
  {t: 'd', i: 0, s: 'first'}
 ])
 await writer.drain()
})

test('empty deltas drain without emitting empty frames', async () => {
 const capture = createCapture()
 const writer = new SlimStreamWriter(capture.sink)
 writer.enqueueTextStart(0)
 writer.enqueueDelta(0, '')
 writer.enqueueTextEnd(0)
 await writer.drain()
 expect(parseFrames(capture.read())).toEqual([
  {t: 's', i: 0},
  {t: 'e', i: 0}
 ])
})

test('interleaved deltas beyond the two-slot fast path preserve every index', async () => {
 const capture = createCapture()
 const writer = new SlimStreamWriter(capture.sink)
 const expected = new Map<number, string>()
 for (let index = 0; index < 5; index += 1) {
  expected.set(index, '')
  writer.enqueueTextStart(index)
 }
 for (let round = 0; round < 40; round += 1) {
  for (let index = 4; index >= 0; index -= 1) {
   const delta = `${index}:${round};`
   expected.set(index, `${expected.get(index)}${delta}`)
   writer.enqueueDelta(index, delta)
  }
 }
 for (let index = 0; index < 5; index += 1) writer.enqueueTextEnd(index)
 await writer.drain()
 const actual = new Map<number, string>()
 for (const frame of parseFrames(capture.read())) {
  if (frame.t === 'd') actual.set(frame.i, `${actual.get(frame.i) ?? ''}${frame.s}`)
 }
 expect(actual).toEqual(expected)
})

function selectableModel(provider: string, id: string) {
 return {id, name: id, provider, api: 'openai-completions', baseUrl: `https://${provider}.example.test`, reasoning: false, input: ['text'], cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, contextWindow: 128000, maxTokens: 16384}
}

test('duplicate unqualified model ids prefer a configured provider deterministically', () => {
 const catalog = {alpha: {shared: selectableModel('alpha', 'shared')}, beta: {shared: selectableModel('beta', 'shared')}}
 const defaults = {alpha: 'shared', beta: 'shared'}
 const {providers, requestConfig} = createModelMap(catalog, {})
 const beta = selectModel({modelId: 'shared', messages: []}, {}, providers, {beta: {type: 'api_key', key: 'dummy'}}, requestConfig, defaults)
 expect(beta.model.provider).toBe('beta')
 const first = selectModel({modelId: 'shared', messages: []}, {}, providers, {alpha: {}, beta: {}}, requestConfig, defaults)
 expect(first.model.provider).toBe('alpha')
})

test('every installed provider default drives normal and unknown-id fallback selection', async () => {
 const packageRoot = resolve(import.meta.dir, '..', 'node_modules', '@earendil-works')
 const [catalogModule, resolverModule] = await Promise.all([import(resolve(packageRoot, 'pi-ai', 'dist', 'models.generated.js')), import(resolve(packageRoot, 'pi-coding-agent', 'dist', 'core', 'model-resolver.js'))])
 const catalog = catalogModule.MODELS
 const defaults = resolverModule.defaultModelPerProvider
 const {providers, requestConfig} = createModelMap(catalog, {})
 let checked = 0
 for (const [provider, defaultId] of Object.entries(defaults)) {
  if (typeof defaultId !== 'string') throw new Error(`Invalid default for ${provider}`)
  const candidates = providers.get(provider)
  if (!candidates) continue
  const expected = candidates.find(model => model.id === defaultId)
  if (!expected) throw new Error(`Missing installed default ${provider}/${defaultId}`)
  const selected = selectModel({provider, messages: []}, {}, providers, {}, requestConfig, defaults)
  expect(selected.model.id).toBe(defaultId)
  const fallback = selectModel({provider, modelId: 'tia-unknown-model', messages: []}, {}, providers, {}, requestConfig, defaults)
  expect(fallback.model.id).toBe('tia-unknown-model')
  expect(fallback.model.api).toBe(expected?.api)
  expect(fallback.model.baseUrl).toBe(expected?.baseUrl)
  checked += 1
 }
 expect(checked).toBeGreaterThan(30)
})

test('concurrent OAuth refreshes share the persisted result through the auth lock', async () => {
 const dir = mkdtempSync(resolve(tmpdir(), 'tia-oauth-test-'))
 const authPath = resolve(dir, 'auth.json')
 const credential = {type: 'oauth', refresh: 'refresh-token', access: 'expired', expires: 0}
 const auth = {test: credential}
 writeFileSync(authPath, JSON.stringify(auth))
 let refreshes = 0
 const loadProvider = async () => ({
  refreshToken: async () => {
   refreshes += 1
   await Bun.sleep(30)
   return {refresh: 'refresh-token', access: 'fresh', expires: Date.now() + 60_000}
  }
 })
 try {
  const [left, right] = await Promise.all([resolveOAuth('test', credential, auth, authPath, loadProvider), resolveOAuth('test', credential, auth, authPath, loadProvider)])
  expect(left.apiKey).toBe('fresh')
  expect(right.apiKey).toBe('fresh')
  expect(refreshes).toBe(1)
  expect(JSON.parse(readFileSync(authPath, 'utf8')).test.access).toBe('fresh')
  expect(existsSync(`${authPath}.lock`)).toBe(false)
 } finally {
  rmSync(dir, {recursive: true, force: true})
 }
})
