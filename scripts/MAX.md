# tia launcher

Installs tia's sandboxed `max` command.

After install you can run:

```bash
max pi
max opencode
```

## Install

Recommended from a local clone:

```bash
bash install.sh max install
```

Direct script form:

```bash
bash scripts/install-max.sh install
```

One-liner form when the scripts are hosted somewhere accessible:

```bash
curl -fsSL https://your.host/install.sh | \
  INSTALL_BASE_URL=https://your.host/scripts bash -s -- max install
```

## Status

```bash
bash scripts/install-max.sh status
max status
```

## Uninstall

```bash
bash scripts/install-max.sh uninstall
```

## What it does

### `max pi`
- uses a sandboxed compiled pi binary
- uses a sandboxed pi agent dir
- loads the fast-tools extension automatically
- reuses your existing auth/settings/models via symlinks

### `max opencode`
- starts opencode with a sandboxed helper `PATH`
- currently accelerates the file-copy style shell path via a fast `cp` wrapper
- uses the direct native opencode binary when it can resolve it

## Benchmarks

### `max pi`
- startup / rpc:
  - about **1.86x** faster than the original `pi` launcher
- isolated tool burst benchmarks:
  - `read`: about **5.18x** faster
  - `write`: about **1.01x** faster
  - `edit`: about **2.50x** faster
  - `bash`: about **1.59x** faster on the tested drain/copy workload

### `max opencode`
- startup:
  - about **1.06x** faster on the tested `--version` path
- tested shell helper path:
  - `cp` repeated workload: about **1.11x** faster

## Notes

- `max pi` is the strong path right now.
- `max opencode` is a beta path and currently gives the clearest gains on shell/file-copy heavy workloads.
- Re-run the installer after updating pi or opencode.
