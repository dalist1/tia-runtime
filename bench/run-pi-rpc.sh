#!/usr/bin/env bash

set -euo pipefail

REQUEST_FILE="${1:?missing request file}"
ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TIMEOUT_SECONDS="${PI_RPC_TIMEOUT_SECONDS:-20}"

if [[ -n "${PI_PACKAGE_DIR:-}" && -f "${PI_PACKAGE_DIR}/dist/cli.js" ]]; then
	PI_PACKAGE_DIR="${PI_PACKAGE_DIR}"
elif [[ -f "${ROOT_DIR}/node_modules/@earendil-works/pi-coding-agent/dist/cli.js" ]]; then
	PI_PACKAGE_DIR="${ROOT_DIR}/node_modules/@earendil-works/pi-coding-agent"
elif [[ -f "${HOME}/.local/share/tia/pi-package-dir.txt" ]]; then
	PI_PACKAGE_DIR="$(cat "${HOME}/.local/share/tia/pi-package-dir.txt")"
else
	printf 'Could not resolve @earendil-works/pi-coding-agent\n' >&2
	exit 1
fi
PI_CLI="${PI_PACKAGE_DIR}/dist/cli.js"
[[ -f "${PI_CLI}" ]] || { printf 'Missing pi CLI: %s\n' "${PI_CLI}" >&2; exit 1; }

export PI_SKIP_VERSION_CHECK=1
export PI_PACKAGE_DIR
unset PI_CODING_AGENT_DIR

args=(bun "${PI_CLI}" --mode rpc --no-session --no-extensions --no-skills --no-prompt-templates --no-themes)
if command -v timeout >/dev/null 2>&1; then
	exec timeout "${TIMEOUT_SECONDS}s" "${args[@]}" < "${REQUEST_FILE}"
fi
if command -v gtimeout >/dev/null 2>&1; then
	exec gtimeout "${TIMEOUT_SECONDS}s" "${args[@]}" < "${REQUEST_FILE}"
fi
exec "${args[@]}" < "${REQUEST_FILE}"
