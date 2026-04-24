#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "${ROOT_DIR}/bin"

bun build --compile \
	"${ROOT_DIR}/bench/pi-tool-override-burst.ts" \
	--outfile "${ROOT_DIR}/bin/pi-tool-override-burst"

bun build --compile \
	"${ROOT_DIR}/bench/pi-tool-override-stream-burst.ts" \
	--outfile "${ROOT_DIR}/bin/pi-tool-override-stream-burst"

bun build --compile \
	"${ROOT_DIR}/bench/pi-tool-override-daemon.ts" \
	--outfile "${ROOT_DIR}/bin/pi-tool-override-daemon"

bun build --compile \
	"${ROOT_DIR}/bench/pi-tool-request-loop.ts" \
	--outfile "${ROOT_DIR}/bin/pi-tool-request-loop"

printf 'Built %s, %s, %s, and %s\n' \
	"${ROOT_DIR}/bin/pi-tool-override-burst" \
	"${ROOT_DIR}/bin/pi-tool-override-stream-burst" \
	"${ROOT_DIR}/bin/pi-tool-override-daemon" \
	"${ROOT_DIR}/bin/pi-tool-request-loop"
