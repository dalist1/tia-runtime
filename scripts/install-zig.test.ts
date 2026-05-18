import {expect, test} from 'bun:test'
import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

async function installZigWithFakeTools(unameM: string, unameS: string) {
 const repo = process.cwd()
 const cwd = mkdtempSync(join(tmpdir(), 'tia-install-zig-test-'))
 try {
  const bin = join(cwd, 'bin')
  await Bun.write(join(cwd, 'uname'), `#!/usr/bin/env bash\nif [[ "$1" == "-m" ]]; then echo ${unameM}; else echo ${unameS}; fi\n`)
  await Bun.write(join(cwd, 'curl'), '#!/usr/bin/env bash\nexit 99\n')
  await Bun.write(join(cwd, 'tar'), '#!/usr/bin/env bash\nexit 99\n')
  await Bun.spawn(['chmod', '+x', join(cwd, 'uname'), join(cwd, 'curl'), join(cwd, 'tar')]).exited
  const proc = Bun.spawn(['bash', join(repo, 'scripts/install-zig.sh')], {cwd: repo, env: {...process.env, PATH: `${cwd}:${process.env.PATH ?? ''}`, ZIG_INSTALL_ROOT: join(cwd, 'share'), XDG_BIN_HOME: bin}, stdout: 'pipe', stderr: 'pipe'})
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return {stdout, stderr, exitCode}
 } finally {
  rmSync(cwd, {recursive: true, force: true})
 }
}

test('install-zig resolves pinned macOS and Linux archive platforms before download', async () => {
 for (const [machine, system, platform] of [
  ['arm64', 'Darwin', 'aarch64-macos'],
  ['x86_64', 'Darwin', 'x86_64-macos'],
  ['aarch64', 'Linux', 'aarch64-linux'],
  ['x86_64', 'Linux', 'x86_64-linux']
 ]) {
  const result = await installZigWithFakeTools(machine, system)
  expect(result.exitCode).toBe(99)
  expect(result.stderr).toContain(`zig-${platform}-0.17.0-dev.305+bdfbf432d.tar.xz`)
  expect(result.stderr).not.toContain('Unsupported Zig platform')
 }
})
