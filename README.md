# max sandbox research

Private research repo for making `pi` and `opencode` materially faster with sandboxed launchers and tool-path optimizations.

## Quick start

Canonical local entrypoint:

```bash
bash install.sh
```

Mode-specific local entrypoints:

```bash
bash install.sh max install
bash install.sh fast-pi install
bash install.sh fast-pi-max install
```

If you want to run `install.sh` via curl, either serve this repo from a host that exposes the `scripts/` directory or set `INSTALL_BASE_URL` to an alternate script host.

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

## What matters most

| Path | Workload | Speedup |
|---|---|---:|
| `max pi` | RPC startup (`get_state`) | **1.86x** |
| `pi` compiled direct | RPC startup (`get_state`) | **1.98x** |
| `max pi` fast tools | `read` burst | **5.18x** |
| `max pi` fast tools | `edit` burst | **2.50x** |
| `max pi` fast tools | `bash` burst | **1.59x** |
| `max opencode` startup | `--version` | **1.06x** |
| `max opencode` helpers | repeated `cp` shell workload | **1.11x** |

See also:
- `BENCHMARKS.md`
- `scripts/MAX.md`
- `scripts/FAST-PI.md`
- `scripts/FAST-PI-MAX.md`

## Testing

Run the smoke/integration checks with:

```bash
bash test.sh
```

## Benchmarks

Main benchmark entrypoints:

- `bench/hyperfine-max-pi.sh`
- `bench/hyperfine-pi-tools-fast-burst.sh`
- `bench/hyperfine-pi-rpc-direct.sh`
- `bench/hyperfine-pi-rpc-burst.sh`
- `bench/hyperfine-max-opencode-helpers.sh`
- `bench/hyperfine-max-opencode-startup.sh`

## Notes

Generated payloads, results, compiled binaries, and node_modules are intentionally gitignored.
