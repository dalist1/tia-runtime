import assert from 'node:assert/strict'
import {existsSync, readFileSync} from 'node:fs'
import {join, resolve} from 'node:path'

type Value = string | number | boolean
export type Target = {name: string; command: string[]; protocol: 'rpc' | 'json' | 'slim'; buildMetadata?: string}
export type Scenario = {name: string; turns: number; deltas: number; deltaChars: number; cadenceMs: number; firstDelayMs: number; thinkingDeltas: number; promptChars: number; tools: boolean; consumerDelayMs: number}
export type Config = {schemaVersion: 1; packageDir: string; fastTools: string; fffExtension?: string; targets: Target[]; axes: Record<string, Value[]>; design: 'oat' | 'pairs' | 'grid'; rounds: number; warmups: number; seed: number; timeoutMs: number; maxDurationMs?: number; maxRuns: number; scenarios: Scenario[]}
export type Profile = {name: string; values: Record<string, Value>}

type Parameter = {control: string; scope: 'full' | 'slim' | 'both'; values: Value[]; note: string}
export const parameters: Record<string, Parameter> = {
 session: {control: '--no-session', scope: 'full', values: [true, false], note: 'Persistence tradeoff, not a safe automatic default change.'},
 skills: {control: '--no-skills', scope: 'full', values: [true, false], note: '20 synthetic skill descriptors; disabling removes instructions.'},
 prompts: {control: '--no-prompt-templates', scope: 'full', values: [true, false], note: '20 synthetic templates; disabling removes commands.'},
 themes: {control: '--no-themes', scope: 'full', values: [true, false], note: 'Built-in themes only; RPC/JSON does not measure terminal painting.'},
 context: {control: '--no-context-files', scope: 'full', values: [true, false], note: 'Synthetic AGENTS.md; disabling removes project instructions.'},
 fastTools: {control: 'settings.extensions (fast-tools)', scope: 'full', values: [true, false], note: 'Actual registered read/write/edit/bash versus stock tools; verification stays enabled.'},
 fffMode: {control: 'PI_FFF_MODE', scope: 'full', values: ['disabled', 'override', 'tools-only', 'tools-and-ui'], note: 'Requires fffExtension. Startup/indexing only; search ranking and TUI autocomplete are not measured.'},
 transformCache: {control: 'JITI_FS_CACHE', scope: 'full', values: ['warm', 'disabled', 'cold'], note: 'Cold means empty transform cache per process, not cold OS page cache.'},
 thinking: {control: '--thinking', scope: 'both', values: ['off', 'minimal', 'low', 'medium', 'high'], note: 'Measures request serialization only; scripted thinking is NOT model reasoning or a quality evaluation.'},
 cacheRetention: {control: 'PI_CACHE_RETENTION', scope: 'both', values: ['short', 'long'], note: 'Request markers only; loopback cannot measure real provider cache hits.'},
 transport: {control: 'settings.transport', scope: 'both', values: ['auto', 'sse'], note: 'Both use Anthropic SSE here. WebSocket/provider routing require separate live evidence.'},
 flush: {control: 'TIA_STREAM_FLUSH', scope: 'slim', values: ['microtask', 'immediate'], note: 'Immediate removes a microtask hop but can increase writes/CPU.'},
 deltaChars: {control: 'TIA_STREAM_DELTA_CHARS', scope: 'slim', values: [96, 1, 256, 1024], note: 'UTF-16 code units per coalesced delta, not tokenizer tokens.'},
 outputChars: {control: 'TIA_STREAM_OUTPUT_CHARS', scope: 'slim', values: [16384, 1024, 65536], note: 'Flush threshold in UTF-16 code units; text always bypasses the control timer.'},
 controlDelayMs: {control: 'TIA_STREAM_CONTROL_DELAY_MS', scope: 'slim', values: [4, 0, 1, 8], note: 'Timer for control frames only; may change completion-tail latency.'}
}

