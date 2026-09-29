import assert from 'node:assert/strict'
import {createHash, randomUUID} from 'node:crypto'
import {appendFileSync, chmodSync, closeSync, copyFileSync, existsSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync} from 'node:fs'
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path'

export const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
export const id = () => randomUUID()
export const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
export type Entry = {path: string; type: 'file' | 'directory' | 'symlink'; mode: number; size?: number; sha256?: string; link?: string}
export type Generation = {schemaVersion: 1; id: string; version: string; piVersion: string; createdAt: string; files: Entry[]; details: Record<string, unknown>}
export type Activation = {schemaVersion: 1; id: string; generation: string | null; controller: string; previous: string | null; createdAt: string; legacy?: {launcher: string; sha256: string}; disabled?: boolean}
export type FaultHook = (phase: string) => void
export const dispatcherMarker = '# tia generation dispatcher v1'

export function syncPath(path: string) {
 const fd = openSync(path, 'r')
 try {
  fsyncSync(fd)
 } finally {
  closeSync(fd)
 }
}
export function durableWrite(path: string, bytes: string | Buffer, mode = 0o600) {
 const fd = openSync(path, 'wx', mode)
 try {
  writeFileSync(fd, bytes)
  fchmodSync(fd, mode)
  fsyncSync(fd)
 } finally {
  closeSync(fd)
 }
}
export function syncFilesystem(path: string) {
 const result = Bun.spawnSync(['sync', '--file-system', path], {stdout: 'ignore', stderr: 'pipe'})
 assert.equal(result.exitCode, 0, `syncfs failed for ${path}: ${result.stderr.toString()}`)
}
export function inside(root: string, path: string) {
 const r = relative(root, path)
 return r === '' || (!isAbsolute(r) && r !== '..' && !r.startsWith(`..${sep}`))
}
export function directory(path: string) {
 mkdirSync(path, {recursive: true, mode: 0o700})
 const stat = lstatSync(path)
 assert(stat.isDirectory() && !stat.isSymbolicLink(), `Not a real directory: ${path}`)
}
export function walk(root: string, sub = ''): string[] {
 return readdirSync(join(root, sub))
  .sort()
  .flatMap(name => {
   const path = join(sub, name)
   return lstatSync(join(root, path)).isDirectory() ? [path, ...walk(root, path)] : [path]
  })
}
export function inventory(root: string, seal = false): Entry[] {
 const paths = walk(root).filter(path => path !== 'generation.json')
 const entries: Entry[] = []
 for (const path of paths) {
  const absolute = join(root, path)
  let stat = lstatSync(absolute)
  if (stat.isSymbolicLink()) {
   const link = readlinkSync(absolute)
   assert(inside(root, resolve(dirname(absolute), link)), `Dependency escapes generation: ${path} -> ${link}`)
   assert(existsSync(absolute) && inside(realpathSync(root), realpathSync(absolute)), `Dangling or escaping runtime link: ${path} -> ${link}`)
   entries.push({path, type: 'symlink', mode: stat.mode & 0o777, link})
  } else if (stat.isDirectory()) {
   entries.push({path, type: 'directory', mode: seal ? 0o555 : stat.mode & 0o777})
  } else {
   assert(stat.isFile(), `Unsupported runtime entry: ${path}`)
   if (seal) {
    if (stat.nlink > 1) {
     const copy = `${absolute}.private-${id()}`
     copyFileSync(absolute, copy)
     renameSync(copy, absolute)
    }
    chmodSync(absolute, 0o444 | (stat.mode & 0o111))
    stat = lstatSync(absolute)
   }
   assert.equal(stat.nlink, 1, `Runtime file aliases another inode: ${path}`)
   const bytes = readFileSync(absolute)
   entries.push({path, type: 'file', mode: stat.mode & 0o777, size: bytes.length, sha256: sha256(bytes)})
  }
 }
 if (seal)
  for (const path of paths.reverse())
   if (lstatSync(join(root, path)).isDirectory()) {
    chmodSync(join(root, path), 0o555)
   }
 if (seal) syncFilesystem(root)
 return entries
}
export function sealGeneration(root: string, metadata: Omit<Generation, 'files' | 'schemaVersion'>) {
 const manifest: Generation = {schemaVersion: 1, ...metadata, files: inventory(root, true)}
 durableWrite(join(root, 'generation.json'), JSON.stringify(manifest, null, 1) + '\n', 0o444)
 chmodSync(root, 0o555)
 syncPath(root)
 syncPath(dirname(root))
 return manifest
}
export function readGeneration(root: string, generation: string): Generation {
 assert(validId(generation), 'Invalid generation id')
 const manifest: Generation = JSON.parse(readFileSync(join(root, 'generations', generation, 'generation.json'), 'utf8'))
 assert.equal(manifest.schemaVersion, 1, 'Unsupported generation manifest')
 assert.equal(manifest.id, generation, 'Generation manifest id mismatch')
 return manifest
}
export function verifyGeneration(root: string, generation: string) {
 assert(validId(generation), 'Invalid generation id')
 const path = join(root, 'generations', generation)
 const stat = lstatSync(path)
 assert(stat.isDirectory() && !stat.isSymbolicLink(), 'Invalid generation directory')
 assert.equal(stat.mode & 0o222, 0, 'Generation is writable')
 assert.equal(lstatSync(join(path, 'generation.json')).mode & 0o777, 0o444, 'Generation manifest is writable')
 const manifest = readGeneration(root, generation)
 assert.deepEqual(inventory(path), manifest.files, `Generation integrity check failed: ${generation}`)
 return manifest
}
export function readActivation(root: string, activation: string): Activation {
 assert(validId(activation), 'Invalid activation id')
 const value: Activation = JSON.parse(readFileSync(join(root, 'activations', activation, 'activation.json'), 'utf8'))
 assert.equal(value.schemaVersion, 1, 'Unsupported activation record')
 assert.equal(value.id, activation, 'Activation record id mismatch')
 assert(value.generation === null || validId(value.generation), 'Invalid selected generation')
 assert(validId(value.controller), 'Invalid controller generation')
 assert(value.previous === null || validId(value.previous), 'Invalid previous activation')
 return value
}
export function pointer(root: string) {
 try {
  const path = join(root, 'current')
  assert(lstatSync(path).isSymbolicLink(), 'current is not a symlink')
  return readlinkSync(path)
 } catch (error) {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined
  throw error
 }
}
export function selection(root: string): Activation | undefined {
 const target = pointer(root)
 if (target === undefined) return undefined
 assert(/^activations\/[a-f0-9-]{36}$/.test(target), 'Invalid activation pointer')
 const path = join(root, target)
 assert(lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(), 'Invalid activation directory')
 return readActivation(root, target.slice('activations/'.length))
}
export function activationRuntime(root: string, activation: Activation) {
 return activation.generation ? join(root, 'generations', activation.generation) : undefined
}
export function activeRuntime(root: string) {
 const active = selection(root)
 return active ? activationRuntime(root, active) : undefined
}
export function verifyActivation(root: string, activation: Activation) {
 const path = join(root, 'activations', activation.id)
 assert.equal(lstatSync(path).mode & 0o222, 0, 'Activation is writable')
 assert.equal(readlinkSync(join(path, 'control')), `../../generations/${activation.controller}/control`, 'Activation control link changed')
 verifyGeneration(root, activation.controller)
 if (activation.generation) {
  assert.equal(readlinkSync(join(path, 'runtime')), `../../generations/${activation.generation}`, 'Activation runtime link changed')
  assert.equal(readlinkSync(join(path, 'launch')), 'runtime/launch', 'Activation launch link changed')
  return verifyGeneration(root, activation.generation)
 }
 if (activation.legacy) {
  assert.equal(readlinkSync(join(path, 'launch')), activation.legacy.launcher, 'Legacy launch link changed')
  assert.equal(sha256(readFileSync(activation.legacy.launcher)), activation.legacy.sha256, 'Legacy launcher changed')
 } else assert(activation.disabled && lstatSync(join(path, 'launch')).isFile(), 'Activation has no runtime')
}
function makeWritable(path: string) {
 for (const relative of ['', ...walk(path)]) {
  const target = join(path, relative)
  if (lstatSync(target).isDirectory()) chmodSync(target, 0o700)
 }
}
export function discardUnpublished(path: string) {
 if (!existsSync(path)) return
 makeWritable(path)
 rmSync(path, {recursive: true})
}
export function createActivation(root: string, generation: string | null, previous: string | null, controller: string, legacy?: Activation['legacy'], disabled = false) {
 assert(validId(controller) && (generation === null || validId(generation)), 'Invalid activation target')
 const activation: Activation = {schemaVersion: 1, id: id(), generation, controller, previous, createdAt: new Date().toISOString(), ...(legacy ? {legacy} : {}), ...(disabled ? {disabled} : {})}
 const path = join(root, 'activations', activation.id)
 directory(path)
 durableWrite(join(path, 'activation.json'), JSON.stringify(activation) + '\n', 0o444)
 symlinkSync(`../../generations/${controller}/control`, join(path, 'control'))
 if (generation) {
  symlinkSync(`../../generations/${generation}`, join(path, 'runtime'))
  symlinkSync('runtime/launch', join(path, 'launch'))
 } else if (legacy) symlinkSync(legacy.launcher, join(path, 'launch'))
 else durableWrite(join(path, 'launch'), '#!/usr/bin/env bash\necho "TIA is deactivated; run tia rollback to restore the previous runtime" >&2\nexit 1\n', 0o555)
 chmodSync(path, 0o555)
 syncPath(path)
 syncPath(dirname(path))
 return activation
}
export function switchActivation(root: string, next: Activation, expected: string | undefined, hook: FaultHook = () => {}, expectedPointer?: string) {
 if (expectedPointer === undefined) assert.equal(selection(root)?.id, expected, 'Activation changed during transaction')
 else assert.equal(pointer(root), expectedPointer, 'Activation pointer changed during transaction')
 const temporary = join(root, `.current-${id()}`)
 symlinkSync(`activations/${next.id}`, temporary)
 try {
  syncPath(root)
  hook('before-switch')
  renameSync(temporary, join(root, 'current'))
  try {
   hook('after-switch')
   syncPath(root)
  } catch (error) {
   throw new Error(`Activation ${next.id} is committed, but durability confirmation failed; inspect tia status before retrying`, {cause: error})
  }
 } finally {
  rmSync(temporary, {force: true})
 }
}
export function checkTarget(root: string, target: Activation) {
 if (target.generation) verifyGeneration(root, target.generation)
 else if (!target.disabled) {
  assert(target.legacy, 'Missing legacy rollback launcher')
  assert.equal(sha256(readFileSync(target.legacy.launcher)), target.legacy.sha256, 'Legacy launcher changed')
 }
 verifyGeneration(root, target.controller)
}
export function rollback(root: string, hook?: FaultHook) {
 const current = selection(root)
 assert(current?.previous, 'No previous activation to roll back to')
 const previous = readActivation(root, current.previous)
 checkTarget(root, previous)
 const next = createActivation(root, previous.generation, current.id, previous.controller, previous.legacy, previous.disabled)
 switchActivation(root, next, current.id, hook)
 return next
}
export function select(root: string, target: string, hook?: FaultHook) {
 const chosen = readActivation(root, target)
 checkTarget(root, chosen)
 const raw = pointer(root)
 let current: string | null = null
 try {
  current = selection(root)?.id ?? null
 } catch {}
 const next = createActivation(root, chosen.generation, current, chosen.controller, chosen.legacy, chosen.disabled)
 switchActivation(root, next, undefined, hook, raw)
 return next
}
export function shellQuote(value: string) {
 return `'${value.replaceAll("'", "'\\''")}'`
}
export function dispatcher(root: string) {
 return `#!/usr/bin/env bash
set -euo pipefail
${dispatcherMarker}
root=${shellQuote(root)}
if [[ -L "$root/current" ]]; then
 selected="$(readlink "$root/current")"
 [[ "$selected" =~ ^activations/[a-f0-9-]{36}$ ]] || { echo "Invalid TIA activation pointer; inspect $root/activations" >&2; exit 1; }
 case "\${1:-}" in
 rollback|verify|generations|uninstall|recover|select|prune) exec "$root/$selected/control" "$@" ;;
 *) exec "$root/$selected/launch" "$@" ;;
 esac
fi
echo 'No active TIA runtime; run the installer' >&2
exit 1
`
}
export type Launcher = {kind: 'none'} | {kind: 'dispatcher'; current: boolean} | {kind: 'legacy'; text: string}
export function inspectLauncher(root: string, command: string): Launcher {
 let stat
 try {
  stat = lstatSync(command)
 } catch (error) {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return {kind: 'none'}
  throw error
 }
 assert(stat.isFile(), `Refusing to replace a non-regular launcher: ${command}`)
 const text = readFileSync(command, 'utf8')
 if (text.includes(dispatcherMarker)) {
  assert(text.includes(`\nroot=${shellQuote(root)}\n`), `Dispatcher at ${command} belongs to another runtime root`)
  return {kind: 'dispatcher', current: text === dispatcher(root)}
 }
 assert(text.includes(`\nTIA_ROOT="${root}"\n`) && text.includes('\nTIA_PI_BIN='), `Refusing to replace an unrelated launcher: ${command}`)
 return {kind: 'legacy', text}
}
export function prepareDispatcher(root: string, command: string, controller: string) {
 directory(dirname(command))
 const launcher = inspectLauncher(root, command)
 if (launcher.kind === 'dispatcher' && launcher.current) return
 if (launcher.kind === 'legacy') {
  directory(join(root, 'legacy'))
  const legacy = join(root, 'legacy', `launcher-${sha256(launcher.text)}`)
  if (!existsSync(legacy)) durableWrite(legacy, launcher.text, 0o555)
  assert.equal(sha256(readFileSync(legacy)), sha256(launcher.text), 'Retained legacy launcher differs')
  syncPath(join(root, 'legacy'))
  syncPath(root)
  if (!selection(root)) switchActivation(root, createActivation(root, null, null, controller, {launcher: legacy, sha256: sha256(launcher.text)}), undefined)
 }
 const temporary = join(dirname(command), `.tia-${id()}`)
 try {
  durableWrite(temporary, dispatcher(root), 0o755)
  renameSync(temporary, command)
  syncPath(dirname(command))
 } finally {
  rmSync(temporary, {force: true})
 }
}
export function prepareRoot(path: string) {
 const root = resolve(path)
 directory(root)
 assert.equal(realpathSync(root), root, 'TIA_ROOT must not traverse symlinks')
 for (const sub of ['generations', 'activations', 'logs']) {
  directory(join(root, sub))
  assert.equal(statSync(join(root, sub)).dev, statSync(root).dev, `${sub} must be on the same filesystem as TIA_ROOT`)
 }
 syncPath(root)
 return root
}
export function referenced(root: string) {
 const generations = new Set<string>()
 const complete = new Set<string>()
 for (const name of readdirSync(join(root, 'activations'))) {
  try {
   const activation = readActivation(root, name)
   for (const path of ['control', 'launch']) lstatSync(join(root, 'activations', name, path))
   assert.equal(lstatSync(join(root, 'activations', name)).mode & 0o222, 0)
   complete.add(name)
   generations.add(activation.controller)
   if (activation.generation) generations.add(activation.generation)
  } catch {}
 }
 return {generations, activations: complete}
}
export function holders(path: string) {
 const pids: number[] = []
 const prefix = path + '/'
 const link = (file: string) => {
  try {
   return readlinkSync(file) + '/'
  } catch {
   return ''
  }
 }
 for (const pid of readdirSync('/proc').filter(name => /^\d+$/.test(name) && Number(name) !== process.pid)) {
  try {
   if (link(`/proc/${pid}/exe`).startsWith(prefix) || link(`/proc/${pid}/cwd`).startsWith(prefix) || readFileSync(`/proc/${pid}/maps`, 'utf8').includes(prefix) || readFileSync(`/proc/${pid}/environ`).includes(`TIA_GENERATION_DIR=${path}\0`)) pids.push(Number(pid))
  } catch {}
 }
 return pids
}
export function recover(root: string) {
 const actions: string[] = []
 const log = (action: string) => {
  actions.push(action)
  appendFileSync(join(root, 'logs', 'recovery.jsonl'), JSON.stringify({at: new Date().toISOString(), action}) + '\n', {mode: 0o600})
 }
 for (const name of readdirSync(root))
  if (name.startsWith('.current-') && lstatSync(join(root, name)).isSymbolicLink()) {
   rmSync(join(root, name))
   log(`removed uncommitted pointer ${name}`)
  }
 let active: Activation | undefined
 try {
  active = selection(root)
 } catch (error) {
  const candidates = readdirSync(join(root, 'activations'))
   .flatMap(name => {
    try {
     const activation = readActivation(root, name)
     verifyActivation(root, activation)
     return [activation]
    } catch {
     return []
    }
   })
   .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  throw new Error(
   `TIA activation pointer is corrupt (${String(error)}). No target was guessed. Verified activations, newest first: ${candidates.map(a => `${a.id} (${a.generation ?? (a.legacy ? 'legacy' : 'deactivated')}, ${a.createdAt})`).join(', ') || 'none'}. Select one explicitly with: ${candidates.length ? join(root, 'generations', candidates[0].controller, 'control') : '<generation>/control'} select <activation-id>`
  )
 }
 const refs = referenced(root)
 for (const name of readdirSync(join(root, 'activations')))
  if (!refs.activations.has(name) && name !== active?.id) {
   discardUnpublished(join(root, 'activations', name))
   log(`removed incomplete activation ${name}`)
  }
 for (const name of readdirSync(join(root, 'generations')))
  if (!refs.generations.has(name)) {
   const busy = holders(join(root, 'generations', name))
   if (busy.length) {
    log(`kept unselected staging generation ${name}; still used by pids ${busy.join(',')}`)
    continue
   }
   discardUnpublished(join(root, 'generations', name))
   log(`removed unselected staging generation ${name}`)
  }
 if (actions.length) syncPath(root)
 return actions
}
