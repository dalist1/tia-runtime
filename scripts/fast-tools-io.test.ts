import {afterAll, beforeAll, expect, test} from 'bun:test'
import {chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync} from 'node:fs'
import {homedir, tmpdir} from 'node:os'
import {join} from 'node:path'

const repo = process.cwd()
const agentDir = mkdtempSync(join(tmpdir(), 'tia-io-agent-'))
const fastToolsDir = join(agentDir, 'fast-tools')
process.env.PI_CODING_AGENT_DIR = agentDir

const work = mkdtempSync(join(tmpdir(), 'tia-io-work-'))
const filePath = (name: string) => join(work, name)

type Extension = typeof import('./fast-tools-extension.ts')
let ext: Extension

async function buildHelpers() {
 mkdirSync(fastToolsDir, {recursive: true})
 const env = {...process.env, PATH: `${join(homedir(), '.local/bin')}:${process.env.PATH ?? ''}`}
 const builds = [
  ['zig', 'build-exe', '-O', 'ReleaseFast', '-fstrip', `-femit-bin=${join(fastToolsDir, 'fastread-window')}`, join(repo, 'native/fastread-window.zig')],
  ['zig', 'build-exe', '-O', 'ReleaseFast', '-fstrip', `-femit-bin=${join(fastToolsDir, 'fastedit')}`, join(repo, 'native/fastedit.zig')],
  ['zig', 'cc', '-O3', '-pipe', '-s', '-o', join(fastToolsDir, 'fastwrite'), join(repo, 'native/fastwrite.c')],
  ['zig', 'cc', '-O3', '-pipe', '-s', '-o', join(fastToolsDir, 'fastcopy'), join(repo, 'native/fastcopy.c')],
  ['zig', 'cc', '-O3', '-pipe', '-s', '-o', join(fastToolsDir, 'fastdrain'), join(repo, 'native/fastdrain.c')]
 ]
 for (const cmd of builds) {
  const proc = Bun.spawn(cmd, {env, stdout: 'pipe', stderr: 'pipe'})
  const code = await proc.exited
  if (code !== 0) throw new Error(`helper build failed: ${cmd.join(' ')}\n${await new Response(proc.stderr).text()}`)
 }
}

function resultText(result: {content: Array<{text?: string}>}) {
 return result.content[0]?.text ?? ''
}

beforeAll(async () => {
 await buildHelpers()
 ext = await import('./fast-tools-extension.ts')
}, 180000)

afterAll(() => {
 rmSync(agentDir, {recursive: true, force: true})
 rmSync(work, {recursive: true, force: true})
})

const writeCases: Array<[string, string]> = [
 ['empty', ''],
 ['ascii', 'hello write\nsecond line\n'],
 ['crlf', 'first\r\nsecond\r\nthird\r\n'],
 ['unicode', 'emoji 😄\naccent café\nmath ∑λπ\n'],
 ['large', `${'x'.repeat(1024 * 1024)}\nEND\n`]
]

for (const [name, content] of writeCases) {
 test(`fastWrite writes exact bytes: ${name}`, async () => {
  const target = filePath(`write-${name}.txt`)
  const result = await ext.fastWrite(work, target, content)
  expect(readFileSync(target, 'utf8')).toBe(content)
  expect(resultText(result)).toContain('verified')
 })
}

test('fastWrite preserves mode when overwriting an existing file', async () => {
 const target = filePath('write-mode.txt')
 writeFileSync(target, 'original\n')
 chmodSync(target, 0o600)
 await ext.fastWrite(work, target, 'replacement\n')
 expect(readFileSync(target, 'utf8')).toBe('replacement\n')
 expect(statSync(target).mode & 0o777).toBe(0o600)
})

test('fastWrite preserves symlinks (writes through to the real target)', async () => {
 const real = filePath('write-symlink-real.txt')
 const link = filePath('write-symlink-link.txt')
 writeFileSync(real, 'before\n')
 symlinkSync(real, link)
 await ext.fastWrite(work, link, 'after via symlink\n')
 expect(lstatSync(link).isSymbolicLink()).toBe(true)
 expect(readlinkSync(link)).toBe(real)
 expect(readFileSync(real, 'utf8')).toBe('after via symlink\n')
})

test('fastWrite rejects a pre-aborted signal', async () => {
 const controller = new AbortController()
 controller.abort()
 await expect(ext.fastWrite(work, filePath('write-abort.txt'), 'x', controller.signal)).rejects.toThrow(/abort/i)
})

test('fastEdit preserves file mode (executable bit kept)', async () => {
 const target = filePath('edit-mode.sh')
 writeFileSync(target, 'hello old world\n')
 chmodSync(target, 0o755)
 await ext.fastEdit(work, [{path: target, oldText: 'old', newText: 'new'}])
 expect(readFileSync(target, 'utf8')).toBe('hello new world\n')
 expect(statSync(target).mode & 0o777).toBe(0o755)
})

