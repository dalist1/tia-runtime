import {expect, test} from 'bun:test'
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {resolvePiAi} from './resolve-pi-ai.ts'

function fixture() {
 const work = mkdtempSync(join(tmpdir(), 'tia-pi-dependency-'))
 const scope = join(work, 'node_modules/@earendil-works')
 const pi = join(scope, 'pi-coding-agent')
 mkdirSync(pi, {recursive: true})
 writeFileSync(join(pi, 'package.json'), JSON.stringify({name: '@earendil-works/pi-coding-agent', version: '0.87.1'}))
 const ai = (nested: boolean, version: string) => {
  const directory = nested ? join(pi, 'node_modules/@earendil-works/pi-ai') : join(scope, 'pi-ai')
  mkdirSync(join(directory, 'dist'), {recursive: true})
  writeFileSync(join(directory, 'package.json'), JSON.stringify({name: '@earendil-works/pi-ai', version, type: 'module', exports: {'.': './dist/index.js'}}))
  writeFileSync(join(directory, 'dist/index.js'), 'throw new Error("Resolution must not execute dependency code")')
  return directory
 }
 return {work, pi, ai, cleanup: () => rmSync(work, {recursive: true, force: true})}
}

for (const nested of [false, true])
 test(`resolves the actual ${nested ? 'nested' : 'hoisted'} pi-ai without importing it`, () => {
  const f = fixture()
  try {
   if (nested) f.ai(false, '0.85.1')
   const directory = f.ai(nested, '0.87.1')
   expect(resolvePiAi(f.pi)).toEqual({directory, version: '0.87.1', entry: join(directory, 'dist/index.js')})
  } finally {
   f.cleanup()
  }
 })

test('rejects the resolved version mismatch instead of substituting an unrelated sibling', () => {
 const f = fixture()
 try {
  f.ai(false, '0.87.1')
  f.ai(true, '0.85.1')
  expect(() => resolvePiAi(f.pi)).toThrow('does not match')
 } finally {
  f.cleanup()
 }
})

test('rejects a missing dependency and an invalid caller manifest', () => {
 const f = fixture()
 try {
  expect(() => resolvePiAi(f.pi)).toThrow()
  f.ai(false, '0.87.1')
  writeFileSync(join(f.pi, 'package.json'), JSON.stringify({name: 'unrelated', version: '0.87.1'}))
  expect(() => resolvePiAi(f.pi)).toThrow('Invalid pi package manifest')
 } finally {
  f.cleanup()
 }
})
