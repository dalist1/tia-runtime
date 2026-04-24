#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "${ROOT_DIR}/bin"

gcc \
	-O3 \
	-pipe \
	-march=native \
	-s \
	-o "${ROOT_DIR}/bin/fastdrain" \
	"${ROOT_DIR}/native/fastdrain.c"

gcc \
	-O3 \
	-pipe \
	-march=native \
	-s \
	-o "${ROOT_DIR}/bin/fastedit" \
	"${ROOT_DIR}/native/fastedit.c"

gcc \
	-O3 \
	-pipe \
	-march=native \
	-s \
	-o "${ROOT_DIR}/bin/fastread-window" \
	"${ROOT_DIR}/native/fastread-window.c"

gcc \
	-O3 \
	-pipe \
	-march=native \
	-s \
	-o "${ROOT_DIR}/bin/fastcopy" \
	"${ROOT_DIR}/native/fastcopy.c"

printf 'Built %s, %s, %s, and %s\n' \
	"${ROOT_DIR}/bin/fastdrain" \
	"${ROOT_DIR}/bin/fastedit" \
	"${ROOT_DIR}/bin/fastread-window" \
	"${ROOT_DIR}/bin/fastcopy"
