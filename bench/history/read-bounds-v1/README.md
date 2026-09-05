# Read bounds: measured speed and reliability

Released as **v0.4.0**, optimization marker **`2026-09-read-bounds-v1`**. The version bump does not change the benchmarked extension bytes; original measurement records remain unchanged.

The subsequent release gate passed **89 unit tests** (including the new version-consistency test) and all **12 pinned integration stages**. The installed and bootstrap launchers report the new marker. See `release-validation.json`; the original 88-test benchmark gate below remains a historical record.

Recorded 2026-09-04 (machine UTC clock), pi **0.84.4**, Bun **1.4.1-canary.1**, Linux x86_64, Intel i7-1360P. Workloads used an ext4-backed `/tmp`, warm page cache, and CPU affinity **2** (a performance core). No CPU governor or system-wide settings were changed.

## Result

**The 10× target was exceeded for reads that discard a giant following line—not for all tools.** The installed-extension confirmation measured **274×** faster line-limited reads, **70×** faster byte-limited reads, and **2.74×** faster oversized-first-line handling.

The implementation change is confined to `scanReadWindow` in `scripts/fast-tools-extension.ts`:

- Search only bytes actually returned by `readSync`, not the unused scratch-buffer tail.
- Stop at a satisfied line limit before accumulating an unterminated following line.
- Stop after exceeding the byte budget when at least one line has already been accepted.
- Drop oversized carry buffers while still counting an oversized first line to report its exact size.

No content cache, skipped verification, new native dependency, or write/edit semantic change was introduced. Unlimited skill reads still return the complete file. This is not a claim of globally optimal performance.

## Installed-extension confirmation

Each row has **2,400 measured operations per implementation**, plus **720 warmup operations per implementation**. Times below are per-operation medians. Speedup uses paired round **means**, not the quotient of the displayed medians; its interval is a paired bootstrap 95% CI.

| Workload | Before p50 (ms) | After p50 (ms) | Paired mean speedup [95% CI] |
|---|---:|---:|---:|
| Tiny 11-byte UTF-8 file, no newline | 0.0067 | 0.0042 | 1.28× [0.61, 2.56] |
| 5 MiB file, default 50 KiB window | 0.0294 | 0.0297 | 1.01× [0.93, 1.09] |
| 5 MiB file, offset 60,000, 100 lines | 1.0078 | 0.9970 | 1.01× [0.97, 1.04] |
| One accepted line, discarded 16 MiB tail | 2.1320 | 0.0058 | **274.43× [247.62, 306.17]** |
| 48 KiB accepted, discarded 16 MiB tail | 2.0934 | 0.0197 | **70.19× [61.42, 80.75]** |
| Oversized 16 MiB first line, exact size diagnostic | 2.0663 | 0.8372 | **2.74× [2.65, 2.81]** |
| UTF-8/CRLF window crossing scan chunks | 0.0897 | 0.0900 | 0.99× [0.90, 1.09] |
| Unlimited UTF-8 skill read | 0.7289 | 0.7318 | 0.99× [0.98, 1.00] |
| 1 MiB verified atomic write | 0.3771 | 0.3737 | 0.97× [0.94, 1.00] |
| 100 KB verified edit with rendered diff | 0.1520 | 0.1512 | 1.05× [0.99, 1.13] |

For the three confirmed improvements, p95 latency changed respectively from **4.986 → 0.00790 ms**, **4.802 → 0.0473 ms**, and **4.684 → 1.405 ms**. Full p50/p95/mean statistics and all individual samples are archived.

The tiny-file median improvement reproduced, but its mean-latency confidence interval did not; **no repeatable mean-speedup claim is made for tiny reads**. No material improvement or regression was established for the remaining workloads. The classification requires the entire mean-speedup CI to exceed 1.05 (improvement) or fall below 1/1.05 (regression). This threshold is not proof that smaller effects do not exist.

## Controls and limitations

Three valid runs each completed **62,400 checked operations**, for **187,200 total**, with zero incorrect results:

1. `control`: original code versus itself, 12 alternating AB/BA pairs. No material improvements/regressions were detected.
2. `comparison`: repository baseline versus candidate, 12 pairs. The three principal gains were 271×, 114×, and 2.52×.
3. `installed-confirmation`: both implementations resolved the same installed dependency files, 12 pairs. The installed candidate's SHA-256 equals the repository candidate's.

An additional `installed-mixed-dependencies` run is retained **but excluded from optimization conclusions and the 187,200 count**. It mixed repository and global dependencies and reported apparent regressions in unchanged code. The harness now rejects mismatched resolved dependency files before timing. Earlier exploratory, unpinned runs also showed noise in unchanged code; they motivated workload isolation and pinning on this hybrid-core CPU, not selective deletion of samples from the final runs.

