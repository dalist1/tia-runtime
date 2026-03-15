# Fast pi MAX installer

This is the aggressive installer.

It does two things:
1. installs the compiled `pi` launcher as the default `pi`
2. installs a global `fast-tools` extension that overrides `read`, `write`, `edit`, and `bash`

## Install

Recommended from a local clone:

```bash
bash install.sh fast-pi-max install
```

Direct script form:

```bash
bash scripts/install-fast-pi-max.sh install
```

One-liner:

```bash
curl -fsSL https://your.host/install-fast-pi-max.sh | bash -s -- install
```

Local test form:

```bash
curl -fsSL file:///absolute/path/to/install-fast-pi-max.sh | bash -s -- install
```

Status:

```bash
bash scripts/install-fast-pi-max.sh status
```

Uninstall:

```bash
bash scripts/install-fast-pi-max.sh uninstall
```

## What it installs

- compiled default launcher:
  - `pi`
- original launcher backup:
  - `pi-original`
- global extension:
  - `~/.pi/agent/extensions/fast-tools.ts`
- optional native helpers when `gcc` exists:
  - `~/.pi/agent/fast-tools/fastdrain`
  - `~/.pi/agent/fast-tools/fastcopy`

## Benchmark highlights

Launcher / RPC startup:
- compiled default `pi`: about **1.98x** faster than the stock RPC launcher path

Built-in tool runtime, isolated burst benchmarks:
- `read`: about **5.18x** faster
- `write`: about **1.01x** faster
- `edit`: about **2.50x** faster
- `bash`: about **1.59x** faster on file-drain/copy/remove style commands

## Notes

- The fastest gains come from:
  - compiled launcher startup
  - streamed `read`
  - Bun-native `edit`
  - optimized `bash` fast paths for common file commands
- Re-run after updating pi globally.
