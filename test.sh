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
assert_clean_native_search_dir() {
	local dir="$1"
	[[ -f "${dir}/index.ts" ]]
	[[ -f "${dir}/native-search.zig" ]]
	local stale
	for stale in robots.ts safety.ts extract.ts rank.ts candidates.ts; do
		[[ ! -e "${dir}/${stale}" ]]
	done
}
cleanup() {
	rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

printf '[1/11] install tia runtime\n'
TIA_ENABLE_FFF=0 bash "${ROOT_DIR}/install.sh" >/dev/null

printf '[2/11] check tia status\n'
tia status > "${TMP_DIR}/tia-status.txt"
rg -n "tia-runtime installed:[[:space:]]+yes|tia stream:[[:space:]]+|pi package:[[:space:]]+|cliproxy auto-start:[[:space:]]+enabled" "${TMP_DIR}/tia-status.txt" >/dev/null
! rg -n "opencode" "${TMP_DIR}/tia-status.txt" >/dev/null

printf '[3/11] verify tia refreshes shell pi agent links at launch\n'
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

printf '[4/11] verify concurrent tia pi launches refresh shell pi agent links safely\n'
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

printf '[5/11] verify tia pi does not touch sandbox history on startup\n'
TIA_AGENT_DIR="${HOME}/.local/share/tia/pi-agent"
mkdir -p "${TIA_AGENT_DIR}/sessions"
printf '{}' > "${TIA_AGENT_DIR}/sessions/stale.jsonl"
tia pi --version >/dev/null
[[ -e "${TIA_AGENT_DIR}/sessions/stale.jsonl" ]]
rm -f "${TIA_AGENT_DIR}/sessions/stale.jsonl"

printf '[6/11] verify deprecated top-level modes are rejected\n'
! bash "${ROOT_DIR}/install.sh" fast-pi status >"${TMP_DIR}/fast-pi.out" 2>"${TMP_DIR}/fast-pi.err"
! bash "${ROOT_DIR}/install.sh" fast-pi-max status >"${TMP_DIR}/fast-pi-max.out" 2>"${TMP_DIR}/fast-pi-max.err"
! bash "${ROOT_DIR}/install.sh" max status >"${TMP_DIR}/max.out" 2>"${TMP_DIR}/max.err"
rg -n "no longer supported" "${TMP_DIR}/fast-pi.err" "${TMP_DIR}/fast-pi-max.err" "${TMP_DIR}/max.err" >/dev/null

printf '[7/11] verify tia pi rpc\n'
bash "${ROOT_DIR}/bench/build-pi-rpc-payloads.sh" >/dev/null
ANTHROPIC_API_KEY=dummy \
	run_with_optional_timeout tia pi --mode rpc --no-session --no-skills --no-prompt-templates --no-themes \
	< "${ROOT_DIR}/payloads-rpc/empty.get-state.jsonl" > "${TMP_DIR}/tia-pi-rpc.jsonl"
bun -e 'const fs=require("node:fs"); const lines=fs.readFileSync(process.argv[1], "utf8").trim().split(/\n+/); const response=lines.map((line)=>JSON.parse(line)).find((obj)=>obj.type === "response"); if (!response || response.command !== "get_state" || response.success !== true) process.exit(1);' "${TMP_DIR}/tia-pi-rpc.jsonl"

printf '[8/11] verify exact write reliability\n'
bun "${ROOT_DIR}/bench/write-reliability.ts" 5 > "${TMP_DIR}/write-reliability.json"
bun -e 'const obj=require(process.argv[1]); if (obj.ok !== true || obj.writes <= 0) process.exit(1);' "${TMP_DIR}/write-reliability.json"

printf '[9/11] verify native search extension and Zig backend\n'
assert_clean_native_search_dir "${HOME}/.local/share/tia/pi-agent/extensions/native-search"
! grep -q -- 'set -- --search' "${HOME}/.local/bin/tia"
tia pi --help | grep -q -- '--search'
while IFS= read -r file; do
	lines="$(wc -l < "${file}")"
	[[ "${lines}" -le 400 ]]
done < <(find "${ROOT_DIR}/scripts/native-search-extension" -maxdepth 1 -type f \( -name '*.ts' -o -name '*.zig' \) | sort)
if command -v zig >/dev/null 2>&1; then
	[[ -x "${HOME}/.local/share/tia/pi-agent/fast-tools/native-search-zig" ]]
	bash "${ROOT_DIR}/bench/build-native-search-zig.sh" >/dev/null
	printf '%s\t%s\t%s\n' \
		'aHR0cHM6Ly9leGFtcGxlLmludmFsaWQ=' \
		'dGV4dC9tYXJrZG93bg==' \
		'IyBOYXRpdmUgU2VhcmNoCm1hcmtkb3duIGRvY3VtZW50YXRpb24gbmF0aXZlIHNlYXJjaA==' \
		> "${TMP_DIR}/native-search-raw.tsv"
	"${ROOT_DIR}/bin/native-search-zig" native,search 1 1000 "${TMP_DIR}/native-search-raw.tsv" > "${TMP_DIR}/native-search-zig.txt"
	grep -q 'Native Zig search found 1 result' "${TMP_DIR}/native-search-zig.txt"
	grep -q 'https://example.invalid' "${TMP_DIR}/native-search-zig.txt"
fi

printf '[10/11] verify installer bootstrap path\n'
BOOTSTRAP_HOME="${TMP_DIR}/bootstrap-home"
BOOTSTRAP_BIN_HOME="${BOOTSTRAP_HOME}/bin"
BOOTSTRAP_DATA_HOME="${BOOTSTRAP_HOME}/share"
mkdir -p "${TMP_DIR}/bootstrap-cwd"
(
	cd "${TMP_DIR}/bootstrap-cwd"
	curl -fsSL "$(bun -e 'const { pathToFileURL } = require("node:url"); console.log(pathToFileURL(process.argv[1]).href)' "${ROOT_DIR}/install.sh")" | \
	HOME="${BOOTSTRAP_HOME}" \
	XDG_BIN_HOME="${BOOTSTRAP_BIN_HOME}" \
	XDG_DATA_HOME="${BOOTSTRAP_DATA_HOME}" \
	INSTALL_BASE_URL="$(bun -e 'const { pathToFileURL } = require("node:url"); console.log(pathToFileURL(process.argv[1]).href)' "${ROOT_DIR}/scripts")" \
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
assert_clean_native_search_dir "${BOOTSTRAP_DATA_HOME}/tia/pi-agent/extensions/native-search"
! grep -q -- 'set -- --search' "${BOOTSTRAP_BIN_HOME}/tia"
[[ ! -e "${BOOTSTRAP_BIN_HOME}/max" ]]

printf '[11/11] cleanup tia benchmark helper processes\n'
bash "${ROOT_DIR}/bench/cleanup-processes.sh" >/dev/null

printf 'All runtime tests passed.\n'
