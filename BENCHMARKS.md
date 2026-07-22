# tia benchmarks

These are the latest benchmark highlights from the tia research harness.

## Optimization version `2026-07-low-level-v4` (current)

The runtime is pinned to `@earendil-works/pi-coding-agent` **0.81.1**. The slim runner now reads a provider-specific model catalog instead of initializing every provider model, exact full-line edits render bounded diffs without indexing complete files, and the stream writer keeps its common two-index state out of a `Map`.

Current same-source head-to-head results (`hyperfine`, sequential runs, no network):

| Workload | Baseline | `tia pi` optimized | Speedup |
|---|---:|---:|---:|
| Process startup (`--version`) | stock: 304.8 ± 25.3 ms | 229.1 ± 4.5 ms | **1.33x** |
| RPC startup (`get_state`) | stock: 324.1 ± 9.6 ms | 261.8 ± 4.4 ms | **1.24x** |
| JSON startup (`--mode json --no-session`) | full tia: 262.8 ± 13.0 ms | slim tia: 24.2 ± 3.2 ms | **10.87x** |

Alternating or paired before/after measurements for this optimization version:

| Path | Workload | Before | After | Speedup |
|---|---|---:|---:|---:|
| slim startup | provider-selective no-prompt startup | 20.074 ms | 17.869 ms | **1.12x** |
| slim startup | unqualified model lookup | 20.485 ms | 19.756 ms | **1.04x** |
| extension `edit` | 100KB verified replacement + diff | 0.507 ms/op | 0.362 ms/op | **1.40x** |
| slim stream writer | 2M interleaved deltas | 39.966 ns/delta | 34.858 ns/delta | **1.15x** |
| native read | 50KB window | 0.853 ms/op | 0.753 ms/op | **1.13x** |
| native edit | exact replacement | 13.770 ms/op | 7.704 ms/op | **1.79x** |
| native verified write | 1MB atomic write | 16.731 ms/op | 16.239 ms/op | **1.03x** |
| native bash | 5MB drain/copy/remove chain | 11.587 ms/op | 3.635 ms/op | **3.19x** |

Low-level changes:
- provider catalogs are emitted as independent minified JSON files; an allocation-light text index resolves unqualified model IDs
- aligned full-line edit diffs scan only changed lines and four context lines while retaining generic formatting for other edits
- the stream writer uses two inline delta slots and lazily allocates a map only for additional content indexes
- the native read helper uses `memchr`, bounded output buffering, and C built with `zig cc`; the slower duplicate Zig read implementation was removed
- native copy uses larger `copy_file_range` requests and no longer adds an `fsync` that normal `cp` does not provide
- native verified writes compare through the existing read/write descriptor without allocating and reopening full files
- benchmark and RPC paths no longer contain machine-specific package paths; formatting, linting, and TypeScript checks cover every TypeScript source

The complete machine-readable record is `bench/history/2026-07-low-level-v4.json`.

## Optimization version `2026-07-low-level-v3`

The slim streaming path now keeps only its small control plane in the compiled executable. Provider implementations are installed as minified split ESM assets and loaded on demand, while settings, auth, model overrides, and model selection are resolved directly without initializing the full coding-agent registry stack.

| Workload | Previous | Optimized | Speedup |
|---|---:|---:|---:|
| Slim JSON startup, no network | 236.2 ± 18.9 ms | 97.5 ± 9.6 ms | **2.42x** |
| End-to-end loopback Anthropic stream | 238.9 ms | 116.9 ± 11.5 ms | **2.04x** |
| Full tia JSON vs slim JSON startup | 1.161 s | 97.5 ms | **11.91x** |

The loopback measurement includes process launch, configuration/model/auth resolution, loading the selected provider implementation, an HTTP/SSE request, stream framing, and shutdown. It therefore checks that reducing executable startup does not merely move the cost into first request setup. Text deltas now bypass the 4 ms batching timer and are microtask-coalesced, preserving same-turn batching without adding timer latency.

