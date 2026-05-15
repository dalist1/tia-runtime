import {renderProgressText} from './progress.ts'
import type {ToolTextResponse} from './types.ts'

const COLLAPSED_RESULT_LIMIT = 3
const EXPANDED_RESULT_LIMIT = 8
const COLLAPSED_SNIPPET_CHARS = 140
const EXPANDED_SNIPPET_CHARS = 260
const COLLAPSED_TOTAL_CHARS = 500
const COLLAPSED_COMPACT_RESULT_CHARS = 120
const EXPANDED_TOTAL_CHARS = 1200

type RenderOptions = {expanded?: boolean; expandHint?: string; isPartial?: boolean}
type ParsedSearchResult = {title: string; url: string; snippet?: string}

export function buildNativeSearchRenderText(result: ToolTextResponse, options: RenderOptions = {}) {
 if (options.isPartial) return renderProgressText(result)

 const fullText = textContent(result)
 const parsed = parseNativeSearchText(fullText)
 const detailCount = typeof result.details?.resultCount === 'number' ? result.details.resultCount : undefined
 const shownCount = parsed.resultCount ?? (parsed.results.length || detailCount || 0)
 const resultLabel = shownCount === 1 ? '1 result' : `${shownCount} results`
 const hasFullContent = result.details?.outputContent === true
 const limit = options.expanded ? EXPANDED_RESULT_LIMIT : COLLAPSED_RESULT_LIMIT
 const snippetLimit = options.expanded ? EXPANDED_SNIPPET_CHARS : COLLAPSED_SNIPPET_CHARS
 const totalLimit = options.expanded ? EXPANDED_TOTAL_CHARS : COLLAPSED_TOTAL_CHARS
 const lines = [`Native search: ${resultLabel}`]

 if (options.expanded && parsed.plan.length > 0) {
  lines.push(...parsed.plan.slice(0, 3).map(line => truncateLine(line, 180)))
 }

 const renderedResults = parsed.results.slice(0, limit)
 const compactResults = !options.expanded && renderedResults.length > 1
 for (const [index, item] of renderedResults.entries()) {
  if (compactResults) {
   const display = `${item.title || item.url} — ${item.url}`
   const deduped = item.title ? display : item.url
   lines.push(`${index + 1}. ${truncateLine(deduped, COLLAPSED_COMPACT_RESULT_CHARS)}`)
  } else {
   lines.push(`${index + 1}. ${truncateLine(item.title || item.url, 120)}`)
   if (item.url) lines.push(`   ${truncateLine(item.url, 180)}`)
   if (item.snippet) lines.push(`   ${truncateLine(squashWhitespace(item.snippet), snippetLimit)}`)
  }
 }

 const hiddenCount = parsed.results.length - renderedResults.length
 if (hiddenCount > 0) {
  const hint = options.expandHint ? `, ${options.expandHint}` : ''
  lines.push(`… ${hiddenCount} more result(s) hidden in terminal render${hint}`)
 }

 if (parsed.results.length === 0 && fullText.trim()) {
  lines.push(truncateLine(squashWhitespace(fullText), options.expanded ? 700 : 260))
 }

 if (hasFullContent) {
  const expandHint = options.expandHint ?? 'expand tool output'
  lines.push(options.expanded ? 'Full output remains truncated in UI; full data stays in tool context.' : `Full output truncated. ${expandHint}.`)
 }

 return truncateBlock(lines.join('\n'), totalLimit)
}

function textContent(result: ToolTextResponse) {
 return result.content
  .filter(part => part.type === 'text')
  .map(part => part.text)
  .join('\n')
}

function parseNativeSearchText(text: string) {
 const resultCount = Number(text.match(/Native Zig search found\s+(\d+)\s+result/)?.[1] ?? NaN)
 const lines = text.split('\n')
 const results: ParsedSearchResult[] = []
 let firstResultLine = -1

 for (let index = 0; index < lines.length; index += 1) {
  const heading = lines[index].match(/^##\s+\d+\.\s+(.+?)\s*$/)
  if (!heading) continue

  const urlLine = nextNonEmptyLine(lines, index + 1)
  const scoreLine = urlLine ? nextNonEmptyLine(lines, urlLine.index + 1) : undefined
  if (!urlLine?.text.match(/^https?:\/\/\S+/) || !scoreLine?.text.startsWith('Score:')) continue

  if (firstResultLine < 0) firstResultLine = index
  results.push({title: heading[1].trim(), url: urlLine.text.replace(/[).,;]+$/, ''), snippet: snippetAfterScore(lines, scoreLine.index + 1)})
 }

 const plan = (firstResultLine >= 0 ? lines.slice(0, firstResultLine) : []).map(line => line.trim()).filter(line => line && !line.startsWith('Native Zig search found'))
 return {plan, results, resultCount: Number.isFinite(resultCount) ? resultCount : undefined}
}

function nextNonEmptyLine(lines: string[], start: number) {
 for (let index = start; index < lines.length; index += 1) {
  const text = lines[index].trim()
  if (text) return {index, text}
 }
 return undefined
}

function snippetAfterScore(lines: string[], start: number) {
 const snippetLine = nextNonEmptyLine(lines, start)
 if (!snippetLine?.text.startsWith('Snippet:')) return undefined
 const snippetLines = [snippetLine.text.slice('Snippet:'.length).trim()]
 for (let index = snippetLine.index + 1; index < lines.length; index += 1) {
  const line = lines[index].trim()
  if (!line) break
  snippetLines.push(line)
 }
 const snippet = snippetLines.join(' ').trim()
 return snippet || undefined
}

function squashWhitespace(text: string) {
 return text.replace(/\s+/g, ' ').trim()
}

function truncateLine(text: string, maxChars: number) {
 const clean = text.replace(/\n/g, ' ')
 return clean.length <= maxChars ? clean : `${clean.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`
}

function truncateBlock(text: string, maxChars: number) {
 return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`
}
