#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
RESULT_DIR="${RESULT_DIR:-${ROOT_DIR}/results-smoke}"
PAYLOAD_DIR="${ROOT_DIR}/payloads"
RUNS="${RUNS:-8}"
WARMUP="${WARMUP:-1}"
PAYLOAD_NAMES="${PAYLOAD_NAMES:-tiny lines-10k}"

mkdir -p "${RESULT_DIR}" "${PAYLOAD_DIR}"

cleanup() {
	bash "${ROOT_DIR}/bench/cleanup-processes.sh" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
cleanup

python3 - <<'PY'
from pathlib import Path

payload_dir = Path("/home/frensiqatipi1/bun-stdin-bench/payloads")
payload_dir.mkdir(parents=True, exist_ok=True)

(payload_dir / "tiny.txt").write_text("hello stdin\n", encoding="utf-8")
(payload_dir / "lines-10k.txt").write_text("".join(f"line-{i}\n" for i in range(10000)), encoding="utf-8")
(payload_dir / "blob-1m.txt").write_text("x" * (1024 * 1024), encoding="utf-8")
(payload_dir / "jsonl-5m.txt").write_text(
    "".join(
        '{"id":%d,"name":"item-%d","active":true,"tags":["a","b","c"]}\n' % (i, i)
        for i in range(75000)
    ),
    encoding="utf-8",
)
PY

run_suite() {
	local name="$1"
	local payload="$2"

	hyperfine \
		--warmup "${WARMUP}" \
		--runs "${RUNS}" \
		--export-json "${RESULT_DIR}/${name}.json" \
		--export-markdown "${RESULT_DIR}/${name}.md" \
		--command-name "bash cat >/dev/null" \
		"bash \"${ROOT_DIR}/bench/run-target.sh\" bash-dev-null \"${payload}\"" \
		--command-name "bash wc -l" \
		"bash \"${ROOT_DIR}/bench/run-target.sh\" bash-count-lines \"${payload}\"" \
		--command-name "bun console lines" \
		"bash \"${ROOT_DIR}/bench/run-target.sh\" bun-console-lines \"${payload}\"" \
		--command-name "bun stdin stream" \
		"bash \"${ROOT_DIR}/bench/run-target.sh\" bun-stream-bytes \"${payload}\"" \
		--command-name "bun Response.text" \
		"bash \"${ROOT_DIR}/bench/run-target.sh\" bun-response-text \"${payload}\""
}

printf 'Running light stdin benchmark set into %s (runs=%s warmup=%s payloads=%s)\n' \
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

printf 'Wrote results to %s\n' "${RESULT_DIR}"