export const externalParameters = [
 {controls: ['TIA_DISABLE_LAZY_JITI', 'TIA_PI_MINIFY_SYNTAX', 'TIA_PI_MINIFY_WHITESPACE', 'TIA_PI_MINIFY_IDENTIFIERS', 'TIA_PI_BYTECODE'], coverage: '--build creates same-source binaries and records failed candidates; then benchmark targets.'},
 {controls: ['TIA_PROXY_CHECK_INTERVAL_SECONDS', 'PI_NO_PROXY_AUTO_START'], coverage: 'Not swept: benchmark disables service management. Proxy cold-start and TTL need an isolated service fixture.'},
 {controls: ['TIA_ENABLE_FFF', 'TIA_FFF_SOURCE', 'TIA_FFF_PACKAGE_VERSION', 'PI_PACKAGE_DIR', 'TIA_PI_PACKAGE_VERSION'], coverage: 'Installation/source selectors. Use isolated pinned installations as targets; never silently mix package versions.'},
 {controls: ['TIA_FASTWRITE_FSYNC'], coverage: 'Held at 0 (runtime default). Byte verification never disabled. Filesystem durability must be evaluated separately with bench:tools.'},
 {
  controls: ['provider/model', 'thinkingBudgets', 'maxTokens', 'samplingParams', 'service tier', 'routing', 'websocket', 'websocket-cached', 'httpIdleTimeoutMs', 'websocketConnectTimeoutMs', 'retry'],
  coverage: 'Live provider/cost/quality/reliability dimensions, not measurable with scripted loopback. No paid requests or auto-tuning of these settings.'
 },
 {controls: ['Bun version', 'CPU affinity', 'OS page cache', 'terminal', 'TUI rendering', 'long-history compaction'], coverage: 'Record host/runtime identity and control externally; RPC measurements do not establish terminal paint or live generation latency.'},
 {controls: ['PI_TELEMETRY', 'PI_OFFLINE', 'PI_SKIP_VERSION_CHECK'], coverage: 'Always forced to opt-out/offline; never sweep telemetry on.'}
]

export function defaultConfig(root = resolve('.'), runtime = join(process.env.HOME ?? '', '.local/share/tia')): Config {
 const installedSource = join(runtime, 'pi-package-dir.txt')
 return {
  schemaVersion: 1,
  packageDir: existsSync(installedSource) ? readFileSync(installedSource, 'utf8').trim() : join(root, 'node_modules/@earendil-works/pi-coding-agent'),
  fastTools: join(root, 'scripts/fast-tools-extension.ts'),
  targets: [{name: 'full-rpc', command: [join(runtime, 'bin/pi')], protocol: 'rpc', buildMetadata: join(runtime, 'pi-build.json')}],
  axes: Object.fromEntries(
   Object.entries(parameters)
    .filter(([key, p]) => p.scope !== 'slim' && key !== 'fffMode')
    .map(([key, p]) => [key, p.values])
  ),
  design: 'oat',
  rounds: 8,
  warmups: 1,
  seed: 202609,
  timeoutMs: 20000,
  maxDurationMs: 60000,
  maxRuns: 2000,
  scenarios: [
   {name: 'paced', turns: 3, deltas: 24, deltaChars: 32, cadenceMs: 3, firstDelayMs: 10, thinkingDeltas: 2, promptChars: 128, tools: false, consumerDelayMs: 0},
   {name: 'coding', turns: 3, deltas: 24, deltaChars: 32, cadenceMs: 3, firstDelayMs: 10, thinkingDeltas: 0, promptChars: 8192, tools: true, consumerDelayMs: 0},
   {name: 'burst-long-context', turns: 2, deltas: 128, deltaChars: 128, cadenceMs: 0, firstDelayMs: 0, thinkingDeltas: 0, promptChars: 65536, tools: false, consumerDelayMs: 0},
   {name: 'sparse', turns: 2, deltas: 12, deltaChars: 16, cadenceMs: 12, firstDelayMs: 30, thinkingDeltas: 0, promptChars: 128, tools: false, consumerDelayMs: 0},
   {name: 'slow-consumer', turns: 1, deltas: 256, deltaChars: 1024, cadenceMs: 1, firstDelayMs: 0, thinkingDeltas: 0, promptChars: 128, tools: false, consumerDelayMs: 10}
  ]
 }
}

