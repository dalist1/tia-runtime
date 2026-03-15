#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
RESULT_DIR="${RESULT_DIR:-${ROOT_DIR}/results-pi-tools-smoke}"
RUNS="${RUNS:-8}"
WARMUP="${WARMUP:-1}"
NODE_BIN="${NODE_BIN:-$(command -v node 2>/dev/null || true)}"
PI_PACKAGE_DIR_ENV="/home/frensiqatipi1/.bun/install/global/node_modules/@mariozechner/pi-coding-agent"

mkdir -p "${RESULT_DIR}"

cleanup() {
	bash "${ROOT_DIR}/bench/cleanup-processes.sh" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
cleanup

[[ -n "${NODE_BIN}" ]] || {
	printf 'Node not found. Set NODE_BIN=/absolute/path/to/node and retry.\n' >&2
	exit 1
}

bash "${ROOT_DIR}/bench/build-tool-fixtures.sh"
bash "${ROOT_DIR}/bench/build-pi-tool-runner.sh"

run_suite() {
	local name="$1"
	local command_suffix="$2"

	hyperfine \
		--shell=none \
		--warmup "${WARMUP}" \
		--runs "${RUNS}" \
		--export-json "${RESULT_DIR}/${name}.json" \
		--export-markdown "${RESULT_DIR}/${name}.md" \
		--command-name "node tool runner" \
		"env PI_PACKAGE_DIR=${PI_PACKAGE_DIR_ENV} ${NODE_BIN} ${ROOT_DIR}/bin/pi-tool-runner.mjs ${command_suffix}" \
		--command-name "compiled tool runner" \
		"env PI_PACKAGE_DIR=${PI_PACKAGE_DIR_ENV} ${ROOT_DIR}/bin/pi-tool-runner ${command_suffix}"
}

printf 'Running pi built-in tool benchmarks into %s (runs=%s warmup=%s)\n' \
	"${RESULT_DIR}" "${RUNS}" "${WARMUP}"

run_suite "read" "read ${ROOT_DIR}/payloads/jsonl-5m.txt"
run_suite "write" "write ${ROOT_DIR}/payloads/blob-1m.txt"
run_suite "edit" "edit ${ROOT_DIR}/payloads/lines-10k.txt ${ROOT_DIR}/payloads/edit-old.txt ${ROOT_DIR}/payloads/edit-new.txt"
run_suite "bash" "bash cat ${ROOT_DIR}/payloads/jsonl-5m.txt > /dev/null"

printf 'Wrote pi tool benchmark results to %s\n' "${RESULT_DIR}"
