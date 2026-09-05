import {createHash} from 'node:crypto'
import {existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs'
import {dirname, join, relative, resolve} from 'node:path'

const digest = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')

function packageFiles(root: string) {
 const files = new Map<string, Buffer>()
 function visit(directory: string) {
  for (const name of readdirSync(join(root, directory)).sort()) {
   if (name === 'node_modules' || name === '.git') continue
   const path = join(directory, name)
   const stat = lstatSync(join(root, path))
   if (stat.isDirectory()) visit(path)
   else if (stat.isFile()) files.set(path, readFileSync(join(root, path)))
   else throw new Error(`Unsupported package entry: ${join(root, path)}`)
  }
 }
 visit('')
 return files
}

function filesDigest(files: Map<string, Buffer>) {
 const hash = createHash('sha256')
 for (const [path, bytes] of files) hash.update(JSON.stringify([path, bytes.length])).update(bytes)
 return hash.digest('hex')
}

export function snapshotPackage(source: string, runtimeDir: string) {
 const files = packageFiles(source)
 const sha256 = filesDigest(files)
 mkdirSync(runtimeDir, {recursive: true})
 const directory = join(runtimeDir, `jiti-${sha256}`)
 const verify = () => {
  if (!lstatSync(directory).isDirectory() || filesDigest(packageFiles(directory)) !== sha256) throw new Error(`Companion verification failed: ${directory}`)
 }
 if (existsSync(directory)) {
  verify()
  return {directory, sha256}
 }
 const temporary = mkdtempSync(join(runtimeDir, '.jiti-stage-'))
 try {
  for (const [path, bytes] of files) {
   const target = join(temporary, path)
   mkdirSync(dirname(target), {recursive: true})
   writeFileSync(target, bytes, {flag: 'wx'})
  }
  if (filesDigest(packageFiles(temporary)) !== sha256) throw new Error('Staged companion verification failed')
  try {
   renameSync(temporary, directory)
  } catch (error) {
   if (!existsSync(directory)) throw error
  }
  verify()
  return {directory, sha256}
 } finally {
  rmSync(temporary, {recursive: true, force: true})
 }
}

function packageRoot(entry: string, name: string) {
 let directory = dirname(realpathSync(entry))
 while (true) {
  const manifest = join(directory, 'package.json')
  if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === name) return directory
  const parent = dirname(directory)
  if (parent === directory) throw new Error(`Cannot locate ${name} package for ${entry}`)
  directory = parent
 }
}

