import {rmSync, writeFileSync} from 'node:fs'
import {resolve} from 'node:path'

const readyPath = process.argv[2]
if (!readyPath) throw new Error('Usage: bun anthropic-loopback-server.ts <ready-file>')

const messageStart = {type: 'message_start', message: {id: 'msg_tia_loopback', type: 'message', role: 'assistant', model: 'claude-opus-4-8', content: [], stop_reason: null, stop_sequence: null, usage: {input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0}}}
const frames = [
 ['message_start', messageStart],
 ['content_block_start', {type: 'content_block_start', index: 0, content_block: {type: 'text', text: ''}}],
 ['content_block_delta', {type: 'content_block_delta', index: 0, delta: {type: 'text_delta', text: 'loopback ok'}}],
 ['content_block_stop', {type: 'content_block_stop', index: 0}],
 ['message_delta', {type: 'message_delta', delta: {stop_reason: 'end_turn', stop_sequence: null}, usage: {output_tokens: 2}}],
 ['message_stop', {type: 'message_stop'}]
] as const
const body = `${frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')}`

const server = Bun.serve({
 hostname: '127.0.0.1',
 port: 0,
 fetch(request) {
  const url = new URL(request.url)
  if (url.pathname === '/health') return new Response('ok')
  if (request.method !== 'POST' || url.pathname !== '/v1/messages') return new Response('not found', {status: 404})
  return new Response(body, {headers: {'content-type': 'text/event-stream', 'cache-control': 'no-cache'}})
 }
})

const resolvedReadyPath = resolve(readyPath)
writeFileSync(resolvedReadyPath, `${server.port}\n`)
const stop = () => {
 server.stop(true)
 rmSync(resolvedReadyPath, {force: true})
 process.exit(0)
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
