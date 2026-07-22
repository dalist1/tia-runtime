import {mkdirSync, rmSync, writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'

type CatalogModel = {id: string; provider: string; [key: string]: unknown}

export type ModelCatalog = Record<string, Record<string, CatalogModel>>
export type DefaultModels = Record<string, string>

function isRecord(value: unknown): value is Record<string, unknown> {
 return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCatalogModel(value: unknown): value is CatalogModel {
 return isRecord(value) && typeof value.id === 'string' && value.id.length > 0 && typeof value.provider === 'string'
}

export function validateCatalog(catalogValue: unknown): ModelCatalog {
 if (!isRecord(catalogValue)) throw new Error('pi-ai MODELS export is not an object')
 const catalog: ModelCatalog = {}
 for (const [provider, modelsValue] of Object.entries(catalogValue)) {
  if (!/^[a-z0-9-]+$/.test(provider)) throw new Error(`Invalid catalog provider id: ${provider}`)
  if (!isRecord(modelsValue)) throw new Error(`Catalog entry for "${provider}" is not an object`)
  const models: Record<string, CatalogModel> = {}
  for (const [key, modelValue] of Object.entries(modelsValue)) {
   if (!isCatalogModel(modelValue)) throw new Error(`Catalog model "${provider}/${key}" has no valid id`)
   if (modelValue.provider !== provider) {
    throw new Error(`Catalog model "${provider}/${modelValue.id}" reports provider "${String(modelValue.provider)}"`)
   }
   models[key] = modelValue
  }
  catalog[provider] = models
 }
 return catalog
}

export function validateDefaultModels(defaultsValue: unknown, catalog: ModelCatalog): DefaultModels {
 if (!isRecord(defaultsValue)) throw new Error('pi defaultModelPerProvider export is not an object')
 const defaults: DefaultModels = {}
 for (const [provider, modelValue] of Object.entries(defaultsValue)) {
  if (typeof modelValue !== 'string' || modelValue.length === 0) throw new Error(`Default model for "${provider}" is not a string`)
  const providerModels = catalog[provider]
  if (providerModels && !Object.values(providerModels).some(model => model.id === modelValue)) {
   throw new Error(`Default model "${provider}/${modelValue}" is missing from the installed pi-ai catalog`)
  }
  defaults[provider] = modelValue
 }
 return defaults
}

export function buildStreamCatalog(catalogValue: unknown, defaultsValue: unknown, targetDir: string) {
 const catalog = validateCatalog(catalogValue)
 const defaults = validateDefaultModels(defaultsValue, catalog)
 const modelsDir = resolve(targetDir, 'models')
 rmSync(modelsDir, {recursive: true, force: true})
 mkdirSync(modelsDir, {recursive: true})
 writeFileSync(resolve(targetDir, 'models.json'), JSON.stringify(catalog))
 writeFileSync(resolve(targetDir, 'default-models.json'), JSON.stringify(defaults))

 const index = new Map<string, string | null>()
 for (const [provider, models] of Object.entries(catalog)) {
  writeFileSync(resolve(modelsDir, `${provider}.json`), JSON.stringify(models))
  for (const model of Object.values(models)) {
   const key = model.id.toLowerCase()
   const indexedProvider = index.get(key)
   index.set(key, indexedProvider === undefined || indexedProvider === provider ? provider : null)
  }
 }
 const lines = [...index]
  .filter((entry): entry is [string, string] => entry[1] !== null)
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([model, provider]) => `${model}\t${provider}`)
 writeFileSync(resolve(targetDir, 'model-index.txt'), `\n${lines.join('\n')}\n`)
 return {catalog, defaults}
}

export async function buildStreamCatalogFromModules(catalogModulePath: string, defaultsModulePath: string, targetDir: string) {
 const [catalogModule, defaultsModule] = await Promise.all([import(pathToFileURL(resolve(catalogModulePath)).href), import(pathToFileURL(resolve(defaultsModulePath)).href)])
 return buildStreamCatalog(catalogModule.MODELS, defaultsModule.defaultModelPerProvider, targetDir)
}

if (import.meta.main) {
 const [catalogModulePath, defaultsModulePath, targetDir] = process.argv.slice(2)
 if (!catalogModulePath || !defaultsModulePath || !targetDir) {
  console.error('Usage: bun build-stream-catalog.ts <models.generated.js> <model-resolver.js> <target-dir>')
  process.exit(1)
 }
 await buildStreamCatalogFromModules(catalogModulePath, defaultsModulePath, targetDir)
}
