# tia launcher

Installs tia's sandboxed launcher command.

The single supported runtime mode from this project is:

```bash
tia pi
```

That path combines:
- compiled startup improvements
- sandboxed runtime wiring
- fast tool overrides

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
- uses a sandboxed compiled pi binary
- uses a sandboxed pi agent dir
- loads the fast-tools extension automatically
- reuses your current shell agent auth/settings/models via symlinks refreshed at launch time
- preserves the current shell environment for provider/model login env vars
- supports an opt-in slim stream runtime for `--mode json --no-session`
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

- `tia pi` is the supported runtime mode.
- Direct compiled `pi` remains useful as a benchmark reference, not as a separate supported mode.
- The slim stream path is enabled by default for `--mode json --no-session`.
- Set `TIA_DISABLE_FAST_STREAM=1` if you need to opt out.
- `tia` does not add startup-time session/history cleanup logic.
- Re-run the installer after updating pi.
