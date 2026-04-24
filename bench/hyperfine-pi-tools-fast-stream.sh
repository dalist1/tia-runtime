#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
RESULT_DIR="${RESULT_DIR:-${ROOT_DIR}/results-pi-tools-fast-stream-smoke}"
RUNS="${RUNS:-6}"
WARMUP="${WARMUP:-1}"
READ_ITERATIONS="${READ_ITERATIONS:-60}"

mkdir -p "${RESULT_DIR}"

cleanup() {
	bash "${ROOT_DIR}/bench/cleanup-processes.sh" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
cleanup

bash "${ROOT_DIR}/bench/build-tool-fixtures.sh"
bash "${ROOT_DIR}/bench/build-native.sh"
bash "${ROOT_DIR}/bench/build-pi-tool-override-burst.sh"

hyperfine \
	--shell=none \
	--warmup "${WARMUP}" \
	--runs "${RUNS}" \
	--export-json "${RESULT_DIR}/read.json" \
	--export-markdown "${RESULT_DIR}/read.md" \
	--command-name "stock (bun)" \
	"bun ${ROOT_DIR}/bench/pi-tool-override-stream-burst.ts stock read ${READ_ITERATIONS}" \
	--command-name "fast (bun)" \
	"bun ${ROOT_DIR}/bench/pi-tool-override-stream-burst.ts fast read ${READ_ITERATIONS}" \
	--command-name "fast (compiled)" \
	"${ROOT_DIR}/bin/pi-tool-override-stream-burst fast read ${READ_ITERATIONS}"

printf 'Wrote fast override streaming benchmark results to %s\n' "${RESULT_DIR}"
