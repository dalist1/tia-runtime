import {closeSync, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync, writeSync} from 'node:fs'
import {homedir} from 'node:os'
import {basename, dirname, isAbsolute, join, resolve} from 'node:path'
import {createBashTool, createBashToolDefinition, createReadToolDefinition, createWriteToolDefinition, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type ExtensionAPI, formatSize, getAgentDir, ModelRuntime} from '@earendil-works/pi-coding-agent'
import {Container, Spacer, Text} from '@earendil-works/pi-tui'
import {Type} from '@sinclair/typebox'

const fastToolsDir = () => join(getAgentDir(), 'fast-tools')
const FASTDRAIN_BIN = () => join(fastToolsDir(), 'fastdrain')
const FASTCOPY_BIN = () => join(fastToolsDir(), 'fastcopy')
const READ_SCAN_CHUNK = 256 * 1024
const READ_FIRST_CHUNK = 64 * 1024
const selectorFilterMarker = Symbol.for('tia.gpt-model-selector-filter')
const gptSelectorProviders = new Set(['openai', 'openai-codex'])

let readScratch: Buffer | null = null
let verifyScratch: Buffer | null = null
let temporaryFileNonce = Date.now()

type TextBlock = {type: 'text'; text: string}
type TextToolUpdate = {content: TextBlock[]; details: any}

type ToolUpdateFn = ((update: TextToolUpdate) => void) | undefined

type OptimizedBashStep = {description: string; run: () => Promise<void>}

type ReplacementEdit = {oldText: string; newText: string}
type MultiReplacementEdit = ReplacementEdit & {path?: string}
type ClassicEdit = {path: string; oldText: string; newText: string}
type DiffHint = {beforeStart: number; beforeEnd: number; afterStart: number; afterEnd: number}
type PlannedFileEdit = {path: string; absolutePath: string; before: string; after: string; editCount: number; diffHint?: DiffHint}
type PatchOperation = {kind: 'add'; path: string; contents: string} | {kind: 'delete'; path: string} | {kind: 'update'; path: string; chunks: PatchChunk[]}
type PatchChunk = {oldLines: string[]; newLines: string[]; isEndOfFile: boolean}
type PlannedPatchFile = {path: string; absolutePath: string; before: string | null; after: string | null}
type EditFailureDetails = {
 reason: 'not_found' | 'indentation_mismatch' | 'line_ending_mismatch' | 'duplicate_match'
 path: string
 editIndex: number
 line?: number
 count?: number
 locations?: number[]
 matchType?: 'trimmed_whitespace' | 'line_endings' | 'exact'
 confidence?: number
 expectedPrefix?: string
 actualPrefix?: string
 suggestion: string
}
type EditToolError = Error & {details: EditFailureDetails}

type EditResultDetails = {verified?: boolean; files?: number; diff?: string}

function installGptSelectorFilter() {
 const prototype = ModelRuntime.prototype
 if (Reflect.get(prototype, selectorFilterMarker)) return

 const getAvailable = prototype.getAvailable
 const getAvailableSnapshot = prototype.getAvailableSnapshot
 prototype.getAvailable = async function (providerId?: string) {
  if (providerId && !gptSelectorProviders.has(providerId)) return []
  return (await getAvailable.call(this, providerId)).filter(model => gptSelectorProviders.has(model.provider))
 }
 prototype.getAvailableSnapshot = function () {
  return getAvailableSnapshot.call(this).filter(model => gptSelectorProviders.has(model.provider))
 }
 Reflect.defineProperty(prototype, selectorFilterMarker, {value: true})
}

export function previewWhitespace(text: string) {
 return text.replace(/\t/g, '\\t').replace(/ /g, '·')
}

function firstNonEmptyLine(text: string) {
 return text.split('\n').find(line => line.trim().length > 0) ?? text.split('\n')[0] ?? ''
}

function shortenDisplayPath(path: string) {
 return path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path
}

function uniqueStrings(values: string[]) {
 const out: string[] = []
 for (const value of values) {
  if (value && !out.includes(value)) out.push(value)
 }
 return out
}

function normalizeUnifiedDiffPath(path: string) {
 const trimmed = path.trim()
 if (trimmed === '/dev/null') return ''
 if (trimmed.startsWith('a/') || trimmed.startsWith('b/')) return trimmed.slice(2)
 return trimmed
}

function patchOperationPaths(patchText: string) {
 const paths: string[] = []
 for (const line of patchText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')) {
  const match = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/)
  if (match) paths.push(match[1])
  const oldFile = line.match(/^---\s+(.+)$/)
  const newFile = line.match(/^\+\+\+\s+(.+)$/)
  if (oldFile) paths.push(normalizeUnifiedDiffPath(oldFile[1]))
  if (newFile) paths.push(normalizeUnifiedDiffPath(newFile[1]))
 }
 return uniqueStrings(paths)
}

function editDisplayTarget(args: any) {
 if (typeof args?.path === 'string' && args.path) return shortenDisplayPath(args.path)
 if (Array.isArray(args?.multi)) {
  const paths = uniqueStrings(args.multi.map((edit: any) => (typeof edit?.path === 'string' ? edit.path : '')).filter(Boolean))
  if (paths.length === 1) return shortenDisplayPath(paths[0])
  if (paths.length > 1) return `${paths.length} files`
 }
 if (typeof args?.patch === 'string') {
  const paths = patchOperationPaths(args.patch)
  if (paths.length === 1) return shortenDisplayPath(paths[0])
  if (paths.length > 1) return `${paths.length} files`
 }
 return '...'
}

function editDisplayMode(args: any) {
 if (typeof args?.patch === 'string') return 'patch'
 if (Array.isArray(args?.multi)) return 'multi'
 return undefined
}

function lineStarts(text: string) {
 const starts: number[] = [0]
 let newline = text.indexOf('\n')
 while (newline !== -1) {
  starts.push(newline + 1)
  newline = text.indexOf('\n', newline + 1)
 }
 if (starts[starts.length - 1] === text.length) starts.pop()
 return starts
}

function lineEnd(text: string, starts: number[], index: number) {
 if (index + 1 < starts.length) return starts[index + 1] - 1
 return text.charCodeAt(text.length - 1) === 10 ? text.length - 1 : text.length
}

function linesEqual(left: string, leftStarts: number[], leftIndex: number, right: string, rightStarts: number[], rightIndex: number) {
 const leftStart = leftStarts[leftIndex]
 const rightStart = rightStarts[rightIndex]
 const leftEnd = lineEnd(left, leftStarts, leftIndex)
 const rightEnd = lineEnd(right, rightStarts, rightIndex)
 const length = leftEnd - leftStart
 if (length !== rightEnd - rightStart) return false
 for (let i = 0; i < length; i += 1) {
  if (left.charCodeAt(leftStart + i) !== right.charCodeAt(rightStart + i)) return false
 }
 return true
}

function lineText(text: string, starts: number[], index: number) {
 return text.slice(starts[index], lineEnd(text, starts, index))
}

function countNewlines(text: string, start = 0, end = text.length) {
 let count = 0
 let newline = text.indexOf('\n', start)
 while (newline !== -1 && newline < end) {
  count += 1
  newline = text.indexOf('\n', newline + 1)
 }
 return count
}

function textLineCount(text: string) {
 if (text.length === 0) return 1
 const lines = countNewlines(text)
 return text.charCodeAt(text.length - 1) === 10 ? lines : lines + 1
}

function isLineBoundary(text: string, index: number) {
 return index >= 0 && index <= text.length && (index === 0 || text.charCodeAt(index - 1) === 10)
}

function rangeLineEqual(left: string, leftStart: number, leftEnd: number, right: string, rightStart: number, rightEnd: number) {
 const leftLength = leftEnd - leftStart
 if (leftLength !== rightEnd - rightStart) return false
 for (let i = 0; i < leftLength; i += 1) {
  if (left.charCodeAt(leftStart + i) !== right.charCodeAt(rightStart + i)) return false
 }
 return true
}

function appendDiffRange(lines: string[], text: string, start: number, end: number, firstLine: number, marker: string, width: number) {
 let position = start
 let line = firstLine
 while (position < end) {
  const newline = text.indexOf('\n', position)
  const lineEnd = newline === -1 || newline >= end ? end : newline
  lines.push(`${marker}${String(line).padStart(width)} ${text.slice(position, lineEnd)}`)
  line += 1
  position = newline === -1 || newline >= end ? end : newline + 1
 }
}

