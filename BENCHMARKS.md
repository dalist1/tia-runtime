# tia benchmarks

These are the latest benchmark highlights from the tia research harness.

## Summary table

| Path | Workload | Baseline | Optimized | Speedup |
|---|---|---:|---:|---:|
| `tia pi` | RPC startup (`get_state`) | 1.786 s | 0.961 s | **1.86x** |
| `pi` compiled direct | RPC startup (`get_state`) | 1.476 s | 0.745 s | **1.98x** |
| `tia pi` fast tools | `read` burst | 977.7 ms | 188.6 ms | **5.18x** |
| `tia pi` fast tools | `read` streaming burst | 1.372 s | 249.9 ms | **5.49x** |
| `tia pi` fast tools | `write` burst | 195.5 ms | 193.0 ms | **1.01x** |
| `tia pi` fast tools | `edit` burst | 378.3 ms | 151.0 ms | **2.50x** |
| `tia pi` fast tools | `bash` burst | 513.7 ms | 322.5 ms | **1.59x** |

## Supported runtime subcommands

Supported user-facing tia runtime subcommands from this project are:
- `tia pi`
- `tia opencode`

`pi` compiled direct remains a benchmark reference, not a separate supported install mode.
Current benchmark results below focus on `tia pi`.

## Source result files

### tia startup / rpc
- `results-tia-pi/rpc.md`
- `results-pi-rpc-direct-smoke/empty.md`

### tia fast tools burst
- `results-pi-tools-fast-burst-smoke/read.md`
- `results-pi-tools-fast-burst-smoke/write.md`
- `results-pi-tools-fast-burst-smoke/edit.md`
- `results-pi-tools-fast-burst-smoke/bash.md`

### tia fast tools streaming
- `results-pi-tools-fast-stream-smoke/read.md`

### tia fast tools persistent
- `results-pi-tools-persistent-smoke/read.md`
- `results-pi-tools-persistent-smoke/edit.md`
- `results-pi-tools-persistent-smoke/bash.md`

## How to reproduce

### tia pi startup
```bash
hyperfine --runs 4 --warmup 1 \
  --command-name 'pi original rpc' \
  'pi-node --mode rpc --no-session --no-extensions --no-skills --no-prompt-templates --no-themes < ./payloads-rpc/empty.get-state.jsonl' \
  --command-name 'tia pi rpc' \
  'tia pi --mode rpc --no-session --no-skills --no-prompt-templates --no-themes < ./payloads-rpc/empty.get-state.jsonl'
```

### tia fast tools burst
```bash
bash bench/hyperfine-pi-tools-fast-burst.sh
```

This now compares:
- `stock (bun)`
- `fast (bun + native helpers)`
- `fast (compiled + native helpers)`

### tia fast tools streaming
```bash
bash bench/hyperfine-pi-tools-fast-stream.sh
```

This now compares:
- `stock (bun)`
- `fast (bun + native helpers)`
- `fast (compiled + native helpers)`

### tia fast tools persistent warm runner
```bash
bash bench/hyperfine-pi-tools-persistent.sh
```

This compares:
- `fast (compiled cold spawn-per-request)`
- `fast (compiled warm daemon + native helpers)`

## Interpretation

- `tia pi` is the strongest path today.
- It combines:
  - compiled startup
  - sandboxed runtime wiring
  - fast `read`
  - streamed fast `read` updates
  - fast exact-text `edit`
  - faster `bash` handling on the tested workloads
- `write` improves, but less dramatically than `read` and `edit`.
- In the direct streaming runner, fast `read` delivered about 7 partial updates per iteration with about 1.29 ms average time-to-first-update across 60 iterations.
