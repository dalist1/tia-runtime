import assert from 'node:assert/strict'
import {mkdirSync, writeFileSync} from 'node:fs'
import {join, resolve} from 'node:path'
import {command} from './runtime-build.ts'
import {failpoint, installTransaction, type Build} from './runtime-manager.ts'
import {shellQuote, type FaultHook} from './runtime-store.ts'

export const buildPhases = ['resolved', 'packages', 'fff', 'helpers', 'full', 'slim']
export const transactionPhases = ['started', ...buildPhases, 'built', 'sealed', 'validated', 'dispatcher-ready', 'activation-ready', 'before-switch', 'after-switch', 'committed', 'verified']
export const commitPhases = ['after-switch', 'committed', 'verified']

export function fixtureBuild(root: string, label: string, extra: (generation: string) => void = () => {}): Build {
 const control = resolve(import.meta.dir, 'runtime-control.ts')
 return async (generation: string, phase: FaultHook) => {
  const id = generation.split('/').at(-1)!
  mkdirSync(join(generation, 'bin'))
  writeFileSync(join(generation, 'bin/payload.txt'), `payload ${label}\n`)
  const worker = Bun.spawn(['sleep', '60'], {cwd: generation, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore'})
  try {
   for (const name of buildPhases) phase(name)
  } finally {
   worker.kill('SIGKILL')
   await worker.exited
  }
  writeFileSync(join(generation, 'launch'), `#!/usr/bin/env bash\nset -euo pipefail\n[[ "\${1:-}" != status ]] || echo "generation: ${id}"\necho "runtime ${label}"\ncat ${shellQuote(join(generation, 'bin/payload.txt'))}\n`, {mode: 0o755})
  writeFileSync(join(generation, 'control'), `#!/usr/bin/env bash\nset -euo pipefail\nexec flock --nonblock --no-fork ${shellQuote(join(root, '.upgrade.lock'))} ${shellQuote(process.execPath)} ${shellQuote(control)} ${shellQuote(root)} "$@"\n`, {mode: 0o755})
  extra(generation)
  return {piVersion: `fixture-${label}`, details: {fixture: label}}
 }
}

export async function fixtureInstall(root: string, launcher: string, label: string, hook: FaultHook = () => {}, extra?: (generation: string) => void) {
 const log = join(root, `fixture-${label}.log`)
 return installTransaction(
  root,
  launcher,
  'fixture',
  fixtureBuild(root, label, extra),
  async path => {
   const output = await command([path, 'pi'], root, log, undefined, 10000, true)
   assert(output.includes(`runtime ${label}`) && output.includes(`payload ${label}`), `Fixture ${label} validation failed: ${output}`)
   return {label}
  },
  hook
 )
}

if (import.meta.main) {
 const [root, launcher, label, spec] = process.argv.slice(2)
 assert(root && launcher && label, 'Usage: runtime-fixture.ts <root> <launcher> <label> [phase:mode]')
 const activation = await fixtureInstall(root, launcher, label, failpoint(spec || undefined))
 console.log(JSON.stringify(activation))
}
