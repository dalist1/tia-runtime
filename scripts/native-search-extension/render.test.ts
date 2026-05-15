import {describe, expect, test} from 'bun:test'
import {buildNativeSearchRenderText} from './render.ts'

function nativeSearchContent(bodyRepeat = 200) {
 const longBody = Array.from({length: bodyRepeat}, (_, index) => `FULL_BODY_LINE_${index} native search documentation body text that should never flood the terminal.`).join('\n')
 return [
  'Search plan: direct URL strategy for `native search`.',
  'Scope: 1 site seed(s), 1/1 final candidate URL(s), cap 8 per site.',
  'Breadth: https://example.com=1.',
  '',
  'Native Zig search found 1 result(s) for `native search`.',
  '',
  '## 1. Native Search Guide',
  '',
  'https://example.com/native-search',
  '',
  'Score: 42; kind=markdown; contentType=text/markdown',
  '',
  'Snippet: Native search prefers concise snippets while full page content remains available to the model.',
  '',
  longBody,
  ''
 ].join('\n')
}

describe('native_search extension module', () => {
 test('loads without resolving TUI dependencies at module top level', async () => {
  const proc = Bun.spawn(['bun', '--no-install', '-e', "await import('./scripts/native-search-extension/index.ts')"], {stdout: 'pipe', stderr: 'pipe'})
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])

  expect(`${stdout}${stderr}`).not.toContain('Cannot find module')
  expect(exitCode).toBe(0)
 })

 test('renderResult does not fall back to raw output when keyHint package is unavailable', async () => {
  const extension = await import('./index.ts')
  let registeredTool: any
  extension.default({
   registerTool(tool: any) {
    registeredTool = tool
   },
   on() {}
  })
  const component = registeredTool.renderResult({content: [{type: 'text', text: nativeSearchContent()}], details: {resultCount: 1, outputContent: true}}, {expanded: false, isPartial: false}, {fg: (_color: string, text: string) => text})
  const rendered = component.render(120).join('\n')

  expect(rendered).toContain('Full output truncated. Ctrl+O to expand.')
  expect(rendered).not.toContain('FULL_BODY_LINE_25')
 })
})

