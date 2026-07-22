#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
RESULT_DIR="${RESULT_DIR:-${ROOT_DIR}/results-tia-loopback}"
RUNS="${RUNS:-15}"
WARMUP="${WARMUP:-3}"
TMP_DIR="$(mktemp -d)"
SERVER_PID=""

cleanup() {
	if [[ -n "${SERVER_PID}" ]]; then
		kill "${SERVER_PID}" >/dev/null 2>&1 || true
		wait "${SERVER_PID}" 2>/dev/null || true
	fi
	rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

for command_name in bun hyperfine tia; do
	command -v "${command_name}" >/dev/null 2>&1 || {
		printf 'Error: %s is required for this benchmark.\n' "${command_name}" >&2
		exit 1
	}
done

READY_FILE="${TMP_DIR}/server.port"
AGENT_DIR="${TMP_DIR}/agent"
mkdir -p "${AGENT_DIR}" "${RESULT_DIR}"
bun "${ROOT_DIR}/bench/anthropic-loopback-server.ts" "${READY_FILE}" >"${TMP_DIR}/server.log" 2>&1 &
SERVER_PID="$!"
for _ in $(seq 1 100); do
	[[ -s "${READY_FILE}" ]] && break
	kill -0 "${SERVER_PID}" 2>/dev/null || {
		cat "${TMP_DIR}/server.log" >&2
		exit 1
	}
	sleep 0.02
done
[[ -s "${READY_FILE}" ]] || {
	printf 'Error: loopback server did not become ready.\n' >&2
	exit 1
}
PORT="$(tr -d '[:space:]' < "${READY_FILE}")"
cat > "${AGENT_DIR}/models.json" <<EOF
{"providers":{"anthropic":{"baseUrl":"http://127.0.0.1:${PORT}","apiKey":"dummy"}}}
EOF

TIA_PATH="$(command -v tia)"
SLIM_COMMAND="env PI_NO_PROXY_AUTO_START=1 PI_CODING_AGENT_DIR=${AGENT_DIR} ${TIA_PATH} pi --mode json --no-session --provider anthropic --model claude-opus-4-8 loopback"
FULL_COMMAND="env TIA_DISABLE_FAST_STREAM=1 PI_NO_PROXY_AUTO_START=1 PI_CODING_AGENT_DIR=${AGENT_DIR} ${TIA_PATH} pi --mode json --no-session --provider anthropic --model claude-opus-4-8 loopback"
${SLIM_COMMAND} > "${TMP_DIR}/smoke.jsonl"
bun -e 'const lines=require("node:fs").readFileSync(process.argv[1],"utf8").trim().split(/\n+/).map(JSON.parse); if (!lines.some(event=>event.t==="d"&&event.s==="loopback ok") || !lines.some(event=>event.t==="done"&&!event.error)) process.exit(1)' "${TMP_DIR}/smoke.jsonl"

OPTIMIZATION_VERSION="$(tr -d '[:space:]' < "${ROOT_DIR}/OPTIMIZATION_VERSION" 2>/dev/null || printf 'unversioned')"
PI_PACKAGE_DIR="$(cat "${HOME}/.local/share/tia/pi-package-dir.txt")"
PI_VERSION="$(bun -e 'console.log(require(process.argv[1]).version ?? "unknown")' "${PI_PACKAGE_DIR}/package.json")"
cat > "${RESULT_DIR}/benchmark-info.json" <<EOF
{
  "suite": "tia-anthropic-loopback",
  "optimizationVersion": "${OPTIMIZATION_VERSION}",
  "piVersion": "${PI_VERSION}",
  "dateUtc": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "runs": ${RUNS},
  "warmup": ${WARMUP},
  "endpoint": "local HTTP/SSE"
}
EOF

hyperfine \
	--shell=none \
	--warmup "${WARMUP}" \
	--runs "${RUNS}" \
	--export-json "${RESULT_DIR}/loopback.json" \
	--export-markdown "${RESULT_DIR}/loopback.md" \
	--command-name 'tia slim Anthropic loopback' \
	"${SLIM_COMMAND}" \
	--command-name 'tia full Anthropic loopback (baseline)' \
	"${FULL_COMMAND}"

printf 'Wrote Anthropic loopback benchmark results to %s\n' "${RESULT_DIR}"
