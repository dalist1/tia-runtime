# Fast-tool correctness review and measurements

## What was checked?

The shipped read, write, edit/patch and bash extension, its native copy/drain helpers,
and installed FFF find/grep integration. FFF's search engine is an external dependency;
this is not a source audit of that engine.

The initial suite passed 67 tests but missed 15 independently reproduced patch failures.
New coverage includes nested multi-file additions, repeated file sections, numbered
hunks, section anchors, header-shaped content, quoted/timestamped paths, CRLF, trailing
spaces, missing final newlines, and empty files. Eighty seeded Git-generated multi-file
diffs are checked against independently constructed expected bytes.

Additional fixes protect temporary writes, rollback, executable permissions, symlinks,
overlapping exact matches, image reads, shell semantics and same-inode copies. Installer
smoke checks now exercise nested multi-file patches when the installed tool matches the
shipped implementation; preserved custom tools retain their existing compatibility check.

## Validation

- **188 tests passed**, including fault-injected writes and concurrent mutations.
- Format, lint, typecheck, shell syntax and runtime asset checks passed.
- The complete disposable-home integration suite passed with **Pi 1.0.0**, including
  the shipped patch smoke, FFF searches, preserved custom extensions, rollback and host sync.
- The real installer passed **16 SIGKILL failpoints**, with no leaked processes or
  user-state changes; the fault suite used Pi 0.87.1.
- All provider traffic in integration tests was synthetic/local; no real-model test was needed.

## What got faster—and what did not?

[Raw timings and source hashes](benchmark.json.gz), [baseline source](baseline-extension.ts.gz).
Measured 2026-10-03: Linux, Bun 1.4.3-canary.1, Pi 0.85.0 dependencies, CPU 2,
warm filesystem cache, fsync off. Twelve alternating AB/BA pairs; 100 measured calls
and 30 warmups per workload per worker: **37,440 checked results, zero failures**.

| Workload | Baseline median | Candidate median | Paired speedup, 95% CI |
|---|---:|---:|---:|
| Ten-file patch, 100 KB/file | 5.988 ms | 4.806 ms | 1.34× [1.13, 1.78] |
| Numbered patch, 100 KB | 0.648 ms | 0.624 ms | 1.09× [1.03, 1.15] |
| Exact edit, 100 KB | 0.158 ms | 0.217 ms | 0.74× [0.65, 0.83] |

The exact-edit regression buys verified staging before atomic replacement: approximately
0.06 ms additional median latency instead of truncating the live file first. Read/write
results were inconclusive. Paired ratios use round means, not the pooled medians shown
above. These local microbenchmarks do not establish industry-wide or model-turn speed.

## Safety boundaries

- All patch operations are planned before mutation. Repeated sections compose in memory.
  Regular files are verified in a temporary file before atomic replacement. A failed batch
  attempts reverse-order rollback and reports rollback failures rather than hiding them.
- This is **not a crash-atomic transaction across multiple files**, nor a cross-process
  filesystem lock. External changes detected at preflight/rollback are not silently overwritten.
- Symlink writes preserve the link and write through in place, with verification and
  recovery on failure; they do not have regular-file rename atomicity. Replacing a regular
  file changes its inode and does not preserve hard-link relationships or extended attributes.
- Unsupported binary, metadata-only and permission-changing Git patches fail explicitly.
  Use explicit file operations or bash for those cases. Ambiguous hunks still require context.
- Uncertain shell syntax/semantics and explicit timeouts use stock bash. Images use stock
  Pi handling; ordinary text retains the bounded zero-spawn scanner.

Implementation and regressions: [extension](../../../scripts/fast-tools-extension.ts),
[patch tests](../../../scripts/fast-tools-patch.test.ts),
[safety tests](../../../scripts/fast-tools-safety.test.ts).
