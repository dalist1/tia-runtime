import {existsSync, readFileSync, realpathSync} from 'node:fs'
import {dirname, join} from 'node:path'

export function resolvePiAi(packageDir: string) {
 const root = realpathSync(packageDir)
 const pi = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
 if (pi.name !== '@earendil-works/pi-coding-agent' || typeof pi.version !== 'string') throw new Error('Invalid pi package manifest')
 const entry = realpathSync(Bun.resolveSync('@earendil-works/pi-ai', root))
 let directory = dirname(entry)
 while (true) {
  const path = join(directory, 'package.json')
  if (existsSync(path)) {
   const manifest = JSON.parse(readFileSync(path, 'utf8'))
   if (manifest.name === '@earendil-works/pi-ai') {
    if (manifest.version !== pi.version) throw new Error(`Resolved pi-ai ${manifest.version} does not match pi-coding-agent ${pi.version}; install a synchronized package set`)
    return {directory, version: pi.version, entry}
   }
  }
  const parent = dirname(directory)
  if (parent === directory) throw new Error(`Cannot locate pi-ai package for ${entry}`)
  directory = parent
 }
}

if (import.meta.main) {
 const [packageDir, ...extra] = process.argv.slice(2)
 if (!packageDir || extra.length) throw new Error('Usage: resolve-pi-ai.ts <pi-package-dir>')
 console.log(resolvePiAi(packageDir).directory)
}
