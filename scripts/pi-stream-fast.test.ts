import {expect, test} from 'bun:test'
import {SlimStreamWriter} from './pi-stream-fast.ts'

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
