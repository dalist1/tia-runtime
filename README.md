# tia-runtime

A faster pi coding-agent runtime: compiled startup, FFF search, and in-process read/write/edit tools with byte-verified writes.

**v0.5.0** · optimization marker `2026-09-runtime-boundaries-v1`

## Run

```bash
bash install.sh tia install
tia pi
tia status
```

Bootstrap:

```bash
curl -fsSL https://raw.githubusercontent.com/dalist1/tia-runtime/main/install.sh | bash -s -- tia install
```

- Normal `tia pi` keeps tools, extensions, sessions and project instructions.
- `tia pi --mode json --no-session "prompt"` is the **model-only slim stream**, not a coding-agent substitute. Set `TIA_DISABLE_FAST_STREAM=1` for full JSON/tool compatibility.
- Writes remain verified; `TIA_FASTWRITE_FSYNC=1` additionally enables durability.
- Install controls: `TIA_PI_PACKAGE_VERSION=<version>`, `TIA_FFF_SOURCE=vanilla|fork`, `TIA_ENABLE_FFF=0`.
- Uninstall: `bash install.sh tia uninstall`.

## Benchmark one parameter

```bash
mkdir -p results-latency
bun run bench:latency --init results-latency/config.json
bun run bench:latency --slice results-latency/config.json results-latency/cache.json transformCache coding
bun run bench:latency --plan results-latency/cache.json
bun run bench:latency --run results-latency/cache.json results-latency/cache-run
```

Per-process progress; **60-second measurement budget** by default. Use fresh output paths. [Benchmark commands and results](BENCHMARKS.md).

## Validate

```bash
bash -n install.sh scripts/install-tia.sh test.sh
bun run format
bun run lint
bun run typecheck
bun test
bash test.sh
```