function keys(object: object, allowed: string[]) {
 for (const key of Object.keys(object)) assert(allowed.includes(key), `Unknown configuration key: ${key}`)
}
function integer(value: number, min: number, max: number) {
 assert(Number.isSafeInteger(value) && value >= min && value <= max, `Expected integer ${min}..${max}, got ${value}`)
}
export function validateConfig(config: Config) {
 keys(config, ['schemaVersion', 'packageDir', 'fastTools', 'fffExtension', 'targets', 'axes', 'design', 'rounds', 'warmups', 'seed', 'timeoutMs', 'maxDurationMs', 'maxRuns', 'scenarios'])
 assert.equal(config.schemaVersion, 1)
 assert(typeof config.packageDir === 'string' && typeof config.fastTools === 'string')
 assert(['oat', 'pairs', 'grid'].includes(config.design))
 integer(config.rounds, 2, 1000)
 integer(config.warmups, 0, 100)
 integer(config.seed, 0, 0xffffffff)
 integer(config.timeoutMs, 100, 300000)
 if (config.maxDurationMs !== undefined) integer(config.maxDurationMs, 100, 3600000)
 integer(config.maxRuns, 1, 100000)
 assert(config.targets.length > 0 && config.scenarios.length > 0)
 for (const target of config.targets) {
  keys(target, ['name', 'command', 'protocol', 'buildMetadata'])
  assert(/^[\w.-]+$/.test(target.name) && ['rpc', 'json', 'slim'].includes(target.protocol))
  assert(target.command.length > 0 && target.command.every(arg => typeof arg === 'string' && arg.length > 0))
 }
 assert.equal(new Set(config.targets.map(t => t.name)).size, config.targets.length, 'Duplicate target')
 assert.equal(new Set(config.scenarios.map(s => s.name)).size, config.scenarios.length, 'Duplicate scenario')
 for (const scenario of config.scenarios) {
  keys(scenario, ['name', 'turns', 'deltas', 'deltaChars', 'cadenceMs', 'firstDelayMs', 'thinkingDeltas', 'promptChars', 'tools', 'consumerDelayMs'])
  assert(/^[\w.-]+$/.test(scenario.name) && typeof scenario.tools === 'boolean')
  integer(scenario.turns, 1, 100)
  integer(scenario.deltas, 2, 10000)
  integer(scenario.deltaChars, 16, 16384)
  integer(scenario.cadenceMs, 0, 1000)
  integer(scenario.firstDelayMs, 0, 10000)
  integer(scenario.thinkingDeltas, 0, 100)
  integer(scenario.promptChars, 0, 1000000)
  integer(scenario.consumerDelayMs, 0, 1000)
  assert(scenario.deltas * scenario.deltaChars <= 2 * 1024 * 1024, 'Response exceeds 2 MiB budget')
 }
 for (const [name, values] of Object.entries(config.axes)) {
  assert(Object.hasOwn(parameters, name), `Unknown parameter: ${name}`)
  assert(Array.isArray(values) && values.length > 0 && new Set(values).size === values.length)
  for (const value of values) assert(parameters[name].values.includes(value), `Unsupported ${name}=${value}; extend the registry and tests first`)
  if (name === 'fffMode' && values.some(v => v !== 'disabled')) assert(config.fffExtension, 'fffMode requires an explicit fffExtension')
 }
 return config
}

