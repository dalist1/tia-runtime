# tia-runtime launcher

Installs tia-runtime's sandboxed `tia` launcher command.

Supported tia runtime subcommands from this project are:

```bash
tia pi
```

Release **v0.4.0**, optimization marker **`2026-09-read-bounds-v1`**, combines compiled startup, sandboxed runtime wiring, and fast tool overrides. Validated upstream runtime: **pi 0.84.4**.

## Install

Recommended from a local clone:

```bash
TIA_PI_PACKAGE_VERSION=0.84.4 bash install.sh tia install
```

Direct script form:

```bash
TIA_PI_PACKAGE_VERSION=0.84.4 bash scripts/install-tia.sh install
```

Global user install from GitHub:

```bash
curl -fsSL https://raw.githubusercontent.com/dalist1/tia-runtime/main/install.sh | TIA_PI_PACKAGE_VERSION=0.84.4 bash -s -- tia install
```

Direct installer script:

```bash
curl -fsSL https://raw.githubusercontent.com/dalist1/tia-runtime/main/scripts/install-tia.sh | TIA_PI_PACKAGE_VERSION=0.84.4 bash -s -- install
```

The installer still defaults to upstream `latest` when no override is supplied. At release validation, pi 0.85.0 failed to bundle missing `@earendil-works/pi-server` imports; the commands above use the tested version rather than claiming that upstream failure is fixed.

## Status

```bash
bash scripts/install-tia.sh status
tia status
```

## Uninstall

```bash
bash scripts/install-tia.sh uninstall
```

## What it does

### `tia pi`
- uses a sandboxed compiled pi binary built from the synchronized `@earendil-works/pi-*` package set selected during installation
- uses a sandboxed pi agent dir
- loads the fast-tools extension automatically
- runs `read`/`write`/`edit` tool fast paths fully in-process (zero-spawn, byte-verified); installs low-level helper binaries for the `bash` fast path when building from a local checkout (`fastdrain`/`fastcopy` via `zig cc`)
- installs the official FFF pi extension (`@ff-labs/pi-fff`) from the upstream `nightly` dist-tag when available, defaulting to `PI_FFF_MODE=override` for FFF-backed `find`, `grep`, `multi_grep`, and `@` file autocomplete
- reuses your current shell agent auth/settings/models via symlinks refreshed at launch time
- avoids self-linking the tia sandbox if `PI_CODING_AGENT_DIR` already points there, preserving shell pi / cliproxy linkage
- preserves the current shell environment for provider/model login env vars
- uses a low-level slim stream runtime by default for `--mode json --no-session`, with provider code loaded on demand and stock pi provider defaults validated against the installed pi-ai catalog
- keeps FFF frecency/history state in the tia sandbox under `~/.local/share/tia/pi-agent/fff`
- covers both startup and tool-runtime optimization in one launcher path

## Benchmarks

### Current read-bounds results — v0.4.0

| Read workload | Paired mean speedup | 95% CI |
|---|---:|---:|
| One requested line followed by a discarded 16 MiB line | **274.43×** | 247.62–306.17× |
| 48 KiB accepted before a discarded 16 MiB line | **70.19×** | 61.42–80.75× |
| Oversized 16 MiB first line, retaining exact size diagnostics | **2.74×** | 2.65–2.81× |

**187,200 checked benchmark operations**, **89 passing release tests**, and **12 passing pinned integration stages**. Measurements used pi 0.84.4, Bun 1.4.1-canary.1, warm ext4 page cache, CPU affinity 2 on an i7-1360P, and 12 alternating pairs with identical resolved dependencies. Speedups are geometric means of paired round-mean ratios.

These are targeted read gains, not universal tool or end-to-end agent speedups. Ordinary reads, writes, and edits had no confirmed material change. [Detailed report, raw timings, and reproduction](../bench/history/read-bounds-v1/README.md).

### Historical startup/helper results — July 2026

The following measurements predate v0.4.0 and were not remeasured for this release:

- `--version` startup: **1.33x** faster than stock pi
- RPC startup: **1.24x** faster than stock pi
- slim JSON startup: **10.87x** faster than full tia JSON startup
- local Anthropic HTTP/SSE end-to-end stream: **11.07x** faster than full tia
- bounded verified edit path: **1.40x** faster than the previous formatter
- slim stream framing: **1.15x** faster
- native bash drain/copy chain: **3.19x** faster

## Notes

- `tia pi` remains the benchmarked performance path today.
- Direct compiled `pi` remains useful as a benchmark reference, not as a separate supported mode.
- The slim stream path is enabled by default for `--mode json --no-session`.
- It calls pi's provider streaming layer directly and intentionally skips full CLI/session/resource/tool loading for speed; unsupported flags and sessionful JSON runs fall back to normal compiled `tia pi`.
- Do not force tool-using coding subagents through slim mode; use full JSON pi for subagents that need tools or stock pi JSON events.
- Set `TIA_DISABLE_FAST_STREAM=1` if you need to opt out.
- Set `TIA_PI_PACKAGE_VERSION=<version|latest>` to select another pi package version, `PI_PACKAGE_DIR=<path>` to use a local checkout, or `TIA_SKIP_PI_PACKAGE_INSTALL=1` to skip the global package update.
- Set `TIA_ENABLE_FFF=0` during install to skip FFF, `TIA_REQUIRE_FFF=1` to make FFF install failures fatal, `TIA_FFF_PACKAGE_VERSION=<version|latest|nightly>` to override the FFF package dist-tag/version, `TIA_FFF_SOURCE=vanilla|fork` to switch between the upstream `@ff-labs/pi-fff` npm package and the forked `@edxeth/pi-fff` / `@edxeth/fff-node` npm packages (default: `vanilla`), or `PI_FFF_MODE=tools-and-ui|tools-only|override` at runtime to change FFF behavior.
- `tia-runtime` does not add startup-time session/history cleanup logic.
- Re-run the installer after updating pi.
