# TODO

- Generate or validate preferred provider model IDs from the installed pi-ai catalog instead of maintaining the `DEFAULT_MODEL` table manually. The current xAI preference is stale, and multi-provider authentication needs parity tests for fallback selection.
- Add integration coverage for custom providers, custom model definitions, duplicate unqualified model IDs, OAuth refresh locking, and every provider-specific catalog fallback.
- Re-run the loopback HTTP/SSE end-to-end benchmark for optimization version `2026-07-low-level-v4`; this checkpoint records no-network startup and local tool-path measurements.
- Profile the extension read and verified-write paths further. This pass measured them as neutral and intentionally makes no speedup claim.
- Replace the installer’s inline model-catalog generation program with a typed, directly tested build script.
- Add fault-injection tests for partial native writes, `copy_file_range`/`sendfile` fallback after partial progress, verification mismatches, rollback failures, and interrupted atomic renames.
- Revisit multi-file edit planning under concurrent external mutations so preflight reads cannot become stale before queued writes begin.
- Run a longer full-tier feedback loop on an otherwise idle machine and archive the raw output alongside the v4 benchmark record.
