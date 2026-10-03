import {afterEach, beforeEach, expect, spyOn, test} from 'bun:test'
import * as fs from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import extension, {fastEdit, fastPatch, fastRead, fastWrite, planOptimizedBash} from './fast-tools-extension'

let cwd: string
beforeEach(() => {
 cwd = fs.mkdtempSync(join(tmpdir(), 'tia-tool-safety-'))
})
afterEach(() => {
 fs.rmSync(cwd, {recursive: true, force: true})
})
const put = (name: string, content: string) => fs.writeFileSync(join(cwd, name), content)
const get = (name: string) => fs.readFileSync(join(cwd, name), 'utf8')

for (const failure of ['partial-write', 'verification', 'rename', 'abort'] as const) {
 test(`single edit keeps original bytes and cleans temporary files after ${failure}`, async () => {
  put('one.txt', 'old\n')
  const controller = new AbortController()
  const write = fs.writeSync
  const read = fs.readSync
  let spy: {mockRestore(): void}
  if (failure === 'partial-write')
   spy = spyOn(fs, 'writeSync').mockImplementation((...args: any[]) => {
    Reflect.apply(write, fs, [args[0], args[1], args[2], 1])
    throw new Error('injected partial write')
   })
  else if (failure === 'verification')
   spy = spyOn(fs, 'readSync').mockImplementation((...args: any[]) => {
    const count = Reflect.apply(read, fs, args)
    if (count) args[1][args[2]] ^= 1
    return count
   })
  else if (failure === 'rename')
   spy = spyOn(fs, 'renameSync').mockImplementation(() => {
    throw new Error('injected rename failure')
   })
  else
   spy = spyOn(fs, 'writeSync').mockImplementation((...args: any[]) => {
    const count = Reflect.apply(write, fs, args)
    controller.abort()
    return count
   })
  try {
   await expect(fastEdit(cwd, [{path: 'one.txt', oldText: 'old', newText: 'new'}], controller.signal)).rejects.toThrow()
  } finally {
   spy.mockRestore()
  }
  expect(get('one.txt')).toBe('old\n')
  expect(fs.readdirSync(cwd)).toEqual(['one.txt'])
 })
}

test('multi-file failure restores updated/deleted bytes, executable mode, symlinks and new directories', async () => {
 put('one.sh', 'old\n')
 put('delete.sh', 'deleted\n')
 put('target.txt', 'target\n')
 fs.chmodSync(join(cwd, 'delete.sh'), 0o751)
 fs.symlinkSync('target.txt', join(cwd, 'link.txt'))
 const rename = fs.renameSync
 const spy = spyOn(fs, 'renameSync').mockImplementation((...args: any[]) => {
  if (args[1] === join(cwd, 'nested/fail.txt')) throw new Error('injected rename failure')
  return Reflect.apply(rename, fs, args)
 })
 try {
  await expect(fastPatch(cwd, '*** Begin Patch\n*** Update File: one.sh\n@@\n-old\n+new\n*** Delete File: delete.sh\n*** Delete File: link.txt\n*** Add File: nested/ok.txt\n+ok\n*** Add File: nested/fail.txt\n+failure\n*** End Patch')).rejects.toThrow('injected rename failure')
 } finally {
  spy.mockRestore()
 }
 expect(get('one.sh')).toBe('old\n')
 expect(get('delete.sh')).toBe('deleted\n')
 expect(fs.statSync(join(cwd, 'delete.sh')).mode & 0o777).toBe(0o751)
 expect(fs.readlinkSync(join(cwd, 'link.txt'))).toBe('target.txt')
 expect(get('target.txt')).toBe('target\n')
 expect(fs.existsSync(join(cwd, 'nested'))).toBe(false)
})

test('cancel after the first committed file rolls back the whole batch', async () => {
 put('one.txt', 'old\n')
 put('two.txt', 'old\n')
 const controller = new AbortController()
 const rename = fs.renameSync
 const spy = spyOn(fs, 'renameSync').mockImplementation((...args: any[]) => {
  Reflect.apply(rename, fs, args)
  controller.abort()
 })
 try {
  await expect(fastPatch(cwd, '*** Begin Patch\n*** Update File: one.txt\n@@\n-old\n+new\n*** Update File: two.txt\n@@\n-old\n+new\n*** End Patch', controller.signal)).rejects.toThrow(/aborted/)
 } finally {
  spy.mockRestore()
 }
 expect(get('one.txt')).toBe('old\n')
 expect(get('two.txt')).toBe('old\n')
})

test('zero-progress writes fail without hanging or modifying the destination', async () => {
 put('one.txt', 'old\n')
 const spy = spyOn(fs, 'writeSync').mockReturnValue(0)
 try {
  await expect(fastWrite(cwd, 'one.txt', 'new\n')).rejects.toThrow('no progress')
 } finally {
  spy.mockRestore()
 }
 expect(get('one.txt')).toBe('old\n')
})

test('overlapping occurrences are ambiguous in both exact-edit paths', async () => {
 put('one.txt', 'aaa\nend\n')
 for (const edits of [
  [{path: 'one.txt', oldText: 'aa', newText: 'b'}],
  [
   {path: 'one.txt', oldText: 'aa', newText: 'b'},
   {path: 'one.txt', oldText: 'end', newText: 'END'}
  ]
 ]) {
  await expect(fastEdit(cwd, edits)).rejects.toThrow(/matched 2 places/)
 }
 expect(get('one.txt')).toBe('aaa\nend\n')
})

