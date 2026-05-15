#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
RESULT_DIR="${RESULT_DIR:-${ROOT_DIR}/results-feedback-loop/${RUN_ID}}"
TIER="${TIER:-smoke}"
ROUNDS="${ROUNDS:-5}"
RUNS="${RUNS:-}"
WARMUP="${WARMUP:-1}"
RUN_STARTUP="${RUN_STARTUP:-auto}"
RUN_GATES="${RUN_GATES:-1}"
IGNORE_FAILURE="${IGNORE_FAILURE:-1}"
SETUP_ZIG="${SETUP_ZIG:-1}"

case "${TIER}" in
	smoke)
		RUNS="${RUNS:-3}"
		READ_ITERATIONS="${READ_ITERATIONS:-12}"
		WRITE_ITERATIONS="${WRITE_ITERATIONS:-8}"
		EDIT_ITERATIONS="${EDIT_ITERATIONS:-8}"
		BASH_ITERATIONS="${BASH_ITERATIONS:-4}"
		STREAM_ITERATIONS="${STREAM_ITERATIONS:-8}"
		;;
	full)
		RUNS="${RUNS:-6}"
		READ_ITERATIONS="${READ_ITERATIONS:-60}"
		WRITE_ITERATIONS="${WRITE_ITERATIONS:-25}"
		EDIT_ITERATIONS="${EDIT_ITERATIONS:-30}"
		BASH_ITERATIONS="${BASH_ITERATIONS:-20}"
		STREAM_ITERATIONS="${STREAM_ITERATIONS:-60}"
		;;
	*)
		printf 'Unsupported TIER=%s (expected smoke or full)\n' "${TIER}" >&2
		exit 2
		;;
esac

need_cmd() {
	command -v "$1" >/dev/null 2>&1 || {
		printf 'Missing required command: %s\n' "$1" >&2
		exit 1
	}
}

log() {
	printf '[feedback] %s\n' "$*"
}

json_assert_field() {
	bun -e 'const fs=require("node:fs"); const [path, field, expected]=process.argv.slice(1); let value=JSON.parse(fs.readFileSync(path,"utf8")); for (const part of field.split(".")) value=value[part]; if (String(value) !== expected) { console.error(`Expected ${field}=${expected}, got ${value}`); process.exit(1); }' "$1" "$2" "$3"
}

