# max sandbox research

Private research repo for making `pi` and `opencode` materially faster with sandboxed launchers and tool-path optimizations.

## Quick start

Canonical entrypoint:

```bash
bash install.sh
```

Mode-specific entrypoints:

```bash
bash install.sh max install
bash install.sh fast-pi install
bash install.sh fast-pi-max install
```

Raw one-liner shape:

```bash
curl -fsSL https://raw.githubusercontent.com/dalist1/max-sandbox-research/main/install.sh | bash -s -- max install
```

## Install modes

- `max`
  - installs the sandboxed `max` command
  - supports:
    - `max pi`
    - `max opencode`
- `fast-pi`
  - safer compiled-launcher-only install
- `fast-pi-max`
  - compiled pi + global fast-tools extension

## Main docs

- `scripts/MAX.md`
- `scripts/FAST-PI.md`
- `scripts/FAST-PI-MAX.md`

## Benchmarks

- `bench/hyperfine-pi-tools-fast-burst.sh`
- `bench/hyperfine-pi-rpc-direct.sh`
- `bench/hyperfine-pi-rpc-burst.sh`
- `bench/hyperfine-max-opencode-helpers.sh`

## Notes

Generated payloads, results, compiled binaries, and node_modules are intentionally gitignored.
