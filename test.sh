#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TMP_DIR="$(mktemp -d)"
HAS_OPENCODE=0
if command -v opencode >/dev/null 2>&1; then
	HAS_OPENCODE=1
fi
cleanup() {
	rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

printf '[1/12] install tia runtime\n'
bash "${ROOT_DIR}/install.sh" >/dev/null

printf '[2/12] check tia status\n'
tia status > "${TMP_DIR}/tia-status.txt"
rg -n "tia installed:[[:space:]]+yes|tia stream:[[:space:]]+|pi package:[[:space:]]+" "${TMP_DIR}/tia-status.txt" >/dev/null
if [[ "${HAS_OPENCODE}" == "1" ]]; then
	rg -n "tia opencode available:[[:space:]]+yes|tia opencode cmd:[[:space:]]+" "${TMP_DIR}/tia-status.txt" >/dev/null
else
	rg -n "tia opencode available:[[:space:]]+no" "${TMP_DIR}/tia-status.txt" >/dev/null
fi

printf '[3/12] verify tia refreshes shell pi agent links at launch\n'
CUSTOM_AGENT_DIR="${TMP_DIR}/custom-agent"
mkdir -p "${CUSTOM_AGENT_DIR}"
printf '%s\n' '{"source":"custom"}' > "${CUSTOM_AGENT_DIR}/auth.json"
printf '%s\n' '{"source":"custom"}' > "${CUSTOM_AGENT_DIR}/models.json"
printf '%s\n' '{"source":"custom"}' > "${CUSTOM_AGENT_DIR}/settings.json"
PI_CODING_AGENT_DIR="${CUSTOM_AGENT_DIR}" tia pi --version >/dev/null
[[ "$(readlink "${HOME}/.local/share/tia/pi-agent/auth.json")" == "${CUSTOM_AGENT_DIR}/auth.json" ]]
[[ "$(readlink "${HOME}/.local/share/tia/pi-agent/models.json")" == "${CUSTOM_AGENT_DIR}/models.json" ]]
[[ "$(readlink "${HOME}/.local/share/tia/pi-agent/settings.json")" == "${CUSTOM_AGENT_DIR}/settings.json" ]]

printf '[4/12] verify tia preserves exact opencode credentials/session dirs and env\n'
if [[ "${HAS_OPENCODE}" == "1" ]]; then
	SHELL_XDG_CONFIG_HOME="${TMP_DIR}/shell-config"
	SHELL_XDG_DATA_HOME="${TMP_DIR}/shell-data"
	SHELL_XDG_CACHE_HOME="${TMP_DIR}/shell-cache"
	SHELL_XDG_STATE_HOME="${TMP_DIR}/shell-state"
	mkdir -p \
		"${SHELL_XDG_CONFIG_HOME}/opencode" \
		"${SHELL_XDG_DATA_HOME}/opencode" \
		"${SHELL_XDG_CACHE_HOME}/opencode" \
		"${SHELL_XDG_STATE_HOME}/opencode"
	printf '%s\n' '{"source":"custom"}' > "${SHELL_XDG_CONFIG_HOME}/opencode/opencode.json"
	printf '%s\n' '{"source":"custom"}' > "${SHELL_XDG_DATA_HOME}/opencode/auth.json"
	printf '%s\n' 'db' > "${SHELL_XDG_DATA_HOME}/opencode/opencode.db"
	printf '%s\n' '{"source":"custom"}' > "${SHELL_XDG_CACHE_HOME}/opencode/models.json"
	printf '%s\n' '{"source":"custom"}' > "${SHELL_XDG_STATE_HOME}/opencode/kv.json"
	printf '%s\n' '{"source":"custom"}' > "${SHELL_XDG_STATE_HOME}/opencode/model.json"
	printf '%s\n' '{"source":"custom"}' > "${SHELL_XDG_STATE_HOME}/opencode/prompt-history.jsonl"
	OPENCODE_HELPER="${TMP_DIR}/opencode-env-dump.sh"
	cat > "${OPENCODE_HELPER}" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'args=%s\n' "$*"
printf 'OPENAI_API_KEY=%s\n' "${OPENAI_API_KEY:-}"
printf 'ANTHROPIC_API_KEY=%s\n' "${ANTHROPIC_API_KEY:-}"
printf 'XDG_CONFIG_HOME=%s\n' "${XDG_CONFIG_HOME:-}"
printf 'XDG_DATA_HOME=%s\n' "${XDG_DATA_HOME:-}"
printf 'XDG_CACHE_HOME=%s\n' "${XDG_CACHE_HOME:-}"
printf 'XDG_STATE_HOME=%s\n' "${XDG_STATE_HOME:-}"
EOF
	chmod +x "${OPENCODE_HELPER}"
	XDG_CONFIG_HOME="${SHELL_XDG_CONFIG_HOME}" \
	XDG_DATA_HOME="${SHELL_XDG_DATA_HOME}" \
	XDG_CACHE_HOME="${SHELL_XDG_CACHE_HOME}" \
	XDG_STATE_HOME="${SHELL_XDG_STATE_HOME}" \
	OPENAI_API_KEY="custom-openai-key" \
	ANTHROPIC_API_KEY="custom-anthropic-key" \
	OPENCODE_BIN_PATH="${OPENCODE_HELPER}" \
		tia opencode debug paths > "${TMP_DIR}/tia-opencode-env.txt" 2>&1
	TIA_OPENCODE_ROOT="${HOME}/.local/share/tia/opencode"
	[[ "$(readlink "${TIA_OPENCODE_ROOT}/config-home/opencode")" == "${SHELL_XDG_CONFIG_HOME}/opencode" ]]
	[[ "$(readlink "${TIA_OPENCODE_ROOT}/data-home/opencode")" == "${SHELL_XDG_DATA_HOME}/opencode" ]]
	[[ "$(readlink "${TIA_OPENCODE_ROOT}/cache-home/opencode")" == "${SHELL_XDG_CACHE_HOME}/opencode" ]]
	[[ "$(readlink "${TIA_OPENCODE_ROOT}/state-home/opencode")" == "${SHELL_XDG_STATE_HOME}/opencode" ]]
	rg -n "args=debug paths|OPENAI_API_KEY=custom-openai-key|ANTHROPIC_API_KEY=custom-anthropic-key" "${TMP_DIR}/tia-opencode-env.txt" >/dev/null
	rg -n "XDG_CONFIG_HOME=${TIA_OPENCODE_ROOT}/config-home|XDG_DATA_HOME=${TIA_OPENCODE_ROOT}/data-home|XDG_CACHE_HOME=${TIA_OPENCODE_ROOT}/cache-home|XDG_STATE_HOME=${TIA_OPENCODE_ROOT}/state-home" "${TMP_DIR}/tia-opencode-env.txt" >/dev/null
else
	printf 'skipped (opencode not installed)\n'
fi

printf '[5/12] verify tia pi does not touch sandbox history on startup\n'
TIA_AGENT_DIR="${HOME}/.local/share/tia/pi-agent"
mkdir -p "${TIA_AGENT_DIR}/sessions"
printf '{}' > "${TIA_AGENT_DIR}/sessions/stale.jsonl"
tia pi --version >/dev/null
[[ -e "${TIA_AGENT_DIR}/sessions/stale.jsonl" ]]
rm -f "${TIA_AGENT_DIR}/sessions/stale.jsonl"

printf '[6/12] verify deprecated top-level modes are rejected\n'
! bash "${ROOT_DIR}/install.sh" fast-pi status >"${TMP_DIR}/fast-pi.out" 2>"${TMP_DIR}/fast-pi.err"
! bash "${ROOT_DIR}/install.sh" fast-pi-max status >"${TMP_DIR}/fast-pi-max.out" 2>"${TMP_DIR}/fast-pi-max.err"
! bash "${ROOT_DIR}/install.sh" max status >"${TMP_DIR}/max.out" 2>"${TMP_DIR}/max.err"
rg -n "no longer supported" "${TMP_DIR}/fast-pi.err" "${TMP_DIR}/fast-pi-max.err" "${TMP_DIR}/max.err" >/dev/null

printf '[7/12] verify tia pi rpc\n'
bash "${ROOT_DIR}/bench/build-pi-rpc-payloads.sh" >/dev/null
ANTHROPIC_API_KEY=dummy \
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

printf '[8/12] verify installer bootstrap path\n'
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
rg -n "tia installed:[[:space:]]+yes|tia stream:[[:space:]]+|pi package:[[:space:]]+" "${TMP_DIR}/bootstrap-status.txt" >/dev/null
if [[ "${HAS_OPENCODE}" == "1" ]]; then
	rg -n "tia opencode available:[[:space:]]+yes|tia opencode cmd:[[:space:]]+" "${TMP_DIR}/bootstrap-status.txt" >/dev/null
fi
[[ ! -e "${BOOTSTRAP_BIN_HOME}/max" ]]

printf '[9/12] verify fast tool runners\n'
bash "${ROOT_DIR}/bench/build-tool-fixtures.sh" >/dev/null
bash "${ROOT_DIR}/bench/build-native.sh" >/dev/null
bash "${ROOT_DIR}/bench/build-pi-tool-override-burst.sh" >/dev/null
bun "${ROOT_DIR}/bench/pi-tool-override-burst.ts" stock read 2 >/dev/null
bun "${ROOT_DIR}/bench/pi-tool-override-burst.ts" fast read 2 >/dev/null
bun "${ROOT_DIR}/bench/pi-tool-override-burst.ts" stock edit 2 >/dev/null
bun "${ROOT_DIR}/bench/pi-tool-override-burst.ts" fast edit 2 >/dev/null
bun "${ROOT_DIR}/bench/pi-tool-override-burst.ts" stock bash 1 >/dev/null
bun "${ROOT_DIR}/bench/pi-tool-override-burst.ts" fast bash 1 >/dev/null
bun "${ROOT_DIR}/bench/pi-tool-override-stream-burst.ts" stock read 2 >/dev/null
bun "${ROOT_DIR}/bench/pi-tool-override-stream-burst.ts" fast read 2 >/dev/null
"${ROOT_DIR}/bin/pi-tool-override-burst" fast edit 2 >/dev/null
"${ROOT_DIR}/bin/pi-tool-override-stream-burst" fast read 2 >/dev/null

printf '[10/12] verify low-level benchmark harness\n'
bash "${ROOT_DIR}/bench/test-low-level.sh" >/dev/null

printf '[11/12] verify startup latency budgets\n'
bash "${ROOT_DIR}/bench/test-startup-latency.sh" >/dev/null

printf '[12/12] cleanup benchmark processes\n'
bash "${ROOT_DIR}/bench/cleanup-processes.sh" >/dev/null

printf 'All tests passed.\n'
