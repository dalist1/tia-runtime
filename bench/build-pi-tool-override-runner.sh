#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "${ROOT_DIR}/bin"

bun build --compile \
	"${ROOT_DIR}/bench/pi-tool-override-runner.ts" \
	--outfile "${ROOT_DIR}/bin/pi-tool-override-runner"

printf 'Built %s\n' "${ROOT_DIR}/bin/pi-tool-override-runner"
