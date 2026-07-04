# tia benchmarks

These are the latest benchmark highlights from the tia research harness.

## `tia pi` vs stock `pi` (head-to-head, pi 0.80.3)

Same pi source on both sides; isolates what `tia-runtime` adds. Toolchain: pi `0.80.3`, bun `1.4.0`, zig `0.17.0-dev.1158+1d1193aa7`, Linux x86_64 (8 cores). `hyperfine`, 12 runs / 3 warmup (startup), 10 runs / 2 warmup (RPC), no network.

| Workload | stock `pi` | `tia pi` | Speedup |
|---|---:|---:|---:|
| Process startup (`--version`) | 751 ± 81 ms | 579 ± 36 ms | **1.30x** |
| RPC startup (`get_state`) | 802 ± 73 ms | 742 ± 23 ms | **1.08x** |
| JSON stream startup (`--mode json --no-session`, no prompt) | 769 ± 37 ms | 217 ± 10 ms | **3.54x** |

Reproduce: `bash bench/hyperfine-tia-pi.sh` (RPC) and `bash bench/hyperfine-tia-json-stream.sh` (stream). The stock baseline runs the same compiled pi package's `dist/cli.js`.

## 2026-07 optimization pass

Measured on one Linux box with hyperfine (same machine before/after, sandboxed install). Also migrated the pinned pi runtime `0.75.3` → `0.80.3` (latest), which clears 4 Dependabot advisories including a high-severity local privilege-escalation; the slim stream runner's `pi-ai` import moved `stream.js` → `compat.js` to match the restructured package.

| Path | Before | After | Change |
|---|---:|---:|---:|
| `tia pi --version` startup (minified compile) | 838 ms | 534 ms | **-36%** |
| `tia pi` RPC startup (`get_state`) | 1.068 s | 688 ms | **-36%** |
| `tia pi` slim JSON stream startup (bytecode compile) | 471 ms | 205 ms | **-57%** |
| extension `write` burst, 1 MB verified writes | ~27.7 ms/op | ~25.0 ms/op | within noise (one redundant read-back removed) |

What changed:
- the main `tia pi` binary is compiled with `--minify`
- the slim stream runner is compiled with `--minify --bytecode` (with automatic fallback to a plain minified compile), and its module imports load in parallel
- native `write` no longer re-verifies in JS what the `fastwrite` helper already verified twice (after temp write and after rename); verification coverage is unchanged
- the `bash` fast path now defers to stock bash whenever preconditions do not hold (missing source, directory target, missing `rm` target), so exit codes and error output match real bash
- `bench/hyperfine-tia-json-stream.sh` makes the slim-stream startup benchmark reproducible from the harness
- `bench/fast-tools-extension-burst.ts` bursts the real installed extension code path instead of a harness re-implementation
- feedback-loop summaries only report `speedup_vs_baseline` when a suite actually contains a baseline command (retained-only suites now report `n/a` instead of comparing the fast path to itself)

## Summary table (historical research numbers)

These earlier numbers used a `pi-node` (node-runtime) baseline, which starts slower than the bun-run stock `pi` used in the head-to-head above; treat the head-to-head table as the current apples-to-apples comparison.

| Path | Workload | Baseline | Optimized | Speedup |
|---|---|---:|---:|---:|
| `tia pi` | RPC startup (`get_state`) | 1.786 s | 0.961 s | **1.86x** |
| `pi` compiled direct | RPC startup (`get_state`) | 1.476 s | 0.745 s | **1.98x** |
| `tia pi` slim JSON stream | JSON stream startup (`--mode json --no-session`, no prompt) | 1.200 s | 506.0 ms | **2.37x** |
| `tia pi` fast tools | `read` burst | 977.7 ms | 188.6 ms | **5.18x** |
| `tia pi` fast tools | `read` streaming burst | 1.372 s | 249.9 ms | **5.49x** |
| `tia pi` fast tools | `write` burst | 195.5 ms | 193.0 ms | **1.01x** |
| `tia pi` fast tools | `edit` burst | 378.3 ms | 151.0 ms | **2.50x** |
| `tia pi` fast tools | `bash` burst | 513.7 ms | 322.5 ms | **1.59x** |
| `native_search` + Zig | full local fixture generation + extraction + ranking | 2k raw docs | 11.3 ms | zero network |
| `native_search` + Zig | live exact URL smoke + full Zig fetch/extraction/ranking | 3 distinct origins, opt-in | writes `zig-search.md` | bounded live fetches |

## Supported runtime subcommands

Supported user-facing tia runtime subcommands from this project are:
- `tia pi`

`pi` compiled direct remains a benchmark reference, not a separate supported install mode.
Current benchmark results below focus on `tia pi`.

## Source result files

### tia startup / rpc
- `results-tia-pi/rpc.md`
- `results-pi-rpc-direct-smoke/empty.md`

### tia slim JSON streaming
- `results-tia-json-stream/startup.md`

### tia fast tools burst
- `results-pi-tools-fast-burst-smoke/read.md`
- `results-pi-tools-fast-burst-smoke/write.md`
- `results-pi-tools-fast-burst-smoke/edit.md`
- `results-pi-tools-fast-burst-smoke/bash.md`

### tia fast tools streaming
- `results-pi-tools-fast-stream-smoke/read.md`

