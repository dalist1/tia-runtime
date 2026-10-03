import assert from 'node:assert/strict'

export type LoopMark = {stage: string; at: number; turn: number; request: number; id?: string}

export function traceExtension(sources: string[]) {
 return `import {writeFileSync} from 'node:fs'
${sources.map((source, i) => `import extension${i} from ${JSON.stringify(source)}`).join('\n')}
export default async function (pi) {
 const tracePath = process.env.TIA_BENCH_TRACE_PATH
 if (!tracePath) throw new Error('Missing isolated trace path')
 const marks = []
 let turn = -1, request = 0
 const mark = (stage, id) => marks.push({stage, id, at: performance.now(), turn, request})
 const proxy = new Proxy(pi, {get(target, key) {
  if (key !== 'registerTool') return Reflect.get(target, key)
  return tool => pi.registerTool({...tool, async execute(...args) {
   mark('execute_start', args[0])
   try { return await tool.execute(...args) } finally { mark('execute_end', args[0]) }
  }})
 }})
 ${sources.map((_, i) => `await extension${i}(proxy)`).join('\n ')}
 pi.on('before_agent_start', () => { turn++; request = 0; mark('before_agent_start') })
 pi.on('before_provider_request', () => { request++; mark('before_provider_request') })
 for (const name of ['context', 'context_with_system', 'after_provider_response', 'turn_start', 'turn_end', 'agent_settled', 'tool_execution_start', 'tool_call', 'tool_result', 'tool_execution_end'])
  pi.on(name, event => { mark(name, event.toolCallId) })
 pi.on('provider_stream_event', event => {
  if (event.data?.type === 'message_start') mark('provider_start')
  if (event.data?.type === 'message_stop') mark('provider_end')
 })
 pi.on('message_end', event => {
  if (event.message.role === 'assistant') mark('assistant_end')
 })
 pi.on('session_shutdown', () => { writeFileSync(tracePath, JSON.stringify(marks), {flag: 'wx'}) })
}
`
}

export function traceMetrics(marks: LoopMark[], turns: number) {
 let last = -Infinity
 for (const mark of marks) {
  assert(Number.isFinite(mark.at) && mark.at >= last && Number.isSafeInteger(mark.turn) && mark.turn >= -1 && mark.turn < turns, 'Invalid trace clock or turn')
  last = mark.at
 }
 const span = (list: LoopMark[], first: string, last: string) => {
  const start = list.find(mark => mark.stage === first)
  const end = list.find(mark => mark.stage === last)
  assert(start && end && end.at >= start.at, `Missing or misordered trace boundary: ${first}/${last}`)
  return end.at - start.at
 }
 return Array.from({length: turns}, (_, turn) => {
  const selected = marks.filter(mark => mark.turn === turn)
  assert.equal(selected.filter(mark => mark.stage === 'before_agent_start').length, 1)
  assert.equal(selected.filter(mark => mark.stage === 'agent_settled').length, 1)
  const toolIds = selected.filter(mark => mark.stage === 'tool_execution_start').map(mark => mark.id)
  assert.equal(new Set(toolIds).size, toolIds.length, 'Duplicate traced tool')
  const tools = toolIds.map(id => {
   assert(id, 'Missing traced tool id')
   const tool = selected.filter(mark => mark.id === id)
   return {
    id,
    validationAndBeforeHookMs: span(tool, 'tool_execution_start', 'tool_call'),
    totalMs: span(tool, 'tool_execution_start', 'tool_execution_end'),
    ...(tool.some(mark => mark.stage === 'execute_start') ? {schedulingMs: span(tool, 'tool_call', 'execute_start'), bodyMs: span(tool, 'execute_start', 'execute_end'), resultHooksMs: span(tool, 'execute_end', 'tool_execution_end')} : {})
   }
  })
  const requests = selected.filter(mark => mark.stage === 'before_provider_request').map(mark => mark.request)
  assert(requests.length > 0 && new Set(requests).size === requests.length, 'Missing or duplicate traced request')
  return {
   turn,
   tools,
   requests: requests.map(request => {
    const response = selected.filter(mark => mark.request === request)
    const end = selected.findIndex(mark => mark.stage === 'before_provider_request' && mark.request === request)
    const context = selected
     .slice(0, end)
     .map(mark => mark.stage)
     .lastIndexOf('context')
    return {request, ...(context >= 0 ? {contextAndRequestBuildMs: selected[end].at - selected[context].at} : {}), responseHandlingMs: span(response, 'provider_end', 'assistant_end')}
   }),
   totalMs: span(selected, 'before_agent_start', 'agent_settled')
  }
 })
}