function alignedLineDiff(before: string, after: string, hint: DiffHint) {
 if (hint.beforeStart !== hint.afterStart || !isLineBoundary(before, hint.beforeStart) || !isLineBoundary(before, hint.beforeEnd) || !isLineBoundary(after, hint.afterStart) || !isLineBoundary(after, hint.afterEnd)) return undefined
 const prefix = countNewlines(before, 0, hint.beforeStart)
 const beforeChanged = countNewlines(before, hint.beforeStart, hint.beforeEnd)
 const afterChanged = countNewlines(after, hint.afterStart, hint.afterEnd)
 const beforeLines = textLineCount(before)
 const afterLines = textLineCount(after)
 const beforeSuffix = beforeLines - prefix - beforeChanged
 const afterSuffix = afterLines - prefix - afterChanged
 if (beforeSuffix !== afterSuffix) return undefined
 if (beforeChanged > 0 && afterChanged > 0) {
  const beforeFirstEnd = before.indexOf('\n', hint.beforeStart)
  const afterFirstEnd = after.indexOf('\n', hint.afterStart)
  if (rangeLineEqual(before, hint.beforeStart, beforeFirstEnd, after, hint.afterStart, afterFirstEnd)) return undefined
  const beforeLastStart = before.lastIndexOf('\n', hint.beforeEnd - 2) + 1
  const afterLastStart = after.lastIndexOf('\n', hint.afterEnd - 2) + 1
  if (rangeLineEqual(before, beforeLastStart, hint.beforeEnd - 1, after, afterLastStart, hint.afterEnd - 1)) return undefined
 }

 const context = 4
 const contextBefore = Math.min(context, prefix)
 let contextStart = hint.beforeStart
 for (let i = 0; i < contextBefore; i += 1) contextStart = before.lastIndexOf('\n', contextStart - 2) + 1
 let contextEnd = hint.afterEnd
 let contextAfter = 0
 while (contextAfter < context && contextEnd < after.length) {
  const newline = after.indexOf('\n', contextEnd)
  contextEnd = newline === -1 ? after.length : newline + 1
  contextAfter += 1
 }

 const width = String(Math.max(beforeLines, afterLines, 1)).length
 const lines: string[] = []
 if (prefix > context) lines.push(` ${''.padStart(width)} ...`)
 appendDiffRange(lines, before, contextStart, hint.beforeStart, prefix - contextBefore + 1, ' ', width)
 appendDiffRange(lines, before, hint.beforeStart, hint.beforeEnd, prefix + 1, '-', width)
 appendDiffRange(lines, after, hint.afterStart, hint.afterEnd, prefix + 1, '+', width)
 appendDiffRange(lines, after, hint.afterEnd, contextEnd, prefix + afterChanged + 1, ' ', width)
 if (beforeSuffix > contextAfter) lines.push(` ${''.padStart(width)} ...`)
 return lines.join('\n')
}

function lineDiff(before: string | null, after: string | null, hint?: DiffHint) {
 const beforeText = before ?? ''
 const afterText = after ?? ''
 const aligned = hint && before !== null && after !== null ? alignedLineDiff(beforeText, afterText, hint) : undefined
 if (aligned !== undefined) return aligned
 const beforeLines = lineStarts(beforeText)
 const afterLines = lineStarts(afterText)

 let prefix = 0
 while (prefix < beforeLines.length && prefix < afterLines.length && linesEqual(beforeText, beforeLines, prefix, afterText, afterLines, prefix)) prefix += 1

 let suffix = 0
 while (suffix < beforeLines.length - prefix && suffix < afterLines.length - prefix && linesEqual(beforeText, beforeLines, beforeLines.length - 1 - suffix, afterText, afterLines, afterLines.length - 1 - suffix)) suffix += 1

 const context = 4
 const start = Math.max(0, prefix - context)
 const beforeEnd = Math.min(beforeLines.length, beforeLines.length - suffix + context)
 const afterEnd = Math.min(afterLines.length, afterLines.length - suffix + context)
 const width = String(Math.max(beforeLines.length, afterLines.length, 1)).length
 const lines: string[] = []

 if (start > 0) lines.push(` ${''.padStart(width)} ...`)
 for (let i = start; i < prefix; i += 1) lines.push(` ${String(i + 1).padStart(width)} ${lineText(beforeText, beforeLines, i)}`)
 for (let i = prefix; i < beforeLines.length - suffix; i += 1) lines.push(`-${String(i + 1).padStart(width)} ${lineText(beforeText, beforeLines, i)}`)
 for (let i = prefix; i < afterLines.length - suffix; i += 1) lines.push(`+${String(i + 1).padStart(width)} ${lineText(afterText, afterLines, i)}`)
 for (let i = afterLines.length - suffix; i < afterEnd; i += 1) lines.push(` ${String(i + 1).padStart(width)} ${lineText(afterText, afterLines, i)}`)
 if (afterEnd < afterLines.length || beforeEnd < beforeLines.length) lines.push(` ${''.padStart(width)} ...`)

 return lines.join('\n')
}

function editDiffSectionTitle(plan: PlannedFileEdit | PlannedPatchFile) {
 if (plan.before === null) return `added ${plan.path}`
 if (plan.after === null) return `deleted ${plan.path}`
 return plan.path
}

export function combinedEditDiff(plans: Array<PlannedFileEdit | PlannedPatchFile>) {
 if (plans.length === 1) return lineDiff(plans[0].before, plans[0].after, 'diffHint' in plans[0] ? plans[0].diffHint : undefined)
 return plans.map(plan => `${editDiffSectionTitle(plan)}\n${lineDiff(plan.before, plan.after, 'diffHint' in plan ? plan.diffHint : undefined)}`).join('\n\n')
}

function renderDiffText(diffText: string, theme: any) {
 return diffText
  .split('\n')
  .map(line => {
   if (line.startsWith('-') && !line.startsWith('---')) return theme.fg('toolDiffRemoved', line)
   if (line.startsWith('+') && !line.startsWith('+++')) return theme.fg('toolDiffAdded', line)
   return theme.fg('toolDiffContext', line)
  })
  .join('\n')
}

function renderLimitedText(text: string, expanded: boolean, maxLines: number, theme: any) {
 const lines = text.split('\n')
 const shown = expanded ? lines : lines.slice(0, maxLines)
 let rendered = shown.join('\n')
 if (lines.length > shown.length) rendered += theme.fg('muted', `\n... (${lines.length - shown.length} more lines, ctrl+o to expand)`)
 return rendered
}

function editResultDetails(details: unknown): EditResultDetails | undefined {
 if (!isRecord(details)) return undefined
 return {verified: typeof details.verified === 'boolean' ? details.verified : undefined, files: typeof details.files === 'number' ? details.files : undefined, diff: typeof details.diff === 'string' ? details.diff : undefined}
}

function isRecord(value: unknown): value is Record<string, unknown> {
 return Boolean(value) && typeof value === 'object'
}

function isTextBlock(value: unknown): value is TextBlock {
 return isRecord(value) && value.type === 'text' && typeof value.text === 'string'
}

function textContentOutput(content: unknown) {
 if (!Array.isArray(content)) return ''
 return content
  .filter(isTextBlock)
  .map(block => block.text)
  .join('\n')
  .trimEnd()
}

function findIndentationOnlyMatch(content: string, oldText: string) {
 const expectedLines = oldText.split('\n')
 const contentLines = content.split('\n')
 if (expectedLines.every(line => line.length === 0)) return null

 for (let start = 0; start + expectedLines.length <= contentLines.length; start += 1) {
  let matches = true
  for (let offset = 0; offset < expectedLines.length; offset += 1) {
   if (contentLines[start + offset].trim() !== expectedLines[offset].trim()) {
    matches = false
    break
   }
  }
  if (matches) {
   return {line: start + 1, actual: contentLines[start]}
  }
 }
 return null
}

function lineNumberAt(content: string, index: number) {
 let line = 1
 for (let i = 0; i < index; i += 1) {
  if (content.charCodeAt(i) === 10) line += 1
 }
 return line
}

function exactMatchLines(content: string, oldText: string, limit = 8) {
 const locations: number[] = []
 let index = content.indexOf(oldText)
 while (index !== -1 && locations.length < limit) {
  locations.push(lineNumberAt(content, index))
  index = content.indexOf(oldText, index + Math.max(oldText.length, 1))
 }
 return locations
}

