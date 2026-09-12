import {expect, test} from 'bun:test'
import {mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {buildPi, compileOptions, smokeBinary, snapshotPackage} from './build-pi.ts'

test('build controls are independent and reject ambiguous environment values', () => {
 expect(compileOptions({})).toEqual({minify: {syntax: true, whitespace: true, identifiers: true}, bytecode: false})
 for (const name of ['TIA_PI_MINIFY_SYNTAX', 'TIA_PI_MINIFY_WHITESPACE', 'TIA_PI_MINIFY_IDENTIFIERS', 'TIA_PI_BYTECODE']) expect(() => compileOptions({[name]: 'yes'})).toThrow('0 or 1')
 expect(compileOptions({TIA_PI_MINIFY_IDENTIFIERS: '0', TIA_PI_BYTECODE: '1'})).toEqual({minify: {syntax: true, whitespace: true, identifiers: false}, bytecode: true})
})

function fixture() {
 const work = mkdtempSync(join(tmpdir(), 'tia-build-pi-'))
 const pkg = join(work, 'pi-package')
 const jiti = join(pkg, 'node_modules/jiti')
 mkdirSync(join(pkg, 'dist/bun'), {recursive: true})
 mkdirSync(join(jiti, 'lib'), {recursive: true})
 writeFileSync(join(pkg, 'package.json'), JSON.stringify({name: '@earendil-works/pi-coding-agent', version: '9.8.7'}))
 writeFileSync(join(jiti, 'package.json'), JSON.stringify({name: 'jiti', version: '2.7.0', type: 'module', exports: {'.': './lib/jiti.mjs', './static': './lib/jiti-static.mjs'}}))
 writeFileSync(join(jiti, 'lib/jiti.mjs'), 'export function createJiti() { return "fixture"; }')
 writeFileSync(join(jiti, 'lib/jiti-static.mjs'), 'export {createJiti} from "./jiti.mjs";')
 const entry = join(pkg, 'dist/bun/cli.js')
 writeFileSync(entry, 'import {createJiti} from "jiti/static"; console.log(process.argv.includes("--version") ? "9.8.7" : createJiti());')
 const output = join(work, 'bin/pi')
 const runtime = join(work, 'runtime')
 return {work, pkg, jiti, entry, output, runtime, cleanup: () => rmSync(work, {recursive: true, force: true})}
}

async function outputOf(binary: string) {
 const child = Bun.spawn([binary], {stdout: 'pipe', stderr: 'pipe', env: {PATH: process.env.PATH ?? ''}})
 const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
 expect(code, stderr).toBe(0)
 return stdout.trim()
}

test('lazy build snapshots its dependency and keeps old binaries usable after source upgrades', async () => {
 const f = fixture()
 try {
  const first = await buildPi(f.pkg, f.output, f.runtime)
  expect(first.rewrittenImports).toBe(1)
  expect(first.companion?.version).toBe('2.7.0')
  expect(await outputOf(f.output)).toBe('fixture')
  writeFileSync(join(f.jiti, 'lib/jiti.mjs'), 'export function createJiti() { return "upgraded"; }')
  const secondOutput = join(f.work, 'bin/next')
  const second = await buildPi(f.pkg, secondOutput, f.runtime)
  expect(second.companion?.sha256).not.toBe(first.companion?.sha256)
  expect(await outputOf(secondOutput)).toBe('upgraded')
  expect(await outputOf(f.output)).toBe('fixture')
  expect(readdirSync(join(f.work, 'bin')).some(name => name.startsWith('.pi-build-'))).toBe(false)
 } finally {
  f.cleanup()
 }
}, 30000)

test('stock build escape hatch remains self-contained', async () => {
 const f = fixture()
 try {
  const result = await buildPi(f.pkg, f.output, f.runtime, 'bundled')
  expect(result.companion).toBeUndefined()
  expect(result.rewrittenImports).toBe(0)
  rmSync(f.jiti, {recursive: true})
  expect(await outputOf(f.output)).toBe('fixture')
 } finally {
  f.cleanup()
 }
}, 30000)

for (const failure of ['compile', 'smoke', 'upstream-shape', 'dependency-closure']) {
 test(`failed ${failure} preserves the previous binary and cleans staging`, async () => {
  const f = fixture()
  try {
   mkdirSync(join(f.work, 'bin'))
   writeFileSync(f.output, 'previous binary')
   const entry = readFileSync(f.entry, 'utf8')
   if (failure === 'dependency-closure') {
    const manifest = JSON.parse(readFileSync(join(f.jiti, 'package.json'), 'utf8'))
    manifest.dependencies = {unexpected: '1.0.0'}
    writeFileSync(join(f.jiti, 'package.json'), JSON.stringify(manifest))
   }
   writeFileSync(f.entry, failure === 'compile' ? 'this is invalid JavaScript {' : failure === 'smoke' ? entry.replace('9.8.7', 'wrong-version') : failure === 'upstream-shape' ? entry.replace('jiti/static', 'jiti') : entry)
   await expect(buildPi(f.pkg, f.output, f.runtime)).rejects.toThrow(failure === 'dependency-closure' ? 'dependency closure' : undefined)
   expect(readFileSync(f.output, 'utf8')).toBe('previous binary')
   expect(readdirSync(join(f.work, 'bin'))).toEqual(['pi'])
  } finally {
   f.cleanup()
  }
 }, 30000)
}

test('companion reuse is byte-verified and rejects corruption and symlinks', () => {
 const f = fixture()
 try {
  const first = snapshotPackage(f.jiti, f.runtime)
  expect(snapshotPackage(f.jiti, f.runtime)).toEqual(first)
  writeFileSync(join(first.directory, 'lib/jiti.mjs'), 'corrupt')
  expect(() => snapshotPackage(f.jiti, f.runtime)).toThrow('verification failed')
  rmSync(first.directory, {recursive: true})
  symlinkSync(f.jiti, first.directory, 'dir')
  expect(() => snapshotPackage(f.jiti, f.runtime)).toThrow('verification failed')
  expect(readdirSync(f.runtime).some(name => name.startsWith('.jiti-stage-'))).toBe(false)
 } finally {
  f.cleanup()
 }
})

test('non-minified build controls retain smoke validation and record effective choices', async () => {
 const f = fixture()
 try {
  const options = compileOptions({TIA_PI_MINIFY_SYNTAX: '0', TIA_PI_MINIFY_IDENTIFIERS: '0', TIA_PI_MINIFY_WHITESPACE: '0'})
  const result = await buildPi(f.pkg, f.output, f.runtime, 'lazy-jiti', options)
  expect(result.options).toEqual(options)
  expect(await outputOf(f.output)).toBe('fixture')
 } finally {
  f.cleanup()
 }
}, 30000)

test('compiled smoke check kills a hung child on its deadline', async () => {
 const f = fixture()
 try {
  writeFileSync(f.entry, 'setInterval(() => {}, 1000)')
  const result = await Bun.build({entrypoints: [f.entry], compile: {outfile: f.output}})
  expect(result.success).toBe(true)
  await expect(smokeBinary(f.output, f.pkg, f.work, '9.8.7', 100)).rejects.toThrow('timeout')
 } finally {
  f.cleanup()
 }
}, 30000)
