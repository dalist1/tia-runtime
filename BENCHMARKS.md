# tia benchmarks

These are the latest benchmark highlights from the tia research harness.

## Summary table

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
- `bench/feedback-loop.sh` auto-installs Zig locally via `scripts/install-zig.sh` unless `SETUP_ZIG=0`
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
hyperfine --runs 4 --warmup 1 \
  --command-name 'pi original rpc' \
  'env -u PI_PACKAGE_DIR -u PI_CODING_AGENT_DIR ANTHROPIC_API_KEY=dummy pi-node --mode rpc --no-session --no-extensions --no-skills --no-prompt-templates --no-themes < ./payloads-rpc/empty.get-state.jsonl' \
  --command-name 'tia pi rpc' \
  'env -u PI_PACKAGE_DIR ANTHROPIC_API_KEY=dummy tia pi --mode rpc --no-session --no-skills --no-prompt-templates --no-themes < ./payloads-rpc/empty.get-state.jsonl'
```

### tia slim JSON streaming
```bash
mkdir -p results-tia-json-stream
hyperfine --warmup 2 --runs 10 --shell=none \
  --export-json results-tia-json-stream/startup.json \
  --export-markdown results-tia-json-stream/startup.md \
  --command-name 'tia slim json stream startup' \
  'tia pi --mode json --no-session' \
  --command-name 'tia full json startup' \
  'env TIA_DISABLE_FAST_STREAM=1 tia pi --mode json --no-session'
```

This benchmark isolates local JSON streaming startup/runner overhead by sending no prompt. It does not measure provider first-token or token-throughput latency, which is network/model dependent.

### tia fast tools burst
```bash
bash bench/hyperfine-pi-tools-fast-burst.sh
```

This now compares retained candidates only:
- `fast (compiled + native helpers)`
- `fast (compiled + zigcc helpers)` when Zig helpers are available
- `fast (warm daemon + native helpers)`

### tia fast tools streaming
```bash
bash bench/hyperfine-pi-tools-fast-stream.sh
```

This now compares retained candidates only:
- `fast (compiled + native helpers)`
- `fast (compiled + zigcc helpers)` when Zig helpers are available

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