export function duplicateEditError(pathArg: string, editIndex: number, content: string, oldText: string): EditToolError {
 const locations = exactMatchLines(content, oldText)
 const details: EditFailureDetails = {reason: 'duplicate_match', path: pathArg, editIndex, count: locations.length, locations, matchType: 'exact', suggestion: 'Add surrounding context to oldText or use patch'}
 const lines = locations.length > 0 ? `\nMatch lines: ${locations.join(', ')}${locations.length >= 8 ? ', ...' : ''}.` : ''
 return Object.assign(new Error(`Edit failed in ${pathArg}: edits[${editIndex}].oldText matched ${locations.length} places; it must match exactly one place.${lines}\nFix: include more surrounding context in oldText, or use patch.`), {details})
}

export function missingEditError(pathArg: string, editIndex: number, content: string, oldText: string): EditToolError {
 const messages: string[] = []
 let failureDetails: EditFailureDetails = {reason: 'not_found', path: pathArg, editIndex, suggestion: 'Read the target region again, then retry with exact oldText or use patch for contextual edits.'}
 const indentationMatch = findIndentationOnlyMatch(content, oldText)
 if (indentationMatch) {
  const expectedPrefix = previewWhitespace(firstNonEmptyLine(oldText).slice(0, 80))
  const actualPrefix = previewWhitespace(indentationMatch.actual.slice(0, 80))
  messages.push(`Nearest match starts at line ${indentationMatch.line} and differs only after trimming whitespace.`)
  messages.push(`Expected first line prefix: "${expectedPrefix}"`)
  messages.push(`Actual first line prefix: "${actualPrefix}"`)
  failureDetails = {reason: 'indentation_mismatch', path: pathArg, editIndex, line: indentationMatch.line, matchType: 'trimmed_whitespace', confidence: 0.98, expectedPrefix, actualPrefix, suggestion: 'Retry with the actual whitespace from actualPrefix, or use patch for indentation-sensitive edits.'}
 }
 if (oldText.includes('\r\n') && content.includes('\n') && !content.includes('\r\n')) {
  messages.push('The requested oldText uses CRLF line endings, but the file appears to use LF line endings.')
  failureDetails = {reason: 'line_ending_mismatch', path: pathArg, editIndex, matchType: 'line_endings', confidence: 0.99, suggestion: 'Retry using LF line endings in oldText.'}
 } else if (!oldText.includes('\r\n') && content.includes('\r\n')) {
  messages.push('The file appears to use CRLF line endings, but the requested oldText uses LF line endings.')
  failureDetails = {reason: 'line_ending_mismatch', path: pathArg, editIndex, matchType: 'line_endings', confidence: 0.99, suggestion: 'Retry using CRLF line endings in oldText, or use patch.'}
 }
 const suffix = messages.length > 0 ? `\n${messages.join('\n')}\nFix: ${failureDetails.suggestion}` : `\nFix: ${failureDetails.suggestion}`
 const error: EditToolError = Object.assign(new Error(`Edit failed in ${pathArg}: edits[${editIndex}].oldText was not found exactly.${suffix}`), {details: failureDetails})
 return error
}

function resolveEditPath(cwd: string, path: string) {
 return isAbsolute(path) ? resolve(path) : resolve(cwd, path)
}

function planFileEdits(pathArg: string, absolutePath: string, content: string, edits: Array<{index: number; oldText: string; newText: string}>): PlannedFileEdit {
 const replacements = edits.map(edit => {
  if (edit.oldText.length === 0) {
   throw new Error(`Edit ${edit.index + 1} in ${pathArg} has empty oldText.`)
  }

  const firstIndex = content.indexOf(edit.oldText)
  if (firstIndex === -1) {
   throw missingEditError(pathArg, edit.index, content, edit.oldText)
  }

  const secondIndex = content.indexOf(edit.oldText, firstIndex + edit.oldText.length)
  if (secondIndex !== -1) {
   throw duplicateEditError(pathArg, edit.index, content, edit.oldText)
  }

  return {index: edit.index, start: firstIndex, end: firstIndex + edit.oldText.length, newText: edit.newText}
 })

 replacements.sort((a, b) => a.start - b.start || a.index - b.index)
 let after = ''
 let cursor = 0
 for (const replacement of replacements) {
  if (replacement.start < cursor) {
   throw new Error(`Edit ${replacement.index + 1} in ${pathArg} overlaps another replacement. Merge nearby changes into one edit.`)
  }
  after += content.slice(cursor, replacement.start)
  after += replacement.newText
  cursor = replacement.end
 }
 after += content.slice(cursor)

 if (after === content) {
  throw new Error(`No changes made to ${pathArg}. The replacement produced identical content.`)
 }

 return {path: pathArg, absolutePath, before: content, after, editCount: edits.length}
}

export async function planClassicEdits(cwd: string, edits: ClassicEdit[], readText: (absolutePath: string) => Promise<string>) {
 if (edits.length === 0) {
  throw new Error('Edit tool input is invalid. edits must contain at least one replacement.')
 }

 const groups = new Map<string, {pathArg: string; edits: Array<{index: number; oldText: string; newText: string}>}>()
 const order: string[] = []
 for (let index = 0; index < edits.length; index += 1) {
  const edit = edits[index]
  if (!edit.path) {
   throw new Error(`Edit ${index + 1} is missing a path.`)
  }
  const absolutePath = resolveEditPath(cwd, edit.path)
  if (!groups.has(absolutePath)) {
   groups.set(absolutePath, {pathArg: edit.path, edits: []})
   order.push(absolutePath)
  }
  groups.get(absolutePath)!.edits.push({index, oldText: edit.oldText, newText: edit.newText})
 }

 const planned: PlannedFileEdit[] = []
 for (const absolutePath of order) {
  const group = groups.get(absolutePath)!
  const content = await readText(absolutePath)
  planned.push(planFileEdits(group.pathArg, absolutePath, content, group.edits))
 }
 return planned
}

const readSchema = Type.Object({path: Type.String({description: 'Path to the file to read (relative or absolute)'}), offset: Type.Optional(Type.Number({description: 'Line number to start reading from (1-indexed)'})), limit: Type.Optional(Type.Number({description: 'Maximum number of lines to read'}))})

const writeSchema = Type.Object({path: Type.String({description: 'Path to the file to write (relative or absolute)'}), content: Type.String({description: 'Content to write to the file'})})

const replacementEditSchema = Type.Object({oldText: Type.String({description: 'Exact text for one targeted replacement. It must be unique in the original file and must not overlap with another edit.'}), newText: Type.String({description: 'Replacement text for this targeted edit.'})})
const multiReplacementEditSchema = Type.Object({path: Type.Optional(Type.String({description: 'Path for this edit. Inherits top-level path when omitted.'})), oldText: Type.String({description: 'Exact text for one targeted replacement.'}), newText: Type.String({description: 'Replacement text for this targeted edit.'})})

const editSchema = Type.Object({
 path: Type.Optional(Type.String({description: 'Path to the file to edit (relative or absolute)'})),
 edits: Type.Optional(Type.Array(replacementEditSchema, {description: 'One or more exact-text replacements. Each oldText is matched against the original file, not incrementally.'})),
 multi: Type.Optional(Type.Array(multiReplacementEditSchema, {description: 'Multiple exact-text replacements, optionally across files. Each item can inherit top-level path.'})),
 patch: Type.Optional(Type.String({description: 'Bare unified/git diff or apply_patch-style patch. Mutually exclusive with path/oldText/newText/edits/multi.'})),
 oldText: Type.Optional(Type.String({description: 'Deprecated compatibility field. Prefer edits[].oldText.'})),
 newText: Type.Optional(Type.String({description: 'Deprecated compatibility field. Prefer edits[].newText.'}))
})

const bashSchema = Type.Object({command: Type.String({description: 'Bash command to execute'}), timeout: Type.Optional(Type.Number({description: 'Timeout in seconds (optional, no default timeout)'}))})

function expandPath(path: string) {
 if (path === '~') {
  return homedir()
 }
 if (path.startsWith('~/')) {
  return `${homedir()}${path.slice(1)}`
 }
 return path.startsWith('@') ? path.slice(1) : path
}

export const editToolDescription =
 'Edit files. Use patch for non-trivial code edits, long files, indentation-sensitive/block/multi-file changes; patch accepts bare unified/git diff or apply_patch-style patches. Use exact oldText/edits[]/multi[] only for tiny fresh verbatim replacements. Exact oldText must include whitespace and newlines exactly.'