The launcher routes slim calls before FFF setup and shell-agent symlink refresh. It passes the source agent directory directly to the runner, while retaining the cliproxy availability check. The machine-readable record is `bench/history/2026-07-low-level-v3.json`.

## Optimization version `2026-07-low-level-v2`

The runtime and development baseline are pinned to `@earendil-works/pi-coding-agent` **0.80.6**, verified as the latest npm release on 2026-07-12. `tia status` prints the optimization version so installed runtimes can be tied back to benchmark records. The machine-readable record is committed at `bench/history/2026-07-low-level-v2.json`.

Recorded no-network startup comparison, run sequentially on the same pi 0.80.6 source:

| Workload | Baseline | Optimized | Speedup |
|---|---:|---:|---:|
| Process startup (`--version`) | stock: 1.037 ± 0.172 s | `tia pi`: 742.2 ± 121.1 ms | **1.40x** |
| RPC startup (`get_state`) | stock: 1.901 ± 0.172 s | `tia pi`: 661.4 ± 49.1 ms | **2.87x** |
| JSON startup (`--mode json --no-session`) | full tia: 656.9 ± 30.0 ms | slim tia: 236.2 ± 18.9 ms | **2.78x** |

Component before/after measurements retained by this optimization version:

| Path | Workload | Before | After | Speedup |
|---|---|---:|---:|---:|
| extension `write` | 1MB verified atomic writes | 2.825 ms/op | 2.111 ms/op | **1.34x** |
| extension `edit` | 100KB verified single replacement + rendered diff | 2.028 ms/op | 1.647 ms/op | **1.23x** |
| slim stream writer | 10M small deltas | 1.296 ± 0.076 s | 961.3 ± 48.1 ms | **1.35x** |
| `tia pi` slim launcher | no-prompt JSON startup | 233.3 ± 11.4 ms | 189.9 ± 19.0 ms | **1.23x** |

Tool numbers are medians from 12 alternating baseline/optimized rounds. The stream-writer comparison used `hyperfine`, 15 runs / 3 warmup. The launcher comparison used 30 runs / 5 warmup; its direct slim binary measured 184.2 ± 19.2 ms, reducing wrapper overhead from about 49 ms to about 6 ms.

Low-level changes:
- atomic writes now verify bytes directly through the already-open temporary file descriptor with a reused 256KB comparison buffer, avoiding a close/reopen cycle and a full-size verification allocation
- target type/mode uses one `lstat` instead of separate `lstat` + `stat` calls, and collision-safe per-process temp nonces replace timestamp/UUID generation
- exact edit verification uses the same allocation-bounded scanner; output assembly writes into one exact-size buffer
- diff generation stores numeric line offsets and materializes only displayed lines instead of splitting both complete files into thousands of strings
- the launcher caches cliproxy checks for 30 seconds, refreshes shell-agent links only when the source directory changes, and avoids unconditional `mkdir` subprocesses; set `TIA_PROXY_CHECK_INTERVAL_SECONDS=0` for an uncached proxy check
- the slim stream writer batches output in chunk arrays, avoids repeated buffer lookups, specializes the one-index flush path, and coalesces redundant queued microtasks

Correctness gates included the complete fast-tools I/O/patch suite and a 5,000-case randomized parity check against the previous line-diff formatter.

## Previous head-to-head record (pi 0.80.3)

Same pi source on both sides; isolates what `tia-runtime` adds. Toolchain: pi `0.80.3`, bun `1.4.0`, zig `0.17.0-dev.1158+1d1193aa7`, Linux x86_64 (8 cores). `hyperfine`, 12 runs / 3 warmup (startup), 10 runs / 2 warmup (RPC), no network.

| Workload | stock `pi` | `tia pi` | Speedup |
|---|---:|---:|---:|
| Process startup (`--version`) | 751 ± 81 ms | 579 ± 36 ms | **1.30x** |
| RPC startup (`get_state`) | 802 ± 73 ms | 742 ± 23 ms | **1.08x** |
| JSON stream startup (`--mode json --no-session`, no prompt) | 769 ± 37 ms | 217 ± 10 ms | **3.54x** |

