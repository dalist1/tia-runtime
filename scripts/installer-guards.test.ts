import {expect, test} from 'bun:test'
import {mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'

for (const scenario of ['invalid', 'missing', 'symlink'])
 test(`local-tool preservation rejects ${scenario} before changing installed assets`, () => {
  const home = mkdtempSync(join(tmpdir(), 'tia-installer-guard-'))
  const root = join(home, 'runtime')
  try {
   mkdirSync(join(root, 'bin'), {recursive: true})
   mkdirSync(join(root, 'pi-agent/extensions'), {recursive: true})
   writeFileSync(join(root, 'bin/pi'), 'previous binary')
   const source = join(home, 'user-extension.ts')
   writeFileSync(source, 'user-owned source')
   if (scenario === 'symlink') symlinkSync(source, join(root, 'pi-agent/extensions/fast-tools.ts'))
   const result = Bun.spawnSync(['bash', resolve(import.meta.dir, 'install-tia.sh'), 'install'], {
    env: {HOME: home, PATH: process.env.PATH ?? '', TIA_ROOT: root, TIA_PRESERVE_FAST_TOOLS: scenario === 'invalid' ? 'yes' : '1', PI_TELEMETRY: '0', PI_OFFLINE: '1', DO_NOT_TRACK: '1'},
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 10000
   })
   expect(result.exitCode).toBe(1)
   expect(result.stderr.toString()).toContain(scenario === 'invalid' ? 'must be 0 or 1' : 'requires an existing regular')
   expect(readFileSync(join(root, 'bin/pi'), 'utf8')).toBe('previous binary')
   expect(readFileSync(source, 'utf8')).toBe('user-owned source')
  } finally {
   rmSync(home, {recursive: true, force: true})
  }
 })
