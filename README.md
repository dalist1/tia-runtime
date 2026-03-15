# tia — Terminal Interactive Agents runtime

Private research repo for the **Terminal Interactive Agents runtime**.

Goal:
- make terminal coding agents faster without patching the upstream pi codebase
- keep the fast path simple and sandboxed
- expose the main runtime as:
  - `tia pi`
  - `tia opencode`

A legacy `max` alias is still installed by default for compatibility when that path is free or already managed by tia.

## Pick a mode

| If you want... | Use |
|---|---|
| the main tia runtime | `bash install.sh tia install` |
| only a safer compiled `pi` default | `bash install.sh fast-pi install` |
| compiled `pi` plus global fast tool overrides | `bash install.sh fast-pi-max install` |

## Recommended path

Install tia:

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

bash install.sh fast-pi install
bash install.sh fast-pi status
bash install.sh fast-pi uninstall

bash install.sh fast-pi-max install
bash install.sh fast-pi-max status
bash install.sh fast-pi-max uninstall
```

## Curl / bootstrap usage

The top-level installer bootstraps sibling scripts when `INSTALL_BASE_URL` points at a host serving the `scripts/` directory.

```bash
curl -fsSL https://your.host/install.sh | \
  INSTALL_BASE_URL=https://your.host/scripts bash -s -- tia install
```

This path is smoke-tested from outside the repo checkout.

## What each mode does

### `tia`
- installs `~/.local/bin/tia`
- creates the tia sandbox runtime under `~/.local/share/tia`
- runs `tia pi` with:
  - compiled pi
  - sandboxed pi agent dir
  - fast-tools extension enabled
- runs `tia opencode` with a sandboxed helper `PATH`
- installs a legacy `max` alias by default when safe to do so

### `fast-pi`
- compiles the installed pi CLI
- keeps the original launcher as `pi-original`
- makes compiled `pi` the default

### `fast-pi-max`
- does everything from `fast-pi`
- installs a global fast-tools extension overriding:
  - `read`
  - `write`
  - `edit`
  - parts of `bash`

## Current benchmark highlights

| Path | Workload | Speedup |
|---|---|---:|
| `tia pi` | RPC startup (`get_state`) | **1.86x** |
| compiled direct `pi` | RPC startup (`get_state`) | **1.98x** |
| `tia pi` fast tools | `read` burst | **5.18x** |
| `tia pi` fast tools | `edit` burst | **2.50x** |
| `tia pi` fast tools | `bash` burst | **1.59x** |
| `tia opencode` | `--version` startup | **1.06x** |
| `tia opencode` | repeated `cp` shell workload | **1.11x** |

More detail:
- `BENCHMARKS.md`
- `scripts/TIA.md`
- `scripts/FAST-PI.md`
- `scripts/FAST-PI-MAX.md`

## Testing

Run the smoke/integration checks:

```bash
bash test.sh
```

What it covers:
- local `tia` install/status
- legacy `max` alias health
- `tia pi` RPC health
- real curl/bootstrap install from outside the repo checkout
- `fast-pi` and `fast-pi-max` status paths
- fast tool runner execution
- `tia opencode --version`
- benchmark process cleanup

## Main benchmark commands

```bash
bash bench/hyperfine-tia-pi.sh
bash bench/hyperfine-pi-rpc-direct.sh
bash bench/hyperfine-pi-tools-fast-burst.sh
bash bench/hyperfine-tia-opencode-startup.sh
bash bench/hyperfine-tia-opencode-helpers.sh
```

## Release asset staging

```bash
bash scripts/stage-release-assets.sh
```

This writes clearly named `tia-*` files into `release-assets/`.

## Notes

- `tia pi` is the strongest path today.
- `tia opencode` is still the weaker/beta path.
- Set `INSTALL_LEGACY_MAX_ALIAS=0` if you do not want the compatibility `max` alias.
- Generated payloads, benchmark results, release-assets, compiled binaries, and `node_modules` are gitignored.
