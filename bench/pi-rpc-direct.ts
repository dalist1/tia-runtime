import {createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager} from '@earendil-works/pi-coding-agent'

const provider = process.env.PI_BENCH_PROVIDER ?? 'openai-codex'
const modelId = process.env.PI_BENCH_MODEL ?? 'gpt-5.4'

const modelRuntime = await ModelRuntime.create({modelsPath: null})
const model = modelRuntime.getModel(provider, modelId)
if (!model) throw new Error(`Unknown benchmark model: ${provider}/${modelId}`)
const settingsManager = SettingsManager.inMemory({compaction: {enabled: false}, retry: {enabled: false}})

const resourceLoader = {
 getExtensions: () => ({extensions: [], errors: [], runtime: createExtensionRuntime()}),
 getSkills: () => ({skills: [], diagnostics: []}),
 getPrompts: () => ({prompts: [], diagnostics: []}),
 getThemes: () => ({themes: [], diagnostics: []}),
 getAgentsFiles: () => ({agentsFiles: []}),
 getSystemPrompt: () => '',
 getAppendSystemPrompt: () => [],
 getPathMetadata: () => new Map(),
 extendResources: () => {},
 reload: async () => {}
}

const {session} = await createAgentSession({cwd: process.cwd(), modelRuntime, model, thinkingLevel: 'off', tools: [], resourceLoader, sessionManager: SessionManager.inMemory(), settingsManager})

const output = (value: unknown) => {
 process.stdout.write(`${JSON.stringify(value)}\n`)
}

const success = (id: string | undefined, command: string, data?: unknown) => {
 if (data === undefined) {
  return {id, type: 'response', command, success: true}
 }
 return {id, type: 'response', command, success: true, data}
}

const failure = (id: string | undefined, command: string, error: string) => {
 return {id, type: 'response', command, success: false, error}
}

const getState = () => ({
 model: session.model,
 thinkingLevel: session.thinkingLevel,
 isStreaming: session.isStreaming,
 isCompacting: session.isCompacting,
 steeringMode: session.steeringMode,
 followUpMode: session.followUpMode,
 sessionFile: session.sessionFile,
 sessionId: session.sessionId,
 sessionName: session.sessionName,
 autoCompactionEnabled: session.autoCompactionEnabled,
 messageCount: session.messages.length,
 pendingMessageCount: session.pendingMessageCount
})

const handleCommand = async (parsed: any) => {
 const id = parsed?.id
 switch (parsed?.type) {
  case 'get_state':
   return success(id, 'get_state', getState())
  case 'bash': {
   const result = await session.executeBash(parsed.command)
   return success(id, 'bash', result)
  }
  case 'abort_bash':
   session.abortBash()
   return success(id, 'abort_bash')
  default:
   return failure(id, parsed?.type ?? 'unknown', `Unknown command: ${parsed?.type}`)
 }
}

let buffer = ''
let pending = Promise.resolve()

process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
 buffer += chunk
 for (;;) {
  const newlineIndex = buffer.indexOf('\n')
  if (newlineIndex === -1) {
   break
  }
  let line = buffer.slice(0, newlineIndex)
  buffer = buffer.slice(newlineIndex + 1)
  if (line.endsWith('\r')) {
   line = line.slice(0, -1)
  }
  if (!line) {
   continue
  }
  pending = pending.then(async () => {
   try {
    const parsed = JSON.parse(line)
    output(await handleCommand(parsed))
   } catch (error) {
    output(failure(undefined, 'parse', `Failed to parse command: ${String(error)}`))
   }
  })
 }
})

process.stdin.on('end', () => {
 pending.finally(() => process.exit(0))
})
