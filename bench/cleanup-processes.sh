#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
SELF_PID="$$"
PARENT_PID="${PPID:-0}"

patterns=(
	'^hyperfine( |$)'
	"^bun ${ROOT_DIR}/bench/opencode-e2e-run.ts( |$)"
	'^opencode serve( |$)'
	"^${ROOT_DIR}/bin/fastdrain( |$)"
	"^${ROOT_DIR}/bin/pi-rpc-direct( |$)"
	"^${ROOT_DIR}/opencode-optimized/bin/fastcopy( |$)"
	'^bun /home/frensiqatipi1/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/dist/cli.js --mode rpc( |$)'
)

kill_matches() {
	local signal="$1"
	local had_match=1

	for pattern in "${patterns[@]}"; do
		while read -r pid _; do
			if [[ -z "${pid}" || "${pid}" == "${SELF_PID}" || "${pid}" == "${PARENT_PID}" ]]; then
				continue
			fi
			kill "-${signal}" "${pid}" 2>/dev/null || true
			had_match=0
		done < <(pgrep -af "${pattern}" || true)
	done

	return "${had_match}"
}

kill_matches TERM || true
sleep 0.5
kill_matches KILL || true
sleep 0.2

remaining=""
for pattern in "${patterns[@]}"; do
	matches="$(pgrep -af "${pattern}" || true)"
	if [[ -n "${matches}" ]]; then
		while read -r pid rest; do
			if [[ -z "${pid}" || "${pid}" == "${SELF_PID}" || "${pid}" == "${PARENT_PID}" ]]; then
				continue
			fi
			remaining+="${pid} ${rest}"$'\n'
		done <<< "${matches}"
	fi
done

if [[ -n "${remaining}" ]]; then
	printf 'Remaining benchmark processes:\n%s' "${remaining}" >&2
	exit 1
fi

printf 'No active benchmark processes found for %s\n' "${ROOT_DIR}"
