import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFileSync, writeFileSync} from 'node:fs'
import {join, resolve} from 'node:path'

const assets = [
 'runtime-bootstrap.ts',
 'runtime-manager.ts',
 'runtime-build.ts',
 'runtime-store.ts',
 'runtime-control.ts',
 'runtime-smoke.ts',
 'runtime-resources.ts',
 'runtime-launch.sh',
 'build-pi.ts',
 'resolve-pi-ai.ts',
 'build-stream-catalog.ts',
 'pi-stream-fast.ts',
 'fast-tools-extension.ts',
 'fastcopy.c',
 'fastdrain.c'
]
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
export function shippedFastTools(root: string) {
 const git = (args: string[]) => {
  const result = Bun.spawnSync(['git', ...args], {cwd: root, stdout: 'pipe', stderr: 'pipe'})
  assert.equal(result.exitCode, 0, `git ${args[0]} failed: ${result.stderr.toString()}`)
  return result.stdout
 }
 const commits = git(['log', '--format=%H', '--', 'scripts/fast-tools-extension.ts']).toString().trim().split('\n').filter(Boolean)
 assert(commits.length, 'fast-tools history unavailable; use a full clone')
 const hashes = new Set(commits.map(commit => hash(git(['show', `${commit}:scripts/fast-tools-extension.ts`]))))
 hashes.add(hash(readFileSync(join(root, 'scripts/fast-tools-extension.ts'))))
 return [...hashes].sort()
}
export function runtimeManifest(root: string) {
 return {
  schemaVersion: 1,
  version: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
  optimization: readFileSync(join(root, 'OPTIMIZATION_VERSION'), 'utf8').trim(),
  files: Object.fromEntries(assets.map(name => [name, hash(readFileSync(join(root, name.endsWith('.c') ? 'native' : 'scripts', name)))])),
  shippedFastTools: shippedFastTools(root)
 }
}
if (import.meta.main) {
 const root = resolve(import.meta.dir, '..')
 const bytes = JSON.stringify(runtimeManifest(root), null, 1) + '\n'
 const path = join(root, 'scripts/runtime-assets.json')
 if (process.argv[2] === '--check') assert.equal(readFileSync(path, 'utf8'), bytes, 'Runtime assets changed; run bun run assets')
 else {
  assert(process.argv.length === 2, 'Usage: build-runtime-manifest.ts [--check]')
  writeFileSync(path, bytes)
 }
}
