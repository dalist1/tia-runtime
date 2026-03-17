#!/usr/bin/env bash

set -euo pipefail

SOURCE_PATH="${BASH_SOURCE[0]:-$0}"
ROOT_DIR="$(cd -- "$(dirname -- "${SOURCE_PATH}")" && pwd)"
MODE="${1:-tia}"
ACTION="${2:-install}"
INSTALL_BASE_URL="${INSTALL_BASE_URL:-https://raw.githubusercontent.com/dalist1/tia/main/scripts}"

usage() {
	cat <<'EOF'
Usage:
  install.sh [tia] [install|status|uninstall]

Defaults to:
  install.sh tia install

Examples:
  bash install.sh
  bash install.sh tia install
  bash install.sh tia status

Notes:
  - tia is the only supported top-level installer target.
  - Installed tia runtime subcommands currently include `pi` and `opencode` when they are available locally.
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
		exec bash "${local_path}" "${ACTION}"
	fi

	command -v curl >/dev/null 2>&1 || {
		echo "Error: curl is required when installer scripts are not present locally." >&2
		exit 1
	}

	exec bash -c "$(curl -fsSL "${INSTALL_BASE_URL}/${script_name}")" -- "${ACTION}"
}

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
