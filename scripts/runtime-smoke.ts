import assert from 'node:assert/strict'
import {mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {cleanEnvironment, command} from './runtime-build.ts'

export async function smokeRuntime(launcher: string, fff: boolean, log: string) {
 const work = mkdtempSync(join(tmpdir(), 'tia-generation-smoke-'))
 const agent = join(work, 'shell-agent'),
  tiaAgent = join(work, 'tia-agent'),
  home = join(work, 'home')
 for (const path of [agent, tiaAgent, home]) mkdirSync(path)
 writeFileSync(join(work, 'atomic-smoke.txt'), 'atomic-needle café\n')
 writeFileSync(join(work, 'edited.txt'), 'before')
 const calls = [
  {id: 'read', name: 'read', input: {path: join(work, 'atomic-smoke.txt')}},
  {id: 'write', name: 'write', input: {path: join(work, 'written.txt'), content: 'verified café\n'}},
  {id: 'edit', name: 'edit', input: {path: join(work, 'edited.txt'), oldText: 'before', newText: 'after'}},
  {id: 'bash', name: 'bash', input: {command: 'printf atomic-bash'}},
  ...(fff
   ? [
      {id: 'find', name: 'find', input: {pattern: 'atomic-smoke.txt', path: work}},
      {id: 'grep', name: 'grep', input: {pattern: 'atomic-needle', path: join(work, 'atomic-smoke.txt')}}
     ]
   : [])
 ]
 let full = true,
  requests = 0,
  serverError: unknown
 const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
   try {
    const body = await request.json()
    assert.equal(body.model, 'atomic-fixture')
    assert.equal(body.stream, true)
    assert.equal(new URL(request.url).pathname, '/v1/messages')
    requests++
    assert(requests <= (full ? 2 : 1), 'Unexpected provider retry')
    const tools = full && requests === 1
    if (tools)
     for (const call of calls)
      assert(
       body.tools.some((tool: any) => tool.name === call.name),
       `Missing ${call.name} tool`
      )
    if (full && !tools) {
     const results = body.messages.at(-1).content.filter((entry: any) => entry.type === 'tool_result')
     assert.equal(results.length, calls.length)
     for (const call of calls)
      assert(
       results.some((r: any) => r.tool_use_id === call.id && !r.is_error),
       `Failed ${call.name} result`
      )
    }
    const events: Record<string, unknown>[] = [{type: 'message_start', message: {id: 'atomic', type: 'message', role: 'assistant', model: 'atomic-fixture', content: [], stop_reason: null, stop_sequence: null, usage: {input_tokens: 10, output_tokens: 0}}}]
    if (tools)
     for (const [index, call] of calls.entries()) {
      events.push({type: 'content_block_start', index, content_block: {type: 'tool_use', id: call.id, name: call.name, input: {}}}, {type: 'content_block_delta', index, delta: {type: 'input_json_delta', partial_json: JSON.stringify(call.input)}}, {type: 'content_block_stop', index})
     }
    else events.push({type: 'content_block_start', index: 0, content_block: {type: 'text', text: ''}}, {type: 'content_block_delta', index: 0, delta: {type: 'text_delta', text: 'atomic-runtime-ok café'}}, {type: 'content_block_stop', index: 0})
    events.push({type: 'message_delta', delta: {stop_reason: tools ? 'tool_use' : 'end_turn', stop_sequence: null}, usage: {output_tokens: 3}}, {type: 'message_stop'})
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {headers: {'content-type': 'text/event-stream'}})
   } catch (error) {
    serverError = error
    return new Response('Invalid smoke request', {status: 400})
   }
  }
 })
 try {
  writeFileSync(join(agent, 'auth.json'), '{}')
  writeFileSync(join(agent, 'settings.json'), JSON.stringify({enableInstallTelemetry: false, retry: {enabled: false, provider: {maxRetries: 0, timeoutMs: 10000}}, compaction: {enabled: false}}))
  writeFileSync(
   join(agent, 'models.json'),
   JSON.stringify({providers: {atomic: {baseUrl: `http://127.0.0.1:${server.port}`, api: 'anthropic-messages', apiKey: 'loopback-only', models: [{id: 'atomic-fixture', reasoning: false, input: ['text'], cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, contextWindow: 100000, maxTokens: 4096}]}}})
  )
  const env = {...cleanEnvironment(home), PI_CODING_AGENT_DIR: agent, TIA_PI_AGENT_DIR: tiaAgent, TIA_DISABLE_FAST_STREAM: '1', FFF_FRECENCY_DB: join(work, 'fff.sqlite'), FFF_HISTORY_DB: join(work, 'fff-history.sqlite'), TMPDIR: work, JITI_RESPECT_TMPDIR_ENV: '1', JITI_FS_CACHE: 'true'}
  const args = [launcher, 'pi', '--mode', 'json', '--no-session', '--no-context-files', '--provider', 'atomic', '--model', 'atomic-fixture', '--thinking', 'off', 'Validate the runtime']
  const parse = (text: string) =>
   text
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
  const events = parse(await command(args, work, log, env, 30000, true))
  assert(!serverError, String(serverError))
  assert.equal(requests, 2)
  assert(!events.some(event => ['extension_error', 'auto_retry_start'].includes(event.type)), 'Runtime diagnostic during smoke')
  const results = events.filter(event => event.type === 'tool_execution_end')
  assert.equal(results.length, calls.length)
  for (const result of results) assert.equal(result.isError, false, JSON.stringify(result))
  for (const [name, text] of [
   ['read', 'atomic-needle'],
   ['bash', 'atomic-bash'],
   ...(fff
    ? [
       ['find', 'atomic-smoke.txt'],
       ['grep', 'atomic-needle']
      ]
    : [])
  ])
   assert(JSON.stringify(results.find(r => r.toolName === name)?.result).includes(text), `Invalid ${name} result`)
  assert.equal(readFileSync(join(work, 'written.txt'), 'utf8'), 'verified café\n')
  assert.equal(readFileSync(join(work, 'edited.txt'), 'utf8'), 'after')
  assert(
   events.some(event => event.type === 'message_end' && event.message?.stopReason === 'stop' && event.message.content.some((c: any) => c.text === 'atomic-runtime-ok café')),
   'Missing final assistant response'
  )
  assert(
   events.some(event => event.type === 'agent_end' && !event.willRetry),
   'Missing full completion'
  )
  for (const name of ['auth.json', 'models.json', 'settings.json']) assert.equal(readlinkSync(join(tiaAgent, name)), join(agent, name), `Shell agent ${name} was not linked`)
  full = false
  requests = 0
  const slim = parse(await command(args, work, log, {...env, TIA_DISABLE_FAST_STREAM: '0'}, 30000, true))
  assert(!serverError, String(serverError))
  assert.equal(requests, 1)
  assert.equal(
   slim
    .filter(e => e.t === 'd')
    .map(e => e.s)
    .join(''),
   'atomic-runtime-ok café'
  )
  assert(
   slim.some(event => event.t === 'done' && event.stopReason === 'stop' && !event.error),
   'Missing slim completion'
  )
  return {full: true, slim: true, toolCalls: calls.length, fffSearch: fff, writesVerified: true}
 } finally {
  server.stop(true)
  rmSync(work, {recursive: true, force: true})
 }
}
