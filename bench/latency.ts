import assert from 'node:assert/strict'
import {appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync} from 'node:fs'
import {cpus, release, tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {buildPi} from '../scripts/build-pi.ts'
import {defaultConfig, externalParameters, parameters, plan, shuffle, sliceConfig, type Config, type Profile, type Scenario, type Target} from './latency-config.ts'
import {distribution, hash, JsonlReader, loopback, metrics, newTurn, now, type TurnTrace} from './latency-fixture.ts'
import {pairedSpeedup} from './tool-benchmark.ts'

type Cell = {target: Target; profile: Profile; scenario: Scenario}
type Sample = {
 id: number
 round: number
 warmup: boolean
 target: string
 profile: string
 scenario: string
 start: number
 readyMs: number
 elapsedMs: number
 cpuMicros: number
 stdoutBytes: number
 eventCount: number
 cache: {mode: string; beforeFiles: number; afterFiles: number}
 turns: {phase: string; trace: TurnTrace; metrics: ReturnType<typeof metrics>}[]
}
const json = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 1) + '\n', {flag: 'wx'})
const shaFile = (path: string) => hash(readFileSync(path))
const turnCount = (target: Target, scenario: Scenario) => (target.protocol === 'rpc' ? scenario.turns : 1)

function setup(config: Config, work: string) {
 const view = join(work, 'package')
 mkdirSync(view)
 symlinkSync(join(resolve(config.packageDir), 'dist'), join(view, 'dist'))
 for (const [name, source] of [
  ['package.json', 'package.json'],
  ['theme', 'dist/modes/interactive/theme'],
  ['assets', 'dist/modes/interactive/assets'],
  ['export-html', 'dist/core/export-html']
 ]) {
  symlinkSync(join(resolve(config.packageDir), source), join(view, name))
 }
 return view
}

function fixture(config: Config, cell: Cell, work: string, id: number, url: string) {
 const directory = join(work, `run-${id}`),
  agent = join(directory, 'agent'),
  home = join(directory, 'home')
 for (const path of [directory, agent, home, join(agent, 'skills'), join(agent, 'prompts')]) mkdirSync(path, {recursive: true})
 writeFileSync(join(directory, 'source.txt'), 'source café\nsecond line\n')
 writeFileSync(join(directory, 'AGENTS.md'), '# Benchmark fixture\nPreserve verified writes and coding tools.\n' + 'Synthetic context.\n'.repeat(400))
 for (let i = 0; i < 20; i++) {
  const skill = join(agent, `skills/fixture-${i}`)
  mkdirSync(skill)
  writeFileSync(join(skill, 'SKILL.md'), `---\nname: fixture-${i}\ndescription: Synthetic latency fixture ${i}\n---\nUse verified tool operations.\n`)
  writeFileSync(join(agent, `prompts/fixture-${i}.md`), `---\ndescription: Synthetic prompt ${i}\n---\nInspect the fixture.\n`)
 }
 const v = cell.profile.values
 const extensions = [...(v.fastTools ? [resolve(config.fastTools)] : []), ...(v.fffMode && v.fffMode !== 'disabled' ? [resolve(config.fffExtension!)] : [])]
 json(join(agent, 'settings.json'), {
  extensions,
  transport: v.transport,
  defaultProvider: 'latency',
  defaultModel: 'latency-fixture',
  defaultThinkingLevel: v.thinking,
  enableInstallTelemetry: false,
  compaction: {enabled: false},
  retry: {enabled: false, provider: {maxRetries: 0, timeoutMs: config.timeoutMs}},
  quietStartup: true
 })
 json(join(agent, 'auth.json'), {})
 json(join(agent, 'models.json'), {providers: {latency: {baseUrl: url, api: 'anthropic-messages', apiKey: 'loopback-only', models: [{id: 'latency-fixture', reasoning: true, input: ['text'], contextWindow: 2000000, maxTokens: 65536, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}}]}}})
 const cache = v.transformCache === 'cold' ? join(directory, 'cache') : join(work, 'cache', hash(JSON.stringify([cell.target.name, cell.profile.values])).slice(0, 16))
 mkdirSync(cache, {recursive: true})
 const env: Record<string, string> = {
  HOME: home,
  PATH: process.env.PATH ?? '',
  TMPDIR: cache,
  XDG_CACHE_HOME: join(directory, 'xdg-cache'),
  XDG_CONFIG_HOME: join(directory, 'xdg-config'),
  XDG_DATA_HOME: join(directory, 'xdg-data'),
  PI_CODING_AGENT_DIR: agent,
  TIA_STREAM_AGENT_DIR: agent,
  PI_PACKAGE_DIR: join(work, 'package'),
  PI_OFFLINE: '1',
  PI_TELEMETRY: '0',
  PI_SKIP_VERSION_CHECK: '1',
  DO_NOT_TRACK: '1',
  BUN_DISABLE_TELEMETRY: '1',
  PI_NO_PROXY_AUTO_START: '1',
  TIA_DISABLE_FAST_STREAM: cell.target.protocol === 'slim' ? '0' : '1',
  TIA_FASTWRITE_FSYNC: '0',
  PI_CACHE_RETENTION: String(v.cacheRetention),
  JITI_FS_CACHE: v.transformCache === 'disabled' ? 'false' : 'true',
  JITI_RESPECT_TMPDIR_ENV: '1',
  PI_FFF_MODE: v.fffMode === 'disabled' || !v.fffMode ? 'override' : String(v.fffMode),
  FFF_FRECENCY_DB: join(directory, 'fff-frecency.sqlite'),
  FFF_HISTORY_DB: join(directory, 'fff-history.sqlite')
 }
 for (const key of ['flush', 'deltaChars', 'outputChars', 'controlDelayMs']) if (v[key] !== undefined) env[parameters[key].control] = String(v[key])
 const args = ['--mode', cell.target.protocol === 'rpc' ? 'rpc' : 'json', '--provider', 'latency', '--model', 'latency-fixture', '--thinking', String(v.thinking)]
 if (cell.target.protocol === 'slim' || !v.session) args.push('--no-session')
 if (cell.target.protocol !== 'slim') {
  for (const key of ['skills', 'prompts', 'themes', 'context']) if (!v[key]) args.push(parameters[key].control)
 }
 return {directory, env, args, cache: join(cache, 'jiti')}
}