export const editToolPromptSnippet = 'Edit choice: patch for non-trivial code edits, long files, indentation-sensitive/block/multi-file changes; accepts bare unified/git diff or apply_patch-style patches. Use exact oldText/edits[]/multi[] only for tiny fresh verbatim replacements. If exact fails once, reread or patch.'

function resolvePath(cwd: string, path: string) {
 return resolve(cwd, expandPath(path))
}

function resolvePatchPath(cwd: string, path: string) {
 const trimmed = path.trim()
 if (!trimmed) throw new Error('Patch path cannot be empty')
 return isAbsolute(trimmed) ? resolve(trimmed) : resolve(cwd, trimmed)
}

function parseUpdateChunk(lines: string[], startIndex: number, lastContentLine: number) {
 let i = startIndex
 if (lines[i].trimEnd().startsWith('@@')) i += 1
 const oldLines: string[] = []
 const newLines: string[] = []
 let parsed = 0
 let isEndOfFile = false
 while (i <= lastContentLine) {
  const raw = lines[i]
  const trimmed = raw.trimEnd()
  if (trimmed === '*** End of File') {
   isEndOfFile = true
   i += 1
   break
  }
  if (trimmed.startsWith('\\ No newline')) {
   i += 1
   continue
  }
  if (parsed > 0 && (trimmed.startsWith('@@') || trimmed.startsWith('*** '))) break
  if (raw.length === 0) {
   oldLines.push('')
   newLines.push('')
   parsed += 1
   i += 1
   continue
  }
  const marker = raw[0]
  const body = raw.slice(1)
  if (marker === ' ') {
   oldLines.push(body)
   newLines.push(body)
  } else if (marker === '-') {
   oldLines.push(body)
  } else if (marker === '+') {
   newLines.push(body)
  } else if (parsed === 0) {
   throw new Error(`Unexpected line found in update hunk: '${raw}'.`)
  } else {
   break
  }
  parsed += 1
  i += 1
 }
 if (parsed === 0) throw new Error('Update hunk does not contain any lines')
 return {chunk: {oldLines, newLines, isEndOfFile}, nextIndex: i}
}

function patchHeaderError(line: string) {
 return new Error(
  `'${line}' is not a valid patch file header.\nAccepted patch forms:\n1. Bare unified diff: --- a/path, +++ b/path, @@ ...\n2. Git diff: diff --git a/path b/path, then ---/+++ and @@ hunks\n3. Apply-patch wrapper: *** Begin Patch / *** Update File: path / @@ ... / *** End Patch\n4. Add/delete: *** Add File: path or *** Delete File: path\n\nDo not start with @@; include a file header first.`
 )
}

function normalizePatchText(patchText: string) {
 const normalized = patchText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
 if (!normalized) throw new Error('Patch payload is empty.')
 if (normalized.startsWith('*** Begin Patch')) return normalized
 return `*** Begin Patch\n${normalized}\n*** End Patch`
}

function isUnifiedFileHeader(lines: string[], index: number, lastContentLine: number) {
 return index + 1 <= lastContentLine && /^---\s+/.test(lines[index]) && /^\+\+\+\s+/.test(lines[index + 1])
}

function isGitFileHeader(line: string) {
 return line.trim().startsWith('diff --git ')
}

function parseUnifiedPath(line: string, marker: '---' | '+++') {
 return normalizeUnifiedDiffPath(line.slice(marker.length).trim())
}

function skipOptionalUnifiedBody(lines: string[], index: number, lastContentLine: number) {
 let i = index
 if (isUnifiedFileHeader(lines, i, lastContentLine)) i += 2
 if (i <= lastContentLine && lines[i].trim().startsWith('@@')) i += 1
 return i
}

function skipToNextPatchSection(lines: string[], index: number, lastContentLine: number) {
 let i = index
 while (i <= lastContentLine && !lines[i].trim().startsWith('*** ')) i += 1
 return i
}

function parseUnifiedDiffOperation(lines: string[], startIndex: number, lastContentLine: number) {
 const oldPath = parseUnifiedPath(lines[startIndex], '---')
 const newPath = parseUnifiedPath(lines[startIndex + 1], '+++')
 if (!oldPath && !newPath) throw patchHeaderError(lines[startIndex])
 const path = newPath || oldPath
 let i = startIndex + 2
 let operationEnd = i
 while (operationEnd <= lastContentLine && !lines[operationEnd].trim().startsWith('*** ') && !isUnifiedFileHeader(lines, operationEnd, lastContentLine) && !isGitFileHeader(lines[operationEnd])) operationEnd += 1
 const lastOperationLine = operationEnd - 1
 const chunks: PatchChunk[] = []
 while (i <= lastOperationLine) {
  if (!lines[i].trim() || lines[i].trim().startsWith('\\ No newline')) {
   i += 1
   continue
  }
  const parsed = parseUpdateChunk(lines, i, lastOperationLine)
  chunks.push(parsed.chunk)
  i = parsed.nextIndex
 }
 if (!oldPath) {
  const contents = `${chunks.flatMap(chunk => chunk.newLines).join('\n')}\n`
  return {operation: {kind: 'add' as const, path, contents}, nextIndex: operationEnd}
 }
 if (!newPath) return {operation: {kind: 'delete' as const, path}, nextIndex: operationEnd}
 if (chunks.length === 0) throw new Error(`Unified diff for path '${path}' has no hunks.`)
 return {operation: {kind: 'update' as const, path, chunks}, nextIndex: operationEnd}
}

export function parsePatch(patchText: string): PatchOperation[] {
 const lines = normalizePatchText(patchText).split('\n')
 if (lines[0]?.trim() !== '*** Begin Patch') throw new Error("The first line of the patch must be '*** Begin Patch'")
 if (lines[lines.length - 1]?.trim() !== '*** End Patch') throw new Error("The last line of the patch must be '*** End Patch'")
 const operations: PatchOperation[] = []
 let i = 1
 const lastContentLine = lines.length - 2
 while (i <= lastContentLine) {
  const line = lines[i].trim()
  if (!line) {
   i += 1
   continue
  }
  if (line.startsWith('diff --git ') || line.startsWith('index ') || line.startsWith('new file mode ') || line.startsWith('deleted file mode ') || line.startsWith('similarity index ') || line.startsWith('rename from ') || line.startsWith('rename to ')) {
   i += 1
   continue
  }
  if (isUnifiedFileHeader(lines, i, lastContentLine)) {
   const parsed = parseUnifiedDiffOperation(lines, i, lastContentLine)
   operations.push(parsed.operation)
   i = parsed.nextIndex
   continue
  }
  if (line.startsWith('*** Add File: ')) {
   const path = line.slice('*** Add File: '.length)
   i += 1
   i = skipOptionalUnifiedBody(lines, i, lastContentLine)
   const contentLines: string[] = []
   while (i <= lastContentLine && !lines[i].trim().startsWith('*** ')) {
    if (lines[i].trim().startsWith('\\ No newline')) {
     i += 1
     continue
    }
    contentLines.push(lines[i].startsWith('+') ? lines[i].slice(1) : lines[i])
    i += 1
   }
   operations.push({kind: 'add', path, contents: `${contentLines.join('\n')}\n`})
   continue
  }
  if (line.startsWith('*** Delete File: ')) {
   operations.push({kind: 'delete', path: line.slice('*** Delete File: '.length)})
   i += 1
   i = skipToNextPatchSection(lines, skipOptionalUnifiedBody(lines, i, lastContentLine), lastContentLine)
   continue
  }
  if (line.startsWith('*** Update File: ')) {
   const path = line.slice('*** Update File: '.length)
   i += 1
   if (isUnifiedFileHeader(lines, i, lastContentLine)) i += 2
   const chunks: PatchChunk[] = []
   while (i <= lastContentLine && !lines[i].trim().startsWith('*** ')) {
    if (!lines[i].trim()) {
     i += 1
     continue
    }
    const parsed = parseUpdateChunk(lines, i, lastContentLine)
    chunks.push(parsed.chunk)
    i = parsed.nextIndex
   }
   if (chunks.length === 0) throw new Error(`Update file hunk for path '${path}' is empty`)
   operations.push({kind: 'update', path, chunks})
   continue
  }
  throw patchHeaderError(line)
 }
 return operations
}

function normalizedLine(line: string) {
 return line
  .trim()
  .replace(/[\u2010-\u2015\u2212]/g, '-')
  .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
  .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
  .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ')
}

