#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
RESULT_DIR="${RESULT_DIR:-${ROOT_DIR}/results-max-opencode-startup}"
RUNS="${RUNS:-8}"
WARMUP="${WARMUP:-2}"

mkdir -p "${RESULT_DIR}"

hyperfine \
	--runs "${RUNS}" \
	--warmup "${WARMUP}" \
	--export-json "${RESULT_DIR}/startup.json" \
	--export-markdown "${RESULT_DIR}/startup.md" \
	--command-name "opencode version" \
	"opencode --version" \
	--command-name "tia opencode version" \
	"tia opencode --version"

printf 'Wrote tia opencode startup benchmarks to %s\n' "${RESULT_DIR}"
