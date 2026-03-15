#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
RESULT_DIR="${RESULT_DIR:-${ROOT_DIR}/results-pi-tools-fast-smoke}"
RUNS="${RUNS:-8}"
WARMUP="${WARMUP:-1}"

mkdir -p "${RESULT_DIR}"

cleanup() {
	bash "${ROOT_DIR}/bench/cleanup-processes.sh" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
cleanup

bash "${ROOT_DIR}/bench/build-tool-fixtures.sh"
bash "${ROOT_DIR}/bench/build-native.sh"
bash "${ROOT_DIR}/bench/build-pi-tool-override-runner.sh"

run_suite() {
	local name="$1"
	shift

	hyperfine \
		--shell=none \
		--warmup "${WARMUP}" \
		--runs "${RUNS}" \
		--export-json "${RESULT_DIR}/${name}.json" \
		--export-markdown "${RESULT_DIR}/${name}.md" \
		--command-name "stock" \
		"${ROOT_DIR}/bench/run-pi-tool-override.sh stock $*" \
		--command-name "fast" \
		"${ROOT_DIR}/bench/run-pi-tool-override.sh fast $*"
}

printf 'Running fast override tool benchmarks into %s (runs=%s warmup=%s)\n' \
	"${RESULT_DIR}" "${RUNS}" "${WARMUP}"

run_suite "read" read "${ROOT_DIR}/payloads/jsonl-5m.txt"
run_suite "write" write "${ROOT_DIR}/payloads/blob-1m.txt"
run_suite "edit" edit "${ROOT_DIR}/payloads/lines-10k.txt" "${ROOT_DIR}/payloads/edit-old.txt" "${ROOT_DIR}/payloads/edit-new.txt"
run_suite "bash" bash

printf 'Wrote fast override tool benchmark results to %s\n' "${RESULT_DIR}"