export async function smokeBinary(binary: string, packageDir: string, agentDir: string, version: string, timeoutMs = 10000) {
 const child = Bun.spawn([binary, '--version'], {env: {PATH: process.env.PATH ?? '', HOME: agentDir, PI_PACKAGE_DIR: packageDir, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_NO_PROXY_AUTO_START: '1'}, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe'})
 let timedOut = false
 const timer = setTimeout(() => {
  timedOut = true
  child.kill('SIGKILL')
 }, timeoutMs)
 try {
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (timedOut || code !== 0 || stdout.trim() !== version) throw new Error(`Compiled pi smoke check failed${timedOut ? ' (timeout)' : ''}: exit=${code}, stdout=${JSON.stringify(stdout)}, stderr=${stderr}`)
 } finally {
  clearTimeout(timer)
 }
}

export async function buildPi(packageDirArg: string, outfileArg: string, runtimeDirArg: string, mode: 'lazy-jiti' | 'bundled' = 'lazy-jiti') {
 const packageDir = realpathSync(packageDirArg)
 const outfile = resolve(outfileArg)
 const runtimeDir = resolve(runtimeDirArg)
 const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
 if (manifest.name !== '@earendil-works/pi-coding-agent' || typeof manifest.version !== 'string') throw new Error('Invalid pi package manifest')
 const bunEntry = join(packageDir, 'dist/bun/cli.js')
 const entry = existsSync(bunEntry) ? bunEntry : join(packageDir, 'dist/cli.js')
 const entrypoints = [entry]
 const worker = join(packageDir, 'dist/utils/image-resize-worker.js')
 if (entry === bunEntry && existsSync(worker)) entrypoints.push(worker)
 let companion: {directory: string; sha256: string; version: string; entry: string} | undefined
 let matches = 0
 const plugins: Bun.BunPlugin[] = []
 if (mode === 'lazy-jiti') {
  const standardEntry = Bun.resolveSync('jiti', packageDir)
  const staticEntry = Bun.resolveSync('jiti/static', packageDir)
  const root = packageRoot(standardEntry, 'jiti')
  if (packageRoot(staticEntry, 'jiti') !== root) throw new Error('Jiti entrypoints resolve to different packages')
  const jitiManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
   if (Object.keys(jitiManifest[field] ?? {}).length) throw new Error(`Jiti has ${field}; companion dependency closure needs revalidation. Use TIA_DISABLE_LAZY_JITI=1`)
  }
  const snapshot = snapshotPackage(root, runtimeDir)
  companion = {...snapshot, version: jitiManifest.version, entry: join(snapshot.directory, relative(root, realpathSync(standardEntry)))}
  const externalEntry = companion.entry
  plugins.push({
   name: 'tia-lazy-jiti',
   setup(build) {
    build.onResolve({filter: /^jiti\/static$/}, () => {
     matches += 1
     return {path: externalEntry, external: true}
    })
   }
  })
 }
 mkdirSync(dirname(outfile), {recursive: true})
 const stage = mkdtempSync(join(dirname(outfile), '.pi-build-'))
 try {
  const binary = join(stage, 'pi')
  const result = await Bun.build({entrypoints, compile: {outfile: binary}, minify: true, metafile: true, plugins})
  if (!result.success) throw new AggregateError(result.logs, 'Pi compilation failed')
  if (mode === 'lazy-jiti' && matches === 0) throw new Error('Upstream no longer imports jiti/static; use TIA_DISABLE_LAZY_JITI=1 and remeasure before enabling this optimization')
  const agentDir = join(stage, 'agent')
  mkdirSync(agentDir)
  await smokeBinary(binary, packageDir, agentDir, manifest.version)
  if (companion && filesDigest(packageFiles(companion.directory)) !== companion.sha256) throw new Error('Companion changed during compilation')
  const graph = result.metafile!
  const contributions = new Map<string, number>()
  for (const output of Object.values(graph.outputs)) {
   for (const [input, value] of Object.entries(output.inputs)) {
    const name = input.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/)?.[1] ?? 'local'
    contributions.set(name, (contributions.get(name) ?? 0) + value.bytesInOutput)
   }
  }
  const metadata = {
   mode,
   piVersion: manifest.version,
   bunVersion: Bun.version,
   entry,
   entrySha256: digest(readFileSync(entry)),
   companion,
   rewrittenImports: matches,
   binaryBytes: statSync(binary).size,
   binarySha256: digest(readFileSync(binary)),
   javascriptBytes: Object.values(graph.outputs).reduce((sum, output) => sum + output.bytes, 0),
   bundledModules: Object.keys(graph.inputs).length,
   contributions: Object.fromEntries([...contributions].sort((a, b) => b[1] - a[1]))
  }
  renameSync(binary, outfile)
  return metadata
 } finally {
  rmSync(stage, {recursive: true, force: true})
 }
}

if (import.meta.main) {
 const [packageDir, outfile, runtimeDir] = process.argv.slice(2)
 if (!packageDir || !outfile || !runtimeDir) throw new Error('Usage: build-pi.ts <pi-package-dir> <outfile> <runtime-dir>')
 console.log(JSON.stringify(await buildPi(packageDir, outfile, runtimeDir, process.env.TIA_DISABLE_LAZY_JITI === '1' ? 'bundled' : 'lazy-jiti'), null, 1))
}
