# Release notes

## v0.2.0

Tia runtime release.

### Highlights
- `install.sh` now supports only the `tia` top-level target
- runtime subcommands now include `tia pi` and `tia opencode`
- deprecated top-level modes `max`, `fast-pi`, and `fast-pi-max` are now rejected
- docs and release assets were simplified around the tia runtime
- `tia pi` remains the path that combines startup and tool optimization without patching upstream pi
- `tia opencode` adds sandboxed opencode launch support via tia-managed XDG directories

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
- supported runtime subcommands: `tia pi`, `tia opencode`
- benchmark-only reference path: compiled direct `pi`

## v0.1.6

Canonical tia benchmark-script release.

## v0.1.5

Leftover tia cleanup release.

## v0.1.4

Full tia rename release.
