import {expect, test} from 'bun:test'
import {mkdtempSync, readFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {resolve} from 'node:path'
import {buildStreamCatalog, buildStreamCatalogFromModules} from './build-stream-catalog.ts'

function model(provider: string, id: string) {
 return {id, provider, api: 'openai-completions', baseUrl: 'https://example.test'}
}

function withTempDir(run: (path: string) => void | Promise<void>) {
 const path = mkdtempSync(resolve(tmpdir(), 'tia-catalog-test-'))
 return Promise.resolve(run(path)).finally(() => rmSync(path, {recursive: true, force: true}))
}

test('buildStreamCatalog emits provider shards, validated defaults, and an unambiguous model index', () =>
 withTempDir(path => {
  const catalog = {alpha: {preferred: model('alpha', 'Alpha-Preferred'), shared: model('alpha', 'Shared-ID')}, beta: {unique: model('beta', 'Beta-Unique'), shared: model('beta', 'shared-id')}}
  const defaults = {alpha: 'Alpha-Preferred', beta: 'Beta-Unique', dynamic: 'remote-default'}
  buildStreamCatalog(catalog, defaults, path)

  expect(JSON.parse(readFileSync(resolve(path, 'models.json'), 'utf8'))).toEqual(catalog)
  expect(JSON.parse(readFileSync(resolve(path, 'models', 'alpha.json'), 'utf8'))).toEqual(catalog.alpha)
  expect(JSON.parse(readFileSync(resolve(path, 'default-models.json'), 'utf8'))).toEqual(defaults)
  const index = readFileSync(resolve(path, 'model-index.txt'), 'utf8')
  expect(index).toContain('\nalpha-preferred\talpha\n')
  expect(index).toContain('\nbeta-unique\tbeta\n')
  expect(index).not.toContain('shared-id')
 }))

test('buildStreamCatalog rejects a stale default for a provider in the installed catalog', () =>
 withTempDir(path => {
  const catalog = {xai: {current: model('xai', 'grok-current')}}
  expect(() => buildStreamCatalog(catalog, {xai: 'grok-stale'}, path)).toThrow('missing from the installed pi-ai catalog')
 }))

test('installed pi defaults are validated against pi-ai and include the current xAI preference', () =>
 withTempDir(async path => {
  const packageRoot = resolve(import.meta.dir, '..', 'node_modules', '@earendil-works')
  const result = await buildStreamCatalogFromModules(resolve(packageRoot, 'pi-ai', 'dist', 'models.generated.js'), resolve(packageRoot, 'pi-coding-agent', 'dist', 'core', 'model-resolver.js'), path)
  expect(result.defaults.xai).toBe('grok-4.5')
  expect(result.catalog.xai[result.defaults.xai]?.id).toBe('grok-4.5')
  expect(Object.keys(result.catalog).length).toBeGreaterThan(20)
 }))
