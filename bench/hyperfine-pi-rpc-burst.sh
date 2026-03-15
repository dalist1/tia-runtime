#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
RESULT_DIR="${RESULT_DIR:-${ROOT_DIR}/results-pi-rpc-burst-smoke}"
REQUEST_FILE="${REQUEST_FILE:-${ROOT_DIR}/payloads-rpc/empty.get-state.jsonl}"
ITERATIONS="${ITERATIONS:-200}"
RUNS="${RUNS:-6}"
WARMUP="${WARMUP:-1}"

mkdir -p "${RESULT_DIR}"

cleanup() {
	bash "${ROOT_DIR}/bench/cleanup-processes.sh" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
cleanup

bash "${ROOT_DIR}/bench/build-pi-rpc-payloads.sh"
bash "${ROOT_DIR}/bench/build-pi-rpc-direct.sh"

printf 'Running pi RPC burst benchmark into %s (runs=%s warmup=%s iterations=%s request=%s)\n' \
	"${RESULT_DIR}" "${RUNS}" "${WARMUP}" "${ITERATIONS}" "${REQUEST_FILE}"

hyperfine \
	--shell=none \
	--warmup "${WARMUP}" \
	--runs "${RUNS}" \
	--export-json "${RESULT_DIR}/burst.json" \
	--export-markdown "${RESULT_DIR}/burst.md" \
	--command-name "pi cli rpc burst" \
	"bun ${ROOT_DIR}/bench/pi-rpc-burst.ts cli ${ITERATIONS} ${REQUEST_FILE}" \
	--command-name "pi direct rpc burst" \
	"bun ${ROOT_DIR}/bench/pi-rpc-burst.ts direct ${ITERATIONS} ${REQUEST_FILE}"

printf 'Wrote pi RPC burst benchmark results to %s\n' "${RESULT_DIR}"
