# tia-runtime — Terminal Interactive Agents runtime

**tia-runtime** is an open runtime that makes the pi coding agent faster without patching its upstream codebase.

Goal:
- make the pi coding agent faster without patching its upstream codebase
- keep the fast path simple and sandboxed
- expose the user-facing `tia pi` runtime from this project

Reference baselines still exist for comparison:
- stock/native `pi`
- compiled direct `pi` benchmark path

## Supported coding agent

The pi coding agent is the only coding agent currently supported by tia-runtime.

Install the `tia` launcher with:

```bash
bash install.sh tia install
```

Then use:

```bash
tia pi
tia status
```

## Install, status, uninstall

```bash
bash install.sh tia install
bash install.sh tia status
bash install.sh tia uninstall
```

## Curl / bootstrap usage

Install globally for your user directly from GitHub:

```bash
curl -fsSL https://raw.githubusercontent.com/dalist1/tia-runtime/main/install.sh | bash -s -- tia install
```

This installs `tia` to `~/.local/bin`. If that directory is not on `PATH`, the installer prints the exact path you can run immediately. The top-level installer bootstraps its sibling scripts automatically; set `INSTALL_BASE_URL` only when serving the repository from another host.

This path is smoke-tested from outside the repo checkout.

### v0.4.0 validated upgrade

Release **v0.4.0** uses optimization marker **`2026-09-read-bounds-v1`** and is validated with pi **0.84.4**:

```bash
TIA_PI_PACKAGE_VERSION=0.84.4 bash install.sh tia install
tia status
```

For bootstrap installation, put the version override on the shell side of the pipeline:

```bash
curl -fsSL https://raw.githubusercontent.com/dalist1/tia-runtime/v0.4.0/install.sh | \
  TIA_PI_PACKAGE_VERSION=0.84.4 \
  INSTALL_BASE_URL=https://raw.githubusercontent.com/dalist1/tia-runtime/v0.4.0/scripts \
  bash -s -- tia install
```

The installer still defaults to upstream `latest`. At release validation, pi **0.85.0** failed to bundle missing `@earendil-works/pi-server` imports; use the explicit tested version above until upstream compatibility is resolved. This release does not claim to fix that upstream failure.

## Latest measured tool gains — v0.4.0

Installed extension, pi **0.84.4**, Bun **1.4.1-canary.1**, Linux i7-1360P, warm ext4 page cache, CPU affinity 2:

| Read workload | Before p50 (ms) | After p50 (ms) | Paired mean speedup | 95% CI |
|---|---:|---:|---:|---:|
| One requested line followed by a discarded 16 MiB line | 2.1320 | 0.0058 | **274.43×** | 247.62–306.17× |
| 48 KiB accepted before a discarded 16 MiB line | 2.0934 | 0.0197 | **70.19×** | 61.42–80.75× |
| Oversized 16 MiB first line, retaining exact size diagnostics | 2.0663 | 0.8372 | **2.74×** | 2.65–2.81× |

Speedup is the geometric mean of paired round-mean ratios, **not** the quotient of the displayed medians. Each workload used 12 alternating pairs, with 200 measured operations and 60 warmups per implementation per pair.

**187,200 checked benchmark operations**, **89 passing release tests**, and **12 passing pinned integration stages**. Same-code controls and identical dependency resolution guard against misleading comparisons. Ordinary reads, verified writes, and edits had no confirmed material change; tiny-read mean gains were inconclusive. These are targeted read gains, **not a 10× improvement across all tools or end-to-end agent latency**.

All workloads, p95 timings, raw samples, and reproduction commands: [read-bounds report](bench/history/read-bounds-v1/README.md). Machine-readable results: [summary](bench/history/read-bounds-v1/summary.json) and [release validation](bench/history/read-bounds-v1/release-validation.json).

## What tia-runtime installs

- installs the `tia` launcher at `~/.local/bin/tia`
- creates the tia runtime sandbox under `~/.local/share/tia`
- runs `tia pi` with:
  - compiled pi startup path
  - sandboxed pi agent dir
  - fast-tools extension enabled
  - in-process zero-spawn `read`/`write`/`edit` tool fast paths (no helper binaries on these paths anymore)
  - low-level helper binaries installed under `~/.local/share/tia/pi-agent/fast-tools` for the `bash` fast path when building from a local checkout (`fastdrain`, `fastcopy`)
  - FFF (`@ff-labs/pi-fff`) installed as a sandboxed pi extension when available, giving FFF-backed `find`/`grep`/`multi_grep` and `@` file autocomplete (default `PI_FFF_MODE=override`)
  - current shell environment preserved for provider/model login env vars
  - auth/models/settings symlinks refreshed from the shell pi agent without self-linking the tia sandbox, preserving cliproxy model/provider linkage
