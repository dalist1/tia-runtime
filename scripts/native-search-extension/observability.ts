import {mkdirSync} from 'node:fs'
import {appendFile} from 'node:fs/promises'
import {dirname} from 'node:path'

type NativeSearchEvent = {kind: 'native_search'; phase: 'complete' | 'error'; timestamp: string; query: string; details?: unknown; error?: string}

export async function logNativeSearchEvent(event: Omit<NativeSearchEvent, 'kind' | 'timestamp'>) {
 const path = process.env.TIA_NATIVE_SEARCH_LOG_PATH
 if (!path) return
 try {
  mkdirSync(dirname(path), {recursive: true})
  await appendFile(path, `${JSON.stringify({kind: 'native_search', timestamp: new Date().toISOString(), ...event})}\n`, 'utf8')
 } catch {
  // Observability must never break search.
 }
}
