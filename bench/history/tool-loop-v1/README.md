# Full tool-loop review (Pi 1.0.0)

## What improved?

This extends the [correctness review](../fast-tools-review-v1/README.md), without
removing verified writes, preflight checks, rollback, extension hooks or session resources.

- Patch planning preserves unchanged line records instead of rebuilding every line.
  Diff comparisons use native string equality rather than per-character JavaScript loops.
- Overlapping file mutations reserve their complete path group once, avoiding nested
  queue acquisition and duplicate path resolution. Disjoint groups remain independent;
  symlink aliases serialize, and failures release reservations.
- Copy/drain operations up to 256 KiB stay in-process; larger files still use available
  native helpers. Uncertain shell syntax and explicit timeouts still use stock bash.
- Collapsed edit results color only the ten displayed diff lines. Expanded output and
  omitted-line counts are unchanged. The renderer benchmark includes component layout,
  not terminal painting.

## Did the entire loop get faster?

**The patch-heavy loop improved repeatably; not every step or workload improved.**
The confirmation ran full RPC with real read/write/edit/bash and FFF find/grep tools,
normal persistence, skills, templates, context discovery and themes enabled. Both targets
used the same compiled Pi executable; only the fast-tools source differed. No slim-mode
substitution, paid requests, provider-selection changes or disabled verification were used.

Measured 2026-10-03, Linux, CPU 2, Bun 1.4.3-canary.1, Pi 1.0.0, FFF
0.10.7-nightly.c3f2c7f, warm filesystem/transform caches, fsync off. Twelve paired rounds
plus two warmup rounds, same-code controls, independent confirmation seed. Each process
retained 16 turns, or 40 for long-session. First turns and warmup processes are excluded
from the table. Each remaining process contributes one warm-turn mean to the paired
10,000-resample bootstrap; turns are not treated as independent replicates.

| Prompt → settled, full loop | Baseline mean | Candidate mean | Paired speedup, 95% CI |
|---|---:|---:|---:|
| basic | 13.62 ms | 13.49 ms | 1.01× [0.99, 1.03] |
| multi-patch | 21.24 ms | 19.84 ms | 1.07× [1.05, 1.09] |
| small-files | 12.24 ms | 11.61 ms | 1.05× [1.00, 1.10] |
| search | 12.97 ms | 13.08 ms | 0.99× [0.97, 1.02] |
| long-session | 15.68 ms | 16.00 ms | 0.98× [0.95, 1.01] |

The ten-file patch loop improved about 7% on confirmation (about 8% in the first pass).
Its tool span fell from 10.36 to 9.49 ms. Small-file tool span fell from 2.68 to 2.11 ms;
its total-loop improvement is smaller and less certain. Basic, search and long-session
results do not establish a speedup. No universal end-to-end or live-model speedup is claimed.

The first pass suggested a long-session slowdown: ratio 0.954 [0.898, 0.999]. Inspection
found that the harness retained its entire multi-gigabyte request journal in memory.
The corrected harness journals exact requests but retains only compact summary data,
and hashes the journal incrementally. The independent rerun still has a slightly slower
long-session point estimate, but its interval crosses parity. This does not prove that
small regressions are impossible. Both passes are retained, rather than hiding the first.
There were 16 individual phase-level same-code control warnings in the
confirmation; these many exploratory intervals are not corrected for multiple comparisons.

## Individual operations

Separate workers, alternating AB/BA order, 12 pairs, 100 measured calls and 30 warmups per
workload: **43,680 checked results, zero failures**. These microbenchmarks used Pi 1.0.0
for both sources. Displayed medians and paired round-mean ratios are different statistics.

| Operation | Baseline median | Candidate median | Paired speedup, 95% CI |
|---|---:|---:|---:|
| patch-100KB-numbered | 0.505 ms | 0.399 ms | 1.28× [1.19, 1.39] |
| patch-10-file-verified | 4.171 ms | 2.868 ms | 1.43× [1.42, 1.43] |
| edit-render-collapsed | 0.682 ms | 0.103 ms | 4.90× [4.72, 5.09] |

The collapsed-render fixture has 10,000 diff lines. Reads, verified writes, exact edits
and expanded rendering did not demonstrate material improvements. All operation results,
including inconclusive workloads, are retained in [tools.json.gz](tools.json.gz).

## Coverage and limits

The harness checks exact streamed and final text, expected requests and tool completions,
write/edit bytes, FFF search results, diagnostics and isolated caches. The confirmation
completed **280 processes, 5,824 prompts and 23,296 tool calls**.

An optional, separately run diagnostic extension records a single child-process clock for
argument-validation/before-hook boundaries, scheduling, execution, result hooks, context
and request construction, response handling and settlement. Concurrent tool durations
can overlap and must not be added together. Instrumented timings are not used as primary
speedup evidence. Provider tokenization/parsing, serialization, arbitrary shell startup
and result delivery remain normal Pi behavior; they were not all optimized individually.

Real provider/network latency, tokenizer throughput, compaction/retries, terminal painting,
FFF ranking quality, cold-disk behavior, other CPUs/filesystems and power loss are not
established by these measurements. The existing [filesystem safety boundaries](../fast-tools-review-v1/README.md#safety-boundaries)
remain unchanged: these are not cross-process locks or crash-atomic multi-file transactions.

## Validation and retained evidence

- **195 tests / 4,108 assertions passed**, including new rendering, threshold, queue,
  workload and tracing regressions, plus existing injected-I/O-failure coverage.
- Format, lint, typecheck, shell syntax and generated asset checks passed.
- All **14 disposable-home installation/integration stages passed with Pi 1.0.0**.
  Installer transaction/store code did not change; the installer fault matrix was not rerun.
- [Unit log](unit.log.gz), [integration log](integration.log.gz),
  [source snapshots, configuration, summaries and checksums](index.json).

Public `*-compact.jsonl.gz` records omit only request body strings; byte lengths and
SHA-256 hashes were checked against every original request before export. Exact original
journals and their lossless archives are retained locally, outside the published evidence.
Their original hashes and sizes are recorded in the index. Compact records are derived
artifacts, not replacements for historical originals.

The index includes confirmation, first-pass and instrumented profiling runs, all source
snapshots needed for the changes, and the pre-correction harness. Benchmark construction
and scope controls are documented in [BENCHMARKS.md](../../../BENCHMARKS.md#full-tool-loop-comparisons).
