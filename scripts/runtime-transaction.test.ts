import {afterEach, expect, test} from 'bun:test'
import {createHash} from 'node:crypto'
import {chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {commitPhases, fixtureInstall, transactionPhases} from './runtime-fixture.ts'
import {dispatcher, holders, readActivation, recover, rollback, selection, verifyGeneration} from './runtime-store.ts'

const fixture = resolve(import.meta.dir, 'runtime-fixture.ts')
const secret = 'SECRET-DUMMY-TOKEN-7f3a'
const homes: string[] = []
const stagedPhases = ['activation-ready', 'before-switch']
afterEach(() => {
 for (const home of homes.splice(0)) {
  Bun.spawnSync(['chmod', '-R', 'u+w', home])
  rmSync(home, {recursive: true, force: true})
 }
})

type Context = {home: string; root: string; launcher: string}
function context(): Context {
 const home = mkdtempSync(join(tmpdir(), 'tia-transaction-'))
 homes.push(home)
 const root = join(home, 'root')
 const agent = join(root, 'pi-agent')
 for (const path of ['extensions', 'sessions', 'fff']) mkdirSync(join(agent, path), {recursive: true})
 writeFileSync(join(agent, 'auth.json'), JSON.stringify({provider: {type: 'api_key', key: secret}}))
 writeFileSync(join(agent, 'settings.json'), '{"theme":"dark"}\n')
 writeFileSync(join(agent, 'sessions/session.jsonl'), '{"type":"session"}\n')
 writeFileSync(join(agent, 'extensions/user.ts'), 'export default function () {}\n')
 writeFileSync(join(agent, 'fff/history.sqlite'), 'history')
 return {home, root, launcher: join(home, 'bin/tia')}
}
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
function pointer(root: string) {
 return existsSync(join(root, 'current')) ? readlinkSync(join(root, 'current')) : undefined
}
function tia(ctx: Context, ...args: string[]) {
 const result = Bun.spawnSync([ctx.launcher, ...args], {env: {PATH: process.env.PATH ?? '', HOME: ctx.home}, stdout: 'pipe', stderr: 'pipe'})
 return {code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString()}
}
function childInstall(ctx: Context, label: string, spec = '') {
 const child = Bun.spawnSync(['setsid', process.execPath, fixture, ctx.root, ctx.launcher, label, spec], {stdout: 'pipe', stderr: 'pipe', env: {PATH: process.env.PATH ?? '', HOME: ctx.home}, timeout: 30000})
 const stragglers = readdirSync('/proc').filter(pid => {
  try {
   return /^\d+$/.test(pid) && readlinkSync(`/proc/${pid}/cwd`).startsWith(join(ctx.root, 'generations'))
  } catch {
   return false
  }
 })
 for (const pid of stragglers) process.kill(Number(pid), 'SIGKILL')
 return {code: child.exitCode, signal: child.signalCode, out: child.stdout.toString(), err: child.stderr.toString(), stragglers}
}
function generations(root: string) {
 return readdirSync(join(root, 'generations')).sort()
}
function logs(root: string) {
 return readdirSync(join(root, 'logs'))
  .map(name => readFileSync(join(root, 'logs', name), 'utf8'))
  .join('\n')
}

test('install, rollback, uninstall and restore select immutable generations atomically', async () => {
 const ctx = context()
 const before = stateHash(ctx.root)
 const a = await fixtureInstall(ctx.root, ctx.launcher, 'A')
 expect(tia(ctx, 'pi').out).toContain('runtime A')
 const b = await fixtureInstall(ctx.root, ctx.launcher, 'B')
 expect(b.previous).toBe(a.id)
 expect(tia(ctx, 'pi').out).toContain('runtime B')
 expect(tia(ctx, 'rollback').code).toBe(0)
 expect(tia(ctx, 'pi').out).toContain('runtime A')
 expect(tia(ctx, 'rollback').code).toBe(0)
 expect(tia(ctx, 'pi').out).toContain('runtime B')
 expect(tia(ctx, 'uninstall').code).toBe(0)
 const disabled = tia(ctx, 'pi')
 expect(disabled.code).toBe(1)
 expect(disabled.err).toContain('deactivated')
 expect(tia(ctx, 'rollback').code).toBe(0)
 expect(tia(ctx, 'pi').out).toContain('runtime B')
 const verified = JSON.parse(tia(ctx, 'verify').out)
 expect(verified).toMatchObject({verified: true, generation: b.generation})
 for (const id of [a.generation!, b.generation!]) verifyGeneration(ctx.root, id)
 expect(stateHash(ctx.root)).toBe(before)
 expect(logs(ctx.root)).not.toContain(secret)
})

for (const mode of ['throw', 'SIGTERM', 'SIGKILL'])
 test(`every transaction phase is crash-consistent (${mode})`, async () => {
  const ctx = context()
  const a = await fixtureInstall(ctx.root, ctx.launcher, 'A')
  const state = stateHash(ctx.root)
  let current = pointer(ctx.root)
  let expected = 'A'
  const retained = new Set([a.generation!])
  for (const phase of transactionPhases) {
   const label = `B-${phase}`
   const result = childInstall(ctx, label, `${phase}:${mode}`)
   expect(result.code === 0 && result.signal === null).toBe(false)
   if (mode === 'SIGKILL') expect(result.signal).toBe('SIGKILL')
   expect(stateHash(ctx.root)).toBe(state)
   const committed = commitPhases.includes(phase)
   if (committed) {
    expect(pointer(ctx.root)).not.toBe(current)
    expected = label
    retained.add(selection(ctx.root)!.generation!)
    current = pointer(ctx.root)
   } else expect(pointer(ctx.root)).toBe(current)
   expect(tia(ctx, 'pi').out).toContain(`runtime ${expected}`)
   recover(ctx.root)
   if (mode !== 'throw' && stagedPhases.includes(phase)) {
    const staged = generations(ctx.root).filter(id => !retained.has(id))
    expect(staged).toHaveLength(1)
    retained.add(staged[0])
   }
   expect({phase, generations: generations(ctx.root)}).toEqual({phase, generations: [...retained].sort()})
   expect(readdirSync(ctx.root).filter(name => name.startsWith('.current-'))).toEqual([])
   for (const id of retained) verifyGeneration(ctx.root, id)
   const log = logs(ctx.root)
   expect(log).toContain(`"phase":"${phase}"`)
   expect(log).not.toContain(secret)
  }
  expect(tia(ctx, 'rollback').code).toBe(0)
  expect(tia(ctx, 'pi').out).toContain('runtime B-')
  expect(stateHash(ctx.root)).toBe(state)
 }, 120000)

test('an orphaned staging process keeps its generation until it exits', () => {
 const ctx = context()
 const result = Bun.spawnSync([process.execPath, fixture, ctx.root, ctx.launcher, 'A', 'fff:SIGKILL'], {stdout: 'pipe', stderr: 'pipe', timeout: 30000})
 expect(result.signalCode).toBe('SIGKILL')
 const [staging] = generations(ctx.root)
 expect(staging).toBeDefined()
 const actions = recover(ctx.root)
 expect(actions.join('\n')).toContain('still used by pids')
 expect(generations(ctx.root)).toEqual([staging])
 for (const pid of holders(join(ctx.root, 'generations', staging))) process.kill(pid, 'SIGKILL')
 Bun.sleepSync(100)
 recover(ctx.root)
 expect(generations(ctx.root)).toEqual([])
})

test('legacy launcher migration is byte-verified and reversible at every boundary', async () => {
 const ctx = context()
 mkdirSync(join(ctx.home, 'bin'))
 const legacy = `#!/usr/bin/env bash\nset -euo pipefail\nTIA_ROOT="${ctx.root}"\nTIA_PI_BIN="${ctx.root}/bin/pi"\necho "legacy runtime $*"\n`
 writeFileSync(ctx.launcher, legacy, {mode: 0o755})
 const killed = childInstall(ctx, 'B', 'dispatcher-ready:SIGKILL')
 expect(killed.signal).toBe('SIGKILL')
 expect(readFileSync(ctx.launcher, 'utf8')).toBe(dispatcher(ctx.root))
 expect(tia(ctx, 'status').out).toBe('legacy runtime status\n')
 const active = selection(ctx.root)!
 expect(active.legacy?.sha256).toBe(createHash('sha256').update(legacy).digest('hex'))
 expect(readFileSync(active.legacy!.launcher, 'utf8')).toBe(legacy)
 await fixtureInstall(ctx.root, ctx.launcher, 'B')
 expect(tia(ctx, 'pi').out).toContain('runtime B')
 expect(tia(ctx, 'rollback').code).toBe(0)
 expect(tia(ctx, 'pi', 'x').out).toBe('legacy runtime pi x\n')
 expect(JSON.parse(tia(ctx, 'verify').out)).toMatchObject({verified: true, legacy: true})
 expect(tia(ctx, 'rollback').code).toBe(0)
 expect(tia(ctx, 'pi').out).toContain('runtime B')
 chmodSync(active.legacy!.launcher, 0o755)
 writeFileSync(active.legacy!.launcher, 'tampered')
 const selected = pointer(ctx.root)
 expect(tia(ctx, 'rollback').err).toContain('Legacy launcher changed')
 expect(pointer(ctx.root)).toBe(selected)
})

for (const scenario of ['unrelated', 'symlink', 'foreign-dispatcher'])
 test(`preflight refuses ${scenario} launchers without staging anything`, () => {
  const ctx = context()
  mkdirSync(join(ctx.home, 'bin'))
  const other = join(ctx.home, 'other')
  writeFileSync(other, '#!/bin/sh\necho other\n', {mode: 0o755})
  if (scenario === 'unrelated') writeFileSync(ctx.launcher, '#!/bin/sh\necho other\n', {mode: 0o755})
  if (scenario === 'symlink') symlinkSync(other, ctx.launcher)
  if (scenario === 'foreign-dispatcher') writeFileSync(ctx.launcher, dispatcher(join(ctx.home, 'elsewhere')), {mode: 0o755})
  const before = readFileSync(ctx.launcher)
  const result = childInstall(ctx, 'A')
  expect(result.code).toBe(1)
  expect(result.err).toMatch(/Refusing|another runtime root/)
  expect(readFileSync(ctx.launcher)).toEqual(before)
  expect(generations(ctx.root)).toEqual([])
  expect(pointer(ctx.root)).toBeUndefined()
 })

test('tampered, aliased or escaping generations are rejected', async () => {
 const ctx = context()
 const a = await fixtureInstall(ctx.root, ctx.launcher, 'A')
 await fixtureInstall(ctx.root, ctx.launcher, 'B')
 const payload = join(ctx.root, 'generations', a.generation!, 'bin/payload.txt')
 const alias = join(ctx.home, 'alias')
 linkSync(payload, alias)
 expect(() => verifyGeneration(ctx.root, a.generation!)).toThrow(/aliases another inode/)
 expect(tia(ctx, 'rollback').code).not.toBe(0)
 unlinkSync(alias)
 chmodSync(join(ctx.root, 'generations', a.generation!, 'bin'), 0o755)
 chmodSync(payload, 0o644)
 writeFileSync(payload, 'payload changed\n')
 chmodSync(payload, 0o444)
 chmodSync(join(ctx.root, 'generations', a.generation!, 'bin'), 0o555)
 expect(() => verifyGeneration(ctx.root, a.generation!)).toThrow(/integrity/)
 expect(tia(ctx, 'rollback').code).not.toBe(0)
 expect(tia(ctx, 'pi').out).toContain('runtime B')
 const selected = pointer(ctx.root)
 await expect(fixtureInstall(ctx.root, ctx.launcher, 'C', undefined, generation => symlinkSync(ctx.home, join(generation, 'escape')))).rejects.toThrow(/escapes generation/)
 expect(pointer(ctx.root)).toBe(selected)
 expect(generations(ctx.root)).toHaveLength(2)
})

test('a corrupt pointer is never guessed and explicit select repairs it', async () => {
 const ctx = context()
 const a = await fixtureInstall(ctx.root, ctx.launcher, 'A')
 const b = await fixtureInstall(ctx.root, ctx.launcher, 'B')
 rmSync(join(ctx.root, 'current'))
 symlinkSync('activations/00000000-0000-0000-0000-000000000000', join(ctx.root, 'current'))
 expect(() => recover(ctx.root)).toThrow(new RegExp(`No target was guessed.*${b.id}.*${a.id}`))
 expect(tia(ctx, 'pi').code).not.toBe(0)
 const control = join(ctx.root, 'generations', b.generation!, 'control')
 const repaired = Bun.spawnSync([control, 'select', a.id], {stdout: 'pipe', stderr: 'pipe'})
 expect(repaired.exitCode).toBe(0)
 expect(tia(ctx, 'pi').out).toContain('runtime A')
})

test('rollback is crash-safe on both sides of its commit point', async () => {
 const ctx = context()
 await fixtureInstall(ctx.root, ctx.launcher, 'A')
 await fixtureInstall(ctx.root, ctx.launcher, 'B')
 const selected = pointer(ctx.root)
 expect(() =>
  rollback(ctx.root, phase => {
   if (phase === 'before-switch') throw new Error('injected')
  })
 ).toThrow('injected')
 expect(pointer(ctx.root)).toBe(selected)
 expect(tia(ctx, 'pi').out).toContain('runtime B')
 expect(() =>
  rollback(ctx.root, phase => {
   if (phase === 'after-switch') throw new Error('injected')
  })
 ).toThrow(/committed/)
 expect(tia(ctx, 'pi').out).toContain('runtime A')
 recover(ctx.root)
 expect(JSON.parse(tia(ctx, 'verify').out).verified).toBe(true)
})

test('concurrent mutators are serialized by the upgrade lock', async () => {
 const ctx = context()
 await fixtureInstall(ctx.root, ctx.launcher, 'A')
 await fixtureInstall(ctx.root, ctx.launcher, 'B')
 const selected = pointer(ctx.root)
 const holder = Bun.spawn(['flock', join(ctx.root, '.upgrade.lock'), 'sleep', '20'])
 await Bun.sleep(200)
 try {
  expect(tia(ctx, 'rollback').code).not.toBe(0)
  const installer = Bun.spawnSync(['bash', resolve(import.meta.dir, 'install-tia.sh'), 'install'], {env: {PATH: process.env.PATH ?? '', HOME: ctx.home, TIA_ROOT: ctx.root, XDG_BIN_HOME: join(ctx.home, 'bin')}, stdout: 'pipe', stderr: 'pipe', timeout: 20000})
  expect(installer.exitCode).not.toBe(0)
  expect(pointer(ctx.root)).toBe(selected)
  expect(generations(ctx.root)).toHaveLength(2)
 } finally {
  holder.kill('SIGKILL')
  await holder.exited
 }
})

test('prune keeps current, previous and busy generations', async () => {
 const ctx = context()
 const a = await fixtureInstall(ctx.root, ctx.launcher, 'A')
 const b = await fixtureInstall(ctx.root, ctx.launcher, 'B')
 const c = await fixtureInstall(ctx.root, ctx.launcher, 'C')
 const dry = JSON.parse(tia(ctx, 'prune').out)
 expect(dry.dryRun).toBe(true)
 expect(dry.candidates.map((entry: {id: string}) => entry.id)).toEqual([a.generation!])
 const oldGeneration = join(ctx.root, 'generations', a.generation!)
 const session = Bun.spawn(['sleep', '30'], {env: {PATH: process.env.PATH ?? '', TIA_GENERATION_DIR: oldGeneration}})
 try {
  const busy = JSON.parse(tia(ctx, 'prune', '--apply').out)
  expect(busy.removed).toEqual([])
  expect(busy.candidates[0].holders).toContain(session.pid)
 } finally {
  session.kill('SIGKILL')
  await session.exited
 }
 expect(JSON.parse(tia(ctx, 'prune', '--apply').out).removed).toEqual([a.generation!])
 expect(generations(ctx.root)).toEqual([b.generation!, c.generation!].sort())
 expect(tia(ctx, 'uninstall').code).toBe(0)
 expect(tia(ctx, 'rollback').code).toBe(0)
 const kept = JSON.parse(tia(ctx, 'prune').out).kept
 expect(kept).toContain(b.generation)
 expect(readActivation(ctx.root, selection(ctx.root)!.id).generation).toBe(c.generation)
})
