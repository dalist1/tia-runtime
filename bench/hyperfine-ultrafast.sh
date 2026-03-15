#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
RESULT_DIR="${RESULT_DIR:-${ROOT_DIR}/results-ultra-smoke}"
PAYLOAD_DIR="${ROOT_DIR}/payloads"
RUNS="${RUNS:-12}"
WARMUP="${WARMUP:-2}"
DD_BLOCK_SIZE="${DD_BLOCK_SIZE:-262144}"
PAYLOAD_NAMES="${PAYLOAD_NAMES:-tiny lines-10k}"

mkdir -p "${RESULT_DIR}" "${PAYLOAD_DIR}"

cleanup() {
	bash "${ROOT_DIR}/bench/cleanup-processes.sh" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
cleanup

bash "${ROOT_DIR}/bench/build-native.sh"

run_suite() {
	local name="$1"
	local payload="$2"

	hyperfine \
		--shell=none \
		--warmup "${WARMUP}" \
		--runs "${RUNS}" \
		--export-json "${RESULT_DIR}/${name}.json" \
		--export-markdown "${RESULT_DIR}/${name}.md" \
		--command-name "native fastdrain" \
		"${ROOT_DIR}/bin/fastdrain ${payload}" \
		--command-name "dd -> /dev/null" \
		"dd if=${payload} of=/dev/null bs=${DD_BLOCK_SIZE} status=none" \
		--command-name "bash cat file" \
		"bash ${ROOT_DIR}/bench/bash-cat-file.sh ${payload}" \
		--command-name "bun file bytes" \
		"bun ${ROOT_DIR}/bench/bun-file-bytes.ts ${payload}" \
		--command-name "bun file stream" \
		"bun ${ROOT_DIR}/bench/bun-file-stream.ts ${payload}"
}

printf 'Running light ultrafast benchmark set into %s (runs=%s warmup=%s payloads=%s)\n' \
	"${RESULT_DIR}" "${RUNS}" "${WARMUP}" "${PAYLOAD_NAMES}"

for name in ${PAYLOAD_NAMES}; do
	case "${name}" in
		tiny|lines-10k|blob-1m|jsonl-5m)
			run_suite "${name}" "${PAYLOAD_DIR}/${name}.txt"
			;;
		*)
			printf 'Unsupported payload name: %s\n' "${name}" >&2
			exit 1
			;;
	esac
done

printf 'Wrote ultrafast benchmark results to %s\n' "${RESULT_DIR}"