function lineEqual(actual: string, expected: string) {
 return actual === expected || actual.trimEnd() === expected.trimEnd() || normalizedLine(actual) === normalizedLine(expected)
}

function findChunk(lines: string[], pattern: string[], start: number, eof: boolean) {
 const searchStart = eof && lines.length >= pattern.length ? lines.length - pattern.length : start
 const matches: number[] = []
 for (let i = searchStart; i <= lines.length - pattern.length; i += 1) {
  let ok = true
  for (let j = 0; j < pattern.length; j += 1) {
   if (!lineEqual(lines[i + j], pattern[j])) {
    ok = false
    break
   }
  }
  if (ok) matches.push(i)
 }
 if (matches.length > 1) throw new Error('Patch hunk is ambiguous; multiple matching locations were found.')
 return matches[0]
}

function leadingWhitespace(line: string) {
 return line.match(/^\s*/)?.[0] ?? ''
}

function preserveMatchedIndent(actualLines: string[], expectedLines: string[], newLines: string[]) {
 const expectedAnchor = expectedLines.find(line => line.trim().length > 0)
 if (expectedAnchor === undefined || leadingWhitespace(expectedAnchor).length > 0) return newLines
 const actualAnchorIndex = expectedLines.findIndex(line => line === expectedAnchor)
 const actualIndent = leadingWhitespace(actualLines[actualAnchorIndex] ?? '')
 if (actualIndent.length === 0) return newLines
 return newLines.map(line => (line.trim().length > 0 && leadingWhitespace(line).length === 0 ? `${actualIndent}${line}` : line))
}

function nearestPatchPrefixLine(lines: string[], oldLines: string[], start: number) {
 const prefix = oldLines.find(line => line.trim().length > 0)
 if (prefix === undefined) return undefined
 const normalizedPrefix = normalizedLine(prefix)
 for (let i = start; i < lines.length; i += 1) {
  if (normalizedLine(lines[i]) === normalizedPrefix) return i + 1
 }
 return undefined
}

function formatMissingPatchChunkError(path: string, oldLines: string[], nearestPrefixLine?: number) {
 const lineCount = oldLines.length
 const noun = lineCount === 1 ? 'line' : 'lines'
 const nearest = nearestPrefixLine === undefined ? '' : `\nNearest matching prefix starts at line ${nearestPrefixLine}.`
 return `Patch failed in ${path}: expected ${lineCount} ${noun} from the patch were not found.${nearest}\nFix: reread that region, then retry with current context or use exact edit.`
}

function applyUpdate(path: string, content: string, chunks: PatchChunk[]) {
 const lines = content.split('\n')
 if (lines[lines.length - 1] === '') lines.pop()
 const replacements: Array<[number, number, string[]]> = []
 let cursor = 0
 for (const chunk of chunks) {
  const found = findChunk(lines, chunk.oldLines, cursor, chunk.isEndOfFile)
  if (found === undefined) throw new Error(formatMissingPatchChunkError(path, chunk.oldLines, nearestPatchPrefixLine(lines, chunk.oldLines, cursor)))
  const newLines = preserveMatchedIndent(lines.slice(found, found + chunk.oldLines.length), chunk.oldLines, chunk.newLines)
  replacements.push([found, chunk.oldLines.length, newLines])
  cursor = found + chunk.oldLines.length
 }
 for (const [start, oldLen, newLines] of replacements.sort((a, b) => b[0] - a[0])) {
  lines.splice(start, oldLen, ...newLines)
 }
 return `${lines.join('\n')}\n`
}

async function planPatchOperations(cwd: string, operations: PatchOperation[], readText: (absolutePath: string) => Promise<string>, exists: (absolutePath: string) => Promise<boolean>) {
 const plans: PlannedPatchFile[] = []
 for (const op of operations) {
  const absolutePath = resolvePatchPath(cwd, op.path)
  if (op.kind === 'add') {
   if (await exists(absolutePath)) throw new Error(`Patch failed in ${op.path}: file already exists.\nFix: use an update patch for existing files, or choose a new file path.`)
   plans.push({path: op.path, absolutePath, before: null, after: op.contents.endsWith('\n') ? op.contents : `${op.contents}\n`})
  } else if (op.kind === 'delete') {
   if (!(await exists(absolutePath))) throw new Error(`Failed to delete ${op.path}: file does not exist`)
   plans.push({path: op.path, absolutePath, before: await readText(absolutePath), after: null})
  } else {
   const before = await readText(absolutePath)
   plans.push({path: op.path, absolutePath, before, after: applyUpdate(op.path, before, op.chunks)})
  }
 }
 return plans
}

export async function planPatch(cwd: string, patchText: string, readText: (absolutePath: string) => Promise<string>, exists: (absolutePath: string) => Promise<boolean>) {
 return planPatchOperations(cwd, parsePatch(patchText), readText, exists)
}

function textResult(text: string, details: any = undefined) {
 return {content: [{type: 'text' as const, text}], details}
}

function emitTextUpdate(onUpdate: ToolUpdateFn, text: string, details: any = undefined) {
 onUpdate?.(textResult(text, details))
}

function ensureNotAborted(signal?: AbortSignal) {
 if (signal?.aborted) {
  throw new Error('Operation aborted')
 }
}

const fileMutationQueues = new Map<string, Promise<void>>()

async function withFileMutationQueue<T>(path: string, task: () => Promise<T>): Promise<T> {
 const previous = fileMutationQueues.get(path)
 let release = () => {}
 const current = new Promise<void>(resolve => {
  release = resolve
 })
 fileMutationQueues.set(path, current)

 if (previous) await previous
 try {
  return await task()
 } finally {
  release()
  if (fileMutationQueues.get(path) === current) {
   fileMutationQueues.delete(path)
  }
 }
}

function firstMismatchIndex(expected: string, actual: string) {
 const limit = Math.min(expected.length, actual.length)
 for (let i = 0; i < limit; i += 1) {
  if (expected.charCodeAt(i) !== actual.charCodeAt(i)) return i
 }
 return expected.length === actual.length ? -1 : limit
}

function writeVerificationError(pathArg: string, label: string, expected: string, actual: string) {
 const mismatch = firstMismatchIndex(expected, actual)
 const expectedBytes = Buffer.byteLength(expected, 'utf8')
 const actualBytes = Buffer.byteLength(actual, 'utf8')
 const suffix = mismatch === -1 ? 'length metadata mismatch' : `first mismatch at character ${mismatch} (expected code ${expected.charCodeAt(mismatch)}, got ${actual.charCodeAt(mismatch)})`
 return new Error(`Write verification failed for ${pathArg} after ${label}: expected ${expected.length} chars/${expectedBytes} bytes, got ${actual.length} chars/${actualBytes} bytes; ${suffix}.`)
}

function openFdMatches(fd: number, expected: Buffer) {
 if (fstatSync(fd).size !== expected.length) return false
 const scratch = verifyScratch ?? (verifyScratch = Buffer.allocUnsafe(256 * 1024))
 let offset = 0
 while (offset < expected.length) {
  const wanted = Math.min(scratch.length, expected.length - offset)
  let received = 0
  while (received < wanted) {
   const count = readSync(fd, scratch, received, wanted - received, offset + received)
   if (count === 0) return false
   received += count
  }
  if (expected.compare(scratch, 0, wanted, offset, offset + wanted) !== 0) return false
  offset += wanted
 }
 return true
}

function writtenBytesMatch(absolutePath: string, expected: Buffer) {
 const fd = openSync(absolutePath, 'r')
 try {
  return openFdMatches(fd, expected)
 } finally {
  closeSync(fd)
 }
}

function verifyWrittenBytes(absolutePath: string, pathArg: string, expected: Buffer, label: string) {
 if (!writtenBytesMatch(absolutePath, expected)) {
  const actual = readFileSync(absolutePath)
  throw writeVerificationError(pathArg, label, expected.toString('utf8'), actual.toString('utf8'))
 }
}

const writeDurability = () => process.env.TIA_FASTWRITE_FSYNC === '1'

function fsyncDirOf(absolutePath: string) {
 try {
  const fd = openSync(dirname(absolutePath), 'r')
  try {
   fsyncSync(fd)
  } finally {
   closeSync(fd)
  }
 } catch {}
}

function writeAllSync(fd: number, data: Buffer) {
 let written = 0
 while (written < data.length) {
  written += writeSync(fd, data, written, data.length - written)
 }
}

