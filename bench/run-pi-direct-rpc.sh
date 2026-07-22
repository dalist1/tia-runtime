#!/usr/bin/env bash

set -euo pipefail

REQUEST_FILE="${1:?missing request file}"
ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TIMEOUT_SECONDS="${PI_RPC_TIMEOUT_SECONDS:-20}"
BINARY="${ROOT_DIR}/bin/pi-rpc-direct"

export PI_SKIP_VERSION_CHECK=1
if [[ -z "${PI_PACKAGE_DIR:-}" ]]; then
	if [[ -f "${ROOT_DIR}/node_modules/@earendil-works/pi-coding-agent/package.json" ]]; then
		export PI_PACKAGE_DIR="${ROOT_DIR}/node_modules/@earendil-works/pi-coding-agent"
	elif [[ -f "${HOME}/.local/share/tia/pi-package-dir.txt" ]]; then
		export PI_PACKAGE_DIR="$(cat "${HOME}/.local/share/tia/pi-package-dir.txt")"
	else
		printf 'Could not resolve @earendil-works/pi-coding-agent\n' >&2
		exit 1
	fi
fi

if [[ ! -x "${BINARY}" || "${ROOT_DIR}/bench/pi-rpc-direct.ts" -nt "${BINARY}" ]]; then
	bash "${ROOT_DIR}/bench/build-pi-rpc-direct.sh" >/dev/null
fi

if command -v timeout >/dev/null 2>&1; then
	exec timeout "${TIMEOUT_SECONDS}s" "${BINARY}" < "${REQUEST_FILE}"
fi
if command -v gtimeout >/dev/null 2>&1; then
	exec gtimeout "${TIMEOUT_SECONDS}s" "${BINARY}" < "${REQUEST_FILE}"
fi
exec "${BINARY}" < "${REQUEST_FILE}"
