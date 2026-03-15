#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
RESULT_DIR="${RESULT_DIR:-${ROOT_DIR}/results-max-pi}"
RUNS="${RUNS:-6}"
WARMUP="${WARMUP:-1}"
REQUEST_FILE="${REQUEST_FILE:-${ROOT_DIR}/payloads-rpc/empty.get-state.jsonl}"

mkdir -p "${RESULT_DIR}"

hyperfine \
	--runs "${RUNS}" \
	--warmup "${WARMUP}" \
	--export-json "${RESULT_DIR}/rpc.json" \
	--export-markdown "${RESULT_DIR}/rpc.md" \
	--command-name "pi original rpc" \
	"pi-node --mode rpc --no-session --no-extensions --no-skills --no-prompt-templates --no-themes < ${REQUEST_FILE}" \
	--command-name "max pi rpc" \
	"max pi --mode rpc --no-session --no-skills --no-prompt-templates --no-themes < ${REQUEST_FILE}"

printf 'Wrote max pi benchmarks to %s\n' "${RESULT_DIR}"