test('read rejects invalid windows rather than returning an unusable continuation', async () => {
 put('one.txt', 'hello\n')
 for (const value of [0, -1, 1.5, NaN, Infinity]) {
  await expect(fastRead(cwd, 'one.txt', value)).rejects.toThrow(/positive integer/)
  await expect(fastRead(cwd, 'one.txt', 1, value)).rejects.toThrow(/positive integer/)
 }
})

function registeredTools() {
 const tools = new Map<string, any>()
 Reflect.apply(extension, undefined, [{registerTool: (tool: any) => tools.set(tool.name, tool)}])
 return tools
}

test('registered read delegates images, including extensionless files, to stock image handling', async () => {
 const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
 fs.writeFileSync(join(cwd, 'image'), image)
 const result = await registeredTools().get('read').execute('image', {path: 'image'}, undefined, undefined, {cwd})
 expect(
  result.content.some((block: any) => block.type === 'image' && block.mimeType === 'image/png'),
  JSON.stringify(result)
 ).toBe(true)
})

test('registered edit rejects mixed patch and exact arguments instead of silently ignoring them', async () => {
 await expect(registeredTools().get('edit').execute('mixed', {patch: '*** Begin Patch\n*** Add File: one.txt\n+new\n*** End Patch', path: 'ignored.txt'}, undefined, undefined, {cwd})).rejects.toThrow('mutually exclusive')
 expect(fs.readdirSync(cwd)).toEqual([])
})

test('multi-edits through a symlink and its target share the mutation queue', async () => {
 put('target.txt', 'alpha beta one two\n')
 fs.symlinkSync('target.txt', join(cwd, 'link.txt'))
 await Promise.all([
  fastEdit(cwd, [
   {path: 'link.txt', oldText: 'alpha', newText: 'ALPHA'},
   {path: 'link.txt', oldText: 'one', newText: 'ONE'}
  ]),
  fastEdit(cwd, [
   {path: 'target.txt', oldText: 'beta', newText: 'BETA'},
   {path: 'target.txt', oldText: 'two', newText: 'TWO'}
  ])
 ])
 expect(get('target.txt')).toBe('ALPHA BETA ONE TWO\n')
 expect(fs.readlinkSync(join(cwd, 'link.txt'))).toBe('target.txt')
})

test('a batch naming a file through two aliases fails before either write', async () => {
 put('target.txt', 'alpha\nbeta\n')
 fs.symlinkSync('target.txt', join(cwd, 'link.txt'))
 await expect(fastPatch(cwd, '*** Begin Patch\n*** Update File: target.txt\n@@\n-alpha\n+ALPHA\n*** Update File: link.txt\n@@\n-beta\n+BETA\n*** End Patch')).rejects.toThrow('refer to the same file')
 expect(get('target.txt')).toBe('alpha\nbeta\n')
})

test('registered bash honors explicit timeouts through the stock execution path', async () => {
 const result = await registeredTools().get('bash').execute('timeout', {command: 'printf timeout-check', timeout: 5}, undefined, undefined, {cwd})
 expect(result.content[0].text).toContain('timeout-check')
 await expect(registeredTools().get('bash').execute('cancelled', {command: 'sleep 5', timeout: 0.02}, undefined, undefined, {cwd})).rejects.toThrow(/timed out/)
})

test('durable writes surface fsync errors rather than claiming success', async () => {
 put('one.txt', 'old\n')
 const previous = process.env.TIA_FASTWRITE_FSYNC
 process.env.TIA_FASTWRITE_FSYNC = '1'
 const spy = spyOn(fs, 'fsyncSync').mockImplementation(() => {
  throw new Error('injected durability failure')
 })
 try {
  await expect(fastWrite(cwd, 'one.txt', 'new\n')).rejects.toThrow('durability failure')
 } finally {
  spy.mockRestore()
  if (previous === undefined) delete process.env.TIA_FASTWRITE_FSYNC
  else process.env.TIA_FASTWRITE_FSYNC = previous
 }
 expect(get('one.txt')).toBe('old\n')
})

test('shell fast path declines malformed, state-dependent, and same-inode commands', () => {
 put('one.txt', 'payload\n')
 fs.linkSync(join(cwd, 'one.txt'), join(cwd, 'hardlink.txt'))
 fs.symlinkSync('one.txt', join(cwd, 'symlink.txt'))
 for (const command of [
  'cp one.txt one.txt',
  'cp one.txt hardlink.txt',
  'cp one.txt symlink.txt',
  'cp one.txt missing/two.txt',
  'rm one.txt && rm one.txt',
  'rm one.txt && cat one.txt > /dev/null',
  'rm one.txt && cp one.txt two.txt',
  'rm one.txt &&',
  '&& rm one.txt',
  'rm one.txt\n',
  'rm #comment',
  'cat ~someone/file > /dev/null'
 ]) {
  expect(planOptimizedBash(cwd, command), command).toBeNull()
 }
 expect(get('one.txt')).toBe('payload\n')
})

test('shell fast-path copy preserves modes and does not strip @ from literal filenames', async () => {
 put('@source', 'payload\n')
 put('existing', 'old\n')
 fs.chmodSync(join(cwd, '@source'), 0o751)
 fs.chmodSync(join(cwd, 'existing'), 0o600)
 const steps = planOptimizedBash(cwd, 'cp @source fresh && cp @source existing && cat fresh > /dev/null && rm fresh')
 expect(steps).not.toBeNull()
 for (const step of steps!) await step.run()
 expect(get('existing')).toBe('payload\n')
 expect(fs.statSync(join(cwd, 'existing')).mode & 0o777).toBe(0o600)
 expect(fs.existsSync(join(cwd, 'fresh'))).toBe(false)
})
