import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync} from 'node:fs'
import {join, resolve} from 'node:path'
import {transactionPhases} from './runtime-fixture.ts'
import {holders, pointer, referenced, selection, verifyActivation} from './runtime-store.ts'

const commitPhases = new Set(['after-switch', 'committed', 'verified'])
const secret = 'SECRET-FAULT-MATRIX-4b1d'

function stateHash(root: string) {
 const hash = createHash('sha256')
 const visit = (path: string) => {
  for (const name of readdirSync(path).sort()) {
   const child = join(path, name)
   const stat = lstatSync(child)
   if (stat.isDirectory()) visit(child)
   else hash.update(child).update(stat.isSymbolicLink() ? readlinkSync(child) : readFileSync(child))
  }
 }
 visit(join(root, 'pi-agent'))
 return hash.digest('hex')
}

if (import.meta.main) {
 const [evidenceArg, modesArg = 'SIGKILL'] = process.argv.slice(2)
 assert(evidenceArg, 'Usage: runtime-fault-matrix.ts <evidence-dir> [SIGKILL,SIGTERM,throw]')
 const evidence = resolve(evidenceArg)
 assert(!existsSync(evidence), 'Evidence directory must be new')
 const home = join(evidence, 'home'),
  root = join(home, '.local/share/tia'),
  launcher = join(home, '.local/bin/tia')
 mkdirSync(join(root, 'pi-agent/extensions'), {recursive: true})
 mkdirSync(join(root, 'pi-agent/sessions'))
 writeFileSync(join(root, 'pi-agent/auth.json'), JSON.stringify({fixture: {type: 'api_key', key: secret}}))
 writeFileSync(join(root, 'pi-agent/sessions/kept.jsonl'), '{"type":"session"}\n')
 writeFileSync(join(root, 'pi-agent/extensions/user-kept.ts'), 'export default function () {}\n')
 const pins = {TIA_PI_PACKAGE_VERSION: process.env.TIA_PI_PACKAGE_VERSION ?? '0.87.1', TIA_FFF_PACKAGE_VERSION: process.env.TIA_FFF_PACKAGE_VERSION ?? '0.10.7-nightly.c3f2c7f'}
 const env = {PATH: process.env.PATH ?? '', HOME: home, PI_NO_PROXY_AUTO_START: '1', ...pins}
 const install = (label: string, failpoint?: string, overrides: Record<string, string> = {}) => {
  const started = performance.now()
  const result = Bun.spawnSync(['bash', resolve(import.meta.dir, 'install-tia.sh'), 'install'], {env: {...env, ...(failpoint ? {TIA_FAILPOINT: failpoint} : {}), ...overrides}, stdout: 'pipe', stderr: 'pipe', timeout: 900000})
  writeFileSync(join(evidence, `${label}.log`), result.stdout.toString() + result.stderr.toString())
  return {code: result.exitCode, ms: Math.round(performance.now() - started)}
 }
 const tia = (...args: string[]) => {
  const result = Bun.spawnSync([launcher, ...args], {env, stdout: 'pipe', stderr: 'pipe'})
  return {code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString()}
 }
 const baseline = install('baseline')
 assert.equal(baseline.code, 0, 'Baseline install failed')
 assert.equal(tia('pi', '--version').code, 0, 'Baseline launcher failed')
 const state = stateHash(root)
 const rows: Record<string, unknown>[] = []
 const inputs: [string, Record<string, string>][] = [
  ['unknown-pi-version', {TIA_PI_PACKAGE_VERSION: '999.0.0'}],
  ['unknown-fff-version', {TIA_FFF_PACKAGE_VERSION: '999.0.0'}],
  ['registry-unreachable', {TIA_PI_PACKAGE_VERSION: 'latest', npm_config_registry: 'http://127.0.0.1:9/'}]
 ]
 const checkUnchanged = (label: string, before: string | undefined, code: number | null) => {
  const leaked = readdirSync(join(root, 'generations')).flatMap(id => holders(join(root, 'generations', id)))
  const refs = referenced(root)
  const row = {mode: 'inputs', phase: label, exit: code, pointerChanged: pointer(root) !== before, leakedProcesses: leaked, unreferenced: readdirSync(join(root, 'generations')).filter(id => !refs.generations.has(id)), userStateUnchanged: stateHash(root) === state, launcherWorks: tia('pi', '--version').code === 0}
  rows.push(row)
  console.log(JSON.stringify(row))
  assert(code !== 0 && !row.pointerChanged && !leaked.length && !row.unreferenced.length && row.userStateUnchanged && row.launcherWorks, `${label}: pre-commit input failure was not contained`)
 }
 if (modesArg.split(',').includes('inputs')) {
  for (const [label, overrides] of inputs) {
   const before = pointer(root)
   checkUnchanged(label, before, install(label, undefined, overrides).code)
  }
  const before = pointer(root)
  const child = Bun.spawn(['bash', resolve(import.meta.dir, 'install-tia.sh'), 'install'], {env, stdout: 'ignore', stderr: 'ignore'})
  for (let i = 0; i < 400 && !readdirSync(join(root, 'generations')).some(id => existsSync(join(root, 'generations', id, 'pi'))); i++) await Bun.sleep(25)
  child.kill('SIGTERM')
  const code = await child.exited
  await Bun.sleep(200)
  tia('recover')
  checkUnchanged('external-sigterm-during-packages', before, code)
 }
 for (const mode of modesArg.split(',').filter(mode => mode !== 'inputs'))
  for (const phase of transactionPhases) {
   const before = pointer(root)
   const beforeGeneration = selection(root)?.generation
   const result = install(`${mode}-${phase}`, `${phase}:${mode}`)
   const committed = commitPhases.has(phase)
   const after = selection(root)
   const leaked = readdirSync(join(root, 'generations')).flatMap(id => holders(join(root, 'generations', id)))
   const recovered = tia('recover')
   const refs = referenced(root)
   const unreferenced = readdirSync(join(root, 'generations')).filter(id => !refs.generations.has(id))
   verifyActivation(root, selection(root)!)
   const status = tia('status')
   const version = tia('pi', '--version')
   const logs = readdirSync(join(root, 'logs'))
    .map(name => readFileSync(join(root, 'logs', name), 'utf8'))
    .join('\n')
   const row = {
    mode,
    phase,
    exit: result.code,
    ms: result.ms,
    pointerChanged: pointer(root) !== before,
    expectedCommit: committed,
    selectedGeneration: after?.generation,
    statusMatchesSelection: status.code === 0 && status.out.includes(after?.generation ?? '<none>'),
    launcherWorks: version.code === 0 && /^\d+\.\d+\.\d+/.test(version.out),
    leakedProcesses: leaked,
    recoverExit: recovered.code,
    unreferencedAfterRecover: unreferenced,
    tempPointers: readdirSync(root).filter(name => name.startsWith('.current-')),
    userStateUnchanged: stateHash(root) === state,
    phaseLogged: logs.includes(`"phase":"${phase}"`),
    secretInLogs: logs.includes(secret)
   }
   rows.push(row)
   console.log(JSON.stringify(row))
   assert.notEqual(result.code, 0)
   assert.equal(row.pointerChanged, committed, `${mode}/${phase}: pointer change does not match commit point`)
   if (!committed) assert.equal(after?.generation, beforeGeneration)
   assert(row.statusMatchesSelection && row.launcherWorks, `${mode}/${phase}: launcher does not run the selected generation`)
   assert.deepEqual(leaked, [], `${mode}/${phase}: transaction processes survived`)
   assert.equal(recovered.code, 0, `${mode}/${phase}: recovery failed: ${recovered.err}`)
   assert.deepEqual(unreferenced, [], `${mode}/${phase}: unreferenced staging remains`)
   assert.deepEqual(row.tempPointers, [])
   assert(row.userStateUnchanged, `${mode}/${phase}: user state changed`)
   assert(row.phaseLogged && !row.secretInLogs, `${mode}/${phase}: log receipt invalid`)
  }
 const rollback = tia('rollback')
 assert.equal(rollback.code, 0, rollback.err)
 assert.equal(tia('verify').code, 0)
 writeFileSync(join(evidence, 'matrix.json'), JSON.stringify({pins, bun: Bun.version, rows, finalRollback: JSON.parse(rollback.out)}, null, 1) + '\n')
 console.log(`Fault matrix passed: ${rows.length} injected failures`)
}
