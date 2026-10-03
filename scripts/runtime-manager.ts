import assert from 'node:assert/strict'
import {createHmac, randomBytes} from 'node:crypto'
import {appendFileSync, existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, writeFileSync} from 'node:fs'
import {join, resolve} from 'node:path'
import {buildRuntime, command as run, fastToolsPolicy, type RuntimeAssets} from './runtime-build.ts'
import {pinNativeHelpers} from './runtime-resources.ts'
import {smokeRuntime} from './runtime-smoke.ts'
import {createActivation, directory, discardUnpublished, id, inspectLauncher, prepareDispatcher, prepareRoot, recover, sealGeneration, selection, switchActivation, verifyActivation, verifyGeneration, type Activation, type FaultHook, type Generation} from './runtime-store.ts'

export type Build = (directory: string, phase: FaultHook) => Promise<{piVersion: string; details: Record<string, unknown>}>
export type Validate = (launcher: string, generation: string) => Promise<unknown>
export class CommittedError extends Error {}

const stateFiles = ['auth.json', 'settings.json', 'models.json', 'keybindings.json', 'trust.json', 'models-store.json']
export function fingerprint(root: string, key: Buffer) {
 const agent = join(root, 'pi-agent')
 const mac = (bytes: Buffer | string) => createHmac('sha256', key).update(bytes).digest('hex')
 const result: Record<string, string> = {}
 const visit = (path: string, label: string) => {
  let stat
  try {
   stat = lstatSync(path)
  } catch {
   return
  }
  if (stat.isSymbolicLink()) {
   result[`${label}@link`] = readlinkSync(path)
   if (existsSync(path) && lstatSync(path).isFile()) result[label] = mac(readFileSync(path))
  } else if (stat.isDirectory()) {
   for (const name of readdirSync(path).sort()) if (name !== 'node_modules') visit(join(path, name), `${label}/${name}`)
  } else if (stat.isFile()) result[label] = mac(readFileSync(path))
 }
 for (const name of stateFiles) visit(join(agent, name), name)
 visit(join(agent, 'extensions'), 'extensions')
 return result
}
function changed(before: Record<string, string>, after: Record<string, string>) {
 return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(key => before[key] !== after[key]).sort()
}

export async function installTransaction(rootArg: string, launcherPath: string, version: string, build: Build, validate: Validate, hook: FaultHook = () => {}) {
 const root = prepareRoot(rootArg)
 const command = resolve(launcherPath)
 const recovered = recover(root)
 inspectLauncher(root, command)
 const initial = selection(root)
 if (initial) verifyActivation(root, initial)
 const key = randomBytes(32)
 const state = fingerprint(root, key)
 const generationId = id(),
  generation = join(root, 'generations', generationId)
 const log = join(root, 'logs', `${generationId}.jsonl`)
 const record = (entry: Record<string, unknown>) => appendFileSync(log, JSON.stringify({at: new Date().toISOString(), generation: generationId, ...entry}) + '\n', {mode: 0o600})
 const phase = (name: string) => {
  record({phase: name})
  hook(name)
 }
 let committed: Activation | undefined
 let staged: Activation | undefined
 record({phase: 'preflight', active: initial?.id ?? null, activeGeneration: initial?.generation ?? null, recovered, launcher: command, stateKeys: Object.keys(state).length})
 directory(generation)
 try {
  phase('started')
  const result = await build(generation, phase)
  phase('built')
  const metadata: Omit<Generation, 'files' | 'schemaVersion'> = {id: generationId, version, piVersion: result.piVersion, createdAt: new Date().toISOString(), details: result.details}
  const manifest = sealGeneration(generation, metadata)
  verifyGeneration(root, generationId)
  phase('sealed')
  const validation = await validate(join(generation, 'launch'), generation)
  verifyGeneration(root, generationId)
  record({phase: 'validated', validation, files: manifest.files.length})
  hook('validated')
  const drift = changed(state, fingerprint(root, key))
  assert(!drift.some(name => name.startsWith('extensions')), `User extensions changed during install (${drift.join(', ')}); nothing was activated. Retry when they are stable.`)
  if (drift.length) record({phase: 'state-drift', changed: drift, note: 'changed by another process; the installer does not write user state'})
  assert.equal(selection(root)?.id, initial?.id, 'Activation changed during build')
  prepareDispatcher(root, command, generationId)
  phase('dispatcher-ready')
  const expected = selection(root)
  const next = createActivation(root, generationId, expected?.id ?? null, generationId)
  staged = next
  phase('activation-ready')
  switchActivation(root, next, expected?.id, phase)
  committed = next
  phase('committed')
  verifyActivation(root, next)
  const status = await run([command, 'status'], root, join(root, 'logs', `${generationId}.post-commit.log`), undefined, 30000, true)
  assert(status.includes(generationId), 'Stable launcher did not select the committed generation')
  const receipt = await validate(command, generation)
  record({phase: 'verified', receipt, stateChanged: changed(state, fingerprint(root, key)), activation: next.id, previous: expected?.id ?? null})
  hook('verified')
  return next
 } catch (error) {
  const selected = (() => {
   try {
    return selection(root)
   } catch {
    return undefined
   }
  })()
  const retained = selected?.generation === generationId || selected?.controller === generationId || !!committed
  record({phase: 'error', error: String(error), committed: committed?.id ?? null, retained, active: selected?.id ?? null})
  if (committed)
   throw new CommittedError(`Activation ${committed.id} (generation ${generationId}) is COMMITTED and selected, but post-commit verification failed: ${error instanceof Error ? error.message : String(error)}. The previous activation ${committed.previous ?? '(none)'} is retained; run 'tia rollback' to select it.`, {
    cause: error
   })
  if (!retained) {
   if (staged && selected?.id !== staged.id) discardUnpublished(join(root, 'activations', staged.id))
   discardUnpublished(generation)
  }
  throw error
 }
}

