#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
RESULT_DIR="${RESULT_DIR:-${ROOT_DIR}/results-tia-json-stream}"
RUNS="${RUNS:-10}"
WARMUP="${WARMUP:-2}"

command -v tia >/dev/null 2>&1 || {
	printf 'Error: tia is not installed. Run: bash install.sh tia install\n' >&2
	exit 1
}
command -v hyperfine >/dev/null 2>&1 || {
	printf 'Error: hyperfine is required for this benchmark.\n' >&2
	exit 1
}

mkdir -p "${RESULT_DIR}"

# No prompt is sent: this isolates local JSON streaming startup/runner overhead,
# not provider first-token latency. A dummy key keeps model resolution deterministic.
hyperfine \
	--shell=none \
	--warmup "${WARMUP}" \
	--runs "${RUNS}" \
	--ignore-failure \
	--export-json "${RESULT_DIR}/startup.json" \
	--export-markdown "${RESULT_DIR}/startup.md" \
	--command-name 'tia slim json stream startup' \
	"env ANTHROPIC_API_KEY=dummy $(command -v tia) pi --mode json --no-session" \
	--command-name 'tia full json startup (baseline)' \
	"env TIA_DISABLE_FAST_STREAM=1 ANTHROPIC_API_KEY=dummy $(command -v tia) pi --mode json --no-session"

printf 'Wrote slim JSON stream startup benchmark results to %s\n' "${RESULT_DIR}"
