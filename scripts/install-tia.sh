#!/usr/bin/env bash
set -euo pipefail
umask 077

TIA_VERSION="0.7.0"
TIA_OPTIMIZATION_VERSION="${TIA_OPTIMIZATION_VERSION:-2026-09-atomic-runtime-v1}"
ACTION="${1:-install}"
[[ "$#" -le 1 ]] || { echo 'Unsupported installer arguments' >&2; exit 1; }
TIA_ROOT="${TIA_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/tia}"
TIA_CMD_PATH="${XDG_BIN_HOME:-$HOME/.local/bin}/tia"
INSTALL_BASE_URL="${INSTALL_BASE_URL:-https://raw.githubusercontent.com/dalist1/tia-runtime/main/scripts}"

case "$ACTION" in
 -h|--help|help)
  cat <<'EOF'
Usage: install-tia.sh {install|status|verify|generations|rollback|recover|prune|uninstall}

Install builds a private, self-contained generation, seals it read-only,
validates full/slim/tools/FFF through its launcher, then activates it with one
atomic pointer replacement and re-verifies through the stable launcher. Old
generations and user state are retained. rollback atomically selects the
previous activation. uninstall deactivates the runtime without deleting
generations, sessions or the launcher. prune lists removable generations;
tia prune --apply deletes those no running process uses. A corrupt pointer is
never guessed: tia recover names verified activations for tia select <id>.

Controls: TIA_PI_PACKAGE_VERSION, TIA_FFF_SOURCE=vanilla|fork,
TIA_FFF_PACKAGE_VERSION, TIA_ENABLE_FFF=0|1, TIA_PI_BYTECODE=0|1 (default 1),
TIA_DISABLE_LAZY_JITI=0|1, TIA_PRESERVE_FAST_TOOLS=0|1,
TIA_REQUIRE_FAST_HELPERS=0|1, TIA_ROOT, XDG_BIN_HOME, XDG_DATA_HOME.
An unrecognized existing fast-tools.ts requires TIA_PRESERVE_FAST_TOOLS=1 (keep)
or TIA_PRESERVE_FAST_TOOLS=0 (replace in the new generation).
PI_PACKAGE_DIR selects a registry version, not mutable local source/dependencies.
Global packages are never updated. Linux with flock and fsync is required.
EOF
  exit 0 ;;
 status)
  if [[ -x "$TIA_CMD_PATH" ]]; then exec "$TIA_CMD_PATH" status; fi
  echo 'tia-runtime installed: no'; exit 0 ;;
 rollback|verify|generations|recover|prune|uninstall)
  [[ -x "$TIA_CMD_PATH" ]] || { echo 'No TIA launcher installed' >&2; exit 1; }
  exec "$TIA_CMD_PATH" "$ACTION" ;;
 install) ;;
 *) echo "Unsupported installer action: $ACTION" >&2; exit 1 ;;
esac

[[ "$(uname -s)" == Linux ]] || { echo 'Atomic generations currently require validated Linux filesystem semantics' >&2; exit 1; }
for command in bun flock setsid; do command -v "$command" >/dev/null || { echo "Missing required command: $command" >&2; exit 1; }; done
mkdir -p "$TIA_ROOT"
[[ ! -L "$TIA_ROOT/.upgrade.lock" ]] || { echo 'Upgrade lock cannot be a symlink' >&2; exit 1; }
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" && pwd)"
bootstrap="$source_dir/runtime-bootstrap.ts"
if [[ ! -f "$bootstrap" ]]; then
 command -v curl >/dev/null || { echo 'curl is required for bootstrap installation' >&2; exit 1; }
 bootstrap="$work/runtime-bootstrap.ts"
 curl --fail --silent --show-error --connect-timeout 10 --max-time 30 "$INSTALL_BASE_URL/runtime-bootstrap.ts" > "$bootstrap"
fi
export INSTALL_BASE_URL TIA_INSTALLER_VERSION="$TIA_VERSION"
export PI_TELEMETRY=0 PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 DO_NOT_TRACK=1 BUN_DISABLE_TELEMETRY=1
# The transaction runs in its own session so every package/build/smoke child can be reaped with it.
setsid flock --nonblock --no-fork "$TIA_ROOT/.upgrade.lock" bun "$bootstrap" install "$TIA_ROOT" "$TIA_CMD_PATH" "$work/assets" &
transaction=$!
trap 'kill -TERM -- "-$transaction" 2>/dev/null || true' INT TERM HUP
status=0
wait "$transaction" || status=$?
kill -KILL -- "-$transaction" 2>/dev/null || true
[[ "$status" == 0 ]] || echo "Install stopped (exit $status). The previous selection is unchanged unless a COMMITTED message was printed; run tia status or tia verify." >&2
exit "$status"
