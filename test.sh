#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TMP_DIR="$(mktemp -d)"
TIMEOUT_BIN=""
LOOPBACK_PID=""
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
assert_clean_toolkit() {
	local agent_dir="$1"
	[[ -f "${agent_dir}/extensions/fast-tools.ts" ]]
	[[ -f "${agent_dir}/extensions/fff/index.ts" || ! -d "${agent_dir}/extensions/fff" ]]
	local entry
	while IFS= read -r entry; do
		case "$(basename -- "${entry}")" in
		fast-tools.ts|fff)
			;;
		*)
			return 1
			;;
		esac
	done < <(find "${agent_dir}/extensions" -mindepth 1 -maxdepth 1)
	while IFS= read -r entry; do
		case "$(basename -- "${entry}")" in
		fastcopy|fastdrain)
			;;
		*)
			return 1
			;;
		esac
	done < <(find "${agent_dir}/fast-tools" -mindepth 1 -maxdepth 1 -type f)
}
cleanup() {
	if [[ -n "${LOOPBACK_PID}" ]]; then
		kill "${LOOPBACK_PID}" >/dev/null 2>&1 || true
		wait "${LOOPBACK_PID}" 2>/dev/null || true
	fi
	rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

printf '[1/12] install tia runtime\n'
TIA_REQUIRE_FFF=1 bash "${ROOT_DIR}/install.sh" tia install >/dev/null

printf '[2/12] check tia status\n'
tia status > "${TMP_DIR}/tia-status.txt"
grep -En "tia-runtime installed:[[:space:]]+yes|tia stream:[[:space:]]+|pi package:[[:space:]]+|cliproxy auto-start:[[:space:]]+enabled" "${TMP_DIR}/tia-status.txt" >/dev/null
grep -En "optimization:.*$(tr -d '[:space:]' < "${ROOT_DIR}/OPTIMIZATION_VERSION")" "${TMP_DIR}/tia-status.txt" >/dev/null
grep -En "pi version:.*[0-9]+\.[0-9]+\.[0-9]+" "${TMP_DIR}/tia-status.txt" >/dev/null
grep -En "fff extension:.*enabled" "${TMP_DIR}/tia-status.txt" >/dev/null
PI_PACKAGE_DIR="$(cat "${HOME}/.local/share/tia/pi-package-dir.txt")"
HOST_PI_PACKAGE_DIR="${PI_PACKAGE_DIR}"
[[ "$(bun -e 'console.log(require(process.argv[1]).version)' "${PI_PACKAGE_DIR}/package.json")" == "$(npm view @earendil-works/pi-coding-agent version)" ]]
[[ -x "${HOME}/.local/share/tia/bin/pi-stream-fast" ]]
[[ -f "${HOME}/.local/share/tia/stream-runtime/models.json" ]]
[[ -f "${HOME}/.local/share/tia/stream-runtime/default-models.json" ]]
[[ -f "${HOME}/.local/share/tia/stream-runtime/model-index.txt" ]]
[[ -f "${HOME}/.local/share/tia/stream-runtime/models/anthropic.json" ]]
[[ -f "${HOME}/.local/share/tia/stream-runtime/anthropic-messages.mjs" ]]
[[ -f "${HOME}/.local/share/tia/stream-runtime/openai-responses.mjs" ]]

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
if [[ -f "${HOME}/.pi/agent/auth.json" && -f "${HOME}/.pi/agent/models.json" && -f "${HOME}/.pi/agent/settings.json" ]]; then
	PI_CODING_AGENT_DIR="${HOME}/.local/share/tia/pi-agent" tia pi --version >/dev/null
	[[ "$(readlink "${HOME}/.local/share/tia/pi-agent/auth.json")" == "${HOME}/.pi/agent/auth.json" ]]
	[[ "$(readlink "${HOME}/.local/share/tia/pi-agent/models.json")" == "${HOME}/.pi/agent/models.json" ]]
	[[ "$(readlink "${HOME}/.local/share/tia/pi-agent/settings.json")" == "${HOME}/.pi/agent/settings.json" ]]
fi

printf '[4/12] verify concurrent tia pi launches refresh shell pi agent links safely\n'
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

printf '[5/12] verify OAuth flows are bundled into tia pi\n'
OAUTH_AGENT_DIR="${TMP_DIR}/oauth-agent"
mkdir -p "${OAUTH_AGENT_DIR}"
bun -e 'const fs=require("node:fs"); const payload=Buffer.from(JSON.stringify({"https://api.openai.com/auth":{chatgpt_account_id:"test-account"}})).toString("base64url"); fs.writeFileSync(process.argv[1], JSON.stringify({"openai-codex":{type:"oauth",access:`e30.${payload}.sig`,refresh:"fake",expires:Date.now()+3600000,accountId:"test-account"}}));' "${OAUTH_AGENT_DIR}/auth.json"
printf '%s\n' '{"providers":{"openai-codex":{"baseUrl":"http://127.0.0.1:1"}}}' > "${OAUTH_AGENT_DIR}/models.json"
printf '%s\n' '{"retry":{"provider":{"maxRetries":0,"timeoutMs":1000}}}' > "${OAUTH_AGENT_DIR}/settings.json"
run_with_optional_timeout env -i HOME="${HOME}" PATH="${PATH}" PI_NO_PROXY_AUTO_START=1 TIA_DISABLE_FAST_STREAM=1 PI_CODING_AGENT_DIR="${OAUTH_AGENT_DIR}" \
	tia pi --mode json --no-session --no-extensions --no-skills --no-prompt-templates --no-themes --no-tools --no-context-files --provider openai-codex -p oauth-check \
	> "${TMP_DIR}/tia-oauth-bundle.jsonl"
bun -e 'const events=require("node:fs").readFileSync(process.argv[1],"utf8").trim().split(/\n+/).map(JSON.parse); const message=events.map(event=>event.message).find(message=>message?.role==="assistant"); if (!message || message.errorMessage?.includes("OAuth auth derivation failed") || !message.diagnostics?.some(item=>item.type==="provider_transport_failure")) process.exit(1);' "${TMP_DIR}/tia-oauth-bundle.jsonl"

printf '[6/12] verify model selectors expose only GPT providers\n'
SELECTOR_AGENT_DIR="${TMP_DIR}/selector-agent"
mkdir -p "${SELECTOR_AGENT_DIR}"
printf '%s\n' '{"providers":{"openai":{"baseUrl":"http://127.0.0.1:1/v1","api":"openai-completions","apiKey":"test","models":[{"id":"private-openai","reasoning":false,"input":["text"],"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"contextWindow":1000,"maxTokens":100}]},"openai-codex":{"baseUrl":"http://127.0.0.1:1/v1","api":"openai-completions","apiKey":"test","models":[{"id":"private-codex","reasoning":false,"input":["text"],"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"contextWindow":1000,"maxTokens":100}]},"selector-test":{"baseUrl":"http://127.0.0.1:1/v1","api":"openai-completions","apiKey":"test","models":[{"id":"visible-model","reasoning":false,"input":["text"],"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"contextWindow":1000,"maxTokens":100}]}}}' > "${SELECTOR_AGENT_DIR}/models.json"
printf '%s\n' '{}' > "${SELECTOR_AGENT_DIR}/settings.json"
PI_NO_PROXY_AUTO_START=1 PI_CODING_AGENT_DIR="${SELECTOR_AGENT_DIR}" tia pi --list-models > "${TMP_DIR}/selector-models.txt"
grep -q 'openai.*private-openai' "${TMP_DIR}/selector-models.txt"
grep -q 'openai-codex.*private-codex' "${TMP_DIR}/selector-models.txt"
! grep -q 'selector-test.*visible-model' "${TMP_DIR}/selector-models.txt"

printf '[7/12] verify tia pi does not touch sandbox history on startup\n'
TIA_AGENT_DIR="${HOME}/.local/share/tia/pi-agent"
mkdir -p "${TIA_AGENT_DIR}/sessions"
printf '{}' > "${TIA_AGENT_DIR}/sessions/stale.jsonl"
tia pi --version >/dev/null
[[ -e "${TIA_AGENT_DIR}/sessions/stale.jsonl" ]]
rm -f "${TIA_AGENT_DIR}/sessions/stale.jsonl"

printf '[8/12] verify deprecated top-level modes are rejected\n'
! bash "${ROOT_DIR}/install.sh" fast-pi status >"${TMP_DIR}/fast-pi.out" 2>"${TMP_DIR}/fast-pi.err"
! bash "${ROOT_DIR}/install.sh" fast-pi-max status >"${TMP_DIR}/fast-pi-max.out" 2>"${TMP_DIR}/fast-pi-max.err"
! bash "${ROOT_DIR}/install.sh" max status >"${TMP_DIR}/max.out" 2>"${TMP_DIR}/max.err"
grep -En "no longer supported" "${TMP_DIR}/fast-pi.err" "${TMP_DIR}/fast-pi-max.err" "${TMP_DIR}/max.err" >/dev/null

printf '[9/12] verify tia pi rpc\n'
bash "${ROOT_DIR}/bench/build-pi-rpc-payloads.sh" >/dev/null
ANTHROPIC_API_KEY=dummy \
	run_with_optional_timeout tia pi --mode rpc --no-session --no-skills --no-prompt-templates --no-themes \
	< "${ROOT_DIR}/payloads-rpc/empty.get-state.jsonl" > "${TMP_DIR}/tia-pi-rpc.jsonl"
bun -e 'const fs=require("node:fs"); const lines=fs.readFileSync(process.argv[1], "utf8").trim().split(/\n+/); const response=lines.map((line)=>JSON.parse(line)).find((obj)=>obj.type === "response"); if (!response || response.command !== "get_state" || response.success !== true) process.exit(1);' "${TMP_DIR}/tia-pi-rpc.jsonl"

STREAM_AGENT_DIR="${TMP_DIR}/stream-agent"
mkdir -p "${STREAM_AGENT_DIR}"
env -i HOME="${HOME}" PATH="${PATH}" ANTHROPIC_API_KEY=dummy PI_NO_PROXY_AUTO_START=1 PI_CODING_AGENT_DIR="${STREAM_AGENT_DIR}" \
	tia pi --mode json --no-session --provider anthropic > "${TMP_DIR}/tia-stream-provider.jsonl"
env -i HOME="${HOME}" PATH="${PATH}" ANTHROPIC_API_KEY=dummy PI_NO_PROXY_AUTO_START=1 PI_CODING_AGENT_DIR="${STREAM_AGENT_DIR}" \
	tia pi --mode json --no-session --model claude-opus-4-8 > "${TMP_DIR}/tia-stream-model.jsonl"
bun -e 'for (const path of process.argv.slice(1)) { const event=JSON.parse(require("node:fs").readFileSync(path,"utf8").trim()); if (event.t !== "session" || event.provider !== "anthropic" || event.model !== "claude-opus-4-8") process.exit(1); }' \
	"${TMP_DIR}/tia-stream-provider.jsonl" "${TMP_DIR}/tia-stream-model.jsonl"
env -i HOME="${HOME}" PATH="${PATH}" XAI_API_KEY=dummy PI_NO_PROXY_AUTO_START=1 PI_CODING_AGENT_DIR="${STREAM_AGENT_DIR}" \
	tia pi --mode json --no-session --provider xai > "${TMP_DIR}/tia-stream-xai.jsonl"
env -i HOME="${HOME}" PATH="${PATH}" ANTHROPIC_API_KEY=dummy XAI_API_KEY=dummy PI_NO_PROXY_AUTO_START=1 PI_CODING_AGENT_DIR="${STREAM_AGENT_DIR}" \
	tia pi --mode json --no-session > "${TMP_DIR}/tia-stream-auth-fallback.jsonl"
printf '%s\n' '{"providers":{"local-fast":{"baseUrl":"http://127.0.0.1:11434/v1","api":"openai-completions","apiKey":"local","models":[{"id":"local-model"}]}}}' > "${STREAM_AGENT_DIR}/models.json"
env -i HOME="${HOME}" PATH="${PATH}" PI_NO_PROXY_AUTO_START=1 PI_CODING_AGENT_DIR="${STREAM_AGENT_DIR}" \
	tia pi --mode json --no-session --provider local-fast > "${TMP_DIR}/tia-stream-custom.jsonl"
bun -e 'const fs=require("node:fs"); const checks=[[process.argv[1],"xai","grok-4.5"],[process.argv[2],"anthropic","claude-opus-4-8"],[process.argv[3],"local-fast","local-model"]]; for (const [path,provider,model] of checks) { const event=JSON.parse(fs.readFileSync(path,"utf8").trim()); if (event.t !== "session" || event.provider !== provider || event.model !== model) process.exit(1); }' \
	"${TMP_DIR}/tia-stream-xai.jsonl" "${TMP_DIR}/tia-stream-auth-fallback.jsonl" "${TMP_DIR}/tia-stream-custom.jsonl"
LOOPBACK_READY="${TMP_DIR}/loopback.port"
bun "${ROOT_DIR}/bench/anthropic-loopback-server.ts" "${LOOPBACK_READY}" >"${TMP_DIR}/loopback-server.log" 2>&1 &
LOOPBACK_PID="$!"
for _ in $(seq 1 100); do
	[[ -s "${LOOPBACK_READY}" ]] && break
	kill -0 "${LOOPBACK_PID}" 2>/dev/null || break
	sleep 0.02
done
[[ -s "${LOOPBACK_READY}" ]]
LOOPBACK_PORT="$(tr -d '[:space:]' < "${LOOPBACK_READY}")"
printf '%s\n' "{\"providers\":{\"anthropic\":{\"baseUrl\":\"http://127.0.0.1:${LOOPBACK_PORT}\",\"apiKey\":\"dummy\"}}}" > "${STREAM_AGENT_DIR}/models.json"
run_with_optional_timeout env -i HOME="${HOME}" PATH="${PATH}" PI_NO_PROXY_AUTO_START=1 PI_CODING_AGENT_DIR="${STREAM_AGENT_DIR}" \
	tia pi --mode json --no-session --provider anthropic --model claude-opus-4-8 loopback > "${TMP_DIR}/tia-stream-loopback.jsonl"
kill "${LOOPBACK_PID}" >/dev/null 2>&1 || true
wait "${LOOPBACK_PID}" 2>/dev/null || true
LOOPBACK_PID=""
bun -e 'const lines=require("node:fs").readFileSync(process.argv[1],"utf8").trim().split(/\n+/).map(JSON.parse); if (!lines.some(event=>event.t==="d"&&event.s==="loopback ok") || !lines.some(event=>event.t==="done"&&!event.error)) process.exit(1)' "${TMP_DIR}/tia-stream-loopback.jsonl"

printf '[10/12] verify exact write reliability\n'
bun "${ROOT_DIR}/bench/write-reliability.ts" 5 > "${TMP_DIR}/write-reliability.json"
bun -e 'const obj=require(process.argv[1]); if (obj.ok !== true || obj.writes <= 0) process.exit(1);' "${TMP_DIR}/write-reliability.json"

printf '[11/12] verify installed toolkit is clean\n'
assert_clean_toolkit "${HOME}/.local/share/tia/pi-agent"

printf '[12/12] verify installer bootstrap path\n'
BOOTSTRAP_HOME="${TMP_DIR}/bootstrap-home"
BOOTSTRAP_BIN_HOME="${BOOTSTRAP_HOME}/bin"
BOOTSTRAP_DATA_HOME="${BOOTSTRAP_HOME}/share"
mkdir -p "${TMP_DIR}/bootstrap-cwd" "${BOOTSTRAP_DATA_HOME}/tia/pi-agent"
ln -s "${TMP_DIR}/missing-fff-state" "${BOOTSTRAP_DATA_HOME}/tia/pi-agent/fff"
(
	cd "${TMP_DIR}/bootstrap-cwd"
	curl -fsSL "$(bun -e 'const { pathToFileURL } = require("node:url"); console.log(pathToFileURL(process.argv[1]).href)' "${ROOT_DIR}/install.sh")" | \
	HOME="${BOOTSTRAP_HOME}" \
	XDG_BIN_HOME="${BOOTSTRAP_BIN_HOME}" \
	XDG_DATA_HOME="${BOOTSTRAP_DATA_HOME}" \
	INSTALL_BASE_URL="$(bun -e 'const { pathToFileURL } = require("node:url"); console.log(pathToFileURL(process.argv[1]).href)' "${ROOT_DIR}/scripts")" \
	PI_PACKAGE_DIR="${HOST_PI_PACKAGE_DIR}" \
	TIA_ENABLE_FFF=0 \
	bash -s -- tia install > "${TMP_DIR}/bootstrap-install.txt" 2>&1
)
HOME="${BOOTSTRAP_HOME}" \
XDG_BIN_HOME="${BOOTSTRAP_BIN_HOME}" \
XDG_DATA_HOME="${BOOTSTRAP_DATA_HOME}" \
"${BOOTSTRAP_BIN_HOME}/tia" status > "${TMP_DIR}/bootstrap-status.txt"
grep -En "tia-runtime installed:[[:space:]]+yes|tia stream:[[:space:]]+|pi package:[[:space:]]+|cliproxy auto-start:[[:space:]]+enabled" "${TMP_DIR}/bootstrap-status.txt" >/dev/null
grep -F "${BOOTSTRAP_BIN_HOME} is not on PATH" "${TMP_DIR}/bootstrap-install.txt" >/dev/null
[[ -d "${BOOTSTRAP_DATA_HOME}/tia/pi-agent/fff" && ! -L "${BOOTSTRAP_DATA_HOME}/tia/pi-agent/fff" ]]
rm -rf "${BOOTSTRAP_DATA_HOME}/tia/pi-agent/fff"
ln -s "${TMP_DIR}/missing-fff-state" "${BOOTSTRAP_DATA_HOME}/tia/pi-agent/fff"
HOME="${BOOTSTRAP_HOME}" PI_NO_PROXY_AUTO_START=1 "${BOOTSTRAP_BIN_HOME}/tia" pi --version >/dev/null
[[ -d "${BOOTSTRAP_DATA_HOME}/tia/pi-agent/fff" && ! -L "${BOOTSTRAP_DATA_HOME}/tia/pi-agent/fff" ]]
assert_clean_toolkit "${BOOTSTRAP_DATA_HOME}/tia/pi-agent"
[[ ! -e "${BOOTSTRAP_BIN_HOME}/max" ]]

bash "${ROOT_DIR}/bench/cleanup-processes.sh" >/dev/null

printf 'All runtime tests passed.\n'
