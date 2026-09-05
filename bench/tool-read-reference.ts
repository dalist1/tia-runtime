import {formatSize} from '@earendil-works/pi-coding-agent'

export function referenceRead(content: string, offset = 1, limit = 2000, unlimited = false) {
 const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? []
 const total = Math.max(1, lines.length)
 if (offset > total) throw new Error(`Offset ${offset} is beyond end of file (${total} lines total)`)
 const selected: string[] = []
 let bytes = 0
 const result = (text: string, details: any = undefined) => ({content: [{type: 'text' as const, text}], details})
 for (const line of lines.slice(offset - 1)) {
  const end = offset + selected.length - 1
  if (!unlimited && selected.length >= limit) {
   return result(`${selected.join('')}\n\n[Showing lines ${offset}-${end}. Use offset=${end + 1} to continue.]`, {truncation: {truncated: true, truncatedBy: 'lines', outputLines: selected.length}})
  }
  const length = Buffer.byteLength(line)
  if (!unlimited && bytes + length > 50 * 1024) {
   if (selected.length === 0) return result(`[Line ${offset} is ${formatSize(length)}, exceeds 50.0KB limit. Use bash for partial reads.]`, {truncation: {truncated: true, firstLineExceedsLimit: true}})
   return result(`${selected.join('')}\n\n[Showing lines ${offset}-${end} (${formatSize(bytes)} limit). Use offset=${end + 1} to continue.]`, {truncation: {truncated: true, truncatedBy: 'bytes', outputLines: selected.length}})
  }
  bytes += length
  selected.push(line)
 }
 return result(selected.join(''))
}
