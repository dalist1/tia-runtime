import {afterAll, beforeAll, expect, spyOn, test} from 'bun:test'
import * as fs from 'node:fs'
import {chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {referenceRead} from '../bench/tool-read-reference.ts'

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
 await expect(ext.fastRead(work, target, 4)).rejects.toThrow(/beyond end of file \(3 lines total\)/)
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
 const content = `${'€'.repeat(120000)}\ntail line\n`
 writeFileSync(target, content)
 expect(resultText(await ext.fastRead(work, target))).toBe(content)
})

for (const trailingNewline of [false, true]) {
 for (const limitKind of ['lines', 'bytes'] as const) {
  test(`fastRead bounds I/O after ${limitKind} truncation, giant tail newline=${trailingNewline}`, async () => {
   const target = filePath(`read-giant-tail-${limitKind}-${trailingNewline}.txt`)
   const prefix = limitKind === 'lines' ? 'head\n' : `${'x'.repeat(48 * 1024 - 1)}\n`
   writeFileSync(target, prefix + 'z'.repeat(4 * 1024 * 1024) + (trailingNewline ? '\n' : ''))
   const original = fs.readSync
   let bytes = 0
   const spy = spyOn(fs, 'readSync').mockImplementation((...args: any[]) => {
    const count = Reflect.apply(original, fs, args)
    bytes += count
    return count
   })
   try {
    const updates: string[] = []
    const result = await ext.fastRead(work, target, 1, limitKind === 'lines' ? 1 : 2000, undefined, update => updates.push(resultText(update)))
    expect(result.details?.truncation?.truncatedBy).toBe(limitKind)
    expect(resultText(result)).toBe(`${prefix}\n\n[Showing lines 1-1${limitKind === 'bytes' ? ' (48.0KB limit)' : ''}. Use offset=2 to continue.]`)
    expect(updates).toEqual([prefix])
    expect(bytes).toBeLessThanOrEqual(64 * 1024)
   } finally {
    spy.mockRestore()
   }
  })
 }
}

test('fastRead counts an oversized first line without copying its discarded contents', async () => {
 const target = filePath('read-giant-first.txt')
 const length = 4 * 1024 * 1024
 writeFileSync(target, 'z'.repeat(length))
 const original = Buffer.from
 let copied = 0
 const spy = spyOn(Buffer, 'from').mockImplementation((...args: any[]) => {
  if (Buffer.isBuffer(args[0])) copied += args[0].length
  return Reflect.apply(original, Buffer, args)
 })
 try {
  expect(resultText(await ext.fastRead(work, target))).toBe('[Line 1 is 4.0MB, exceeds 50.0KB limit. Use bash for partial reads.]')
  expect(copied).toBeLessThanOrEqual(50 * 1024)
 } finally {
  spy.mockRestore()
 }
})

test('fastRead tolerates short reads splitting UTF-8 and CRLF, including exact EOF limits', async () => {
 const target = filePath('read-short.txt')
 const content = '😄 café\r\n€\nlast λ'
 writeFileSync(target, content)
 const original = fs.readSync
 const spy = spyOn(fs, 'readSync').mockImplementation((...args: any[]) => {
  args[3] = Math.min(args[3], 1)
  return Reflect.apply(original, fs, args)
 })
 try {
  expect(resultText(await ext.fastRead(work, target))).toBe(content)
  expect(resultText(await ext.fastRead(work, target, 3, 1))).toBe('last λ')
  expect(resultText(await ext.fastRead(work, target, 2, 1))).toBe('€\n\n\n[Showing lines 2-2. Use offset=3 to continue.]')
  await expect(ext.fastRead(work, target, 4)).rejects.toThrow('3 lines total')
 } finally {
  spy.mockRestore()
 }
})

