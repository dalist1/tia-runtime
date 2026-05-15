import {describe, expect, test} from 'bun:test'
import {chmodSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

describe('native_search watchdog timeout', () => {
 test('returns recovered backend progress instead of hanging', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tia-native-search-timeout-'))
  const fakeBackend = join(dir, 'fake-native-search')
  writeFileSync(fakeBackend, ['#!/usr/bin/env bun', "console.error('progress: fetching 1/2 https://example.com/ok')", "console.error('progress: fetched 1/2 score=99 Example OK — https://example.com/ok')", "console.error('progress: fetching 2/2 https://example.com/slow')", 'await new Promise(() => {})'].join('\n'))
  chmodSync(fakeBackend, 0o755)

  try {
   const runner = `
    const {runNativeSearchTool} = await import('./scripts/native-search-extension/tool.ts')
    const result = await runNativeSearchTool({query: 'timeout test', sites: ['https://example.com/ok', 'https://example.com/slow'], strategy: 'direct', maxPages: 2, overallTimeoutMs: 1000, fetchContent: false})
    console.log(JSON.stringify({status: result.details.status, recovered: result.details.recoveredResults.length, text: result.content[0].text}))
   `
   const proc = Bun.spawn(['bun', '--no-install', '-e', runner], {stdout: 'pipe', stderr: 'pipe', env: {...process.env, TIA_NATIVE_SEARCH_ZIG_BIN: fakeBackend}})
   const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])

   expect(exitCode).toBe(0)
   expect(stderr).toBe('')
   const parsed = JSON.parse(stdout)
   expect(parsed.status).toBe('timeout')
   expect(parsed.recovered).toBe(1)
   expect(parsed.text).toContain('Example OK')
  } finally {
   rmSync(dir, {recursive: true, force: true})
  }
 })
})
