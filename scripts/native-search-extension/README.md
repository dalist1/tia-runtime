# native search extension

Vanilla, site-bounded search extension installed with `bash install.sh tia install --search` and used by `tia pi` without a runtime `--search` flag.

Rules:
- no third-party search APIs
- no extraction/search libraries
- bounded URLs/sites only
- Zig backend handles fetch, extraction, ranking, and output
- balanced planning broadens across origins instead of exhausting one site first
- each TypeScript file stays under 400 lines

Module map:
- `native-search.zig` fetches exact URLs, decodes fixture corpora, extracts readable text, ranks, and formats output
- `index.ts` registers the `native_search` tool when the extension is installed
- `tool.ts` orchestrates bounded discovery, balanced/deep/direct planning, and launches the Zig backend
- `discover.ts` reads `llms.txt`, sitemaps, and same-origin page links for site mode
- `http.ts` is used only for discovery fetches
- `text.ts` has small URL/text helpers
- `types.ts`, `config.ts` keep shared types and limits

Bench helpers:
- `bench/hyperfine-native-search-zig.sh` uses only Zig for fixture generation plus full extract/rank benchmarking
- `bench/native-search-live-smoke.sh` runs opt-in exact-URL live fetch/extract/rank through Zig only
