# Runtime boundaries: first-principles optimization through tia

Release **v0.5.0**; optimization marker **`2026-09-runtime-boundaries-v1`**. Baseline repository: `d04ac4c99133b418d43c9644c092606d5b1a3494`. Upstream pi **0.84.4**, Jiti **2.7.0**, Bun **1.4.1-canary.1**, Linux i7-1360P, CPU affinity **2**, warm filesystem cache.

## What changed

The first-principles question was **which work is necessary before the first useful operation?** Pi's Bun entrypoint eagerly imports `jiti/static` through its extension loader. That entrypoint embeds the Babel transformer, even when no extension needs transformation. The transformer was approximately 1.68 MB of the compiled JavaScript graph.

`build-pi.ts` redirects only that bundler import to **the same Jiti package's supported regular entrypoint**, whose transformer is lazy. Pi's extension loader still supplies its original virtual modules and options. No upstream files, agent-loop implementation, OAuth registration, image worker, tool implementation, or CLI semantics were patched. This is a build-boundary optimization in the wrapper, not a slim replacement for full pi.

### Measured installed confirmation

| Full compiled pi workload | Before mean (ms) | After mean (ms) | Paired speedup [95% CI] | Before → after p95 (ms) |
|---|---:|---:|---:|---:|
| `--version` | 232.07 | 185.34 | **1.25× [1.25, 1.26]** | 240.33 → 191.18 |
| RPC startup, minimal resources | 264.74 | 218.47 | **1.21× [1.21, 1.22]** | 269.98 → 223.65 |
| RPC + cached TypeScript read/write/edit/bash probes | 282.16 | 235.24 | **1.20× [1.19, 1.20]** | 287.78 → 239.85 |
| Same probes, transpilation cache disabled | 602.50 | 592.71 | 1.02× [1.01, 1.02] | 614.94 → 604.79 |

The cached tool workload saves **46.92 ms**, or about **16.6%** of its elapsed time. The uncached gain is below the 5% materiality threshold; no major cold-transpilation improvement is claimed. Ratios are geometric means of paired round-mean ratios, not ratios of pooled medians.

The installed bundle contains **6,417,452 → 4,735,915 JavaScript bytes** (**26.2% fewer**). The ELF binary is **87,725,536 → 86,046,176 bytes** (**1.9% smaller**). The Jiti dependency still exists in a verified companion directory, so this is neither a 26% reduction in total installation size nor a 26% RAM claim.

## Breakdown by boundary

| Boundary | Evidence | Wrapper intervention / remaining work |
|---|---|---|
| Shell routing and environment | Full and slim routes are already distinct; the benchmark below calls compiled binaries directly | Preserve full-tool routing; separately profile launcher/FFF overhead rather than attributing it to this change |
| VM startup, bundled source and module evaluation | About 2,000 modules; source bytes are dominated by a few large packages, especially Jiti and highlighting | Weight the import graph by bytes, not module count; retain lazy Jiti loading |
| Pi initialization after imports | Separate `PI_TIMING=1` probes show roughly 27–29 ms in the main timing group before and after; whole instrumented launches are roughly 252 → 206 ms | Most of this improvement occurs outside pi's existing main timers; do not add overlapping timing namespaces |
| Extension transformation | Warm tool startup improves materially; disabling Jiti's filesystem cache makes transformation dominate | Keep upstream cache validation and transformation semantics; measure cold and cached execution separately |
| Tool execution and kernel I/O | Startup probes execute the registered read, write, edit, and bash handlers and check their results | Retain byte verification, queues, and fallback behavior; read-bounds work from v0.4.0 remains unchanged |
| Provider/network/agent turns | Not exercised by these latency benchmarks; local SSE/OAuth integration checks still pass | Do not claim faster model tokens or a faster complete reasoning turn |
| Build/publication | Previously the compiler wrote directly to the live binary path | Verify a staged binary before atomic replacement; retain immutable companions for older binaries |
| Complete installation/dependency closure | Global package installation and other assets are still outside the binary transaction; pi 0.85.0 has undeclared server imports | This remains a separate hardening target, not a solved problem |