### tia fast tools persistent
- `results-pi-tools-persistent-smoke/read.md`
- `results-pi-tools-persistent-smoke/edit.md`
- `results-pi-tools-persistent-smoke/bash.md`

### native search
- `results-native-search-zig-smoke/native-search-zig.md`
- `results-native-search-live-smoke/summary.md` (only when explicitly run with `TIA_NATIVE_SEARCH_LIVE=1`)

## Feedback-loop harness

Use the feedback loop when comparing optimization ideas across both speed and reliability:

```bash
bash bench/feedback-loop.sh
```

Defaults:
- 5 smoke rounds
- repeated `hyperfine` runs per round
- correctness gates before benchmarking
- score = mean latency penalized by variance and failures
- retained candidates: compiled/native helpers, compiled/Zig-built helpers, and warm daemon/native helpers
- native helper coverage now includes read, verified write, edit, and optimized bash drain/copy paths
- retired slow approaches: stock Bun tool baseline and Bun source-runner fast path
- `bench/feedback-loop.sh` auto-installs the pinned Zig nightly (`0.17.0-dev.1158+1d1193aa7`) locally via `scripts/install-zig.sh` unless `SETUP_ZIG=0`
- Zig is treated as a measured candidate only when `zig` can build helper variants and beat the current native helpers in this same loop

Results are written under `results-feedback-loop/<run-id>/summary.md` and `summary.json`.

For a heavier confirmation pass:

```bash
TIER=full ROUNDS=5 bash bench/feedback-loop.sh
```

Recent loops found the retained set alternating between compiled/native, compiled/Zig-built, and warm-daemon winners depending on workload. Verified writes now perform exact post-write content checks; any mismatch fails the run.

## How to reproduce

### tia pi startup
```bash
bash bench/hyperfine-tia-pi.sh
```

This resolves a stock pi baseline automatically (installed `pi-node`/`pi`, else the compiled pi package's `dist/cli.js` via bun) and compares it against `tia pi` on the RPC `get_state` startup path.

### tia slim JSON streaming
```bash
bash bench/hyperfine-tia-json-stream.sh
```

This benchmark isolates local JSON streaming startup/runner overhead by sending no prompt. It does not measure provider first-token or token-throughput latency, which is network/model dependent.

### tia fast tools burst
```bash
bash bench/hyperfine-pi-tools-fast-burst.sh
```

This now compares retained candidates only:
- `fast (compiled + native helpers)` where read/edit are pure Zig and the remaining native helpers are active zig cc builds
- `fast (compiled + gcc comparison helpers)` when GCC comparison helpers are available
- `fast (warm daemon + native helpers)`

### tia fast tools streaming
```bash
bash bench/hyperfine-pi-tools-fast-stream.sh
```

This now compares retained candidates only:
- `fast (compiled + native helpers)` where read streaming is a pure Zig native helper
- `fast (compiled + gcc comparison read helper)` when the GCC comparison helper is available

### tia fast tools persistent warm runner
```bash
bash bench/hyperfine-pi-tools-persistent.sh
```

This compares:
- `fast (compiled cold spawn-per-request)`
- `fast (compiled warm daemon + native helpers)`

### native search extraction/ranking
```bash
bash bench/hyperfine-native-search-zig.sh
```

This benchmark performs zero network requests and uses Zig only: `bin/native-search-zig --fixture` generates the raw fixture corpus, then `bin/native-search-zig` decodes, extracts, ranks, and formats results.

Recent local result:
- Full Zig fixture path: **11.3 ± 6.2 ms** for 500 repeats × 4 docs = 2,000 raw docs (about 177k docs/s), including Zig fixture generation, base64 decode, readable extraction, ranking, and output generation.

For a responsible opt-in live smoke with full Zig fetch/extraction/ranking:

```bash
bash bench/build-native-search-zig.sh
TIA_NATIVE_SEARCH_LIVE=1 bash bench/native-search-live-smoke.sh
```

The live phase passes exact URLs from distinct origins to `bin/native-search-zig --urls`, which applies the configured inter-request delay and performs fetch, extraction, ranking, and output in Zig. Recent responsible smoke fetched 3/3 exact documentation URLs in about 10.5 s with a 2.5 s inter-request delay and wrote `zig-search.md`.

## Interpretation

- `tia pi` is the strongest path today.
- It combines:
  - compiled startup
  - sandboxed runtime wiring
  - slim JSON streaming for `--mode json --no-session`
  - fast `read`
  - streamed fast `read` updates
  - fast exact-text `edit`
  - faster `bash` handling on the tested workloads
- `write` improves less dramatically than `read` and `edit`; current feedback-loop write candidates perform exact post-write verification so text mismatches fail the run instead of being counted as success.
- The slim JSON stream path routes `tia pi --mode json --no-session` to a direct provider-streaming runner. In the local no-prompt startup benchmark, it measured 506.0 ms versus 1.200 s for the full compiled JSON path with `TIA_DISABLE_FAST_STREAM=1` (**2.37x** faster).
- In the direct tool streaming runner, fast `read` delivered about 7 partial updates per iteration with about 1.29 ms average time-to-first-update across 60 iterations.
- `native_search` now requires the compiled Zig backend for fetch/decode/extract/rank/output. TypeScript is kept to pi tool registration plus bounded site discovery orchestration only; the benchmark path for native search is Zig-only.
