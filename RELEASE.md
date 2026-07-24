# Release notes

## v0.3.0

Low-level v4 runtime and benchmark cleanup.

### Highlights
- install the latest pi runtime on every tia installation
- load provider-specific model catalogs on the slim stream path and validate stock pi provider defaults during installation
- speed up bounded edit diffs, stream framing, native read/edit/write, and bash copy/drain helpers
- add a reproducible local Anthropic HTTP/SSE benchmark covering the complete slim streaming path
- prevent stale multi-file edit plans from overwriting concurrent or external file changes, and add native I/O/rollback fault injection coverage
- archive a five-round full-tier feedback run with 100% successful measurements
- make benchmark and RPC harnesses portable across machines
- enforce formatting, linting, and TypeScript checks across every TypeScript source

## v0.2.0

Tia runtime release.

### Highlights
- `install.sh` now supports only the `tia` top-level target
- `tia pi` is the only supported coding-agent runtime command
- deprecated top-level modes `max`, `fast-pi`, and `fast-pi-max` are now rejected
- docs and release assets were simplified around the tia runtime
- `tia pi` remains the path that combines startup and tool optimization without patching upstream pi

### Recommended install

Local clone:

```bash
bash install.sh tia install
```

Global user install from GitHub:

```bash
curl -fsSL https://raw.githubusercontent.com/dalist1/tia-runtime/main/install.sh | bash -s -- tia install
```

### Notes
- supported coding-agent runtime command: `tia pi`
- benchmark-only reference path: compiled direct `pi`

## v0.1.6

Canonical tia benchmark-script release.

## v0.1.5

Leftover tia cleanup release.

## v0.1.4

Full tia rename release.
