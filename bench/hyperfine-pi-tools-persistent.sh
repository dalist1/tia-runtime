#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
RESULT_DIR="${RESULT_DIR:-${ROOT_DIR}/results-pi-tools-persistent-smoke}"
RUNS="${RUNS:-6}"
WARMUP="${WARMUP:-1}"
READ_ITERATIONS="${READ_ITERATIONS:-20}"
EDIT_ITERATIONS="${EDIT_ITERATIONS:-12}"
BASH_ITERATIONS="${BASH_ITERATIONS:-8}"

mkdir -p "${RESULT_DIR}"

cleanup() {
	bash "${ROOT_DIR}/bench/cleanup-processes.sh" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
cleanup

bash "${ROOT_DIR}/bench/build-tool-fixtures.sh"
bash "${ROOT_DIR}/bench/build-native.sh"
bash "${ROOT_DIR}/bench/build-pi-tool-override-burst.sh"

run_suite() {
	local name="$1"
	local iterations="$2"

	hyperfine \
		--shell=none \
		--warmup "${WARMUP}" \
		--runs "${RUNS}" \
		--export-json "${RESULT_DIR}/${name}.json" \
		--export-markdown "${RESULT_DIR}/${name}.md" \
		--command-name "fast (compiled cold spawn-per-request)" \
		"${ROOT_DIR}/bin/pi-tool-request-loop spawn fast ${name} ${iterations}" \
		--command-name "fast (compiled warm daemon + native helpers)" \
		"${ROOT_DIR}/bin/pi-tool-request-loop daemon fast ${name} ${iterations}"
}

printf 'Running persistent tool benchmarks into %s (runs=%s warmup=%s)\n' \
	"${RESULT_DIR}" "${RUNS}" "${WARMUP}"

run_suite "read" "${READ_ITERATIONS}"
run_suite "edit" "${EDIT_ITERATIONS}"
run_suite "bash" "${BASH_ITERATIONS}"

printf 'Wrote persistent tool benchmark results to %s\n' "${RESULT_DIR}"
