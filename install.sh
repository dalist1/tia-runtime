#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
MODE="${1:-max}"
ACTION="${2:-install}"

usage() {
	cat <<'EOF'
Usage:
  install.sh [max|fast-pi|fast-pi-max] [install|status|uninstall]

Defaults to:
  install.sh max install

Examples:
  bash install.sh
  bash install.sh max install
  bash install.sh max status
  bash install.sh fast-pi install
  bash install.sh fast-pi-max uninstall
EOF
}

case "${MODE}" in
	max)
		exec bash "${ROOT_DIR}/scripts/install-max.sh" "${ACTION}"
		;;
	fast-pi)
		exec bash "${ROOT_DIR}/scripts/install-fast-pi.sh" "${ACTION}"
		;;
	fast-pi-max)
		exec bash "${ROOT_DIR}/scripts/install-fast-pi-max.sh" "${ACTION}"
		;;
	-h|--help|help)
		usage
		;;
	*)
		usage >&2
		exit 1
		;;
esac
