#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${OUT_DIR:-${ROOT_DIR}/release-assets}"

copy_asset() {
	local src="$1"
	local dst_name="$2"
	[[ -f "${ROOT_DIR}/${src}" ]] || {
		echo "Missing asset source: ${src}" >&2
		exit 1
	}
	cp "${ROOT_DIR}/${src}" "${OUT_DIR}/${dst_name}"
}

mkdir -p "${OUT_DIR}"
rm -f "${OUT_DIR}"/*

copy_asset "install.sh" "max-sandbox-install.sh"
copy_asset "scripts/install-max.sh" "max-sandbox-install-max.sh"
copy_asset "scripts/install-fast-pi.sh" "max-sandbox-install-fast-pi.sh"
copy_asset "scripts/install-fast-pi-max.sh" "max-sandbox-install-fast-pi-max.sh"
copy_asset "BENCHMARKS.md" "max-sandbox-benchmarks.md"
copy_asset "results-max-pi/rpc.md" "max-sandbox-benchmark-max-pi-rpc.md"
copy_asset "results-pi-rpc-direct-smoke/empty.md" "max-sandbox-benchmark-pi-direct-rpc-empty.md"
copy_asset "results-pi-tools-fast-burst-smoke/read.md" "max-sandbox-benchmark-pi-tools-fast-read.md"
copy_asset "results-pi-tools-fast-burst-smoke/write.md" "max-sandbox-benchmark-pi-tools-fast-write.md"
copy_asset "results-pi-tools-fast-burst-smoke/edit.md" "max-sandbox-benchmark-pi-tools-fast-edit.md"
copy_asset "results-pi-tools-fast-burst-smoke/bash.md" "max-sandbox-benchmark-pi-tools-fast-bash.md"
copy_asset "results-max-opencode-startup/startup.md" "max-sandbox-benchmark-max-opencode-startup.md"
copy_asset "results-max-opencode-helpers/cp.md" "max-sandbox-benchmark-max-opencode-cp.md"

printf 'Staged release assets in %s\n' "${OUT_DIR}"
find "${OUT_DIR}" -maxdepth 1 -type f | sort
