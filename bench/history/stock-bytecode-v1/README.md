# Stock Pi 0.87.1 versus ESM bytecode

Measured **2026-09-26** on Linux, i7-1360P, CPU affinity **2**, Node **22.23.1**, Bun **1.4.3-canary.1+73df7bb27**. Base repository commit: `3d35ab0aad1de2e0ef799ffaf31754a8fe90b8e9`. [Evidence, checksums and controls](index.json).

**Implemented and offline-tested; opt-in, not activated on the user's installation.** The default remains `TIA_PI_BYTECODE=0`. Pi 0.87.1 was the newest registry version by publish date across all channels (2026-09-22); the `latest` tag happened to agree. Registry responses are archived.

## What changed

The full-runtime builder now explicitly requests `format: 'esm'`. With `TIA_PI_BYTECODE=1`, Bun otherwise defaults to CJS bytecode, and Pi fails its smoke check with **“import.meta is only valid inside modules.”** ESM bytecode preserves top-level await, dynamic imports, `import.meta`, the real agent loop, tools, sessions and extension loader. No upstream source patch, slim substitution, verification removal or resource-disabling optimization was used.

Build metadata now fingerprints all bundled source inputs and records the module format. `bench:latency --stock` creates source/bytecode builds plus a stock target using the package's **published Node bin** (`dist/bundle/cli.js` for this release), not its older unbundled entry. The harness verifies Node identity, stock source hashes, matching build inputs, companion identity and isolated cache state.

## Primary coding confirmation

**Mean milliseconds (p95)**, 12 measured rounds per target/profile plus two validated warmups. Three prompts per process; each prompt executes read, write, edit and bash, then continues to a scripted response. This table uses **stock tools on every target**. Both compiled builds use the same locked 0.87.1 tree and lazy-Jiti companion; only bytecode differs.

| Measurement | Stock Pi / Node | TIA before / source | TIA after / ESM bytecode | After vs stock, paired ratio [95% CI] |
|---|---:|---:|---:|---:|
| RPC readiness | 234.35 (267.19) | 288.23 (318.58) | 138.93 (171.55) | 1.70× [1.61, 1.77] |
| Launch → first response text | 302.38 (342.29) | 344.47 (378.04) | 178.18 (214.79) | 1.70× [1.62, 1.77] |
| Complete three-prompt process | 596.94 (640.00) | 630.95 (666.46) | 470.80 (515.15) | 1.27× [1.23, 1.30] |

Readiness falls **40.7%** versus stock and **51.8%** versus the previous compiled configuration. The same-input readiness speedup is **2.09× [1.99, 2.18]**. Mean process CPU time: **363.75 → 198.76 ms** versus stock.

The separate `fastTools=true` profile loads the actual fast-tools extension on **all** targets, preserving verified writes; it also improved. These profiles are never silently mixed to inflate the stock comparison.

## Independent rerun and stress cases

Each row is a separate suite, not pooled with the primary result. Times are means in milliseconds. Ratios describe complete process elapsed time, not LLM token generation.

| Suite | Stock → bytecode readiness | Stock → bytecode elapsed | Elapsed ratio [95% CI] |
|---|---:|---:|---:|
| replication | 275.46 → 141.98 | 654.12 → 476.56 | 1.36× [1.30, 1.44] |
| burst | 241.70 → 134.90 | 338.40 → 169.96 | 1.99× [1.92, 2.05] |
| backpressure | 233.46 → 129.86 | 776.12 → 637.03 | 1.22× [1.20, 1.24] |
| cold | 625.73 → 575.82 | 981.15 → 903.70 | 1.08× [1.04, 1.14] |
| fff | 352.42 → 228.01 | 713.17 → 560.51 | 1.27× [1.26, 1.28] |

- **replication:** same coding workload, fresh run/cache directories and a different randomization seed; 12 measured rounds.
- **burst:** 64 KiB prompts, 128 scripted deltas, two turns, stock tools retained but not invoked.
- **backpressure:** a deliberately slow stdout consumer and 256 large deltas. Exact Unicode text and completion were checked without loss or duplication.
- **cold:** empty Jiti transform cache per launch, fast-tools enabled on all targets. Node compile cache stays warm. The smaller gain shows that extension transpilation remains a bottleneck.
- **fff:** fast-tools plus FFF **0.10.7-nightly.c3f2c7f**, override mode, loaded on all targets; three coding prompts. This tests extension loading/continuations, **not FFF search correctness or ranking**.

## Limits and trade-offs

