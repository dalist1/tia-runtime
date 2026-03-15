#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "${ROOT_DIR}/bin"

bun build \
	"${ROOT_DIR}/bench/pi-tool-runner.ts" \
	--target node \
	--format esm \
	--outfile "${ROOT_DIR}/bin/pi-tool-runner.mjs"

bun build --compile \
	"${ROOT_DIR}/bench/pi-tool-runner.ts" \
	--outfile "${ROOT_DIR}/bin/pi-tool-runner"

printf 'Built %s and %s\n' "${ROOT_DIR}/bin/pi-tool-runner.mjs" "${ROOT_DIR}/bin/pi-tool-runner"
