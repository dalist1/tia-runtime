import {closeSync, existsSync, fchmodSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, readSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync} from 'node:fs'
import {homedir} from 'node:os'
import {basename, dirname, join, resolve} from 'node:path'
import {createBashTool, createBashToolDefinition, createReadToolDefinition, createWriteToolDefinition, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type ExtensionAPI, formatSize, getAgentDir} from '@earendil-works/pi-coding-agent'
import {Container, Spacer, Text} from '@earendil-works/pi-tui'
import {Type} from '@sinclair/typebox'

const fastToolsDir = () => join(getAgentDir(), 'fast-tools')
const FASTDRAIN_BIN = () => join(fastToolsDir(), 'fastdrain')
const FASTCOPY_BIN = () => join(fastToolsDir(), 'fastcopy')
const READ_SCAN_CHUNK = 256 * 1024
const READ_FIRST_CHUNK = 64 * 1024
const INLINE_FILE_LIMIT = 256 * 1024

let readScratch: Buffer | null = null
let verifyScratch: Buffer | null = null
let temporaryFileNonce = Date.now()

type TextBlock = {type: 'text'; text: string}
type TextToolUpdate = {content: TextBlock[]; details: any}

type ToolUpdateFn = ((update: TextToolUpdate) => void) | undefined

type OptimizedBashStep = {description: string; run: (signal?: AbortSignal) => Promise<void>}

type ReplacementEdit = {oldText: string; newText: string}
type MultiReplacementEdit = ReplacementEdit & {path?: string}
type ClassicEdit = {path: string; oldText: string; newText: string}
type DiffHint = {beforeStart: number; beforeEnd: number; afterStart: number; afterEnd: number}
type PlannedFileEdit = {path: string; absolutePath: string; before: string; after: string; editCount: number; diffHint?: DiffHint}
type PatchOperation = {kind: 'add'; path: string; contents: string} | {kind: 'delete'; path: string; chunks?: PatchChunk[]} | {kind: 'update'; path: string; chunks: PatchChunk[]; movePath?: string}
type PatchChunk = {oldLines: string[]; newLines: string[]; context: number[]; isEndOfFile: boolean; oldStart?: number; anchor?: string; oldNoNewline?: boolean; newNoNewline?: boolean}
type PlannedPatchFile = {path: string; absolutePath: string; before: string | null; after: string | null; moveFrom?: string}
type FileSnapshot = {mode: number; link?: string}
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
 let trimmed = path.split('\t')[0].trim()
 if (trimmed.startsWith('"')) {
  const quoted = path.match(/^"((?:[^"\\]|\\.)*)"(?:\t.*)?$/)
  if (!quoted) throw new Error(`Invalid quoted patch path: ${path}`)
  const bytes: number[] = []
  for (let i = 0; i < quoted[1].length;) {
   if (quoted[1][i] !== '\\') {
    const code = quoted[1].codePointAt(i)!
    bytes.push(...Buffer.from(String.fromCodePoint(code)))
    i += code > 0xffff ? 2 : 1
    continue
   }
   const escape = quoted[1].slice(i + 1).match(/^[0-7]{1,3}/)?.[0]
   if (escape) {
    bytes.push(parseInt(escape, 8))
    i += 1 + escape.length
   } else {
    const escapes: Record<string, string> = {t: '\t', n: '\n', r: '\r', b: '\b', f: '\f', v: '\v', a: '\x07', '\\': '\\', '"': '"'}
    const value = escapes[quoted[1][i + 1]]
    if (value === undefined) throw new Error(`Invalid escape in patch path: ${path}`)
    bytes.push(...Buffer.from(value))
    i += 2
   }
  }
  trimmed = Buffer.from(bytes).toString('utf8')
 }
 if (trimmed === '/dev/null') return ''
 if (trimmed.startsWith('a/') || trimmed.startsWith('b/')) return trimmed.slice(2)
 return trimmed
}

