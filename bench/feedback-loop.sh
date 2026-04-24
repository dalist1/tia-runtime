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
	python3 - <<'PY' "$1" "$2" "$3"
import json, sys
path, field, expected = sys.argv[1:4]
with open(path, 'r', encoding='utf-8') as f:
    obj = json.load(f)
value = obj
for part in field.split('.'):
    value = value[part]
if str(value) != expected:
    raise SystemExit(f"Expected {field}={expected}, got {value}")
PY
}

cleanup() {
	bash "${ROOT_DIR}/bench/cleanup-processes.sh" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

need_cmd bash
need_cmd bun
need_cmd gcc
need_cmd hyperfine
need_cmd python3

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

python3 - <<'PY' "${RESULT_DIR}/config.json" "${ROOT_DIR}" "${RUN_ID}" "${ROUNDS}" "${RUNS}" "${WARMUP}" "${TIER}" "${RUN_STARTUP}" "${ZIG_STATUS}" "${READ_ITERATIONS}" "${WRITE_ITERATIONS}" "${EDIT_ITERATIONS}" "${BASH_ITERATIONS}" "${STREAM_ITERATIONS}"
import json, sys
(
    path,
    root,
    run_id,
    rounds,
    runs,
    warmup,
    tier,
    run_startup,
    zig,
    read_iterations,
    write_iterations,
    edit_iterations,
    bash_iterations,
    stream_iterations,
) = sys.argv[1:]
config = {
    "root_dir": root,
    "run_id": run_id,
    "rounds": int(rounds),
    "runs": int(runs),
    "warmup": int(warmup),
    "tier": tier,
    "run_startup": run_startup == "1",
    "zig": zig,
    "iterations": {
        "read": int(read_iterations),
        "write": int(write_iterations),
        "edit": int(edit_iterations),
        "bash": int(bash_iterations),
        "stream": int(stream_iterations),
    },
    "top_ideas": [
        {
            "name": "native helpers for hot file paths",
            "hypothesis": "C helpers for read/edit/drain/copy reduce JS runtime overhead and syscalls on IO-heavy tool calls.",
        },
        {
            "name": "compiled runner path",
            "hypothesis": "Bun --compile removes TypeScript/runtime startup overhead for cold tool bursts and tia startup paths.",
        },
        {
            "name": "warm daemon transport",
            "hypothesis": "A persistent worker amortizes cold starts across repeated tool calls and should win when reliability stays at 100%.",
        },
        {
            "name": "Zig toolchain gate",
            "hypothesis": "Build native helpers with Zig and only promote a Zig rewrite/toolchain path when this same loop proves it faster and at least as reliable; language choice alone is not treated as a guarantee.",
        },
    ],
}
with open(path, "w", encoding="utf-8") as f:
    json.dump(config, f, indent=2)
PY

log "results: ${RESULT_DIR}"
log "top active ideas: native helpers, compiled runner, warm daemon, zig-built helpers"
log "zig status: ${ZIG_STATUS}"

log "build fixtures, native helpers, compiled harnesses"
bash "${ROOT_DIR}/bench/build-tool-fixtures.sh" >/dev/null
bash "${ROOT_DIR}/bench/build-native.sh" >/dev/null
bash "${ROOT_DIR}/bench/build-pi-tool-override-burst.sh" >/dev/null
HAVE_ZIG_HELPERS=0
if [[ -x "${ROOT_DIR}/bin/fastread-window-zigcc" && -x "${ROOT_DIR}/bin/fastedit-zigcc" && -x "${ROOT_DIR}/bin/fastdrain-zigcc" && -x "${ROOT_DIR}/bin/fastcopy-zigcc" ]]; then
	HAVE_ZIG_HELPERS=1
	log "zig helper candidate: enabled (zig cc built native helpers)"
else
	log "zig helper candidate: disabled (missing zig-built helper binaries)"
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
	if [[ "${HAVE_ZIG_HELPERS}" == "1" ]]; then
		env TIA_FASTREAD_BIN="${ROOT_DIR}/bin/fastread-window-zigcc" \
			"${ROOT_DIR}/bin/pi-tool-override-burst" fast read 2 > "${TMP_DIR}/zig-read.json"
		json_assert_field "${TMP_DIR}/zig-read.json" mode fast
		env TIA_FASTEDIT_BIN="${ROOT_DIR}/bin/fastedit-zigcc" \
			"${ROOT_DIR}/bin/pi-tool-override-burst" fast edit 2 > "${TMP_DIR}/zig-edit.json"
		json_assert_field "${TMP_DIR}/zig-edit.json" tool edit
		env TIA_FASTREAD_BIN="${ROOT_DIR}/bin/fastread-window-zigcc" \
			"${ROOT_DIR}/bin/pi-tool-override-stream-burst" fast read 2 > "${TMP_DIR}/zig-stream.json"
		json_assert_field "${TMP_DIR}/zig-stream.json" mode fast
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
		--command-name "stock bun"
		"bun ${ROOT_DIR}/bench/pi-tool-override-burst.ts stock ${tool} ${iterations}"
		--command-name "fast bun/native"
		"bun ${ROOT_DIR}/bench/pi-tool-override-burst.ts fast ${tool} ${iterations}"
		--command-name "fast compiled/native"
		"${ROOT_DIR}/bin/pi-tool-override-burst fast ${tool} ${iterations}"
		--command-name "fast warm-daemon/native"
		"${ROOT_DIR}/bin/pi-tool-request-loop daemon fast ${tool} ${iterations}"
	)
	if [[ "${HAVE_ZIG_HELPERS}" == "1" && "${tool}" != "write" ]]; then
		commands+=(
			--command-name "fast compiled/zigcc-native"
			"env TIA_FASTREAD_BIN=${ROOT_DIR}/bin/fastread-window-zigcc TIA_FASTEDIT_BIN=${ROOT_DIR}/bin/fastedit-zigcc TIA_FASTDRAIN_BIN=${ROOT_DIR}/bin/fastdrain-zigcc TIA_FASTCOPY_BIN=${ROOT_DIR}/bin/fastcopy-zigcc ${ROOT_DIR}/bin/pi-tool-override-burst fast ${tool} ${iterations}"
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
		--command-name "stock stream bun"
		"bun ${ROOT_DIR}/bench/pi-tool-override-stream-burst.ts stock read ${STREAM_ITERATIONS}"
		--command-name "fast stream bun/native"
		"bun ${ROOT_DIR}/bench/pi-tool-override-stream-burst.ts fast read ${STREAM_ITERATIONS}"
		--command-name "fast stream compiled/native"
		"${ROOT_DIR}/bin/pi-tool-override-stream-burst fast read ${STREAM_ITERATIONS}"
	)
	if [[ "${HAVE_ZIG_HELPERS}" == "1" ]]; then
		commands+=(
			--command-name "fast stream compiled/zigcc-native"
			"env TIA_FASTREAD_BIN=${ROOT_DIR}/bin/fastread-window-zigcc ${ROOT_DIR}/bin/pi-tool-override-stream-burst fast read ${STREAM_ITERATIONS}"
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
	python3 - <<'PY' "${round_dir}/meta.json" "${round}" "${ROUNDS}"
import json, sys, time
path, round_no, rounds = sys.argv[1:]
with open(path, "w", encoding="utf-8") as f:
    json.dump({"round": int(round_no), "rounds": int(rounds), "started_at": time.time()}, f, indent=2)
PY
	cleanup
	run_tool_suite "${round_dir}" read "${READ_ITERATIONS}"
	run_tool_suite "${round_dir}" write "${WRITE_ITERATIONS}"
	run_tool_suite "${round_dir}" edit "${EDIT_ITERATIONS}"
	run_tool_suite "${round_dir}" bash "${BASH_ITERATIONS}"
	run_stream_suite "${round_dir}"
	if [[ "${RUN_STARTUP}" == "1" ]]; then
		run_startup_suite "${round_dir}"
	fi
	python3 - <<'PY' "${round_dir}/meta.json"
import json, sys, time
path = sys.argv[1]
with open(path, "r", encoding="utf-8") as f:
    data = json.load(f)
data["finished_at"] = time.time()
data["elapsed_s"] = data["finished_at"] - data["started_at"]
with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
PY
	python3 "${ROOT_DIR}/bench/summarize-feedback-loop.py" "${RESULT_DIR}" >/dev/null
	log "round ${round}/${ROUNDS} complete"
done

summary_path="$(python3 "${ROOT_DIR}/bench/summarize-feedback-loop.py" "${RESULT_DIR}")"
log "summary: ${summary_path}"
cat "${summary_path}"
