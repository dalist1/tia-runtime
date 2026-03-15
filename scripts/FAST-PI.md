# Fast pi installer

This installs a compiled `pi` launcher as the default `pi` command on the current machine.

It does **not** patch the pi codebase. It compiles the existing installed `dist/cli.js`, keeps the original launcher as `pi-original`, and repoints `pi` to the compiled binary.

## Requirements

- `pi` already installed and on `PATH`
- `bun` on `PATH`
- write access to the pi package directory and the directory containing the `pi` launcher

## Install

Local file one-liner:

```bash
curl -fsSL file:///absolute/path/to/install-fast-pi.sh | bash -s -- install
```

Hosted one-liner:

```bash
curl -fsSL https://your.host/install-fast-pi.sh | bash -s -- install
```

Direct invocation also works:

```bash
bash scripts/install-fast-pi.sh install
```

## Check status

```bash
bash scripts/install-fast-pi.sh status
```

## Restore original launcher

```bash
bash scripts/install-fast-pi.sh uninstall
```

## Benchmarks

Run the isolated built-in tool benchmarks with:

```bash
bash bench/hyperfine-pi-tools.sh
```

Run the launcher/RPC benchmark with:

```bash
bash bench/hyperfine-pi-rpc-direct.sh
```

## What it changes

- compiles the installed pi CLI to `pi-compiled` inside the installed pi package directory
- ensures the compiled binary can find shipped assets via:
  - `theme -> dist/modes/interactive/theme`
  - `export-html -> dist/core/export-html`
- saves the original launcher as `pi-original` next to your `pi` binary
- makes `pi` point to the compiled binary

## Notes

- This speeds up **launcher/startup/stdin-stdout path** overhead.
- It also improves built-in tool execution modestly in isolated benchmarks:
  - `read`: about **1.25x** faster
  - `write`: about **1.13x** faster
  - `edit`: about **1.15x** faster
  - `bash`: about **1.15x** faster
- It is intended to be a safe drop-in default for normal `pi` usage.
- Re-run the installer after updating pi globally, since the compiled binary should track the installed version.
