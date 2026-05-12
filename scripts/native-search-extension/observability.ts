import {mkdirSync} from 'node:fs'
import {appendFile} from 'node:fs/promises'
import {dirname} from 'node:path'

type NativeSearchEvent = {kind: 'native_search'; phase: 'complete' | 'error' | 'fetch'; timestamp: string; query?: string; details?: unknown; error?: string; url?: string; origin?: string; cacheStatus?: 'hit' | 'miss'; fetchMs?: number; status?: number; truncated?: boolean; bytes?: number}

let logPath: string | undefined

function ensureLogPath() {
 if (logPath !== undefined) return logPath
 logPath = process.env.TIA_NATIVE_SEARCH_LOG_PATH ?? ''
 return logPath
}

export async function logNativeSearchEvent(event: Omit<NativeSearchEvent, 'kind' | 'timestamp'>) {
 const path = ensureLogPath()
 if (!path) return
 try {
  mkdirSync(dirname(path), {recursive: true})
  await appendFile(path, `${JSON.stringify({kind: 'native_search', timestamp: new Date().toISOString(), ...event})}\n`, 'utf8')
 } catch {
  // Observability must never break search.
 }
}

export function logFetchEvent(event: {url: string; origin: string; cacheStatus: 'hit' | 'miss'; fetchMs: number; status?: number; truncated?: boolean; bytes?: number; error?: string}) {
 logNativeSearchEvent({phase: 'fetch', ...event}).catch(() => {})
}