- combines runtime sandboxing with the pi fast path in one launcher

## Historical startup comparison — July 2026

Both runtimes execute the **same pi source** (`@earendil-works/pi-coding-agent`), so this isolates what `tia-runtime` adds: AOT-compiled + minified startup, a low-level slim stream runner with on-demand provider modules, and the sandbox wiring. Stock `pi` is run straight from `dist/cli.js`; `tia pi` is the installed launcher.

Historical startup benchmark marker: **`2026-07-low-level-v4`**. Toolchain: pi `0.81.1`, bun `1.4.0`, Zig `0.17.0-dev.1441+d5181a9c9`, Linux x86_64 (16 logical cores). The complete machine-readable record is `bench/history/2026-07-low-level-v4.json`. These startup timings were not remeasured for v0.4.0.

| Workload | Baseline | `tia pi` optimized | Speedup |
|---|---:|---:|---:|
| Process startup (`--version`) | stock: 304.8 ± 25.3 ms | 229.1 ± 4.5 ms | **1.33x** |
| RPC startup (`get_state`) | stock: 324.1 ± 9.6 ms | 261.8 ± 4.4 ms | **1.24x** |
| JSON stream startup (`--mode json --no-session`, no prompt) | full tia: 262.8 ± 13.0 ms | 24.2 ± 3.2 ms | **10.87x** |
| Anthropic end-to-end loopback stream | full tia: 360.6 ± 6.7 ms | 32.6 ± 2.7 ms | **11.07x** |

The slim stream path is where `tia pi` pulls furthest ahead: it bypasses the full CLI/AgentSession/tools/extensions and loads only the selected provider implementation and provider model catalog. Provider defaults are generated from the installed pi package and validated against its pi-ai catalog during installation, preventing the slim path from drifting from stock pi model selection. In paired direct-runner measurements, provider-selective startup improved from 20.07 ms to 17.87 ms (**1.12x**); unqualified model lookup improved from 20.49 ms to 19.76 ms (**1.04x**) through a compact text index. Text deltas remain microtask-coalesced instead of waiting for the 4 ms batching timer.

Reproduce startup/stream:

```bash
bash bench/hyperfine-tia-json-stream.sh   # slim vs full JSON stream startup
bash bench/hyperfine-tia-loopback.sh      # slim vs full local HTTP/SSE stream
bash bench/hyperfine-tia-pi.sh            # tia pi vs stock pi RPC startup
```

## Historical internal fast-path highlights — July 2026

These earlier measurements compare retained fast paths against tia's own slower references (not stock `pi`). They were not remeasured for v0.4.0 and must not be combined with its speedups:

| Path | Workload | Result |
|---|---|---:|
| in-process extension | 100KB verified edit + rendered diff | **1.40x** mean / **1.45x** median |
| slim stream writer | 2M interleaved deltas | **1.15x** |
| native helper | 50KB read window | **1.13x** |
| native helper | exact edit | **1.79x** |
| native helper | verified write | **1.03x** |
| native helpers | `bash` drain/copy chain | **3.19x** |

The tool burst rows above come from the standalone burst harness. `bench/fast-tools-extension-burst.ts` additionally measures the real installed `fast-tools` extension code path (mutation queues, verification, and result assembly included).

### 2026-07 in-process read/write/edit pass (real extension code path)

Same machine, same harness (`bun bench/fast-tools-extension-burst.ts <tool> 40`, medians across runs), before vs after replacing per-call native helper spawns with in-process byte-level I/O:

| Tool | Workload | Before | After | Speedup |
|---|---|---:|---:|---:|
| `read` | 5MB file, 50KB window burst | 2.56 ms/op | 0.17 ms/op | **14.7x** |
| `write` | 1MB verified atomic write burst | 24.7 ms/op | 2.37 ms/op | **10.4x** |
| `edit` | 100KB file, verified single replacement burst | 20.6 ms/op | 1.84 ms/op | **11.2x** |

