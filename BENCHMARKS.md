# Benchmarks

Runtime **v0.5.0** · `2026-09-runtime-boundaries-v1`

## Granular latency

```bash
bun run bench:latency --init results-latency/config.json
bun run bench:latency --slice results-latency/config.json results-latency/one.json transformCache coding
bun run bench:latency --plan results-latency/one.json
bun run bench:latency --run results-latency/one.json results-latency/one-run
```

`--slice <config> <new-config> <axis|baseline> [scenario]` varies one parameter and preserves the baseline. Progress prints after every process. `maxDurationMs` defaults to **60000**; interrupted/expired runs retain partial evidence but cannot report success. Change the budget explicitly for longer confirmations.

- **15 runtime/request axes:** persistence, skills, prompts, themes, context, fast tools, FFF modes, transform caching, thinking, cache retention, transport, and four slim-output controls. `--plan` prints supported values, scope, exclusions and exact run counts.
- **Five build axes:** lazy Jiti, syntax/whitespace/identifier minification, bytecode. `--build <pi-package> <new-build-dir>` screens them; append `grid` for all 32 combinations. Use generated `targets.json` in a config, preferably two targets at a time.
- Config designs: `oat`, `pairs` (all two-factor combinations), `grid` (bounded Cartesian product). First axis value = baseline. Named slices avoid long global sweeps.
- Scenarios: `paced`, `coding`, `burst-long-context`, `sparse`, `slow-consumer`.
- Metrics: launch/readiness, request setup, first text, per-delta delivery p50/p95/p99/max, inter-delta gaps, completion tail, CPU/output bytes, four-tool continuations and warm RPC turns.
- Exact text, tool results, file bytes, completion, cache state and source/binary hashes are checked. Raw JSONL samples and exact synthetic request bodies are retained with hashes; errors/timeouts never become fast samples.

**Scope:** local Anthropic SSE, dummy credentials, telemetry off. Deltas are not model tokens; pipe receipt is not terminal paint. Provider thinking/cache/transport axes measure request construction, not reasoning quality, real cache hits or WebSocket performance. Only RPC measures warm sessions; slim cannot run coding tools. Use compiled binaries or an explicitly isolated launcher installation—not your shared workstation launcher. Unknown controls fail validation; inapplicable axes are reported.

**Statistics:** seeded randomized AB/BA blocks, same-code controls and 10,000 paired bootstrap resamples. Multiple-comparison intervals are exploratory, not automatic tuning recommendations. Inspect `controlWarnings`, tail latency and CPU, then confirm a shortlist independently. No user settings are changed.

**Cache correction:** `JITI_FS_CACHE` is boolean. Current harnesses isolate through `TMPDIR` and `JITI_RESPECT_TMPDIR_ENV=1`, checking cache files before/after. Historical records are unchanged; earlier directory-valued cache settings did not prove isolation.

## Current screening evidence

[Machine-readable index, checksums and validation](bench/history/latency-v1/index.json).

| Completed suite | Checked processes | Prompts | Tool calls |
|---|---:|---:|---:|
| Same-source build grid, isolated caches | 576 | 1,152 | 2,304 |
| Slim parameter screening | 612 | 612 | 0 |
| Corrected cache-only coding slice | 20 | 60 | 240 |

Pi **0.85.0**, Bun **1.4.3**, Linux, CPU affinity 2. Two build-control warnings prevent a blanket performance claim. The best alternative build's coding first-text ratio was **1.02× [0.96, 1.10]**: inconclusive, so full minification and lazy Jiti remain the defaults. Immediate slim flushing did not consistently outperform microtask coalescing. No universal lowest-latency or live-model speedup is claimed.

The cache slice confirmed actual cold/warm separation: mean RPC readiness **324 ms warm**, **1,040 ms cold**, **1,000 ms caching disabled** (four measured rounds; exploratory). This is cache-state sensitivity, not a newly shipped 3× speedup. The earlier misisolated full sweep and interrupted rerun are excluded from completed evidence.

## Tuning controls

| Scope | Variables | Defaults |
|---|---|---|
| Build/install | `TIA_PI_MINIFY_SYNTAX`, `TIA_PI_MINIFY_WHITESPACE`, `TIA_PI_MINIFY_IDENTIFIERS` | `1`; each accepts `0`/`1` |
| Build/install | `TIA_PI_BYTECODE`, `TIA_DISABLE_LAZY_JITI` | `0`; unsupported bytecode builds fail safely |
| Slim only | `TIA_STREAM_FLUSH` | `microtask`; optional `immediate` |
| Slim only | `TIA_STREAM_DELTA_CHARS`, `TIA_STREAM_OUTPUT_CHARS` | `96`, `16384`; integers 1–1048576 |
| Slim only | `TIA_STREAM_CONTROL_DELAY_MS` | `4`; integer 0–100 |

Thresholds count UTF-16 code units. Text bypasses the control timer. Verification/backpressure handling stays enabled. Resource removal changes functionality; it is not automatically recommended.

## Other benchmarks

```bash
bun run bench:runtime <before-bin> <after-bin> <pi-package> <output.json> 12 5
bun run bench:tools <before-extension.ts> <output.json> 12 200 60
bun run bench:writer
bash bench/feedback-loop.sh
bash bench/hyperfine-tia-loopback.sh
```

Retained historical gains: [full startup: ~47 ms saved](bench/history/runtime-boundaries-v1/README.md); [targeted oversized-tail reads: 70–274×](bench/history/read-bounds-v1/README.md). These are workload-specific and must not be multiplied into agent/model speedups.
