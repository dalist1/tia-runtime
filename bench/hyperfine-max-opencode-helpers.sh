#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
RESULT_DIR="${RESULT_DIR:-${ROOT_DIR}/results-max-opencode-helpers}"
HELPER_DIR="${HELPER_DIR:-${HOME}/.local/share/tia/opencode-bin}"
RUNS="${RUNS:-6}"
WARMUP="${WARMUP:-1}"
CAT_REPS="${CAT_REPS:-30}"
CP_REPS="${CP_REPS:-20}"
COMBO_REPS="${COMBO_REPS:-15}"

mkdir -p "${RESULT_DIR}"

[[ -d "${HELPER_DIR}" ]] || {
	printf 'Helper dir not found: %s\n' "${HELPER_DIR}" >&2
	exit 1
}

run_suite() {
	local name="$1"
	local stock_cmd="$2"
	local fast_cmd="$3"

	hyperfine \
		--runs "${RUNS}" \
		--warmup "${WARMUP}" \
		--export-json "${RESULT_DIR}/${name}.json" \
		--export-markdown "${RESULT_DIR}/${name}.md" \
		--command-name "stock" \
		"${stock_cmd}" \
		--command-name "tia-opencode" \
		"${fast_cmd}"
}

run_suite \
	cat \
	"bash -lc 'for i in \$(seq 1 ${CAT_REPS}); do cat ${ROOT_DIR}/payloads/jsonl-5m.txt > /dev/null; done'" \
	"bash -lc 'PATH=${HELPER_DIR}:\$PATH; for i in \$(seq 1 ${CAT_REPS}); do cat ${ROOT_DIR}/payloads/jsonl-5m.txt > /dev/null; done'"

run_suite \
	cp \
	"bash -lc 'for i in \$(seq 1 ${CP_REPS}); do cp ${ROOT_DIR}/payloads/jsonl-5m.txt /tmp/tia-opencode-stock-\$i && rm /tmp/tia-opencode-stock-\$i; done'" \
	"bash -lc 'PATH=${HELPER_DIR}:\$PATH; for i in \$(seq 1 ${CP_REPS}); do cp ${ROOT_DIR}/payloads/jsonl-5m.txt /tmp/tia-opencode-fast-\$i && rm /tmp/tia-opencode-fast-\$i; done'"

run_suite \
	combo \
	"bash -lc 'for i in \$(seq 1 ${COMBO_REPS}); do cat ${ROOT_DIR}/payloads/jsonl-5m.txt > /dev/null && cp ${ROOT_DIR}/payloads/jsonl-5m.txt /tmp/tia-opencode-combo-stock-\$i && rm /tmp/tia-opencode-combo-stock-\$i; done'" \
	"bash -lc 'PATH=${HELPER_DIR}:\$PATH; for i in \$(seq 1 ${COMBO_REPS}); do cat ${ROOT_DIR}/payloads/jsonl-5m.txt > /dev/null && cp ${ROOT_DIR}/payloads/jsonl-5m.txt /tmp/tia-opencode-combo-fast-\$i && rm /tmp/tia-opencode-combo-fast-\$i; done'"

printf 'Wrote tia opencode helper benchmarks to %s\n' "${RESULT_DIR}"
