import {afterEach, beforeEach, expect, test} from 'bun:test'
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {fastPatch} from './fast-tools-extension'

let cwd: string
beforeEach(() => {
 cwd = mkdtempSync(join(tmpdir(), 'tia-patch-regression-'))
})
afterEach(() => {
 rmSync(cwd, {recursive: true, force: true})
})
const put = (path: string, content: string) => {
 mkdirSync(dirname(join(cwd, path)), {recursive: true})
 writeFileSync(join(cwd, path), content)
}
const get = (path: string) => readFileSync(join(cwd, path), 'utf8')

test('multi-file patch creates nested parents and commits add/update/delete together', async () => {
 put('existing.txt', 'old\n')
 put('remove.txt', 'gone\n')
 const result = await fastPatch(cwd, '*** Begin Patch\n*** Update File: existing.txt\n@@\n-old\n+new\n*** Add File: new/deep/one.txt\n+one\n*** Add File: new/deep/two.txt\n+two\n*** Delete File: remove.txt\n*** End Patch')
 expect(get('existing.txt')).toBe('new\n')
 expect(get('new/deep/one.txt')).toBe('one\n')
 expect(get('new/deep/two.txt')).toBe('two\n')
 expect(existsSync(join(cwd, 'remove.txt'))).toBe(false)
 expect(result.details).toMatchObject({verified: true, files: 4})
})

test('repeated sections for a file compose in memory before any writes', async () => {
 put('one.txt', 'alpha\nbeta\n')
 await fastPatch(cwd, '*** Begin Patch\n*** Update File: one.txt\n@@\n-alpha\n+ALPHA\n*** Add File: nested/two.txt\n+start\n*** Update File: ./one.txt\n@@\n-beta\n+BETA\n*** Update File: nested/two.txt\n@@\n-start\n+finish\n*** End Patch')
 expect(get('one.txt')).toBe('ALPHA\nBETA\n')
 expect(get('nested/two.txt')).toBe('finish\n')
})

test('a later invalid hunk leaves every earlier file untouched', async () => {
 put('one.txt', 'old\n')
 put('two.txt', 'different\n')
 await expect(fastPatch(cwd, '*** Begin Patch\n*** Update File: one.txt\n@@\n-old\n+new\n*** Add File: nested/new.txt\n+created\n*** Update File: two.txt\n@@\n-missing\n+bad\n*** End Patch')).rejects.toThrow(/two.txt/)
 expect(get('one.txt')).toBe('old\n')
 expect(existsSync(join(cwd, 'nested'))).toBe(false)
})

test('numeric hunks disambiguate repeated lines and insert at the specified position', async () => {
 put('one.txt', 'same\nkeep\nsame\n')
 await fastPatch(cwd, '--- a/one.txt\n+++ b/one.txt\n@@ -3 +3 @@\n-same\n+changed\n')
 expect(get('one.txt')).toBe('same\nkeep\nchanged\n')
 await fastPatch(cwd, '--- a/one.txt\n+++ b/one.txt\n@@ -0,0 +1 @@\n+first\n@@ -2,0 +4 @@\n+middle\n')
 expect(get('one.txt')).toBe('first\nsame\nkeep\nmiddle\nchanged\n')
})

test('apply-patch section anchors narrow repeated bodies', async () => {
 put('one.txt', 'function first() {\n return 1\n}\nfunction second() {\n return 1\n}\n')
 await fastPatch(cwd, '*** Begin Patch\n*** Update File: one.txt\n@@ function second() {\n- return 1\n+ return 2\n*** End Patch')
 expect(get('one.txt')).toBe('function first() {\n return 1\n}\nfunction second() {\n return 2\n}\n')
})

test('exact hunk matches win over whitespace-normalized alternatives', async () => {
 put('one.txt', '  value\nvalue\n')
 await fastPatch(cwd, '*** Begin Patch\n*** Update File: one.txt\n@@\n-value\n+changed\n*** End Patch')
 expect(get('one.txt')).toBe('  value\nchanged\n')
})

