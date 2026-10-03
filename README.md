# tia-runtime

A faster pi coding-agent runtime: compiled startup, FFF search, and in-process read/write/edit tools with byte-verified writes.

**v0.7.0** · optimization marker `2026-09-atomic-runtime-v1`

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
- Multi-file patches preflight every operation, create missing parents and attempt rollback on failure. See the [tool review, safety boundaries and measurements](bench/history/fast-tools-review-v1/README.md).
- **TIA follows your Pi.** Without a pin, install builds the same Pi version as the host `pi` (Bun global `@earendil-works/pi-coding-agent`). After `pi` updates, the next `tia` launch builds and switches to a matching generation in the background; running sessions are unaffected. `tia sync` does it in the foreground, `tia status` shows `host pi`, and `TIA_AUTO_SYNC=0` disables it.
- Install controls: `TIA_PI_PACKAGE_VERSION=<version>` (pins the version and disables auto-sync; without a host Pi the default is the newest publish date across channels), `TIA_FFF_SOURCE=vanilla|fork`, `TIA_FFF_PACKAGE_VERSION`, `TIA_ENABLE_FFF=0`.
- ESM bytecode is enabled by default (tested with Bun 1.4.3); set `TIA_PI_BYTECODE=0` for older compilers. [Measurements](BENCHMARKS.md#stock-pi-versus-esm-bytecode) and [release status](RELEASE.md).
- Each install builds a sealed, self-contained **generation** (Pi packages, FFF, catalogs, helpers, extension snapshot), validates it through its own launcher and switches one `current` pointer; a failure before that switch leaves the previous runtime selected. Sessions, credentials, settings and FFF databases stay in `pi-agent/` and are never rolled back. [Contract and status](ATOMIC-UPGRADE-PLAN.md).
- `tia rollback` selects the previous activation (including a pre-0.7 launcher); `tia verify`, `tia generations`, `tia recover`; `tia prune` lists removable generations and `tia prune --apply` deletes those no process uses.
- User extensions in `pi-agent/extensions` are snapshotted into each generation; edits take effect at the next install. A `fast-tools.ts` that matches no TIA-shipped version stops the install until you choose `TIA_PRESERVE_FAST_TOOLS=1` (keep) or `=0` (replace); the file itself is never modified.
- `bash install.sh tia uninstall` deactivates the runtime and keeps generations, state and the launcher; `tia rollback` reactivates it.

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
bash test.sh                                   # disposable HOME; never touches the live runtime
bun run test:faults results-faults/<new-dir>   # real installer killed at every transaction phase
```
