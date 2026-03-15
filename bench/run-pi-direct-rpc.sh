#!/usr/bin/env bash

set -euo pipefail

REQUEST_FILE="${1:?missing request file}"
ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TIMEOUT_SECONDS="${PI_RPC_TIMEOUT_SECONDS:-20}"
BINARY="${ROOT_DIR}/bin/pi-rpc-direct"

export PI_SKIP_VERSION_CHECK=1
export PI_PACKAGE_DIR="/home/frensiqatipi1/.bun/install/global/node_modules/@mariozechner/pi-coding-agent"

if [[ ! -x "${BINARY}" || "${ROOT_DIR}/bench/pi-rpc-direct.ts" -nt "${BINARY}" ]]; then
	bash "${ROOT_DIR}/bench/build-pi-rpc-direct.sh" >/dev/null
fi

exec timeout "${TIMEOUT_SECONDS}s" \
	"${BINARY}" \
	< "${REQUEST_FILE}"