- **Not a universal speedup.** Once running, warm turns do not consistently improve. In the primary suite, the second prompt's mean first-text time was **32.38 → 34.85 ms** against the previous compiled build. FFF's first-turn median completion tail was **1.48 → 2.84 ms**, despite faster overall startup/process time.
- One primary same-code control warns about **stock first-turn delivery p95**. The replication has no such warning. No blanket claim about per-delta latency is made. Retrospective readiness/elapsed control checks are retained in `index.json`; none exceed the harness's 5% material-warning criterion, though some small differences exclude 1.00. Replication source-build startup was noisy; all samples and outliers remain included.
- The executable grows from **84.23 to 100.33 MiB**. No memory/RSS reduction is claimed.
- Only this Linux/Bun canary combination was measured. Keep bytecode opt-in until other compiler/platform combinations are validated. Unsupported compilers fail before binary replacement; `TIA_PI_BYTECODE=0` is the explicit escape hatch.
- Stock-vs-compiled includes **Node versus Bun, different entrypoints and dependency bundling**. The bytecode-only claim comes from the two compiled builds with identical input/companion fingerprints.
- Synthetic loopback is not live model latency, tokens/second, TUI paint, interactive image rendering, reasoning quality, long-history replay or compaction. Skills, prompt templates, themes, context discovery and persistence stay enabled, using isolated synthetic resources. No user credentials or paid model calls were used.

## Validation and retained evidence

**492 processes, 1296 prompts and 4464 tool executions** were validated across the six completed suites, including warmups and same-code controls:

| Suite | Processes | Prompts | Tool executions |
|---|---:|---:|---:|
| confirmation | 126 | 378 | 1512 |
| replication | 126 | 378 | 1512 |
| burst | 60 | 120 | 0 |
| backpressure | 60 | 60 | 0 |
| cold | 60 | 180 | 720 |
| fff | 60 | 180 | 720 |

The full regression suite passed **119 tests / 2,697 assertions**. Shell syntax, formatting, lint and typecheck passed. All **12 installer/integration stages** passed in each of three isolated configurations: lazy-Jiti source, lazy-Jiti ESM bytecode and bundled-Jiti ESM bytecode. These include concurrent launches, OAuth transport wiring with dummy credentials, full RPC, slim loopback, verified writes and bootstrap installation. Unit loopback tests cover both source and bytecode on the repository-pinned Pi 0.85.0; integration/confirmation uses a synchronized 0.87.1 installation.

New ESM regressions exercise `import.meta`, top-level await and dynamic imports. Existing corruption, dependency-closure, publication/rollback, cache, stream-loss, timeout and tool mutation tests remain enabled. Integration expectations now read the validated upstream model defaults rather than hard-coding the old Grok version. The integration script no longer invokes broad process-name cleanup; its EXIT trap cleans up its own loopback child instead of risking unrelated sessions.

After measurement, only the stock runtime identity preflight was simplified to CLI `--version`; the timing loop is unchanged. The exact measured harness is retained as `measured-latency.ts.gz`. A final **18-process / 72-tool** smoke run and all 119 tests passed; that smoke run is not pooled into the six performance suites.

Warm OS caches; isolated, primed Node compile caches; independently validated Jiti caches. Seeded AB/BA blocks and 10,000 paired-bootstrap resamples. These are workload-specific exploratory intervals, not multiple-comparison-adjusted universal guarantees. All request bodies are synthetic and retained with hashes. Compressed artifacts decompress byte-for-byte to the original results; `index.json` includes both hashes. Small pilots and the unsuccessful CJS build are retained but excluded from confirmation totals. The inconclusive “externalize both Jiti entries” candidate was not adopted.

## Remaining installer limitation

The initial integration attempt against the existing global installation exposed a **pre-existing dependency-resolution assumption**: the coding-agent package is 0.87.1 and resolves nested 0.87.1 dependencies, but the installer selects a sibling pi-ai 0.85.1 for its slim catalog. Catalog validation correctly stopped on missing `xai/grok-4.7`. This is not fixed by bytecode and was not bypassed. A separate, synchronized, lockfile-pinned package tree passed all integration gates. Whole-generation activation/dependency closure remains tracked in [TODO](../../../TODO.md).

The shared runtime was not rebuilt or activated. Its binary SHA-256 remains `697b08fedeeb3dec4f8bb7e7c812b82361a966f90126fa2288546b68b8eb3a27`. No user settings, auth files, sessions, services or VS Code windows were changed. The opt-in flag is not a claim that the mixed global installation is ready for an in-place upgrade.

## Reproduce

Restore the archived package manifest/lock into a fresh isolated directory, then build and measure without touching the shared launcher:

```bash
mkdir -p results-repro/packages
gzip -dc bench/history/stock-bytecode-v1/package-087/package.json.gz > results-repro/packages/package.json
gzip -dc bench/history/stock-bytecode-v1/package-087/bun.lock.gz > results-repro/packages/bun.lock
(cd results-repro/packages && PI_TELEMETRY=0 DO_NOT_TRACK=1 BUN_DISABLE_TELEMETRY=1 bun install --frozen-lockfile --ignore-scripts)
bun run bench:latency --stock "$PWD/results-repro/packages/node_modules/@earendil-works/pi-coding-agent" results-repro/builds
bun run bench:latency --slice results-repro/builds/config.json results-repro/coding.json fastTools coding
bun run bench:latency --plan results-repro/coding.json
taskset -c 2 bun run bench:latency --run results-repro/coding.json results-repro/coding
```

Select an available CPU. Generated configs default to eight rounds and a 60-second budget; the archived coding confirmation/replication explicitly use **12 rounds, two warmups and 90,000 ms**, with seeds **202609 / 202786**. Inspect the archived configs for every scenario/axis value. Fresh output paths are mandatory. Benchmarks do not change the installation default or update packages.
