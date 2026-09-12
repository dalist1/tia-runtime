import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {join} from 'node:path'
import type {Scenario} from './latency-config.ts'
import {quantile} from './tool-benchmark.ts'

export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
export const now = () => performance.now()
export type Delta = {at: number; text: string}
export type RequestTrace = {at: number; body: string; sha256: string; bytes: number; firstFrameAt?: number; endAt?: number}
export type TurnTrace = {promptAt: number; firstEventAt?: number; doneAt?: number; requests: RequestTrace[]; sent: Delta[]; received: Delta[]; tools: Record<string, {name: string; start: number; end?: number}>; authoritative?: string; thinkingEvents: number}
export function newTurn(): TurnTrace {
 return {promptAt: 0, requests: [], sent: [], received: [], tools: {}, thinkingEvents: 0}
}
export function textChunks(scenario: Scenario) {
 return Array.from({length: scenario.deltas}, (_, i) => `${String(i).padStart(5, '0')} café😄\u2028` + 'x'.repeat(scenario.deltaChars - 14) + '\n')
}
export function toolCalls(directory: string, turn: number) {
 return [
  {id: `read_${turn}`, name: 'read', input: {path: join(directory, 'source.txt'), offset: 1, limit: 2}},
  {id: `write_${turn}`, name: 'write', input: {path: join(directory, 'written.txt'), content: `verified-${turn}\ncafé😄\n`}},
  {id: `edit_${turn}`, name: 'edit', input: {path: join(directory, 'edited.txt'), oldText: `before-${turn}`, newText: `after-${turn}`}},
  {id: `bash_${turn}`, name: 'bash', input: {command: 'printf latency-bash'}}
 ]
}

