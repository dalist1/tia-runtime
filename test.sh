#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TMP_DIR="$(mktemp -d)"
cleanup() {
	rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

printf '[1/8] install max sandbox\n'
bash "${ROOT_DIR}/install.sh" max install >/dev/null

printf '[2/8] check max status\n'
max status > "${TMP_DIR}/max-status.txt"
rg -n "max installed: yes|pi package:|opencode" "${TMP_DIR}/max-status.txt" >/dev/null

printf '[3/8] verify max pi rpc\n'
timeout 25s max pi --mode rpc --no-session --no-skills --no-prompt-templates --no-themes \
	< "${ROOT_DIR}/payloads-rpc/empty.get-state.jsonl" > "${TMP_DIR}/max-pi-rpc.jsonl"
python3 - <<'PY' "${TMP_DIR}/max-pi-rpc.jsonl"
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    line = f.readline().strip()
obj = json.loads(line)
assert obj['type'] == 'response'
assert obj['command'] == 'get_state'
assert obj['success'] is True
PY

printf '[4/8] verify installer bootstrap path\n'
BOOTSTRAP_HOME="${TMP_DIR}/bootstrap-home"
BOOTSTRAP_BIN_HOME="${BOOTSTRAP_HOME}/bin"
BOOTSTRAP_DATA_HOME="${BOOTSTRAP_HOME}/share"
mkdir -p "${TMP_DIR}/bootstrap-cwd"
(
	cd "${TMP_DIR}/bootstrap-cwd"
	curl -fsSL "file://${ROOT_DIR}/install.sh" | \
	HOME="${BOOTSTRAP_HOME}" \
	XDG_BIN_HOME="${BOOTSTRAP_BIN_HOME}" \
	XDG_DATA_HOME="${BOOTSTRAP_DATA_HOME}" \
	INSTALL_BASE_URL="file://${ROOT_DIR}/scripts" \
	bash -s -- max install > "${TMP_DIR}/bootstrap-install.txt"
)
HOME="${BOOTSTRAP_HOME}" \
XDG_BIN_HOME="${BOOTSTRAP_BIN_HOME}" \
XDG_DATA_HOME="${BOOTSTRAP_DATA_HOME}" \
"${BOOTSTRAP_BIN_HOME}/max" status > "${TMP_DIR}/bootstrap-status.txt"
rg -n "max installed: yes|pi package:" "${TMP_DIR}/bootstrap-status.txt" >/dev/null

printf '[5/8] verify pi installers\n'
bash "${ROOT_DIR}/install.sh" fast-pi status >/dev/null
bash "${ROOT_DIR}/install.sh" fast-pi-max status >/dev/null

printf '[6/8] verify fast tool runners\n'
bash "${ROOT_DIR}/bench/build-tool-fixtures.sh" >/dev/null
bun "${ROOT_DIR}/bench/pi-tool-override-burst.ts" stock read 2 >/dev/null
bun "${ROOT_DIR}/bench/pi-tool-override-burst.ts" fast read 2 >/dev/null
bun "${ROOT_DIR}/bench/pi-tool-override-burst.ts" stock edit 2 >/dev/null
bun "${ROOT_DIR}/bench/pi-tool-override-burst.ts" fast edit 2 >/dev/null
bun "${ROOT_DIR}/bench/pi-tool-override-burst.ts" stock bash 1 >/dev/null
bun "${ROOT_DIR}/bench/pi-tool-override-burst.ts" fast bash 1 >/dev/null

printf '[7/8] verify max opencode\n'
if command -v opencode >/dev/null 2>&1; then
	max opencode --version > "${TMP_DIR}/max-opencode-version.txt"
	rg -n "0\.0\.0|[0-9]+\.[0-9]+" "${TMP_DIR}/max-opencode-version.txt" >/dev/null
fi

printf '[8/8] cleanup benchmark processes\n'
bash "${ROOT_DIR}/bench/cleanup-processes.sh" >/dev/null

printf 'All tests passed.\n'
