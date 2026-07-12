#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
RESULT_DIR="${RESULT_DIR:-${ROOT_DIR}/results-tia-json-stream}"
RUNS="${RUNS:-10}"
WARMUP="${WARMUP:-2}"

command -v tia >/dev/null 2>&1 || {
	printf 'Error: tia is not installed. Run: bash install.sh tia install\n' >&2
	exit 1
}
command -v hyperfine >/dev/null 2>&1 || {
	printf 'Error: hyperfine is required for this benchmark.\n' >&2
	exit 1
}

mkdir -p "${RESULT_DIR}"
OPTIMIZATION_VERSION="$(tr -d '[:space:]' < "${ROOT_DIR}/OPTIMIZATION_VERSION" 2>/dev/null || printf 'unversioned')"
PI_PACKAGE_DIR_FILE="${HOME}/.local/share/tia/pi-package-dir.txt"
PI_VERSION="unknown"
if [[ -f "${PI_PACKAGE_DIR_FILE}" ]]; then
	PI_PACKAGE_DIR="$(cat "${PI_PACKAGE_DIR_FILE}")"
	if [[ -f "${PI_PACKAGE_DIR}/package.json" ]]; then
		PI_VERSION="$(bun -e 'console.log(require(process.argv[1]).version ?? "unknown")' "${PI_PACKAGE_DIR}/package.json")"
	fi
fi
cat > "${RESULT_DIR}/benchmark-info.json" <<EOF
{
  "suite": "tia-json-stream",
  "optimizationVersion": "${OPTIMIZATION_VERSION}",
  "piVersion": "${PI_VERSION}",
  "dateUtc": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "runs": ${RUNS},
  "warmup": ${WARMUP}
}
EOF

# No prompt is sent: this isolates local JSON streaming startup/runner overhead,
# not provider first-token latency. A dummy key keeps model resolution deterministic.
hyperfine \
	--shell=none \
	--warmup "${WARMUP}" \
	--runs "${RUNS}" \
	--ignore-failure \
	--export-json "${RESULT_DIR}/startup.json" \
	--export-markdown "${RESULT_DIR}/startup.md" \
	--command-name 'tia slim json stream startup' \
	"env ANTHROPIC_API_KEY=dummy $(command -v tia) pi --mode json --no-session" \
	--command-name 'tia full json startup (baseline)' \
	"env TIA_DISABLE_FAST_STREAM=1 ANTHROPIC_API_KEY=dummy $(command -v tia) pi --mode json --no-session"

printf 'Wrote slim JSON stream startup benchmark results to %s\n' "${RESULT_DIR}"
