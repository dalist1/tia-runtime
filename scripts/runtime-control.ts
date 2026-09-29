import assert from 'node:assert/strict'
import {readdirSync} from 'node:fs'
import {join} from 'node:path'
import {createActivation, discardUnpublished, holders, readActivation, readGeneration, recover, rollback, select, selection, switchActivation, validId, verifyActivation} from './runtime-store.ts'

export function control(root: string, action: string, args: string[] = []) {
 if (action === 'recover') return {recovered: recover(root)}
 if (action === 'select') {
  assert(args.length === 1 && validId(args[0]), 'Usage: tia select <activation-id>')
  const next = select(root, args[0])
  return {selected: next.id, generation: next.generation}
 }
 const recovered = recover(root)
 const active = selection(root)
 assert(active, 'No active runtime')
 if (action === 'rollback') {
  assert.equal(args.length, 0, 'Usage: tia rollback')
  const next = rollback(root)
  return {rolledBack: true, activation: next.id, generation: next.generation, legacy: !!next.legacy, disabled: !!next.disabled, from: active.id}
 }
 if (action === 'uninstall') {
  assert.equal(args.length, 0, 'Usage: tia uninstall')
  const disabled = createActivation(root, null, active.id, active.controller, undefined, true)
  switchActivation(root, disabled, active.id)
  return {deactivated: true, activation: disabled.id, note: 'Runtime generations, launcher and user state are retained; running processes are unaffected. tia rollback restores the previous selection.'}
 }
 if (action === 'verify') {
  assert.equal(args.length, 0, 'Usage: tia verify')
  const manifest = verifyActivation(root, active)
  return {verified: true, activation: active.id, generation: active.generation, legacy: !!active.legacy, disabled: !!active.disabled, version: manifest?.version, files: manifest?.files.length, recovered}
 }
 if (action === 'generations') {
  assert.equal(args.length, 0, 'Usage: tia generations')
  return {
   active,
   generations: readdirSync(join(root, 'generations'))
    .sort()
    .map(id => {
     try {
      const manifest = readGeneration(root, id)
      return {id, version: manifest.version, piVersion: manifest.piVersion, createdAt: manifest.createdAt, sealed: true}
     } catch {
      return {id, sealed: false}
     }
    })
  }
 }
 if (action === 'prune') {
  const keep = new Set([active.generation, active.controller])
  let apply = false
  for (const arg of args) {
   if (arg === '--apply') apply = true
   else if (arg.startsWith('--keep=') && validId(arg.slice(7))) keep.add(arg.slice(7))
   else throw new Error('Usage: tia prune [--apply] [--keep=<generation-id>...]')
  }
  let cursor = active.previous
  for (let depth = 0; cursor && depth < 1000; depth++) {
   const previous = readActivation(root, cursor)
   keep.add(previous.controller)
   if (previous.generation && previous.generation !== active.generation) {
    keep.add(previous.generation)
    break
   }
   cursor = previous.previous
  }
  const candidates = readdirSync(join(root, 'generations'))
   .sort()
   .filter(id => !keep.has(id))
  const report = candidates.map(id => ({id, holders: holders(join(root, 'generations', id))}))
  const removed: string[] = []
  if (apply)
   for (const {id, holders: pids} of report)
    if (!pids.length) {
     discardUnpublished(join(root, 'generations', id))
     removed.push(id)
    }
  return {dryRun: !apply, kept: [...keep].filter(Boolean).sort(), candidates: report, removed, note: 'Generations used by running processes are never removed. Activations referencing removed generations can no longer be selected.'}
 }
 throw new Error('Expected rollback, verify, generations, recover, select, prune or uninstall')
}

if (import.meta.main) {
 const [root, action, ...args] = process.argv.slice(2)
 if (root === 'probe' && action === undefined) console.log('tia-control-v1')
 else {
  assert(root && action, 'Usage: tia-control <root> <action> [args...]')
  console.log(JSON.stringify(control(root, action, args), null, 1))
 }
}
