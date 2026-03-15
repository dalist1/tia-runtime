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
XDG_DATA_HOME="${XDG_DATA_HOME:-${HOME}/.local/share}"
XDG_BIN_HOME="${XDG_BIN_HOME:-${HOME}/.local/bin}"
TIA_ROOT="${TIA_ROOT:-${XDG_DATA_HOME}/tia}"
LEGACY_MAX_ROOT="${MAX_ROOT:-${XDG_DATA_HOME}/max-sandbox}"
TIA_BIN_DIR="${XDG_BIN_HOME}"
TIA_CMD_PATH="${TIA_BIN_DIR}/tia"
LEGACY_MAX_CMD_PATH="${TIA_BIN_DIR}/max"
TIA_PI_BIN="${TIA_ROOT}/bin/pi"
TIA_PI_AGENT_DIR="${TIA_ROOT}/pi-agent"
TIA_EXTENSION_PATH="${TIA_PI_AGENT_DIR}/extensions/fast-tools.ts"
INSTALL_LEGACY_MAX_ALIAS="${INSTALL_LEGACY_MAX_ALIAS:-1}"
PACKAGE_NAME_PI="@mariozechner/pi-coding-agent"

usage() {
	cat <<EOF
Usage:
  install-tia.sh install
  install-tia.sh uninstall
  install-tia.sh status

Installs the tia runtime command so you can run:
  tia pi [args...]

By default it also creates a legacy `max` alias. Set INSTALL_LEGACY_MAX_ALIAS=0 to skip that.
EOF
}

die() {
	printf 'Error: %s\n' "$*" >&2
	exit 1
}

need_cmd() {
	command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

copy_or_fetch_script_asset() {
	local relative_path="$1"
	local destination="$2"
	local local_path="${ROOT_DIR}/scripts/${relative_path}"

	mkdir -p "$(dirname -- "${destination}")"

	if [[ -f "${local_path}" ]]; then
		cp "${local_path}" "${destination}"
		return 0
	fi

	[[ -n "${INSTALL_BASE_URL}" ]] || die "Could not locate scripts/${relative_path} locally. Set INSTALL_BASE_URL to a host serving the scripts directory."
	need_cmd curl
	curl -fsSL "${INSTALL_BASE_URL}/${relative_path}" > "${destination}"
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

install_pi_sandbox() {
	need_cmd bun
	need_cmd pi
	mkdir -p "$(dirname -- "${TIA_PI_BIN}")" "$(dirname -- "${TIA_EXTENSION_PATH}")"

	local pi_path pi_resolved pi_package_dir pi_bin_dir base_agent_dir
	pi_path="$(command -v pi)"
	pi_resolved="$(realpath_py "${pi_path}")"
	pi_package_dir="$(find_pi_package_dir "${pi_resolved}")" || die "Could not locate ${PACKAGE_NAME_PI} package directory"
	pi_bin_dir="$(dirname -- "${TIA_PI_BIN}")"
	base_agent_dir="${PI_CODING_AGENT_DIR:-${HOME}/.pi/agent}"

	bun build --compile "${pi_package_dir}/dist/cli.js" --outfile "${TIA_PI_BIN}"
	ln -sfn "${pi_package_dir}/dist/modes/interactive/theme" "${pi_bin_dir}/theme"
	ln -sfn "${pi_package_dir}/dist/core/export-html" "${pi_bin_dir}/export-html"
	copy_or_fetch_script_asset "fast-tools-extension.ts" "${TIA_EXTENSION_PATH}"

	if [[ -f "${base_agent_dir}/auth.json" ]]; then
		ln -sfn "${base_agent_dir}/auth.json" "${TIA_PI_AGENT_DIR}/auth.json"
	fi
	if [[ -f "${base_agent_dir}/models.json" ]]; then
		ln -sfn "${base_agent_dir}/models.json" "${TIA_PI_AGENT_DIR}/models.json"
	fi
	if [[ -f "${base_agent_dir}/settings.json" ]]; then
		ln -sfn "${base_agent_dir}/settings.json" "${TIA_PI_AGENT_DIR}/settings.json"
	fi

	printf '%s\n' "${pi_package_dir}" > "${TIA_ROOT}/pi-package-dir.txt"
}

write_tia_wrapper() {
	mkdir -p "${TIA_BIN_DIR}"
	local pi_package_dir
	pi_package_dir="$(cat "${TIA_ROOT}/pi-package-dir.txt")"

	cat > "${TIA_CMD_PATH}" <<EOF
#!/usr/bin/env bash
set -euo pipefail
TIA_ROOT="${TIA_ROOT}"
TIA_PI_BIN="${TIA_PI_BIN}"
TIA_PI_AGENT_DIR="${TIA_PI_AGENT_DIR}"
PI_PACKAGE_DIR="${pi_package_dir}"

subcommand="\${1:-}"
if [[ -z "\${subcommand}" ]]; then
  echo "Usage: tia {pi|status} [args...]" >&2
  exit 1
fi
shift || true

case "\${subcommand}" in
  pi)
    export PI_CODING_AGENT_DIR="\${TIA_PI_AGENT_DIR}"
    export PI_PACKAGE_DIR="\${PI_PACKAGE_DIR}"
    exec "\${TIA_PI_BIN}" "\$@"
    ;;
  status)
    echo "tia root:      \t\${TIA_ROOT}"
    echo "tia pi bin:    \t\${TIA_PI_BIN}"
    echo "tia pi agent:  \t\${TIA_PI_AGENT_DIR}"
    echo "pi package:    \t\${PI_PACKAGE_DIR}"
    ;;
  *)
    echo "Unknown subcommand: \t\${subcommand}" >&2
    exit 1
    ;;