test('fastEdit preserves a restricted mode (700)', async () => {
 const target = filePath('edit-mode-700')
 writeFileSync(target, 'keep old here\n')
 chmodSync(target, 0o700)
 await ext.fastEdit(work, [{path: target, oldText: 'old', newText: 'new'}])
 expect(statSync(target).mode & 0o777).toBe(0o700)
})

test('fastEdit preserves symlinks and edits the real target', async () => {
 const real = filePath('edit-symlink-real.txt')
 const link = filePath('edit-symlink-link.txt')
 writeFileSync(real, 'hello old world\n')
 chmodSync(real, 0o640)
 symlinkSync(real, link)
 const realInode = statSync(real).ino
 await ext.fastEdit(work, [{path: link, oldText: 'old', newText: 'new'}])
 expect(lstatSync(link).isSymbolicLink()).toBe(true)
 expect(readlinkSync(link)).toBe(real)
 expect(readFileSync(real, 'utf8')).toBe('hello new world\n')
 expect(statSync(real).mode & 0o777).toBe(0o640)
 expect(statSync(real).ino).toBe(realInode)
})

test('fastEdit rejects a no-op replacement (oldText === newText)', async () => {
 const target = filePath('edit-noop.txt')
 writeFileSync(target, 'same text here\n')
 await expect(ext.fastEdit(work, [{path: target, oldText: 'same', newText: 'same'}])).rejects.toThrow(/No changes/)
})

test('fastEdit errors when oldText is missing', async () => {
 const target = filePath('edit-missing.txt')
 writeFileSync(target, 'abc def\n')
 await expect(ext.fastEdit(work, [{path: target, oldText: 'zzz', newText: 'q'}])).rejects.toThrow()
 expect(readFileSync(target, 'utf8')).toBe('abc def\n')
})

test('fastEdit errors when oldText is not unique', async () => {
 const target = filePath('edit-dup.txt')
 writeFileSync(target, 'aa bb aa\n')
 await expect(ext.fastEdit(work, [{path: target, oldText: 'aa', newText: 'q'}])).rejects.toThrow()
 expect(readFileSync(target, 'utf8')).toBe('aa bb aa\n')
})

test('fastEdit applies and verifies a multi-file batch', async () => {
 const first = filePath('edit-multi-1.txt')
 const second = filePath('edit-multi-2.txt')
 writeFileSync(first, 'one old\n')
 writeFileSync(second, 'two old\n')
 await ext.fastEdit(work, [
  {path: first, oldText: 'old', newText: 'new'},
  {path: second, oldText: 'old', newText: 'new'}
 ])
 expect(readFileSync(first, 'utf8')).toBe('one new\n')
 expect(readFileSync(second, 'utf8')).toBe('two new\n')
})

test('fastRead returns a windowed slice (offset + limit)', async () => {
 const target = filePath('read-window.txt')
 writeFileSync(target, 'alpha\nbeta\ngamma\ndelta\n')
 const result = await ext.fastRead(work, target, 2, 2)
 expect(resultText(result).startsWith('beta\ngamma\n')).toBe(true)
})

test('fastRead native path truncates at DEFAULT_MAX_BYTES (50KB), matching the fallback', async () => {
 const target = filePath('read-big.txt')
 writeFileSync(target, `${'y'.repeat(60000)}\n`)
 const result = await ext.fastRead(work, target)
 expect(resultText(result)).toMatch(/exceeds 50\.0 ?KB limit/)
})

test('fastRead throws on an offset beyond EOF (parity with the TS fallback)', async () => {
 const target = filePath('read-eof.txt')
 writeFileSync(target, 'a\nb\nc\n')
 await expect(ext.fastRead(work, target, 99)).rejects.toThrow(/beyond end of file/)
})

test('fastPatch can add, update, and delete files', async () => {
 const added = filePath('patch-add.txt')
 await ext.fastPatch(work, `*** Begin Patch\n*** Add File: ${added}\n+hello\n+world\n*** End Patch`)
 expect(readFileSync(added, 'utf8')).toBe('hello\nworld\n')

 const updated = filePath('patch-update.txt')
 writeFileSync(updated, 'line one\nline two\n')
 await ext.fastPatch(work, `*** Begin Patch\n*** Update File: ${updated}\n@@\n-line two\n+line TWO\n*** End Patch`)
 expect(readFileSync(updated, 'utf8')).toBe('line one\nline TWO\n')

 await ext.fastPatch(work, `*** Begin Patch\n*** Delete File: ${added}\n*** End Patch`)
 expect(() => readFileSync(added, 'utf8')).toThrow()
})