test('fuzzy context is retained byte-for-byte rather than rewritten', async () => {
 put('one.txt', '\tcontext — “keep”  \n\told\n\tend\n')
 await fastPatch(cwd, '*** Begin Patch\n*** Update File: one.txt\n@@\n context - "keep"\n-old\n+new\n end\n*** End Patch')
 expect(get('one.txt')).toBe('\tcontext — “keep”  \n\tnew\n\tend\n')
})

test('apply-patch keeps CRLF and the original missing final newline', async () => {
 put('one.txt', 'first\r\nold\r\nlast')
 await fastPatch(cwd, '*** Begin Patch\n*** Update File: one.txt\n@@\n-old\n+new\n*** End Patch')
 expect(get('one.txt')).toBe('first\r\nnew\r\nlast')
})

test('bare patch retains trailing spaces on its final addition', async () => {
 put('one.txt', 'old\n')
 await fastPatch(cwd, '--- a/one.txt\n+++ b/one.txt\n@@ -1 +1 @@\n-old\n+new  ')
 expect(get('one.txt')).toBe('new  \n')
})

test('unified no-newline markers preserve an unterminated replacement and addition', async () => {
 put('one.txt', 'old')
 await fastPatch(cwd, '--- a/one.txt\n+++ b/one.txt\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n--- /dev/null\n+++ b/two.txt\n@@ -0,0 +1 @@\n+added\n\\ No newline at end of file\n')
 expect(get('one.txt')).toBe('new')
 expect(get('two.txt')).toBe('added')
})

test('empty added files and fully deleted contents remain empty', async () => {
 put('one.txt', 'only\n')
 await fastPatch(cwd, '*** Begin Patch\n*** Add File: empty.txt\n*** Update File: one.txt\n@@\n-only\n*** End Patch')
 expect(get('empty.txt')).toBe('')
 expect(get('one.txt')).toBe('')
})

test('header-shaped content inside a numeric hunk is not another file', async () => {
 put('one.txt', '-- old\nkeep\n')
 await fastPatch(cwd, '--- a/one.txt\n+++ b/one.txt\n@@ -1,2 +1,2 @@\n--- old\n+++ new\n keep\n--- /dev/null\n+++ b/two.txt\n@@ -0,0 +1 @@\n+two\n')
 expect(get('one.txt')).toBe('++ new\nkeep\n')
 expect(get('two.txt')).toBe('two\n')
})

test('pure addition apply-patch hunk appends without an ambiguous empty search', async () => {
 put('one.txt', 'first\n')
 await fastPatch(cwd, '*** Begin Patch\n*** Update File: one.txt\n@@\n+last\n*** End Patch')
 expect(get('one.txt')).toBe('first\nlast\n')
})

test('truncated numeric hunks are rejected before writing', async () => {
 put('one.txt', 'old\nkeep\n')
 await expect(fastPatch(cwd, '--- a/one.txt\n+++ b/one.txt\n@@ -1,2 +1,2 @@\n-old\n+new\n')).rejects.toThrow(/count|truncated/i)
 expect(get('one.txt')).toBe('old\nkeep\n')
})

test('a stale unified delete is not allowed to remove a changed file', async () => {
 put('one.txt', 'external change\n')
 await expect(fastPatch(cwd, '--- a/one.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n')).rejects.toThrow()
 expect(get('one.txt')).toBe('external change\n')
})

test('timestamped and git-quoted paths resolve to actual files', async () => {
 put('space name.txt', 'old\n')
 put('tab\tname.txt', 'old\n')
 await fastPatch(cwd, '--- a/space name.txt\t2026-01-01 00:00:00\n+++ b/space name.txt\t2026-01-02 00:00:00\n@@ -1 +1 @@\n-old\n+new\n--- "a/tab\\tname.txt"\n+++ "b/tab\\tname.txt"\n@@ -1 +1 @@\n-old\n+new\n')
 expect(get('space name.txt')).toBe('new\n')
 expect(get('tab\tname.txt')).toBe('new\n')
})