function atomicWriteVerifiedSync(absolutePath: string, pathArg: string, data: Buffer, signal?: AbortSignal) {
 let mode = 0o644
 let hadExisting = false
 let targetStat: ReturnType<typeof lstatSync> | undefined
 try {
  targetStat = lstatSync(absolutePath)
 } catch {}
 if (targetStat?.isSymbolicLink()) {
  writeFileSync(absolutePath, data)
  ensureNotAborted(signal)
  verifyWrittenBytes(absolutePath, pathArg, data, 'symlink-preserving write')
  return
 }
 if (targetStat) {
  mode = Number(targetStat.mode) & 0o777
  hadExisting = true
 }

 temporaryFileNonce += 1
 const tmpPath = `${absolutePath}.tmp.${process.pid}.${temporaryFileNonce}`
 const durable = writeDurability()
 try {
  const fd = openSync(tmpPath, 'wx+', mode)
  try {
   if (hadExisting) fchmodSync(fd, mode)
   writeAllSync(fd, data)
   if (durable) fsyncSync(fd)
   ensureNotAborted(signal)
   if (!openFdMatches(fd, data)) {
    throw new Error(`Write verification failed for ${pathArg} after temporary write.`)
   }
  } finally {
   closeSync(fd)
  }
  renameSync(tmpPath, absolutePath)
  if (durable) fsyncDirOf(absolutePath)
  ensureNotAborted(signal)
 } catch (error) {
  rmSync(tmpPath, {force: true})
  throw error
 }
}

function isAgentSkill(absolutePath: string, _cwd: string): boolean {
 if (basename(absolutePath) !== 'SKILL.md') return false
 if (absolutePath.includes('/node_modules/')) return false

 const agentDir = getAgentDir()
 const agentSkillsPrefix = join(agentDir, 'skills') + '/'
 if (absolutePath.startsWith(agentSkillsPrefix)) return true

 const posixPath = absolutePath.replace(/\\/g, '/')
 if (posixPath.includes('/.pi/skills/') || posixPath.includes('/.agents/skills/')) return true

 return false
}

type ReadWindow = {output: string; outputLines: number; outputBytes: number; hitLineLimit: boolean; hitByteLimit: boolean; firstLineExcess: number; totalLines: number}

function scanReadWindow(absolutePath: string, startLine: number, maxLines: number, maxBytes: number, unlimited: boolean, signal?: AbortSignal): ReadWindow {
 const fd = openSync(absolutePath, 'r')
 const chunk = readScratch ?? (readScratch = Buffer.allocUnsafe(READ_SCAN_CHUNK))
 try {
  let output = ''
  let carry: Buffer[] = []
  let carryBytes = 0
  let currentLine = 1
  let outputLines = 0
  let outputBytes = 0
  let hitLineLimit = false
  let hitByteLimit = false
  let firstLineExcess = 0
  let firstRead = true
  let lastByteWasNewline = false

  while (true) {
   ensureNotAborted(signal)
   const want = firstRead && startLine === 1 && !unlimited ? READ_FIRST_CHUNK : READ_SCAN_CHUNK
   firstRead = false
   const bytesRead = readSync(fd, chunk, 0, want, null)
   if (bytesRead <= 0) break
   lastByteWasNewline = chunk[bytesRead - 1] === 10
   let pos = 0
   let flushFrom = -1
   let flushTo = 0
   while (pos < bytesRead) {
    const newline = chunk.indexOf(10, pos)
    if (newline === -1 || newline >= bytesRead) {
     if (currentLine >= startLine) carry.push(Buffer.from(chunk.subarray(pos, bytesRead)))
     carryBytes += bytesRead - pos
     break
    }
    const lineBytes = carryBytes + newline + 1 - pos
    if (currentLine >= startLine) {
     if (outputLines >= maxLines) {
      hitLineLimit = true
      break
     }
     if (!unlimited && outputBytes + lineBytes > maxBytes) {
      hitByteLimit = true
      if (outputLines === 0) firstLineExcess = lineBytes
      break
     }
     if (carryBytes > 0) {
      carry.push(Buffer.from(chunk.subarray(pos, newline + 1)))
      output += Buffer.concat(carry).toString('utf8')
      carry = []
     } else {
      if (flushFrom === -1) flushFrom = pos
      flushTo = newline + 1
     }
     outputLines += 1
     outputBytes += lineBytes
    } else if (carry.length > 0) {
     carry = []
    }
    carryBytes = 0
    currentLine += 1
    pos = newline + 1
   }
   if (flushFrom !== -1) output += chunk.toString('utf8', flushFrom, flushTo)
   if (hitLineLimit || hitByteLimit) break
  }

  if (!hitLineLimit && !hitByteLimit && carryBytes > 0 && currentLine >= startLine) {
   if (!unlimited && outputLines === 0 && carryBytes > maxBytes) {
    hitByteLimit = true
    firstLineExcess = carryBytes
   } else if (outputLines >= maxLines) {
    hitLineLimit = true
   } else if (!unlimited && outputBytes + carryBytes > maxBytes) {
    hitByteLimit = true
   } else {
    output += (carry.length === 1 ? carry[0] : Buffer.concat(carry)).toString('utf8')
    outputLines += 1
    outputBytes += carryBytes
   }
  }

  return {output, outputLines, outputBytes, hitLineLimit, hitByteLimit, firstLineExcess, totalLines: Math.max(1, currentLine - (lastByteWasNewline ? 1 : 0))}
 } finally {
  closeSync(fd)
 }
}

export async function fastRead(cwd: string, pathArg: string, offset?: number, limit?: number, signal?: AbortSignal, onUpdate?: ToolUpdateFn) {
 ensureNotAborted(signal)

 const absolutePath = resolvePath(cwd, pathArg)
 const agentSkill = isAgentSkill(absolutePath, cwd)
 const startLine = Math.max(1, offset ?? 1)
 const maxLines = agentSkill ? Number.MAX_SAFE_INTEGER : (limit ?? DEFAULT_MAX_LINES)
 const window = scanReadWindow(absolutePath, startLine, maxLines, DEFAULT_MAX_BYTES, agentSkill, signal)

 if (!window.hitLineLimit && !window.hitByteLimit && startLine > window.totalLines) {
  throw new Error(`Offset ${offset} is beyond end of file (${window.totalLines} lines total)`)
 }

 if (onUpdate && window.output.length > 0) {
  emitTextUpdate(onUpdate, window.output)
 }

 const endLine = startLine + window.outputLines - 1
 const nextOffset = endLine + 1
 if (window.hitLineLimit) {
  return textResult(`${window.output}\n\n[Showing lines ${startLine}-${endLine}. Use offset=${nextOffset} to continue.]`, {truncation: {truncated: true, truncatedBy: 'lines', outputLines: window.outputLines}})
 }
 if (window.hitByteLimit) {
  if (window.outputLines === 0) {
   return textResult(`[Line ${startLine} is ${formatSize(window.firstLineExcess)}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash for partial reads.]`, {truncation: {truncated: true, firstLineExceedsLimit: true}})
  }
  return textResult(`${window.output}\n\n[Showing lines ${startLine}-${endLine} (${formatSize(window.outputBytes)} limit). Use offset=${nextOffset} to continue.]`, {truncation: {truncated: true, truncatedBy: 'bytes', outputLines: window.outputLines}})
 }
 return textResult(window.output)
}

export async function fastWrite(cwd: string, pathArg: string, content: string, signal?: AbortSignal) {
 const absolutePath = resolvePath(cwd, pathArg)

 return withFileMutationQueue(absolutePath, async () => {
  ensureNotAborted(signal)
  mkdirSync(dirname(absolutePath), {recursive: true})

  const data = Buffer.from(content, 'utf8')
  atomicWriteVerifiedSync(absolutePath, pathArg, data, signal)

  return textResult(`Successfully wrote and verified ${data.length} bytes to ${pathArg}`, {verified: true, bytes: data.length})
 })
}

