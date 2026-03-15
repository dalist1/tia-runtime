#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

gcc \
	-O3 \
	-pipe \
	-march=native \
	-s \
	-o "${ROOT_DIR}/bin/fastdrain" \
	"${ROOT_DIR}/native/fastdrain.c"

printf 'Built %s\n' "${ROOT_DIR}/bin/fastdrain"
