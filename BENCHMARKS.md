# Benchmarks

These are the latest benchmark highlights from this repo's current research harness.

## Summary table

| Path | Workload | Baseline | Optimized | Speedup |
|---|---|---:|---:|---:|
| `max pi` | RPC startup (`get_state`) | 1.786 s | 0.961 s | **1.86x** |
| `pi` compiled direct | RPC startup (`get_state`) | 1.476 s | 0.745 s | **1.98x** |
| `max pi` fast tools | `read` burst | 977.7 ms | 188.6 ms | **5.18x** |
| `max pi` fast tools | `write` burst | 195.5 ms | 193.0 ms | **1.01x** |
| `max pi` fast tools | `edit` burst | 378.3 ms | 151.0 ms | **2.50x** |
| `max pi` fast tools | `bash` burst | 513.7 ms | 322.5 ms | **1.59x** |
| `max opencode` startup | `--version` | 1.365 s | 1.293 s | **1.06x** |
| `max opencode` helpers | repeated `cp` shell workload | 248.6 ms | 222.9 ms | **1.11x** |

## Source result files

### pi startup / rpc
- `results-max-pi/rpc.md`
- `results-pi-rpc-direct-smoke/empty.md`

### pi fast tools burst
- `results-pi-tools-fast-burst-smoke/read.md`
- `results-pi-tools-fast-burst-smoke/write.md`
- `results-pi-tools-fast-burst-smoke/edit.md`
- `results-pi-tools-fast-burst-smoke/bash.md`

### opencode helper path
- `results-max-opencode-startup/startup.md`
- `results-max-opencode-helpers/cp.md`
- `results-max-opencode-helpers/cat.md`
- `results-max-opencode-helpers/combo.md`

## How to reproduce

### max pi startup
```bash
hyperfine --runs 4 --warmup 1 \
  --command-name 'pi original rpc' \
  'pi-node --mode rpc --no-session --no-extensions --no-skills --no-prompt-templates --no-themes < ./payloads-rpc/empty.get-state.jsonl' \
  --command-name 'max pi rpc' \
  'max pi --mode rpc --no-session --no-skills --no-prompt-templates --no-themes < ./payloads-rpc/empty.get-state.jsonl'
```

### pi fast tools burst
```bash
bash bench/hyperfine-pi-tools-fast-burst.sh
```

### opencode helper path
```bash
bash bench/hyperfine-max-opencode-helpers.sh
```

## Interpretation

- `max pi` is the strongest path today.
- The largest gains come from:
  - compiled pi startup
  - streaming `read`
  - fast exact-text `edit`
- `max opencode` currently gives the clearest win on repeated `cp`-style shell workloads.
- `write` improves, but less dramatically than `read` and `edit`.