export function profiles(config: Config, target: Target): Profile[] {
 const applicable = Object.entries(parameters).filter(([, p]) => p.scope === 'both' || p.scope === (target.protocol === 'slim' ? 'slim' : 'full'))
 const baseline = Object.fromEntries(applicable.map(([key, p]) => [key, config.axes[key]?.[0] ?? p.values[0]]))
 const axes = applicable.map(([key]) => [key, config.axes[key] ?? [baseline[key]]] as const)
 const result: Profile[] = [
  {name: 'baseline', values: baseline},
  {name: 'control', values: {...baseline}}
 ]
 const seen = new Set([JSON.stringify(baseline)])
 const add = (changes: Record<string, Value>) => {
  const values = {...baseline, ...changes},
   signature = JSON.stringify(values)
  if (seen.has(signature)) return
  seen.add(signature)
  result.push({
   name:
    Object.entries(values)
     .filter(([key, value]) => value !== baseline[key])
     .map(([key, value]) => `${key}=${value}`)
     .join(',') || 'baseline',
   values
  })
  assert(result.length <= config.maxRuns, 'Matrix exceeds maxRuns; narrow axes or explicitly raise the budget')
 }
 if (config.design === 'grid') {
  assert(axes.reduce((n, [, values]) => n * values.length, 1) + 1 <= config.maxRuns, 'Cartesian matrix exceeds maxRuns')
  const visit = (index: number, values: Record<string, Value>) => {
   if (index === axes.length) return add(values)
   const [key, options] = axes[index]
   for (const value of options) visit(index + 1, {...values, [key]: value})
  }
  visit(0, {})
 } else {
  for (const [key, values] of axes) for (const value of values) add({[key]: value})
  if (config.design === 'pairs') {
   for (let i = 0; i < axes.length; i++)
    for (let j = i + 1; j < axes.length; j++) {
     for (const a of axes[i][1]) for (const b of axes[j][1]) add({[axes[i][0]]: a, [axes[j][0]]: b})
    }
  }
 }
 return result
}

export function plan(config: Config) {
 validateConfig(config)
 const cells = config.targets.flatMap(target => profiles(config, target).flatMap(profile => config.scenarios.filter(s => target.protocol !== 'slim' || !s.tools).map(scenario => ({target, profile, scenario}))))
 const launches = cells.length * (config.rounds + config.warmups)
 assert(launches <= config.maxRuns, `${launches} launches exceed maxRuns=${config.maxRuns}`)
 const ignoredAxes = config.targets.map(target => ({target: target.name, axes: Object.keys(config.axes).filter(key => !(key in profiles(config, target)[0].values))}))
 return {cells, launches, prompts: cells.reduce((n, cell) => n + (cell.target.protocol === 'rpc' ? cell.scenario.turns : 1), 0) * (config.rounds + config.warmups), ignoredAxes}
}

export function sliceConfig(config: Config, axis: string, scenarioName?: string): Config {
 validateConfig(config)
 assert(axis === 'baseline' || Object.hasOwn(parameters, axis), `Unknown axis: ${axis}`)
 const result = structuredClone(config)
 result.axes = Object.fromEntries(Object.entries(config.axes).map(([name, values]) => [name, [values[0]]]))
 if (axis !== 'baseline') {
  result.axes[axis] = config.axes[axis] ?? parameters[axis].values
  result.targets = result.targets.filter(t => parameters[axis].scope === 'both' || parameters[axis].scope === (t.protocol === 'slim' ? 'slim' : 'full'))
 }
 if (scenarioName) result.scenarios = result.scenarios.filter(s => s.name === scenarioName)
 result.design = 'oat'
 assert(result.targets.length && result.scenarios.length, 'Slice has no applicable target/scenario')
 plan(result)
 return result
}

export function shuffle<T>(values: T[], seed: number) {
 const result = [...values]
 for (let i = result.length - 1; i > 0; i--) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  const j = Math.floor((seed / 0x100000000) * (i + 1))
  ;[result[i], result[j]] = [result[j], result[i]]
 }
 return result
}