export function failpoint(spec: string | undefined): FaultHook {
 if (!spec) return () => {}
 const [name, mode = 'throw'] = spec.split(':')
 assert(name && ['throw', 'SIGTERM', 'SIGKILL'].includes(mode), 'TIA_FAILPOINT must be <phase>[:throw|SIGTERM|SIGKILL]')
 return phase => {
  if (phase !== name) return
  if (mode === 'throw') throw new Error(`Injected failure at ${phase}`)
  process.kill(process.pid, mode)
  Bun.sleepSync(10000)
 }
}
export async function installRuntime(rootArg: string, command: string, assetsDir: string, env = process.env) {
 const manifest: RuntimeAssets = JSON.parse(readFileSync(join(assetsDir, 'runtime-assets.json'), 'utf8'))
 assert.equal(manifest.schemaVersion, 1)
 assert(Array.isArray(manifest.shippedFastTools), 'Runtime asset manifest lacks shipped fast-tools hashes')
 const root = prepareRoot(rootArg)
 fastToolsPolicy(root, env, manifest.shippedFastTools)
 const log = join(root, 'logs', `build-${id()}.log`)
 writeFileSync(log, '', {flag: 'wx', mode: 0o600})
 let fff = false
 const active = await installTransaction(
  root,
  command,
  manifest.version,
  async (generation, phase) => {
   const result = await buildRuntime(
    root,
    generation,
    assetsDir,
    manifest,
    log,
    env,
    name => {
     console.error(`Preparing runtime: ${name}`)
     phase(name)
    },
    resolve(command)
   )
   fff = result.details.fff.enabled
   return result
  },
  (launcher, generation) => smokeRuntime(launcher, fff, log, readFileSync(join(generation, 'extensions/fast-tools.ts'), 'utf8') === pinNativeHelpers(readFileSync(join(assetsDir, 'fast-tools-extension.ts'), 'utf8'))),
  failpoint(env.TIA_FAILPOINT)
 )
 console.log(`Activated TIA ${manifest.version}: generation ${active.generation} (activation ${active.id})`)
 if (active.previous) console.log(`Previous activation ${active.previous} is retained; run 'tia rollback' to return to it.`)
 console.log(`Launcher: ${resolve(command)}`)
 if (!process.env.PATH?.split(':').includes(resolve(command, '..'))) console.log(`Note: ${resolve(command, '..')} is not on PATH`)
 return active
}

if (import.meta.main) {
 const [root, command, assets] = process.argv.slice(2)
 assert(root && command && assets && existsSync(join(assets, 'runtime-assets.json')), 'Usage: runtime-manager.ts <root> <launcher> <assets>')
 await installRuntime(root, command, assets)
}