Notes:
- `compiled direct pi` is a benchmark reference, not a separate supported install mode.
- active feedback-loop candidates now focus on retained fast paths only.
- the two slowest retired tool approaches are the stock Bun tool baseline and the Bun source-runner fast path.
- `tia-runtime` does not add startup-time session/history cleanup logic.

More detail:
- `BENCHMARKS.md`
- `scripts/TIA.md`

## Retained fast paths

The active tool-runtime loop now keeps only the approaches that remain useful:

1. **compiled runner + in-process tools** — default retained fast path; `read`/`write`/`edit` run fully in-process and the remaining `bash` hot helpers are C built with `zig cc`.
2. **warm daemon + native helpers** — retained for repeated-call and verified-write workloads where amortizing startup can still win.
3. **gcc-built comparison helpers** — low-level comparison binaries only, not the active runtime path.

The installed fast-tools extension runs the hot tool paths fully in-process (no per-call process spawns):
- `read` → single-pass windowed byte scanner (memchr-backed newline scan, one decode per contiguous run, UTF-8-safe chunk joins)
- `write` → atomic temp-file + rename with byte-for-byte read-back verification before the rename (`TIA_FASTWRITE_FSYNC=1` opts into fsync durability)
- `edit` → in-place byte-level single replacement with read-back verification (keeps inode/mode/symlink identity); JS multi-edit path otherwise
- `bash` optimized drain/copy paths → `fastdrain` and `fastcopy` native helpers

The native `fastread-window`/`fastwrite`/`fastedit` binaries remain in `native/` and `bin/` as benchmark comparison baselines only.

The installer also attempts to add the official FFF pi extension, using the upstream `nightly` dist-tag by default:
- `find`/`grep` are backed by FFF in the default `override` mode
- `multi_grep` adds FFF multi-pattern content search
- interactive `@` file autocomplete is fed by FFF's frecency-ranked index
- state lives under `~/.local/share/tia/pi-agent/fff`

