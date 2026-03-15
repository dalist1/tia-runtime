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

copy_asset "install.sh" "tia-install.sh"
copy_asset "scripts/install-tia.sh" "tia-install-tia.sh"
copy_asset "scripts/install-fast-pi.sh" "tia-install-fast-pi.sh"
copy_asset "scripts/install-fast-pi-max.sh" "tia-install-fast-pi-max.sh"
copy_asset "scripts/TIA.md" "tia-launcher.md"
copy_asset "BENCHMARKS.md" "tia-benchmarks.md"
copy_asset "results-max-pi/rpc.md" "tia-benchmark-tia-pi-rpc.md"
copy_asset "results-pi-rpc-direct-smoke/empty.md" "tia-benchmark-pi-direct-rpc-empty.md"
copy_asset "results-pi-tools-fast-burst-smoke/read.md" "tia-benchmark-tia-pi-fast-read.md"
copy_asset "results-pi-tools-fast-burst-smoke/write.md" "tia-benchmark-tia-pi-fast-write.md"
copy_asset "results-pi-tools-fast-burst-smoke/edit.md" "tia-benchmark-tia-pi-fast-edit.md"
copy_asset "results-pi-tools-fast-burst-smoke/bash.md" "tia-benchmark-tia-pi-fast-bash.md"
copy_asset "results-max-opencode-startup/startup.md" "tia-benchmark-tia-opencode-startup.md"
copy_asset "results-max-opencode-helpers/cp.md" "tia-benchmark-tia-opencode-cp.md"

printf 'Staged release assets in %s\n' "${OUT_DIR}"
find "${OUT_DIR}" -maxdepth 1 -type f | sort
