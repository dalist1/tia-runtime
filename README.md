# tia — Terminal Interactive Agents runtime

Private research repo for the **Terminal Interactive Agents runtime**.

Goal:
- make terminal coding agents faster without patching upstream agent codebases
- keep the fast path simple and sandboxed
- expose user-facing tia runtime subcommands from this project:
  - `tia pi`
  - `tia opencode`

Reference baselines still exist for comparison:
- stock/native `pi`
- compiled direct `pi` benchmark path

## Supported modes

Install tia with:

```bash
bash install.sh tia install
```

Then use:

```bash
tia pi
tia opencode
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

## What tia does

- installs `~/.local/bin/tia`
- creates the tia sandbox runtime under `~/.local/share/tia`
- runs `tia pi` with:
  - compiled pi startup path
  - sandboxed pi agent dir
  - fast-tools extension enabled
  - current shell environment preserved for provider/model login env vars
- runs `tia opencode` with:
  - tia-managed XDG wrapper dirs
  - the shell opencode config/data/cache/state directories linked in at launch time
  - the exact same opencode credentials, session database, login state, and shell env vars preserved
- combines runtime sandboxing with the pi fast path in one launcher

## Current benchmark highlights

| Path | Workload | Speedup |
|---|---|---:|
| `tia pi` | RPC startup (`get_state`) | **1.86x** |
| compiled direct `pi` | RPC startup (`get_state`) | **1.98x** |
| `tia pi` fast tools | `read` burst | **5.18x** |
| `tia pi` fast tools | `read` streaming burst | **5.49x** |
| `tia pi` fast tools | `edit` burst | **2.50x** |
| `tia pi` fast tools | `bash` burst | **1.59x** |

Notes:
- `compiled direct pi` is a benchmark reference, not a separate supported install mode.
- benchmark highlights below currently focus on `tia pi`.
- `tia opencode` currently focuses on preserving the exact same shell credentials/session wiring rather than a separate benchmark fast path.
- `tia` does not add startup-time session/history cleanup logic.

More detail:
- `BENCHMARKS.md`
- `scripts/TIA.md`

## Testing

Run the smoke/integration checks:

```bash
bash test.sh
```

Run the low-level optimization checks only:

```bash
bash bench/test-low-level.sh
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
- `tia opencode` exact credential/session dir linking and env preservation when `opencode` is installed
- rejection of deprecated top-level modes
- `tia pi` RPC health
- real curl/bootstrap install from outside the repo checkout
- fast tool runner execution
- low-level native/compiled runner validation
- benchmark process cleanup

## Main benchmark commands

```bash
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

This path is intentionally optimized for speed over stock JSON event compatibility.

## Release asset staging

```bash
bash scripts/stage-release-assets.sh
```

This writes clearly named `tia-*` files into `release-assets/`.

## Notes

- `tia pi` is the strongest performance-focused path today.
- `tia opencode` adds the same tia-style sandbox launcher flow for opencode.
- Generated payloads, benchmark results, release-assets, compiled binaries, and `node_modules` are gitignored.