function patchOperationPaths(patchText: string) {
 const paths: string[] = []
 const displayPath = (path: string) => {
  try {
   return normalizeUnifiedDiffPath(path)
  } catch {
   return path
  }
 }
 for (const line of patchText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')) {
  const match = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/)
  if (match) paths.push(match[1])
  const oldFile = line.match(/^---\s+(.+)$/)
  const newFile = line.match(/^\+\+\+\s+(.+)$/)
  if (oldFile) paths.push(displayPath(oldFile[1]))
  if (newFile) paths.push(displayPath(newFile[1]))
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
 return left.slice(leftStart, leftEnd) === right.slice(rightStart, rightEnd)
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
 return left.slice(leftStart, leftEnd) === right.slice(rightStart, rightEnd)
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

export function renderEditDiff(diff: string, expanded: boolean, theme: any) {
 if (expanded) return renderDiffText(diff, theme)
 let end = -1
 for (let line = 0; line < 10; line++) {
  end = diff.indexOf('\n', end + 1)
  if (end === -1) return renderDiffText(diff, theme)
 }
 return renderDiffText(diff.slice(0, end), theme) + theme.fg('muted', `\n... (${countNewlines(diff, end)} more lines, ctrl+o to expand)`)
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
  index = content.indexOf(oldText, index + 1)
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
 return resolvePath(cwd, path)
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

  const secondIndex = content.indexOf(edit.oldText, firstIndex + 1)
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

const readSchema = Type.Object({
 path: Type.String({description: 'Path to the file to read (relative or absolute)'}),
 offset: Type.Optional(Type.Integer({minimum: 1, description: 'Line number to start reading from (1-indexed)'})),
 limit: Type.Optional(Type.Integer({minimum: 1, description: 'Maximum number of lines to read'}))
})

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
 if (!path.trim()) throw new Error('Patch path cannot be empty')
 return resolvePath(cwd, path)
}

function parseUpdateChunk(lines: string[], startIndex: number, lastContentLine: number) {
 let i = startIndex
 const header = lines[i]
 const range = header.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/)
 if (header.startsWith('@@ -') && !range) throw new Error(`Invalid unified hunk header: ${header}`)
 const oldCount = range ? Number(range[2] ?? 1) : undefined
 const newCount = range ? Number(range[4] ?? 1) : undefined
 const oldStart = range ? Number(range[1]) - (oldCount === 0 ? 0 : 1) : undefined
 if (range && (![oldStart!, oldCount!, Number(range[3]), newCount!].every(Number.isSafeInteger) || oldStart! < 0)) throw new Error(`Invalid unified hunk range: ${header}`)
 const anchor = !range && header.startsWith('@@ ') ? header.slice(3) : undefined
 if (header.startsWith('@@')) i += 1
 const oldLines: string[] = []
 const newLines: string[] = []
 const context: number[] = []
 let parsed = 0
 let isEndOfFile = false
 let oldNoNewline = false
 let newNoNewline = false
 let previousMarker = ''
 while (i <= lastContentLine) {
  const raw = lines[i]
  if (raw === '\\ No newline at end of file') {
   if (!previousMarker) throw new Error('No-newline marker must follow a hunk line')
   if (previousMarker !== '+') oldNoNewline = true
   if (previousMarker !== '-') newNoNewline = true
   previousMarker = ''
   i += 1
   continue
  }
  if (raw === '*** End of File') {
   isEndOfFile = true
   i += 1
   break
  }
  if (range && oldLines.length === oldCount && newLines.length === newCount) break
  if (raw.startsWith('@@') || raw.startsWith('*** ') || isGitFileHeader(raw)) break
  if (!range && isUnifiedFileHeader(lines, i, lastContentLine)) break
  const marker = raw.length === 0 ? ' ' : raw[0]
  const body = raw.slice(1)
  if ((oldNoNewline && marker !== '+') || (newNoNewline && marker !== '-')) throw new Error('No-newline marker must describe the last line of the file')
  if (marker === ' ') {
   context.push(oldLines.length)
   oldLines.push(body)
   newLines.push(body)
  } else if (marker === '-') {
   oldLines.push(body)
  } else if (marker === '+') {
   newLines.push(body)
   context.push(-1)
  } else if (parsed === 0) {
   throw new Error(`Unexpected line found in update hunk: '${raw}'.`)
  } else {
   break
  }
  previousMarker = marker
  parsed += 1
  i += 1
  if (range && (oldLines.length > oldCount! || newLines.length > newCount!)) throw new Error(`Unified hunk line count mismatch: ${header}`)
 }
 if (range && (oldLines.length !== oldCount || newLines.length !== newCount)) throw new Error(`Unified hunk line count mismatch (truncated hunk): ${header}`)
 if (parsed === 0 && (!range || oldCount !== 0 || newCount !== 0)) throw new Error('Update hunk does not contain any lines')
 return {chunk: {oldLines, newLines, context, isEndOfFile, oldStart, anchor, oldNoNewline, newNoNewline}, nextIndex: i}
}

function patchHeaderError(line: string) {
 return new Error(
  `'${line}' is not a valid patch file header.\nAccepted patch forms:\n1. Bare unified diff: --- a/path, +++ b/path, @@ ...\n2. Git diff: diff --git a/path b/path, then ---/+++ and @@ hunks\n3. Apply-patch wrapper: *** Begin Patch / *** Update File: path / @@ ... / *** End Patch\n4. Add/delete: *** Add File: path or *** Delete File: path\n\nDo not start with @@; include a file header first.`
 )
}

function normalizePatchText(patchText: string) {
 const normalized = patchText
  .replace(/\r\n/g, '\n')
  .replace(/\r/g, '\n')
  .replace(/^\n+|\n+$/g, '')
 if (!normalized) throw new Error('Patch payload is empty.')
 if (normalized.startsWith('*** Begin Patch')) return normalized
 return `*** Begin Patch\n${normalized}\n*** End Patch`
}

