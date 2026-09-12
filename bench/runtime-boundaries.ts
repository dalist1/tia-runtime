import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync} from 'node:fs'
import {cpus, release, tmpdir} from 'node:os'
import {dirname, join, resolve} from 'node:path'

type Sample = {ms: number; cpuMicros: number}
type Pair = {order: string[]; baseline: Sample[]; candidate: Sample[]}
const workloads = ['version', 'rpc-minimal', 'rpc-tools-warm', 'rpc-tools-no-transform-cache'] as const
const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

export function validateRpcOutput(stdout: string, tools: boolean) {
 const events = stdout
  .trim()
  .split('\n')
  .map(line => JSON.parse(line))
 const state = events.find(event => event.type === 'response' && event.id === 'state')
 assert.equal(state?.success, true, 'Missing successful get_state response')
 assert.equal(state.data.isStreaming, false)
 assert.equal(state.data.messageCount, 0)
 if (tools) {
  const commands = events.find(event => event.type === 'response' && event.id === 'commands')
  assert.equal(commands?.success, true, 'Missing successful get_commands response')
  assert(
   commands.data.commands.some((command: any) => command.name === 'boundary_probe'),
   'Extension did not register its command'
  )
  assert.equal(state.data.model.provider, 'openai')
 }
}

async function main() {
 const [beforeArg, afterArg, packageArg, outputArg, roundsArg = '12', iterationsArg = '5'] = process.argv.slice(2)
 assert(beforeArg && afterArg && packageArg && outputArg, 'Usage: runtime-boundaries.ts <baseline-bin> <candidate-bin> <pi-package-dir> <output.json> [rounds=12] [iterations=5]')
 const rounds = Number(roundsArg),
  iterations = Number(iterationsArg)
 assert(Number.isSafeInteger(rounds) && rounds >= 2 && Number.isSafeInteger(iterations) && iterations > 0)
 const baseline = resolve(beforeArg),
  candidate = resolve(afterArg),
  packageDir = resolve(packageArg),
  output = resolve(outputArg)
 const version = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).version
 const sources = {baseline: {path: baseline, sha256: sha(baseline)}, candidate: {path: candidate, sha256: sha(candidate)}, harnessSha256: sha(import.meta.path), toolsSha256: sha(resolve(import.meta.dir, '../scripts/fast-tools-extension.ts'))}
 const work = mkdtempSync(join(tmpdir(), 'tia-boundary-bench-'))
 const startedAt = new Date().toISOString()
 try {
  const view = join(work, 'view'),
   agent = join(work, 'agent'),
   cache = join(work, 'cache'),
   home = join(work, 'home')
  for (const directory of [view, agent, cache, home]) mkdirSync(directory)
  for (const [name, source] of [
   ['package.json', 'package.json'],
   ['theme', 'dist/modes/interactive/theme'],
   ['assets', 'dist/modes/interactive/assets'],
   ['export-html', 'dist/core/export-html']
  ])
   symlinkSync(join(packageDir, source), join(view, name))
  const probe = join(work, 'probe.ts')
  const receipt = join(work, 'receipt.json')
  writeFileSync(
   probe,
   `
import assert from 'node:assert/strict'
import {readFileSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent'
import fastTools from ${JSON.stringify(resolve(import.meta.dir, '../scripts/fast-tools-extension.ts'))}
export default function(pi: ExtensionAPI) {
 const tools = new Map<string, any>()
 fastTools({...pi, registerTool(tool) { tools.set(tool.name, tool); pi.registerTool(tool) }})
 pi.registerCommand('boundary_probe', {description: 'Benchmark fixture', handler: async () => {}})
 pi.on('session_start', async (_event, ctx) => {
  const target = join(ctx.cwd, 'tool.txt')
  const call = (name: string, args: any) => tools.get(name).execute(name, args, undefined, undefined, ctx)
  assert.equal((await call('write', {path: target, content: 'before\\n'})).details.verified, true)
  assert.equal((await call('read', {path: target})).content[0].text, 'before\\n')
  const edited = await call('edit', {path: target, edits: [{oldText: 'before', newText: 'after'}]})
  assert(edited.details.diff.includes('after'))
  assert.equal(readFileSync(target, 'utf8'), 'after\\n')
  assert.equal((await call('bash', {command: "printf boundary"})).content[0].text, 'boundary')
  writeFileSync(process.env.TIA_BOUNDARY_RECEIPT!, JSON.stringify({read: true, write: true, edit: true, bash: true}))
 })
}
`
  )
  const results: Record<string, Pair[]> = {}
  const run = async (binary: string, workload: (typeof workloads)[number]): Promise<Sample> => {
   const tools = workload.startsWith('rpc-tools')
   rmSync(receipt, {force: true})
   const args = workload === 'version' ? ['--version'] : ['--mode', 'rpc', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', ...(tools ? ['-e', probe] : [])]
   const start = performance.now()
   const child = Bun.spawn([binary, ...args], {
    cwd: work,
    env: {
     HOME: home,
     PATH: process.env.PATH ?? '',
     PI_PACKAGE_DIR: view,
     PI_CODING_AGENT_DIR: agent,
     PI_OFFLINE: '1',
     PI_TELEMETRY: '0',
     PI_SKIP_VERSION_CHECK: '1',
     OPENAI_API_KEY: 'dummy',
     PI_NO_PROXY_AUTO_START: '1',
     JITI_FS_CACHE: workload.endsWith('no-transform-cache') ? 'false' : 'true',
     TMPDIR: cache,
     JITI_RESPECT_TMPDIR_ENV: '1',
     TIA_BOUNDARY_RECEIPT: receipt
    },
    stdin: new Blob(['{"id":"state","type":"get_state"}\n{"id":"commands","type":"get_commands"}\n']),
    stdout: 'pipe',
    stderr: 'pipe'
   })
   const timer = setTimeout(() => child.kill('SIGKILL'), 20000)
   try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    const ms = performance.now() - start
    assert.equal(code, 0, `${workload}: ${stderr}`)
    assert.equal(stderr, '', `${workload}: unexpected diagnostics`)
    if (workload === 'version') assert.equal(stdout.trim(), version)
    else validateRpcOutput(stdout, tools)
    if (tools) assert.deepEqual(JSON.parse(readFileSync(receipt, 'utf8')), {read: true, write: true, edit: true, bash: true})
    if (workload === 'rpc-tools-warm') assert(readdirSync(join(cache, 'jiti')).length > 0, 'Jiti did not use the isolated transform cache')
    const usage = child.resourceUsage()!
    return {ms, cpuMicros: Number(usage.cpuTime.total)}
   } finally {
    clearTimeout(timer)
   }
  }
  for (const workload of workloads) {
   results[workload] = []
   for (let warmup = 0; warmup < 3; warmup += 1) {
    await run(baseline, workload)
    await run(candidate, workload)
   }
   for (let round = 0; round < rounds; round += 1) {
    const order = round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']
    const pair: Pair = {order, baseline: [], candidate: []}
    for (const label of order)
     for (let i = 0; i < iterations; i += 1) {
      if (label === 'baseline') pair.baseline.push(await run(baseline, workload))
      else pair.candidate.push(await run(candidate, workload))
     }
    results[workload].push(pair)
   }
   console.error(`Verified ${workload}`)
  }
  assert.equal(sha(baseline), sources.baseline.sha256)
  assert.equal(sha(candidate), sources.candidate.sha256)
  const {pairedSpeedup, quantile} = await import('./tool-benchmark.ts')
  const summary = workloads.map(workload => {
   const pairs = results[workload]
   const stats = (name: 'baseline' | 'candidate') => {
    const samples = pairs.flatMap(pair => pair[name])
    const times = samples.map(sample => sample.ms)
    return {meanMs: mean(times), medianMs: quantile(times, 0.5), p95Ms: quantile(times, 0.95), meanCpuMicros: mean(samples.map(sample => sample.cpuMicros))}
   }
   return {
    workload,
    baseline: stats('baseline'),
    candidate: stats('candidate'),
    speedup: pairedSpeedup(
     pairs.map(pair => mean(pair.baseline.map(sample => sample.ms))),
     pairs.map(pair => mean(pair.candidate.map(sample => sample.ms)))
    )
   }
  })
  const record = {
   schemaVersion: 1,
   startedAt,
   finishedAt: new Date().toISOString(),
   sources,
   environment: {piVersion: version, bunVersion: Bun.version, kernel: release(), cpu: cpus()[0]?.model, cpuAffinity: process.platform === 'linux' ? readFileSync('/proc/self/status', 'utf8').match(/^Cpus_allowed_list:\s*(.*)$/m)?.[1] : undefined},
   rounds,
   iterations,
   warmupsPerCandidatePerWorkload: 3,
   checkedProcesses: workloads.length * 2 * (rounds * iterations + 3),
   checkedToolCalls: 2 * 2 * (rounds * iterations + 3) * 4,
   methodology:
    'Full compiled pi, not slim mode. Alternating paired rounds; elapsed process launch through stdout/stderr drain and exit. Fresh process per sample; warm OS cache; isolated settings and Jiti cache. Cold-transform case disables Jiti filesystem cache. Warmup and measured runs all validated. No network/model request. Startup tool probes execute registered read/write/edit/bash handlers. CI: 10000-resample paired bootstrap over round means.',
   summary,
   results
  }
  mkdirSync(dirname(output), {recursive: true})
  writeFileSync(output, JSON.stringify(record, null, 1) + '\n')
  console.table(summary.map(item => ({workload: item.workload, beforeMs: item.baseline.meanMs.toFixed(2), afterMs: item.candidate.meanMs.toFixed(2), speedup: item.speedup.ratio.toFixed(2), ci95: item.speedup.ci95.map(value => value.toFixed(2)).join('–')})))
 } finally {
  rmSync(work, {recursive: true, force: true})
 }
}

if (import.meta.main) await main()
