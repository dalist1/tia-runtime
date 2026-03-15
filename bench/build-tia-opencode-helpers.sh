#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
HELPER_DIR="${ROOT_DIR}/tia-opencode-bin"
mkdir -p "${HELPER_DIR}"

bash "${ROOT_DIR}/bench/build-native.sh"
bash "${ROOT_DIR}/bench/build-opencode-fastpath.sh"

gcc -O3 -pipe -march=native -s -o "${HELPER_DIR}/cat" "${ROOT_DIR}/native/catwrap.c"
gcc -O3 -pipe -march=native -s -o "${HELPER_DIR}/cp" "${ROOT_DIR}/native/cpwrap.c"

printf 'Built tia opencode helper wrappers in %s\n' "${HELPER_DIR}"