Each workload/candidate gets a fresh process, 60 warmup operations, and 200 measured operations. Candidate order alternates each round. Every operation's returned read result is checked against an independent whole-file reference; writes and edits are reread and checked byte-for-byte, and edit diffs are checked for both tokens. Import, fixture setup, and independent assertions are outside the timed interval; the tools' own verification remains inside it. No samples are removed. Confidence intervals use 10,000 seeded resamples of paired rounds, preserving pairing rather than treating individual operations as independent trials.

These are direct calls to the actual extension functions, including a byte-identical installed copy—not model/API latency, TUI rendering, RPC round trips, cold-disk throughput, or FFF search benchmarks. Assertions and fixture generation can influence allocator/cache state despite being excluded from elapsed time. Warm writes use the default `TIA_FASTWRITE_FSYNC=0`; read-back verification is enabled, but crash durability is not being benchmarked. Zero observed failures does not establish zero production failure probability.

## Reliability gates

- **88 unit tests passed**, including native copy/write fault injection and the existing write/edit/patch regression suite.
- **1,500 deterministic randomized read windows** matched an independent reference, covering skipped oversized lines, Unicode, NULs, CRLF, empty files, truncation, and offsets beyond EOF.
- Short reads splitting UTF-8 into single bytes, exact chunk-boundary EOF, external rewrites, cancellation, and injected I/O errors are covered. Cancellation/error tests check that the descriptor was closed.
- Four giant-tail cases assert **at most 64 KiB actually read**, with correct output and continuation hints (line/byte limits, with/without a trailing newline).
- An oversized-first-line test asserts **at most 50 KiB copied into carry buffers**, rather than retaining the discarded multi-megabyte line.
- A short-file test asserts that newline search examines exactly the five bytes read, not the 256 KiB scratch allocation.
- The original source fails all **six** new resource-bound assertions; the candidate passes. Output correctness checks also pass against the original source.
- Shell syntax, formatting, lint, and TypeScript checks passed.
- All **12 install/runtime integration stages passed on explicitly pinned pi 0.84.4**, including concurrent launches, RPC, local SSE streaming, verified writes, and bootstrap installation. `test.sh` now checks the explicitly requested version when supplied, rather than always comparing with npm's latest tag.

**Unresolved upstream installation failure:** the first plain `bash test.sh` fetched pi **0.85.0** and failed to bundle its undeclared `@earendil-works/pi-server` and `@earendil-works/pi-server/unix` imports. That latest-version gate did **not** pass. The global package set was restored to 0.84.4 using the existing installer override, and the upgraded extension was installed and verified there. No claim is made that default latest-version installation is fixed.

## Reproduce

Baseline commit: `1ea9b47dc3f5039fc4c1e618799b3ce470a438b0`.

From the repository root, with the locked development dependencies installed:

```bash
mkdir -p results-tool-benchmark/baseline
git show 1ea9b47dc3f5039fc4c1e618799b3ce470a438b0:scripts/fast-tools-extension.ts \
  > results-tool-benchmark/baseline/extension.ts

# Use an available performance core on your machine; CPU 2 was used here.
TIA_BENCH_CANDIDATE="$PWD/results-tool-benchmark/baseline/extension.ts" \
  taskset -c 2 bun run bench:tools results-tool-benchmark/baseline/extension.ts \
  results-tool-benchmark/control.json 12 200 60

taskset -c 2 bun run bench:tools results-tool-benchmark/baseline/extension.ts \
  results-tool-benchmark/comparison.json 12 200 60

bash -n install.sh scripts/install-tia.sh test.sh
bun run format
bun run lint
bun run typecheck
bun test
TIA_PI_PACKAGE_VERSION=0.84.4 bash test.sh
```

The last command installs the runtime and changes the global pi package set. It requires network access for installation; benchmark workers themselves make no model/network requests. Omit `taskset` on unsupported platforms, but record the changed conditions.

For installed-code confirmation, place the original source in a temporary directory **beside the installed agent's `node_modules` tree, outside its auto-discovered `extensions` directory**, and set `TIA_BENCH_CANDIDATE` to the installed `extensions/fast-tools.ts`. This machine required `NODE_PATH="$PWD/node_modules"` for direct Bun resolution of `@sinclair/typebox`; normal pi loads the extension through its own loader. The harness rejects comparisons whose dependencies resolve differently.

## Artifacts

`summary.json` contains run metadata, checksums, complete summary statistics, and CI results. The four `*.json.gz` files contain the original complete JSON records, including every raw sample; decompress with `gzip -dc <file.json.gz>`. `validation.json` records the final gates and the upstream failure. Harness: `bench/tool-benchmark.ts`; reference oracle: `bench/tool-read-reference.ts`; harness tests: `bench/tool-benchmark.test.ts`.
