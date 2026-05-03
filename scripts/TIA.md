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

Hosted direct-script one-liner:

```bash
curl -fsSL https://your.host/scripts/install-tia.sh | bash -s -- install
```

Top-level bootstrap one-liner:

```bash
curl -fsSL https://your.host/install.sh | \
  INSTALL_BASE_URL=https://your.host/scripts bash -s -- tia install
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
- ensures `@mariozechner/pi-coding-agent` is installed at the pinned latest version, then uses a sandboxed compiled pi binary
- uses a sandboxed pi agent dir
- loads the fast-tools extension automatically
- installs low-level helper binaries for hot paths when building from a local checkout (`fastread-window`, `fastwrite`, `fastedit`, `fastdrain`, `fastcopy`)
- installs the official FFF pi extension (`@ff-labs/pi-fff`) from the upstream `nightly` dist-tag when available, defaulting to `PI_FFF_MODE=override` for FFF-backed `find`, `grep`, `multi_grep`, and `@` file autocomplete
- reuses your current shell agent auth/settings/models via symlinks refreshed at launch time
- avoids self-linking the tia sandbox if `PI_CODING_AGENT_DIR` already points there, preserving shell pi / cliproxy linkage
- preserves the current shell environment for provider/model login env vars
- supports an opt-in slim stream runtime for `--mode json --no-session`
- keeps FFF frecency/history state in the tia sandbox under `~/.local/share/tia/pi-agent/fff`
- covers both startup and tool-runtime optimization in one launcher path

## Benchmarks

### `tia pi`
- startup / rpc:
  - about **1.86x** faster than the original `pi` launcher
- isolated tool burst benchmarks:
  - `read`: about **5.18x** faster
  - `read` streaming burst: about **5.49x** faster
  - `write`: about **1.01x** faster
  - `edit`: about **2.50x** faster
  - `bash`: about **1.59x** faster on the tested drain/copy workload

## Notes

- `tia pi` remains the benchmarked performance path today.
- Direct compiled `pi` remains useful as a benchmark reference, not as a separate supported mode.
- The slim stream path is enabled by default for `--mode json --no-session`.
- It calls pi's provider streaming layer directly and intentionally skips full CLI/session/resource/tool loading for speed; unsupported flags and sessionful JSON runs fall back to normal compiled `tia pi`.
- Do not force tool-using coding subagents through slim mode; use full JSON pi for subagents that need tools or stock pi JSON events.
- Set `TIA_DISABLE_FAST_STREAM=1` if you need to opt out.
- Set `TIA_PI_PACKAGE_VERSION=<version|latest>` to override the pinned pi package version, `PI_PACKAGE_DIR=<path>` to use a local checkout, or `TIA_SKIP_PI_PACKAGE_INSTALL=1` to skip the global package update.
- Set `TIA_ENABLE_FFF=0` during install to skip FFF, `TIA_REQUIRE_FFF=1` to make FFF install failures fatal, `TIA_FFF_PACKAGE_VERSION=<version|latest|nightly>` to override the FFF package dist-tag/version, or `PI_FFF_MODE=tools-and-ui|tools-only|override` at runtime to change FFF behavior.
- `tia-runtime` does not add startup-time session/history cleanup logic.
- Re-run the installer after updating pi.
