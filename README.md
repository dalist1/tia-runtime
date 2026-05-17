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

Recent local benchmark runs show:

| Path | Workload | Result |
|---|---|---:|
| `tia pi` | RPC startup (`get_state`) | about **1.9x** faster than stock `pi` |
| retained tool path | `read` burst | about **2.1x** faster than stock in smoke loops |
| retained tool path | `read` streaming burst | about **2.0x** faster than stock in smoke loops |
| retained tool path | `edit` burst | about **2.1x** faster than stock in smoke loops |
| retained tool path | verified `write` burst | about **1.5–1.6x** faster than stock in smoke loops |
| retained tool path | `bash` drain/copy burst | about **1.9x** faster than stock in smoke loops |
| `native_search` | full local Zig fixture/extract/rank | 2k raw docs in **11.3 ms** (zero network benchmark) |

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

1. **compiled runner + native helpers** — default retained fast path; read/edit are pure Zig binaries and the remaining hot helpers are C built with `zig cc`.
2. **warm daemon + native helpers** — retained for repeated-call and verified-write workloads where amortizing startup can still win.
3. **gcc-built comparison helpers** — low-level comparison binaries only, not the active runtime path.

The installed fast-tools extension now tries low-level helpers for every hot tool path:
- `read` → `fastread-window`
- `write` → `fastwrite` with exact verification
- `edit` → `fastedit` for single exact replacements, JS multi-edit fallback otherwise
- `bash` optimized drain/copy paths → `fastdrain` and `fastcopy`

Pass `--search` at install time to add the modular native search extension. Runtime sessions then use the installed `native_search` tool automatically; do not pass `--search` to `tia pi`:
- `native_search` performs bounded website search from provided URLs/sites only; query-only URLs use exact direct-URL mode without discovery
- vanilla implementation: no third-party extraction libraries and no search-engine/tool APIs
- discovers `llms.txt`, sitemaps, and same-origin links in bounded site mode
- final exact URL fetch, markdown/html extraction, ranking, and output are handled by the compiled Zig backend
- default `balanced` planning uses divide-and-conquer round-robin candidate selection across origins; `deep` and `direct` strategies are available
- stays bounded by explicit sites/URLs, caps pages/results, and applies a per-origin/inter-request delay
- live smoke benchmarking is opt-in and runs exact URL fetch/extract/rank through Zig only

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

The installer ensures `@mariozechner/pi-coding-agent` is installed at the pinned latest version before compiling the sandboxed `tia pi` binary. Set `TIA_PI_PACKAGE_VERSION=<version|latest>` to override the pin, `PI_PACKAGE_DIR=<path>` to use a local package checkout, or `TIA_SKIP_PI_PACKAGE_INSTALL=1` to skip the global package update.

Set `TIA_ENABLE_FFF=0` to skip FFF entirely, `TIA_REQUIRE_FFF=1` to make FFF install failures fatal, or `PI_FFF_MODE=tools-and-ui|tools-only|override` at runtime to change FFF behavior. Set `TIA_ENABLE_NATIVE_SEARCH=1` or pass `bash install.sh tia install --search` to install native search; omit it or pass `--no-search` to leave runtime behavior to whatever global/user extensions are already installed. Extensions from the shell/global pi agent are loaded via the shared `settings.json` packages list.

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

The feedback loop auto-installs the pinned Zig nightly (`0.17.0-dev.305+bdfbf432d`) locally for measured Zig-built helper candidates. You can also install it explicitly:

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

```bash
bash bench/feedback-loop.sh
bash bench/hyperfine-tia-pi.sh
bash bench/hyperfine-pi-rpc-direct.sh
bash bench/hyperfine-pi-tools-fast-burst.sh
bash bench/hyperfine-pi-tools-fast-stream.sh
bash bench/hyperfine-pi-tools-persistent.sh
bash bench/hyperfine-native-search-zig.sh
bash bench/build-native-search-zig.sh
TIA_NATIVE_SEARCH_LIVE=1 bash bench/native-search-live-smoke.sh
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

Subagent guidance: do not force tool-using coding subagents through slim mode. Use full JSON pi for subagents that need tools or stock pi JSON events, optionally with `--no-session --no-skills --no-prompt-templates --no-themes --no-context-files`. Reserve slim mode for model-only stateless subagents that can consume compact `t` events.

## Release asset staging

```bash
bash scripts/stage-release-assets.sh
```

This writes clearly named `tia-*` files into `release-assets/`.

## Notes

- `tia pi` is the strongest performance-focused path today.
- Generated payloads, benchmark results, release-assets, compiled binaries, and `node_modules` are gitignored.
