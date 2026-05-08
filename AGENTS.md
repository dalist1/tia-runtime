# Agent notes for tia-runtime

- Prefer FFF tools for search: `find` for paths, `grep` for content, `multi_grep` for OR searches. Use short bare identifiers and tool constraints (`src/`, `*.ts`, `*.{ts,tsx} !test/`) instead of shelling out to `rg`/`fd`/`find`.
- `tia pi` is the full daily coding path: tools, sessions, extensions, FFF, fast-tools, skills/templates/themes, and normal pi behavior.
- `tia pi --mode json --no-session ...` is the slim stateless stream path. It is auto-routed to `pi-stream-fast` and skips tools, extensions, skills, prompt templates, themes, context files, persisted sessions, and stock pi JSON compatibility.
- Do not force tool-using coding subagents through slim mode. They need full JSON pi so they can use tools and parse normal pi events.
- For subagents that need tools, use full JSON mode and reduce overhead with `--no-session --no-skills --no-prompt-templates --no-themes --no-context-files` where safe.
- Use slim mode only for model-only subagents/tasks that need no tools/resources and can consume compact events (`t: session/s/d/e/done`).
- To force full JSON compatibility for tests or consumers: `TIA_DISABLE_FAST_STREAM=1 tia pi --mode json --no-session ...`.

Validation for runtime/install/streaming/tool changes:

```bash
bash -n install.sh scripts/install-tia.sh test.sh
bun run format
bun run lint
bun test
bash test.sh
```

<!-- tia-runtime-guidance:start -->
## Pi / tia usage guidance

- Prefer FFF-backed search tools: `find` for paths, `grep` for content, and `multi_grep` for OR searches. Use short bare identifiers plus constraints like `src/`, `*.ts`, or `*.{ts,tsx} !test/`; avoid shelling out to `rg`/`fd`/`find` unless FFF is unavailable.
- Use `tia pi` for full coding sessions: tools, sessions, extensions, FFF, fast-tools, skills/templates/themes, and normal pi behavior.
- Use `tia pi --mode json --no-session ...` only for stateless model-only streaming calls; it auto-routes to the slim `pi-stream-fast` path and skips tools/resources plus stock pi JSON compatibility.
- Do not force tool-using coding subagents through slim mode. For subagents that need tools or stock pi JSON events, use full JSON pi and reduce overhead with `--no-session --no-skills --no-prompt-templates --no-themes --no-context-files` where safe.
- For compatibility tests or consumers that need stock JSON events, disable the slim path with `TIA_DISABLE_FAST_STREAM=1`.
<!-- tia-runtime-guidance:end -->
