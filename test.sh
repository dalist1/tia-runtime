#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TMP_DIR="$(mktemp -d)"
cleanup() {
	rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

printf '[1/9] install tia runtime\n'
bash "${ROOT_DIR}/install.sh" >/dev/null

printf '[2/9] check tia status\n'
tia status > "${TMP_DIR}/tia-status.txt"
rg -n "tia installed: yes|pi package:|opencode|max alias ok:" "${TMP_DIR}/tia-status.txt" >/dev/null

printf '[3/9] verify legacy max alias\n'
max status > "${TMP_DIR}/max-status.txt"
rg -n "tia root:|tia pi bin:|pi package:" "${TMP_DIR}/max-status.txt" >/dev/null

printf '[4/9] verify tia pi rpc\n'
timeout 25s tia pi --mode rpc --no-session --no-skills --no-prompt-templates --no-themes \
	< "${ROOT_DIR}/payloads-rpc/empty.get-state.jsonl" > "${TMP_DIR}/tia-pi-rpc.jsonl"
python3 - <<'PY' "${TMP_DIR}/tia-pi-rpc.jsonl"
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    line = f.readline().strip()
obj = json.loads(line)
assert obj['type'] == 'response'
assert obj['command'] == 'get_state'
assert obj['success'] is True
PY

printf '[5/9] verify installer bootstrap path\n'
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
	bash -s -- tia install > "${TMP_DIR}/bootstrap-install.txt"
)
HOME="${BOOTSTRAP_HOME}" \
XDG_BIN_HOME="${BOOTSTRAP_BIN_HOME}" \
XDG_DATA_HOME="${BOOTSTRAP_DATA_HOME}" \
"${BOOTSTRAP_BIN_HOME}/tia" status > "${TMP_DIR}/bootstrap-status.txt"
rg -n "tia installed: yes|pi package:|max alias ok:" "${TMP_DIR}/bootstrap-status.txt" >/dev/null
[[ -x "${BOOTSTRAP_BIN_HOME}/max" ]]

printf '[6/9] verify pi installers\n'
bash "${ROOT_DIR}/install.sh" fast-pi status >/dev/null
bash "${ROOT_DIR}/install.sh" fast-pi-max status >/dev/null

printf '[7/9] verify fast tool runners\n'
bash "${ROOT_DIR}/bench/build-tool-fixtures.sh" >/dev/null
bun "${ROOT_DIR}/bench/pi-tool-override-burst.ts" stock read 2 >/dev/null
bun "${ROOT_DIR}/bench/pi-tool-override-burst.ts" fast read 2 >/dev/null
bun "${ROOT_DIR}/bench/pi-tool-override-burst.ts" stock edit 2 >/dev/null
bun "${ROOT_DIR}/bench/pi-tool-override-burst.ts" fast edit 2 >/dev/null
bun "${ROOT_DIR}/bench/pi-tool-override-burst.ts" stock bash 1 >/dev/null
bun "${ROOT_DIR}/bench/pi-tool-override-burst.ts" fast bash 1 >/dev/null

printf '[8/9] verify tia opencode\n'
if command -v opencode >/dev/null 2>&1; then
	tia opencode --version > "${TMP_DIR}/tia-opencode-version.txt"
	rg -n "0\.0\.0|[0-9]+\.[0-9]+" "${TMP_DIR}/tia-opencode-version.txt" >/dev/null
fi

printf '[9/9] cleanup benchmark processes\n'
bash "${ROOT_DIR}/bench/cleanup-processes.sh" >/dev/null

printf 'All tests passed.\n'