### Syscall confirmation

Separate `strace -f -e trace=openat` runs on the same candidate and real fast-tools extension showed:

- **Warm Jiti cache: 0 opens of `dist/babel.cjs`.**
- **`JITI_FS_CACHE=false`: 1 open of `dist/babel.cjs`.**

The transformer is genuinely deferred, not disabled. Evidence is in `lazy-load-trace.json`; traces were not used for latency estimates.

## Robustness added

- The selected Jiti package must have no declared runtime, optional, or peer dependencies. A changed dependency closure fails closed rather than silently creating an incomplete companion.
- The selected Jiti package is copied to `full-runtime/jiti-<SHA-256>/`, then reread and verified. Reused companions are checked again; corrupt or symlink-substituted companions fail closed.
- Binaries refer to their own content-addressed companion, not a mutable global Jiti path. Tests confirm an older binary still uses its original Jiti snapshot after a newer snapshot is built.
- The compiler writes to a same-filesystem staging directory, checks build success and the expected upstream import boundary, and runs an isolated `--version` smoke check with a deadline.
- Compilation, upstream-shape, and smoke-check failures preserve the previous binary and remove binary staging files. Publication uses an atomic rename after these checks.
- Old companions are deliberately retained: a running older process may need its transformer later. Do not delete them merely because a newer binary exists.
- `TIA_DISABLE_LAZY_JITI=1` during installation selects the stock bundled build. It is an explicit compatibility escape hatch, not an automatic claim that unknown upstream versions support this optimization.
- `pi-build.json` records mode, dependency fingerprint, upstream entrypoint hash, binary hash, module count, and byte contributions. `tia status` reports `full pi build: lazy-jiti` or `bundled`.

These safeguards are **not** a complete installer transaction, power-loss durability guarantee, filesystem security sandbox, or proof that every third-party extension is compatible. The installer still updates global packages before building and subsequently refreshes other assets. Immutable whole-runtime generations and dependency-closure validation are next steps.

## Validation and methodology

**98 unit tests passed**, including eight new snapshot/build/publication failure tests and RPC benchmark validation. All **12 pinned runtime integration stages passed in both lazy and stock build modes**, including bootstrap, concurrent launches, OAuth, local SSE streaming, and installed binary hash checks. Lazy mode was restored afterward; the installed binary remains byte-identical to the benchmarked candidate. Formatting, lint, typecheck, and shell syntax checks passed.

Three benchmark suites each validated **504 process runs** and **1,008 registered tool calls**, totaling **1,512 process runs** and **3,024 tool calls**:

1. `control.json`: same baseline binary on both sides; all four 95% intervals include 1.00.
2. `comparison.json`: both binaries built from the locked repository dependency tree; cached tool startup improved 1.21×.
3. `installed-confirmation.json`: baseline and candidate built from the same installed package tree; cached tool startup improved 1.20×. Repository/global dependency trees were not mixed in one comparison.

Each workload has 12 alternating AB/BA pairs and five launches per candidate per pair, plus three validated warmups per candidate. Every sample uses a fresh process. The harness uses isolated agent settings, an isolated Jiti cache, dummy credentials, `PI_OFFLINE=1`, and no network/model request. Tool cases register the actual fast-tools extension, execute all four handlers at session startup, verify bytes/results, and require successful RPC state and command registration responses.

Elapsed time includes process launch, full compiled pi initialization, the tool probe where applicable, output draining, and exit. It excludes fixture creation and external assertions. The uncached case disables only the transform cache, not the OS page cache. All samples are retained. Confidence intervals use 10,000 seeded paired-bootstrap resamples over round means.

This measures the **full compiled runtime without automatic extension/skill/theme discovery**, not the shell wrapper's overhead, default FFF indexing, TUI paint latency, session replay, or actual LLM tool selection. Existing integration checks cover wrapper wiring but do not turn this into an end-to-end agent benchmark.

## Rejected candidates and measurement pitfalls

