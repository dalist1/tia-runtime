#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
RESULT_DIR="${RESULT_DIR:-${ROOT_DIR}/results-pi-rpc-direct-smoke}"
RPC_PAYLOAD_DIR="${ROOT_DIR}/payloads-rpc"
RUNS="${RUNS:-5}"
WARMUP="${WARMUP:-1}"
PAYLOAD_NAMES="${PAYLOAD_NAMES:-tiny lines-10k blob-1m jsonl-5m}"

mkdir -p "${RESULT_DIR}" "${RPC_PAYLOAD_DIR}"

cleanup() {
	bash "${ROOT_DIR}/bench/cleanup-processes.sh" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
cleanup

bash "${ROOT_DIR}/bench/build-pi-rpc-payloads.sh"
bash "${ROOT_DIR}/bench/build-pi-rpc-direct.sh"

run_suite() {
	local label="$1"
	local request_file="$2"

	hyperfine \
		--shell=none \
		--warmup "${WARMUP}" \
		--runs "${RUNS}" \
		--export-json "${RESULT_DIR}/${label}.json" \
		--export-markdown "${RESULT_DIR}/${label}.md" \
		--command-name "pi cli rpc" \
		"${ROOT_DIR}/bench/run-pi-rpc.sh ${request_file}" \
		--command-name "pi direct rpc (compiled)" \
		"${ROOT_DIR}/bench/run-pi-direct-rpc.sh ${request_file}"
}

printf 'Running pi RPC direct benchmark set into %s (runs=%s warmup=%s payloads=%s)\n' \
	"${RESULT_DIR}" "${RUNS}" "${WARMUP}" "${PAYLOAD_NAMES}"

run_suite "empty" "${RPC_PAYLOAD_DIR}/empty.get-state.jsonl"

for name in ${PAYLOAD_NAMES}; do
	case "${name}" in
		tiny|lines-10k|blob-1m|jsonl-5m)
			run_suite "${name}" "${RPC_PAYLOAD_DIR}/${name}.get-state.jsonl"
			;;
		*)
			printf 'Unsupported payload name: %s\n' "${name}" >&2
			exit 1
			;;
	esac
done

printf 'Wrote pi RPC direct benchmark results to %s\n' "${RESULT_DIR}"
