import assert from 'node:assert/strict'
import {appendFileSync, chmodSync, cpSync, existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, symlinkSync, writeFileSync} from 'node:fs'
import {join, resolve} from 'node:path'
import {buildPi, compileOptions} from './build-pi.ts'
import {resolvePiAi} from './resolve-pi-ai.ts'
import {pinNativeHelpers} from './runtime-resources.ts'
import {directory, inventory, readGeneration, selection, sha256, shellQuote, type FaultHook} from './runtime-store.ts'

export type RuntimeAssets = {schemaVersion: 1; version: string; optimization: string; files: Record<string, string>; shippedFastTools: string[]}
export const piPackages = ['pi-coding-agent', 'pi-agent-core', 'pi-ai', 'pi-tui', 'pi-server', 'pi-client', 'pi-protocol', 'pi-telemetry']
const exactVersion = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/
export function flag(env: NodeJS.ProcessEnv, name: string, fallback: boolean) {
 const value = env[name]
 assert(value === undefined || value === '0' || value === '1', `${name} must be 0 or 1`)
 return value === undefined ? fallback : value === '1'
}
export function cleanEnvironment(home: string): Record<string, string> {
 const env: Record<string, string> = {HOME: home, PATH: process.env.PATH ?? '', PI_TELEMETRY: '0', PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_NO_PROXY_AUTO_START: '1', DO_NOT_TRACK: '1', BUN_DISABLE_TELEMETRY: '1', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false'}
 for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'BUN_INSTALL_CACHE_DIR', 'BUN_FEATURE_FLAG_DISABLE_IPV6', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'npm_config_registry']) if (process.env[name] !== undefined) env[name] = process.env[name]!
 return env
}
export async function command(args: string[], cwd: string, log: string, env = cleanEnvironment(process.env.HOME ?? cwd), timeout = 120000, strictStderr = false) {
 appendFileSync(log, `$ ${args.map(shellQuote).join(' ')}\n`)
 const child = Bun.spawn(args, {cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe'})
 let expired = false
 const kill = () => {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
 }
 const timer = setTimeout(() => {
  expired = true
  kill()
 }, timeout)
 let stdout = '',
  stderr = ''
 const drain = async (stream: ReadableStream<Uint8Array>, output: boolean) => {
  const decoder = new TextDecoder('utf-8', {fatal: true})
  for await (const chunk of stream) {
   appendFileSync(log, chunk)
   const text = decoder.decode(chunk, {stream: true})
   if (output) stdout += text
   else stderr = (stderr + text).slice(-16384)
   if (stdout.length > 8 * 1024 * 1024) {
    kill()
    throw new Error('Subprocess output exceeded budget')
   }
  }
  const last = decoder.decode()
  if (output) stdout += last
  else stderr += last
 }
 try {
  const [code] = await Promise.all([child.exited, drain(child.stdout, true), drain(child.stderr, false)])
  assert(!expired && code === 0, `Command failed${expired ? ' (timeout)' : ''}: ${args[0]}; see ${log}\n${stderr}`)
  assert(!strictStderr || stderr === '', `Unexpected runtime diagnostics: ${stderr}`)
  return stdout.trim()
 } finally {
  clearTimeout(timer)
  kill()
  await child.exited
 }
}
export async function versionFor(pkg: string, requested: string, cwd: string, log: string) {
 if (exactVersion.test(requested)) return requested
 assert(/^[\w.-]+$/.test(requested), 'Select an exact package version or channel tag')
 assert(Bun.which('npm'), `npm is required to resolve ${pkg}@${requested}; pin an exact version instead`)
 if (requested === 'latest') {
  const result = JSON.parse(await command(['npm', 'view', pkg, 'time', '--json', '--fetch-timeout=10000', '--fetch-retries=0'], cwd, log, undefined, 20000))
  const candidates = Object.entries(result)
   .filter(([v, date]) => exactVersion.test(v) && typeof date === 'string' && Number.isFinite(Date.parse(date)))
   .sort((a, b) => Date.parse(String(b[1])) - Date.parse(String(a[1])))
  assert(candidates.length, 'Registry supplied no dated versions')
  return candidates[0][0]
 }
 const version = JSON.parse(await command(['npm', 'view', `${pkg}@${requested}`, 'version', '--json', '--fetch-timeout=10000', '--fetch-retries=0'], cwd, log, undefined, 20000))
 assert(typeof version === 'string' && exactVersion.test(version), 'Registry did not resolve one version')
 return version
}
export function hostPiPackageDir(env: NodeJS.ProcessEnv) {
 return join(env.BUN_INSTALL || join(env.HOME ?? '', '.bun'), 'install/global/node_modules/@earendil-works/pi-coding-agent')
}
function packageVersion(directory: string) {
 const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
 assert.equal(manifest.name, '@earendil-works/pi-coding-agent', `Not a Pi package: ${directory}`)
 assert(exactVersion.test(manifest.version), `Invalid Pi version in ${directory}`)
 const version: string = manifest.version
 return version
}
export type PiSelection = {requested: string; source: 'pinned' | 'PI_PACKAGE_DIR' | 'host' | 'latest'; hostPackageDir?: string}
export function selectPi(root: string, env: NodeJS.ProcessEnv): PiSelection {
 const host = hostPiPackageDir(env)
 const hostExists = existsSync(join(host, 'package.json'))
 if (env.TIA_PI_PACKAGE_VERSION) return {requested: env.TIA_PI_PACKAGE_VERSION, source: 'pinned'}
 const external = env.PI_PACKAGE_DIR && !resolve(env.PI_PACKAGE_DIR).startsWith(root + '/') ? resolve(env.PI_PACKAGE_DIR) : undefined
 if (external && !(hostExists && realpathSync(external) === realpathSync(host))) return {requested: packageVersion(external), source: 'PI_PACKAGE_DIR'}
 if (hostExists) return {requested: packageVersion(host), source: 'host', hostPackageDir: host}
 return {requested: 'latest', source: 'latest'}
}
export type ToolsPolicy = {source: string; preserved: boolean; replacedSha256?: string}
export function extensionSource(root: string) {
 return join(root, 'pi-agent/extensions')
}
function previouslyPreserved(root: string, hash: string) {
 const generations = join(root, 'generations')
 return (existsSync(generations) ? readdirSync(generations) : []).some(id => {
  try {
   const tools: any = readGeneration(root, id).details.fastTools
   return tools?.preserved === true && tools.sourceSha256 === hash
  } catch {
   return false
  }
 })
}
export function fastToolsPolicy(root: string, env: NodeJS.ProcessEnv, shipped: string[]): ToolsPolicy {
 const source = extensionSource(root)
 const path = join(source, 'fast-tools.ts')
 const preserve = env.TIA_PRESERVE_FAST_TOOLS === undefined ? undefined : flag(env, 'TIA_PRESERVE_FAST_TOOLS', false)
 let stat
 try {
  stat = lstatSync(path)
 } catch {}
 if (preserve) {
  assert(stat?.isFile(), 'TIA_PRESERVE_FAST_TOOLS=1 requires an existing regular fast-tools.ts')
  return {source, preserved: true}
 }
 if (!stat) return {source, preserved: false}
 const hash = stat.isFile() ? sha256(readFileSync(path)) : undefined
 if (preserve === undefined && hash && previouslyPreserved(root, hash)) return {source, preserved: true}
 assert(preserve === false || (hash && shipped.includes(hash)), `${path} does not match any fast-tools.ts shipped by TIA (sha256 ${hash ?? 'not a regular file'}). Set TIA_PRESERVE_FAST_TOOLS=1 to keep it or TIA_PRESERVE_FAST_TOOLS=0 to replace it in the new generation; the existing file is never modified.`)
 return {source, preserved: false, replacedSha256: hash}
}
function lockfile(directory: string) {
 const path = join(directory, 'bun.lock')
 assert(existsSync(path), `Package install did not produce a lockfile: ${directory}`)
 return sha256(readFileSync(path))
}
function installedVersion(directory: string, name: string) {
 return JSON.parse(readFileSync(join(directory, 'node_modules', name, 'package.json'), 'utf8')).version
}
export async function buildRuntime(root: string, generation: string, assetsDir: string, manifest: RuntimeAssets, log: string, env: NodeJS.ProcessEnv, phase: FaultHook, launcher = join(root, 'tia')) {
 const source = join(generation, 'source')
 directory(source)
 for (const [name, hash] of Object.entries(manifest.files)) {
  const bytes = readFileSync(join(assetsDir, name))
  assert.equal(sha256(bytes), hash, `Asset changed: ${name}`)
  writeFileSync(join(source, name), bytes, {flag: 'wx'})
 }
 writeFileSync(join(source, 'runtime-assets.json'), JSON.stringify(manifest, null, 1) + '\n')
 const tools = fastToolsPolicy(root, env, manifest.shippedFastTools)
 const custom = tools.source
 const active = selection(root)
 const previousDetails: any = active?.generation ? readGeneration(root, active.generation).details : {}
 const selected = selectPi(root, env)
 const requested = selected.requested
 if (selected.source !== 'latest') console.error(`Pi ${requested} selected from ${selected.source === 'pinned' ? 'TIA_PI_PACKAGE_VERSION' : selected.source === 'host' ? `the host Pi at ${selected.hostPackageDir}` : 'PI_PACKAGE_DIR'}; installing an isolated registry package set.`)
 const piVersion = await versionFor('@earendil-works/pi-coding-agent', requested, generation, log)
 const fffSource = env.TIA_FFF_SOURCE ?? previousDetails.fff?.source ?? (existsSync(join(root, 'fff-source.txt')) ? readFileSync(join(root, 'fff-source.txt'), 'utf8').trim() : 'vanilla')
 assert(['vanilla', 'fork'].includes(fffSource), 'FFF source must be vanilla or fork')
 const fff: {enabled: boolean; source: string; requested?: string; version?: string; packages?: Record<string, string>; lockSha256?: string} = {enabled: flag(env, 'TIA_ENABLE_FFF', previousDetails.fff?.enabled ?? true), source: fffSource}
 const scope = fffSource === 'vanilla' ? '@ff-labs' : '@edxeth'
 if (fff.enabled) {
  const legacyManifest = join(root, `pi-agent/extensions/fff/node_modules/${scope}/pi-fff/package.json`)
  const legacyVersion = existsSync(legacyManifest) ? JSON.parse(readFileSync(legacyManifest, 'utf8')).version : undefined
  fff.requested = env.TIA_FFF_PACKAGE_VERSION ?? previousDetails.fff?.version ?? legacyVersion ?? 'nightly'
  fff.version = await versionFor(`${scope}/pi-fff`, fff.requested!, generation, log)
 }
 phase('resolved')
 const pi = join(generation, 'pi')
 directory(pi)
 writeFileSync(join(pi, 'package.json'), JSON.stringify({private: true, dependencies: Object.fromEntries(piPackages.map(name => [`@earendil-works/${name}`, piVersion]))}, null, 1))
 await command([process.execPath, 'install', '--ignore-scripts', '--backend=copyfile', '--save-text-lockfile'], pi, log)
 for (const name of piPackages) assert.equal(installedVersion(pi, `@earendil-works/${name}`), piVersion, `Unsynchronized @earendil-works/${name}`)
 const packageDir = join(pi, 'node_modules/@earendil-works/pi-coding-agent')
 const piAi = resolvePiAi(packageDir).directory
 const piLockSha256 = lockfile(pi)
 phase('packages')
 directory(join(generation, 'extensions'))
 const extensions: {name: string; type: 'file' | 'directory'; linkedFrom?: string; sha256: string}[] = []
 const before = existsSync(custom) ? inventoryOf(custom) : ''
 for (const name of existsSync(custom) ? readdirSync(custom).sort() : []) {
  if (name === 'fff' || name === 'fast-tools.ts' || name.startsWith('.')) continue
  const from = join(custom, name),
   to = join(generation, 'extensions', name)
  const link = lstatSync(from).isSymbolicLink() ? readlinkSync(from) : undefined
  cpSync(from, to, {recursive: true, dereference: true, errorOnExist: true, force: false, verbatimSymlinks: false})
  const stat = lstatSync(to)
  extensions.push({name, type: stat.isDirectory() ? 'directory' : 'file', ...(link ? {linkedFrom: link} : {}), sha256: sha256(JSON.stringify(stat.isDirectory() ? inventory(to) : readFileSync(to).toString('base64')))})
 }
 const toolsSource = tools.preserved ? readFileSync(join(custom, 'fast-tools.ts'), 'utf8') : readFileSync(join(source, 'fast-tools-extension.ts'), 'utf8')
 const adaptedTools = pinNativeHelpers(toolsSource)
 writeFileSync(join(generation, 'extensions/fast-tools.ts'), adaptedTools)
 symlinkSync('pi/node_modules', join(generation, 'node_modules'))
 if (fff.enabled) {
  const extension = join(generation, 'extensions/fff')
  directory(extension)
  writeFileSync(join(extension, 'package.json'), JSON.stringify({private: true, type: 'module', dependencies: {[`${scope}/pi-fff`]: fff.version, [`${scope}/fff-node`]: fff.version}}, null, 1))
  writeFileSync(join(extension, 'index.ts'), `export {default} from ${JSON.stringify(`${scope}/pi-fff/src/index.ts`)};\n`)
  await command([process.execPath, 'install', '--lockfile-only', '--omit=peer', '--ignore-scripts', '--save-text-lockfile'], extension, log)
  await command([process.execPath, 'install', '--production', '--frozen-lockfile', '--omit=peer', '--ignore-scripts', '--backend=copyfile'], extension, log)
  fff.packages = Object.fromEntries([`${scope}/pi-fff`, `${scope}/fff-node`].map(name => [name, installedVersion(extension, name)]))
  for (const [name, version] of Object.entries(fff.packages)) assert.equal(version, fff.version, `Unsynchronized ${name}`)
  fff.lockSha256 = lockfile(extension)
 }
 assert.equal(existsSync(custom) ? inventoryOf(custom) : '', before, 'User extensions changed during install; retry when they are stable')
 phase('fff')
 directory(join(generation, 'fast-tools'))
 const compiler = Bun.which('zig')
 if (compiler) for (const name of ['fastcopy', 'fastdrain']) await command([compiler, 'cc', '-O3', '-s', '-o', join(generation, 'fast-tools', name), join(source, `${name}.c`)], generation, log)
 else assert(!flag(env, 'TIA_REQUIRE_FAST_HELPERS', false), 'Native helpers require Zig')
 phase('helpers')
 const options = compileOptions(env)
 const mode = flag(env, 'TIA_DISABLE_LAZY_JITI', false) ? 'bundled' : 'lazy-jiti'
 const build = await buildPi(packageDir, join(generation, 'bin/pi'), join(generation, 'full-runtime'), mode, options, true)
 writeFileSync(join(generation, 'pi-build.json'), JSON.stringify(build, null, 1) + '\n')
 writeFileSync(join(generation, 'pi-package-dir.txt'), packageDir + '\n')
 writeFileSync(join(generation, 'pi-ai-package-dir.txt'), piAi + '\n')
 for (const [name, path] of [
  ['theme', 'dist/modes/interactive/theme'],
  ['assets', 'dist/modes/interactive/assets'],
  ['export-html', 'dist/core/export-html'],
  ['package.json', 'package.json'],
  ['README.md', 'README.md'],
  ['CHANGELOG.md', 'CHANGELOG.md'],
  ['docs', 'docs'],
  ['examples', 'examples']
 ])
  symlinkSync(join(packageDir, path), join(generation, 'bin', name))
 phase('full')
 const stream = join(generation, 'stream-runtime')
 directory(stream)
 await command([process.execPath, join(source, 'build-stream-catalog.ts'), join(piAi, 'dist/models.generated.js'), join(packageDir, 'dist/core/model-resolver.js'), stream], generation, log)
 const apis = ['anthropic-messages', 'azure-openai-responses', 'bedrock-converse-stream', 'google-generative-ai', 'google-vertex', 'mistral-conversations', 'openai-codex-responses', 'openai-completions', 'openai-responses']
 await command([process.execPath, 'build', '--target=bun', '--format=esm', '--minify', '--splitting', '--entry-naming=[name].mjs', '--chunk-naming=chunks/[name]-[hash].mjs', `--outdir=${stream}`, ...apis.map(api => join(piAi, 'dist/api', `${api}.js`)), join(piAi, 'dist/oauth.js')], generation, log)
 const template = readFileSync(join(source, 'pi-stream-fast.ts'), 'utf8')
 assert(template.includes('{} /* __TIA_DEFAULT_MODELS__ */'), 'Stream template boundary changed')
 const generated = template
  .replaceAll('__PI_PACKAGE_DIR__', packageDir)
  .replaceAll('__STREAM_RUNTIME_DIR__', stream)
  .replace('{} /* __TIA_DEFAULT_MODELS__ */', readFileSync(join(stream, 'default-models.json'), 'utf8'))
 writeFileSync(join(source, 'pi-stream-compiled.ts'), generated)
 for (const [entry, output] of [
  ['pi-stream-compiled.ts', 'pi-stream-fast'],
  ['runtime-control.ts', 'tia-control']
 ]) {
  const result = await Bun.build({entrypoints: [join(source, entry)], compile: {outfile: join(generation, 'bin', output)}, minify: true, format: 'esm', bytecode: options.bytecode})
  if (!result.success) throw new AggregateError(result.logs, `Failed to build ${output}`)
 }
 phase('slim')
 const config = Object.entries({
  TIA_ROOT: root,
  G: generation,
  TIA_GENERATION_ID: generation.split('/').at(-1)!,
  TIA_VERSION: manifest.version,
  TIA_PI_VERSION: piVersion,
  TIA_OPTIMIZATION_VERSION: manifest.optimization,
  TIA_FULL_BUILD_MODE: mode,
  TIA_FULL_BYTECODE: options.bytecode ? 'enabled' : 'disabled',
  TIA_FFF_STATUS: fff.enabled ? `enabled (source: ${fff.source} ${fff.version})` : 'not installed',
  TIA_PI_SOURCE: selected.source,
  TIA_HOST_PI_PACKAGE_DIR: selected.source === 'host' ? selected.hostPackageDir! : '',
  TIA_BUN: process.execPath,
  TIA_DISPATCHER: launcher
 })
  .map(([key, value]) => `${key}=${shellQuote(value)}`)
  .join('\n')
 writeFileSync(join(generation, 'launch'), readFileSync(join(source, 'runtime-launch.sh'), 'utf8').replace('# __TIA_CONFIG__', config), {mode: 0o755})
 writeFileSync(join(generation, 'control'), `#!/usr/bin/env bash\nset -euo pipefail\nexec flock --nonblock --no-fork ${shellQuote(join(root, '.upgrade.lock'))} ${shellQuote(join(generation, 'bin/tia-control'))} ${shellQuote(root)} "$@"\n`, {mode: 0o755})
 chmodSync(join(generation, 'launch'), 0o755)
 assert.equal(await command([join(generation, 'bin/tia-control'), 'probe'], generation, log), 'tia-control-v1')
 return {
  piVersion,
  details: {
   pi: {version: piVersion, requested, source: selected.source, ...(selected.hostPackageDir ? {hostPackageDir: selected.hostPackageDir} : {}), packages: Object.fromEntries(piPackages.map(name => [`@earendil-works/${name}`, piVersion])), lockSha256: piLockSha256},
   fff,
   build,
   extensions,
   fastTools: {preserved: tools.preserved, ...(tools.replacedSha256 ? {replacedSha256: tools.replacedSha256} : {}), sourceSha256: sha256(toolsSource), installedSha256: sha256(adaptedTools)},
   assetsSha256: sha256(JSON.stringify(manifest)),
   nativeHelpers: !!compiler,
   bunVersion: Bun.version,
   platform: `${process.platform}-${process.arch}`
  }
 }
}
function inventoryOf(path: string) {
 const entries: string[] = []
 const visit = (relative: string) => {
  const absolute = join(path, relative)
  const stat = lstatSync(absolute)
  if (stat.isSymbolicLink()) {
   entries.push(`${relative}\0link\0${readlinkSync(absolute)}`)
   if (existsSync(absolute) && lstatSync(absolute).isFile()) entries.push(`${relative}\0target\0${sha256(readFileSync(absolute))}`)
  } else if (stat.isDirectory()) for (const name of readdirSync(absolute).sort()) visit(join(relative, name))
  else entries.push(`${relative}\0file\0${stat.size}\0${stat.mtimeMs}`)
 }
 visit('')
 return sha256(entries.join('\n'))
}
