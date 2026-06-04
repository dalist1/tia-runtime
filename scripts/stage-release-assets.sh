#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${OUT_DIR:-${ROOT_DIR}/release-assets}"

STAGE_DIR="$(mktemp -d)"
cleanup() { rm -rf "${STAGE_DIR}"; }
trap cleanup EXIT

copy_asset() {
	local kind="$1"
	local src="$2"
	local dst_name="$3"
	if [[ ! -f "${ROOT_DIR}/${src}" ]]; then
		if [[ "${kind}" == "optional" ]]; then
			printf 'Skipping missing optional asset source: %s\n' "${src}" >&2
			return 0
		fi
		printf 'Missing asset source: %s\n' "${src}" >&2
		exit 1
	fi
	cp "${ROOT_DIR}/${src}" "${STAGE_DIR}/${dst_name}"
}

copy_asset "mandatory" "install.sh" "tia-install.sh"
copy_asset "mandatory" "scripts/install-tia.sh" "tia-install-tia.sh"
copy_asset "mandatory" "scripts/TIA.md" "tia-launcher.md"
copy_asset "mandatory" "BENCHMARKS.md" "tia-benchmarks.md"
copy_asset "optional" "results-tia-pi/rpc.md" "tia-benchmark-tia-pi-rpc.md"
copy_asset "optional" "results-pi-rpc-direct-smoke/empty.md" "tia-benchmark-pi-direct-rpc-empty.md"
copy_asset "optional" "results-pi-tools-fast-burst-smoke/read.md" "tia-benchmark-tia-pi-fast-read.md"
copy_asset "optional" "results-pi-tools-fast-stream-smoke/read.md" "tia-benchmark-tia-pi-fast-read-stream.md"
copy_asset "optional" "results-pi-tools-fast-burst-smoke/write.md" "tia-benchmark-tia-pi-fast-write.md"
copy_asset "optional" "results-pi-tools-fast-burst-smoke/edit.md" "tia-benchmark-tia-pi-fast-edit.md"
copy_asset "optional" "results-pi-tools-fast-burst-smoke/bash.md" "tia-benchmark-tia-pi-fast-bash.md"

mkdir -p "${OUT_DIR}"
rm -f "${OUT_DIR}"/*
cp -a "${STAGE_DIR}"/. "${OUT_DIR}"/

printf 'Staged release assets in %s\n' "${OUT_DIR}"
find "${OUT_DIR}" -maxdepth 1 -type f | sort
