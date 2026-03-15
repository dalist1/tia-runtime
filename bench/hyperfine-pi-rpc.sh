#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
RESULT_DIR="${RESULT_DIR:-${ROOT_DIR}/results-pi-rpc-smoke}"
RPC_PAYLOAD_DIR="${ROOT_DIR}/payloads-rpc"
RUNS="${RUNS:-6}"
WARMUP="${WARMUP:-1}"
PAYLOAD_NAMES="${PAYLOAD_NAMES:-tiny lines-10k blob-1m}"

mkdir -p "${RESULT_DIR}" "${RPC_PAYLOAD_DIR}"

cleanup() {
	bash "${ROOT_DIR}/bench/cleanup-processes.sh" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
cleanup

bash "${ROOT_DIR}/bench/build-pi-rpc-payloads.sh"

run_suite() {
	local name="$1"

	hyperfine \
		--shell=none \
		--warmup "${WARMUP}" \
		--runs "${RUNS}" \
		--export-json "${RESULT_DIR}/${name}.json" \
		--export-markdown "${RESULT_DIR}/${name}.md" \
		--command-name "pi rpc get_state (empty)" \
		"${ROOT_DIR}/bench/run-pi-rpc.sh ${RPC_PAYLOAD_DIR}/empty.get-state.jsonl" \
		--command-name "pi rpc get_state (+payload)" \
		"${ROOT_DIR}/bench/run-pi-rpc.sh ${RPC_PAYLOAD_DIR}/${name}.get-state.jsonl"
}

printf 'Running light pi RPC benchmark set into %s (runs=%s warmup=%s payloads=%s)\n' \
	"${RESULT_DIR}" "${RUNS}" "${WARMUP}" "${PAYLOAD_NAMES}"

for name in ${PAYLOAD_NAMES}; do
	case "${name}" in
		tiny|lines-10k|blob-1m|jsonl-5m)
			run_suite "${name}"
			;;
		*)
			printf 'Unsupported payload name: %s\n' "${name}" >&2
			exit 1
			;;
	esac
done

printf 'Wrote pi RPC benchmark results to %s\n' "${RESULT_DIR}"
