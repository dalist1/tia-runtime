#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
RESULT_DIR="${RESULT_DIR:-${ROOT_DIR}/results-tia-pi}"
RPC_PAYLOAD_DIR="${ROOT_DIR}/payloads-rpc"
RUNS="${RUNS:-6}"
WARMUP="${WARMUP:-1}"
REQUEST_FILE="${REQUEST_FILE:-${RPC_PAYLOAD_DIR}/empty.get-state.jsonl}"

mkdir -p "${RESULT_DIR}" "${RPC_PAYLOAD_DIR}"
bash "${ROOT_DIR}/bench/build-pi-rpc-payloads.sh" >/dev/null

hyperfine \
	--runs "${RUNS}" \
	--warmup "${WARMUP}" \
	--export-json "${RESULT_DIR}/rpc.json" \
	--export-markdown "${RESULT_DIR}/rpc.md" \
	--command-name "pi original rpc" \
	"env -u PI_PACKAGE_DIR -u PI_CODING_AGENT_DIR ANTHROPIC_API_KEY=dummy pi-node --mode rpc --no-session --no-extensions --no-skills --no-prompt-templates --no-themes < ${REQUEST_FILE}" \
	--command-name "tia pi rpc" \
	"env -u PI_PACKAGE_DIR ANTHROPIC_API_KEY=dummy tia pi --mode rpc --no-session --no-skills --no-prompt-templates --no-themes < ${REQUEST_FILE}"

printf 'Wrote tia pi benchmarks to %s\n' "${RESULT_DIR}"