function isUnifiedFileHeader(lines: string[], index: number, lastContentLine: number) {
 return index + 1 <= lastContentLine && /^---\s+/.test(lines[index]) && /^\+\+\+\s+/.test(lines[index + 1])
}

function isGitFileHeader(line: string) {
 return line.startsWith('diff --git ')
}

function parseUnifiedPath(line: string, marker: '---' | '+++') {
 return normalizeUnifiedDiffPath(line.slice(marker.length).trimStart())
}

function parseUnifiedDiffOperation(lines: string[], startIndex: number, lastContentLine: number) {
 const oldPath = parseUnifiedPath(lines[startIndex], '---')
 const newPath = parseUnifiedPath(lines[startIndex + 1], '+++')
 if (!oldPath && !newPath) throw patchHeaderError(lines[startIndex])
 const path = oldPath || newPath
 let i = startIndex + 2
 const chunks: PatchChunk[] = []
 while (i <= lastContentLine) {
  if (!lines[i].trim()) {
   i += 1
   continue
  }
  if (!lines[i].startsWith('@@')) break
  const parsed = parseUpdateChunk(lines, i, lastContentLine)
  chunks.push(parsed.chunk)
  i = parsed.nextIndex
 }
 if (chunks.length === 0) throw new Error(`Unified diff for path '${path}' has no hunks.`)
 if (!oldPath) {
  if (chunks.some(chunk => chunk.oldLines.length > 0 || chunk.oldStart !== 0)) throw new Error(`Invalid add hunk for ${path}`)
  const contents = applyUpdate(path, '', chunks)
  return {operation: {kind: 'add' as const, path, contents}, nextIndex: i}
 }
 if (!newPath) return {operation: {kind: 'delete' as const, path, chunks}, nextIndex: i}
 return {operation: {kind: 'update' as const, path, chunks, movePath: oldPath !== newPath ? newPath : undefined}, nextIndex: i}
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
  if (line.startsWith('diff --git ')) {
   let next = i + 1
   while (next <= lastContentLine && !isGitFileHeader(lines[next]) && !lines[next].startsWith('*** ') && !isUnifiedFileHeader(lines, next, lastContentLine)) next += 1
   if (!isUnifiedFileHeader(lines, next, lastContentLine)) throw new Error('Git metadata-only or binary patches are not supported; use explicit Add/Delete/Update File operations.')
   i += 1
   continue
  }
  if (line.startsWith('new file mode ') && line !== 'new file mode 100644') throw new Error('File mode changes are not supported by patch; set permissions explicitly with bash.')
  if (line.startsWith('index ') || line.startsWith('new file mode ') || line.startsWith('deleted file mode ') || line.startsWith('similarity index ') || line.startsWith('rename from ') || line.startsWith('rename to ')) {
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
   if (isUnifiedFileHeader(lines, i, lastContentLine)) {
    const parsed = parseUnifiedDiffOperation(lines, i, lastContentLine)
    if (parsed.operation.kind !== 'add' || parsed.operation.path !== path) throw new Error(`Mismatched add headers for ${path}`)
    operations.push(parsed.operation)
    i = parsed.nextIndex
    continue
   }
   const contentLines: string[] = []
   while (i <= lastContentLine && !lines[i].startsWith('*** ') && !isGitFileHeader(lines[i]) && !isUnifiedFileHeader(lines, i, lastContentLine)) {
    if (lines[i].trim().startsWith('\\ No newline')) {
     i += 1
     continue
    }
    contentLines.push(lines[i].startsWith('+') ? lines[i].slice(1) : lines[i])
    i += 1
   }
   operations.push({kind: 'add', path, contents: contentLines.length ? `${contentLines.join('\n')}\n` : ''})
   continue
  }
  if (line.startsWith('*** Delete File: ')) {
   const path = line.slice('*** Delete File: '.length)
   i += 1
   if (isUnifiedFileHeader(lines, i, lastContentLine)) {
    const parsed = parseUnifiedDiffOperation(lines, i, lastContentLine)
    if (parsed.operation.kind !== 'delete' || parsed.operation.path !== path) throw new Error(`Mismatched delete headers for ${path}`)
    operations.push(parsed.operation)
    i = parsed.nextIndex
   } else operations.push({kind: 'delete', path})
   continue
  }
  if (line.startsWith('*** Update File: ')) {
   const path = line.slice('*** Update File: '.length)
   i += 1
   let movePath: string | undefined
   if (lines[i]?.startsWith('*** Move to: ')) movePath = lines[i++].slice('*** Move to: '.length)
   if (isUnifiedFileHeader(lines, i, lastContentLine)) i += 2
   const chunks: PatchChunk[] = []
   while (i <= lastContentLine && !lines[i].startsWith('*** ') && !isUnifiedFileHeader(lines, i, lastContentLine) && !isGitFileHeader(lines[i])) {
    if (!lines[i].trim()) {
     i += 1
     continue
    }
    const parsed = parseUpdateChunk(lines, i, lastContentLine)
    chunks.push(parsed.chunk)
    i = parsed.nextIndex
   }
   if (chunks.length === 0) throw new Error(`Update file hunk for path '${path}' is empty`)
   operations.push({kind: 'update', path, chunks, movePath})
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

function findChunk(lines: string[], pattern: string[], start: number, eof: boolean, preferred?: number) {
 const end = lines.length - pattern.length
 if (eof && end < start) return undefined
 const searchStart = eof ? end : start
 for (const normalize of [(line: string) => line, (line: string) => line.trimEnd(), normalizedLine]) {
  const expected = pattern.map(normalize)
  const matchesAt = (at: number) => at >= searchStart && at <= end && expected.every((line, index) => normalize(lines[at + index]) === line)
  if (preferred !== undefined && matchesAt(preferred)) return preferred
  let found: number | undefined
  for (let i = searchStart; i <= end; i += 1) {
   if (!matchesAt(i)) continue
   if (found !== undefined) throw new Error('Patch hunk is ambiguous; multiple matching locations were found. Add context, a section anchor, or a numbered hunk.')
   found = i
  }
  if (found !== undefined) return found
 }
 return undefined
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
 return newLines.map(line => (line.trim().length > 0 ? `${actualIndent}${line}` : line))
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

function patchLineEnding(line: string) {
 return line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : ''
}

function patchLineText(line: string) {
 const ending = patchLineEnding(line)
 return ending ? line.slice(0, -ending.length) : line
}

function applyUpdate(path: string, content: string, chunks: PatchChunk[]) {
 const records = content.match(/[^\n]*\n|[^\n]+$/g) ?? []
 const lines = records.map(patchLineText)
 const firstNewline = content.indexOf('\n')
 const newline = firstNewline > 0 && content.charCodeAt(firstNewline - 1) === 13 ? '\r\n' : '\n'
 const output: string[] = []
 let cursor = 0
 for (const chunk of chunks) {
  let searchStart = cursor
  if (chunk.anchor) {
   const anchor = findChunk(lines, [chunk.anchor], cursor, false)
   if (anchor === undefined) throw new Error(`Patch failed in ${path}: section anchor '${chunk.anchor}' was not found.`)
   searchStart = anchor + 1
  }
  const found = chunk.oldLines.length === 0 ? (chunk.oldStart ?? (chunk.anchor ? searchStart : lines.length)) : findChunk(lines, chunk.oldLines, searchStart, chunk.isEndOfFile || Boolean(chunk.oldNoNewline), chunk.oldStart)
  if (found === undefined) throw new Error(formatMissingPatchChunkError(path, chunk.oldLines, nearestPatchPrefixLine(lines, chunk.oldLines, cursor)))
  if (found < cursor || found > lines.length) throw new Error(`Patch failed in ${path}: overlapping or out-of-range hunk.`)
  if (chunk.oldNoNewline && records.at(-1)?.endsWith('\n')) throw new Error(`Patch failed in ${path}: expected no newline at end of file.`)
  if (chunk.newNoNewline && found + chunk.oldLines.length !== lines.length) throw new Error(`Patch failed in ${path}: no-newline marker is not at end of file.`)
  for (let i = cursor; i < found; i += 1) output.push(records[i])
  const newLines = preserveMatchedIndent(lines.slice(found, found + chunk.oldLines.length), chunk.oldLines, chunk.newLines)
  for (let i = 0; i < newLines.length; i += 1) {
   const oldIndex = chunk.context[i]
   output.push(oldIndex >= 0 ? records[found + oldIndex] : newLines[i] + newline)
  }
  if (newLines.length && found + chunk.oldLines.length === lines.length) {
   const index = output.length - 1
   if (chunk.newNoNewline) output[index] = patchLineText(output[index])
   else if (chunk.oldStart !== undefined) output[index] = patchLineText(output[index]) + newline
   else if (records.length && chunk.oldLines.length) output[index] = patchLineText(output[index]) + patchLineEnding(records[records.length - 1])
  }
  cursor = found + chunk.oldLines.length
 }
 for (let i = cursor; i < records.length; i += 1) output.push(records[i])
 return output.map((record, index) => (record.endsWith('\n') || index === output.length - 1 ? record : record + newline)).join('')
}

async function planPatchOperations(cwd: string, operations: PatchOperation[], readText: (absolutePath: string) => Promise<string>, exists: (absolutePath: string) => Promise<boolean>) {
 const plans = new Map<string, PlannedPatchFile>()
 const load = async (path: string) => {
  const absolutePath = resolvePatchPath(cwd, path)
  let plan = plans.get(absolutePath)
  if (!plan) {
   const before = (await exists(absolutePath)) ? await readText(absolutePath) : null
   plan = {path, absolutePath, before, after: before}
   plans.set(absolutePath, plan)
  }
  return plan
 }
 for (const op of operations) {
  const plan = await load(op.path)
  if (op.kind === 'add') {
   if (plan.after !== null) throw new Error(`Patch failed in ${op.path}: file already exists.\nFix: use an update patch for existing files, or choose a new file path.`)
   plan.after = op.contents
  } else {
   if (plan.after === null) throw new Error(`Patch failed in ${op.path}: file does not exist`)
   if (op.kind === 'delete') {
    if (op.chunks && applyUpdate(op.path, plan.after, op.chunks) !== '') throw new Error(`Patch failed in ${op.path}: delete hunks do not cover the complete file.`)
    plan.after = null
   } else {
    const after = applyUpdate(op.path, plan.after, op.chunks)
    if (op.movePath && resolvePatchPath(cwd, op.movePath) !== plan.absolutePath) {
     const destination = await load(op.movePath)
     if (destination.after !== null) throw new Error(`Patch failed in ${op.movePath}: move destination already exists.`)
     destination.after = after
     destination.moveFrom = plan.absolutePath
     plan.after = null
    } else plan.after = after
   }
  }
 }
 return [...plans.values()].filter(plan => plan.before !== plan.after)
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

function mutationKey(path: string): string {
 try {
  return realpathSync(path)
 } catch (error) {
  if (!isRecord(error) || error.code !== 'ENOENT') throw error
  const parent = dirname(path)
  if (parent === path) return path
  return join(mutationKey(parent), basename(path))
 }
}

async function withFileMutationQueue<T>(path: string, task: () => Promise<T>): Promise<T> {
 return withFileMutationQueues([path], task)
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
 const fd = openSync(dirname(absolutePath), 'r')
 try {
  fsyncSync(fd)
 } finally {
  closeSync(fd)
 }
}

function writeAllSync(fd: number, data: Buffer) {
 let written = 0
 while (written < data.length) {
  const count = writeSync(fd, data, written, data.length - written)
  if (count <= 0) throw new Error('Write made no progress')
  written += count
 }
}

function atomicWriteVerifiedSync(absolutePath: string, pathArg: string, data: Buffer, signal?: AbortSignal, requestedMode?: number) {
 ensureNotAborted(signal)
 let mode = requestedMode ?? 0o666
 let hadExisting = false
 let targetStat: ReturnType<typeof lstatSync> | undefined
 try {
  targetStat = lstatSync(absolutePath)
 } catch (error) {
  if (!isRecord(error) || error.code !== 'ENOENT') throw error
 }
 if (targetStat?.isSymbolicLink()) {
  const before = readFileSync(absolutePath)
  try {
   writeFileSync(absolutePath, data)
   verifyWrittenBytes(absolutePath, pathArg, data, 'symlink-preserving write')
   if (writeDurability()) {
    const fd = openSync(absolutePath, 'r+')
    try {
     fsyncSync(fd)
    } finally {
     closeSync(fd)
    }
   }
   ensureNotAborted(signal)
  } catch (error) {
   try {
    writeFileSync(absolutePath, before)
    verifyWrittenBytes(absolutePath, pathArg, before, 'rollback')
   } catch (rollbackError) {
    throw new AggregateError([error, rollbackError], `Write failed for ${pathArg}; rollback also failed`, {cause: error})
   }
   throw error
  }
  return
 }
 if (targetStat) {
  if (!targetStat.isFile()) throw new Error(`Cannot write non-regular file: ${pathArg}`)
  mode = Number(targetStat.mode) & 0o777
  hadExisting = true
 }

 temporaryFileNonce += 1
 const tmpPath = `${absolutePath}.tmp.${process.pid}.${temporaryFileNonce}`
 const durable = writeDurability()
 try {
  const fd = openSync(tmpPath, 'wx+', mode)
  try {
   if (hadExisting || requestedMode !== undefined) fchmodSync(fd, mode)
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

class ImageReadRequired extends Error {}

function isImageHeader(bytes: Buffer) {
 return (
  (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.readUInt32BE(4) === 0x0d0a1a0a) ||
  (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
  (bytes[0] === 0x47 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) ||
  (bytes[0] === 0x52 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') ||
  (bytes[0] === 0x42 && bytes[1] === 0x4d)
 )
}

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
   let bytesRead = readSync(fd, chunk, 0, want, null)
   while (firstRead && bytesRead > 0 && bytesRead < 12) {
    const count = readSync(fd, chunk, bytesRead, 12 - bytesRead, null)
    if (!count) break
    bytesRead += count
   }
   if (bytesRead <= 0) break
   if (firstRead && isImageHeader(chunk.subarray(0, bytesRead))) throw new ImageReadRequired('Read this image with the stock image reader')
   firstRead = false
   lastByteWasNewline = chunk[bytesRead - 1] === 10
   const scanned = bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead)
   let pos = 0
   let flushFrom = -1
   let flushTo = 0
   while (pos < bytesRead) {
    const newline = scanned.indexOf(10, pos)
    if (newline === -1 || newline >= bytesRead) {
     carryBytes += bytesRead - pos
     if (currentLine >= startLine) {
      if (outputLines >= maxLines) {
       hitLineLimit = true
       break
      }
      if (!unlimited && outputBytes + carryBytes > maxBytes) {
       carry = []
       if (outputLines > 0) {
        hitByteLimit = true
        break
       }
      } else {
       carry.push(Buffer.from(chunk.subarray(pos, bytesRead)))
      }
     }
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
 if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 1)) throw new Error('offset must be a positive integer')
 if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error('limit must be a positive integer')

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

export async function withFileMutationQueues<T>(paths: string[], task: () => Promise<T>): Promise<T> {
 paths = [...new Set(paths.map(mutationKey))].sort()
 const previous = [...new Set(paths.map(path => fileMutationQueues.get(path)).filter(queue => queue !== undefined))]
 let release = () => {}
 const current = new Promise<void>(resolve => {
  release = resolve
 })
 for (const path of paths) fileMutationQueues.set(path, current)
 try {
  if (previous.length) await Promise.all(previous)
  return await task()
 } finally {
  release()
  for (const path of paths) if (fileMutationQueues.get(path) === current) fileMutationQueues.delete(path)
 }
}

function planMatchesCurrent(plan: PlannedFileEdit | PlannedPatchFile) {
 if (plan.before === null) return lstatSync(plan.absolutePath, {throwIfNoEntry: false}) === undefined
 try {
  return readFileSync(plan.absolutePath, 'utf8') === plan.before
 } catch {
  return false
 }
}

function assertPlanCurrent(plan: PlannedFileEdit | PlannedPatchFile) {
 if (!planMatchesCurrent(plan)) throw new Error(`Edit aborted for ${plan.path}: file changed after preflight. Reread it and retry.`)
}

async function restorePlan(plan: PlannedFileEdit | PlannedPatchFile, snapshot?: FileSnapshot) {
 if (planMatchesCurrent(plan)) return
 if (plan.after === null) {
  if (existsSync(plan.absolutePath)) throw new Error('File changed during rollback; external contents preserved')
  if (plan.before !== null) {
   if (snapshot?.link !== undefined) symlinkSync(snapshot.link, plan.absolutePath)
   else atomicWriteVerifiedSync(plan.absolutePath, plan.path, Buffer.from(plan.before), undefined, snapshot?.mode)
  }
  return
 }
 if (!existsSync(plan.absolutePath) || readFileSync(plan.absolutePath, 'utf8') !== plan.after) throw new Error('File changed during rollback; external contents preserved')
 if (plan.before === null) rmSync(plan.absolutePath, {force: true})
 else atomicWriteVerifiedSync(plan.absolutePath, plan.path, Buffer.from(plan.before), undefined, snapshot?.mode)
}

async function applyPlannedEditsUnlocked(plans: Array<PlannedFileEdit | PlannedPatchFile>, signal?: AbortSignal, restore: (plan: PlannedFileEdit | PlannedPatchFile, snapshot?: FileSnapshot) => Promise<void> = restorePlan) {
 if (plans.length === 0) throw new Error('No edit operations were planned.')
 ensureNotAborted(signal)
 for (const plan of plans) assertPlanCurrent(plan)
 const snapshots = new Map<string, FileSnapshot>()
 const identities = new Map<string, string>()
 for (const plan of plans) {
  const key = mutationKey(plan.absolutePath)
  const alias = identities.get(key)
  if (alias && alias !== plan.absolutePath) throw new Error(`Edit paths ${alias} and ${plan.path} refer to the same file. Use one path for all changes.`)
  identities.set(key, plan.absolutePath)
  if (plan.before === null) continue
  const stat = lstatSync(plan.absolutePath)
  snapshots.set(plan.absolutePath, {mode: stat.mode & 0o777, link: stat.isSymbolicLink() ? readlinkSync(plan.absolutePath) : undefined})
 }
 const applied: Array<PlannedFileEdit | PlannedPatchFile> = []
 const createdDirectories: string[] = []
 try {
  for (const plan of plans) {
   ensureNotAborted(signal)
   assertPlanCurrent(plan)
   applied.push(plan)
   if (plan.after === null) {
    rmSync(plan.absolutePath, {force: true})
   } else {
    const parent = dirname(plan.absolutePath)
    const firstCreated = mkdirSync(parent, {recursive: true})
    if (firstCreated) {
     const directories: string[] = []
     for (let dir = parent; ; dir = dirname(dir)) {
      directories.push(dir)
      if (dir === firstCreated) break
     }
     createdDirectories.push(...directories.reverse())
    }
    const data = Buffer.from(plan.after, 'utf8')
    const moveMode = 'moveFrom' in plan && plan.moveFrom ? snapshots.get(plan.moveFrom)?.mode : undefined
    atomicWriteVerifiedSync(plan.absolutePath, plan.path, data, signal, moveMode)
   }
   ensureNotAborted(signal)
  }
 } catch (error) {
  const rollbackErrors: Error[] = []
  for (let i = applied.length - 1; i >= 0; i -= 1) {
   try {
    await restore(applied[i], snapshots.get(applied[i].absolutePath))
   } catch (rollbackError) {
    rollbackErrors.push(new Error(`Rollback failed for ${applied[i].path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`, {cause: rollbackError}))
   }
  }
  for (const dir of createdDirectories.reverse()) {
   try {
    rmdirSync(dir)
   } catch (cleanupError) {
    if (!isRecord(cleanupError) || !['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(String(cleanupError.code))) rollbackErrors.push(new Error(`Could not remove created directory ${dir}`, {cause: cleanupError}))
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
 ensureNotAborted(signal)
 const operations = parsePatch(patch)
 const uniquePaths = [...new Set(operations.flatMap(operation => [resolvePatchPath(cwd, operation.path), ...(operation.kind === 'update' && operation.movePath ? [resolvePatchPath(cwd, operation.movePath)] : [])]))].sort()
 return withFileMutationQueues(uniquePaths, async () => {
  ensureNotAborted(signal)
  const plans = await planPatchOperations(
   cwd,
   operations,
   path => Bun.file(path).text(),
   async path => lstatSync(path, {throwIfNoEntry: false}) !== undefined
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
   if (before.indexOf(oldBytes, firstIndex + 1) !== -1) {
    throw duplicateEditError(pathArg, 0, before.toString('utf8'), edit.oldText)
   }
   const newBytes = Buffer.from(edit.newText, 'utf8')
   const after = Buffer.allocUnsafe(before.length - oldBytes.length + newBytes.length)
   before.copy(after, 0, 0, firstIndex)
   newBytes.copy(after, firstIndex)
   before.copy(after, firstIndex + newBytes.length, firstIndex + oldBytes.length)
   atomicWriteVerifiedSync(absolutePath, pathArg, after, signal)
   const beforeText = before.toString('utf8')
   const afterText = after.toString('utf8')
   const beforeStart = beforeText.indexOf(edit.oldText)
   return textResult(`Successfully replaced 1 block(s) in ${pathArg}.`, {
    verified: true,
    files: 1,
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
 ensureNotAborted(signal)
 const proc = Bun.spawn([cmd, ...args], {stdout: 'ignore', stderr: 'pipe', signal})
 const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
 if (signal?.aborted) throw new Error('Operation aborted')
 if (exitCode !== 0) {
  throw new Error(`${cmd} exited with code ${exitCode}${stderr.trim() ? `: ${stderr.trim()}` : ''}`)
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
 return token.length > 0 && !/^[-#~]/.test(token) && !/[\\'"`$*?[\]{}();<>|&!]/.test(token)
}

function copyPlainFile(src: string, dst: string, signal?: AbortSignal) {
 ensureNotAborted(signal)
 const input = openSync(src, 'r')
 try {
  const source = fstatSync(input)
  if (!source.isFile()) throw new Error('Copy source is not a regular file')
  const output = openSync(dst, 'a', source.mode & 0o777)
  try {
   const target = fstatSync(output)
   if (!target.isFile() || (source.dev === target.dev && source.ino === target.ino)) throw new Error('Cannot copy to the same file or a non-regular file')
   ftruncateSync(output, 0)
   const buffer = Buffer.allocUnsafe(Math.min(256 * 1024, Math.max(source.size, 1)))
   while (true) {
    ensureNotAborted(signal)
    const count = readSync(input, buffer, 0, buffer.length, null)
    if (!count) break
    writeAllSync(output, buffer.subarray(0, count))
   }
  } finally {
   closeSync(output)
  }
 } finally {
  closeSync(input)
 }
}

export function planOptimizedBash(cwd: string, command: string): OptimizedBashStep[] | null {
 if (/[\r\n]/.test(command)) return null
 const parts = command.split('&&').map(part => part.trim())

 if (parts.some(part => !part)) {
  return null
 }

 const steps: OptimizedBashStep[] = []
 const virtual = new Map<string, 'file' | 'missing'>()
 const kind = (path: string) => virtual.get(path) ?? statKind(path)
 const plain = (path: string) => kind(path) === 'file' && (virtual.has(path) || lstatSync(path).isFile())

 for (const part of parts) {
  const catMatch = part.match(/^cat\s+(\S+)\s*>\s*\/dev\/null$/)
  if (catMatch) {
   if (!safeShellPathToken(catMatch[1])) return null
   const file = resolve(cwd, catMatch[1])
   if (!plain(file)) return null
   steps.push({
    description: `drain ${catMatch[1]}`,
    run: async signal => {
     if (statSync(file).size > INLINE_FILE_LIMIT && existsSync(FASTDRAIN_BIN())) {
      await runBinary(FASTDRAIN_BIN(), [file], signal)
     } else {
      const fd = openSync(file, 'r')
      try {
       const buffer = Buffer.allocUnsafe(256 * 1024)
       while (readSync(fd, buffer, 0, buffer.length, null)) ensureNotAborted(signal)
      } finally {
       closeSync(fd)
      }
     }
    }
   })
   continue
  }

  const cpMatch = part.match(/^cp\s+(\S+)\s+(\S+)$/)
  if (cpMatch) {
   if (!safeShellPathToken(cpMatch[1]) || !safeShellPathToken(cpMatch[2])) return null
   const src = resolve(cwd, cpMatch[1])
   const dst = resolve(cwd, cpMatch[2])
   if (!plain(src) || src === dst || (kind(dst) !== 'missing' && !plain(dst)) || statKind(dirname(dst)) !== 'dir') return null
   if (existsSync(src) && existsSync(dst)) {
    const source = statSync(src)
    const target = statSync(dst)
    if (source.dev === target.dev && source.ino === target.ino) return null
   }
   virtual.set(dst, 'file')
   steps.push({
    description: `copy ${cpMatch[1]} -> ${cpMatch[2]}`,
    run: async signal => {
     if (statSync(src).size > INLINE_FILE_LIMIT && existsSync(FASTCOPY_BIN())) {
      await runBinary(FASTCOPY_BIN(), [src, dst], signal)
     } else {
      copyPlainFile(src, dst, signal)
     }
    }
   })
   continue
  }

  const rmMatch = part.match(/^rm\s+(\S+)$/)
  if (rmMatch) {
   if (!safeShellPathToken(rmMatch[1])) return null
   const target = resolve(cwd, rmMatch[1])
   if (!plain(target) || (statSync(dirname(target)).mode & 0o1000) !== 0) return null
   if (!virtual.has(target) && (statSync(target).mode & 0o222) === 0) return null
   virtual.set(target, 'missing')
   steps.push({
    description: `rm ${rmMatch[1]}`,
    run: async () => {
     rmSync(target)
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
  await steps[i].run(signal)
  ensureNotAborted(signal)
 }

 return true
}

export default function (pi: ExtensionAPI) {
 const stockRead = createReadToolDefinition(process.cwd())
 const stockWrite = createWriteToolDefinition(process.cwd())
 const stockBash = createBashToolDefinition(process.cwd())

 pi.registerTool({
  name: 'read',
  label: 'read',
  description: 'Read text with an in-process windowed byte scanner, or images as attachments. Supports offset/limit windows and returns truncated output with continuation hints.',
  parameters: readSchema,
  renderShell: stockRead.renderShell,
  renderCall: stockRead.renderCall,
  renderResult: stockRead.renderResult,
  async execute(_toolCallId, params, signal, onUpdate, ctx) {
   const typedOnUpdate: ToolUpdateFn = onUpdate
   try {
    return await fastRead(ctx.cwd, params.path, params.offset, params.limit, signal, typedOnUpdate)
   } catch (error) {
    if (!(error instanceof ImageReadRequired)) throw error
    return stockRead.execute(_toolCallId, params, signal, onUpdate, ctx)
   }
  }
 })

 pi.registerTool({
  name: 'write',
  label: 'write',
  description: 'Write content with byte-for-byte read-back verification. Regular files use atomic temp-file + rename; symlinks are written through without replacing the link.',
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
   const expanded = Boolean(options.expanded)
   const body = !context.isError && typeof details?.diff === 'string' && details.diff.length > 0 ? renderEditDiff(details.diff, expanded, theme) : renderLimitedText(theme.fg('toolOutput', output), expanded, 10, theme)
   if (!body) return component
   component.addChild(new Spacer(1))
   component.addChild(new Text(body, 0, 0))
   return component
  },
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
   const edits = normalizeEditParams(params)
   if (typeof params.patch === 'string') {
    return fastPatch(ctx.cwd, params.patch, signal)
   }
   return fastEdit(ctx.cwd, edits, signal)
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
   if (params.timeout === undefined && (await tryOptimizedBash(ctx.cwd, params.command, signal, typedOnUpdate))) {
    return textResult('(no output)')
   }

   const fastDir = fastToolsDir()
   const helperPath = existsSync(fastDir) ? `${fastDir}:${process.env.PATH ?? ''}` : (process.env.PATH ?? '')
   const stock = createBashTool(ctx.cwd, {spawnHook: ({command, cwd, env}) => ({command, cwd, env: {...(env ?? process.env), PATH: helperPath}})})
   return stock.execute(toolCallId, params, signal, onUpdate)
  }
 })
}