export async function runCell(config: Config, cell: Cell, work: string, server: ReturnType<typeof loopback>, id: number, round: number, warmup: boolean, signal?: AbortSignal): Promise<Sample> {
 signal?.throwIfAborted()
 const f = fixture(config, cell, work, id, server.url)
 const cacheFiles = () => (existsSync(f.cache) ? readdirSync(f.cache).length : 0)
 const beforeFiles = cacheFiles()
 const cacheMode = String(cell.profile.values.transformCache ?? 'not-applicable')
 const needsTransforms = cell.target.protocol !== 'slim' && (cell.profile.values.fastTools || cell.profile.values.fffMode !== 'disabled')
 if (cacheMode === 'cold') assert.equal(beforeFiles, 0, 'Cold cache is not empty')
 if (cacheMode === 'warm' && needsTransforms && round >= 0 && config.warmups > 0) assert(beforeFiles > 0, 'Warm transform cache was not primed')
 const count = turnCount(cell.target, cell.scenario),
  turns = Array.from({length: count}, newTurn)
 server.activate(cell.scenario, turns, f.directory)
 const prompt = (i: number) => `latency-turn-${i}\n${'p'.repeat(cell.scenario.promptChars)}`
 if (cell.target.protocol !== 'rpc') f.args.push(prompt(0))
 writeFileSync(join(f.directory, 'edited.txt'), 'before-0')
 const start = now()
 if (cell.target.protocol !== 'rpc') turns[0].promptAt = start
 const child = Bun.spawn([...cell.target.command, ...f.args], {cwd: f.directory, env: f.env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe'})
 const abort = () => {
  child.kill('SIGKILL')
 }
 signal?.addEventListener('abort', abort, {once: true})
 let timedOut = false,
  failure: unknown,
  readyMs = 0,
  current = 0,
  stdoutBytes = 0,
  eventCount = 0,
  tail = '',
  stderr = '',
  settled = 0
 const timer = setTimeout(() => {
  timedOut = true
  child.kill('SIGKILL')
 }, config.timeoutMs)
 const send = (event: object) => {
  child.stdin.write(JSON.stringify(event) + '\n')
  child.stdin.flush()
 }
 const startPrompt = (i: number) => {
  writeFileSync(join(f.directory, 'edited.txt'), `before-${i}`)
  turns[i].promptAt = now()
  send({id: `prompt-${i}`, type: 'prompt', message: prompt(i)})
 }
 const checkFiles = (i: number) => {
  if (!cell.scenario.tools) return
  assert.equal(readFileSync(join(f.directory, 'written.txt'), 'utf8'), `verified-${i}\ncafé😄\n`)
  assert.equal(readFileSync(join(f.directory, 'edited.txt'), 'utf8'), `after-${i}`)
 }
 const finish = (at: number) => {
  assert(current < turns.length && turns[current].doneAt === undefined, 'Duplicate completion')
  turns[current].doneAt = at
  checkFiles(current)
  settled++
  if (cell.target.protocol === 'rpc') {
   if (current + 1 < count) startPrompt(++current)
   else child.stdin.end()
  }
 }
 const reader = new JsonlReader((event, at) => {
  eventCount++
  assert(!['extension_error', 'auto_retry_start', 'compaction_start'].includes(event.type), JSON.stringify(event))
  if (event.type === 'response') {
   assert.equal(event.success, true, JSON.stringify(event))
   if (event.id === 'ready') {
    assert.equal(readyMs, 0, 'Duplicate ready')
    assert.equal(event.data.model.provider, 'latency')
    assert.equal(event.data.model.id, 'latency-fixture')
    assert.equal(event.data.isStreaming, false)
    readyMs = at - start
    startPrompt(0)
   }
   return
  }
  if (event.t === 'session') {
   assert.equal(cell.target.protocol, 'slim', 'Unexpected slim routing')
   assert.equal(event.provider, 'latency')
   readyMs = at - start
  }
  const trace = turns[current]
  if (event.type === 'message_end' && event.message?.role === 'assistant') {
   assert(!['error', 'aborted', 'length'].includes(event.message.stopReason), JSON.stringify(event.message))
   if (event.message.stopReason === 'stop')
    trace.authoritative = event.message.content
     .filter((c: any) => c.type === 'text')
     .map((c: any) => c.text)
     .join('')
  }
  const delta = event.assistantMessageEvent
  if (event.type === 'message_update' || event.t === 'd') trace.firstEventAt ??= at
  if (delta?.type === 'thinking_delta') trace.thinkingEvents++
  if (delta?.type === 'text_delta' || event.t === 'd') {
   assert(trace.doneAt === undefined, 'Delta after completion')
   const text = event.t === 'd' ? event.s : delta.delta
   assert(typeof text === 'string')
   if (text) trace.received.push({at, text})
  }
  if (event.type === 'tool_execution_start') {
   assert(!trace.tools[event.toolCallId], 'Duplicate tool start')
   trace.tools[event.toolCallId] = {name: event.toolName, start: at}
  }
  if (event.type === 'tool_execution_end') {
   const tool = trace.tools[event.toolCallId]
   assert(tool && tool.end === undefined, 'Unmatched tool end')
   assert.equal(event.isError, false, JSON.stringify(event.result))
   if (cell.profile.values.fastTools && event.toolName === 'write') assert.equal(event.result.details.verified, true)
   tool.end = at
  }
  if (event.type === 'agent_settled' && cell.target.protocol === 'rpc') finish(at)
  if (event.type === 'agent_end' && cell.target.protocol === 'json') {
   assert(!event.willRetry)
   finish(at)
  }
  if (event.t === 'done') {
   assert.equal(event.stopReason, 'stop', event.error)
   assert(!event.error)
   finish(at)
  }
 })
 if (cell.target.protocol === 'rpc') send({id: 'ready', type: 'get_state'})
 else child.stdin.end()
 const consume = async () => {
  try {
   for await (const bytes of child.stdout) {
    const at = now()
    stdoutBytes += bytes.length
    assert(stdoutBytes <= 128 * 1024 * 1024, 'stdout exceeds run budget')
    tail = (tail + Buffer.from(bytes).toString('utf8')).slice(-65536)
    reader.push(bytes, at)
    if (cell.scenario.consumerDelayMs) await Bun.sleep(cell.scenario.consumerDelayMs)
   }
   reader.end()
  } catch (error) {
   failure = error
   child.kill('SIGKILL')
  }
 }
 const drainError = async () => {
  for await (const bytes of child.stderr) stderr = (stderr + Buffer.from(bytes).toString('utf8')).slice(-65536)
 }
 try {
  const [code] = await Promise.all([child.exited, consume(), drainError()])
  const elapsedMs = now() - start
  signal?.throwIfAborted()
  if (failure) throw failure
  assert(!timedOut, `Process deadline ${config.timeoutMs}ms exceeded`)
  assert.equal(code, 0, stderr)
  assert.equal(stderr, '', 'Unexpected runtime diagnostics: ' + stderr)
  server.check()
  const afterFiles = cacheFiles()
  if (cacheMode === 'disabled') assert.equal(afterFiles, 0, 'Disabled cache wrote files')
  else if (needsTransforms) assert(afterFiles > 0, 'Jiti did not use the isolated cache directory')
  assert.equal(settled, count, 'Missing successful completion')
  if (cell.target.protocol === 'rpc') assert(readyMs > 0, 'Missing RPC readiness')
  for (const trace of turns) if (cell.target.protocol !== 'slim') assert(trace.authoritative !== undefined, 'Missing authoritative assistant response')
  return {
   id,
   round,
   warmup,
   target: cell.target.name,
   profile: cell.profile.name,
   scenario: cell.scenario.name,
   start,
   readyMs,
   elapsedMs,
   cpuMicros: Number(child.resourceUsage()!.cpuTime.total),
   stdoutBytes,
   eventCount,
   cache: {mode: cacheMode, beforeFiles, afterFiles},
   turns: turns.map((trace, index) => ({phase: index ? `warm-${index}` : 'cold', trace, metrics: metrics(trace, cell.scenario, start)}))
  }
 } catch (error) {
  throw new Error(`${cell.target.name}/${cell.profile.name}/${cell.scenario.name}: ${error}\nstderr: ${stderr}\nstdout tail: ${tail}`, {cause: error})
 } finally {
  clearTimeout(timer)
  signal?.removeEventListener('abort', abort)
  if (child.exitCode === null) child.kill('SIGKILL')
  await child.exited
 }
}

export function summarize(samples: Sample[], config: Config) {
 const output: any[] = []
 for (const {target, profile, scenario} of plan(config).cells) {
  const selected = samples.filter(s => !s.warmup && s.target === target.name && s.scenario === scenario.name)
  const rows = selected.filter(s => s.profile === profile.name).sort((a, b) => a.round - b.round)
  const baseline = selected.filter(s => s.profile === 'baseline').sort((a, b) => a.round - b.round)
  if (!rows.length) continue
  assert.equal(rows.length, config.rounds)
  assert.equal(baseline.length, config.rounds)
  for (let turn = 0; turn < turnCount(target, scenario); turn++) {
   const fields = Object.keys(rows[0].turns[turn].metrics.scalar)
   const comparisons = Object.fromEntries(
    fields.map(field => {
     const get = (sample: Sample) => sample.turns[turn].metrics.scalar[field]
     const values = rows.map(get),
      reference = baseline.map(get)
     const speedup = [...values, ...reference].every(v => v > 0) ? pairedSpeedup(reference, values) : null
     return [field, {stats: distribution(values), baseline: distribution(reference), speedup}]
    })
   )
   output.push({target: target.name, profile: profile.name, scenario: scenario.name, phase: rows[0].turns[turn].phase, comparisons})
  }
 }
 return output
}

async function benchmark(config: Config, output: string) {
 const planned = plan(config)
 assert(!existsSync(output), 'Output directory already exists; use a new run path')
 const manifest = JSON.parse(readFileSync(join(config.packageDir, 'package.json'), 'utf8'))
 const identities = config.targets.map(target => {
  const executable = Bun.which(target.command[0]) ?? resolve(target.command[0])
  const metadata = target.buildMetadata ? JSON.parse(readFileSync(target.buildMetadata, 'utf8')) : undefined
  if (metadata) {
   assert.equal(metadata.piVersion, manifest.version, 'Target/package version mismatch')
   assert.equal(metadata.binarySha256, shaFile(executable), 'Target/build metadata hash mismatch')
  }
  const commandFiles = target.command.map(arg => resolve(arg)).filter(path => existsSync(path) && statSync(path).isFile())
  return {name: target.name, executable, sha256: shaFile(executable), commandFiles: commandFiles.map(path => ({path, sha256: shaFile(path)})), metadata, provenance: metadata ? 'build-metadata-verified' : 'caller-supplied; dependency equivalence not established'}
 })
 const sources = ['bench/latency.ts', 'bench/latency-config.ts', 'bench/latency-fixture.ts', 'bench/tool-benchmark.ts', 'scripts/build-pi.ts', 'bun.lock'].map(path => ({path, sha256: shaFile(resolve(import.meta.dir, '..', path))}))
 const extensionSources = [config.fastTools, ...(config.fffExtension ? [config.fffExtension] : [])].map(path => ({path: resolve(path), sha256: shaFile(path)}))
 const git = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {cwd: resolve(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe'})
 const dirty = Bun.spawnSync(['git', 'status', '--porcelain'], {cwd: resolve(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe'})
 mkdirSync(output, {recursive: true})
 json(join(output, 'config.json'), config)
 json(join(output, 'manifest.json'), {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  configSha256: shaFile(join(output, 'config.json')),
  gitCommit: git.stdout.toString().trim(),
  dirtyPaths: dirty.stdout.toString().trim().split('\n').filter(Boolean),
  sources,
  extensionSources,
  identities,
  environment: {piVersion: manifest.version, bunVersion: Bun.version, kernel: release(), cpu: cpus()[0]?.model, cpuAffinity: process.platform === 'linux' ? readFileSync('/proc/self/status', 'utf8').match(/^Cpus_allowed_list:\s*(.*)$/m)?.[1] : undefined},
  launches: planned.launches,
  ignoredAxes: planned.ignoredAxes,
  parameters,
  externalParameters
 })
 const work = mkdtempSync(join(tmpdir(), 'tia-latency-')),
  server = loopback(),
  samples: Sample[] = []
 let id = 0
 const journal = join(output, 'samples.jsonl')
 const controller = new AbortController()
 const interrupt = () => controller.abort(new Error('Benchmark interrupted'))
 const budget = setTimeout(() => controller.abort(new Error('Benchmark exceeded maxDurationMs budget; split with --slice')), config.maxDurationMs ?? 60000)
 process.once('SIGINT', interrupt)
 process.once('SIGTERM', interrupt)
 try {
  setup(config, work)
  const blocks = config.targets.flatMap(target => config.scenarios.map(scenario => planned.cells.filter(c => c.target.name === target.name && c.scenario.name === scenario.name))).filter(b => b.length)
  for (let round = -config.warmups; round < config.rounds; round++) {
   const blockOrder = shuffle([...blocks.entries()], config.seed + Math.floor(Math.max(round, 0) / 2) * 104729)
   if (round % 2 !== 0) blockOrder.reverse()
   for (const [blockIndex, block] of blockOrder) {
    const order = shuffle(block, config.seed + blockIndex + Math.floor(Math.max(round, 0) / 2) * 7919)
    if (round % 2 !== 0) order.reverse()
    for (const cell of order) {
     const attempt = {id: id++, round, warmup: round < 0, target: cell.target.name, profile: cell.profile.name, scenario: cell.scenario.name}
     try {
      const sample = await runCell(config, cell, work, server, attempt.id, round, round < 0, controller.signal)
      samples.push(sample)
      appendFileSync(journal, JSON.stringify(sample) + '\n')
      console.error(`[${samples.length}/${planned.launches}] ${sample.target} / ${sample.profile} / ${sample.scenario}: ${sample.elapsedMs.toFixed(1)}ms${sample.warmup ? ' (warmup)' : ''}`)
     } catch (error) {
      appendFileSync(journal, JSON.stringify({...attempt, failed: true, error: String(error)}) + '\n')
      throw error
     }
    }
   }
   console.error(`Validated ${round < 0 ? 'warmup' : 'round'} ${round < 0 ? round + config.warmups + 1 : round + 1}: ${samples.length}/${planned.launches} processes`)
  }
  for (const identity of identities) {
   assert.equal(shaFile(identity.executable), identity.sha256, 'Binary changed during benchmark')
   for (const source of identity.commandFiles) assert.equal(shaFile(source.path), source.sha256, 'Command source changed during benchmark')
  }
  for (const source of [...sources.map(s => ({...s, path: resolve(import.meta.dir, '..', s.path)})), ...extensionSources]) assert.equal(shaFile(source.path), source.sha256, 'Benchmark source changed during run')
  const summary = summarize(samples, config)
  const processSummary = planned.cells.map(({target, profile, scenario}) => {
   const rows = samples.filter(s => !s.warmup && s.target === target.name && s.profile === profile.name && s.scenario === scenario.name)
   return {target: target.name, profile: profile.name, scenario: scenario.name, readyMs: distribution(rows.map(r => r.readyMs)), elapsedMs: distribution(rows.map(r => r.elapsedMs)), cpuMicros: distribution(rows.map(r => r.cpuMicros)), stdoutBytes: distribution(rows.map(r => r.stdoutBytes))}
  })
  const targetComparisons = config.targets.slice(1).flatMap(target => {
   const baselineTarget = config.targets.find(t => t.protocol === target.protocol)!
   if (baselineTarget === target) return []
   const before = identities.find(t => t.name === baselineTarget.name)!,
    after = identities.find(t => t.name === target.name)!
   if (!before.metadata || !after.metadata || before.metadata.entry !== after.metadata.entry || before.metadata.entrySha256 !== after.metadata.entrySha256) return [{target: target.name, baseline: baselineTarget.name, status: 'not-compared: source equivalence not established'}]
   return config.scenarios
    .filter(s => target.protocol !== 'slim' || !s.tools)
    .map(scenario => {
     const select = (name: string) => samples.filter(s => !s.warmup && s.target === name && s.scenario === scenario.name && s.profile === 'baseline').sort((a, b) => a.round - b.round)
     const left = select(before.name),
      right = select(after.name)
     const comparison = (get: (s: Sample) => number) => ({baseline: distribution(left.map(get)), candidate: distribution(right.map(get)), speedup: pairedSpeedup(left.map(get), right.map(get))})
     return {target: target.name, baseline: baselineTarget.name, scenario: scenario.name, status: 'exploratory', spawnToFirstTextMs: comparison(s => s.turns[0].metrics.scalar.spawnToFirstTextMs), elapsedMs: comparison(s => s.elapsedMs)}
    })
  })
  const controlWarnings = summary
   .filter(row => row.profile === 'control')
   .flatMap(row =>
    ['promptToFirstTextMs', 'deliveryP95Ms'].flatMap(metric => {
     const speedup = row.comparisons[metric].speedup
     return speedup && (speedup.ci95[0] > 1.05 || speedup.ci95[1] < 1 / 1.05) ? [{target: row.target, scenario: row.scenario, phase: row.phase, metric, speedup}] : []
    })
   )
  json(join(output, 'summary.json'), {
   schemaVersion: 1,
   status: 'complete',
   finishedAt: new Date().toISOString(),
   checkedProcesses: samples.length,
   checkedPrompts: samples.reduce((n, s) => n + s.turns.length, 0),
   checkedToolCalls: samples.reduce((n, s) => n + s.turns.reduce((m, t) => m + Object.keys(t.trace.tools).length, 0), 0),
   samplesSha256: shaFile(journal),
   methodology:
    'Loopback only. Full RPC preserves coding tools and measures cold plus warm turns. JSON/slim are single-prompt cold-process cases. Paired AB/BA randomized blocks; 10000 seeded bootstrap resamples over paired process samples, phases kept separate. CIs are exploratory (multiple comparisons, no automatic winner/default changes). Deltas are not tokenizer tokens. Delivery lag is server enqueue to parent receipt, not terminal paint. Request bodies are exact synthetic fixtures; credentials/headers are not recorded.',
   controlWarnings,
   processSummary,
   targetComparisons,
   summary
  })
  const short = summary
   .filter(row => row.phase === 'cold')
   .map(row => ({target: row.target, profile: row.profile, scenario: row.scenario, ttftP50: row.comparisons.promptToFirstTextMs.stats.p50.toFixed(2), deliveryP95: row.comparisons.deliveryP95Ms.stats.p50.toFixed(3), tailP50: row.comparisons.completionTailMs.stats.p50.toFixed(3)}))
  console.table(short)
 } catch (error) {
  json(join(output, 'failure.json'), {status: 'failed', finishedAt: new Date().toISOString(), checkedProcesses: samples.length, error: String(error), samplesSha256: existsSync(journal) ? shaFile(journal) : null})
  throw error
 } finally {
  process.removeListener('SIGINT', interrupt)
  clearTimeout(budget)
  process.removeListener('SIGTERM', interrupt)
  server.stop()
  rmSync(work, {recursive: true, force: true})
 }
}

async function buildMatrix(packageDir: string, output: string, grid: boolean) {
 assert(!existsSync(output), 'Build directory already exists; use a new path')
 mkdirSync(output, {recursive: true})
 const choices = grid
  ? Array.from({length: 32}, (_, bits) => ({lazy: !(bits & 1), syntax: !(bits & 2), whitespace: !(bits & 4), identifiers: !(bits & 8), bytecode: !!(bits & 16)}))
  : [{lazy: true, syntax: true, whitespace: true, identifiers: true, bytecode: false}, ...['lazy', 'syntax', 'whitespace', 'identifiers', 'bytecode'].map(key => ({lazy: true, syntax: true, whitespace: true, identifiers: true, bytecode: false, [key]: key === 'bytecode'}))]
 const targets: Target[] = [],
  attempts: any[] = []
 for (const [index, c] of choices.entries()) {
  const name =
   index === 0
    ? 'default'
    : Object.entries(c)
       .map(([k, v]) => `${k}-${+v}`)
       .join('_')
  const binary = join(output, name),
   buildMetadata = `${binary}.json`
  try {
   const metadata = await buildPi(packageDir, binary, join(output, 'full-runtime'), c.lazy ? 'lazy-jiti' : 'bundled', {minify: {syntax: c.syntax, whitespace: c.whitespace, identifiers: c.identifiers}, bytecode: c.bytecode})
   json(buildMetadata, metadata)
   targets.push({name, command: [binary], protocol: 'rpc', buildMetadata})
   attempts.push({name, choices: c, status: 'built', metadata})
  } catch (error) {
   attempts.push({name, choices: c, status: 'rejected', error: String(error)})
  }
  console.error(`${name}: ${attempts.at(-1).status}`)
  writeFileSync(join(output, 'attempts.json'), JSON.stringify(attempts, null, 1) + '\n')
 }
 json(join(output, 'targets.json'), targets)
 assert(
  targets.some(t => t.name === 'default'),
  'Default build failed'
 )
}

export async function main(args = process.argv.slice(2)) {
 const [action, input, output, extra, scenario] = args
 if (args.length > 5) throw new Error('Too many arguments')
 if (action === '--slice' && input && output && extra) {
  json(resolve(output), sliceConfig(JSON.parse(readFileSync(resolve(input), 'utf8')), extra, scenario))
  return
 }
 if (scenario) throw new Error('Unexpected scenario argument')
 if (action === '--init' && input && !output) {
  json(resolve(input), defaultConfig())
  return
 }
 if (action === '--build' && input && output && (!extra || extra === 'grid')) {
  await buildMatrix(resolve(input), resolve(output), extra === 'grid')
  return
 }
 if ((action === '--plan' || action === '--run') && input && !extra) {
  const config: Config = JSON.parse(readFileSync(resolve(input), 'utf8'))
  const planned = plan(config)
  if (action === '--plan' && !output) {
   console.log(JSON.stringify({...planned, parameters, externalParameters}, null, 1))
   return
  }
  if (action === '--run' && output) {
   await benchmark(config, resolve(output))
   return
  }
 }
 throw new Error('Usage: bun run bench:latency --init <config.json> | --slice <config.json> <new-config.json> <axis|baseline> [scenario] | --plan <config.json> | --run <config.json> <new-output-dir> | --build <pi-package-dir> <new-build-dir> [grid]')
}

if (import.meta.main) await main()
