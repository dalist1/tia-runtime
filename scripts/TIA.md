# tia launcher

Installs tia's sandboxed launcher command.

After install you can run:

```bash
tia pi
tia opencode
tia status
```

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

### `tia opencode`
- starts opencode with a sandboxed helper `PATH`
- currently accelerates the file-copy style shell path via a fast `cp` wrapper
- uses the direct native opencode binary when it can resolve it

## Benchmarks

### `tia pi`
- startup / rpc:
  - about **1.86x** faster than the original `pi` launcher
- isolated tool burst benchmarks:
  - `read`: about **5.18x** faster
  - `write`: about **1.01x** faster
  - `edit`: about **2.50x** faster
  - `bash`: about **1.59x** faster on the tested drain/copy workload

### `tia opencode`
- startup:
  - about **1.06x** faster on the tested `--version` path
- tested shell helper path:
  - `cp` repeated workload: about **1.11x** faster

## Notes

- `tia pi` is the strong path right now.
- `tia opencode` is a beta path and currently gives the clearest gains on shell/file-copy heavy workloads.
- Set `INSTALL_LEGACY_MAX_ALIAS=0` if you do not want the compatibility `max` alias.
- Re-run the installer after updating pi or opencode.
