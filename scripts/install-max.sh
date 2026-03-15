#!/usr/bin/env bash

set -euo pipefail

ACTION="${1:-install}"
SOURCE_PATH="${BASH_SOURCE[0]:-$0}"
if [[ -f "${SOURCE_PATH}" ]]; then
	ROOT_DIR="$(cd -- "$(dirname -- "${SOURCE_PATH}")/.." && pwd)"
else
	ROOT_DIR="$(pwd)"
fi
INSTALL_BASE_URL="${INSTALL_BASE_URL:-https://raw.githubusercontent.com/dalist1/tia/main/scripts}"
LOCAL_TIA_SCRIPT="${ROOT_DIR}/scripts/install-tia.sh"

if [[ -f "${LOCAL_TIA_SCRIPT}" ]]; then
	exec bash "${LOCAL_TIA_SCRIPT}" "${ACTION}"
fi

command -v curl >/dev/null 2>&1 || {
	echo "Error: curl is required when install-tia.sh is not present locally." >&2
	exit 1
}

exec bash -c "$(curl -fsSL "${INSTALL_BASE_URL}/install-tia.sh")" -- "${ACTION}"