You can also opt into a [FFF fork](https://github.com/edxeth/fff) (kept in sync with upstream) that brings quality-of-life improvements to `find` and `grep`. When you use the `path` argument, the fork creates a search index rooted at the correct directory instead of always searching from the workspace root. This means path constraints match more intuitively, absolute paths work correctly, invalid paths return clear error messages, and searches across different directories in the same session behave independently.

```bash
# Install with the forked FFF
TIA_FFF_SOURCE=fork bash install.sh tia install

# Switch back to the official version any time
TIA_FFF_SOURCE=vanilla bash install.sh tia install
```

Verify which source is active with `tia status | grep fff`.

The installer ensures the latest synchronized `@earendil-works/pi-*` runtime package set is installed before compiling the sandboxed `tia pi` binary. Set `TIA_PI_PACKAGE_VERSION=<version|latest>` to select another version, `PI_PACKAGE_DIR=<path>` to use a local package checkout, or `TIA_SKIP_PI_PACKAGE_INSTALL=1` to skip the global package update.

Set `TIA_ENABLE_FFF=0` to skip FFF entirely, `TIA_REQUIRE_FFF=1` to make FFF install failures fatal, or `PI_FFF_MODE=tools-and-ui|tools-only|override` at runtime to change FFF behavior. Extensions from the shell/global pi agent are loaded via the shared `settings.json` packages list.

Removed from active tool benchmarking and harness code:

- **stock Bun tool baseline** — still useful historically, but too slow as an active candidate.
- **Bun source-runner fast path** — slower than compiled runners and no longer worth carrying as a separate approach.

## Write reliability

Writes are now optimized for correctness first:

- normal file writes use a same-directory temporary file followed by atomic rename
- writes verify exact bytes through the open temporary file descriptor before atomic rename; rename moves that verified inode into place
- symlink writes preserve the symlink and verify the target content
- per-file mutation queues serialize concurrent writes/edits to the same path
- multi-file edits plan inside sorted mutation queues and revalidate every preflight snapshot before writing; external changes abort the edit rather than being overwritten
- mismatch errors include expected/got character counts, byte counts, and first mismatch location

Reliability tests cover empty content, large content, CRLF, Unicode/emoji, markdown/code fences, JSON escaping, overwrite shrinking, nested paths, concurrent writes and multi-file edits, stale external mutations, symlink-preserving writes, partial native writes/copies, verification corruption, rollback failure reporting, and interrupted atomic renames.

## Testing

Run the smoke/integration checks:

```bash
TIA_PI_PACKAGE_VERSION=0.84.4 bash test.sh
```

Use plain `bash test.sh` to check upstream `latest` instead; the known 0.85.0 bundling failure is tracked in `TODO.md`.

Run the low-level optimization checks only (includes exact write verification for empty, large, CRLF, Unicode, overwrite, nested path, and symlink-preserving cases):

```bash
bash bench/test-low-level.sh
```

Run the iterative speed/reliability feedback loop (defaults to 5 smoke rounds and compares only retained candidates):

```bash
bash bench/feedback-loop.sh
```

For a heavier confirmation pass:

```bash
TIER=full ROUNDS=5 bash bench/feedback-loop.sh
```

The completed five-round v4 full-tier output is archived under `bench/history/2026-07-low-level-v4-feedback/`; all measured runs passed.

The feedback loop auto-installs the pinned Zig nightly (`0.17.0-dev.1441+d5181a9c9`) locally for measured Zig-built helper candidates. You can also install it explicitly:

```bash
bun run install:zig
# or
bash scripts/install-zig.sh
```

Set `ZIG_VERSION=<version|stable|latest>` only when intentionally overriding the pinned tia-runtime toolchain.

## Linting and formatting

```bash
bun install
bun run lint
bun run format
bun run format:write
```

What it covers:
- local `tia` install/status
- `tia pi` shell-agent link refresh
- rejection of deprecated top-level modes
- `tia pi` RPC health
- exact write reliability cases for empty, large, CRLF, Unicode, overwrite, nested path, and symlink-preserving writes
- real curl/bootstrap install from outside the repo checkout
- fast tool runner execution
- low-level native/compiled runner validation
- benchmark process cleanup

## Main benchmark commands

For the current read-bounds comparison (prepare the original extension using the [report's instructions](bench/history/read-bounds-v1/README.md#reproduce)):

```bash
bun run bench:tools <baseline-extension.ts> <output.json> 12 200 60
```

Other startup and helper benchmarks:

```bash
bash bench/feedback-loop.sh
bash bench/hyperfine-tia-pi.sh
bash bench/hyperfine-tia-json-stream.sh
bash bench/hyperfine-pi-rpc-direct.sh
bash bench/hyperfine-pi-tools-fast-burst.sh
bash bench/hyperfine-pi-tools-fast-stream.sh
bash bench/hyperfine-pi-tools-persistent.sh
```

To burst the real installed fast-tools extension path directly:

```bash
PI_CODING_AGENT_DIR=~/.local/share/tia/pi-agent bun bench/fast-tools-extension-burst.ts write 25
```

## Fast stream path

For faster JSON streaming, tia now uses the slim stream runtime by default for `--mode json --no-session`:

```bash
tia pi --mode json --no-session "Reply in five words."
```

Opt out only if needed:

```bash
TIA_DISABLE_FAST_STREAM=1 tia pi --mode json --no-session "Reply in five words."
```

This path is intentionally optimized for speed over stock JSON event compatibility. It uses a compiled slim runner that calls pi's provider streaming layer directly, bypassing the full CLI, AgentSession, tools, extensions, skills, prompt templates, themes, and context-file discovery. Unsupported flags or sessionful JSON runs fall back to the normal compiled `tia pi` binary.

The installer compiles the slim runner with bun bytecode generation (falling back to a plain minified compile when the toolchain cannot emit bytecode), and the main `tia pi` binary with `--minify`; both cut startup latency measurably.

Subagent guidance: do not force tool-using coding subagents through slim mode. Use full JSON pi for subagents that need tools or stock pi JSON events, optionally with `--no-session --no-skills --no-prompt-templates --no-themes --no-context-files`. Reserve slim mode for model-only stateless subagents that can consume compact `t` events.

## Release asset staging

```bash
bash scripts/stage-release-assets.sh
```

This writes clearly named `tia-*` files into `release-assets/`.

## Notes

- `tia pi` is the strongest performance-focused path today.
- Generated payloads, benchmark results, release-assets, compiled binaries, and `node_modules` are gitignored.
