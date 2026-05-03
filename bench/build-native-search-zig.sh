#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="${HOME}/.local/bin:${PATH}"
mkdir -p "${ROOT_DIR}/bin"

if ! command -v zig >/dev/null 2>&1; then
  bash "${ROOT_DIR}/scripts/install-zig.sh" >/dev/null
fi

build_one() {
  local src="$1"
  local out="$2"
  zig build-exe \
    -O ReleaseFast \
    -fsingle-threaded \
    -fstrip \
    --cache-dir "${ROOT_DIR}/zig-cache" \
    --global-cache-dir "${HOME}/.cache/zig" \
    "${src}" \
    -femit-bin="${out}"
  printf 'Built %s\n' "${out}"
}

build_one "${ROOT_DIR}/scripts/native-search-extension/native-search.zig" "${ROOT_DIR}/bin/native-search-zig"
