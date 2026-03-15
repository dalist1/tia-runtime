# max sandbox

Installs a sandboxed `max` command.

After install you can run:

```bash
max pi
max opencode
```

## Install

```bash
bash scripts/install-max.sh install
```

One-liner form:

```bash
curl -fsSL https://your.host/install-max.sh | bash -s -- install
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
  - about **1.72x** faster than original `pi` launcher
- isolated tool burst benchmarks:
  - `read`: about **4.18x** faster
  - `write`: about **1.09x** faster
  - `edit`: about **2.76x** faster
  - `bash`: about **1.38x** faster on the tested drain/copy workload

### `max opencode`
- startup:
  - roughly on par to slightly faster depending on the machine
- tested shell helper path:
  - `cp` repeated workload: about **1.19x** faster

## Notes

- `max pi` is the strong path right now.
- `max opencode` is a beta path and currently gives the clearest gains on shell/file-copy heavy workloads.
- Re-run the installer after updating pi or opencode.
