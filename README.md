# max sandbox research

Private research repo for making `pi` and `opencode` faster without patching the upstream pi codebase.

The main idea is simple:
- use a compiled `pi` launcher where that helps
- keep aggressive tool overrides separate
- expose the fastest path through a sandboxed launcher:
  - `max pi`
  - `max opencode`

## Pick a mode

| If you want... | Use |
|---|---|
| the best current default path | `bash install.sh max install` |
| only a safer compiled `pi` default | `bash install.sh fast-pi install` |
| compiled `pi` plus global fast tool overrides | `bash install.sh fast-pi-max install` |

## Recommended path

Install the sandboxed launcher:

```bash
bash install.sh max install
```

Then use:

```bash
max pi
max opencode
max status
```

## Install, status, uninstall

```bash
bash install.sh max install
bash install.sh max status
bash install.sh max uninstall

bash install.sh fast-pi install
bash install.sh fast-pi status
bash install.sh fast-pi uninstall

bash install.sh fast-pi-max install
bash install.sh fast-pi-max status
bash install.sh fast-pi-max uninstall
```

## Curl / bootstrap usage

The top-level installer can bootstrap sibling scripts when `INSTALL_BASE_URL` points at a host serving the `scripts/` directory.

Example:

```bash
curl -fsSL https://your.host/install.sh | \
  INSTALL_BASE_URL=https://your.host/scripts bash -s -- max install
```

This path is smoke-tested from outside the repo checkout.

## What each mode does

### `max`
- installs `~/.local/bin/max`
- creates a sandboxed pi runtime under `~/.local/share/max-sandbox`
- runs `max pi` with:
  - compiled pi
  - sandboxed pi agent dir
  - fast-tools extension enabled
- runs `max opencode` with a sandboxed helper `PATH`

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
| `max pi` | RPC startup (`get_state`) | **1.86x** |
| compiled direct `pi` | RPC startup (`get_state`) | **1.98x** |
| `max pi` fast tools | `read` burst | **5.18x** |
| `max pi` fast tools | `edit` burst | **2.50x** |
| `max pi` fast tools | `bash` burst | **1.59x** |
| `max opencode` | `--version` startup | **1.06x** |
| `max opencode` | repeated `cp` shell workload | **1.11x** |

More detail:
- `BENCHMARKS.md`
- `scripts/MAX.md`
- `scripts/FAST-PI.md`
- `scripts/FAST-PI-MAX.md`

## Testing

Run the smoke/integration checks:

```bash
bash test.sh
```

What it covers:
- local `max` install/status
- `max pi` RPC health
- real curl/bootstrap install from outside the repo checkout
- `fast-pi` and `fast-pi-max` status paths
- fast tool runner execution
- `max opencode --version`
- benchmark process cleanup

## Main benchmark commands

```bash
bash bench/hyperfine-max-pi.sh
bash bench/hyperfine-pi-rpc-direct.sh
bash bench/hyperfine-pi-tools-fast-burst.sh
bash bench/hyperfine-max-opencode-startup.sh
bash bench/hyperfine-max-opencode-helpers.sh
```

## Release asset staging

To stage clearly named release assets locally:

```bash
bash scripts/stage-release-assets.sh
```

This writes files into `release-assets/`.

## Notes

- `max pi` is the strongest path today.
- `max opencode` is still the weaker/beta path.
- Generated payloads, benchmark results, release-assets, compiled binaries, and `node_modules` are gitignored.
