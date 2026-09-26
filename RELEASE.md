# Release

## v0.6.0

Optimization marker: `2026-09-esm-bytecode-v1`.

- Full Pi now uses **ESM bytecode by default**, retaining `import.meta`, dynamic imports and top-level await. `TIA_PI_BYTECODE=0` opts out for compilers without ESM-bytecode support. Tested with Bun 1.4.3 on Linux; other platforms remain unverified.
- Compile/smoke checks and verified companion snapshots still precede binary replacement. Failed builds are not silently retried as a different candidate.
- The installer resolves pi-ai from the selected coding-agent package instead of assuming a sibling directory, validates matching versions before compilation, and records the selected path. This fixes the nested-dependency mismatch found during benchmarking; whole-install transactions remain [outstanding](TODO.md).
- `tia status` now shows the runtime release and whether ESM bytecode is enabled.
- Unrelated user extensions survive reinstall. `TIA_PRESERVE_FAST_TOOLS=1` also retains an existing, regular locally customized `fast-tools.ts`; the default still updates the managed tool implementation.
- `bench:latency --stock` compares the published Node CLI with same-input source/bytecode builds, retaining source fingerprints, isolated cache checks and full coding-tool continuations.

[Benchmarked stock comparison](bench/history/stock-bytecode-v1/README.md): 492 validated processes and 4,464 tool calls; mean readiness 234 → 139 ms and the scripted three-turn workload 597 → 471 ms. These are local-loopback results, not live model-token throughput; warm turns do not consistently improve. The historical report's opt-in and installer-blocker notes describe its pre-release snapshot, not the current defaults/fix.

[Release validation](bench/history/stock-bytecode-v1/release-validation.json): 126 tests passed; shell syntax, formatting, lint and typecheck passed; all 12 integration stages passed with the new default on the previously failing nested layout and again with bytecode disabled. User-extension preservation is covered by bootstrap/guard tests.

Tool usage: [README.md](README.md). Measurements: [BENCHMARKS.md](BENCHMARKS.md).
Previous release details remain in Git tags and retained benchmark evidence.
