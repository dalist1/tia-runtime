# Release notes

## v0.1.2

Bootstrap and packaging polish release.

### Highlights
- true curl/bootstrap install path now works from outside the repo checkout when `INSTALL_BASE_URL` is set
- `scripts/install-max.sh` can now fetch `fast-tools-extension.ts` from the script host when local repo files are unavailable
- `test.sh` now verifies a real isolated bootstrap install, not just local delegation
- root `README.md` was collapsed into a more complete single-page guide
- added `scripts/stage-release-assets.sh` to build clearly named release assets

### Recommended install

Local clone:

```bash
bash install.sh max install
```

Bootstrap / hosted scripts:

```bash
curl -fsSL https://your.host/install.sh | \
  INSTALL_BASE_URL=https://your.host/scripts bash -s -- max install
```

### Notes
- no new performance claims were introduced in this release
- benchmark summaries continue to live in `BENCHMARKS.md`

## v0.1.1

Polish release.

### Highlights
- top-level `install.sh` entrypoint now supports local delegation and curl/bootstrap delegation
- root `BENCHMARKS.md` summary added
- root `test.sh` smoke/integration test added
- dedicated benchmark entrypoints for:
  - `max pi`
  - `max opencode` startup
- root README simplified and benchmark summary table added
