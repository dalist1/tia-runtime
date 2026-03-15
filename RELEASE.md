# Release notes

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

### Recommended install

Local clone:

```bash
bash install.sh max install
```

If using curl, point `INSTALL_BASE_URL` at a host serving the `scripts/` directory when needed:

```bash
INSTALL_BASE_URL=https://your.host/scripts \
  curl -fsSL https://your.host/install.sh | bash -s -- max install
```

### Other modes

```bash
bash install.sh fast-pi install
bash install.sh fast-pi-max install
```