export function normalizeEditParams(params: any): MultiReplacementEdit[] {
 if (typeof params.patch === 'string') {
  if (params.path !== undefined || params.oldText !== undefined || params.newText !== undefined || params.edits !== undefined || params.multi !== undefined) {
   throw new Error('The patch parameter is mutually exclusive with path/oldText/newText/edits/multi.')
  }
  return []
 }
 const edits: MultiReplacementEdit[] = []

 if (Array.isArray(params.edits)) {
  if (typeof params.path !== 'string') {
   throw new Error('Edit tool input is invalid. path is required when using edits[].')
  }
  for (const edit of params.edits) {
   if (typeof edit?.oldText !== 'string' || typeof edit?.newText !== 'string') {
    throw new Error('Edit tool input is invalid. Each edit needs string oldText and newText.')
   }
   if (edit.oldText.length === 0) throw new Error('Edit tool input is invalid. oldText must not be empty.')
   edits.push({path: params.path, oldText: edit.oldText, newText: edit.newText})
  }
 }

 if (Array.isArray(params.multi)) {
  for (const edit of params.multi) {
   const path = typeof edit?.path === 'string' ? edit.path : params.path
   if (typeof path !== 'string' || typeof edit?.oldText !== 'string' || typeof edit?.newText !== 'string') {
    throw new Error('Edit tool input is invalid. Each multi edit needs a path, oldText, and newText. The path can be inherited from top-level path.')
   }
   if (edit.oldText.length === 0) throw new Error('Edit tool input is invalid. oldText must not be empty.')
   edits.push({path, oldText: edit.oldText, newText: edit.newText})
  }
 }

 if (typeof params.oldText === 'string' || typeof params.newText === 'string') {
  if (typeof params.path !== 'string' || typeof params.oldText !== 'string' || typeof params.newText !== 'string') {
   throw new Error('Edit tool input is invalid. path, oldText, and newText must be provided together.')
  }
  if (params.oldText.length === 0) throw new Error('Edit tool input is invalid. oldText must not be empty.')
  edits.push({path: params.path, oldText: params.oldText, newText: params.newText})
 }

 if (edits.length === 0) {
  throw new Error('Edit tool input is invalid. edits must contain at least one replacement.')
 }

 return edits
}

async function withFileMutationQueues<T>(paths: string[], task: () => Promise<T>): Promise<T> {
 async function acquire(index: number): Promise<T> {
  if (index === paths.length) return task()
  return withFileMutationQueue(paths[index], () => acquire(index + 1))
 }
 return acquire(0)
}

function planMatchesCurrent(plan: PlannedFileEdit | PlannedPatchFile) {
 if (plan.before === null) return !existsSync(plan.absolutePath)
 try {
  return readFileSync(plan.absolutePath, 'utf8') === plan.before
 } catch {
  return false
 }
}

function assertPlanCurrent(plan: PlannedFileEdit | PlannedPatchFile) {
 if (!planMatchesCurrent(plan)) throw new Error(`Edit aborted for ${plan.path}: file changed after preflight. Reread it and retry.`)
}

async function restorePlan(plan: PlannedFileEdit | PlannedPatchFile) {
 if (plan.after === null) {
  if (!existsSync(plan.absolutePath) && plan.before !== null) await Bun.write(plan.absolutePath, plan.before)
  return
 }
 if (!existsSync(plan.absolutePath) || readFileSync(plan.absolutePath, 'utf8') !== plan.after) return
 if (plan.before === null) rmSync(plan.absolutePath, {force: true})
 else await Bun.write(plan.absolutePath, plan.before)
}

async function applyPlannedEditsUnlocked(plans: Array<PlannedFileEdit | PlannedPatchFile>, signal?: AbortSignal, restore: (plan: PlannedFileEdit | PlannedPatchFile) => Promise<void> = restorePlan) {
 if (plans.length === 0) throw new Error('No edit operations were planned.')
 ensureNotAborted(signal)
 for (const plan of plans) assertPlanCurrent(plan)
 const applied: Array<PlannedFileEdit | PlannedPatchFile> = []
 try {
  for (const plan of plans) {
   assertPlanCurrent(plan)
   if (plan.after === null) {
    rmSync(plan.absolutePath, {force: true})
   } else {
    const data = Buffer.from(plan.after, 'utf8')
    writeFileSync(plan.absolutePath, data)
    verifyWrittenBytes(plan.absolutePath, plan.path, data, 'edit write')
   }
   applied.push(plan)
   ensureNotAborted(signal)
  }
 } catch (error) {
  const rollbackErrors: Error[] = []
  for (let i = applied.length - 1; i >= 0; i -= 1) {
   try {
    await restore(applied[i])
   } catch (rollbackError) {
    rollbackErrors.push(new Error(`Rollback failed for ${applied[i].path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`, {cause: rollbackError}))
   }
  }
  if (rollbackErrors.length > 0) {
   throw new AggregateError([error, ...rollbackErrors], `Edit failed and ${rollbackErrors.length} rollback operation(s) also failed: ${rollbackErrors.map(item => item.message).join('; ')}`)
  }
  throw error
 }
 return textResult(`Successfully applied ${plans.length} file edit(s).`, {verified: true, files: plans.length, diff: combinedEditDiff(plans)})
}

export async function applyPlannedEdits(plans: Array<PlannedFileEdit | PlannedPatchFile>, signal?: AbortSignal, restore: (plan: PlannedFileEdit | PlannedPatchFile) => Promise<void> = restorePlan) {
 if (plans.length === 0) throw new Error('No edit operations were planned.')
 const uniquePaths = [...new Set(plans.map(plan => plan.absolutePath))].sort()
 return withFileMutationQueues(uniquePaths, () => applyPlannedEditsUnlocked(plans, signal, restore))
}

export async function fastPatch(cwd: string, patch: string, signal?: AbortSignal) {
 const operations = parsePatch(patch)
 const uniquePaths = [...new Set(operations.map(operation => resolvePatchPath(cwd, operation.path)))].sort()
 return withFileMutationQueues(uniquePaths, async () => {
  const plans = await planPatchOperations(
   cwd,
   operations,
   path => Bun.file(path).text(),
   path => Bun.file(path).exists()
  )
  return applyPlannedEditsUnlocked(plans, signal)
 })
}

export async function fastEdit(cwd: string, edits: MultiReplacementEdit[], signal?: AbortSignal) {
 if (edits.length === 1) {
  const edit = edits[0]
  const pathArg = edit.path!
  if (edit.oldText.length === 0) {
   throw new Error(`Edit 1 in ${pathArg} has empty oldText.`)
  }
  if (edit.oldText === edit.newText) {
   throw new Error(`No changes made to ${pathArg}. The replacement produced identical content.`)
  }
  const absolutePath = resolvePath(cwd, pathArg)
  return withFileMutationQueue(absolutePath, async () => {
   ensureNotAborted(signal)
   const before = readFileSync(absolutePath)
   const oldBytes = Buffer.from(edit.oldText, 'utf8')
   const firstIndex = before.indexOf(oldBytes)
   if (firstIndex === -1) {
    throw missingEditError(pathArg, 0, before.toString('utf8'), edit.oldText)
   }
   if (before.indexOf(oldBytes, firstIndex + oldBytes.length) !== -1) {
    throw duplicateEditError(pathArg, 0, before.toString('utf8'), edit.oldText)
   }
   const newBytes = Buffer.from(edit.newText, 'utf8')
   const after = Buffer.allocUnsafe(before.length - oldBytes.length + newBytes.length)
   before.copy(after, 0, 0, firstIndex)
   newBytes.copy(after, firstIndex)
   before.copy(after, firstIndex + newBytes.length, firstIndex + oldBytes.length)
   writeFileSync(absolutePath, after)
   if (!writtenBytesMatch(absolutePath, after)) {
    const actual = readFileSync(absolutePath)
    try {
     writeFileSync(absolutePath, before)
    } catch {}
    throw writeVerificationError(pathArg, 'edit write', after.toString('utf8'), actual.toString('utf8'))
   }
   ensureNotAborted(signal)
   const beforeText = before.toString('utf8')
   const afterText = after.toString('utf8')
   const beforeStart = beforeText.indexOf(edit.oldText)
   return textResult(`Successfully replaced 1 block(s) in ${pathArg}.`, {
    diff: combinedEditDiff([{path: pathArg, absolutePath, before: beforeText, after: afterText, editCount: 1, diffHint: {beforeStart, beforeEnd: beforeStart + edit.oldText.length, afterStart: beforeStart, afterEnd: beforeStart + edit.newText.length}}])
   })
  })
 }

 const classicEdits = edits.map(edit => ({path: edit.path!, oldText: edit.oldText, newText: edit.newText}))
 const uniquePaths = [...new Set(classicEdits.map(edit => resolveEditPath(cwd, edit.path)))].sort()
 return withFileMutationQueues(uniquePaths, async () => {
  const plans = await planClassicEdits(cwd, classicEdits, path => Bun.file(path).text())
  return applyPlannedEditsUnlocked(plans, signal)
 })
}

