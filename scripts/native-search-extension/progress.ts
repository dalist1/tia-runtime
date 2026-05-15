import type {ProgressEmitter, ToolTextResponse} from './types.ts'

const UPDATE_LIMIT = 16
const RECOVERED_LIMIT = 10
const PROGRESS_RENDER_CHARS = 360

type ProgressDetails = Record<string, unknown>
type FetchProgress = {current: number; total: number; url: string}
type RecoveredFetch = FetchProgress & {title: string; score: number}
type SkippedFetch = FetchProgress & {reason: string}
type ProgressSnapshot = ProgressDetails & {elapsedMs: number; updates: string[]; fetchedCount: number; skippedCount: number; current: FetchProgress | undefined; fetched: RecoveredFetch[]; skipped: SkippedFetch[]}

export class SearchProgress {
 private updates: string[] = []
 private fetched: RecoveredFetch[] = []
 private skipped: SkippedFetch[] = []
 private currentFetch: FetchProgress | undefined

 constructor(
  private emitTarget: ProgressEmitter,
  private started: number
 ) {}

 emit(message: string, details: ProgressDetails = {}) {
  const text = nativeSearchLine(message)
  this.record(text)
  this.emitTarget?.(text, this.snapshot(details))
 }

 applyZigLine(line: string) {
  const detail = zigProgressDetail(line)
  if (!detail) return false
  this.applyZigDetail(detail)
  this.emit(detail, {phase: 'fetch'})
  return true
 }

 snapshot(extra: ProgressDetails = {}): ProgressSnapshot {
  return {...extra, elapsedMs: performance.now() - this.started, updates: this.updates.slice(-UPDATE_LIMIT), fetchedCount: this.fetched.length, skippedCount: this.skipped.length, current: this.currentFetch, fetched: this.recoveredResults(RECOVERED_LIMIT), skipped: this.skipped.slice(-RECOVERED_LIMIT)}
 }

 recoveredResults(limit = 5) {
  return this.fetched
   .slice()
   .sort((a, b) => b.score - a.score)
   .slice(0, limit)
 }

 updatesForText(limit = 4) {
  return this.updates.slice(-limit)
 }

 private record(text: string) {
  this.updates.push(text)
  if (this.updates.length > UPDATE_LIMIT) this.updates = this.updates.slice(-UPDATE_LIMIT)
 }

 private applyZigDetail(detail: string) {
  const fetching = detail.match(/^fetching\s+(\d+)\/(\d+)\s+(.+)$/)
  if (fetching) {
   this.currentFetch = {current: Number(fetching[1]), total: Number(fetching[2]), url: fetching[3]}
   return
  }

  const fetched = detail.match(/^fetched\s+(\d+)\/(\d+)\s+score=(\d+)\s+(.+?)\s+—\s+(https?:\/\/\S+)$/)
  if (fetched) {
   this.currentFetch = undefined
   this.fetched.push({current: Number(fetched[1]), total: Number(fetched[2]), score: Number(fetched[3]), title: fetched[4], url: fetched[5]})
   return
  }

  const skipped = detail.match(/^skipped\s+(\d+)\/(\d+)\s+(.+?)\s+\(([^()]*)\)$/)
  if (skipped) {
   this.currentFetch = undefined
   this.skipped.push({current: Number(skipped[1]), total: Number(skipped[2]), url: skipped[3], reason: skipped[4]})
  }
 }
}

export async function readZigProgress(stream: ReadableStream<Uint8Array> | null, progress: SearchProgress, signal?: AbortSignal) {
 let buffered = ''
 const stderr = await readStreamText(
  stream,
  chunk => {
   buffered += chunk
   buffered = drainProgressLines(buffered, progress)
  },
  signal
 )
 if (buffered) progress.applyZigLine(buffered)
 return stderr
}

export async function readStreamText(stream: ReadableStream<Uint8Array> | null, onChunk?: (chunk: string) => void, signal?: AbortSignal) {
 if (!stream) return ''
 const reader = stream.getReader()
 const decoder = new TextDecoder()
 let text = ''
 let aborted = false
 const abort = () => {
  aborted = true
  reader.cancel().catch(() => {})
 }
 if (signal?.aborted) abort()
 signal?.addEventListener('abort', abort, {once: true})
 try {
  while (!aborted) {
   const {done, value} = await reader.read()
   if (done) break
   const chunk = decoder.decode(value, {stream: true})
   text += chunk
   onChunk?.(chunk)
  }
  const tail = decoder.decode()
  if (tail) {
   text += tail
   onChunk?.(tail)
  }
  return text
 } catch (error) {
  if (aborted) return text
  throw error
 } finally {
  signal?.removeEventListener('abort', abort)
  try {
   reader.releaseLock()
  } catch {
   // Reader may already be released by cancellation.
  }
 }
}

export function nonProgressStderr(stderr: string) {
 return stderr
  .split('\n')
  .map(line => line.trim())
  .filter(line => line && !zigProgressDetail(line))
  .join('\n')
  .trim()
}

export function renderProgressText(result: ToolTextResponse) {
 const text = result.content
  .filter(part => part.type === 'text')
  .map(part => part.text)
  .join('\n')
  .trim()
 if (!text) return 'Native search: searching…'
 const lines = text
  .split('\n')
  .map(line => truncateLine(line.trim(), 180))
  .filter(Boolean)
  .slice(0, 3)
 return truncateBlock(lines.join('\n'), PROGRESS_RENDER_CHARS) || 'Native search: searching…'
}

export function buildTimeoutSearchText(input: {query: string; timeoutMs: number; progress: SearchProgress}) {
 const snapshot = input.progress.snapshot()
 const recovered = input.progress.recoveredResults(5)
 const current = snapshot.current
 const lines = [`Native search timed out after ${formatMs(input.timeoutMs)} for \`${input.query}\`.`]
 lines.push(`Recovered: ${snapshot.fetchedCount} fetched, ${snapshot.skippedCount} skipped${current ? `; last fetch ${current.current}/${current.total} ${current.url}` : ''}.`)

 if (recovered.length > 0) {
  lines.push('Fetched before timeout:')
  for (const [index, item] of recovered.entries()) lines.push(`${index + 1}. ${truncateLine(item.title || item.url, 100)} — ${item.url} (score ${item.score})`)
 } else {
  const updates = input.progress.updatesForText(4)
  if (updates.length > 0) {
   lines.push('Last progress:')
   for (const update of updates) lines.push(`- ${truncateLine(update, 160)}`)
  }
 }

 return truncateBlock(lines.join('\n'), 1400)
}

function drainProgressLines(buffered: string, progress: SearchProgress) {
 let newline = buffered.indexOf('\n')
 while (newline >= 0) {
  const line = buffered.slice(0, newline)
  buffered = buffered.slice(newline + 1)
  progress.applyZigLine(line)
  newline = buffered.indexOf('\n')
 }
 return buffered
}

function zigProgressDetail(line: string) {
 const text = line.trim()
 if (!text.startsWith('progress:')) return undefined
 const detail = text.slice('progress:'.length).trim()
 return detail || undefined
}

function nativeSearchLine(message: string) {
 return message.startsWith('Native search:') ? message : `Native search: ${message}`
}

function formatMs(ms: number) {
 return `${Math.round(ms)} ms`
}

function truncateLine(text: string, maxChars: number) {
 const clean = text.replace(/\n/g, ' ')
 return clean.length <= maxChars ? clean : `${clean.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`
}

function truncateBlock(text: string, maxChars: number) {
 return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`
}
