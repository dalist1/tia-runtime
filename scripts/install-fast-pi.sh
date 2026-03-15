#!/usr/bin/env bash

set -euo pipefail

ACTION="${1:-install}"
PACKAGE_NAME="@mariozechner/pi-coding-agent"
COMPILED_NAME="pi-compiled"
ORIGINAL_NAME="pi-original"
LEGACY_ORIGINAL_NAME="pi-node"
EXPECTED_THEME_TARGET="dist/modes/interactive/theme"
EXPECTED_EXPORT_TARGET="dist/core/export-html"

usage() {
	cat <<'EOF'
Usage:
  install-fast-pi.sh install    # Compile pi and make it the default launcher
  install-fast-pi.sh uninstall  # Restore the original launcher
  install-fast-pi.sh status     # Show current install status

Requirements:
  - pi already installed and available on PATH
  - bun available on PATH
EOF
}

die() {
	printf 'Error: %s\n' "$*" >&2
	exit 1
}

need_cmd() {
	command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

realpath_py() {
	python3 - "$1" <<'PY'
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
}

is_pi_package_dir() {
	local dir="$1"
	local package_json="${dir}/package.json"
	[[ -f "${package_json}" ]] || return 1
	python3 - "${package_json}" <<'PY'
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    data = json.load(f)
raise SystemExit(0 if data.get('name') == '@mariozechner/pi-coding-agent' else 1)
PY
}

find_pi_package_dir() {
	local path="$1"
	local dir
	if [[ -d "${path}" ]]; then
		dir="${path}"
	else
		dir="$(dirname "${path}")"
	fi

	while true; do
		if is_pi_package_dir "${dir}"; then
			printf '%s\n' "${dir}"
			return 0
		fi
		if [[ "${dir}" == "/" ]]; then
			break
		fi
		dir="$(dirname "${dir}")"
	done

	return 1
}

clone_entry() {
	local src="$1"
	local dst="$2"

	if [[ -L "${src}" ]]; then
		ln -sfn "$(readlink "${src}")" "${dst}"
	else
		cp "${src}" "${dst}"
		chmod +x "${dst}"
	fi
}

ensure_backup() {
	if [[ -e "${ORIGINAL_PATH}" ]]; then
		return
	fi

	if [[ -e "${LEGACY_ORIGINAL_PATH}" ]]; then
		clone_entry "${LEGACY_ORIGINAL_PATH}" "${ORIGINAL_PATH}"
		return
	fi

	clone_entry "${PI_BIN_PATH}" "${ORIGINAL_PATH}"
}

ensure_asset_path() {
	local destination="$1"
	local relative_target="$2"

	if [[ -e "${destination}" && ! -L "${destination}" ]]; then
		return
	fi

	ln -sfn "${relative_target}" "${destination}"
}

compile_pi() {
	bun build --compile "${PACKAGE_DIR}/dist/cli.js" --outfile "${COMPILED_PATH}"
}

install_fast_pi() {
	ensure_backup
	compile_pi
	ensure_asset_path "${PACKAGE_DIR}/theme" "${EXPECTED_THEME_TARGET}"
	ensure_asset_path "${PACKAGE_DIR}/export-html" "${EXPECTED_EXPORT_TARGET}"
	ln -sfn "${COMPILED_PATH}" "${PI_BIN_PATH}"
	"${PI_BIN_PATH}" --version >/dev/null

	printf 'Installed compiled pi as the default launcher.\n'
	printf '  pi:          %s\n' "${PI_BIN_PATH}"
	printf '  pi-original: %s\n' "${ORIGINAL_PATH}"
	printf '  package dir: %s\n' "${PACKAGE_DIR}"
}

uninstall_fast_pi() {
	[[ -e "${ORIGINAL_PATH}" ]] || die "Original launcher backup not found at ${ORIGINAL_PATH}"
	clone_entry "${ORIGINAL_PATH}" "${PI_BIN_PATH}"
	"${PI_BIN_PATH}" --version >/dev/null
	printf 'Restored the original pi launcher at %s\n' "${PI_BIN_PATH}"
}

status_fast_pi() {
	local current_real
	current_real="$(realpath_py "${PI_BIN_PATH}")"
	printf 'pi path:        %s\n' "${PI_BIN_PATH}"
	printf 'pi resolved:    %s\n' "${current_real}"
	printf 'package dir:    %s\n' "${PACKAGE_DIR}"
	printf 'compiled path:  %s\n' "${COMPILED_PATH}"
	printf 'backup path:    %s\n' "${ORIGINAL_PATH}"

	if [[ -e "${COMPILED_PATH}" ]]; then
		printf 'compiled build: present\n'
	else
		printf 'compiled build: missing\n'
	fi

	if [[ -e "${ORIGINAL_PATH}" ]]; then
		printf 'backup:         present\n'
	else
		printf 'backup:         missing\n'
	fi

	if [[ "${current_real}" == "$(realpath_py "${COMPILED_PATH}")" ]]; then
		printf 'default mode:   compiled\n'
	else
		printf 'default mode:   original/custom\n'
	fi
}

need_cmd python3
need_cmd pi

PI_BIN_PATH="$(command -v pi)"
BIN_DIR="$(dirname "${PI_BIN_PATH}")"
PI_RESOLVED="$(realpath_py "${PI_BIN_PATH}")"
PACKAGE_DIR="$(find_pi_package_dir "${PI_RESOLVED}")" || die "Could not locate ${PACKAGE_NAME} package directory from ${PI_RESOLVED}"
COMPILED_PATH="${PACKAGE_DIR}/${COMPILED_NAME}"
ORIGINAL_PATH="${BIN_DIR}/${ORIGINAL_NAME}"
LEGACY_ORIGINAL_PATH="${BIN_DIR}/${LEGACY_ORIGINAL_NAME}"

case "${ACTION}" in
	install)
		need_cmd bun
		install_fast_pi
		;;
	uninstall|revert)
		uninstall_fast_pi
		;;
	status)
		status_fast_pi
		;;
	-h|--help|help)
		usage
		;;
	*)
		usage >&2
		die "Unsupported action: ${ACTION}"
		;;
esac
