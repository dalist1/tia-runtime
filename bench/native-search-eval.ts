import {spawnSync} from 'node:child_process'
import {existsSync, mkdirSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {parseZigSearchResults} from '../scripts/native-search-extension/results.ts'

type EvalDoc = {url: string; contentType: string; text: string}
type EvalCase = {id: string; query: string; expectedUrls: string[]; requiredTerms: string[]}
type CaseMetric = {id: string; topUrl: string | null; rank: number | null; recallAt5: number; mrr: number; topScore: number; scoreGap: number; normalizedScoreGap: number; snippetTermRate: number; top5Origins: number; deterministic: boolean; meanMs: number; p50Ms: number; p95Ms: number; minMs: number; maxMs: number}

type ThresholdResult = {metric: string; value: number; threshold: number; pass: boolean}

const resultDir = process.env.RESULT_DIR || join('/tmp', `tia-native-search-eval-${Date.now()}`)
const binPath = process.env.NATIVE_SEARCH_ZIG_BIN || './bin/native-search-zig'
const iterations = numberEnv('ITERATIONS', 10)
const docs = buildDocs()
const cases = buildCases()

if (!existsSync(binPath)) {
 console.error(`native-search-zig binary not found at ${binPath}; run bash bench/build-native-search-zig.sh first`)
 process.exit(1)
}

ensureResultDirIsSafe()
mkdirSync(resultDir, {recursive: true})
const corpusPath = join(resultDir, 'corpus.tsv')
writeFileSync(corpusPath, encodeCorpus(docs))

for (let index = 0; index < 3; index += 1) runSearch('warmup', corpusPath)

const perCase = cases.map(testCase => evaluateCase(testCase, corpusPath))
const summary = summarize(perCase)
writeFileSync(join(resultDir, 'summary.json'), JSON.stringify(summary, null, 2))
writeFileSync(join(resultDir, 'summary.md'), renderSummary(summary))
console.log(renderSummary(summary))
console.log(`\nWrote native_search eval results to ${resultDir}`)

function buildDocs(): EvalDoc[] {
 const baseDocs: EvalDoc[] = [
  {url: 'https://docs.alpha.dev/install', contentType: 'text/markdown', text: '# Alpha install\nInstall Alpha CLI with bun add alpha-cli. Configure ALPHA_TOKEN before running alpha deploy.'},
  {url: 'https://docs.alpha.dev/auth', contentType: 'text/markdown', text: '# Alpha auth\nAlpha authentication uses ALPHA_TOKEN and rotating project credentials for deployment.'},
  {url: 'https://docs.beta.io/search/ranking', contentType: 'text/html', text: '<html><nav>cookie sidebar</nav><main><h1>Beta ranking</h1><p>Beta search ranking combines BM25 phrase boosts title boosts and source priority.</p></main><script>noise()</script></html>'},
  {url: 'https://docs.beta.io/search/source-packs', contentType: 'text/markdown', text: '# Source packs\nSource packs cache documentation pages with manifest timestamps and bounded origin filtering for offline search.'},
  {url: 'https://guide.gamma.dev/errors/timeouts', contentType: 'text/markdown', text: '# Timeout errors\nGamma timeout recovery retries idempotent requests and reports retry-after headers in diagnostics.'},
  {url: 'https://guide.gamma.dev/errors/rate-limits', contentType: 'text/markdown', text: '# Rate limits\nGamma rate limit errors include retry-after and per-origin backoff guidance.'},
  {url: 'https://blog.delta.dev/native-search', contentType: 'text/markdown', text: '# Native search overview\nNative search is bounded to provided sites and avoids third-party search APIs.'},
  {
   url: 'https://markets.example.com/assets/bitcoin',
   contentType: 'text/html',
   text: '<html><body><nav>Markets Portfolio Login Watchlist News</nav><main><h1>Bitcoin price today</h1><p>BTC trades at $81,227.66 USD with market cap $1.62T and 24h volume $29.27B.</p><p>Updated May 10, 2026.</p></main><aside>Sponsored exchange links</aside></body></html>'
  },
  {url: 'https://markets.example.com/learn/bitcoin-history', contentType: 'text/html', text: '<html><main><h1>Bitcoin history</h1><p>Bitcoin price history includes mining, halvings, market cycles, and long-term store of value narratives.</p></main></html>'},
  {url: 'https://react.example.dev/reference/useActionState', contentType: 'text/markdown', text: '---\ntitle: useActionState\nupdated: 2026-05-01\n---\n# useActionState\n`useActionState` is a React Hook for Actions that returns state, dispatchAction, and isPending. Use it for forms and async mutations.'},
  {
   url: 'https://react.example.dev/blog/react-19',
   contentType: 'text/markdown',
   text: '---\ntitle: React 19\ndate: 2024-12-05\n---\nReact 19 stable release overview and migration notes. '.repeat(14) + 'Deep in the release notes, React 19 introduces useActionState for Actions, pending form state, and async mutation results.'
  },
  {
   url: 'https://issues.example.dev/runtime/search?q=fetch+TLS+certificate',
   contentType: 'text/html',
   text:
    '<html><body><header>Repository Stars Fork Notifications</header><main><h1>Search results for fetch TLS certificate</h1><article><h2>tls: implement SecureContext.addCACert #30486</h2><p>Status: Open. Fetch requests fail when custom TLS certificate authority is required.</p></article><article><h2>fetch: certificate chain validation on proxy #29910</h2><p>Status: Closed. TLS certificate bug with proxy fetch.</p></article></main></body></html>'
  },
  {url: 'https://issues.example.dev/runtime/issues', contentType: 'text/html', text: '<html><body><main><h1>Issues</h1><p>Open bugs include filesystem watcher, install cache, console output, and shell completion.</p></main></body></html>'},
  {url: 'https://noise.example.com/cookies', contentType: 'text/html', text: '<html><body>cookie cookie navigation sidebar footer unrelated marketing pricing support login</body></html>'}
 ]
 const noise: EvalDoc[] = []
 for (let index = 0; index < numberEnv('NOISE_DOCS', 1992); index += 1) {
  noise.push({url: `https://noise.example.com/${index}`, contentType: index % 2 === 0 ? 'text/markdown' : 'text/html', text: `# Noise ${index}\nGeneric documentation navigation cookie sidebar footer unrelated tokens ${index % 17} ${index % 23}.`})
 }
 return [...baseDocs, ...noise]
}

function buildCases(): EvalCase[] {
 return [
  {id: 'alpha-install', query: 'install alpha cli ALPHA_TOKEN deploy', expectedUrls: ['https://docs.alpha.dev/install'], requiredTerms: ['install', 'alpha_token']},
  {id: 'alpha-auth', query: 'alpha authentication project credentials token', expectedUrls: ['https://docs.alpha.dev/auth'], requiredTerms: ['authentication', 'credentials']},
  {id: 'beta-ranking', query: 'bm25 phrase boosts source priority ranking', expectedUrls: ['https://docs.beta.io/search/ranking'], requiredTerms: ['bm25', 'phrase', 'source']},
  {id: 'source-packs', query: 'source packs manifest timestamps bounded origin filtering', expectedUrls: ['https://docs.beta.io/search/source-packs'], requiredTerms: ['manifest', 'bounded', 'origin']},
  {id: 'gamma-timeouts', query: 'timeout recovery retry-after diagnostics', expectedUrls: ['https://guide.gamma.dev/errors/timeouts'], requiredTerms: ['timeout', 'retry-after', 'diagnostics']},
  {id: 'gamma-rate', query: 'rate limit per-origin backoff retry-after', expectedUrls: ['https://guide.gamma.dev/errors/rate-limits'], requiredTerms: ['rate', 'backoff', 'retry-after']},
  {id: 'bounded-search', query: 'bounded sites third-party search APIs', expectedUrls: ['https://blog.delta.dev/native-search'], requiredTerms: ['bounded', 'third-party', 'apis']},
  {id: 'asset-price-current', query: 'bitcoin price usd market cap current asset price', expectedUrls: ['https://markets.example.com/assets/bitcoin'], requiredTerms: ['$81,227.66', 'market cap', 'updated']},
  {id: 'latest-docs-hook', query: 'React useActionState latest documentation isPending Actions', expectedUrls: ['https://react.example.dev/reference/useActionState'], requiredTerms: ['useActionState', 'isPending', 'Actions']},
  {id: 'latest-release-section', query: 'React 19 release notes Actions useActionState pending form state', expectedUrls: ['https://react.example.dev/blog/react-19'], requiredTerms: ['useActionState', 'pending', 'Actions']},
  {id: 'bug-search-results', query: 'fetch TLS certificate bug issue status open', expectedUrls: ['https://issues.example.dev/runtime/search?q=fetch+TLS+certificate'], requiredTerms: ['tls', 'certificate', 'Open']}
 ]
}

function evaluateCase(testCase: EvalCase, corpusPath: string): CaseMetric {
 const times: number[] = []
 const observedOrders = new Set<string>()
 let output = ''
 for (let index = 0; index < iterations; index += 1) {
  const started = performance.now()
  output = runSearch(testCase.query, corpusPath)
  times.push(performance.now() - started)
  observedOrders.add(
   parseZigSearchResults(output)
    .slice(0, 5)
    .map(result => result.url)
    .join('|')
  )
 }
 writeFileSync(join(resultDir, `${testCase.id}.md`), output)
 const results = parseZigSearchResults(output)
 const urls = results.map(result => result.url)
 const rankIndex = urls.findIndex(url => testCase.expectedUrls.includes(url))
 const topResult = results[0]
 const expectedHits = testCase.expectedUrls.filter(url => urls.slice(0, 5).includes(url)).length
 const topSnippet = `${topResult?.title ?? ''} ${topResult?.snippet ?? ''}`.toLowerCase()
 const termHits = testCase.requiredTerms.filter(term => topSnippet.includes(term.toLowerCase())).length
 const bestNonRelevantScore = results.find(result => !testCase.expectedUrls.includes(result.url))?.score ?? 0
 const scoreGap = (topResult?.score ?? 0) - bestNonRelevantScore
 const sortedTimes = [...times].sort((a, b) => a - b)
 return {
  id: testCase.id,
  topUrl: topResult?.url ?? null,
  rank: rankIndex >= 0 ? rankIndex + 1 : null,
  recallAt5: expectedHits / testCase.expectedUrls.length,
  mrr: rankIndex >= 0 && rankIndex < 5 ? 1 / (rankIndex + 1) : 0,
  topScore: topResult?.score ?? 0,
  scoreGap,
  normalizedScoreGap: scoreGap / Math.max(1, topResult?.score ?? 0),
  snippetTermRate: termHits / testCase.requiredTerms.length,
  top5Origins: new Set(results.slice(0, 5).map(result => originFor(result.url))).size,
  deterministic: observedOrders.size === 1,
  meanMs: mean(times),
  p50Ms: percentile(sortedTimes, 0.5),
  p95Ms: percentile(sortedTimes, 0.95),
  minMs: Math.min(...times),
  maxMs: Math.max(...times)
 }
}

function runSearch(query: string, corpusPath: string) {
 const result = spawnSync(binPath, [query, '5', '12000', corpusPath, '0'], {encoding: 'utf8'})
 if (result.status !== 0) throw new Error(result.stderr || `native-search-zig exited with ${result.status}`)
 return result.stdout
}

function summarize(perCase: CaseMetric[]) {
 const aggregate = {
  resultDir,
  docs: docs.length,
  cases: cases.length,
  iterations,
  top1Rate: ratio(perCase.filter(item => item.rank === 1).length, perCase.length),
  recallAt5: mean(perCase.map(item => item.recallAt5)),
  mrrAt5: mean(perCase.map(item => item.mrr)),
  snippetTermRate: mean(perCase.map(item => item.snippetTermRate)),
  minSnippetTermRate: Math.min(...perCase.map(item => item.snippetTermRate)),
  avgScoreGap: mean(perCase.map(item => item.scoreGap)),
  avgNormalizedScoreGap: mean(perCase.map(item => item.normalizedScoreGap)),
  avgTop5Origins: mean(perCase.map(item => item.top5Origins)),
  deterministicRate: ratio(perCase.filter(item => item.deterministic).length, perCase.length),
  avgMeanMs: mean(perCase.map(item => item.meanMs)),
  p95MeanMs: percentile(
   perCase.map(item => item.meanMs).sort((a, b) => a - b),
   0.95
  ),
  perCase
 }
 const thresholds: ThresholdResult[] = [
  {metric: 'top1Rate', value: aggregate.top1Rate, threshold: 0.95, pass: aggregate.top1Rate >= 0.95},
  {metric: 'recallAt5', value: aggregate.recallAt5, threshold: 0.98, pass: aggregate.recallAt5 >= 0.98},
  {metric: 'mrrAt5', value: aggregate.mrrAt5, threshold: 0.97, pass: aggregate.mrrAt5 >= 0.97},
  {metric: 'snippetTermRate', value: aggregate.snippetTermRate, threshold: 0.9, pass: aggregate.snippetTermRate >= 0.9},
  {metric: 'minSnippetTermRate', value: aggregate.minSnippetTermRate, threshold: 0.9, pass: aggregate.minSnippetTermRate >= 0.9},
  {metric: 'deterministicRate', value: aggregate.deterministicRate, threshold: 1, pass: aggregate.deterministicRate >= 1},
  {metric: 'avgNormalizedScoreGap', value: aggregate.avgNormalizedScoreGap, threshold: 0.15, pass: aggregate.avgNormalizedScoreGap >= 0.15},
  {metric: 'p95MeanMs', value: aggregate.p95MeanMs, threshold: 250, pass: aggregate.p95MeanMs <= 250}
 ]
 return {...aggregate, thresholds, pass: thresholds.every(item => item.pass)}
}

function renderSummary(summary: ReturnType<typeof summarize>) {
 const lines = [
  '# native_search offline eval',
  '',
  `- docs: ${summary.docs}`,
  `- cases: ${summary.cases}`,
  `- iterations per case: ${summary.iterations}`,
  `- top1Rate: ${format(summary.top1Rate)}`,
  `- recallAt5: ${format(summary.recallAt5)}`,
  `- mrrAt5: ${format(summary.mrrAt5)}`,
  `- snippetTermRate: ${format(summary.snippetTermRate)}`,
  `- minSnippetTermRate: ${format(summary.minSnippetTermRate)}`,
  `- avgScoreGap: ${format(summary.avgScoreGap)}`,
  `- avgNormalizedScoreGap: ${format(summary.avgNormalizedScoreGap)}`,
  `- avgTop5Origins: ${format(summary.avgTop5Origins)}`,
  `- deterministicRate: ${format(summary.deterministicRate)}`,
  `- avgMeanMs: ${format(summary.avgMeanMs)}`,
  `- p95MeanMs: ${format(summary.p95MeanMs)}`,
  `- pass: ${summary.pass ? 'yes' : 'no'}`,
  '',
  '',
  '| Threshold | Value | Target | Pass |',
  '|:--|--:|--:|:--|',
  ...summary.thresholds.map(item => `| ${item.metric} | ${format(item.value)} | ${format(item.threshold)} | ${item.pass ? 'yes' : 'no'} |`),
  '',
  '| Case | Top URL | Rank | Recall@5 | MRR | Snippet terms | Deterministic | Mean ms | P95 ms |',
  '|:--|:--|--:|--:|--:|--:|:--|--:|--:|'
 ]
 for (const item of summary.perCase) lines.push(`| ${item.id} | ${item.topUrl ?? 'n/a'} | ${item.rank ?? 0} | ${format(item.recallAt5)} | ${format(item.mrr)} | ${format(item.snippetTermRate)} | ${item.deterministic ? 'yes' : 'no'} | ${format(item.meanMs)} | ${format(item.p95Ms)} |`)
 return `${lines.join('\n')}\n`
}

function encodeCorpus(corpusDocs: EvalDoc[]) {
 return `${corpusDocs.map(doc => `${base64(doc.url)}\t${base64(doc.contentType)}\t${base64(doc.text)}`).join('\n')}\n`
}

function base64(value: string) {
 return Buffer.from(value, 'utf8').toString('base64')
}

function originFor(url: string) {
 try {
  return new URL(url).origin
 } catch {
  return url
 }
}

function ensureResultDirIsSafe() {
 const cwd = process.cwd()
 const absoluteResultDir = resultDir.startsWith('/') ? resultDir : join(cwd, resultDir)
 if (process.env.ALLOW_REPO_RESULT_DIR === '1') return
 if (absoluteResultDir === cwd || absoluteResultDir.startsWith(`${cwd}/`)) throw new Error(`RESULT_DIR must be outside the repository unless ALLOW_REPO_RESULT_DIR=1: ${resultDir}`)
}

function mean(values: number[]) {
 return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function percentile(sortedValues: number[], quantile: number) {
 if (sortedValues.length === 0) return 0
 const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(sortedValues.length * quantile) - 1))
 return sortedValues[index]
}

function ratio(value: number, total: number) {
 return total > 0 ? value / total : 0
}

function format(value: number) {
 return Number.isInteger(value) ? String(value) : value.toFixed(3)
}

function numberEnv(name: string, fallback: number) {
 const raw = process.env[name]
 if (!raw) return fallback
 const parsed = Number(raw)
 return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}
