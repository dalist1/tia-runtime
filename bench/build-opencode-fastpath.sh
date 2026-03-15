#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

mkdir -p "${ROOT_DIR}/opencode-optimized/bin"

gcc \
	-O3 \
	-pipe \
	-march=native \
	-s \
	-o "${ROOT_DIR}/opencode-optimized/bin/fastcopy" \
	"${ROOT_DIR}/opencode-optimized/native/fastcopy.c"

chmod +x \
	"${ROOT_DIR}/opencode-optimized/bin/cat" \
	"${ROOT_DIR}/opencode-optimized/bin/cp"

printf 'Built optimized OpenCode fastpath helpers\n'
