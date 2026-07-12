import {readFileSync} from 'node:fs'
import {performance} from 'node:perf_hooks'

const optimizationVersion = readFileSync(new URL('../OPTIMIZATION_VERSION', import.meta.url), 'utf8').trim()
const modulePath = process.env.TIA_SLIM_STREAM_MODULE ?? '../scripts/pi-stream-fast.ts'
const {SlimStreamWriter} = await import(modulePath)
const iterations = Number(process.argv[2] ?? 40)
const deltas = Number(process.argv[3] ?? 10000)
if (!Number.isInteger(iterations) || iterations < 1 || !Number.isInteger(deltas) || deltas < 1) {
 throw new Error('Usage: slim-stream-writer-burst.ts [iterations] [deltas]')
}

let bytes = 0
const sink = (chunk: string, callback: () => void) => {
 bytes += Buffer.byteLength(chunk)
 callback()
 return true
}

const start = performance.now()
for (let iteration = 0; iteration < iterations; iteration += 1) {
 const writer = new SlimStreamWriter(sink)
 writer.enqueueTextStart(0)
 writer.enqueueTextStart(1)
 for (let i = 0; i < deltas; i += 1) {
  writer.enqueueDelta(i & 1, i % 17 === 0 ? 'token-with-escape-"\\n' : 'token ')
 }
 writer.enqueueTextEnd(0)
 writer.enqueueTextEnd(1)
 await writer.drain()
}
const elapsedMs = performance.now() - start
console.log(JSON.stringify({optimizationVersion, iterations, deltas, bytes, elapsedMs, perDeltaNs: (elapsedMs * 1e6) / (iterations * deltas)}))