Reproduce: `bash bench/hyperfine-tia-pi.sh` (RPC) and `bash bench/hyperfine-tia-json-stream.sh` (stream). The stock baseline runs the same compiled pi package's `dist/cli.js`.

## 2026-07 in-process fast-tools pass (10x read/write/edit)

The extension's `read`/`write`/`edit` hot paths were rewritten to run fully in-process, replacing per-call native helper spawns (`fastread-window`, `fastwrite`, `fastedit`) with byte-level I/O inside the extension:

- `read`: single-pass windowed scanner — memchr-backed `Buffer.indexOf` newline scan over a reused scratch buffer, one UTF-8 decode per contiguous accepted run, byte-level joins for lines spanning scan chunks (no split-codepoint decodes), 64KB first read for the common offset-1/50KB-cap window.
- `write`: atomic temp-file + rename with one byte-for-byte read-back verification of the temp file before the rename replaces the target (rename moves the verified inode). `TIA_FASTWRITE_FSYNC=1` opts into fsync durability (data + parent dir); content verification never depends on it.
- `edit` (single replacement): in-place byte-level search/replace with read-back verification and best-effort rollback; keeps the target's inode, mode, and symlink identity. Multi-edit and patch paths verify by byte comparison as well.

Why this wins: each old call paid ~1.4 ms of process spawn plus pipe copies and duplicated verification reads; a windowed read or verified 1MB write is fundamentally a sub-millisecond-to-few-millisecond operation once it stays in-process.

Measured on one Linux box (disk-backed `$TMPDIR`, bun 1.4.0, pi 0.80.3) with the real installed extension code path, `bun bench/fast-tools-extension-burst.ts <tool> 40`, medians across 5+ runs before/after:

| Tool | Workload | Before | After | Speedup |
|---|---|---:|---:|---:|
| `read` | 5MB file, 50KB window burst | 2.56 ms/op | 0.17 ms/op | **14.7x** |
| `write` | 1MB verified atomic write burst | 24.7 ms/op | 2.37 ms/op | **10.4x** |
| `edit` | 100KB file, verified single replacement burst | 20.6 ms/op | 1.84 ms/op | **11.2x** |

Verification semantics kept (all read-back based, none removed): write verifies exact bytes before the atomic rename; edit verifies exact bytes after the in-place write and restores the original on mismatch. Coverage added for chunk-boundary unicode windows, truncation messages, no-trailing-newline windows, CRLF payloads, fsync opt-in, write serialization, and large-file edits (`scripts/fast-tools-io.test.ts`).

The `fastdrain`/`fastcopy` helpers remain on the `bash` fast path; `fastread-window`/`fastwrite`/`fastedit` binaries are now benchmark comparison baselines only and are no longer installed to the agent sandbox.

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
- `bench/feedback-loop.sh` auto-installs the pinned Zig nightly (`0.17.0-dev.1441+d5181a9c9`) locally via `scripts/install-zig.sh` unless `SETUP_ZIG=0`
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
- `fast (compiled + native helpers)` where read/write/copy/drain are C built with zig cc and edit is pure Zig
- `fast (compiled + gcc comparison helpers)` when GCC comparison helpers are available
- `fast (warm daemon + native helpers)`

### tia fast tools streaming
```bash
bash bench/hyperfine-pi-tools-fast-stream.sh
```

This now compares retained candidates only:
- `fast (compiled + native helpers)` where read streaming uses the C helper built with zig cc
- `fast (compiled + gcc comparison read helper)` when the GCC comparison helper is available

### tia fast tools persistent warm runner
```bash
bash bench/hyperfine-pi-tools-persistent.sh
```

This compares:
- `fast (compiled cold spawn-per-request)`
- `fast (compiled warm daemon + native helpers)`

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