cleanup() {
	bash "${ROOT_DIR}/bench/cleanup-processes.sh" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

need_cmd bash
need_cmd bun
need_cmd hyperfine

export PATH="${HOME}/.local/bin:${PATH}"
if [[ "${SETUP_ZIG}" != "0" && -z "$(command -v zig 2>/dev/null || true)" ]]; then
	log "zig not found; installing local Zig toolchain"
	bash "${ROOT_DIR}/scripts/install-zig.sh" >/dev/null || true
fi

mkdir -p "${RESULT_DIR}"

ZIG_PATH="$(command -v zig 2>/dev/null || true)"
if [[ -n "${ZIG_PATH}" ]]; then
	ZIG_STATUS="available:${ZIG_PATH} ($(zig version))"
else
	ZIG_STATUS="absent (skipping Zig toolchain candidate until it can be measured here)"
fi

if [[ "${RUN_STARTUP}" == "auto" ]]; then
	if command -v tia >/dev/null 2>&1 && command -v pi-node >/dev/null 2>&1; then
		RUN_STARTUP="1"
	else
		RUN_STARTUP="0"
	fi
fi

bun -e 'const fs=require("node:fs"); const [path, root, runId, rounds, runs, warmup, tier, runStartup, zig, readIterations, writeIterations, editIterations, bashIterations, streamIterations]=process.argv.slice(1); const config={root_dir:root, run_id:runId, date_utc:new Date().toISOString(), rounds:Number(rounds), runs:Number(runs), warmup:Number(warmup), tier, run_startup:runStartup==="1", zig, iterations:{read:Number(readIterations), write:Number(writeIterations), edit:Number(editIterations), bash:Number(bashIterations), stream:Number(streamIterations)}, active_helpers:"pure Zig read/edit, zig cc C write/copy/drain", comparison_helpers:"gcc", top_ideas:[{name:"compiled runner + native helpers", hypothesis:"Compiled Bun runner plus pure Zig read/edit helpers and zig cc-built C helpers is the default retained fast path."},{name:"warm daemon transport", hypothesis:"A persistent worker amortizes cold starts across repeated tool calls, especially verified-write loops."},{name:"gcc comparison helpers", hypothesis:"GCC-built helpers remain as low-level comparison binaries, not the active runtime path."}], removed_approaches:["stock Bun tool baseline", "Bun source-runner fast path"]}; fs.writeFileSync(path, JSON.stringify(config, null, 2));' "${RESULT_DIR}/config.json" "${ROOT_DIR}" "${RUN_ID}" "${ROUNDS}" "${RUNS}" "${WARMUP}" "${TIER}" "${RUN_STARTUP}" "${ZIG_STATUS}" "${READ_ITERATIONS}" "${WRITE_ITERATIONS}" "${EDIT_ITERATIONS}" "${BASH_ITERATIONS}" "${STREAM_ITERATIONS}"

log "results: ${RESULT_DIR}"
log "retained ideas: compiled/native, warm daemon, gcc comparison helpers"
log "zig status: ${ZIG_STATUS}"

log "build fixtures, native helpers, compiled harnesses"
bash "${ROOT_DIR}/bench/build-tool-fixtures.sh" >/dev/null
bash "${ROOT_DIR}/bench/build-native.sh" >/dev/null
bash "${ROOT_DIR}/bench/build-pi-tool-override-burst.sh" >/dev/null
HAVE_GCC_HELPERS=0
if [[ -x "${ROOT_DIR}/bin/fastread-window-gcc" && -x "${ROOT_DIR}/bin/fastedit-gcc" && -x "${ROOT_DIR}/bin/fastdrain-gcc" && -x "${ROOT_DIR}/bin/fastcopy-gcc" && -x "${ROOT_DIR}/bin/fastwrite-gcc" ]]; then
	HAVE_GCC_HELPERS=1
	log "gcc comparison helpers: enabled"
else
	log "gcc comparison helpers: disabled (missing gcc-built helper binaries)"
fi
if [[ "${RUN_STARTUP}" == "1" ]]; then
	bash "${ROOT_DIR}/bench/build-pi-rpc-payloads.sh" >/dev/null
fi
cleanup

if [[ "${RUN_GATES}" == "1" ]]; then
	log "correctness gates"
	TMP_DIR="$(mktemp -d)"
	trap 'rm -rf "${TMP_DIR}"; cleanup' EXIT INT TERM
	"${ROOT_DIR}/bin/pi-tool-override-burst" fast read 2 > "${TMP_DIR}/read.json"
	json_assert_field "${TMP_DIR}/read.json" mode fast
	json_assert_field "${TMP_DIR}/read.json" tool read
	"${ROOT_DIR}/bin/pi-tool-override-burst" fast edit 2 > "${TMP_DIR}/edit.json"
	json_assert_field "${TMP_DIR}/edit.json" mode fast
	json_assert_field "${TMP_DIR}/edit.json" tool edit
	"${ROOT_DIR}/bin/pi-tool-override-stream-burst" fast read 2 > "${TMP_DIR}/stream.json"
	json_assert_field "${TMP_DIR}/stream.json" mode fast
	"${ROOT_DIR}/bin/pi-tool-request-loop" daemon fast read 3 > "${TMP_DIR}/daemon.json"
	json_assert_field "${TMP_DIR}/daemon.json" transport daemon
	if [[ "${HAVE_GCC_HELPERS}" == "1" ]]; then
		env TIA_FASTREAD_BIN="${ROOT_DIR}/bin/fastread-window-gcc" \
			"${ROOT_DIR}/bin/pi-tool-override-burst" fast read 2 > "${TMP_DIR}/gcc-read.json"
		json_assert_field "${TMP_DIR}/gcc-read.json" mode fast
		env TIA_FASTEDIT_BIN="${ROOT_DIR}/bin/fastedit-gcc" \
			"${ROOT_DIR}/bin/pi-tool-override-burst" fast edit 2 > "${TMP_DIR}/gcc-edit.json"
		json_assert_field "${TMP_DIR}/gcc-edit.json" tool edit
		env TIA_FASTREAD_BIN="${ROOT_DIR}/bin/fastread-window-gcc" \
			"${ROOT_DIR}/bin/pi-tool-override-stream-burst" fast read 2 > "${TMP_DIR}/gcc-stream.json"
		json_assert_field "${TMP_DIR}/gcc-stream.json" mode fast
	fi
	rm -rf "${TMP_DIR}"
	trap cleanup EXIT INT TERM
fi

HF_COMMON=(--warmup "${WARMUP}" --runs "${RUNS}")
if [[ "${IGNORE_FAILURE}" == "1" ]]; then
	HF_COMMON+=(--ignore-failure)
fi

run_tool_suite() {
	local round_dir="$1"
	local tool="$2"
	local iterations="$3"
	local out="${round_dir}/tool-${tool}.json"
	log "round ${round}: tool ${tool} (${iterations} iterations, runs=${RUNS})"
	local commands=(
		--command-name "fast compiled/native"
		"${ROOT_DIR}/bin/pi-tool-override-burst fast ${tool} ${iterations}"
		--command-name "fast warm-daemon/native"
		"${ROOT_DIR}/bin/pi-tool-request-loop daemon fast ${tool} ${iterations}"
	)
	if [[ "${HAVE_GCC_HELPERS}" == "1" ]]; then
		commands+=(
			--command-name "fast compiled/gcc comparison"
			"env TIA_FASTREAD_BIN=${ROOT_DIR}/bin/fastread-window-gcc TIA_FASTEDIT_BIN=${ROOT_DIR}/bin/fastedit-gcc TIA_FASTDRAIN_BIN=${ROOT_DIR}/bin/fastdrain-gcc TIA_FASTCOPY_BIN=${ROOT_DIR}/bin/fastcopy-gcc TIA_FASTWRITE_BIN=${ROOT_DIR}/bin/fastwrite-gcc ${ROOT_DIR}/bin/pi-tool-override-burst fast ${tool} ${iterations}"
		)
	fi
	hyperfine \
		--shell=none \
		"${HF_COMMON[@]}" \
		--export-json "${out}" \
		"${commands[@]}" \
		> "${round_dir}/tool-${tool}.log"
}

run_stream_suite() {
	local round_dir="$1"
	local out="${round_dir}/stream-read.json"
	log "round ${round}: stream read (${STREAM_ITERATIONS} iterations, runs=${RUNS})"
	local commands=(
		--command-name "fast stream compiled/native"
		"${ROOT_DIR}/bin/pi-tool-override-stream-burst fast read ${STREAM_ITERATIONS}"
	)
	if [[ "${HAVE_GCC_HELPERS}" == "1" ]]; then
		commands+=(
			--command-name "fast stream compiled/gcc read comparison"
			"env TIA_FASTREAD_BIN=${ROOT_DIR}/bin/fastread-window-gcc ${ROOT_DIR}/bin/pi-tool-override-stream-burst fast read ${STREAM_ITERATIONS}"
		)
	fi
	hyperfine \
		--shell=none \
		"${HF_COMMON[@]}" \
		--export-json "${out}" \
		"${commands[@]}" \
		> "${round_dir}/stream-read.log"
}

run_startup_suite() {
	local round_dir="$1"
	local request_file="${ROOT_DIR}/payloads-rpc/empty.get-state.jsonl"
	local out="${round_dir}/startup-rpc.json"
	log "round ${round}: startup rpc (runs=${RUNS})"
	hyperfine \
		"${HF_COMMON[@]}" \
		--export-json "${out}" \
		--command-name "pi original rpc" \
		"env -u PI_PACKAGE_DIR -u PI_CODING_AGENT_DIR ANTHROPIC_API_KEY=dummy pi-node --mode rpc --no-session --no-extensions --no-skills --no-prompt-templates --no-themes < ${request_file}" \
		--command-name "tia pi rpc" \
		"env -u PI_PACKAGE_DIR ANTHROPIC_API_KEY=dummy tia pi --mode rpc --no-session --no-skills --no-prompt-templates --no-themes < ${request_file}" \
		> "${round_dir}/startup-rpc.log"
}

for round in $(seq 1 "${ROUNDS}"); do
	round_dir="${RESULT_DIR}/round-$(printf '%02d' "${round}")"
	mkdir -p "${round_dir}"
	bun -e 'const fs=require("node:fs"); const [path, roundNo, rounds]=process.argv.slice(1); fs.writeFileSync(path, JSON.stringify({round:Number(roundNo), rounds:Number(rounds), started_at:Date.now()/1000}, null, 2));' "${round_dir}/meta.json" "${round}" "${ROUNDS}"
	cleanup
	run_tool_suite "${round_dir}" read "${READ_ITERATIONS}"
	run_tool_suite "${round_dir}" write "${WRITE_ITERATIONS}"
	run_tool_suite "${round_dir}" edit "${EDIT_ITERATIONS}"
	run_tool_suite "${round_dir}" bash "${BASH_ITERATIONS}"
	run_stream_suite "${round_dir}"
	if [[ "${RUN_STARTUP}" == "1" ]]; then
		run_startup_suite "${round_dir}"
	fi
	bun -e 'const fs=require("node:fs"); const path=process.argv[1]; const data=JSON.parse(fs.readFileSync(path,"utf8")); data.finished_at=Date.now()/1000; data.elapsed_s=data.finished_at-data.started_at; fs.writeFileSync(path, JSON.stringify(data, null, 2));' "${round_dir}/meta.json"
	bun "${ROOT_DIR}/bench/summarize-feedback-loop.ts" "${RESULT_DIR}" >/dev/null
	log "round ${round}/${ROUNDS} complete"
done

summary_path="$(bun "${ROOT_DIR}/bench/summarize-feedback-loop.ts" "${RESULT_DIR}")"
log "summary: ${summary_path}"
cat "${summary_path}"
