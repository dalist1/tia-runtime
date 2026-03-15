# Release notes

## v0.1.0

Initial private release.

### Highlights
- top-level `install.sh` entrypoint
- sandboxed `max` launcher:
  - `max pi`
  - `max opencode`
- compiled pi launcher path
- aggressive pi fast-tools extension
- benchmark suite for launcher, RPC, built-in tools, and opencode helper paths

### Recommended install

```bash
curl -fsSL https://raw.githubusercontent.com/dalist1/max-sandbox-research/main/install.sh | bash -s -- max install
```

### Other modes

```bash
curl -fsSL https://raw.githubusercontent.com/dalist1/max-sandbox-research/main/install.sh | bash -s -- fast-pi install
curl -fsSL https://raw.githubusercontent.com/dalist1/max-sandbox-research/main/install.sh | bash -s -- fast-pi-max install
```