esac
EOF
	chmod +x "${TIA_CMD_PATH}"
}

legacy_max_is_managed() {
	[[ -e "${LEGACY_MAX_CMD_PATH}" ]] || return 1
	if [[ -L "${LEGACY_MAX_CMD_PATH}" ]]; then
		[[ "$(realpath_py "${LEGACY_MAX_CMD_PATH}")" == "$(realpath_py "${TIA_CMD_PATH}")" ]]
		return $?
	fi
	grep -q 'Usage: max {pi|opencode|status} \[args...\]' "${LEGACY_MAX_CMD_PATH}" 2>/dev/null
}

install_legacy_max_alias() {
	if [[ "${INSTALL_LEGACY_MAX_ALIAS}" != "1" ]]; then
		return 0
	fi
	mkdir -p "${TIA_BIN_DIR}"
	if [[ -e "${LEGACY_MAX_CMD_PATH}" ]] && ! legacy_max_is_managed; then
		printf 'Note: leaving existing max command untouched at %s\n' "${LEGACY_MAX_CMD_PATH}" >&2
		return 0
	fi
	ln -sfn "tia" "${LEGACY_MAX_CMD_PATH}"
}

install_all() {
	install_pi_sandbox
	write_tia_wrapper
	install_legacy_max_alias
	printf 'Installed tia command at %s\n' "${TIA_CMD_PATH}"
	printf 'Run: tia pi\n'
	if [[ "${INSTALL_LEGACY_MAX_ALIAS}" == "1" ]]; then
		printf 'Legacy alias: %s -> tia\n' "${LEGACY_MAX_CMD_PATH}"
	fi
	if [[ ":${PATH}:" != *":${TIA_BIN_DIR}:"* ]]; then
		printf 'Note: %s is not on PATH in this shell.\n' "${TIA_BIN_DIR}" >&2
	fi
}

uninstall_all() {
	rm -f "${TIA_CMD_PATH}"
	if legacy_max_is_managed; then
		rm -f "${LEGACY_MAX_CMD_PATH}"
	fi
	rm -rf "${TIA_ROOT}"
	if [[ "${LEGACY_MAX_ROOT}" != "${TIA_ROOT}" ]]; then
		rm -rf "${LEGACY_MAX_ROOT}"
	fi
	printf 'Removed tia command and runtime assets.\n'
}

status_all() {
	printf 'tia command:   %s\n' "${TIA_CMD_PATH}"
	[[ -x "${TIA_CMD_PATH}" ]] && printf 'tia installed: yes\n' || printf 'tia installed: no\n'
	printf 'tia root:      %s\n' "${TIA_ROOT}"
	printf 'tia pi bin:    %s\n' "${TIA_PI_BIN}"
	printf 'tia ext:       %s\n' "${TIA_EXTENSION_PATH}"
	printf 'max alias:     %s\n' "${LEGACY_MAX_CMD_PATH}"
	[[ -x "${LEGACY_MAX_CMD_PATH}" ]] && printf 'max alias ok:  yes\n' || printf 'max alias ok:  no\n'
	if [[ -f "${TIA_ROOT}/pi-package-dir.txt" ]]; then
		printf 'pi package:    %s\n' "$(cat "${TIA_ROOT}/pi-package-dir.txt")"
	fi
	if [[ -d "${LEGACY_MAX_ROOT}" && "${LEGACY_MAX_ROOT}" != "${TIA_ROOT}" ]]; then
		printf 'legacy root:   %s\n' "${LEGACY_MAX_ROOT}"
	fi
}

case "${ACTION}" in
	install)
		need_cmd python3
		need_cmd bun
		need_cmd pi
		install_all
		;;
	uninstall|revert)
		uninstall_all
		;;
	status)
		status_all
		;;
	-h|--help|help)
		usage
		;;
	*)
		usage >&2
		die "Unsupported action: ${ACTION}"
		;;
esac
