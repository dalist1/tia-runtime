if ('__PI_PACKAGE_DIR__'.includes('/')) {
 process.env.PI_PACKAGE_DIR ??= '__PI_PACKAGE_DIR__'
}

import {existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, writeFileSync} from 'node:fs'
import {homedir} from 'node:os'
import {join} from 'node:path'
import type {AssistantMessage, AssistantMessageEventStream, Context, SimpleStreamOptions} from '@earendil-works/pi-ai'

type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
type ParsedArgs = {provider?: string; modelId?: string; thinkingLevel?: ThinkingLevel; messages: string[]}
type StreamSink = (chunk: string, callback: () => void) => boolean
type JsonObject = Record<string, any>
type Model = {id: string; name?: string; api: string; provider: string; baseUrl: string; reasoning?: boolean; thinkingLevelMap?: JsonObject; input: string[]; cost: JsonObject; contextWindow: number; maxTokens: number; headers?: Record<string, string>; compat?: JsonObject}

type RuntimeConfig = {model: Model; thinkingLevel?: ThinkingLevel; streamOptions: SimpleStreamOptions; loadApi: () => Promise<{streamSimple: (model: Model, context: Context, options: SimpleStreamOptions) => AssistantMessageEventStream}>}
type RuntimeFiles = {settings: JsonObject; authPath: string; auth: JsonObject; modelsConfig: JsonObject}