export function loopback() {
 let active: {scenario: Scenario; turns: TurnTrace[]; directory: string; error?: string} | undefined
 const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
   try {
    assert(active, 'No active benchmark')
    assert.equal(new URL(request.url).pathname, '/v1/messages')
    assert.equal(request.method, 'POST')
    const at = now(),
     body = await request.text(),
     parsed = JSON.parse(body)
    assert.equal(parsed.model, 'latency-fixture')
    assert.equal(parsed.stream, true)
    let turnIndex = -1
    for (const message of parsed.messages) {
     if (message.role !== 'user') continue
     const texts = typeof message.content === 'string' ? [message.content] : message.content.filter((b: any) => b.type === 'text').map((b: any) => b.text)
     for (const text of texts) {
      const match = text.match(/^latency-turn-(\d+)/)
      if (match) turnIndex = Number(match[1])
     }
    }
    const trace = active.turns[turnIndex]
    assert(trace, 'Unknown prompt/turn')
    const record: RequestTrace = {at, body, sha256: hash(body), bytes: Buffer.byteLength(body)}
    trace.requests.push(record)
    const {scenario, directory} = active
    assert(trace.requests.length <= (scenario.tools ? 2 : 1), 'Unexpected request/retry')
    const needsTools = scenario.tools && trace.requests.length === 1
    if (scenario.tools) {
     const names = parsed.tools.map((tool: any) => tool.name)
     for (const name of ['read', 'write', 'edit', 'bash']) assert(names.includes(name), `Missing coding tool: ${name}`)
     if (!needsTools) {
      const results = parsed.messages.at(-1).content.filter((b: any) => b.type === 'tool_result')
      assert.equal(results.length, 4, 'Missing tool results in continuation request')
      for (const call of toolCalls(directory, turnIndex)) {
       const result = results.find((r: any) => r.tool_use_id === call.id)
       assert(result && !result.is_error, `Failed tool result: ${call.name}`)
       if (call.name === 'read') assert(JSON.stringify(result.content).includes('source café'))
       if (call.name === 'bash') assert(JSON.stringify(result.content).includes('latency-bash'))
      }
     }
    }
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
     async start(controller) {
      const emit = (event: any) => {
       if (cancelled) return
       record.firstFrameAt ??= now()
       controller.enqueue(Buffer.from(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`))
      }
      const wait = async (ms: number) => {
       if (ms > 0) await Bun.sleep(ms)
      }
      try {
       await wait(scenario.firstDelayMs)
       emit({type: 'message_start', message: {id: `msg_${turnIndex}_${trace.requests.length}`, type: 'message', role: 'assistant', model: 'latency-fixture', content: [], stop_reason: null, stop_sequence: null, usage: {input_tokens: 100, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0}}})
       if (needsTools) {
        for (const [index, call] of toolCalls(directory, turnIndex).entries()) {
         emit({type: 'content_block_start', index, content_block: {type: 'tool_use', id: call.id, name: call.name, input: {}}})
         emit({type: 'content_block_delta', index, delta: {type: 'input_json_delta', partial_json: JSON.stringify(call.input)}})
         emit({type: 'content_block_stop', index})
        }
       } else {
        let index = 0
        if (scenario.thinkingDeltas) {
         emit({type: 'content_block_start', index, content_block: {type: 'thinking', thinking: '', signature: ''}})
         for (let i = 0; i < scenario.thinkingDeltas; i++) {
          await wait(scenario.cadenceMs)
          emit({type: 'content_block_delta', index, delta: {type: 'thinking_delta', thinking: 'scripted reasoning '}})
         }
         emit({type: 'content_block_delta', index, delta: {type: 'signature_delta', signature: 'loopback-signature'}})
         emit({type: 'content_block_stop', index})
         index++
        }
        emit({type: 'content_block_start', index, content_block: {type: 'text', text: ''}})
        for (const [i, text] of textChunks(scenario).entries()) {
         if (i > 0) await wait(scenario.cadenceMs)
         if (cancelled) return
         trace.sent.push({at: now(), text})
         emit({type: 'content_block_delta', index, delta: {type: 'text_delta', text}})
        }
        emit({type: 'content_block_stop', index})
       }
       emit({type: 'message_delta', delta: {stop_reason: needsTools ? 'tool_use' : 'end_turn', stop_sequence: null}, usage: {output_tokens: scenario.deltas}})
       emit({type: 'message_stop'})
       record.endAt = now()
       if (!cancelled) controller.close()
      } catch (error) {
       if (!cancelled) {
        active!.error = String(error)
        controller.error(error)
       }
      }
     },
     cancel() {
      cancelled = true
     }
    })
    return new Response(stream, {headers: {'content-type': 'text/event-stream', 'cache-control': 'no-cache'}})
   } catch (error) {
    if (active) active.error = String(error)
    return new Response(String(error), {status: 400})
   }
  }
 })
 return {
  url: `http://127.0.0.1:${server.port}`,
  activate(scenario: Scenario, turns: TurnTrace[], directory: string) {
   active = {scenario, turns, directory}
  },
  check() {
   assert(!active?.error, active?.error ?? 'Loopback error')
  },
  stop() {
   server.stop(true)
  }
 }
}

export class JsonlReader {
 private decoder = new TextDecoder('utf-8', {fatal: true})
 private pending = ''
 constructor(
  private onEvent: (event: any, at: number) => void,
  private limit = 16 * 1024 * 1024
 ) {}
 push(bytes: Uint8Array, at: number) {
  this.pending += this.decoder.decode(bytes, {stream: true})
  let index: number
  while ((index = this.pending.indexOf('\n')) !== -1) {
   assert(index <= this.limit, 'JSONL frame exceeds limit')
   const line = this.pending.slice(0, index)
   this.pending = this.pending.slice(index + 1)
   assert(line.trim().length > 0, 'Empty JSONL frame')
   this.onEvent(JSON.parse(line), at)
  }
  assert(this.pending.length <= this.limit, 'Unterminated JSONL frame exceeds limit')
 }
 end() {
  this.pending += this.decoder.decode()
  assert.equal(this.pending, '', 'Truncated JSONL output')
 }
}

export function distribution(values: number[]) {
 assert(values.length > 0 && values.every(v => Number.isFinite(v) && v >= 0), 'Invalid/non-monotonic latency')
 return {count: values.length, mean: values.reduce((a, b) => a + b, 0) / values.length, p50: quantile(values, 0.5), p95: quantile(values, 0.95), p99: quantile(values, 0.99), max: Math.max(...values)}
}

export function metrics(trace: TurnTrace, scenario: Scenario, start: number) {
 const {sent, received, requests} = trace
 assert.equal(sent.length, scenario.deltas)
 const expected = textChunks(scenario).join('')
 assert.equal(sent.map(d => d.text).join(''), expected)
 assert.equal(received.map(d => d.text).join(''), expected, 'Lost, duplicated, or reordered delta bytes')
 if (trace.authoritative !== undefined) assert.equal(trace.authoritative, expected, 'Final message differs from deltas')
 assert(trace.doneAt !== undefined && received.length > 0)
 assert.equal(requests.length, scenario.tools ? 2 : 1)
 const delivery: number[] = []
 let readIndex = 0,
  readChars = received[0].text.length,
  sentChars = 0
 for (const delta of sent) {
  sentChars += delta.text.length
  while (readChars < sentChars) readChars += received[++readIndex].text.length
  delivery.push(received[readIndex].at - delta.at)
 }
 const tools = Object.values(trace.tools)
 assert.equal(tools.length, scenario.tools ? 4 : 0)
 for (const tool of tools) assert(tool.end !== undefined && tool.end >= tool.start, 'Incomplete tool execution')
 const gaps = received.slice(1).map((d, i) => d.at - received[i].at)
 const first = received[0].at
 const lag = distribution(delivery)
 const scalar: Record<string, number> = {
  spawnToFirstTextMs: first - start,
  promptToFirstTextMs: first - trace.promptAt,
  requestToFirstTextMs: first - requests[0].at,
  requestSetupMs: requests[0].at - trace.promptAt,
  serverFirstFrameMs: requests[0].firstFrameAt! - requests[0].at,
  serverTextStreamMs: sent.at(-1)!.at - sent[0].at,
  firstTextDeliveryMs: first - sent[0].at,
  promptToDoneMs: trace.doneAt - trace.promptAt,
  completionTailMs: trace.doneAt - sent.at(-1)!.at,
  deliveryP50Ms: lag.p50,
  deliveryP95Ms: lag.p95,
  deliveryP99Ms: lag.p99,
  deliveryMaxMs: lag.max,
  gapP95Ms: gaps.length ? distribution(gaps).p95 : 0,
  gapMaxMs: gaps.length ? Math.max(...gaps) : 0,
  requestBytes: requests.reduce((n, r) => n + r.bytes, 0),
  ...(trace.firstEventAt !== undefined ? {promptToFirstEventMs: trace.firstEventAt - trace.promptAt} : {}),
  ...(tools.length ? {toolSpanMs: Math.max(...tools.map(t => t.end!)) - Math.min(...tools.map(t => t.start)), toolRoundTripMs: requests[1].at - requests[0].endAt!} : {})
 }
 for (const [name, value] of Object.entries(scalar)) assert(Number.isFinite(value) && value >= 0, `${name}: invalid clock/order ${value}`)
 return {scalar, deliveryMs: delivery, gapsMs: gaps, receivedFrames: received.length}
}