- **Full-bytecode compilation:** the upstream entrypoint's top-level await did not compile to bytecode. An experimental asynchronous adapter got farther, but Bun emitted a bytecode-generation error and produced unusable output. Rejected; no upstream code rewrite or bytecode speedup shipped.
- **External syntax highlighting:** the pilot measured about 243 ms versus 236 ms for baseline RPC, while lazy Jiti alone measured about 190 ms. Moving more source out of the binary did not necessarily reduce required evaluation work. Rejected; highlighting stays bundled.
- **Both dependencies external:** about 194 ms in that pilot, no advantage over Jiti alone and more external dependencies. Rejected.
- **Bare external `jiti/static`:** compiled execution could not resolve that specifier from Bun's embedded filesystem. The retained build resolves the supported regular entrypoint and snapshots its package instead of relying on ambient `NODE_PATH`.
- **Peak-RSS inference:** direct Bun-spawn resource readings showed an inherited high-water floor, unlike an independent small `/usr/bin/time` launcher. The harness therefore makes no per-candidate peak-RSS claim. Bundle bytes are not used as a RAM proxy.

Pilot data and rejected-build diagnostics are summarized in `exploratory.json`. They are not pooled with the controlled benchmarks.

## Next first-principles work

1. **Dependency closure and whole-runtime activation:** resolve a synchronized package set into an isolated generation, validate all emitted external imports, then switch the complete generation atomically. Keep the prior generation usable if any package/FFF/catalog/build step fails.
2. **Cold extension loading:** profile parsing versus cache validation versus dependency evaluation. Test cache invalidation and reload behavior before attempting native TypeScript loading or a different compiler.
3. **Full daily-session latency:** add an offline multi-turn/long-history fixture with the normal toolkit, measuring resource discovery, first usable RPC/TUI, tool scheduling, event-loop delay, and serialization bytes independently.
4. **Agent-loop and context costs:** measure work proportional to the whole conversation versus the changed suffix. Only introduce incremental caches if edits, branches, compaction, cancellation, and external mutation have explicit invalidation rules.

These are investigation targets, not additional delivered speedups. Amdahl's law still applies: removing roughly 47 ms of startup cannot make a multi-second model response 20% faster.

## Reproduce

Build both candidates from the **same** installed source tree, without editing it:

```bash
PI_PKG="$(cat "$HOME/.local/share/tia/pi-package-dir.txt")"
mkdir -p results-runtime-boundaries
TIA_DISABLE_LAZY_JITI=1 bun scripts/build-pi.ts "$PI_PKG" \
  results-runtime-boundaries/pi-baseline results-runtime-boundaries/full-runtime \
  > results-runtime-boundaries/baseline-build.json
bun scripts/build-pi.ts "$PI_PKG" \
  results-runtime-boundaries/pi-candidate results-runtime-boundaries/full-runtime \
  > results-runtime-boundaries/candidate-build.json

# Choose an available performance core; CPU 2 was used for the archived runs.
taskset -c 2 bun run bench:runtime \
  results-runtime-boundaries/pi-baseline results-runtime-boundaries/pi-baseline \
  "$PI_PKG" results-runtime-boundaries/control.json 12 5
taskset -c 2 bun run bench:runtime \
  results-runtime-boundaries/pi-baseline results-runtime-boundaries/pi-candidate \
  "$PI_PKG" results-runtime-boundaries/comparison.json 12 5

TIA_PI_PACKAGE_VERSION=0.84.4 bash test.sh
```

The integration command installs the runtime and changes the global package set. This release still documents pi **0.84.4** as validated. Inspection of the published pi **0.85.0** manifest confirms the missing `pi-server` dependency while a matching server package exists, but automatic dependency repair and a successful unpinned 0.85.0 integration gate are **not** delivered here. See `TODO.md`.

Artifacts: three complete timing JSON records; four build-metadata records; `startup-phases.json`; `lazy-load-trace.json`; `exploratory.json`; and `validation.json`. Raw previous read-tool measurements remain under `../read-bounds-v1/` and are not combined with this startup result.
