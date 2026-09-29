import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
async function load(name: string, source: string, base: string) {
 assert(/^[\w.-]+$/.test(name) && !name.startsWith('.'), 'Invalid installer asset name')
 const relative = ['fastcopy.c', 'fastdrain.c'].includes(name) ? `../native/${name}` : name
 if (existsSync(join(source, relative))) return readFileSync(join(source, relative))
 const url = new URL(relative, base.replace(/\/$/, '') + '/')
 if (url.protocol === 'file:') return readFileSync(fileURLToPath(url))
 const response = await fetch(url, {signal: AbortSignal.timeout(20000)})
 assert(response.ok, `Asset request failed: ${name} HTTP ${response.status}`)
 const bytes = Buffer.from(await response.arrayBuffer())
 assert(bytes.length <= 2 * 1024 * 1024, 'Installer asset exceeds 2 MiB')
 return bytes
}

if (import.meta.main) {
 const [action, root, launcher, destination] = process.argv.slice(2)
 assert(action === 'install' && root && launcher && destination, 'Usage: runtime-bootstrap.ts install <root> <launcher> <asset-dir>')
 const local = dirname(import.meta.path)
 const base = process.env.INSTALL_BASE_URL ?? 'https://raw.githubusercontent.com/dalist1/tia-runtime/main/scripts'
 const raw = await load('runtime-assets.json', local, base)
 const manifest = JSON.parse(raw.toString())
 assert.equal(manifest.schemaVersion, 1)
 assert.equal(manifest.version, process.env.TIA_INSTALLER_VERSION, 'Installer/asset release mismatch')
 assert.equal(hash(readFileSync(import.meta.path)), manifest.files['runtime-bootstrap.ts'], 'Bootstrap/manifest hash mismatch')
 mkdirSync(destination, {recursive: true})
 for (const [name, expected] of Object.entries(manifest.files)) {
  const bytes = await load(name, local, base)
  assert.equal(hash(bytes), expected, `Installer asset checksum mismatch: ${name}`)
  writeFileSync(join(destination, name), bytes, {flag: 'wx'})
 }
 writeFileSync(join(destination, 'runtime-assets.json'), raw, {flag: 'wx'})
 const {installRuntime} = await import(pathToFileURL(resolve(destination, 'runtime-manager.ts')).href)
 await installRuntime(root, launcher, destination)
}
