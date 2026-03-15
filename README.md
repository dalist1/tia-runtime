# max sandbox research

Private research repo for making `pi` and `opencode` materially faster with sandboxed launchers and tool-path optimizations.

## Main user-facing installers

- `scripts/install-max.sh`
  - installs a sandboxed `max` command
  - supports:
    - `max pi`
    - `max opencode`
- `scripts/install-fast-pi.sh`
  - safer compiled-launcher-only install
- `scripts/install-fast-pi-max.sh`
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
