# Release notes

## v0.2.0

Single-mode tia release.

### Highlights
- `tia pi` is now the only supported user-facing runtime mode from this project
- `install.sh` now supports only `tia`
- deprecated top-level modes `max`, `fast-pi`, and `fast-pi-max` are now rejected
- docs and release assets were simplified around the single tia mode
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
- supported mode: `tia pi`
- benchmark-only reference path: compiled direct `pi`

## v0.1.6

Canonical tia benchmark-script release.

## v0.1.5

Leftover tia cleanup release.

## v0.1.4

Full tia rename release.
