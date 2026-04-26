#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TMP_DIR="$(mktemp -d)"
HOST_PI_PACKAGE_DIR="${HOME}/.bun/install/global/node_modules/@mariozechner/pi-coding-agent"
TIMEOUT_BIN=""
if command -v timeout >/dev/null 2>&1; then
	TIMEOUT_BIN="timeout"
elif command -v gtimeout >/dev/null 2>&1; then
	TIMEOUT_BIN="gtimeout"
fi
run_with_optional_timeout() {
	if [[ -n "${TIMEOUT_BIN}" ]]; then
		"${TIMEOUT_BIN}" 25s "$@"
	else
		"$@"
	fi
}
cleanup() {
	rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

printf '[1/10] install tia runtime\n'
TIA_ENABLE_FFF=0 bash "${ROOT_DIR}/install.sh" >/dev/null

printf '[2/10] check tia status\n'
tia status > "${TMP_DIR}/tia-status.txt"
rg -n "tia-runtime installed:[[:space:]]+yes|tia stream:[[:space:]]+|pi package:[[:space:]]+|cliproxy auto-start:[[:space:]]+enabled" "${TMP_DIR}/tia-status.txt" >/dev/null
! rg -n "opencode" "${TMP_DIR}/tia-status.txt" >/dev/null

printf '[3/10] verify tia refreshes shell pi agent links at launch\n'
CUSTOM_AGENT_DIR="${TMP_DIR}/custom-agent"
mkdir -p "${CUSTOM_AGENT_DIR}"
printf '%s\n' '{"source":"custom"}' > "${CUSTOM_AGENT_DIR}/auth.json"
printf '%s\n' '{"source":"custom"}' > "${CUSTOM_AGENT_DIR}/models.json"
printf '%s\n' '{"source":"custom"}' > "${CUSTOM_AGENT_DIR}/settings.json"
PI_CODING_AGENT_DIR="${CUSTOM_AGENT_DIR}" tia pi --version >/dev/null
[[ "$(readlink "${HOME}/.local/share/tia/pi-agent/auth.json")" == "${CUSTOM_AGENT_DIR}/auth.json" ]]
[[ "$(readlink "${HOME}/.local/share/tia/pi-agent/models.json")" == "${CUSTOM_AGENT_DIR}/models.json" ]]
[[ "$(readlink "${HOME}/.local/share/tia/pi-agent/settings.json")" == "${CUSTOM_AGENT_DIR}/settings.json" ]]
if [[ -f "${HOME}/.pi/agent/auth.json" && -f "${HOME}/.pi/agent/models.json" && -f "${HOME}/.pi/agent/settings.json" ]]; then
	PI_CODING_AGENT_DIR="${HOME}/.local/share/tia/pi-agent" tia pi --version >/dev/null
	[[ "$(readlink "${HOME}/.local/share/tia/pi-agent/auth.json")" == "${HOME}/.pi/agent/auth.json" ]]
	[[ "$(readlink "${HOME}/.local/share/tia/pi-agent/models.json")" == "${HOME}/.pi/agent/models.json" ]]
	[[ "$(readlink "${HOME}/.local/share/tia/pi-agent/settings.json")" == "${HOME}/.pi/agent/settings.json" ]]
fi

printf '[4/10] verify concurrent tia pi launches refresh shell pi agent links safely\n'
concurrent_pids=""
for i in 1 2 3 4 5; do
	PI_CODING_AGENT_DIR="${CUSTOM_AGENT_DIR}" tia pi --version >"${TMP_DIR}/tia-concurrent-${i}.out" 2>"${TMP_DIR}/tia-concurrent-${i}.err" &
	concurrent_pids="${concurrent_pids} $!"
done
for pid in ${concurrent_pids}; do
	wait "${pid}"
done
[[ "$(readlink "${HOME}/.local/share/tia/pi-agent/auth.json")" == "${CUSTOM_AGENT_DIR}/auth.json" ]]
[[ "$(readlink "${HOME}/.local/share/tia/pi-agent/models.json")" == "${CUSTOM_AGENT_DIR}/models.json" ]]
[[ "$(readlink "${HOME}/.local/share/tia/pi-agent/settings.json")" == "${CUSTOM_AGENT_DIR}/settings.json" ]]
grep -q 'export TIA_ACTIVE=1' "${HOME}/.local/bin/tia"
grep -q 'export TIA_COMMAND="tia pi"' "${HOME}/.local/bin/tia"

printf '[5/10] verify tia pi does not touch sandbox history on startup\n'
TIA_AGENT_DIR="${HOME}/.local/share/tia/pi-agent"
mkdir -p "${TIA_AGENT_DIR}/sessions"
printf '{}' > "${TIA_AGENT_DIR}/sessions/stale.jsonl"
tia pi --version >/dev/null
[[ -e "${TIA_AGENT_DIR}/sessions/stale.jsonl" ]]
rm -f "${TIA_AGENT_DIR}/sessions/stale.jsonl"

printf '[6/10] verify deprecated top-level modes are rejected\n'
! bash "${ROOT_DIR}/install.sh" fast-pi status >"${TMP_DIR}/fast-pi.out" 2>"${TMP_DIR}/fast-pi.err"
! bash "${ROOT_DIR}/install.sh" fast-pi-max status >"${TMP_DIR}/fast-pi-max.out" 2>"${TMP_DIR}/fast-pi-max.err"
! bash "${ROOT_DIR}/install.sh" max status >"${TMP_DIR}/max.out" 2>"${TMP_DIR}/max.err"
rg -n "no longer supported" "${TMP_DIR}/fast-pi.err" "${TMP_DIR}/fast-pi-max.err" "${TMP_DIR}/max.err" >/dev/null

printf '[7/10] verify tia pi rpc\n'
bash "${ROOT_DIR}/bench/build-pi-rpc-payloads.sh" >/dev/null
ANTHROPIC_API_KEY=dummy \
	run_with_optional_timeout tia pi --mode rpc --no-session --no-skills --no-prompt-templates --no-themes \
	< "${ROOT_DIR}/payloads-rpc/empty.get-state.jsonl" > "${TMP_DIR}/tia-pi-rpc.jsonl"
python3 - <<'PY' "${TMP_DIR}/tia-pi-rpc.jsonl"
import json, sys
response = None
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        obj = json.loads(line)
        if obj.get('type') == 'response':
            response = obj
            break
assert response is not None
assert response['command'] == 'get_state'
assert response['success'] is True
PY

printf '[8/10] verify exact write reliability\n'
bun "${ROOT_DIR}/bench/write-reliability.ts" 5 > "${TMP_DIR}/write-reliability.json"
python3 - <<'PY' "${TMP_DIR}/write-reliability.json"
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    obj = json.load(f)
assert obj['ok'] is True
assert obj['writes'] > 0
PY

printf '[9/10] verify installer bootstrap path\n'
BOOTSTRAP_HOME="${TMP_DIR}/bootstrap-home"
BOOTSTRAP_BIN_HOME="${BOOTSTRAP_HOME}/bin"
BOOTSTRAP_DATA_HOME="${BOOTSTRAP_HOME}/share"
mkdir -p "${TMP_DIR}/bootstrap-cwd"
(
	cd "${TMP_DIR}/bootstrap-cwd"
	curl -fsSL "file://$(python3 - <<'PY' "${ROOT_DIR}/install.sh"
import pathlib, sys
print(pathlib.Path(sys.argv[1]).as_posix().replace(' ', '%20'))
PY
)" | \
	HOME="${BOOTSTRAP_HOME}" \
	XDG_BIN_HOME="${BOOTSTRAP_BIN_HOME}" \
	XDG_DATA_HOME="${BOOTSTRAP_DATA_HOME}" \
	INSTALL_BASE_URL="file://$(python3 - <<'PY' "${ROOT_DIR}/scripts"
import pathlib, sys
print(pathlib.Path(sys.argv[1]).as_posix().replace(' ', '%20'))
PY
)" \
	PI_PACKAGE_DIR="${HOST_PI_PACKAGE_DIR}" \
	TIA_ENABLE_FFF=0 \
	bash -s -- tia install > "${TMP_DIR}/bootstrap-install.txt"
)
HOME="${BOOTSTRAP_HOME}" \
XDG_BIN_HOME="${BOOTSTRAP_BIN_HOME}" \
XDG_DATA_HOME="${BOOTSTRAP_DATA_HOME}" \
"${BOOTSTRAP_BIN_HOME}/tia" status > "${TMP_DIR}/bootstrap-status.txt"
rg -n "tia-runtime installed:[[:space:]]+yes|tia stream:[[:space:]]+|pi package:[[:space:]]+|cliproxy auto-start:[[:space:]]+enabled" "${TMP_DIR}/bootstrap-status.txt" >/dev/null
! rg -n "opencode" "${TMP_DIR}/bootstrap-status.txt" >/dev/null
[[ ! -e "${BOOTSTRAP_BIN_HOME}/max" ]]

printf '[10/10] cleanup tia benchmark helper processes\n'
bash "${ROOT_DIR}/bench/cleanup-processes.sh" >/dev/null

printf 'All runtime tests passed.\n'
