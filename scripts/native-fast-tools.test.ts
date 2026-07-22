import {expect, test} from 'bun:test'
import {mkdirSync, mkdtempSync, rmSync} from 'node:fs'
import {readFile, stat, writeFile} from 'node:fs/promises'
import {homedir, tmpdir} from 'node:os'
import {join} from 'node:path'

async function run(command: string[], cwd: string, input?: string) {
 const proc = Bun.spawn(command, {cwd, stdin: input === undefined ? 'ignore' : 'pipe', stdout: 'pipe', stderr: 'pipe'})
 if (input !== undefined) {
  if (!proc.stdin) throw new Error('stdin pipe unavailable')
  await proc.stdin.write(input)
  proc.stdin.end()
 }
 const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
 return {stdout, stderr, exitCode}
}

test('active C fastread and Zig fastedit helpers build and run', async () => {
 const repo = process.cwd()
 const cwd = mkdtempSync(join(tmpdir(), 'tia-native-fast-tools-test-'))
 try {
  const fasteditSource = await readFile(join(repo, 'native/fastedit.zig'), 'utf8')
  expect(fasteditSource).not.toContain('std.os.linux')

  const outDir = join(cwd, 'bin')
  mkdirSync(outDir)
  const readBuild = await run(['zig', 'cc', '-O3', '-pipe', '-s', '-o', join(outDir, 'fastread-window'), join(repo, 'native/fastread-window.c')], repo)
  expect(readBuild.exitCode, readBuild.stderr).toBe(0)
  const editBuild = await run(['zig', 'build-exe', '-O', 'ReleaseFast', '-fstrip', '--cache-dir', join(cwd, 'zig-cache'), '--global-cache-dir', join(homedir(), '.cache', 'zig'), join(repo, 'native/fastedit.zig'), '-femit-bin=' + join(outDir, 'fastedit')], repo)
  expect(editBuild.exitCode, editBuild.stderr).toBe(0)

  await writeFile(join(cwd, 'read.txt'), 'alpha\nbeta\ngamma\n')
  const readResult = await run([join(outDir, 'fastread-window'), 'read.txt', '2', '2'], cwd)
  expect(readResult.exitCode, readResult.stderr).toBe(0)
  expect(readResult.stdout).toBe('beta\ngamma\n')

  await writeFile(join(cwd, 'target.txt'), 'hello old world\n')
  await writeFile(join(cwd, 'old.txt'), 'old')
  await writeFile(join(cwd, 'new.txt'), 'new')
  const editResult = await run([join(outDir, 'fastedit'), 'target.txt', 'old.txt', 'new.txt'], cwd)
  expect(editResult.exitCode, editResult.stderr).toBe(0)
  expect(editResult.stdout).toBe('{"ok":true,"bytes":16}\n')
  expect(await readFile(join(cwd, 'target.txt'), 'utf8')).toBe('hello new world\n')

  await writeFile(join(cwd, 'target.txt'), 'old old\n')
  const duplicateResult = await run([join(outDir, 'fastedit'), 'target.txt', 'old.txt', 'new.txt'], cwd)
  expect(duplicateResult.exitCode).not.toBe(0)
  expect(duplicateResult.stderr).toContain('oldText not unique')

  await writeFile(join(cwd, 'exec.sh'), 'run old script\n')
  await run(['chmod', '755', join(cwd, 'exec.sh')], cwd)
  const modeResult = await run([join(outDir, 'fastedit'), 'exec.sh', 'old.txt', 'new.txt'], cwd)
  expect(modeResult.exitCode, modeResult.stderr).toBe(0)
  const modeStat = await stat(join(cwd, 'exec.sh'))
  expect(modeStat.mode & 0o777).toBe(0o755)
 } finally {
  rmSync(cwd, {recursive: true, force: true})
 }
}, 180000)
