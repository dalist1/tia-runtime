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

A legacy `max` alias is also created by default when that path is free or already managed by tia.

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
- reuses your existing auth/settings/models via symlinks
- covers both startup and tool-runtime optimization in one launcher path

## Benchmarks

### `tia pi`
- startup / rpc:
  - about **1.86x** faster than the original `pi` launcher
- isolated tool burst benchmarks:
  - `read`: about **5.18x** faster
  - `write`: about **1.01x** faster
  - `edit`: about **2.50x** faster
  - `bash`: about **1.59x** faster on the tested drain/copy workload

## Notes

- `tia pi` is the supported runtime mode.
- Direct compiled `pi` remains useful as a benchmark reference, not as a separate supported mode.
- Set `INSTALL_LEGACY_MAX_ALIAS=0` if you do not want the compatibility `max` alias.
- Re-run the installer after updating pi.
