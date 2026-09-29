# Release

## v0.7.0

Optimization marker: `2026-09-atomic-runtime-v1`.

- **Atomic runtime generations.** `install` builds a private, sealed generation (synchronized Pi package set, FFF closure from a recorded lockfile, stream catalogs, native helpers, launcher and an extension snapshot), validates the sealed tree through its own launcher, then switches one `current` pointer by atomic rename. Any failure before the switch leaves the previous runtime selected and its files untouched; post-commit verification failures are reported as committed with the previous activation retained. [Contract and status](ATOMIC-UPGRADE-PLAN.md).
- New commands: `tia rollback`, `tia verify`, `tia generations`, `tia recover`, `tia prune [--apply]`. `uninstall` now deactivates (tombstone activation) instead of deleting the runtime root; `tia rollback` reactivates.
- Upgrading a v0.6.0 install retains the old launcher byte-for-byte as a rollback target. Sessions, credentials, settings and FFF databases are shared and never rolled back.
- A `fast-tools.ts` that matches no TIA-shipped version is no longer overwritten by default: install stops until `TIA_PRESERVE_FAST_TOOLS=1` (keep) or `=0` (replace) is chosen. A choice to preserve is remembered for the same file hash.
- **TIA stays in sync with Pi.** Unpinned installs build the host Pi version, and a host Pi update triggers one background transactional sync on the next launch (`tia sync` to run it now, `TIA_AUTO_SYNC=0` to opt out). Full and slim modes now read the same TIA agent configuration.
- Without a host Pi, "latest" resolves by publish date across all registry channels, not the `latest` dist-tag. FFF keeps the currently installed version unless overridden; FFF install failures now stop the install instead of silently disabling FFF.
- Credential links in `pi-agent/` still follow the shell agent directory, but user-owned regular files are no longer replaced or deleted.
- `test.sh` now runs entirely in a disposable HOME.

[Validation evidence](bench/history/atomic-runtime-v1/README.md). The maintainer's live runtime was upgraded on 2026-09-29 (Pi 0.99.1, rollback targets retained). The human review gate is still open (see the plan's implementation status).

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
