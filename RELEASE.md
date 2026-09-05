# Release notes

## v0.5.0

Optimization marker: **`2026-09-runtime-boundaries-v1`**. Validated upstream runtime: **pi 0.84.4**.

- Preserve Jiti's lazy transformer loading through a build-time entrypoint selection; upstream pi files, full CLI, tools, OAuth, and image worker remain unchanged.
- Installed full-RPC startup: **264.74 → 218.47 ms (1.21×)**. Startup plus cached TypeScript tool probes: **282.16 → 235.24 ms (1.20×)**. Cold transformation remains largely unchanged.
- Reduce embedded JavaScript **26.2%** and the installed ELF binary **1.9%**; the transformer remains available in a verified companion, so these are not total-install-size or RAM reductions.
- Snapshot Jiti by content hash, verify reused snapshots, smoke-test staged binaries before atomic replacement, and retain old companions for running processes.
- Add `TIA_DISABLE_LAZY_JITI=1` as an installation-time stock-build escape hatch and expose the selected mode through `tia status`.
- Validate **98 tests**, **12 pinned integration stages**, **1,512 process runs**, and **3,024 registered tool calls**, including same-code controls, uncached transformation, and failure injection.

Details, confidence intervals, rejected candidates, and the next optimization boundaries: [runtime report](bench/history/runtime-boundaries-v1/README.md). This does not accelerate model token generation, make the whole installer transactional, or fix the upstream pi 0.85.0 missing-server dependency. Upgrade with `TIA_PI_PACKAGE_VERSION=0.84.4 bash install.sh tia install`.

## v0.4.0

Optimization marker: **`2026-09-read-bounds-v1`**. Validated upstream runtime: **pi 0.84.4**.

### Highlights
- stop reading and copying discarded giant lines after read truncation is known
- bound newline searches to actual input bytes and oversized-line carry storage to the output budget
- retain exact size diagnostics, UTF-8/CRLF correctness, unlimited skill reads, and existing write/edit verification
- confirm paired mean speedups of **274.43×** (95% CI 247.62–306.17×) for line-limited reads with a discarded 16 MiB tail, **70.19×** (61.42–80.75×) for byte-limited reads with that tail, and **2.74×** (2.65–2.81×) for oversized first lines; these are not universal tool speedups
- archive **187,200 checked operations**, raw timings, paired confidence intervals, and same-code controls
- add randomized, fault, resource-bound, and benchmark-harness tests, including rejection of mixed dependency trees
- align release metadata and installer/bootstrap optimization markers

Release validation: **89 unit tests passed**, all **12 pinned install/runtime stages passed**, and formatting, lint, TypeScript, shell syntax, and frozen-lockfile installation checks passed. `tia status` reports the new optimization marker. The benchmarked extension's hash is unchanged by the release metadata bump.

The benchmark used 12 alternating pairs per workload, 200 measured operations and 60 warmups per implementation per pair, and identical resolved dependencies. Ordinary reads, verified writes, and edits had no confirmed material change; startup and FFF search were not remeasured. Original timings and release checks remain in [summary.json](bench/history/read-bounds-v1/summary.json) and [release-validation.json](bench/history/read-bounds-v1/release-validation.json).

### Upgrade and compatibility

```bash
TIA_PI_PACKAGE_VERSION=0.84.4 bash install.sh tia install
tia status
```

The installer keeps its existing upstream `latest` default. At validation, pi **0.85.0** failed to bundle undeclared `@earendil-works/pi-server` imports. The explicit 0.84.4 upgrade passed all 12 runtime integration stages; unpinned latest-version installation is **not** claimed fixed. See [the v0.4.0 README](https://github.com/dalist1/tia-runtime/blob/v0.4.0/README.md#v040-validated-upgrade) for a tag-pinned bootstrap command and [the benchmark report](bench/history/read-bounds-v1/README.md) for complete measurements and limitations.

## v0.3.0

Low-level v4 runtime and benchmark cleanup.

### Highlights
- install the latest pi runtime on every tia installation
- load provider-specific model catalogs on the slim stream path and validate stock pi provider defaults during installation
- speed up bounded edit diffs, stream framing, native read/edit/write, and bash copy/drain helpers
- add a reproducible local Anthropic HTTP/SSE benchmark covering the complete slim streaming path
- prevent stale multi-file edit plans from overwriting concurrent or external file changes, and add native I/O/rollback fault injection coverage
- archive a five-round full-tier feedback run with 100% successful measurements
- make benchmark and RPC harnesses portable across machines
- enforce formatting, linting, and TypeScript checks across every TypeScript source

## v0.2.0

Tia runtime release.

### Highlights
- `install.sh` now supports only the `tia` top-level target
- `tia pi` is the only supported coding-agent runtime command
- deprecated top-level modes `max`, `fast-pi`, and `fast-pi-max` are now rejected
- docs and release assets were simplified around the tia runtime
- `tia pi` remains the path that combines startup and tool optimization without patching upstream pi

### Recommended install

Local clone:

```bash
bash install.sh tia install
```

Global user install from GitHub:

```bash
curl -fsSL https://raw.githubusercontent.com/dalist1/tia-runtime/main/install.sh | bash -s -- tia install
```

### Notes
- supported coding-agent runtime command: `tia pi`
- benchmark-only reference path: compiled direct `pi`

## v0.1.6

Canonical tia benchmark-script release.

## v0.1.5

Leftover tia cleanup release.

## v0.1.4

Full tia rename release.
