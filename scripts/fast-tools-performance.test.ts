import {expect, spyOn, test} from 'bun:test'
import {mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {combinedEditDiff, planOptimizedBash, renderEditDiff, withFileMutationQueues} from './fast-tools-extension'

test('collapsed diff rendering matches the full-render reference without styling omitted lines', () => {
 for (const count of [1, 9, 10, 11, 100, 10000]) {
  for (const trailing of ['', '\n']) {
   const diff = Array.from({length: count}, (_, i) => `${['-', '+', ' ', '---', '+++'][i % 5]}${i} café😄`).join('\n') + trailing
   let calls = 0
   const theme = {
    fg: (role: string, text: string) => {
     calls++
     return `<${role}>${text}</${role}>`
    }
   }
   const full = diff.split('\n').map(line => theme.fg(line.startsWith('-') && !line.startsWith('---') ? 'toolDiffRemoved' : line.startsWith('+') && !line.startsWith('+++') ? 'toolDiffAdded' : 'toolDiffContext', line))
   const expected = full.slice(0, 10).join('\n') + (full.length > 10 ? theme.fg('muted', `\n... (${full.length - 10} more lines, ctrl+o to expand)`) : '')
   calls = 0
   expect(renderEditDiff(diff, false, theme)).toBe(expected)
   expect(calls).toBeLessThanOrEqual(11)
   expect(renderEditDiff(diff, true, theme)).toBe(full.join('\n'))
  }
 }
})

test('native string comparisons preserve generic diff results for Unicode, long lines and EOF changes', () => {
 const same = 'same café😄'.repeat(10000)
 const base = {path: 'file.txt', absolutePath: '/file.txt', editCount: 1}
 expect(combinedEditDiff([{...base, before: `${same}\nold\n${same}\n`, after: `${same}\nnew\n${same}\n`}])).toBe(` 1 ${same}\n-2 old\n+2 new\n 3 ${same}`)
 expect(combinedEditDiff([{...base, before: 'a\r\nb\r\n', after: 'a\r\nc\r\n'}])).toBe(' 1 a\r\n-2 b\r\n+2 c\r')
 expect(combinedEditDiff([{...base, before: 'one\ntwo', after: 'one\nTHREE'}])).toBe(' 1 one\n-2 two\n+2 THREE')
})

test('small file chains stay in process while large files retain native helpers', async () => {
 const cwd = mkdtempSync(join(tmpdir(), 'tia-inline-files-'))
 const previous = process.env.PI_CODING_AGENT_DIR
 const calls: string[][] = []
 const spawn = Bun.spawn
 let spy: {mockRestore(): void} | undefined
 try {
  const agent = join(cwd, 'agent')
  mkdirSync(join(agent, 'fast-tools'), {recursive: true})
  symlinkSync(Bun.which('cp')!, join(agent, 'fast-tools/fastcopy'))
  symlinkSync(Bun.which('cat')!, join(agent, 'fast-tools/fastdrain'))
  process.env.PI_CODING_AGENT_DIR = agent
  spy = spyOn(Bun, 'spawn').mockImplementation((...args: any[]) => {
   calls.push(args[0])
   return Reflect.apply(spawn, Bun, args)
  })
  for (const size of [0, 1024, 256 * 1024, 256 * 1024 + 1]) {
   const contents = 'a'.repeat(size)
   writeFileSync(join(cwd, 'source'), contents)
   calls.length = 0
   const steps = planOptimizedBash(cwd, 'cp source copy && cat copy > /dev/null')
   expect(steps).not.toBeNull()
   for (const step of steps!) await step.run()
   expect(readFileSync(join(cwd, 'copy'), 'utf8')).toBe(contents)
   expect(calls.length).toBe(size > 256 * 1024 ? 2 : 0)
  }
 } finally {
  spy?.mockRestore()
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = previous
  rmSync(cwd, {recursive: true, force: true})
 }
})

test('group reservations serialize overlapping and symlink-aliased mutations without blocking disjoint work', async () => {
 const cwd = mkdtempSync(join(tmpdir(), 'tia-group-queues-'))
 try {
  for (let i = 0; i < 5; i++) writeFileSync(join(cwd, `${i}`), '')
  symlinkSync('0', join(cwd, 'alias'))
  let release = () => {}
  const barrier = new Promise<void>(resolve => {
   release = resolve
  })
  const holding = withFileMutationQueues([join(cwd, '0')], () => barrier)
  const active = new Set<number>()
  const last = new Map<number, number>()
  const pending = Array.from({length: 80}, (_, index) => {
   const keys = [...new Set([index % 5, (index + 2) % 5])]
   const paths = keys.map(key => join(cwd, key === 0 && index % 2 ? 'alias' : String(key)))
   return withFileMutationQueues(paths, async () => {
    for (const key of keys) {
     expect(active.has(key)).toBe(false)
     expect(last.get(key) ?? -1).toBeLessThan(index)
     active.add(key)
     last.set(key, index)
    }
    await Bun.sleep(0)
    for (const key of keys) active.delete(key)
   })
  })
  expect(await withFileMutationQueues([join(cwd, 'disjoint')], async () => 'ran')).toBe('ran')
  release()
  await Promise.all([holding, ...pending])
  expect(active.size).toBe(0)
  await expect(
   withFileMutationQueues([join(cwd, '0'), join(cwd, '1')], async () => {
    throw new Error('release me')
   })
  ).rejects.toThrow('release me')
  expect(await withFileMutationQueues([join(cwd, 'alias'), join(cwd, '1')], async () => 'released')).toBe('released')
 } finally {
  rmSync(cwd, {recursive: true, force: true})
 }
})
