# tia-runtime launcher

Installs tia-runtime's sandboxed `tia` launcher command.

Supported tia runtime subcommands from this project are:

```bash
tia pi
```

Today:
- `tia pi` combines compiled startup improvements, sandboxed runtime wiring, and fast tool overrides

## Install

Recommended from a local clone:

```bash
bash install.sh tia install
```

Direct script form:

```bash
bash scripts/install-tia.sh install
```

Global user install from GitHub:

```bash
curl -fsSL https://raw.githubusercontent.com/dalist1/tia-runtime/main/install.sh | bash -s -- tia install
```

Direct installer script:

```bash
curl -fsSL https://raw.githubusercontent.com/dalist1/tia-runtime/main/scripts/install-tia.sh | bash -s -- install
```

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
- ensures `@earendil-works/pi-coding-agent` is installed at the pinned version, then uses a sandboxed compiled pi binary
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

### `tia pi`
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
- Set `TIA_PI_PACKAGE_VERSION=<version|latest>` to override the pinned pi package version, `PI_PACKAGE_DIR=<path>` to use a local checkout, or `TIA_SKIP_PI_PACKAGE_INSTALL=1` to skip the global package update.
- Set `TIA_ENABLE_FFF=0` during install to skip FFF, `TIA_REQUIRE_FFF=1` to make FFF install failures fatal, `TIA_FFF_PACKAGE_VERSION=<version|latest|nightly>` to override the FFF package dist-tag/version, `TIA_FFF_SOURCE=vanilla|fork` to switch between the upstream `@ff-labs/pi-fff` npm package and the forked `@edxeth/pi-fff` / `@edxeth/fff-node` npm packages (default: `vanilla`), or `PI_FFF_MODE=tools-and-ui|tools-only|override` at runtime to change FFF behavior.
- `tia-runtime` does not add startup-time session/history cleanup logic.
- Re-run the installer after updating pi.
