#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="${HOME}/.local/bin:${PATH}"
mkdir -p "${ROOT_DIR}/bin"

zig_names=(fastread-window fastedit)
zigcc_names=(fastwrite fastdrain fastcopy)
helper_names=("${zig_names[@]}" "${zigcc_names[@]}")

c_source_for() {
	local name="$1"
	if [[ -f "${ROOT_DIR}/native/comparison/${name}.c" ]]; then
		printf '%s\n' "${ROOT_DIR}/native/comparison/${name}.c"
	else
		printf '%s\n' "${ROOT_DIR}/native/${name}.c"
	fi
}

build_gcc() {
	local name="$1"
	local output="${2:-${name}-gcc}"
	gcc \
		-O3 \
		-pipe \
		-march=native \
		-s \
		-o "${ROOT_DIR}/bin/${output}" \
		"$(c_source_for "${name}")"
}

build_zigcc() {
	local name="$1"
	local output="${2:-${name}}"
	zig cc \
		-O3 \
		-pipe \
		-march=native \
		-s \
		-o "${ROOT_DIR}/bin/${output}" \
		"${ROOT_DIR}/native/${name}.c"
}

build_zig() {
	local name="$1"
	zig build-exe \
		-O ReleaseFast \
		-fstrip \
		-femit-bin="${ROOT_DIR}/bin/${name}" \
		"${ROOT_DIR}/native/${name}.zig"
}

if ! command -v zig >/dev/null 2>&1; then
	printf 'zig is required to build active native helpers. Run: bun run install:zig\n' >&2
	exit 1
fi

for name in "${zig_names[@]}"; do
	build_zig "${name}"
done

for name in "${zigcc_names[@]}"; do
	build_zigcc "${name}" "${name}"
done

if command -v gcc >/dev/null 2>&1; then
	for name in "${helper_names[@]}"; do
		build_gcc "${name}" "${name}-gcc"
	done
	printf 'Built active native helpers with pure Zig read/edit, zig cc C helpers, and gcc comparison binaries in %s/bin\n' "${ROOT_DIR}"
else
	printf 'Built active native helpers with pure Zig read/edit and zig cc C helpers in %s/bin (gcc not found; skipped gcc comparison binaries)\n' "${ROOT_DIR}"
fi
