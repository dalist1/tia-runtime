import type {NativeSearchResultMetadata, ToolTextResponse} from './types.ts'

export type SearchQuality = {resultCount: number; topScore: number; avgTop3Score: number; goodResultCount: number; scoreSpread: number}

export function parseZigSearchResults(output: string): NativeSearchResultMetadata[] {
 const lines = output.split('\n')
 const results: NativeSearchResultMetadata[] = []
 for (let index = 0; index < lines.length; index += 1) {
  const heading = lines[index].match(/^##\s+(\d+)\.\s+(.+?)\s*$/)
  if (!heading) continue

  const urlLine = nextNonEmptyLine(lines, index + 1)
  const scoreLine = urlLine ? nextNonEmptyLine(lines, urlLine.index + 1) : undefined
  if (!urlLine?.text.match(/^https?:\/\/\S+/) || !scoreLine) continue

  const score = scoreLine.text.match(/^Score:\s+(\d+);\s+kind=([^;]*);\s+contentType=(.*)$/)
  if (!score) continue

  const breakdownLine = nextNonEmptyLine(lines, scoreLine.index + 1)
  const scoreBreakdown = breakdownLine?.text.startsWith('ScoreBreakdown:') ? parseScoreBreakdown(breakdownLine.text) : undefined
  const snippetStart = scoreBreakdown ? breakdownLine!.index + 1 : scoreLine.index + 1
  results.push({rank: Number(heading[1]), title: heading[2].trim(), url: urlLine.text.replace(/[).,;]+$/, ''), score: Number(score[1]), kind: score[2], contentType: score[3], snippet: snippetAfterScore(lines, snippetStart), scoreBreakdown})
 }
 return results
}

export function isEnoughQuality(quality: SearchQuality, maxResults: number) {
 const targetGoodResults = Math.min(maxResults, 3)
 return quality.goodResultCount >= targetGoodResults && quality.topScore >= 45 && quality.avgTop3Score >= 30
}

export function searchQualityFromDetails(details: ToolTextResponse['details']): SearchQuality | undefined {
 const candidate = details?.quality
 if (!candidate || typeof candidate !== 'object') return undefined
 if (typeof candidate.resultCount !== 'number' || typeof candidate.topScore !== 'number' || typeof candidate.avgTop3Score !== 'number' || typeof candidate.goodResultCount !== 'number' || typeof candidate.scoreSpread !== 'number') {
  return undefined
 }
 return candidate
}

export function analyzeSearchQuality(output: string): SearchQuality {
 const scores = Array.from(output.matchAll(/^Score: (\d+);/gm), match => Number(match[1]))
 const top3 = scores.slice(0, 3)
 const topScore = scores[0] ?? 0
 const avgTop3Score = top3.length ? Math.round(top3.reduce((sum, score) => sum + score, 0) / top3.length) : 0
 return {resultCount: scores.length, topScore, avgTop3Score, goodResultCount: scores.filter(score => score >= 30).length, scoreSpread: topScore - (scores[1] ?? 0)}
}

function parseScoreBreakdown(line: string) {
 const values = Object.fromEntries(Array.from(line.matchAll(/(bm25|title|url|phrase|source)=(\d+)/g), match => [match[1], Number(match[2])]))
 if (typeof values.bm25 !== 'number' || typeof values.title !== 'number' || typeof values.url !== 'number' || typeof values.phrase !== 'number' || typeof values.source !== 'number') return undefined
 return {bm25: values.bm25, title: values.title, url: values.url, phrase: values.phrase, source: values.source}
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
