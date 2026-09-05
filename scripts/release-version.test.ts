import {expect, test} from 'bun:test'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'

test('release version and optimization marker stay consistent across metadata and bootstrap', () => {
 const root = join(import.meta.dir, '..')
 const read = (path: string) => readFileSync(join(root, path), 'utf8')
 const version = JSON.parse(read('package.json')).version
 const marker = read('OPTIMIZATION_VERSION').trim()
 expect(version).toMatch(/^\d+\.\d+\.\d+$/)
 expect(read('RELEASE.md').match(/^## v(.+)$/m)?.[1]).toBe(version)
 expect(read('scripts/install-tia.sh')).toContain(`TIA_OPTIMIZATION_VERSION="\${TIA_OPTIMIZATION_VERSION:-${marker}}"`)
 for (const path of ['README.md', 'RELEASE.md', 'BENCHMARKS.md']) {
  expect(read(path)).toContain(`v${version}`)
  expect(read(path)).toContain(marker)
 }
})
