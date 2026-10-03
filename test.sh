#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TMP_DIR="$(mktemp -d)"
REAL_HOME="${HOME}"
# Every install below targets disposable roots; the live runtime is never a fixture.
export HOME="${TMP_DIR}/home" XDG_BIN_HOME="${TMP_DIR}/home/.local/bin" XDG_DATA_HOME="${TMP_DIR}/home/.local/share"
unset TIA_ROOT PI_CODING_AGENT_DIR PI_PACKAGE_DIR
export PATH="${XDG_BIN_HOME}:${PATH}"
TIA_DATA="${XDG_DATA_HOME}/tia"
mkdir -p "${HOME}" "${XDG_BIN_HOME}"
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
	local preserved_extension="${2:-}"
	[[ -f "${agent_dir}/extensions/fast-tools.ts" ]]
	[[ -f "${agent_dir}/extensions/fff/index.ts" || ! -d "${agent_dir}/extensions/fff" ]]
	local entry
	while IFS= read -r entry; do
		case "$(basename -- "${entry}")" in
		fast-tools.ts|fff)
			;;
		*)
			[[ "$(basename -- "${entry}")" == "${preserved_extension}" ]] || return 1
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
	if [[ "${TIA_TEST_KEEP:-0}" == 1 ]]; then
		printf 'Kept test directory: %s\n' "${TMP_DIR}" >&2
		return
	fi
	chmod -R u+w "${TMP_DIR}" 2>/dev/null || true
	rm -rf "${TMP_DIR}"
}
generation_dir() {
	readlink -f "$1/current/runtime"
}
trap cleanup EXIT

