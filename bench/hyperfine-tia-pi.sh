#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
RESULT_DIR="${RESULT_DIR:-${ROOT_DIR}/results-tia-pi}"
RPC_PAYLOAD_DIR="${ROOT_DIR}/payloads-rpc"
RUNS="${RUNS:-6}"
WARMUP="${WARMUP:-1}"
REQUEST_FILE="${REQUEST_FILE:-${RPC_PAYLOAD_DIR}/empty.get-state.jsonl}"

command -v tia >/dev/null 2>&1 || {
	printf 'Error: tia is not installed. Run: bash install.sh tia install\n' >&2
	exit 1
}
command -v hyperfine >/dev/null 2>&1 || {
	printf 'Error: hyperfine is required for this benchmark.\n' >&2
	exit 1
}

# Resolve a stock pi invocation that runs the SAME pi source tia compiled, so the
# comparison isolates tia's compiled/minified/sandboxed runtime, not a version gap.
# Prefer an installed node-run `pi-node`/`pi`; otherwise run dist/cli.js via bun.
STOCK_PI=""
if command -v pi-node >/dev/null 2>&1; then
	STOCK_PI="pi-node"
elif command -v pi >/dev/null 2>&1 && head -1 "$(command -v pi)" 2>/dev/null | grep -qi node; then
	STOCK_PI="pi"
else
	PI_PACKAGE_DIR_FILE="${HOME}/.local/share/tia/pi-package-dir.txt"
	if [[ -f "${PI_PACKAGE_DIR_FILE}" ]]; then
		PI_CLI="$(cat "${PI_PACKAGE_DIR_FILE}")/dist/cli.js"
		if [[ -f "${PI_CLI}" ]]; then
			STOCK_PI="$(command -v bun) ${PI_CLI}"
		fi
	fi
fi
if [[ -z "${STOCK_PI}" ]]; then
	printf 'Error: could not resolve a stock pi baseline (no pi-node/pi and no compiled tia pi package).\n' >&2
	exit 1
fi

mkdir -p "${RESULT_DIR}" "${RPC_PAYLOAD_DIR}"
bash "${ROOT_DIR}/bench/build-pi-rpc-payloads.sh" >/dev/null

hyperfine \
	--runs "${RUNS}" \
	--warmup "${WARMUP}" \
	--export-json "${RESULT_DIR}/rpc.json" \
	--export-markdown "${RESULT_DIR}/rpc.md" \
	--command-name "stock pi rpc" \
	"env -u PI_PACKAGE_DIR -u PI_CODING_AGENT_DIR -u NODE_PATH ANTHROPIC_API_KEY=dummy ${STOCK_PI} --mode rpc --no-session --no-skills --no-prompt-templates --no-themes < ${REQUEST_FILE}" \
	--command-name "tia pi rpc" \
	"env -u PI_PACKAGE_DIR ANTHROPIC_API_KEY=dummy tia pi --mode rpc --no-session --no-skills --no-prompt-templates --no-themes < ${REQUEST_FILE}"

printf 'Wrote tia pi benchmarks to %s (stock baseline: %s)\n' "${RESULT_DIR}" "${STOCK_PI}"
