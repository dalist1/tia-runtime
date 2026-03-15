#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "${ROOT_DIR}/bin"

bun build --compile \
	"${ROOT_DIR}/bench/pi-rpc-direct.ts" \
	--outfile "${ROOT_DIR}/bin/pi-rpc-direct"

printf 'Built %s\n' "${ROOT_DIR}/bin/pi-rpc-direct"
