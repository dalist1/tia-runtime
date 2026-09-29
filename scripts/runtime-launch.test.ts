import {afterEach, expect, test} from 'bun:test'
import {lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {fastToolsPolicy, selectPi} from './runtime-build.ts'
import {isolateResourceSource} from './runtime-resources.ts'
import {shellQuote} from './runtime-store.ts'

const homes: string[] = []
afterEach(() => {
 for (const home of homes.splice(0)) rmSync(home, {recursive: true, force: true})
})
const report = 'for name in PI_CODING_AGENT_DIR TIA_STREAM_AGENT_DIR TIA_AGENT_EXTENSIONS_DIR TIA_FAST_TOOLS_DIR NODE_PATH PI_PACKAGE_DIR TIA_GENERATION_DIR PI_FFF_MODE FFF_HISTORY_DB; do printf "%s=%s\\n" "$name" "${!name:-}"; done; printf "args=%s\\n" "$*"'

function launcher(overrides: Record<string, string> = {}) {
 const home = mkdtempSync(join(tmpdir(), 'tia-launch-'))
 homes.push(home)
 const root = join(home, 'root'),
  generation = join(root, 'generations/g')
 mkdirSync(join(generation, 'bin'), {recursive: true})
 for (const name of ['pi', 'pi-stream-fast']) writeFileSync(join(generation, 'bin', name), `#!/usr/bin/env bash\necho binary=${name}\n${report}\n`, {mode: 0o755})
 const config = Object.entries({
  TIA_ROOT: root,
  G: generation,
  TIA_GENERATION_ID: 'g',
  TIA_VERSION: '0.7.0',
  TIA_PI_VERSION: '1.0.0',
  TIA_OPTIMIZATION_VERSION: 'marker',
  TIA_FULL_BUILD_MODE: 'lazy-jiti',
  TIA_FULL_BYTECODE: 'enabled',
  TIA_FFF_STATUS: 'enabled',
  TIA_PI_SOURCE: 'host',
  TIA_HOST_PI_PACKAGE_DIR: '',
  TIA_BUN: '/nonexistent/bun',
  TIA_DISPATCHER: '/nonexistent/tia',
  ...overrides
 })
  .map(([key, value]) => `${key}=${shellQuote(value)}`)
  .join('\n')
 mkdirSync(join(root, 'logs'))
 const path = join(generation, 'launch')
 writeFileSync(path, readFileSync(resolve(import.meta.dir, 'runtime-launch.sh'), 'utf8').replace('# __TIA_CONFIG__', config), {mode: 0o755})
 const shell = join(home, '.pi/agent')
 mkdirSync(shell, {recursive: true})
 for (const name of ['auth.json', 'models.json', 'settings.json']) writeFileSync(join(shell, name), `{"${name}":true}`)
 const run = (args: string[], env: Record<string, string> = {}) => {
  const result = Bun.spawnSync([path, ...args], {env: {PATH: process.env.PATH ?? '', HOME: home, PI_NO_PROXY_AUTO_START: '1', ...env}, stdout: 'pipe', stderr: 'pipe'})
  const out = result.stdout.toString()
  return {code: result.exitCode, out, err: result.stderr.toString(), env: Object.fromEntries(out.split('\n').flatMap(line => (line.includes('=') ? [[line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]] : [])))}
 }
 return {home, root, generation, shell, agent: join(root, 'pi-agent'), run}
}

test('full mode pins every runtime path to its generation and ignores hostile overrides', () => {
 const t = launcher()
 const result = t.run(['pi', '--fff-mode', 'tools-only', 'hello'], {NODE_PATH: '/hostile', TIA_AGENT_EXTENSIONS_DIR: '/hostile', TIA_FAST_TOOLS_DIR: '/hostile', PI_PACKAGE_DIR: '/hostile'})
 expect(result.code).toBe(0)
 expect(result.env).toMatchObject({
  binary: 'pi',
  PI_CODING_AGENT_DIR: t.agent,
  TIA_AGENT_EXTENSIONS_DIR: join(t.generation, 'extensions'),
  TIA_FAST_TOOLS_DIR: join(t.generation, 'fast-tools'),
  NODE_PATH: join(t.generation, 'pi/node_modules'),
  PI_PACKAGE_DIR: join(t.generation, 'bin'),
  TIA_GENERATION_DIR: t.generation,
  PI_FFF_MODE: 'tools-only',
  FFF_HISTORY_DB: join(t.agent, 'fff/history.sqlite'),
  args: '--fff-mode tools-only hello'
 })
 for (const name of ['auth.json', 'models.json', 'settings.json']) expect(readlinkSync(join(t.agent, name))).toBe(join(t.shell, name))
})

test('slim routing uses the shell agent and the same generation', () => {
 const t = launcher()
 const custom = join(t.home, 'custom-agent')
 const result = t.run(['pi', '--mode', 'json', '--no-session', '--provider', 'x', 'hi'], {PI_CODING_AGENT_DIR: custom})
 expect(result.env).toMatchObject({binary: 'pi-stream-fast', TIA_STREAM_AGENT_DIR: custom, PI_CODING_AGENT_DIR: t.agent, PI_PACKAGE_DIR: join(t.generation, 'bin')})
 expect(t.run(['pi', '--mode', 'json', '--no-session'], {TIA_DISABLE_FAST_STREAM: '1'}).env.binary).toBe('pi')
 expect(t.run(['pi', '--mode', 'json', '--no-session', '--unknown']).env.binary).toBe('pi')
})

test('slim mode without an explicit agent uses the TIA agent and its credential links', () => {
 const t = launcher()
 const result = t.run(['pi', '--mode', 'json', '--no-session'])
 expect(result.env).toMatchObject({binary: 'pi-stream-fast', TIA_STREAM_AGENT_DIR: t.agent, PI_CODING_AGENT_DIR: t.agent})
 expect(readlinkSync(join(t.agent, 'auth.json'))).toBe(join(t.shell, 'auth.json'))
})

function hostSync(hostVersion: string, extra: Record<string, string> = {}) {
 const home = mkdtempSync(join(tmpdir(), 'tia-host-'))
 homes.push(home)
 const host = join(home, 'host-pi'),
  record = join(home, 'record')
 mkdirSync(host)
 writeFileSync(join(host, 'package.json'), `{\n "name": "@earendil-works/pi-coding-agent",\n "version": "${hostVersion}"\n}\n`)
 const recorder = (name: string) => {
  const path = join(home, name)
  writeFileSync(path, `#!/usr/bin/env bash\nprintf '%s %s TIA_FAILPOINT=%s TIA_PRESERVE_FAST_TOOLS=%s\\n' ${name} "$*" "\${TIA_FAILPOINT:-}" "\${TIA_PRESERVE_FAST_TOOLS:-}" >> ${shellQuote(record)}\n`, {mode: 0o755})
  return path
 }
 const dispatcher = recorder('dispatcher')
 const t = launcher({TIA_HOST_PI_PACKAGE_DIR: host, TIA_BUN: recorder('bun'), TIA_DISPATCHER: dispatcher, ...extra})
 const recorded = () => {
  try {
   return readFileSync(record, 'utf8')
  } catch {
   return ''
  }
 }
 return {...t, host, dispatcher, recorded}
}

test('a host Pi update starts exactly one background sync', async () => {
 const t = hostSync('2.0.0')
 expect(t.run(['pi', '--version']).env.binary).toBe('pi')
 for (let i = 0; i < 100 && !t.recorded(); i++) await Bun.sleep(20)
 expect(t.recorded()).toBe('dispatcher sync --background TIA_FAILPOINT= TIA_PRESERVE_FAST_TOOLS=\n')
 t.run(['pi', '--mode', 'json', '--no-session'])
 await Bun.sleep(200)
 expect(t.recorded().split('\n').filter(Boolean)).toHaveLength(1)
 expect(t.run(['status']).out).toMatch(/host pi:\s+2\.0\.0/)
})

test('matching, opted-out or untracked hosts never start a sync', async () => {
 const same = hostSync('1.0.0')
 const optOut = hostSync('2.0.0')
 const pinned = hostSync('2.0.0', {TIA_HOST_PI_PACKAGE_DIR: '', TIA_PI_SOURCE: 'pinned'})
 same.run(['pi', '--version'])
 optOut.run(['pi', '--version'], {TIA_AUTO_SYNC: '0'})
 pinned.run(['pi', '--version'])
 await Bun.sleep(300)
 for (const t of [same, optOut, pinned]) expect(t.recorded()).toBe('')
 expect(pinned.run(['sync']).err).toContain("Pi source 'pinned'")
 expect(same.run(['sync']).out).toContain('already matches host pi 1.0.0')
})

test('tia sync runs the generation manager with a clean environment', () => {
 const t = hostSync('2.0.0')
 const result = t.run(['sync'], {TIA_FAILPOINT: 'sealed:SIGKILL', TIA_PRESERVE_FAST_TOOLS: '1'})
 expect(result.code).toBe(0)
 expect(t.recorded()).toBe(`bun ${join(t.generation, 'source/runtime-manager.ts')} ${t.root} /nonexistent/tia ${join(t.generation, 'source')} TIA_FAILPOINT= TIA_PRESERVE_FAST_TOOLS=1\n`.replace('/nonexistent/tia', t.dispatcher))
})

test('credential links follow the shell agent without replacing user-owned files', () => {
 const t = launcher()
 mkdirSync(t.agent, {recursive: true})
 writeFileSync(join(t.agent, 'models.json'), 'user-owned')
 const custom = join(t.home, 'custom-agent')
 mkdirSync(custom)
 for (const name of ['auth.json', 'settings.json']) writeFileSync(join(custom, name), 'custom')
 t.run(['pi', '--version'], {PI_CODING_AGENT_DIR: custom})
 expect(readlinkSync(join(t.agent, 'auth.json'))).toBe(join(custom, 'auth.json'))
 expect(readFileSync(join(t.agent, 'models.json'), 'utf8')).toBe('user-owned')
 rmSync(join(custom, 'settings.json'))
 writeFileSync(join(custom, 'keybindings.json'), '{}')
 t.run(['pi', '--version'], {PI_CODING_AGENT_DIR: custom})
 expect(() => lstatSync(join(t.agent, 'settings.json'))).toThrow()
 expect(readFileSync(join(t.agent, 'models.json'), 'utf8')).toBe('user-owned')
})

test('status, updates and dangling FFF state are handled without touching generations', () => {
 const t = launcher()
 const status = t.run(['status'])
 expect(status.out).toMatch(/tia-runtime installed:\s+yes/)
 expect(status.out).toContain(`generation dir:         ${t.generation}`)
 for (const args of [
  ['pi', 'update'],
  ['pi', 'update', '--self'],
  ['pi', 'update', 'x', '--all']
 ]) {
  const blocked = t.run(args)
  expect(blocked.code).toBe(1)
  expect(blocked.err).toContain('immutable')
 }
 mkdirSync(t.agent, {recursive: true})
 symlinkSync(join(t.home, 'missing'), join(t.agent, 'fff'))
 t.run(['pi', '--version'])
 expect(lstatSync(join(t.agent, 'fff')).isDirectory()).toBe(true)
 expect(t.run(['bogus']).code).toBe(1)
})

test('fast-tools replacement fails closed unless its provenance is known', () => {
 const home = mkdtempSync(join(tmpdir(), 'tia-tools-'))
 homes.push(home)
 const extensions = join(home, 'pi-agent/extensions')
 mkdirSync(extensions, {recursive: true})
 expect(fastToolsPolicy(home, {}, [])).toEqual({source: extensions, preserved: false})
 writeFileSync(join(extensions, 'fast-tools.ts'), 'custom tools')
 const hash = new Bun.CryptoHasher('sha256').update('custom tools').digest('hex')
 expect(() => fastToolsPolicy(home, {}, [])).toThrow(/does not match any fast-tools.ts shipped/)
 expect(fastToolsPolicy(home, {}, [hash])).toEqual({source: extensions, preserved: false, replacedSha256: hash})
 expect(fastToolsPolicy(home, {TIA_PRESERVE_FAST_TOOLS: '1'}, [])).toEqual({source: extensions, preserved: true})
 expect(fastToolsPolicy(home, {TIA_PRESERVE_FAST_TOOLS: '0'}, [])).toEqual({source: extensions, preserved: false, replacedSha256: hash})
 expect(() => fastToolsPolicy(home, {TIA_PRESERVE_FAST_TOOLS: 'yes'}, [])).toThrow(/must be 0 or 1/)
 const previous = '00000000-0000-4000-8000-000000000001'
 mkdirSync(join(home, 'generations', previous), {recursive: true})
 writeFileSync(join(home, 'generations', previous, 'generation.json'), JSON.stringify({schemaVersion: 1, id: previous, details: {fastTools: {preserved: true, sourceSha256: hash}}}))
 expect(fastToolsPolicy(home, {}, [])).toEqual({source: extensions, preserved: true})
 writeFileSync(join(extensions, 'fast-tools.ts'), 'edited again')
 expect(() => fastToolsPolicy(home, {}, [])).toThrow(/does not match/)
 rmSync(join(extensions, 'fast-tools.ts'))
 symlinkSync(join(home, 'elsewhere.ts'), join(extensions, 'fast-tools.ts'))
 expect(() => fastToolsPolicy(home, {TIA_PRESERVE_FAST_TOOLS: '1'}, [])).toThrow(/requires an existing regular/)
})

test('resource isolation applies to the pinned Pi sources and fails closed on drift', () => {
 const dist = join(import.meta.dir, '../node_modules/@earendil-works/pi-coding-agent/dist/core')
 const packages = readFileSync(join(dist, 'package-manager.js'), 'utf8')
 const loader = readFileSync(join(dist, 'extensions/loader.js'), 'utf8')
 expect(isolateResourceSource(packages, 'packages')).toContain('process.env.TIA_AGENT_EXTENSIONS_DIR')
 expect(isolateResourceSource(loader, 'loader')).toContain('process.env.TIA_AGENT_EXTENSIONS_DIR')
 expect(() => isolateResourceSource(loader.replace('const globalExtDir', 'let globalExtDir'), 'loader')).toThrow(/boundary changed/)
})

test('the Pi version follows the host Pi unless explicitly pinned', () => {
 const home = mkdtempSync(join(tmpdir(), 'tia-select-'))
 homes.push(home)
 const root = join(home, 'root')
 const pkg = (dir: string, version: string) => {
  mkdirSync(dir, {recursive: true})
  writeFileSync(join(dir, 'package.json'), JSON.stringify({name: '@earendil-works/pi-coding-agent', version}))
  return dir
 }
 expect(selectPi(root, {HOME: home})).toEqual({requested: 'latest', source: 'latest'})
 const host = pkg(join(home, 'bun/install/global/node_modules/@earendil-works/pi-coding-agent'), '3.0.0')
 const env = {HOME: home, BUN_INSTALL: join(home, 'bun')}
 expect(selectPi(root, env)).toEqual({requested: '3.0.0', source: 'host', hostPackageDir: host})
 expect(selectPi(root, {...env, PI_PACKAGE_DIR: host})).toMatchObject({source: 'host'})
 expect(selectPi(root, {...env, PI_PACKAGE_DIR: join(root, 'generations/g/bin')})).toMatchObject({source: 'host'})
 expect(selectPi(root, {...env, PI_PACKAGE_DIR: pkg(join(home, 'other'), '2.0.0')})).toEqual({requested: '2.0.0', source: 'PI_PACKAGE_DIR'})
 expect(selectPi(root, {...env, TIA_PI_PACKAGE_VERSION: '1.2.3'})).toEqual({requested: '1.2.3', source: 'pinned'})
})