async function runBinary(cmd: string, args: string[], signal?: AbortSignal) {
 const proc = Bun.spawn([cmd, ...args], {stdout: 'ignore', stderr: 'ignore', signal})
 const exitCode = await proc.exited
 if (signal?.aborted) throw new Error('Operation aborted')
 if (exitCode !== 0) {
  throw new Error(`${cmd} exited with code ${exitCode}`)
 }
}

function statKind(path: string): 'file' | 'dir' | 'other' | 'missing' {
 try {
  const stats = lstatSync(path)
  if (stats.isSymbolicLink()) {
   try {
    return statSync(path).isDirectory() ? 'dir' : 'file'
   } catch {
    return 'other'
   }
  }
  if (stats.isDirectory()) return 'dir'
  if (stats.isFile()) return 'file'
  return 'other'
 } catch {
  return 'missing'
 }
}

function safeShellPathToken(token: string) {
 return token.length > 0 && token.charCodeAt(0) !== 45 && !/[\\'"`$*?[\]{}();<>|&!]/.test(token)
}

export function planOptimizedBash(cwd: string, command: string): OptimizedBashStep[] | null {
 const parts = command
  .split('&&')
  .map(part => part.trim())
  .filter(Boolean)

 if (parts.length === 0) {
  return null
 }

 const steps: OptimizedBashStep[] = []
 const created = new Set<string>()

 for (const part of parts) {
  const catMatch = part.match(/^cat\s+(\S+)\s*>\s*\/dev\/null$/)
  if (catMatch) {
   if (!safeShellPathToken(catMatch[1])) return null
   const file = resolvePath(cwd, catMatch[1])
   if (statKind(file) !== 'file' && !created.has(file)) return null
   steps.push({
    description: `drain ${catMatch[1]}`,
    run: async () => {
     if (existsSync(FASTDRAIN_BIN())) {
      await runBinary(FASTDRAIN_BIN(), [file])
     } else {
      await Bun.file(file).arrayBuffer()
     }
    }
   })
   continue
  }

  const cpMatch = part.match(/^cp\s+(\S+)\s+(\S+)$/)
  if (cpMatch) {
   if (!safeShellPathToken(cpMatch[1]) || !safeShellPathToken(cpMatch[2])) return null
   const src = resolvePath(cwd, cpMatch[1])
   const dst = resolvePath(cwd, cpMatch[2])
   if (statKind(src) !== 'file' && !created.has(src)) return null
   if (statKind(dst) === 'dir') return null
   created.add(dst)
   steps.push({
    description: `copy ${cpMatch[1]} -> ${cpMatch[2]}`,
    run: async () => {
     mkdirSync(dirname(dst), {recursive: true})
     if (existsSync(FASTCOPY_BIN())) {
      await runBinary(FASTCOPY_BIN(), [src, dst])
     } else {
      await Bun.write(dst, Bun.file(src))
     }
    }
   })
   continue
  }

  const rmMatch = part.match(/^rm\s+(\S+)$/)
  if (rmMatch) {
   if (!safeShellPathToken(rmMatch[1])) return null
   const target = resolvePath(cwd, rmMatch[1])
   const kind = statKind(target)
   if (kind === 'dir' || (kind === 'missing' && !created.has(target))) return null
   created.delete(target)
   steps.push({
    description: `rm ${rmMatch[1]}`,
    run: async () => {
     rmSync(target, {force: true})
    }
   })
   continue
  }

  return null
 }

 return steps
}

async function tryOptimizedBash(cwd: string, command: string, signal?: AbortSignal, onUpdate?: ToolUpdateFn) {
 const steps = planOptimizedBash(cwd, command)
 if (!steps) {
  return false
 }

 const updates: string[] = []
 for (let i = 0; i < steps.length; i += 1) {
  ensureNotAborted(signal)
  updates.push(`[fast path ${i + 1}/${steps.length}] ${steps[i].description}`)
  emitTextUpdate(onUpdate, updates.join('\n'))
  await steps[i].run()
 }

 return true
}

export default function (pi: ExtensionAPI) {
 installGptSelectorFilter()

 const stockRead = createReadToolDefinition(process.cwd())
 const stockWrite = createWriteToolDefinition(process.cwd())
 const stockBash = createBashToolDefinition(process.cwd())
 let remappingSelectorModel = false

 pi.on('model_select', async (event, ctx) => {
  if (remappingSelectorModel || event.model.provider !== 'github-copilot' || event.model.id !== 'gpt-5.6-sol') return

  const target = ctx.modelRegistry.find('openai-codex', 'gpt-5.6-sol')
  if (!target) return

  remappingSelectorModel = true
  try {
   await pi.setModel(target)
  } finally {
   remappingSelectorModel = false
  }
 })

 pi.registerTool({
  name: 'read',
  label: 'read',
  description: 'Read the contents of a file using an in-process zero-spawn windowed byte scanner. Supports offset/limit windows and returns truncated output with continuation hints.',
  parameters: readSchema,
  renderShell: stockRead.renderShell,
  renderCall: stockRead.renderCall,
  renderResult: stockRead.renderResult,
  async execute(_toolCallId, params, signal, onUpdate, ctx) {
   const typedOnUpdate: ToolUpdateFn = onUpdate
   return fastRead(ctx.cwd, params.path, params.offset, params.limit, signal, typedOnUpdate)
  }
 })

 pi.registerTool({
  name: 'write',
  label: 'write',
  description: 'Write content to a file atomically (temp file + rename) with byte-for-byte read-back verification.',
  parameters: writeSchema,
  renderShell: stockWrite.renderShell,
  renderCall: stockWrite.renderCall,
  renderResult: stockWrite.renderResult,
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
   return fastWrite(ctx.cwd, params.path, params.content, signal)
  }
 })

 pi.registerTool({
  name: 'edit',
  label: 'edit',
  description: editToolDescription,
  promptSnippet: editToolPromptSnippet,
  parameters: editSchema,
  renderShell: 'default',
  renderCall(args, theme, context) {
   const text = context.lastComponent instanceof Text ? context.lastComponent : new Text('', 0, 0)
   const mode = editDisplayMode(args)
   const target = editDisplayTarget(args)
   const renderedMode = mode ? theme.fg('dim', ` ${mode}`) : ''
   text.setText(`${theme.fg('toolTitle', theme.bold('edit'))}${renderedMode} ${theme.fg('accent', target)}`)
   return text
  },
  renderResult(result, options, theme, context) {
   const component = context.lastComponent instanceof Container ? context.lastComponent : new Container()
   component.clear()
   const details = editResultDetails(result.details)
   const output = textContentOutput(result.content)
   const body = !context.isError && typeof details?.diff === 'string' && details.diff.length > 0 ? renderDiffText(details.diff, theme) : theme.fg('toolOutput', output)
   if (!body) return component
   component.addChild(new Spacer(1))
   component.addChild(new Text(renderLimitedText(body, Boolean(options.expanded), 10, theme), 0, 0))
   return component
  },
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
   if (typeof params.patch === 'string') {
    return fastPatch(ctx.cwd, params.patch, signal)
   }
   return fastEdit(ctx.cwd, normalizeEditParams(params), signal)
  }
 })

 pi.registerTool({
  name: 'bash',
  label: 'bash',
  description: 'Execute bash commands with fast paths for common file drain/copy/remove commands and a stock fallback for everything else.',
  parameters: bashSchema,
  renderShell: stockBash.renderShell,
  renderCall: stockBash.renderCall,
  renderResult: stockBash.renderResult,
  async execute(toolCallId, params, signal, onUpdate, ctx) {
   const typedOnUpdate: ToolUpdateFn = onUpdate
   if (await tryOptimizedBash(ctx.cwd, params.command, signal, typedOnUpdate)) {
    return textResult('(no output)')
   }

   const fastDir = fastToolsDir()
   const helperPath = existsSync(fastDir) ? `${fastDir}:${process.env.PATH ?? ''}` : (process.env.PATH ?? '')
   const stock = createBashTool(ctx.cwd, {spawnHook: ({command, cwd, env}) => ({command, cwd, env: {...(env ?? process.env), PATH: helperPath}})})
   return stock.execute(toolCallId, params, signal, onUpdate)
  }
 })
}