test('move operations retain executable mode and refuse to overwrite a destination', async () => {
 put('old.sh', 'old\n')
 chmodSync(join(cwd, 'old.sh'), 0o751)
 await fastPatch(cwd, '*** Begin Patch\n*** Update File: old.sh\n*** Move to: nested/new.sh\n@@\n-old\n+new\n*** End Patch')
 expect(get('nested/new.sh')).toBe('new\n')
 expect(statSync(join(cwd, 'nested/new.sh')).mode & 0o777).toBe(0o751)
 expect(existsSync(join(cwd, 'old.sh'))).toBe(false)
 put('occupied.sh', 'keep\n')
 await expect(fastPatch(cwd, '*** Begin Patch\n*** Update File: nested/new.sh\n*** Move to: occupied.sh\n@@\n-new\n+gone\n*** End Patch')).rejects.toThrow(/already exists/)
 expect(get('nested/new.sh')).toBe('new\n')
 expect(get('occupied.sh')).toBe('keep\n')
})

test('unsupported git metadata cannot be silently skipped in a multi-file diff', async () => {
 put('one.txt', 'old\n')
 const update = 'diff --git a/one.txt b/one.txt\n--- a/one.txt\n+++ b/one.txt\n@@ -1 +1 @@\n-old\n+new\n'
 for (const unsupported of ['diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt\n', 'diff --git a/empty.txt b/empty.txt\nnew file mode 100644\nindex 0000000..e69de29\n', 'diff --git a/image.png b/image.png\nBinary files a/image.png and b/image.png differ\n']) {
  await expect(fastPatch(cwd, unsupported + update)).rejects.toThrow(/not supported/)
  await expect(fastPatch(cwd, update + unsupported)).rejects.toThrow(/not supported/)
  expect(get('one.txt')).toBe('old\n')
 }
})

test('git-generated multi-file patches reproduce exact expected bytes over 80 seeded cases', async () => {
 let seed = 0x5eed1234
 const random = (max: number) => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  return seed % max
 }
 const tokens = ['same', '', '  indent', '\ttab', 'café 😄', '-- header', '++ header', 'trailing  ']
 for (let iteration = 0; iteration < 80; iteration += 1) {
  const root = join(cwd, String(iteration))
  const beforeDir = join(root, 'before')
  const afterDir = join(root, 'after')
  mkdirSync(beforeDir, {recursive: true})
  mkdirSync(afterDir, {recursive: true})
  const expected = new Map<string, string>()
  for (const name of ['one.txt', 'space name.txt', 'café.txt']) {
   const lines = Array.from({length: 5 + random(35)}, () => tokens[random(tokens.length)])
   const newline = iteration % 3 === 0 ? '\r\n' : '\n'
   const before = lines.join(newline) + (iteration % 2 ? newline : '')
   lines.splice(random(lines.length), random(3), `inserted-${iteration}`, tokens[random(tokens.length)])
   lines.splice(random(lines.length), 0, `extra-${iteration}`)
   const after = lines.join(newline) + (iteration % 4 ? newline : '')
   writeFileSync(join(beforeDir, name), before)
   writeFileSync(join(afterDir, name), after)
   expected.set(name, after)
  }
  const diff = Bun.spawnSync(['git', 'diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', 'before', 'after'], {cwd: root, stdout: 'pipe', stderr: 'pipe', env: {...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null'}})
  expect(diff.exitCode).toBe(1)
  const patch = diff.stdout.toString().replace(/([ab])\/(?:before|after)\//g, '$1/')
  try {
   await fastPatch(beforeDir, patch)
  } catch (error) {
   throw new Error(`Git fixture ${iteration}:\n${patch}`, {cause: error})
  }
  for (const [name, content] of expected) expect(readFileSync(join(beforeDir, name), 'utf8')).toBe(content)
 }
})

test('concurrent patches sharing paths serialize their entire planning and commit', async () => {
 put('one.txt', 'alpha\nbeta\n')
 put('two.txt', 'alpha\nbeta\n')
 await Promise.all(['alpha', 'beta'].map((word, index) => fastPatch(cwd, `*** Begin Patch\n*** Update File: ${index ? 'two' : 'one'}.txt\n@@\n-${word}\n+${word.toUpperCase()}\n*** Update File: ${index ? 'one' : 'two'}.txt\n@@\n-${word}\n+${word.toUpperCase()}\n*** End Patch`)))
 expect(get('one.txt')).toBe('ALPHA\nBETA\n')
 expect(get('two.txt')).toBe('ALPHA\nBETA\n')
})
