#!/usr/bin/env bash

set -euo pipefail

SOURCE_PATH="${BASH_SOURCE[0]:-$0}"
ROOT_DIR="$(cd -- "$(dirname -- "${SOURCE_PATH}")" && pwd)"
MODE="${1:-tia}"
ACTION="${2:-install}"
EXTRA_ARGS=()
INSTALL_BASE_URL="${INSTALL_BASE_URL:-https://raw.githubusercontent.com/dalist1/tia-runtime/main/scripts}"

usage() {
	cat <<'EOF'
Usage:
  install.sh [tia] [install|status|uninstall] [--search]

Defaults to:
  install.sh tia install

Examples:
  bash install.sh
  bash install.sh tia install
  bash install.sh tia install --search
  bash install.sh tia status

Notes:
  - tia is the only supported top-level installer target.
  - Installed tia runtime supports the `pi` subcommand.
  - Pass --search to install the native_search extension; runtime invocations do not need --search.
  - If the repo is cloned locally, this script delegates to ./scripts/* directly.
  - If run via curl, set INSTALL_BASE_URL on the bash side of the pipeline to a
    location serving the scripts/ directory if the default raw GitHub URL is not
    reachable in your environment.
EOF
}

delegate() {
	local script_name="$1"
	local local_path="${ROOT_DIR}/scripts/${script_name}"

	if [[ -f "${local_path}" ]]; then
		exec bash "${local_path}" "${ACTION}" "${EXTRA_ARGS[@]}"
	fi

	command -v curl >/dev/null 2>&1 || {
		echo "Error: curl is required when installer scripts are not present locally." >&2
		exit 1
	}

	exec bash -c "$(curl -fsSL "${INSTALL_BASE_URL}/${script_name}")" -- "${ACTION}" "${EXTRA_ARGS[@]}"
}

case "${MODE}" in
	-h|--help|help)
		usage
		exit 0
		;;
esac

if [[ "${MODE}" == "--search" || "${MODE}" == "--no-search" ]]; then
	EXTRA_ARGS=("$@")
	MODE="tia"
	ACTION="install"
elif [[ "${MODE}" == "tia" ]]; then
	if [[ "${2:-}" == --* ]]; then
		ACTION="install"
		EXTRA_ARGS=("${@:2}")
	else
		ACTION="${2:-install}"
		if [[ "$#" -ge 3 ]]; then
			EXTRA_ARGS=("${@:3}")
		fi
	fi
fi

case "${MODE}" in
	tia)
		delegate "install-tia.sh"
		;;
	fast-pi|fast-pi-max|max)
		echo "Error: ${MODE} is no longer supported. Use 'bash install.sh tia ${ACTION}' instead." >&2
		exit 1
		;;
	-h|--help|help)
		usage
		;;
	*)
		usage >&2
		exit 1
		;;
esac
