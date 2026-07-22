# Release notes

## v0.3.0

Low-level v4 runtime and benchmark cleanup.

### Highlights
- update the pinned pi runtime to `0.81.1`
- load provider-specific model catalogs on the slim stream path
- speed up bounded edit diffs, stream framing, native read/edit/write, and bash copy/drain helpers
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

Bootstrap / hosted scripts:

```bash
curl -fsSL https://your.host/install.sh | \
  INSTALL_BASE_URL=https://your.host/scripts bash -s -- tia install
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
