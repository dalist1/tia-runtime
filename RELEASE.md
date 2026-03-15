# Release notes

## v0.1.6

Canonical tia benchmark-script release.

### Highlights
- tia-named benchmark scripts are now the canonical implementations
- legacy `max` benchmark script names remain as compatibility wrappers
- tia-named helper build script is now canonical too
- no installer, launcher, or performance claims changed from `v0.1.5`

## v0.1.5

Leftover tia cleanup release.

### Highlights
- benchmark scripts now use tia labels and tia runtime paths
- added tia-named benchmark entrypoint wrappers
- benchmark/result documentation now points at tia-named result directories
- staged release assets now source from tia-named result directories
- no behavior or performance claims changed from `v0.1.4`

## v0.1.4

Full tia rename release.

### Highlights
- the primary launcher command is now `tia`
- `install.sh` now defaults to `tia install`
- added `scripts/install-tia.sh` as the primary launcher installer
- added `scripts/TIA.md` as the primary launcher doc
- the GitHub repo slug is now `dalist1/tia`
- the top-level installer now defaults to the renamed GitHub repo slug
- release asset staging now ships `tia-install-tia.sh` and `tia-launcher.md`
- a legacy `max` alias is still created by default for compatibility

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
- the runtime name is `tia`
- the primary command is now `tia`
- `max` remains a compatibility alias
- benchmark claims are unchanged from the prior release

## v0.1.3

Naming release.

### Highlights
- the project is now branded as **tia**
- expanded title in docs: **Terminal Interactive Agents runtime**
- root docs and benchmark docs now use tia naming
- release asset staging now emits cleaner `tia-*` filenames
- launcher behavior and benchmark claims are unchanged from `v0.1.2`

## v0.1.2

Bootstrap and packaging polish release.

### Highlights
- true curl/bootstrap install path now works from outside the repo checkout when `INSTALL_BASE_URL` is set
- `scripts/install-max.sh` can now fetch `fast-tools-extension.ts` from the script host when local repo files are unavailable
- `test.sh` now verifies a real isolated bootstrap install, not just local delegation
- root `README.md` was collapsed into a more complete single-page guide
- added `scripts/stage-release-assets.sh` to build clearly named release assets
