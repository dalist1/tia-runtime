import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statfsSync, writeFileSync} from 'node:fs'
import {cpus, release, tmpdir} from 'node:os'
import {dirname, join, resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {referenceRead} from './tool-read-reference.ts'

type Extension = typeof import('../scripts/fast-tools-extension.ts')
type Measurement = {name: string; bytes: number; samplesMs: number[]; checks: number}
type WorkerResult = {measurements: Measurement[]; maxRssKiB: number}
type Pair = {order: string[]; baseline: WorkerResult; candidate: WorkerResult}

const workloads = ['read-small', 'read-5MiB-window', 'read-deep-offset', 'read-line-limit-giant-tail', 'read-byte-limit-giant-tail', 'read-giant-first-line', 'read-unicode-boundary', 'read-unlimited-skill', 'write-1MiB-verified', 'edit-100KB-verified-diff']

export function quantile(values: number[], fraction: number) {
 assert(values.length > 0 && values.every(value => Number.isFinite(value) && value >= 0))
 assert(fraction >= 0 && fraction <= 1)
 const sorted = [...values].sort((a, b) => a - b)
 const index = (sorted.length - 1) * fraction
 const lower = Math.floor(index)
 return sorted[lower] + (sorted[Math.ceil(index)] - sorted[lower]) * (index - lower)
}

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length

export function pairedSpeedup(baseline: number[], candidate: number[]) {
 assert(baseline.length >= 2 && baseline.length === candidate.length)
 assert([...baseline, ...candidate].every(value => Number.isFinite(value) && value > 0))
 const logs = baseline.map((value, index) => Math.log(value / candidate[index]))
 let seed = 0x5eed1234
 const estimates = Array.from({length: 10000}, () => {
  let sum = 0
  for (let i = 0; i < logs.length; i += 1) {
   seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
   sum += logs[Math.floor((seed / 0x100000000) * logs.length)]
  }
  return Math.exp(sum / logs.length)
 })
 return {ratio: Math.exp(mean(logs)), ci95: [quantile(estimates, 0.025), quantile(estimates, 0.975)]}
}

async function worker(source: string, iterations: number, warmup: number, workload: string): Promise<WorkerResult> {
 assert(workloads.includes(workload), `Unknown workload: ${workload}`)
 const work = mkdtempSync(join(tmpdir(), 'tia-tool-worker-'))
 process.env.PI_CODING_AGENT_DIR = join(work, 'agent')
 try {
  const ext: Extension = await import(pathToFileURL(resolve(source)).href)
  const measurements: Measurement[] = []
  const measure = async (name: string, bytes: number, run: (index: number) => Promise<unknown>, check: (result: any, index: number) => void) => {
   const samplesMs: number[] = []
   for (let index = 0; index < warmup + iterations; index += 1) {
    const start = performance.now()
    const result = await run(index)
    const elapsed = performance.now() - start
    check(result, index)
    if (index >= warmup) samplesMs.push(elapsed)
   }
   measurements.push({name, bytes, samplesMs, checks: iterations + warmup})
  }
  const ordinary = () => Array.from({length: 65536}, (_, i) => `${String(i).padStart(6, '0')} ${'x'.repeat(72)}\n`).join('')
  const giant = () => 'z'.repeat(16 * 1024 * 1024)
  const unicode = () => `${'€'.repeat(15)} 😄 café\r\n`.repeat(20000)
  const readCases = [
   {name: 'read-small', content: () => 'hello café', offset: 1, limit: 2000},
   {name: 'read-5MiB-window', content: ordinary, offset: 1, limit: 2000},
   {name: 'read-deep-offset', content: ordinary, offset: 60000, limit: 100},
   {name: 'read-line-limit-giant-tail', content: () => `head\n${giant()}`, offset: 1, limit: 1},
   {name: 'read-byte-limit-giant-tail', content: () => `${'x'.repeat(48 * 1024 - 1)}\n${giant()}`, offset: 1, limit: 2000},
   {name: 'read-giant-first-line', content: giant, offset: 1, limit: 2000},
   {name: 'read-unicode-boundary', content: unicode, offset: 4500, limit: 300},
   {name: 'read-unlimited-skill', content: unicode, offset: 1, limit: 1, skill: true}
  ]
  for (const fixture of readCases.filter(item => item.name === workload)) {
   const target = fixture.skill ? join(work, 'agent/skills/fixture/SKILL.md') : join(work, fixture.name)
   const content = fixture.content()
   mkdirSync(dirname(target), {recursive: true})
   writeFileSync(target, content)
   const expected = referenceRead(content, fixture.offset, fixture.limit, fixture.skill)
   await measure(
    fixture.name,
    Buffer.byteLength(content),
    () => ext.fastRead(work, target, fixture.offset, fixture.limit),
    result => assert.deepEqual(result, expected)
   )
  }
  if (workload === 'write-1MiB-verified') {
   const writeTarget = join(work, 'write.txt')
   const writePayloads = ['a', 'b'].map(char => char.repeat(1024 * 1024))
   await measure(
    'write-1MiB-verified',
    1024 * 1024,
    index => ext.fastWrite(work, writeTarget, writePayloads[index % 2]),
    (result, index) => {
     assert.equal(result.details.verified, true)
     assert.equal(readFileSync(writeTarget, 'utf8'), writePayloads[index % 2])
    }
   )
  }
  if (workload === 'edit-100KB-verified-diff') {
   const editTarget = join(work, 'edit.txt')
   const filler = `${'f'.repeat(99)}\n`.repeat(500)
   const editPayloads = [`${filler}BEFORE\n${filler}`, `${filler}AFTER!\n${filler}`]
   writeFileSync(editTarget, editPayloads[0])
   await measure(
    'edit-100KB-verified-diff',
    Buffer.byteLength(editPayloads[0]),
    index => ext.fastEdit(work, [{path: editTarget, oldText: index % 2 ? 'AFTER!\n' : 'BEFORE\n', newText: index % 2 ? 'BEFORE\n' : 'AFTER!\n'}]),
    (result, index) => {
     assert.equal(readFileSync(editTarget, 'utf8'), editPayloads[(index + 1) % 2])
     assert.match(result.details.diff, /BEFORE/)
     assert.match(result.details.diff, /AFTER!/)
    }
   )
  }
  return {measurements, maxRssKiB: process.resourceUsage().maxRSS}
 } finally {
  rmSync(work, {recursive: true, force: true})
 }
}

async function runWorker(source: string, iterations: number, warmup: number, workload: string) {
 const child = Bun.spawn([process.execPath, import.meta.path, '--worker', source, String(iterations), String(warmup), workload], {stdout: 'pipe', stderr: 'pipe', env: {...process.env, TIA_FASTWRITE_FSYNC: '0'}})
 const timer = setTimeout(() => child.kill(), 120000)
 try {
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  assert.equal(code, 0, `Benchmark worker failed (${source}): ${stderr}`)
  const result: WorkerResult = JSON.parse(stdout)
  assert.equal(result.measurements.length, 1)
  for (const measurement of result.measurements) {
   assert.equal(measurement.samplesMs.length, iterations)
   assert.equal(measurement.checks, iterations + warmup)
   assert(measurement.samplesMs.every(value => Number.isFinite(value) && value > 0))
  }
  return result
 } finally {
  clearTimeout(timer)
 }
}

async function main() {
 const [baselineArg, outputArg, roundsArg = '12', iterationsArg = '60', warmupArg = '10'] = process.argv.slice(2)
 assert(baselineArg && outputArg, 'Usage: bun bench/tool-benchmark.ts <baseline-extension.ts> <output.json> [rounds=12] [iterations=60] [warmup=10]')
 const rounds = Number(roundsArg)
 const iterations = Number(iterationsArg)
 const warmup = Number(warmupArg)
 assert(Number.isSafeInteger(rounds) && rounds >= 2)
 assert(Number.isSafeInteger(iterations) && iterations > 0)
 assert(Number.isSafeInteger(warmup) && warmup >= 0)
 const baseline = resolve(baselineArg)
 const candidate = resolve(process.env.TIA_BENCH_CANDIDATE ?? join(import.meta.dir, '../scripts/fast-tools-extension.ts'))
 const output = resolve(outputArg)
 const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
 const dependencies = (source: string) =>
  Object.fromEntries(
   ['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', '@sinclair/typebox'].map(name => {
    const path = realpathSync(Bun.resolveSync(name, dirname(source)))
    return [name, {path, sha256: hash(path)}]
   })
  )
 const resolvedDependencies = dependencies(baseline)
 assert.deepEqual(dependencies(candidate), resolvedDependencies, 'Candidates must resolve the same dependency files; place the baseline beside the same node_modules tree as the candidate.')
 const sources = {baseline: {path: baseline, sha256: hash(baseline)}, candidate: {path: candidate, sha256: hash(candidate)}, dependencies: resolvedDependencies, harnessSha256: hash(import.meta.path), oracleSha256: hash(join(import.meta.dir, 'tool-read-reference.ts'))}
 const startedAt = new Date().toISOString()
 const pairs: Pair[] = []
 mkdirSync(dirname(output), {recursive: true})
 for (let round = 0; round < rounds; round += 1) {
  const order = round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']
  const results: Record<string, WorkerResult> = {baseline: {measurements: [], maxRssKiB: 0}, candidate: {measurements: [], maxRssKiB: 0}}
  for (const workload of workloads) {
   for (const label of order) {
    const result = await runWorker(label === 'baseline' ? baseline : candidate, iterations, warmup, workload)
    results[label].measurements.push(...result.measurements)
    results[label].maxRssKiB = Math.max(results[label].maxRssKiB, result.maxRssKiB)
   }
  }
  pairs.push({order, baseline: results.baseline, candidate: results.candidate})
  writeFileSync(`${output}.partial`, JSON.stringify({sources, startedAt, rounds, iterations, warmup, pairs}))
  console.error(`Completed pair ${round + 1}/${rounds}: ${order.join(' → ')}`)
 }
 assert.equal(hash(baseline), sources.baseline.sha256, 'Baseline changed during benchmark')
 assert.equal(hash(candidate), sources.candidate.sha256, 'Candidate changed during benchmark')
 assert.deepEqual(dependencies(baseline), resolvedDependencies, 'Baseline dependencies changed during benchmark')
 assert.deepEqual(dependencies(candidate), resolvedDependencies, 'Candidate dependencies changed during benchmark')
 const summary = pairs[0].baseline.measurements.map((fixture, index) => {
  const times = (label: 'baseline' | 'candidate') =>
   pairs.map(pair => {
    const measurement = pair[label].measurements[index]
    assert.equal(measurement.name, fixture.name)
    assert.equal(measurement.bytes, fixture.bytes)
    return measurement.samplesMs
   })
  const before = times('baseline')
  const after = times('candidate')
  const speedup = pairedSpeedup(before.map(mean), after.map(mean))
  const medianSpeedup = pairedSpeedup(
   before.map(values => quantile(values, 0.5)),
   after.map(values => quantile(values, 0.5))
  )
  const stats = (samples: number[][]) => ({medianMs: quantile(samples.flat(), 0.5), p95Ms: quantile(samples.flat(), 0.95), meanMs: mean(samples.flat()), roundMeanMs: samples.map(mean)})
  return {name: fixture.name, bytes: fixture.bytes, baseline: stats(before), candidate: stats(after), speedup, medianSpeedup, assessment: speedup.ci95[0] > 1.05 ? 'improvement' : speedup.ci95[1] < 1 / 1.05 ? 'regression' : 'inconclusive'}
 })
 const result = {
  schemaVersion: 1,
  startedAt,
  finishedAt: new Date().toISOString(),
  sources,
  environment: {
   platform: process.platform,
   arch: process.arch,
   kernel: release(),
   cpu: cpus()[0]?.model,
   logicalCpus: cpus().length,
   cpuAffinity: process.platform === 'linux' ? readFileSync('/proc/self/status', 'utf8').match(/^Cpus_allowed_list:\s*(.*)$/m)?.[1] : undefined,
   bun: Bun.version,
   pi: JSON.parse(readFileSync(resolve(import.meta.dir, '../node_modules/@earendil-works/pi-coding-agent/package.json'), 'utf8')).version,
   tmpdir: tmpdir(),
   filesystemType: statfsSync(tmpdir()).type,
   fsync: false
  },
  methodology:
   'Separate fresh worker process per workload and candidate, alternating AB/BA pairs, per-workload warmup, warm OS page cache. Import/setup/independent assertions excluded from per-operation latency. Every warmup and measured result checked. Speedup: geometric mean of paired round-mean ratios; seeded 10000-resample paired bootstrap 95% CI. Not end-to-end agent latency or cold-disk throughput.',
  rounds,
  iterations,
  warmup,
  checks: pairs.reduce((sum, pair) => sum + [...pair.baseline.measurements, ...pair.candidate.measurements].reduce((n, item) => n + item.checks, 0), 0),
  failures: 0,
  summary,
  pairs
 }
 writeFileSync(output, JSON.stringify(result, null, 1) + '\n')
 rmSync(`${output}.partial`)
 console.table(summary.map(item => ({workload: item.name, beforeMs: item.baseline.medianMs.toFixed(4), afterMs: item.candidate.medianMs.toFixed(4), speedup: item.speedup.ratio.toFixed(2), ci95: item.speedup.ci95.map(value => value.toFixed(2)).join('–'), assessment: item.assessment})))
 console.log(`Saved ${result.checks} successful checks and raw timings to ${output}`)
}

if (import.meta.main) {
 if (process.argv[2] === '--worker') console.log(JSON.stringify(await worker(process.argv[3], Number(process.argv[4]), Number(process.argv[5]), process.argv[6])))
 else await main()
}
