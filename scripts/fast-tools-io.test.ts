import {afterAll, beforeAll, expect, test} from 'bun:test'
import {chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

const agentDir = mkdtempSync(join(tmpdir(), 'tia-io-agent-'))
process.env.PI_CODING_AGENT_DIR = agentDir

const work = mkdtempSync(join(tmpdir(), 'tia-io-work-'))
const filePath = (name: string) => join(work, name)

type Extension = typeof import('./fast-tools-extension.ts')
let ext: Extension

function resultText(result: {content: Array<{text?: string}>}) {
 return result.content[0]?.text ?? ''
}

beforeAll(async () => {
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

test('fastRead truncates a first line that exceeds DEFAULT_MAX_BYTES (50KB)', async () => {
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

test('fastRead matches a naive reference on a unicode window crossing the 256KB scan boundary', async () => {
 const target = filePath('read-chunk-boundary.txt')
 const lines: string[] = []
 for (let i = 0; i < 8000; i += 1) {
  lines.push(`line ${i} café ∑λπ 😄 ${'x'.repeat(64)}`)
 }
 const content = `${lines.join('\n')}\n`
 expect(Buffer.byteLength(content, 'utf8')).toBeGreaterThan(600 * 1024)
 writeFileSync(target, content)

 // ~90-byte lines put the 256KB scan boundary near line 2900; the wide
 // windows below force lines to span two scan chunks.
 for (const [offset, limit] of [
  [2800, 200],
  [2905, 3],
  [1, 20],
  [7990, 100]
 ]) {
  const result = await ext.fastRead(work, target, offset, limit)
  const expected = lines
   .slice(offset - 1, Math.min(offset - 1 + limit, lines.length))
   .map(line => `${line}\n`)
   .join('')
  expect(resultText(result).startsWith(expected)).toBe(true)
 }
})

test('fastRead reports line-limit truncation with a continuation offset', async () => {
 const target = filePath('read-line-limit.txt')
 writeFileSync(target, `${Array.from({length: 100}, (_, i) => `row ${i + 1}`).join('\n')}\n`)
 const result = await ext.fastRead(work, target, 1, 10)
 expect(resultText(result)).toContain('row 10\n')
 expect(resultText(result)).toContain('[Showing lines 1-10. Use offset=11 to continue.]')
 expect(result.details?.truncation?.truncatedBy).toBe('lines')
})

test('fastRead reports byte-limit truncation across multiple lines', async () => {
 const target = filePath('read-byte-limit.txt')
 const line = `${'z'.repeat(12 * 1024 - 1)}\n`
 writeFileSync(target, line.repeat(10))
 const result = await ext.fastRead(work, target)
 expect(resultText(result)).toContain('[Showing lines 1-4 (48.0KB limit). Use offset=5 to continue.]')
 expect(result.details?.truncation?.truncatedBy).toBe('bytes')
})

test('fastRead handles files without a trailing newline, including a windowed final line', async () => {
 const target = filePath('read-no-trailing-newline.txt')
 writeFileSync(target, 'alpha\nbeta\nlast without newline')
 expect(resultText(await ext.fastRead(work, target))).toBe('alpha\nbeta\nlast without newline')
 expect(resultText(await ext.fastRead(work, target, 3))).toBe('last without newline')
 await expect(ext.fastRead(work, target, 4)).rejects.toThrow(/beyond end of file \(3 lines total\)/)
})

test('fastRead preserves CRLF bytes and reads an empty file as empty text', async () => {
 const crlf = filePath('read-crlf.txt')
 writeFileSync(crlf, 'one\r\ntwo\r\n')
 expect(resultText(await ext.fastRead(work, crlf))).toBe('one\r\ntwo\r\n')

 const empty = filePath('read-empty.txt')
 writeFileSync(empty, '')
 expect(resultText(await ext.fastRead(work, empty))).toBe('')
 await expect(ext.fastRead(work, empty, 2)).rejects.toThrow(/beyond end of file/)
})

test('fastRead agent-skill path returns a full file whose single long line spans scan chunks', async () => {
 const skillDir = join(agentDir, 'skills', 'boundary')
 mkdirSync(skillDir, {recursive: true})
 const target = join(skillDir, 'SKILL.md')
 // 3-byte euro signs guarantee a codepoint straddles the 256KB chunk boundary.
 const content = `${'€'.repeat(120000)}\ntail line\n`
 writeFileSync(target, content)
 expect(resultText(await ext.fastRead(work, target))).toBe(content)
})

test('fastWrite honors TIA_FASTWRITE_FSYNC=1 (durable path stays verified)', async () => {
 const target = filePath('write-fsync.txt')
 process.env.TIA_FASTWRITE_FSYNC = '1'
 try {
  const result = await ext.fastWrite(work, target, 'durable content\n')
  expect(readFileSync(target, 'utf8')).toBe('durable content\n')
  expect(resultText(result)).toContain('verified')
 } finally {
  delete process.env.TIA_FASTWRITE_FSYNC
 }
})

test('fastWrite creates missing parent directories', async () => {
 const target = filePath(join('nested', 'deep', 'write-parents.txt'))
 await ext.fastWrite(work, target, 'nested\n')
 expect(readFileSync(target, 'utf8')).toBe('nested\n')
})

test('concurrent fastWrite calls to one path serialize; the last write wins intact', async () => {
 const target = filePath('write-concurrent.txt')
 const contents = Array.from({length: 5}, (_, i) => `${`payload ${i} `.repeat(2000)}\n`)
 await Promise.all(contents.map(content => ext.fastWrite(work, target, content)))
 expect(readFileSync(target, 'utf8')).toBe(contents[4])
})

test('fastEdit replaces unicode oldText via byte-level matching', async () => {
 const target = filePath('edit-unicode.txt')
 writeFileSync(target, 'prefix — “smart” ∑λ 😄 old-∆-token suffix\n')
 await ext.fastEdit(work, [{path: target, oldText: 'old-∆-token', newText: 'new-Ω-token'}])
 expect(readFileSync(target, 'utf8')).toBe('prefix — “smart” ∑λ 😄 new-Ω-token suffix\n')
})

test('fastEdit rejects an empty oldText on the single-edit fast path', async () => {
 const target = filePath('edit-empty-old.txt')
 writeFileSync(target, 'content\n')
 await expect(ext.fastEdit(work, [{path: target, oldText: '', newText: 'x'}])).rejects.toThrow(/empty oldText/)
})

test('fastEdit performs a verified replacement inside a ~1MB file', async () => {
 const target = filePath('edit-large.txt')
 const filler = `${'lorem ipsum dolor sit amet '.repeat(64)}\n`
 const before = `${filler.repeat(300)}NEEDLE-BLOCK-BEFORE\n${filler.repeat(300)}`
 writeFileSync(target, before)
 await ext.fastEdit(work, [{path: target, oldText: 'NEEDLE-BLOCK-BEFORE', newText: 'NEEDLE-BLOCK-AFTER'}])
 expect(readFileSync(target, 'utf8')).toBe(before.replace('NEEDLE-BLOCK-BEFORE', 'NEEDLE-BLOCK-AFTER'))
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
