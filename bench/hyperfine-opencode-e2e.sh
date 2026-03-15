#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
RESULT_DIR="${RESULT_DIR:-${ROOT_DIR}/results-opencode-smoke}"
RUNS="${RUNS:-4}"
WARMUP="${WARMUP:-1}"
PAYLOAD_PATH="${PAYLOAD_PATH:-${ROOT_DIR}/payloads/lines-10k.txt}"
COMMAND_TIMEOUT_SECONDS="${COMMAND_TIMEOUT_SECONDS:-45}"
COMMAND="${COMMAND:-cat ${PAYLOAD_PATH} > /dev/null}"

mkdir -p "${RESULT_DIR}"

cleanup() {
	bash "${ROOT_DIR}/bench/cleanup-processes.sh" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
cleanup

printf 'Running light OpenCode e2e benchmark into %s (runs=%s warmup=%s timeout=%ss)\n' \
	"${RESULT_DIR}" "${RUNS}" "${WARMUP}" "${COMMAND_TIMEOUT_SECONDS}"

hyperfine \
	--warmup "${WARMUP}" \
	--runs "${RUNS}" \
	--export-json "${RESULT_DIR}/e2e.json" \
	--export-markdown "${RESULT_DIR}/e2e.md" \
	--command-name "opencode baseline" \
	"timeout ${COMMAND_TIMEOUT_SECONDS}s bun \"${ROOT_DIR}/bench/opencode-e2e-run.ts\" baseline \"${ROOT_DIR}\" \"${COMMAND}\"" \
	--command-name "opencode optimized" \
	"timeout ${COMMAND_TIMEOUT_SECONDS}s bun \"${ROOT_DIR}/bench/opencode-e2e-run.ts\" optimized \"${ROOT_DIR}\" \"${COMMAND}\""

printf 'Wrote OpenCode e2e benchmark results to %s\n' "${RESULT_DIR}"