test('fastRead never searches the unused scratch-buffer tail on a short read', async () => {
 const target = filePath('read-bounded-scan.txt')
 writeFileSync(target, 'short')
 const original = Buffer.prototype.indexOf
 const lengths: number[] = []
 const spy = spyOn(Buffer.prototype, 'indexOf').mockImplementation(function (this: Buffer, ...args: any[]) {
  if (args[0] === 10) lengths.push(this.length)
  return Reflect.apply(original, this, args)
 })
 try {
  expect(resultText(await ext.fastRead(work, target))).toBe('short')
  expect(lengths).toEqual([5])
 } finally {
  spy.mockRestore()
 }
})

for (const failure of ['abort', 'io-error']) {
 test(`fastRead closes its descriptor after a mid-scan ${failure}`, async () => {
  const target = filePath(`read-${failure}.txt`)
  writeFileSync(target, 'z'.repeat(1024 * 1024))
  const controller = new AbortController()
  const original = fs.readSync
  let descriptor: number | undefined
  const spy = spyOn(fs, 'readSync').mockImplementation((...args: any[]) => {
   descriptor = args[0]
   if (failure === 'io-error') throw new Error('injected I/O failure')
   const count = Reflect.apply(original, fs, args)
   controller.abort()
   return count
  })
  try {
   await expect(ext.fastRead(work, target, undefined, undefined, controller.signal)).rejects.toThrow(failure === 'abort' ? /abort/i : /injected I\/O failure/)
   expect(descriptor).toBeDefined()
   expect(() => fs.fstatSync(descriptor!)).toThrow(/EBADF/)
  } finally {
   spy.mockRestore()
  }
 })
}

test('fastRead distinguishes an exact chunk-boundary EOF from a following omitted line', async () => {
 const target = filePath('read-chunk-eof.txt')
 const content = `${'x'.repeat(32767)}\n`.repeat(8)
 writeFileSync(target, content)
 expect(resultText(await ext.fastRead(work, target, 8, 1))).toBe(`${'x'.repeat(32767)}\n`)
 writeFileSync(target, content + 'tail')
 expect((await ext.fastRead(work, target, 8, 1)).details?.truncation?.truncatedBy).toBe('lines')
})

test('fastRead sees external rewrites and rejects cancelled and missing-file reads', async () => {
 const target = filePath('read-fresh.txt')
 writeFileSync(target, 'before\n')
 expect(resultText(await ext.fastRead(work, target))).toBe('before\n')
 writeFileSync(target, 'after!\n')
 expect(resultText(await ext.fastRead(work, target))).toBe('after!\n')
 await expect(ext.fastRead(work, target, undefined, undefined, AbortSignal.abort())).rejects.toThrow(/abort/i)
 rmSync(target)
 await expect(ext.fastRead(work, target)).rejects.toThrow()
})

test('fastRead matches an independent whole-file reference over 1500 seeded windows', async () => {
 let seed = 0x5eed1234
 const random = (max: number) => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  return seed % max
 }
 const target = filePath('read-random.txt')
 const tokens = ['x', '😄', 'λ', '\r', '€', '\u0000', '\t', 'café']
 for (let i = 0; i < 500; i += 1) {
  const count = random(30)
  const lines = Array.from({length: count}, () => tokens[random(tokens.length)].repeat(random(80)))
  if (count && i % 5 === 0) lines[random(count)] = '€'.repeat(20000 + random(100000))
  const content = lines.join('\n') + (random(2) ? '\n' : '')
  writeFileSync(target, content)
  for (let j = 0; j < 3; j += 1) {
   const offset = 1 + random(count + 3)
   const limit = 1 + random(20)
   let expected: ReturnType<typeof referenceRead>
   try {
    expected = referenceRead(content, offset, limit)
   } catch (error) {
    if (!(error instanceof Error)) throw error
    await expect(ext.fastRead(work, target, offset, limit)).rejects.toThrow(error.message)
    continue
   }
   expect(await ext.fastRead(work, target, offset, limit)).toEqual(expected)
  }
 }
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