const STREAM_RUNTIME_DIR = '__STREAM_RUNTIME_DIR__'
const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'medium'
const EMPTY_COST = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}
const API_KEY_ENV: Record<string, string[]> = {
 'ant-ling': ['ANT_LING_API_KEY'],
 anthropic: ['ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
 openai: ['OPENAI_API_KEY'],
 'azure-openai-responses': ['AZURE_OPENAI_API_KEY'],
 nvidia: ['NVIDIA_API_KEY'],
 deepseek: ['DEEPSEEK_API_KEY'],
 google: ['GEMINI_API_KEY'],
 'google-vertex': ['GOOGLE_CLOUD_API_KEY'],
 'github-copilot': ['COPILOT_GITHUB_TOKEN'],
 groq: ['GROQ_API_KEY'],
 cerebras: ['CEREBRAS_API_KEY'],
 xai: ['XAI_API_KEY'],
 openrouter: ['OPENROUTER_API_KEY'],
 'vercel-ai-gateway': ['AI_GATEWAY_API_KEY'],
 zai: ['ZAI_API_KEY'],
 'zai-coding-cn': ['ZAI_CODING_CN_API_KEY'],
 mistral: ['MISTRAL_API_KEY'],
 minimax: ['MINIMAX_API_KEY'],
 'minimax-cn': ['MINIMAX_CN_API_KEY'],
 moonshotai: ['MOONSHOT_API_KEY'],
 'moonshotai-cn': ['MOONSHOT_API_KEY'],
 huggingface: ['HF_TOKEN'],
 fireworks: ['FIREWORKS_API_KEY'],
 together: ['TOGETHER_API_KEY'],
 'kimi-coding': ['KIMI_API_KEY'],
 'cloudflare-workers-ai': ['CLOUDFLARE_API_KEY'],
 'cloudflare-ai-gateway': ['CLOUDFLARE_API_KEY'],
 xiaomi: ['XIAOMI_API_KEY'],
 'xiaomi-token-plan-cn': ['XIAOMI_TOKEN_PLAN_CN_API_KEY'],
 'xiaomi-token-plan-ams': ['XIAOMI_TOKEN_PLAN_AMS_API_KEY'],
 'xiaomi-token-plan-sgp': ['XIAOMI_TOKEN_PLAN_SGP_API_KEY']
}

const DEFAULT_MODEL: Record<string, string> = {
 'amazon-bedrock': 'us.anthropic.claude-opus-4-6-v1',
 'ant-ling': 'Ring-2.6-1T',
 anthropic: 'claude-opus-4-8',
 openai: 'gpt-5.5',
 'azure-openai-responses': 'gpt-5.4',
 'openai-codex': 'gpt-5.5',
 nvidia: 'nvidia/nemotron-3-super-120b-a12b',
 deepseek: 'deepseek-v4-pro',
 google: 'gemini-3.1-pro-preview',
 'google-vertex': 'gemini-3.1-pro-preview',
 'github-copilot': 'gpt-5.4',
 openrouter: 'moonshotai/kimi-k2.6',
 'vercel-ai-gateway': 'zai/glm-5.1',
 xai: 'grok-4.20-0309-reasoning',
 groq: 'openai/gpt-oss-120b',
 cerebras: 'zai-glm-4.7',
 zai: 'glm-5.1',
 'zai-coding-cn': 'glm-5.1',
 mistral: 'devstral-medium-latest',
 minimax: 'MiniMax-M2.7',
 'minimax-cn': 'MiniMax-M2.7',
 moonshotai: 'kimi-k2.6',
 'moonshotai-cn': 'kimi-k2.6',
 huggingface: 'moonshotai/Kimi-K2.6',
 fireworks: 'accounts/fireworks/models/kimi-k2p6',
 together: 'moonshotai/Kimi-K2.6',
 'kimi-coding': 'kimi-for-coding',
 'cloudflare-workers-ai': '@cf/moonshotai/kimi-k2.6',
 'cloudflare-ai-gateway': 'workers-ai/@cf/moonshotai/kimi-k2.6',
 xiaomi: 'mimo-v2.5-pro',
 'xiaomi-token-plan-cn': 'mimo-v2.5-pro',
 'xiaomi-token-plan-ams': 'mimo-v2.5-pro',
 'xiaomi-token-plan-sgp': 'mimo-v2.5-pro'
}

function isThinkingLevel(value: string): value is ThinkingLevel {
 return value === 'off' || value === 'minimal' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh'
}

function requireValue(argv: string[], index: number, flag: string) {
 const value = argv[index + 1]
 if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`)
 return value
}

export function parseArgs(argv: string[]): ParsedArgs {
 const parsed: ParsedArgs = {messages: []}
 for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]
  if (arg === '--mode') {
   const value = requireValue(argv, i, arg)
   i += 1
   if (value !== 'json') throw new Error(`Unsupported mode for direct stream runner: ${value}`)
  } else if (arg.startsWith('--mode=')) {
   const value = arg.slice(7)
   if (value !== 'json') throw new Error(`Unsupported mode for direct stream runner: ${value}`)
  } else if (arg === '--provider') {
   parsed.provider = requireValue(argv, i, arg)
   i += 1
  } else if (arg.startsWith('--provider=')) {
   parsed.provider = arg.slice(11)
  } else if (arg === '--model') {
   parsed.modelId = requireValue(argv, i, arg)
   i += 1
  } else if (arg.startsWith('--model=')) {
   parsed.modelId = arg.slice(8)
  } else if (arg === '--thinking') {
   const value = requireValue(argv, i, arg)
   i += 1
   if (!isThinkingLevel(value)) throw new Error(`Unsupported thinking level: ${value}`)
   parsed.thinkingLevel = value
  } else if (arg.startsWith('--thinking=')) {
   const value = arg.slice(11)
   if (!isThinkingLevel(value)) throw new Error(`Unsupported thinking level: ${value}`)
   parsed.thinkingLevel = value
  } else if (arg === '--no-session' || arg === '--no-extensions' || arg === '--no-skills' || arg === '--no-prompt-templates' || arg === '--no-themes' || arg === '--no-tools' || arg === '--no-context-files' || arg === '--print' || arg === '-p') {
   continue
  } else if (arg.startsWith('-')) {
   throw new Error(`Unsupported argument for direct stream runner: ${arg}`)
  } else {
   parsed.messages.push(arg)
  }
 }
 return parsed
}

function defaultSink(chunk: string, callback: () => void): boolean {
 return process.stdout.write(chunk, callback)
}

export class SlimStreamWriter {
 private outChunks: string[] = []
 private outLength = 0
 private deltaIndex: number | undefined
 private deltaText = ''
 private extraIndex: number | undefined
 private extraText = ''
 private extraDeltas: Map<number, string> | undefined
 private writing = false
 private waiters: Array<() => void> = []
 private timer: ReturnType<typeof setTimeout> | null = null
 private flushQueued = false
 private sink: StreamSink

 constructor(sink: StreamSink = defaultSink) {
  this.sink = sink
 }

 enqueue(event: unknown) {
  this.appendRaw(`${JSON.stringify(event)}\n`)
 }

 enqueueTextStart(index: number) {
  this.appendRaw(`{"t":"s","i":${index}}\n`)
 }

 enqueueTextEnd(index: number) {
  this.flushDeltaIndex(index)
  this.appendRaw(`{"t":"e","i":${index}}\n`)
 }

 enqueueDelta(index: number, delta: string) {
  let buffered: string
  let mapped: string | undefined
  if (this.deltaIndex === index) {
   buffered = this.deltaText + delta
   this.deltaText = buffered
  } else if (this.extraIndex === index) {
   buffered = this.extraText + delta
   this.extraText = buffered
  } else if ((mapped = this.extraDeltas?.get(index)) !== undefined) {
   buffered = mapped + delta
   this.extraDeltas?.set(index, buffered)
  } else if (this.deltaIndex === undefined) {
   this.deltaIndex = index
   buffered = delta
   this.deltaText = delta
  } else if (this.extraIndex === undefined) {
   this.extraIndex = index
   buffered = delta
   this.extraText = delta
  } else {
   const extraDeltas = this.extraDeltas ?? (this.extraDeltas = new Map())
   buffered = delta
   extraDeltas.set(index, buffered)
  }
  if (buffered.length >= 96) {
   this.flushDeltaIndex(index)
  }
  this.flushSoon(true)
 }

 flushDeltaIndex(index: number) {
  const isPrimary = this.deltaIndex === index
  const isExtra = this.extraIndex === index
  const delta = isPrimary ? this.deltaText : isExtra ? this.extraText : this.extraDeltas?.get(index)
  if (isPrimary) {
   this.deltaIndex = undefined
   this.deltaText = ''
  } else if (isExtra) {
   this.extraIndex = undefined
   this.extraText = ''
  } else {
   this.extraDeltas?.delete(index)
   if (this.extraDeltas?.size === 0) this.extraDeltas = undefined
  }
  if (!delta) return
  this.appendRaw(`{"t":"d","i":${index},"s":${JSON.stringify(delta)}}\n`, false)
 }

 flushDeltas() {
  if (!this.extraDeltas) {
   const primaryIndex = this.deltaIndex
   const extraIndex = this.extraIndex
   if (primaryIndex === undefined) {
    if (extraIndex !== undefined) this.flushDeltaIndex(extraIndex)
   } else if (extraIndex === undefined) {
    this.flushDeltaIndex(primaryIndex)
   } else if (primaryIndex < extraIndex) {
    this.flushDeltaIndex(primaryIndex)
    this.flushDeltaIndex(extraIndex)
   } else {
    this.flushDeltaIndex(extraIndex)
    this.flushDeltaIndex(primaryIndex)
   }
   return
  }
  const indices = [...this.extraDeltas.keys()]
  if (this.deltaIndex !== undefined) indices.push(this.deltaIndex)
  if (this.extraIndex !== undefined) indices.push(this.extraIndex)
  for (const index of indices.sort((a, b) => a - b)) this.flushDeltaIndex(index)
 }

 private hasDeltas() {
  return this.deltaIndex !== undefined || this.extraIndex !== undefined || this.extraDeltas !== undefined
 }

 private appendRaw(line: string, schedule = true) {
  this.outChunks.push(line)
  this.outLength += line.length
  if (!schedule) return
  this.flushSoon(this.outLength >= 16384)
 }

 private flushSoon(immediate: boolean) {
  if (this.timer) {
   if (!immediate) return
   clearTimeout(this.timer)
   this.timer = null
  }
  if (this.flushQueued) return
  if (immediate) {
   this.flushQueued = true
   queueMicrotask(() => {
    this.flushQueued = false
    this.flush()
   })
   return
  }
  this.timer = setTimeout(() => {
   this.timer = null
   this.flush()
  }, 4)
 }

 private settle() {
  if (this.outLength > 0 || this.hasDeltas()) {
   this.flushSoon(true)
   return
  }
  const waiters = this.waiters
  this.waiters = []
  for (const resolve of waiters) resolve()
 }

 private flush() {
  this.flushDeltas()
  if (this.writing || this.outLength === 0) return
  this.writing = true
  const chunk = this.outChunks.length === 1 ? this.outChunks[0] : this.outChunks.join('')
  this.outChunks = []
  this.outLength = 0
  this.sink(chunk, () => {
   this.writing = false
   this.settle()
  })
 }

 async drain() {
  if (this.timer) {
   clearTimeout(this.timer)
   this.timer = null
  }
  this.flush()
  if (!this.writing && this.outLength === 0 && !this.hasDeltas()) return
  await new Promise<void>(resolve => {
   this.waiters.push(resolve)
   this.flushSoon(true)
  })
 }
}

function stripJsonComments(input: string) {
 return input.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, match => (match[0] === '"' ? match : '')).replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail) => tail ?? (match[0] === '"' ? match : ''))
}

function readJson(path: string, comments = false) {
 return readOptionalJson(path, comments) ?? {}
}

function readOptionalText(path: string) {
 try {
  return readFileSync(path, 'utf8')
 } catch (error) {
  if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT') return undefined
  throw error
 }
}

function readOptionalJson(path: string, comments = false) {
 const content = readOptionalText(path)
 return content === undefined ? undefined : JSON.parse(comments ? stripJsonComments(content) : content)
}

function deepMerge(base: JsonObject, overrides: JsonObject): JsonObject {
 const result = {...base}
 for (const [key, value] of Object.entries(overrides)) {
  const current = result[key]
  if (value && current && typeof value === 'object' && typeof current === 'object' && !Array.isArray(value) && !Array.isArray(current)) {
   result[key] = {...current, ...value}
  } else if (value !== undefined) {
   result[key] = value
  }
 }
 return result
}

function mergeCompat(base: JsonObject | undefined, override: JsonObject | undefined) {
 if (!override) return base
 const merged = {...base, ...override}
 for (const key of ['openRouterRouting', 'vercelGatewayRouting', 'chatTemplateKwargs']) {
  if (base?.[key] || override[key]) merged[key] = Object.assign({}, base?.[key], override[key])
 }
 return merged
}

function applyOverride(model: Model, override: JsonObject): Model {
 const cost = override.cost ? {...model.cost, ...override.cost} : model.cost
 return {
  ...model,
  ...(override.name !== undefined ? {name: override.name} : {}),
  ...(override.reasoning !== undefined ? {reasoning: override.reasoning} : {}),
  ...(override.input !== undefined ? {input: override.input} : {}),
  ...(override.contextWindow !== undefined ? {contextWindow: override.contextWindow} : {}),
  ...(override.maxTokens !== undefined ? {maxTokens: override.maxTokens} : {}),
  thinkingLevelMap: override.thinkingLevelMap ? {...model.thinkingLevelMap, ...override.thinkingLevelMap} : model.thinkingLevelMap,
  cost,
  compat: mergeCompat(model.compat, override.compat)
 }
}

function createModelMap(catalog: JsonObject, config: JsonObject) {
 const providers = new Map<string, Model[]>()
 const requestConfig = new Map<string, JsonObject>()
 const modelHeaders = new Map<string, Record<string, string>>()
 for (const [provider, values] of Object.entries(catalog)) providers.set(provider, Object.values(values))
 const configuredProviders = config.providers && typeof config.providers === 'object' ? config.providers : {}
 for (const [provider, rawProviderConfig] of Object.entries(configuredProviders)) {
  const providerConfig: JsonObject = rawProviderConfig ?? {}
  requestConfig.set(provider, providerConfig)
  const current = providers.get(provider) ?? []
  let models = current.map(model => {
   let next = model
   if (providerConfig.baseUrl || providerConfig.compat) {
    next = {...next, baseUrl: providerConfig.baseUrl ?? next.baseUrl, compat: mergeCompat(next.compat, providerConfig.compat)}
   }
   const override = providerConfig.modelOverrides?.[next.id]
   if (override) next = applyOverride(next, override)
   if (override?.headers) modelHeaders.set(`${provider}:${next.id}`, override.headers)
   return next
  })
  const defaults = models[0]
  for (const definition of providerConfig.models ?? []) {
   const existing = models.findIndex(model => model.id === definition.id)
   const model = {
    id: definition.id,
    name: definition.name ?? definition.id,
    api: definition.api ?? providerConfig.api ?? defaults?.api,
    provider,
    baseUrl: definition.baseUrl ?? providerConfig.baseUrl ?? defaults?.baseUrl,
    reasoning: definition.reasoning ?? false,
    thinkingLevelMap: definition.thinkingLevelMap,
    input: definition.input ?? ['text'],
    cost: definition.cost ?? EMPTY_COST,
    contextWindow: definition.contextWindow ?? 128000,
    maxTokens: definition.maxTokens ?? 16384,
    compat: mergeCompat(providerConfig.compat, definition.compat)
   }
   if (!model.api || !model.baseUrl) continue
   if (definition.headers) modelHeaders.set(`${provider}:${model.id}`, definition.headers)
   if (existing < 0) models.push(model)
   else models[existing] = model
  }
  providers.set(provider, models)
 }
 return {providers, requestConfig, modelHeaders}
}

function envApiKey(provider: string, env?: Record<string, string>) {
 for (const name of API_KEY_ENV[provider] ?? []) {
  const value = env?.[name] ?? process.env[name]
  if (value) return value
 }
 if (provider === 'amazon-bedrock' && (process.env.AWS_PROFILE || process.env.AWS_BEARER_TOKEN_BEDROCK || process.env.AWS_WEB_IDENTITY_TOKEN_FILE || (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY))) return '<authenticated>'
 return undefined
}

function templateConfigured(value: string, env?: Record<string, string>) {
 if (value.startsWith('!')) return true
 for (const match of value.matchAll(/\$(?:{([A-Za-z_][A-Za-z0-9_]*)}|([A-Za-z_][A-Za-z0-9_]*))/g)) {
  const name = match[1] ?? match[2]
  if (!(env?.[name] ?? process.env[name])) return false
 }
 return true
}

function resolveConfigValue(value: string, env?: Record<string, string>) {
 if (value.startsWith('!')) {
  const result = Bun.spawnSync(['/bin/sh', '-c', value.slice(1)], {stdout: 'pipe', stderr: 'ignore'})
  if (result.exitCode !== 0) return undefined
  return result.stdout.toString().trim() || undefined
 }
 let missing = false
 const resolved = value
  .replace(/\$\$/g, '\u0000')
  .replace(/\$!/g, '\u0001')
  .replace(/\$(?:{([A-Za-z_][A-Za-z0-9_]*)}|([A-Za-z_][A-Za-z0-9_]*))/g, (_match, braced, plain) => {
   const found = env?.[braced ?? plain] ?? process.env[braced ?? plain]
   if (found === undefined) missing = true
   return found ?? ''
  })
 return missing ? undefined : resolved.split('\u0000').join('$').split('\u0001').join('!')
}

function resolveHeaders(headers: Record<string, string> | undefined, env?: Record<string, string>) {
 if (!headers) return undefined
 const resolved: Record<string, string> = {}
 for (const [key, value] of Object.entries(headers)) {
  const result = resolveConfigValue(value, env)
  if (result === undefined) throw new Error(`Failed to resolve header "${key}"`)
  resolved[key] = result
 }
 return Object.keys(resolved).length > 0 ? resolved : undefined
}

function hasAuth(provider: string, auth: JsonObject, requestConfig: Map<string, JsonObject>) {
 if (auth[provider] || envApiKey(provider)) return true
 const value = requestConfig.get(provider)?.apiKey
 return typeof value === 'string' && templateConfigured(value)
}

function configuredAuth(provider: string, auth: JsonObject, modelsConfig: JsonObject) {
 if (auth[provider] || envApiKey(provider)) return true
 const configuredProviders = modelsConfig.providers
 if (!configuredProviders || typeof configuredProviders !== 'object') return false
 const providerConfig = Reflect.get(configuredProviders, provider)
 if (!providerConfig || typeof providerConfig !== 'object') return false
 const value = Reflect.get(providerConfig, 'apiKey')
 return typeof value === 'string' && templateConfigured(value)
}

function preferredCatalogProvider(parsed: ParsedArgs, files: RuntimeFiles) {
 if (parsed.provider) return parsed.provider
 if (parsed.modelId?.includes('/')) return parsed.modelId.slice(0, parsed.modelId.indexOf('/'))
 if (parsed.modelId) {
  const index = readOptionalText(join(STREAM_RUNTIME_DIR, 'model-index.txt'))
  if (index) {
   const marker = `\n${splitThinking(parsed.modelId).pattern.toLowerCase()}\t`
   const position = index.indexOf(marker)
   if (position !== -1) {
    const start = position + marker.length
    const end = index.indexOf('\n', start)
    if (end !== -1) return index.slice(start, end)
   }
  }
  return undefined
 }
 const defaultProvider = typeof files.settings.defaultProvider === 'string' ? files.settings.defaultProvider : undefined
 const defaultModel = typeof files.settings.defaultModel === 'string' ? files.settings.defaultModel : undefined
 if (defaultProvider && defaultModel && configuredAuth(defaultProvider, files.auth, files.modelsConfig)) return defaultProvider
 for (const provider in DEFAULT_MODEL) {
  if (configuredAuth(provider, files.auth, files.modelsConfig)) return provider
 }
 return undefined
}

function loadCatalog(provider: string | undefined) {
 if (provider && /^[a-z0-9-]+$/.test(provider)) {
  const models = readOptionalJson(join(STREAM_RUNTIME_DIR, 'models', `${provider}.json`))
  if (models && typeof models === 'object') return {[provider]: models}
 }
 return readJson(join(STREAM_RUNTIME_DIR, 'models.json'))
}

function splitThinking(pattern: string) {
 const colon = pattern.lastIndexOf(':')
 if (colon < 0) return {pattern}
 const suffix = pattern.slice(colon + 1)
 return isThinkingLevel(suffix) ? {pattern: pattern.slice(0, colon), thinkingLevel: suffix} : {pattern}
}

function findModel(models: Model[], pattern: string) {
 const lower = pattern.toLowerCase()
 const exact = models.find(model => model.id.toLowerCase() === lower || `${model.provider}/${model.id}`.toLowerCase() === lower)
 if (exact) return exact
 const matches = models.filter(model => model.id.toLowerCase().includes(lower) || model.name?.toLowerCase().includes(lower))
 const aliases = matches.filter(model => !/-\d{8}$/.test(model.id))
 return (aliases.length > 0 ? aliases : matches).sort((a, b) => b.id.localeCompare(a.id))[0]
}

function selectModel(parsed: ParsedArgs, settings: JsonObject, providers: Map<string, Model[]>, auth: JsonObject, requestConfig: Map<string, JsonObject>) {
 let thinkingLevel: ThinkingLevel | undefined
 let provider = parsed.provider
 let pattern = parsed.modelId
 if (!provider && pattern?.includes('/')) {
  const slash = pattern.indexOf('/')
  const candidate = pattern.slice(0, slash)
  if (providers.has(candidate)) {
   provider = candidate
   pattern = pattern.slice(slash + 1)
  }
 }
 if (pattern) {
  const split = splitThinking(pattern)
  pattern = split.pattern
  thinkingLevel = split.thinkingLevel
  if (provider) {
   const candidates = providers.get(provider) ?? []
   const found = findModel(candidates, pattern)
   if (found) return {model: found, thinkingLevel}
   if (candidates[0]) return {model: {...candidates[0], id: pattern, name: pattern}, thinkingLevel}
  } else {
   const matches = [...providers.values()].flatMap(models => models.filter(model => model.id.toLowerCase() === pattern!.toLowerCase()))
   if (matches.length === 1) return {model: matches[0], thinkingLevel}
  }
 }
 if (provider) {
  const candidates = providers.get(provider) ?? []
  const preferred = candidates.find(model => model.id === DEFAULT_MODEL[provider!]) ?? candidates[0]
  if (preferred) return {model: preferred, thinkingLevel}
 }
 const defaultProvider = typeof settings.defaultProvider === 'string' ? settings.defaultProvider : undefined
 const defaultModel = typeof settings.defaultModel === 'string' ? settings.defaultModel : undefined
 if (defaultProvider && defaultModel && hasAuth(defaultProvider, auth, requestConfig)) {
  const found = providers.get(defaultProvider)?.find(model => model.id === defaultModel)
  if (found) return {model: found, thinkingLevel: typeof settings.defaultThinkingLevel === 'string' && isThinkingLevel(settings.defaultThinkingLevel) ? settings.defaultThinkingLevel : undefined}
 }
 for (const candidateProvider in DEFAULT_MODEL) {
  if (!hasAuth(candidateProvider, auth, requestConfig)) continue
  const found = providers.get(candidateProvider)?.find(model => model.id === DEFAULT_MODEL[candidateProvider])
  if (found) return {model: found, thinkingLevel}
 }
 for (const [candidateProvider, models] of providers) {
  if (models[0] && hasAuth(candidateProvider, auth, requestConfig)) return {model: models[0], thinkingLevel}
 }
 throw new Error('No configured model available')
}

function githubCopilotBaseUrl(token: string, enterpriseUrl?: string) {
 const match = token.match(/proxy-ep=([^;]+)/)
 if (match) return `https://${match[1].replace(/^proxy\./, 'api.')}`
 if (enterpriseUrl) {
  try {
   return `https://copilot-api.${new URL(enterpriseUrl.includes('://') ? enterpriseUrl : `https://${enterpriseUrl}`).hostname}`
  } catch {}
 }
 return 'https://api.individual.githubcopilot.com'
}

async function resolveOAuth(providerId: string, credential: JsonObject, auth: JsonObject, authPath: string) {
 let current = credential
 if (Date.now() >= Number(current.expires ?? 0)) {
  const targetPath = existsSync(authPath) ? realpathSync(authPath) : authPath
  const lockPath = `${targetPath}.lock`
  let locked = false
  for (let attempt = 0; attempt < 500; attempt += 1) {
   try {
    mkdirSync(lockPath)
    locked = true
    break
   } catch {
    await Bun.sleep(20)
   }
  }
  if (!locked) throw new Error(`Timed out locking OAuth credentials for "${providerId}"`)
  try {
   const latestAuth = readJson(targetPath)
   const latest = latestAuth[providerId]
   if (latest?.type === 'oauth' && Date.now() < Number(latest.expires ?? 0)) {
    current = latest
   } else {
    const oauthPath = join(STREAM_RUNTIME_DIR, 'oauth.mjs')
    const oauth = await import(oauthPath)
    const provider = oauth.getOAuthProvider(providerId)
    if (!provider) throw new Error(`Unknown OAuth provider: ${providerId}`)
    current = await provider.refreshToken(current)
    const next = {...auth, ...latestAuth, [providerId]: {type: 'oauth', ...current}}
    const temporary = `${targetPath}.tia-stream-${process.pid}`
    writeFileSync(temporary, JSON.stringify(next, null, 2), {mode: 0o600})
    renameSync(temporary, targetPath)
   }
  } finally {
   rmdirSync(lockPath)
  }
 }
 const access = current.access
 if (typeof access !== 'string' || access.length === 0) throw new Error(`No OAuth access token for "${providerId}"`)
 return {apiKey: access, credential: current}
}

function readRuntimeFiles(): RuntimeFiles {
 const agentDir = process.env.TIA_STREAM_AGENT_DIR || process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent')
 const globalSettings = readJson(join(agentDir, 'settings.json'))
 const projectSettings = readJson(join(process.cwd(), '.pi', 'settings.json'))
 const settings = deepMerge(globalSettings, projectSettings)
 const authPath = join(agentDir, 'auth.json')
 const auth = readJson(authPath)
 const modelsConfig = readJson(join(agentDir, 'models.json'), true)
 return {settings, authPath, auth, modelsConfig}
}

async function prepareRuntime(parsed: ParsedArgs, catalog: JsonObject, files: RuntimeFiles): Promise<RuntimeConfig> {
 const {settings, authPath, auth, modelsConfig} = files
 const {providers, requestConfig, modelHeaders} = createModelMap(catalog, modelsConfig)
 const selected = selectModel(parsed, settings, providers, auth, requestConfig)
 let model = selected.model
 const providerConfig = requestConfig.get(model.provider)
 const credential = auth[model.provider]
 const providerEnv = credential?.type === 'api_key' && credential.env ? credential.env : undefined
 let apiKey: string | undefined
 if (credential?.type === 'api_key' && typeof credential.key === 'string') apiKey = resolveConfigValue(credential.key, providerEnv)
 if (credential?.type === 'oauth') {
  const oauth = await resolveOAuth(model.provider, credential, auth, authPath)
  apiKey = oauth.apiKey
  if (model.provider === 'github-copilot') model = {...model, baseUrl: githubCopilotBaseUrl(apiKey, oauth.credential.enterpriseUrl)}
 }
 if (!apiKey && typeof providerConfig?.apiKey === 'string') apiKey = resolveConfigValue(providerConfig.apiKey, providerEnv)
 apiKey ??= envApiKey(model.provider, providerEnv)
 const providerHeaders = resolveHeaders(providerConfig?.headers, providerEnv)
 const perModelHeaders = resolveHeaders(modelHeaders.get(`${model.provider}:${model.id}`), providerEnv)
 let headers = model.headers || providerHeaders || perModelHeaders ? {...model.headers, ...providerHeaders, ...perModelHeaders} : undefined
 if (providerConfig?.authHeader) {
  if (!apiKey) throw new Error(`No API key found for "${model.provider}"`)
  headers = {...headers, Authorization: `Bearer ${apiKey}`}
 }
 const retry = settings.retry?.provider ?? {}
 const streamOptions = {
  apiKey,
  headers,
  env: providerEnv,
  reasoning: resolveReasoning(parsed.thinkingLevel ?? selected.thinkingLevel ?? (isThinkingLevel(settings.defaultThinkingLevel) ? settings.defaultThinkingLevel : DEFAULT_THINKING_LEVEL), model),
  thinkingBudgets: settings.thinkingBudgets,
  transport: settings.transport ?? (typeof settings.websockets === 'boolean' ? (settings.websockets ? 'websocket' : 'sse') : 'auto'),
  timeoutMs: retry.timeoutMs,
  maxRetries: retry.maxRetries,
  maxRetryDelayMs: retry.maxRetryDelayMs ?? 60000
 }
 const apiPath = join(STREAM_RUNTIME_DIR, `${model.api}.mjs`)
 if (!supportedApi(model.api) || !existsSync(apiPath)) throw new Error(`Unsupported API for direct stream runner: ${model.api}`)
 return {model, thinkingLevel: selected.thinkingLevel, streamOptions, loadApi: () => import(apiPath)}
}

function supportedApi(api: string) {
 switch (api) {
  case 'anthropic-messages':
  case 'azure-openai-responses':
  case 'bedrock-converse-stream':
  case 'google-generative-ai':
  case 'google-vertex':
  case 'mistral-conversations':
  case 'openai-codex-responses':
  case 'openai-completions':
  case 'openai-responses':
   return true
  default:
   return false
 }
}

function resolveReasoning(level: ThinkingLevel | undefined, model: {reasoning?: boolean}): SimpleStreamOptions['reasoning'] {
 if (!model.reasoning || !level || level === 'off') return undefined
 return level
}

async function readStdin(): Promise<string> {
 let data = ''
 process.stdin.setEncoding('utf8')
 for await (const chunk of process.stdin) data += chunk
 return data.replace(/\n+$/, '')
}

async function main() {
 const parsed = parseArgs(process.argv.slice(2))
 const inputPromise = parsed.messages.length === 0 && !process.stdin.isTTY ? readStdin() : undefined
 const files = readRuntimeFiles()
 const catalog = loadCatalog(preferredCatalogProvider(parsed, files))
 const piped = await inputPromise
 if (piped) parsed.messages.push(piped)
 const runtime = await prepareRuntime(parsed, catalog, files)
 const apiPromise = parsed.messages.length > 0 ? runtime.loadApi() : undefined
 const writer = new SlimStreamWriter()
 writer.enqueue({t: 'session', model: runtime.model.id, provider: runtime.model.provider})
 const messages: Context['messages'] = []

 async function prompt(message: string) {
  messages.push({role: 'user', content: message, timestamp: Date.now()})
  const context: Context = {systemPrompt: '', messages, tools: []}
  const api = await (apiPromise ?? runtime.loadApi())
  const stream = api.streamSimple(runtime.model, context, runtime.streamOptions)
  let finalMessage: AssistantMessage | undefined
  for await (const event of stream) {
   if (event?.type === 'text_start') writer.enqueueTextStart(event.contentIndex)
   else if (event?.type === 'text_delta') writer.enqueueDelta(event.contentIndex, event.delta ?? '')
   else if (event?.type === 'text_end') writer.enqueueTextEnd(event.contentIndex)
   else if (event?.type === 'done') finalMessage = event.message
   else if (event?.type === 'error') finalMessage = event.error
  }
  finalMessage ??= await stream.result()
  writer.flushDeltas()
  writer.enqueue({t: 'done', usage: finalMessage?.usage, stopReason: finalMessage?.stopReason, error: finalMessage?.errorMessage})
  if (finalMessage) messages.push(finalMessage)
 }

 for (const message of parsed.messages) await prompt(message)
 await writer.drain()
}

if (import.meta.main) {
 main().catch(error => {
  console.error(error)
  process.exit(1)
 })
}
