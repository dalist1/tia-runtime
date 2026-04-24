#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
RESULT_DIR="${RESULT_DIR:-${ROOT_DIR}/results-pi-tools-fast-burst-smoke}"
RUNS="${RUNS:-6}"
WARMUP="${WARMUP:-1}"
READ_ITERATIONS="${READ_ITERATIONS:-60}"
WRITE_ITERATIONS="${WRITE_ITERATIONS:-25}"
EDIT_ITERATIONS="${EDIT_ITERATIONS:-30}"
BASH_ITERATIONS="${BASH_ITERATIONS:-20}"

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
	local commands=(
		--command-name "fast (compiled + native helpers)"
		"${ROOT_DIR}/bin/pi-tool-override-burst fast ${name} ${iterations}"
		--command-name "fast (warm daemon + native helpers)"
		"${ROOT_DIR}/bin/pi-tool-request-loop daemon fast ${name} ${iterations}"
	)

	if [[ "${name}" != "write" && -x "${ROOT_DIR}/bin/fastread-window-zigcc" ]]; then
		commands+=(
			--command-name "fast (compiled + zigcc helpers)"
			"env TIA_FASTREAD_BIN=${ROOT_DIR}/bin/fastread-window-zigcc TIA_FASTEDIT_BIN=${ROOT_DIR}/bin/fastedit-zigcc TIA_FASTDRAIN_BIN=${ROOT_DIR}/bin/fastdrain-zigcc TIA_FASTCOPY_BIN=${ROOT_DIR}/bin/fastcopy-zigcc ${ROOT_DIR}/bin/pi-tool-override-burst fast ${name} ${iterations}"
		)
	fi

	hyperfine \
		--shell=none \
		--warmup "${WARMUP}" \
		--runs "${RUNS}" \
		--export-json "${RESULT_DIR}/${name}.json" \
		--export-markdown "${RESULT_DIR}/${name}.md" \
		"${commands[@]}"
}

printf 'Running retained fast override burst benchmarks into %s (runs=%s warmup=%s)\n' \
	"${RESULT_DIR}" "${RUNS}" "${WARMUP}"

run_suite "read" "${READ_ITERATIONS}"
run_suite "write" "${WRITE_ITERATIONS}"
run_suite "edit" "${EDIT_ITERATIONS}"
run_suite "bash" "${BASH_ITERATIONS}"

printf 'Wrote fast override burst benchmark results to %s\n' "${RESULT_DIR}"
