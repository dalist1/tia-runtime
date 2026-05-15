#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
RESULT_DIR="${RESULT_DIR:-${ROOT_DIR}/results-pi-tools-fast-burst-smoke}"
RUN_DATE_UTC="${RUN_DATE_UTC:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
RUNS="${RUNS:-6}"
WARMUP="${WARMUP:-1}"
READ_ITERATIONS="${READ_ITERATIONS:-60}"
WRITE_ITERATIONS="${WRITE_ITERATIONS:-25}"
EDIT_ITERATIONS="${EDIT_ITERATIONS:-30}"
BASH_ITERATIONS="${BASH_ITERATIONS:-20}"

mkdir -p "${RESULT_DIR}"
cat > "${RESULT_DIR}/benchmark-info.json" <<EOF
{
  "suite": "pi-tools-fast-burst",
  "dateUtc": "${RUN_DATE_UTC}",
  "rootDir": "${ROOT_DIR}",
  "runs": ${RUNS},
  "warmup": ${WARMUP},
  "iterations": {
    "read": ${READ_ITERATIONS},
    "write": ${WRITE_ITERATIONS},
    "edit": ${EDIT_ITERATIONS},
    "bash": ${BASH_ITERATIONS}
  },
  "activeHelpers": "pure Zig read/edit, zig cc C write/copy/drain",
  "comparisonHelpers": "gcc"
}
EOF
cat > "${RESULT_DIR}/README.md" <<EOF
# pi tools fast burst benchmark

Date (UTC): ${RUN_DATE_UTC}

Active helpers: pure Zig read/edit, zig cc C write/copy/drain. GCC helpers are comparison-only.
EOF

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

	if [[ -x "${ROOT_DIR}/bin/fastread-window-gcc" && -x "${ROOT_DIR}/bin/fastedit-gcc" && -x "${ROOT_DIR}/bin/fastdrain-gcc" && -x "${ROOT_DIR}/bin/fastcopy-gcc" && -x "${ROOT_DIR}/bin/fastwrite-gcc" ]]; then
		commands+=(
			--command-name "fast (compiled + gcc comparison helpers)"
			"env TIA_FASTREAD_BIN=${ROOT_DIR}/bin/fastread-window-gcc TIA_FASTEDIT_BIN=${ROOT_DIR}/bin/fastedit-gcc TIA_FASTDRAIN_BIN=${ROOT_DIR}/bin/fastdrain-gcc TIA_FASTCOPY_BIN=${ROOT_DIR}/bin/fastcopy-gcc TIA_FASTWRITE_BIN=${ROOT_DIR}/bin/fastwrite-gcc ${ROOT_DIR}/bin/pi-tool-override-burst fast ${name} ${iterations}"
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

printf 'Running retained fast override burst benchmarks into %s (date=%s runs=%s warmup=%s)\n' \
	"${RESULT_DIR}" "${RUN_DATE_UTC}" "${RUNS}" "${WARMUP}"

run_suite "read" "${READ_ITERATIONS}"
run_suite "write" "${WRITE_ITERATIONS}"
run_suite "edit" "${EDIT_ITERATIONS}"
run_suite "bash" "${BASH_ITERATIONS}"

printf 'Wrote fast override burst benchmark results to %s\n' "${RESULT_DIR}"
