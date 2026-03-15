# tia — Terminal Interactive Agents runtime

Private research repo for the **Terminal Interactive Agents runtime**.

Goal:
- make terminal coding agents faster without patching the upstream pi codebase
- keep the fast path simple and sandboxed
- expose one user-facing runtime mode from this project:
  - `tia pi`

Reference baselines still exist for comparison:
- stock/native `pi`
- compiled direct `pi` benchmark path

A legacy `max` alias is still installed by default for compatibility when that path is free or already managed by tia.

## Supported mode

There is one supported tia mode:

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

Legacy compatibility alias:

```bash
bash install.sh max install
max status
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
- combines startup improvement and tool-path optimization in one runtime
- installs a legacy `max` alias by default when safe to do so

## Current benchmark highlights

| Path | Workload | Speedup |
|---|---|---:|
| `tia pi` | RPC startup (`get_state`) | **1.86x** |
| compiled direct `pi` | RPC startup (`get_state`) | **1.98x** |
| `tia pi` fast tools | `read` burst | **5.18x** |
| `tia pi` fast tools | `edit` burst | **2.50x** |
| `tia pi` fast tools | `bash` burst | **1.59x** |

Notes:
- `compiled direct pi` is a benchmark reference, not a separate supported install mode.
- `tia pi` is the single supported runtime mode from this project.

More detail:
- `BENCHMARKS.md`
- `scripts/TIA.md`

## Testing

Run the smoke/integration checks:

```bash
bash test.sh
```

What it covers:
- local `tia` install/status
- legacy `max` alias health
- rejection of deprecated top-level modes
- `tia pi` RPC health
- real curl/bootstrap install from outside the repo checkout
- legacy fast-pi wrapper delegation to tia
- fast tool runner execution
- benchmark process cleanup

## Main benchmark commands

```bash
bash bench/hyperfine-tia-pi.sh
bash bench/hyperfine-pi-rpc-direct.sh
bash bench/hyperfine-pi-tools-fast-burst.sh
```

## Release asset staging

```bash
bash scripts/stage-release-assets.sh
```

This writes clearly named `tia-*` files into `release-assets/`.

## Notes

- `tia pi` is the strongest path today.
- Set `INSTALL_LEGACY_MAX_ALIAS=0` if you do not want the compatibility `max` alias.
- Generated payloads, benchmark results, release-assets, compiled binaries, and `node_modules` are gitignored.
