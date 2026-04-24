# tia-runtime — Terminal Interactive Agents runtime

Private research repo for **tia-runtime**, the Terminal Interactive Agents runtime.

Goal:
- make terminal coding agents faster without patching upstream agent codebases
- keep the fast path simple and sandboxed
- expose the user-facing `tia pi` runtime from this project

Reference baselines still exist for comparison:
- stock/native `pi`
- compiled direct `pi` benchmark path

## Supported modes

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

The top-level installer bootstraps sibling scripts when `INSTALL_BASE_URL` points at a host serving the `scripts/` directory.

```bash
curl -fsSL https://your.host/install.sh | \
  INSTALL_BASE_URL=https://your.host/scripts bash -s -- tia install
```

This path is smoke-tested from outside the repo checkout.

## What tia-runtime installs

- installs the `tia` launcher at `~/.local/bin/tia`
- creates the tia runtime sandbox under `~/.local/share/tia`
- runs `tia pi` with:
  - compiled pi startup path
  - sandboxed pi agent dir
  - fast-tools extension enabled
  - low-level helper binaries installed under `~/.local/share/tia/pi-agent/fast-tools` when building from a local checkout (`fastread-window`, `fastwrite`, `fastedit`, `fastdrain`, `fastcopy`)
  - FFF (`@ff-labs/pi-fff`) installed as a sandboxed pi extension when available, giving FFF-backed `find`/`grep`/`multi_grep` and `@` file autocomplete (default `PI_FFF_MODE=override`)
  - current shell environment preserved for provider/model login env vars
  - auth/models/settings symlinks refreshed from the shell pi agent without self-linking the tia sandbox, preserving cliproxy model/provider linkage
- combines runtime sandboxing with the pi fast path in one launcher

## Current benchmark highlights

Recent local feedback-loop runs show:

| Path | Workload | Result |
|---|---|---:|
| `tia pi` | RPC startup (`get_state`) | about **1.9x** faster than stock `pi` |
| retained tool path | `read` burst | about **2.1x** faster than stock in smoke loops |
| retained tool path | `read` streaming burst | about **2.0x** faster than stock in smoke loops |
| retained tool path | `edit` burst | about **2.1x** faster than stock in smoke loops |
| retained tool path | verified `write` burst | about **1.5–1.6x** faster than stock in smoke loops |
| retained tool path | `bash` drain/copy burst | about **1.9x** faster than stock in smoke loops |

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

1. **compiled runner + native helpers** — default retained fast path.
2. **compiled runner + Zig-built helpers** — measured candidate for read/stream/bash/edit/write helper binaries.
3. **warm daemon + native helpers** — retained for repeated-call and verified-write workloads where amortizing startup can still win.

The installed fast-tools extension now tries low-level helpers for every hot tool path:
- `read` → `fastread-window`
- `write` → `fastwrite` with exact verification
- `edit` → `fastedit` for single exact replacements, JS multi-edit fallback otherwise
- `bash` optimized drain/copy paths → `fastdrain` and `fastcopy`

The installer also attempts to add the official FFF pi extension:
- `find`/`grep` are backed by FFF in the default `override` mode
- `multi_grep` adds FFF multi-pattern content search
- interactive `@` file autocomplete is fed by FFF's frecency-ranked index
- state lives under `~/.local/share/tia/pi-agent/fff`

Set `TIA_ENABLE_FFF=0` to skip installing it, `TIA_REQUIRE_FFF=1` to make installation failure fatal, `TIA_FFF_PACKAGE_VERSION=<version>` to pin a different package version, or `PI_FFF_MODE=tools-and-ui|tools-only|override` at runtime to change mode.

Removed from active tool benchmarking and harness code:

- **stock Bun tool baseline** — still useful historically, but too slow as an active candidate.
- **Bun source-runner fast path** — slower than compiled runners and no longer worth carrying as a separate approach.

## Write reliability

Writes are now optimized for correctness first:

- normal file writes use a same-directory temporary file followed by atomic rename
- writes verify exact text after the temporary write and after final rename
- symlink writes preserve the symlink and verify the target content
- per-file mutation queues serialize concurrent writes/edits to the same path
- mismatch errors include expected/got character counts, byte counts, and first mismatch location

Reliability tests cover empty content, large content, CRLF, Unicode/emoji, markdown/code fences, JSON escaping, overwrite shrinking, nested paths, concurrent writes, and symlink-preserving writes.

## Testing

Run the smoke/integration checks:

```bash
bash test.sh
```

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

The feedback loop auto-installs Zig locally for measured Zig-built helper candidates. You can also install it explicitly:

```bash
bun run install:zig
# or
bash scripts/install-zig.sh
```

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

```bash
bash bench/feedback-loop.sh
bash bench/hyperfine-tia-pi.sh
bash bench/hyperfine-pi-rpc-direct.sh
bash bench/hyperfine-pi-tools-fast-burst.sh
bash bench/hyperfine-pi-tools-fast-stream.sh
bash bench/hyperfine-pi-tools-persistent.sh
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

## Release asset staging

```bash
bash scripts/stage-release-assets.sh
```

This writes clearly named `tia-*` files into `release-assets/`.

## Notes

- `tia pi` is the strongest performance-focused path today.
- Generated payloads, benchmark results, release-assets, compiled binaries, and `node_modules` are gitignored.
