#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
RESULT_DIR="${RESULT_DIR:-${ROOT_DIR}/results-pi-tools-fast-stream-smoke}"
RUN_DATE_UTC="${RUN_DATE_UTC:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
RUNS="${RUNS:-6}"
WARMUP="${WARMUP:-1}"
READ_ITERATIONS="${READ_ITERATIONS:-60}"

mkdir -p "${RESULT_DIR}"
cat > "${RESULT_DIR}/benchmark-info.json" <<EOF
{
  "suite": "pi-tools-fast-stream",
  "dateUtc": "${RUN_DATE_UTC}",
  "rootDir": "${ROOT_DIR}",
  "runs": ${RUNS},
  "warmup": ${WARMUP},
  "iterations": {
    "read": ${READ_ITERATIONS}
  },
  "activeHelpers": "pure Zig read/edit, zig cc C write/copy/drain",
  "comparisonHelpers": "gcc"
}
EOF
cat > "${RESULT_DIR}/README.md" <<EOF
# pi tools fast stream benchmark

Date (UTC): ${RUN_DATE_UTC}

Active read helper: pure Zig. GCC read helper is comparison-only.
EOF

cleanup() {
	bash "${ROOT_DIR}/bench/cleanup-processes.sh" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
cleanup

bash "${ROOT_DIR}/bench/build-tool-fixtures.sh"
bash "${ROOT_DIR}/bench/build-native.sh"
bash "${ROOT_DIR}/bench/build-pi-tool-override-burst.sh"

commands=(
	--command-name "fast (compiled + native helpers)"
	"${ROOT_DIR}/bin/pi-tool-override-stream-burst fast read ${READ_ITERATIONS}"
)

if [[ -x "${ROOT_DIR}/bin/fastread-window-gcc" ]]; then
	commands+=(
		--command-name "fast (compiled + gcc comparison read helper)"
		"env TIA_FASTREAD_BIN=${ROOT_DIR}/bin/fastread-window-gcc ${ROOT_DIR}/bin/pi-tool-override-stream-burst fast read ${READ_ITERATIONS}"
	)
fi

hyperfine \
	--shell=none \
	--warmup "${WARMUP}" \
	--runs "${RUNS}" \
	--export-json "${RESULT_DIR}/read.json" \
	--export-markdown "${RESULT_DIR}/read.md" \
	"${commands[@]}"

printf 'Wrote retained fast override streaming benchmark results to %s (date=%s)\n' "${RESULT_DIR}" "${RUN_DATE_UTC}"