describe('native_search render text', () => {
 test('partial output shows concise live progress', () => {
  const rendered = buildNativeSearchRenderText({content: [{type: 'text', text: 'Native search: fetched 2/4 score=42 Example Guide — https://example.com/docs'}]}, {isPartial: true})

  expect(rendered).toContain('fetched 2/4')
  expect(rendered).toContain('https://example.com/docs')
  expect(rendered.length).toBeLessThan(360)
 })

 test('collapsed output is a bounded summary and does not mutate full content', () => {
  const fullText = nativeSearchContent()
  const result = {content: [{type: 'text', text: fullText}], details: {resultCount: 1, outputContent: true}}

  const rendered = buildNativeSearchRenderText(result, {expanded: false, expandHint: 'Ctrl+X to expand'})

  expect(rendered.length).toBeLessThan(520)
  expect(rendered).toContain('1 result')
  expect(rendered).toContain('Native Search Guide')
  expect(rendered).toContain('https://example.com/native-search')
  expect(rendered).toContain('Native search prefers concise snippets')
  expect(rendered).toContain('Full output truncated. Ctrl+X to expand.')
  expect(rendered.split('\n')).toHaveLength(5)
  expect(rendered).not.toContain('Search plan:')
  expect(rendered).not.toContain('FULL_BODY_LINE_25')
  expect(result.content[0].text).toBe(fullText)
 })

 test('collapsed output stays to five lines with multiple results', () => {
  const content = [
   'Native Zig search found 3 result(s) for `docs`.',
   '',
   '## 1. First Result',
   '',
   'https://example.com/first',
   '',
   'Score: 10; kind=markdown; contentType=text/markdown',
   '',
   'Snippet: first snippet that should not get its own line in compact multi-result mode',
   '',
   '## 2. Second Result',
   '',
   'https://example.com/second',
   '',
   'Score: 9; kind=markdown; contentType=text/markdown',
   '',
   'Snippet: second snippet',
   '',
   '## 3. Third Result',
   '',
   'https://example.com/third',
   '',
   'Score: 8; kind=markdown; contentType=text/markdown',
   '',
   'Snippet: third snippet'
  ].join('\n')

  const rendered = buildNativeSearchRenderText({content: [{type: 'text', text: content}], details: {resultCount: 3, outputContent: true}}, {expanded: false, expandHint: 'Ctrl+O to expand'})

  expect(rendered.split('\n')).toHaveLength(5)
  expect(rendered).toContain('First Result')
  expect(rendered).toContain('Second Result')
  expect(rendered).toContain('Third Result')
  expect(rendered).toContain('https://example.com/first')
  expect(rendered).toContain('Full output truncated. Ctrl+O to expand.')
  expect(rendered).not.toContain('first snippet')
 })

 test('collapsed output keeps expand hint with long multi-result titles and urls', () => {
  const longTitle = 'A very long native search result title that could otherwise consume the entire collapsed render budget before the footer appears'
  const longUrl = 'https://example.com/docs/native-search/rendering/with/a/very/long/path/that/should/be/shortened/in/collapsed/output'
  const content = [
   'Native Zig search found 3 result(s) for `docs`.',
   '',
   `## 1. ${longTitle} One`,
   '',
   `${longUrl}/one`,
   '',
   'Score: 10; kind=markdown; contentType=text/markdown',
   '',
   'Snippet: first snippet',
   '',
   `## 2. ${longTitle} Two`,
   '',
   `${longUrl}/two`,
   '',
   'Score: 9; kind=markdown; contentType=text/markdown',
   '',
   'Snippet: second snippet',
   '',
   `## 3. ${longTitle} Three`,
   '',
   `${longUrl}/three`,
   '',
   'Score: 8; kind=markdown; contentType=text/markdown',
   '',
   'Snippet: third snippet'
  ].join('\n')

  const rendered = buildNativeSearchRenderText({content: [{type: 'text', text: content}], details: {resultCount: 3, outputContent: true}}, {expanded: false, expandHint: 'Ctrl+O to expand'})

  expect(rendered.length).toBeLessThan(520)
  expect(rendered.split('\n')).toHaveLength(5)
  expect(rendered).toContain('Full output truncated. Ctrl+O to expand.')
 })

 test('expanded output is still bounded', () => {
  const rendered = buildNativeSearchRenderText({content: [{type: 'text', text: nativeSearchContent(500)}], details: {resultCount: 1, outputContent: true}}, {expanded: true})

  expect(rendered.length).toBeLessThan(1200)
  expect(rendered).toContain('Native Search Guide')
  expect(rendered).toContain('https://example.com/native-search')
  expect(rendered).toContain('Full output remains truncated in UI; full data stays in tool context.')
  expect(rendered).not.toContain('FULL_BODY_LINE_80')
 })

 test('ignores markdown headings inside fetched page bodies', () => {
  const content = [
   'Native Zig search found 2 result(s) for `docs`.',
   '',
   '## 1. Actual First Result',
   '',
   'https://example.com/first',
   '',
   'Score: 10; kind=markdown; contentType=text/markdown',
   '',
   'Snippet: first snippet',
   '',
   'Full fetched content starts here.',
   '',
   '## 1. Installation',
   '',
   'This markdown body heading is not a native_search result record.',
   '',
   '## 2. Actual Second Result',
   '',
   'https://example.com/second',
   '',
   'Score: 9; kind=markdown; contentType=text/markdown',
   '',
   'Snippet: second snippet'
  ].join('\n')

  const rendered = buildNativeSearchRenderText({content: [{type: 'text', text: content}], details: {resultCount: 2, outputContent: true}}, {expanded: false})

  expect(rendered).toContain('Actual First Result')
  expect(rendered).toContain('https://example.com/first')
  expect(rendered).toContain('Actual Second Result')
  expect(rendered).toContain('https://example.com/second')
  expect(rendered).not.toContain('Installation')
 })
})
