#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="${HOME}/.local/bin:${PATH}"
mkdir -p "${ROOT_DIR}/bin"

build_gcc() {
	local name="$1"
	gcc \
		-O3 \
		-pipe \
		-march=native \
		-s \
		-o "${ROOT_DIR}/bin/${name}" \
		"${ROOT_DIR}/native/${name}.c"
}

build_zigcc() {
	local name="$1"
	zig cc \
		-O3 \
		-pipe \
		-march=native \
		-s \
		-o "${ROOT_DIR}/bin/${name}-zigcc" \
		"${ROOT_DIR}/native/${name}.c"
}

for name in fastdrain fastedit fastread-window fastcopy fastwrite; do
	build_gcc "${name}"
done

if command -v zig >/dev/null 2>&1; then
	for name in fastdrain fastedit fastread-window fastcopy fastwrite; do
		build_zigcc "${name}"
	done
	printf 'Built native helpers with gcc and zig cc in %s/bin\n' "${ROOT_DIR}"
else
	printf 'Built native helpers with gcc in %s/bin (zig not found; skipped zig cc variants)\n' "${ROOT_DIR}"
fi