printf '[1/14] install tia runtime into a disposable root\n'
[[ "${HOME}" != "${REAL_HOME}" && "${TIA_DATA}" == "${TMP_DIR}"/* ]]
bash "${ROOT_DIR}/install.sh" tia install >/dev/null
G="$(generation_dir "${TIA_DATA}")"
[[ "${G}" == "${TIA_DATA}"/generations/* ]]
tia verify | grep -q '"verified": true'
bun -e 'const fs=require("node:fs"),path=require("node:path"); const rows=fs.readdirSync(process.argv[1]).flatMap(name=>fs.readFileSync(path.join(process.argv[1],name),"utf8").split("\n")).filter(line=>line.startsWith("{")); if(!rows.some(line=>{try{return JSON.parse(line).validation?.multiFilePatch === true}catch{return false}})) throw new Error("Shipped multi-file patch smoke did not run")' "${TIA_DATA}/logs"

printf '[2/14] check tia status\n'
tia status > "${TMP_DIR}/tia-status.txt"
grep -En "tia-runtime installed:[[:space:]]+yes|tia stream:[[:space:]]+|pi package:[[:space:]]+|cliproxy auto-start:[[:space:]]+enabled" "${TMP_DIR}/tia-status.txt" >/dev/null
grep -En "optimization:.*$(tr -d '[:space:]' < "${ROOT_DIR}/OPTIMIZATION_VERSION")" "${TMP_DIR}/tia-status.txt" >/dev/null
grep -En "pi version:.*[0-9]+\.[0-9]+\.[0-9]+" "${TMP_DIR}/tia-status.txt" >/dev/null
grep -En "fff extension:.*enabled" "${TMP_DIR}/tia-status.txt" >/dev/null
PI_PACKAGE_DIR="$(cat "${G}/pi-package-dir.txt")"
HOST_PI_PACKAGE_DIR="${PI_PACKAGE_DIR}"
bun -e '
const fs=require("node:fs"),{createHash}=require("node:crypto"),assert=require("node:assert/strict");
const root=process.argv[1],meta=JSON.parse(fs.readFileSync(root+"/pi-build.json","utf8"));
const expected=process.env.TIA_DISABLE_LAZY_JITI==="1"?"bundled":"lazy-jiti";
assert.equal(meta.mode,expected,"Unexpected full-runtime build mode");
assert.equal(meta.format,"esm","Full runtime must retain ESM semantics");
assert.equal(meta.options.bytecode,process.env.TIA_PI_BYTECODE!=="0","Unexpected bytecode build setting");
assert.equal(createHash("sha256").update(fs.readFileSync(root+"/bin/pi")).digest("hex"),meta.binarySha256,"Installed binary does not match build metadata");
if(expected==="lazy-jiti")assert(fs.existsSync(meta.companion.entry),"Missing Jiti companion");
const pkg=fs.readFileSync(root+"/pi-package-dir.txt","utf8").trim(), ai=fs.readFileSync(root+"/pi-ai-package-dir.txt","utf8").trim();
assert.equal(fs.realpathSync(Bun.resolveSync("@earendil-works/pi-ai",pkg)),fs.realpathSync(Bun.resolveSync("@earendil-works/pi-ai",ai)),"Slim dependency differs from the full runtime");
assert.equal(JSON.parse(fs.readFileSync(ai+"/package.json","utf8")).version,meta.piVersion,"Unsynchronized pi-ai dependency");
' "${G}"
EXPECTED_PI_VERSION="${TIA_PI_PACKAGE_VERSION:-latest}"
HOST_PI_MANIFEST="${BUN_INSTALL:-${HOME}/.bun}/install/global/node_modules/@earendil-works/pi-coding-agent/package.json"
if [[ -z "${TIA_PI_PACKAGE_VERSION:-}" && -f "${HOST_PI_MANIFEST}" ]]; then
	EXPECTED_PI_VERSION="$(bun -e 'console.log(require(process.argv[1]).version)' "${HOST_PI_MANIFEST}")"
	tia status | grep -Eq "pi source:[[:space:]]+host"
fi
if [[ "${EXPECTED_PI_VERSION}" == "latest" ]]; then
	EXPECTED_PI_VERSION="$(npm view @earendil-works/pi-coding-agent time --json | bun -e 'const t=JSON.parse(await Bun.stdin.text());console.log(Object.entries(t).filter(([v])=>/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(v)).sort((a,b)=>Date.parse(b[1])-Date.parse(a[1]))[0][0])')"
fi
[[ "$(bun -e 'console.log(require(process.argv[1]).version)' "${PI_PACKAGE_DIR}/package.json")" == "${EXPECTED_PI_VERSION}" ]]
[[ -x "${G}/bin/pi-stream-fast" ]]
[[ -f "${G}/stream-runtime/models.json" ]]
[[ -f "${G}/stream-runtime/default-models.json" ]]
[[ -f "${G}/stream-runtime/model-index.txt" ]]
[[ -f "${G}/stream-runtime/models/anthropic.json" ]]
[[ -f "${G}/stream-runtime/anthropic-messages.mjs" ]]
[[ -f "${G}/stream-runtime/openai-responses.mjs" ]]

printf '[3/14] verify tia refreshes shell pi agent links at launch\n'
CUSTOM_AGENT_DIR="${TMP_DIR}/custom-agent"
mkdir -p "${CUSTOM_AGENT_DIR}"
printf '%s\n' '{"source":"custom"}' > "${CUSTOM_AGENT_DIR}/auth.json"
printf '%s\n' '{"source":"custom"}' > "${CUSTOM_AGENT_DIR}/models.json"
printf '%s\n' '{"source":"custom"}' > "${CUSTOM_AGENT_DIR}/settings.json"
PI_CODING_AGENT_DIR="${CUSTOM_AGENT_DIR}" tia pi --version >/dev/null
[[ "$(readlink "${TIA_DATA}/pi-agent/auth.json")" == "${CUSTOM_AGENT_DIR}/auth.json" ]]
[[ "$(readlink "${TIA_DATA}/pi-agent/models.json")" == "${CUSTOM_AGENT_DIR}/models.json" ]]
[[ "$(readlink "${TIA_DATA}/pi-agent/settings.json")" == "${CUSTOM_AGENT_DIR}/settings.json" ]]
if [[ -f "${HOME}/.pi/agent/auth.json" && -f "${HOME}/.pi/agent/models.json" && -f "${HOME}/.pi/agent/settings.json" ]]; then
	PI_CODING_AGENT_DIR="${TIA_DATA}/pi-agent" tia pi --version >/dev/null
	[[ "$(readlink "${TIA_DATA}/pi-agent/auth.json")" == "${HOME}/.pi/agent/auth.json" ]]
	[[ "$(readlink "${TIA_DATA}/pi-agent/models.json")" == "${HOME}/.pi/agent/models.json" ]]
	[[ "$(readlink "${TIA_DATA}/pi-agent/settings.json")" == "${HOME}/.pi/agent/settings.json" ]]
fi

printf '[4/14] verify concurrent tia pi launches refresh shell pi agent links safely\n'
concurrent_pids=""
for i in 1 2 3 4 5; do
	PI_CODING_AGENT_DIR="${CUSTOM_AGENT_DIR}" tia pi --version >"${TMP_DIR}/tia-concurrent-${i}.out" 2>"${TMP_DIR}/tia-concurrent-${i}.err" &
	concurrent_pids="${concurrent_pids} $!"
done
for pid in ${concurrent_pids}; do
	wait "${pid}"
done
[[ "$(readlink "${TIA_DATA}/pi-agent/auth.json")" == "${CUSTOM_AGENT_DIR}/auth.json" ]]
[[ "$(readlink "${TIA_DATA}/pi-agent/models.json")" == "${CUSTOM_AGENT_DIR}/models.json" ]]
[[ "$(readlink "${TIA_DATA}/pi-agent/settings.json")" == "${CUSTOM_AGENT_DIR}/settings.json" ]]
grep -q 'TIA_ACTIVE=1' "${G}/launch"
grep -q 'TIA_COMMAND="tia pi"' "${G}/launch"

printf '[5/14] verify OAuth flows are bundled into tia pi\n'
OAUTH_AGENT_DIR="${TMP_DIR}/oauth-agent"
mkdir -p "${OAUTH_AGENT_DIR}"
bun -e 'const fs=require("node:fs"); const payload=Buffer.from(JSON.stringify({"https://api.openai.com/auth":{chatgpt_account_id:"test-account"}})).toString("base64url"); fs.writeFileSync(process.argv[1], JSON.stringify({"openai-codex":{type:"oauth",access:`e30.${payload}.sig`,refresh:"fake",expires:Date.now()+3600000,accountId:"test-account"}}));' "${OAUTH_AGENT_DIR}/auth.json"
printf '%s\n' '{"providers":{"openai-codex":{"baseUrl":"http://127.0.0.1:1"}}}' > "${OAUTH_AGENT_DIR}/models.json"
printf '%s\n' '{"retry":{"provider":{"maxRetries":0,"timeoutMs":1000}}}' > "${OAUTH_AGENT_DIR}/settings.json"
OAUTH_MODEL="$(bun -e 'console.log(require(process.argv[1])["openai-codex"])' "${G}/stream-runtime/default-models.json")"
run_with_optional_timeout env -i HOME="${HOME}" PATH="${PATH}" PI_NO_PROXY_AUTO_START=1 TIA_DISABLE_FAST_STREAM=1 PI_CODING_AGENT_DIR="${OAUTH_AGENT_DIR}" \
	tia pi --mode json --no-session --no-extensions --no-skills --no-prompt-templates --no-themes --no-tools --no-context-files --provider openai-codex --model "${OAUTH_MODEL}" -p oauth-check \
	> "${TMP_DIR}/tia-oauth-bundle.jsonl"
bun -e 'const events=require("node:fs").readFileSync(process.argv[1],"utf8").trim().split(/\n+/).map(JSON.parse); const message=events.map(event=>event.message).find(message=>message?.role==="assistant"); if (!message || message.errorMessage?.includes("OAuth auth derivation failed") || !message.diagnostics?.some(item=>item.type==="provider_transport_failure")) process.exit(1);' "${TMP_DIR}/tia-oauth-bundle.jsonl"

printf '[6/14] verify upstream model selection retains configured providers\n'
SELECTOR_AGENT_DIR="${TMP_DIR}/selector-agent"
mkdir -p "${SELECTOR_AGENT_DIR}"
printf '%s\n' '{"providers":{"openai":{"baseUrl":"http://127.0.0.1:1/v1","api":"openai-completions","apiKey":"test","models":[{"id":"private-openai","reasoning":false,"input":["text"],"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"contextWindow":1000,"maxTokens":100}]},"openai-codex":{"baseUrl":"http://127.0.0.1:1/v1","api":"openai-completions","apiKey":"test","models":[{"id":"private-codex","reasoning":false,"input":["text"],"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"contextWindow":1000,"maxTokens":100}]},"selector-test":{"baseUrl":"http://127.0.0.1:1/v1","api":"openai-completions","apiKey":"test","models":[{"id":"visible-model","reasoning":false,"input":["text"],"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"contextWindow":1000,"maxTokens":100}]}}}' > "${SELECTOR_AGENT_DIR}/models.json"
printf '%s\n' '{}' > "${SELECTOR_AGENT_DIR}/settings.json"
PI_NO_PROXY_AUTO_START=1 PI_CODING_AGENT_DIR="${SELECTOR_AGENT_DIR}" tia pi --list-models > "${TMP_DIR}/selector-models.txt"
grep -q 'openai.*private-openai' "${TMP_DIR}/selector-models.txt"
grep -q 'openai-codex.*private-codex' "${TMP_DIR}/selector-models.txt"
grep -q 'selector-test.*visible-model' "${TMP_DIR}/selector-models.txt"

printf '[7/14] verify tia pi does not touch sandbox history on startup\n'
TIA_AGENT_DIR="${TIA_DATA}/pi-agent"
mkdir -p "${TIA_AGENT_DIR}/sessions"
printf '{}' > "${TIA_AGENT_DIR}/sessions/stale.jsonl"
tia pi --version >/dev/null
[[ -e "${TIA_AGENT_DIR}/sessions/stale.jsonl" ]]
rm -f "${TIA_AGENT_DIR}/sessions/stale.jsonl"

printf '[8/14] verify deprecated top-level modes are rejected\n'
! bash "${ROOT_DIR}/install.sh" fast-pi status >"${TMP_DIR}/fast-pi.out" 2>"${TMP_DIR}/fast-pi.err"
! bash "${ROOT_DIR}/install.sh" fast-pi-max status >"${TMP_DIR}/fast-pi-max.out" 2>"${TMP_DIR}/fast-pi-max.err"
! bash "${ROOT_DIR}/install.sh" max status >"${TMP_DIR}/max.out" 2>"${TMP_DIR}/max.err"
grep -En "no longer supported" "${TMP_DIR}/fast-pi.err" "${TMP_DIR}/fast-pi-max.err" "${TMP_DIR}/max.err" >/dev/null

printf '[9/14] verify tia pi rpc\n'
bash "${ROOT_DIR}/bench/build-pi-rpc-payloads.sh" >/dev/null
ANTHROPIC_API_KEY=dummy \
	run_with_optional_timeout tia pi --mode rpc --no-session --no-skills --no-prompt-templates --no-themes \
	< "${ROOT_DIR}/payloads-rpc/empty.get-state.jsonl" > "${TMP_DIR}/tia-pi-rpc.jsonl"
bun -e 'const fs=require("node:fs"); const lines=fs.readFileSync(process.argv[1], "utf8").trim().split(/\n+/); const response=lines.map((line)=>JSON.parse(line)).find((obj)=>obj.type === "response"); if (!response || response.command !== "get_state" || response.success !== true) process.exit(1);' "${TMP_DIR}/tia-pi-rpc.jsonl"

STREAM_AGENT_DIR="${TMP_DIR}/stream-agent"
mkdir -p "${STREAM_AGENT_DIR}"
DEFAULT_MODELS="${G}/stream-runtime/default-models.json"
ANTHROPIC_DEFAULT="$(bun -e 'console.log(require(process.argv[1]).anthropic)' "${DEFAULT_MODELS}")"
env -i HOME="${HOME}" PATH="${PATH}" ANTHROPIC_API_KEY=dummy PI_NO_PROXY_AUTO_START=1 PI_CODING_AGENT_DIR="${STREAM_AGENT_DIR}" \
	tia pi --mode json --no-session --provider anthropic > "${TMP_DIR}/tia-stream-provider.jsonl"
env -i HOME="${HOME}" PATH="${PATH}" ANTHROPIC_API_KEY=dummy PI_NO_PROXY_AUTO_START=1 PI_CODING_AGENT_DIR="${STREAM_AGENT_DIR}" \
	tia pi --mode json --no-session --model "${ANTHROPIC_DEFAULT}" > "${TMP_DIR}/tia-stream-model.jsonl"
bun -e 'const model=process.argv[1]; for (const path of process.argv.slice(2)) { const event=JSON.parse(require("node:fs").readFileSync(path,"utf8").trim()); if (event.t !== "session" || event.provider !== "anthropic" || event.model !== model) process.exit(1); }' "${ANTHROPIC_DEFAULT}" \
	"${TMP_DIR}/tia-stream-provider.jsonl" "${TMP_DIR}/tia-stream-model.jsonl"
env -i HOME="${HOME}" PATH="${PATH}" XAI_API_KEY=dummy PI_NO_PROXY_AUTO_START=1 PI_CODING_AGENT_DIR="${STREAM_AGENT_DIR}" \
	tia pi --mode json --no-session --provider xai > "${TMP_DIR}/tia-stream-xai.jsonl"
env -i HOME="${HOME}" PATH="${PATH}" ANTHROPIC_API_KEY=dummy XAI_API_KEY=dummy PI_NO_PROXY_AUTO_START=1 PI_CODING_AGENT_DIR="${STREAM_AGENT_DIR}" \
	tia pi --mode json --no-session > "${TMP_DIR}/tia-stream-auth-fallback.jsonl"
printf '%s\n' '{"providers":{"local-fast":{"baseUrl":"http://127.0.0.1:11434/v1","api":"openai-completions","apiKey":"local","models":[{"id":"local-model"}]}}}' > "${STREAM_AGENT_DIR}/models.json"
env -i HOME="${HOME}" PATH="${PATH}" PI_NO_PROXY_AUTO_START=1 PI_CODING_AGENT_DIR="${STREAM_AGENT_DIR}" \
	tia pi --mode json --no-session --provider local-fast > "${TMP_DIR}/tia-stream-custom.jsonl"
bun -e 'const fs=require("node:fs"), defaults=require(process.argv[4]); const checks=[[process.argv[1],"xai",defaults.xai],[process.argv[2],"anthropic",defaults.anthropic],[process.argv[3],"local-fast","local-model"]]; for (const [path,provider,model] of checks) { const event=JSON.parse(fs.readFileSync(path,"utf8").trim()); if (event.t !== "session" || event.provider !== provider || event.model !== model) process.exit(1); }' \
	"${TMP_DIR}/tia-stream-xai.jsonl" "${TMP_DIR}/tia-stream-auth-fallback.jsonl" "${TMP_DIR}/tia-stream-custom.jsonl" "${DEFAULT_MODELS}"
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
	tia pi --mode json --no-session --provider anthropic --model "${ANTHROPIC_DEFAULT}" loopback > "${TMP_DIR}/tia-stream-loopback.jsonl"
kill "${LOOPBACK_PID}" >/dev/null 2>&1 || true
wait "${LOOPBACK_PID}" 2>/dev/null || true
LOOPBACK_PID=""
bun -e 'const lines=require("node:fs").readFileSync(process.argv[1],"utf8").trim().split(/\n+/).map(JSON.parse); if (!lines.some(event=>event.t==="d"&&event.s==="loopback ok") || !lines.some(event=>event.t==="done"&&!event.error)) process.exit(1)' "${TMP_DIR}/tia-stream-loopback.jsonl"

printf '[10/14] verify exact write reliability\n'
bun "${ROOT_DIR}/bench/write-reliability.ts" 5 > "${TMP_DIR}/write-reliability.json"
bun -e 'const obj=require(process.argv[1]); if (obj.ok !== true || obj.writes <= 0) process.exit(1);' "${TMP_DIR}/write-reliability.json"

printf '[11/14] verify installed toolkit is clean\n'
assert_clean_toolkit "${G}"

printf '[12/14] verify installer bootstrap path\n'
BOOTSTRAP_HOME="${TMP_DIR}/bootstrap-home"
BOOTSTRAP_BIN_HOME="${BOOTSTRAP_HOME}/bin"
BOOTSTRAP_DATA_HOME="${BOOTSTRAP_HOME}/share"
mkdir -p "${TMP_DIR}/bootstrap-cwd" "${BOOTSTRAP_DATA_HOME}/tia/pi-agent"
mkdir -p "${BOOTSTRAP_DATA_HOME}/tia/pi-agent/extensions"
printf 'export default function () {}\n' > "${BOOTSTRAP_DATA_HOME}/tia/pi-agent/extensions/user-kept.ts"
printf 'export default function () { void "local-fast-tools"; }\n' > "${BOOTSTRAP_DATA_HOME}/tia/pi-agent/extensions/fast-tools.ts"
ln -s "${TMP_DIR}/missing-fff-state" "${BOOTSTRAP_DATA_HOME}/tia/pi-agent/fff"
(
	cd "${TMP_DIR}/bootstrap-cwd"
	curl -fsSL "$(bun -e 'const { pathToFileURL } = require("node:url"); console.log(pathToFileURL(process.argv[1]).href)' "${ROOT_DIR}/install.sh")" | \
	HOME="${BOOTSTRAP_HOME}" \
	XDG_BIN_HOME="${BOOTSTRAP_BIN_HOME}" \
	XDG_DATA_HOME="${BOOTSTRAP_DATA_HOME}" \
	INSTALL_BASE_URL="$(bun -e 'const { pathToFileURL } = require("node:url"); console.log(pathToFileURL(process.argv[1]).href)' "${ROOT_DIR}/scripts")" \
	PI_PACKAGE_DIR="${HOST_PI_PACKAGE_DIR}" \
	TIA_PRESERVE_FAST_TOOLS=1 \
	TIA_ENABLE_FFF=0 \
	bash -s -- tia install > "${TMP_DIR}/bootstrap-install.txt" 2>&1
)
HOME="${BOOTSTRAP_HOME}" \
XDG_BIN_HOME="${BOOTSTRAP_BIN_HOME}" \
XDG_DATA_HOME="${BOOTSTRAP_DATA_HOME}" \
"${BOOTSTRAP_BIN_HOME}/tia" status > "${TMP_DIR}/bootstrap-status.txt"
grep -En "optimization:.*$(tr -d '[:space:]' < "${ROOT_DIR}/OPTIMIZATION_VERSION")" "${TMP_DIR}/bootstrap-status.txt" >/dev/null
grep -En "tia-runtime installed:[[:space:]]+yes|tia stream:[[:space:]]+|pi package:[[:space:]]+|cliproxy auto-start:[[:space:]]+enabled" "${TMP_DIR}/bootstrap-status.txt" >/dev/null
grep -F "${BOOTSTRAP_BIN_HOME} is not on PATH" "${TMP_DIR}/bootstrap-install.txt" >/dev/null
[[ -L "${BOOTSTRAP_DATA_HOME}/tia/pi-agent/fff" ]]
HOME="${BOOTSTRAP_HOME}" PI_NO_PROXY_AUTO_START=1 "${BOOTSTRAP_BIN_HOME}/tia" pi --version >/dev/null
[[ -d "${BOOTSTRAP_DATA_HOME}/tia/pi-agent/fff" && ! -L "${BOOTSTRAP_DATA_HOME}/tia/pi-agent/fff" ]]
[[ "$(cat "${BOOTSTRAP_DATA_HOME}/tia/pi-agent/extensions/user-kept.ts")" == 'export default function () {}' ]]
[[ "$(cat "${BOOTSTRAP_DATA_HOME}/tia/pi-agent/extensions/fast-tools.ts")" == 'export default function () { void "local-fast-tools"; }' ]]
BOOTSTRAP_G="$(generation_dir "${BOOTSTRAP_DATA_HOME}/tia")"
assert_clean_toolkit "${BOOTSTRAP_G}" user-kept.ts
[[ "$(cat "${BOOTSTRAP_G}/extensions/fast-tools.ts")" == 'export default function () { void "local-fast-tools"; }' ]]
[[ ! -e "${BOOTSTRAP_BIN_HOME}/max" ]]

printf '[13/14] upgrade a disposable v0.6.0 install with live sessions, rollback and reinstall\n'
LEGACY="${TMP_DIR}/legacy"
LEGACY_HOME="${LEGACY}/home"
LEGACY_BIN="${LEGACY_HOME}/.local/bin"
LEGACY_DATA="${LEGACY_HOME}/.local/share"
LEGACY_ROOT="${LEGACY_DATA}/tia"
mkdir -p "${LEGACY}/src" "${LEGACY}/pi-0.85.0" "${LEGACY_BIN}" "${LEGACY_HOME}/.pi/agent/extensions" "${LEGACY_HOME}/.pi/agent/sessions"
git -C "${ROOT_DIR}" archive v0.6.0 scripts native | tar -x -C "${LEGACY}/src"
printf '%s\n' '{"private":true,"dependencies":{"@earendil-works/pi-coding-agent":"0.85.0","@earendil-works/pi-agent-core":"0.85.0","@earendil-works/pi-ai":"0.85.0","@earendil-works/pi-tui":"0.85.0","@earendil-works/pi-server":"0.85.0","@earendil-works/pi-client":"0.85.0","@earendil-works/pi-protocol":"0.85.0","@earendil-works/pi-telemetry":"0.85.0"}}' > "${LEGACY}/pi-0.85.0/package.json"
(cd "${LEGACY}/pi-0.85.0" && HOME="${LEGACY_HOME}" bun install --ignore-scripts >/dev/null 2>&1)
legacy_env=(env -i PATH="${PATH}" HOME="${LEGACY_HOME}" XDG_BIN_HOME="${LEGACY_BIN}" XDG_DATA_HOME="${LEGACY_DATA}" PI_NO_PROXY_AUTO_START=1 PI_TELEMETRY=0 DO_NOT_TRACK=1)
"${legacy_env[@]}" PI_PACKAGE_DIR="${LEGACY}/pi-0.85.0/node_modules/@earendil-works/pi-coding-agent" TIA_FFF_PACKAGE_VERSION="${TIA_FFF_PACKAGE_VERSION:-nightly}" \
	bash "${LEGACY}/src/scripts/install-tia.sh" install > "${LEGACY}/legacy-install.log" 2>&1
grep -q 'TIA_VERSION="0.6.0"' "${LEGACY_BIN}/tia"
printf '%s\n' '{"legacy":{"type":"api_key","key":"dummy-legacy-key"}}' > "${LEGACY_HOME}/.pi/agent/auth.json"
printf '%s\n' '{"theme":"dark","defaultProvider":"legacy","enableInstallTelemetry":false}' > "${LEGACY_HOME}/.pi/agent/settings.json"
printf '%s\n' '{"providers":{}}' > "${LEGACY_HOME}/.pi/agent/models.json"
printf '%s\n' "import type {ExtensionAPI} from '@earendil-works/pi-coding-agent'" 'export default function (_pi: ExtensionAPI) {}' > "${LEGACY_HOME}/.pi/agent/extensions/custom-route.ts"
ln -s "${LEGACY_HOME}/.pi/agent/extensions/custom-route.ts" "${LEGACY_ROOT}/pi-agent/extensions/custom-route.ts"
printf '\n// locally customized\n' >> "${LEGACY_ROOT}/pi-agent/extensions/fast-tools.ts"
mkdir -p "${LEGACY_ROOT}/pi-agent/sessions"
printf '%s\n' '{"type":"session","id":"kept"}' > "${LEGACY_ROOT}/pi-agent/sessions/kept.jsonl"
"${legacy_env[@]}" "${LEGACY_BIN}/tia" pi --version >/dev/null
"${legacy_env[@]}" "${LEGACY_BIN}/tia" status > "${LEGACY}/legacy-status.txt"
cp "${LEGACY_BIN}/tia" "${LEGACY}/legacy-launcher"
state_hash() {
	bun -e '
const fs=require("node:fs"),path=require("node:path"),{createHash}=require("node:crypto");const hash=createHash("sha256");
const visit=p=>{for(const name of fs.readdirSync(p).sort()){const c=path.join(p,name),s=fs.lstatSync(c);if(name==="node_modules"||name==="fff")continue;if(s.isDirectory())visit(c);else hash.update(c).update(s.isSymbolicLink()?fs.readlinkSync(c):fs.readFileSync(c))}};
for(const p of process.argv.slice(1))visit(p);console.log(hash.digest("hex"))' "${LEGACY_ROOT}/pi-agent" "${LEGACY_HOME}/.pi/agent"
}
start_session() {
	mkfifo "$1.in"
	"${legacy_env[@]}" "${LEGACY_BIN}/tia" pi --mode rpc --no-session --no-extensions < "$1.in" > "$1.out" 2> "$1.err" &
	printf '%s\n' "$!" > "$1.pid"
}
query_session() {
	printf '%s\n' '{"type":"get_state"}' > "$1.in"
	for _ in $(seq 1 100); do grep -q '"command":"get_state"' "$1.out" 2>/dev/null && return 0; sleep 0.05; done
	cat "$1.err" >&2
	return 1
}
upgrade() {
	"${legacy_env[@]}" INSTALL_BASE_URL="file://${ROOT_DIR}/scripts" TIA_PI_PACKAGE_VERSION="${TIA_PI_PACKAGE_VERSION:-0.87.1}" "$@" bash "${ROOT_DIR}/scripts/install-tia.sh" install
}
start_session "${LEGACY}/legacy-session"
exec 8> "${LEGACY}/legacy-session.in"
query_session "${LEGACY}/legacy-session"
STATE_BEFORE="$(state_hash)"
! upgrade > "${LEGACY}/upgrade-refused.log" 2>&1
grep -q 'does not match any fast-tools.ts shipped by TIA' "${LEGACY}/upgrade-refused.log"
cmp "${LEGACY_BIN}/tia" "${LEGACY}/legacy-launcher"
[[ ! -e "${LEGACY_ROOT}/current" && -z "$(ls -A "${LEGACY_ROOT}/generations")" ]]
upgrade TIA_PRESERVE_FAST_TOOLS=1 > "${LEGACY}/upgrade.log" 2>&1
grep -q '# tia generation dispatcher v1' "${LEGACY_BIN}/tia"
LEGACY_G="$(generation_dir "${LEGACY_ROOT}")"
grep -q 'locally customized' "${LEGACY_G}/extensions/fast-tools.ts"
cmp "${LEGACY_G}/extensions/custom-route.ts" "${LEGACY_HOME}/.pi/agent/extensions/custom-route.ts"
[[ "$("${legacy_env[@]}" "${LEGACY_BIN}/tia" pi --version)" == "${TIA_PI_PACKAGE_VERSION:-0.87.1}" ]]
[[ "$(state_hash)" == "${STATE_BEFORE}" ]]
: > "${LEGACY}/legacy-session.out"
query_session "${LEGACY}/legacy-session"
start_session "${LEGACY}/generation-session"
exec 7> "${LEGACY}/generation-session.in"
"${legacy_env[@]}" "${LEGACY_BIN}/tia" rollback > "${LEGACY}/rollback.json"
cmp <("${legacy_env[@]}" "${LEGACY_BIN}/tia" status) "${LEGACY}/legacy-status.txt"
query_session "${LEGACY}/generation-session"
"${legacy_env[@]}" "${LEGACY_BIN}/tia" verify | grep -q '"legacy": true'
upgrade > "${LEGACY}/reinstall.log" 2>&1
[[ "$(generation_dir "${LEGACY_ROOT}")" != "${LEGACY_G}" ]]
"${legacy_env[@]}" "${LEGACY_BIN}/tia" verify | grep -q '"verified": true'
[[ "$(state_hash)" == "${STATE_BEFORE}" ]]
exec 7>&- 8>&-
for session in legacy-session generation-session; do kill "$(cat "${LEGACY}/${session}.pid")" 2>/dev/null || true; done

printf '[14/14] follow a host pi update with a background sync\n'
SYNC="${TMP_DIR}/sync"
SYNC_HOST="${SYNC}/bun/install/global/node_modules/@earendil-works/pi-coding-agent"
mkdir -p "${SYNC_HOST}" "${SYNC}/home"
set_host_pi() { printf '{\n "name": "@earendil-works/pi-coding-agent",\n "version": "%s"\n}\n' "$1" > "${SYNC_HOST}/package.json"; }
sync_env=(env -i PATH="${PATH}" HOME="${SYNC}/home" BUN_INSTALL="${SYNC}/bun" XDG_BIN_HOME="${SYNC}/bin" XDG_DATA_HOME="${SYNC}/data" PI_NO_PROXY_AUTO_START=1)
set_host_pi 0.87.1
"${sync_env[@]}" TIA_FFF_PACKAGE_VERSION="${TIA_FFF_PACKAGE_VERSION:-0.10.7-nightly.c3f2c7f}" bash "${ROOT_DIR}/scripts/install-tia.sh" install > "${SYNC}/install.log" 2>&1
"${sync_env[@]}" "${SYNC}/bin/tia" status | grep -Eq 'pi version:[[:space:]]+0\.87\.1'
"${sync_env[@]}" "${SYNC}/bin/tia" status | grep -Eq 'pi source:[[:space:]]+host'
FIRST_SYNC_G="$(generation_dir "${SYNC}/data/tia")"
set_host_pi 0.99.1
[[ "$("${sync_env[@]}" "${SYNC}/bin/tia" pi --version)" == 0.87.1 ]]
for _ in $(seq 1 300); do
	if [[ "$(generation_dir "${SYNC}/data/tia")" != "${FIRST_SYNC_G}" ]] && flock --nonblock "${SYNC}/data/tia/.upgrade.lock" true; then break; fi
	sleep 0.5
done
[[ "$("${sync_env[@]}" "${SYNC}/bin/tia" pi --version)" == 0.99.1 ]] || { cat "${SYNC}/data/tia/logs/sync-0.99.1.log" >&2; exit 1; }
"${sync_env[@]}" "${SYNC}/bin/tia" verify | grep -q '"verified": true'
"${sync_env[@]}" "${SYNC}/bin/tia" sync | grep -q 'already matches host pi 0.99.1'
"${sync_env[@]}" "${SYNC}/bin/tia" rollback > /dev/null
[[ "$("${sync_env[@]}" TIA_AUTO_SYNC=0 "${SYNC}/bin/tia" pi --version)" == 0.87.1 ]]

printf 'All runtime tests passed.\n'
