#!/usr/bin/env bash

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Startup latency tests — REAL pi agent, REAL payloads, REAL
# RPC protocol.  Nothing is mocked or bypassed.
#
# Every test that touches pi goes through the actual tia pi or
# stock pi binary via --mode rpc, the real extension loader,
# and the real tool dispatch pipeline.
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"

# Resolve PI_PACKAGE_DIR the same way tia and the other test scripts do.
if [[ -f "${HOME}/.local/share/tia/pi-package-dir.txt" ]]; then
	export PI_PACKAGE_DIR="$(cat "${HOME}/.local/share/tia/pi-package-dir.txt")"
elif [[ -z "${PI_PACKAGE_DIR:-}" ]]; then
	pi_path="$(command -v pi 2>/dev/null || true)"
	if [[ -n "${pi_path}" ]]; then
		pi_resolved="$(python3 -c "import os,sys; print(os.path.realpath(sys.argv[1]))" "${pi_path}")"
		pi_dir="$(dirname "${pi_resolved}")"
		while [[ "${pi_dir}" != "/" ]]; do
			if [[ -f "${pi_dir}/package.json" ]] && python3 -c "
import json,sys
with open(sys.argv[1]) as f: d=json.load(f)
raise SystemExit(0 if d.get('name')=='@mariozechner/pi-coding-agent' else 1)
" "${pi_dir}/package.json" 2>/dev/null; then
				export PI_PACKAGE_DIR="${pi_dir}"
				break
			fi
			pi_dir="$(dirname "${pi_dir}")"
		done
	fi
fi
cleanup() {
	rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

PI_RPC_FLAGS=(--mode rpc --no-session --no-skills --no-prompt-templates --no-themes)

assert_latency_under_ms() {
	local label="$1"
	local actual_ms="$2"
	local max_ms="$3"
	python3 - <<PY "${actual_ms}" "${max_ms}" "${label}"
import sys
actual, limit, label = float(sys.argv[1]), float(sys.argv[2]), sys.argv[3]
if actual > limit:
    raise SystemExit(f"FAIL {label}: {actual:.1f}ms > {limit:.0f}ms budget")
PY
}

assert_json_field_eq() {
	local path="$1"
	local field="$2"
	local expected="$3"
	python3 - <<'PY' "${path}" "${field}" "${expected}"
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

assert_json_field_gt() {
	local path="$1"
	local field="$2"
	local min_value="$3"
	python3 - <<'PY' "${path}" "${field}" "${min_value}"
import json, sys
path, field, min_val = sys.argv[1], sys.argv[2], float(sys.argv[3])
with open(path, 'r', encoding='utf-8') as f:
    obj = json.load(f)
value = obj
for part in field.split('.'):
    value = value[part]
if value is None:
    raise SystemExit(f"Expected {field} > {min_val}, got None")
if float(value) <= min_val:
    raise SystemExit(f"Expected {field} > {min_val}, got {value}")
PY
}

assert_file_not_empty() {
	local path="$1"
	[[ -s "${path}" ]] || {
		printf 'FAIL: expected non-empty file: %s\n' "${path}" >&2
		exit 1
	}
}

# time_real_cmd: runs a command, captures stdout to a file, fails on
# non-zero exit, and prints elapsed wall-clock ms.  NO output is
# swallowed -- the caller provides the stdout destination so every
# test can verify actual output afterward.
time_real_cmd() {
	local out_path="$1"
	shift
	local start_ns end_ns
	start_ns="$(python3 -c 'import time; print(time.monotonic_ns())')"
	"$@" > "${out_path}"
	end_ns="$(python3 -c 'import time; print(time.monotonic_ns())')"
	python3 -c "print(($end_ns - $start_ns) / 1e6)"
}

# pi_rpc_session: runs a REAL pi agent (tia pi or stock pi) in RPC
# mode, sends one or more JSONL requests on stdin, captures all JSONL
# responses to a file, and prints elapsed wall-clock ms.
# Usage: pi_rpc_session <out_path> <requests_path> <cmd...>
pi_rpc_session() {
	local out_path="$1"
	local requests_path="$2"
	shift 2
	local start_ns end_ns
	start_ns="$(python3 -c 'import time; print(time.monotonic_ns())')"
	ANTHROPIC_API_KEY=dummy \
		timeout 30s "$@" "${PI_RPC_FLAGS[@]}" \
		< "${requests_path}" > "${out_path}" 2>/dev/null
	end_ns="$(python3 -c 'import time; print(time.monotonic_ns())')"
	python3 -c "print(($end_ns - $start_ns) / 1e6)"
}

# ────────────────────────────────────────────────────────────
# Prerequisites
# ────────────────────────────────────────────────────────────

printf '[startup 1/20] build fixtures and native helpers\n'
bash "${ROOT_DIR}/bench/build-tool-fixtures.sh" >/dev/null
bash "${ROOT_DIR}/bench/build-native.sh" >/dev/null
bash "${ROOT_DIR}/bench/build-pi-rpc-payloads.sh" >/dev/null
bash "${ROOT_DIR}/bench/build-pi-tool-override-burst.sh" >/dev/null

# Build RPC request payloads that exercise real pi tools.
printf '{"type":"get_state"}\n' > "${TMP_DIR}/rpc-get-state.jsonl"
printf '{"type":"bash","command":"echo REAL_PI_BASH_TEST_SENTINEL"}\n' > "${TMP_DIR}/rpc-bash-echo.jsonl"
printf '{"type":"bash","command":"cat %s/payloads/tiny.txt"}\n' "${ROOT_DIR}" > "${TMP_DIR}/rpc-bash-cat.jsonl"
printf '{"type":"bash","command":"wc -l < %s/payloads/lines-10k.txt"}\n' "${ROOT_DIR}" > "${TMP_DIR}/rpc-bash-wc.jsonl"
# Multi-command: startup + bash tool in one session.
cat > "${TMP_DIR}/rpc-startup-then-bash.jsonl" <<EOF
{"type":"get_state"}
{"type":"bash","command":"echo REAL_PI_BASH_TEST_SENTINEL"}
EOF
# Multi-command: startup + multiple bash calls in one session.
cat > "${TMP_DIR}/rpc-multi-bash.jsonl" <<EOF
{"type":"get_state"}
{"type":"bash","command":"cat ${ROOT_DIR}/payloads/tiny.txt"}
{"type":"bash","command":"wc -l < ${ROOT_DIR}/payloads/lines-10k.txt"}
{"type":"bash","command":"cp ${ROOT_DIR}/payloads/tiny.txt ${TMP_DIR}/rpc-bash-copied.txt && echo COPY_OK"}
EOF

# ────────────────────────────────────────────────────────────
# Stage 1: Native binary cold-start latency
# Each native binary runs on REAL payloads and we verify both
# the output correctness AND the wall-clock time.
# ────────────────────────────────────────────────────────────

NATIVE_BUDGET_MS=150

printf '[startup 2/20] native fastdrain cold-start on tiny payload\n'
ms="$(time_real_cmd "${TMP_DIR}/drain-out.txt" "${ROOT_DIR}/bin/fastdrain" "${ROOT_DIR}/payloads/tiny.txt")"
assert_latency_under_ms "fastdrain-tiny" "${ms}" "${NATIVE_BUDGET_MS}"
# fastdrain reads the whole file; verify it ran by also draining the
# real 5MB payload and confirming exit 0 (already guaranteed by set -e).
"${ROOT_DIR}/bin/fastdrain" "${ROOT_DIR}/payloads/jsonl-5m.txt"

printf '[startup 3/20] native fastcopy cold-start on tiny payload\n'
ms="$(time_real_cmd "${TMP_DIR}/fastcopy-tiny.json" "${ROOT_DIR}/bin/fastcopy" "${ROOT_DIR}/payloads/tiny.txt" "${TMP_DIR}/copy-tiny.txt")"
assert_latency_under_ms "fastcopy-tiny" "${ms}" "${NATIVE_BUDGET_MS}"
cmp -s "${ROOT_DIR}/payloads/tiny.txt" "${TMP_DIR}/copy-tiny.txt"
assert_json_field_eq "${TMP_DIR}/fastcopy-tiny.json" "ok" "True"

printf '[startup 4/20] native fastread-window cold-start on tiny payload\n'
ms="$(time_real_cmd "${TMP_DIR}/fastread-tiny.txt" "${ROOT_DIR}/bin/fastread-window" "${ROOT_DIR}/payloads/tiny.txt" 1 10)"
assert_latency_under_ms "fastread-tiny" "${ms}" "${NATIVE_BUDGET_MS}"
rg --fixed-strings "hello stdin" "${TMP_DIR}/fastread-tiny.txt" >/dev/null

printf '[startup 5/20] native fastedit cold-start on real 10k-line file\n'
cp "${ROOT_DIR}/payloads/lines-10k.txt" "${TMP_DIR}/edit-startup.txt"
ms="$(time_real_cmd "${TMP_DIR}/fastedit-startup.json" "${ROOT_DIR}/bin/fastedit" "${TMP_DIR}/edit-startup.txt" "${ROOT_DIR}/payloads/edit-old.txt" "${ROOT_DIR}/payloads/edit-new.txt")"
assert_latency_under_ms "fastedit-startup" "${ms}" "${NATIVE_BUDGET_MS}"
rg --fixed-strings "line-4500-updated" "${TMP_DIR}/edit-startup.txt" >/dev/null
assert_json_field_eq "${TMP_DIR}/fastedit-startup.json" "ok" "True"

# ────────────────────────────────────────────────────────────
# Stage 2: REAL tia pi RPC startup latency
# Launches the REAL tia pi compiled binary in RPC mode, sends
# a get_state request, and measures time to first response.
# This exercises the real bun runtime, real pi module loading,
# real extension discovery, and real session creation.
# ────────────────────────────────────────────────────────────

TIA_PI_RPC_BUDGET_MS=8000

printf '[startup 6/20] real tia pi RPC startup (get_state)\n'
ms="$(pi_rpc_session "${TMP_DIR}/tia-rpc-startup.jsonl" "${TMP_DIR}/rpc-get-state.jsonl" tia pi)"
assert_latency_under_ms "tia-pi-rpc-startup" "${ms}" "${TIA_PI_RPC_BUDGET_MS}"
python3 - <<'PY' "${TMP_DIR}/tia-rpc-startup.jsonl"
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    line = f.readline().strip()
assert line, "Empty response from tia pi RPC"
obj = json.loads(line)
assert obj['type'] == 'response', f"Expected type=response, got {obj['type']}"
assert obj['command'] == 'get_state', f"Expected command=get_state, got {obj['command']}"
assert obj['success'] is True, f"get_state failed: {obj.get('error')}"
assert 'data' in obj and 'model' in obj['data'], "Missing model in get_state response"
PY

# ────────────────────────────────────────────────────────────
# Stage 3: REAL stock pi RPC startup latency (baseline)
# Same test but through the stock (non-tia) pi binary so we
# can compare in Stage 4.
# ────────────────────────────────────────────────────────────

STOCK_PI_RPC_BUDGET_MS=15000

printf '[startup 7/20] real stock pi RPC startup (get_state)\n'
ms_stock="$(pi_rpc_session "${TMP_DIR}/stock-rpc-startup.jsonl" "${TMP_DIR}/rpc-get-state.jsonl" pi)"
assert_latency_under_ms "stock-pi-rpc-startup" "${ms_stock}" "${STOCK_PI_RPC_BUDGET_MS}"
python3 - <<'PY' "${TMP_DIR}/stock-rpc-startup.jsonl"
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    line = f.readline().strip()
assert line, "Empty response from stock pi RPC"
obj = json.loads(line)
assert obj['type'] == 'response'
assert obj['command'] == 'get_state'
assert obj['success'] is True, f"get_state failed: {obj.get('error')}"
PY

# ────────────────────────────────────────────────────────────
# Stage 4: tia pi must be faster than stock pi
# The whole point of tia: compiled startup is faster.
# ────────────────────────────────────────────────────────────

printf '[startup 8/20] real tia pi RPC startup < real stock pi RPC startup\n'
python3 - <<PY "${ms}" "${ms_stock}"
import sys
tia_ms, stock_ms = float(sys.argv[1]), float(sys.argv[2])
print(f"  tia pi RPC startup:   {tia_ms:.0f}ms")
print(f"  stock pi RPC startup: {stock_ms:.0f}ms")
assert tia_ms < stock_ms, (
    f"FAIL: tia pi ({tia_ms:.0f}ms) should be faster than stock pi ({stock_ms:.0f}ms)"
)
PY

# ────────────────────────────────────────────────────────────
# Stage 5: REAL tia pi RPC bash tool execution
# Sends a bash command through the REAL pi RPC protocol.
# This goes through tia wrapper -> compiled pi binary ->
# extension loader -> fast-tools-extension.ts bash override
# -> real shell execution.  We verify the real command output.
# ────────────────────────────────────────────────────────────

TIA_PI_BASH_BUDGET_MS=10000

printf '[startup 9/20] real tia pi RPC bash tool (echo sentinel)\n'
ms="$(pi_rpc_session "${TMP_DIR}/tia-rpc-bash-echo.jsonl" "${TMP_DIR}/rpc-bash-echo.jsonl" tia pi)"
assert_latency_under_ms "tia-pi-rpc-bash-echo" "${ms}" "${TIA_PI_BASH_BUDGET_MS}"
python3 - <<'PY' "${TMP_DIR}/tia-rpc-bash-echo.jsonl"
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    line = f.readline().strip()
assert line, "Empty response from tia pi RPC bash"
obj = json.loads(line)
assert obj['type'] == 'response', f"Expected type=response, got {obj['type']}"
assert obj['command'] == 'bash', f"Expected command=bash, got {obj['command']}"
assert obj['success'] is True, f"bash failed: {obj.get('error')}"
assert obj['data']['exitCode'] == 0, f"bash exit code: {obj['data']['exitCode']}"
assert 'REAL_PI_BASH_TEST_SENTINEL' in obj['data']['output'], (
    f"Missing sentinel in bash output: {obj['data']['output']!r}"
)
PY

printf '[startup 10/20] real tia pi RPC bash tool (cat real payload)\n'
ms="$(pi_rpc_session "${TMP_DIR}/tia-rpc-bash-cat.jsonl" "${TMP_DIR}/rpc-bash-cat.jsonl" tia pi)"
assert_latency_under_ms "tia-pi-rpc-bash-cat" "${ms}" "${TIA_PI_BASH_BUDGET_MS}"
python3 - <<'PY' "${TMP_DIR}/tia-rpc-bash-cat.jsonl"
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    line = f.readline().strip()
obj = json.loads(line)
assert obj['success'] is True, f"bash cat failed: {obj.get('error')}"
assert obj['data']['exitCode'] == 0
assert 'hello stdin' in obj['data']['output'], (
    f"Missing payload content in bash output: {obj['data']['output']!r}"
)
PY

printf '[startup 11/20] real tia pi RPC bash tool (wc on real 10k-line file)\n'
ms="$(pi_rpc_session "${TMP_DIR}/tia-rpc-bash-wc.jsonl" "${TMP_DIR}/rpc-bash-wc.jsonl" tia pi)"
assert_latency_under_ms "tia-pi-rpc-bash-wc" "${ms}" "${TIA_PI_BASH_BUDGET_MS}"
python3 - <<'PY' "${TMP_DIR}/tia-rpc-bash-wc.jsonl"
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    line = f.readline().strip()
obj = json.loads(line)
assert obj['success'] is True, f"bash wc failed: {obj.get('error')}"
assert obj['data']['exitCode'] == 0
assert '10000' in obj['data']['output'], (
    f"Expected 10000 lines, got: {obj['data']['output']!r}"
)
PY

# ────────────────────────────────────────────────────────────
# Stage 6: REAL tia pi multi-command RPC session
# Sends get_state + multiple bash commands in a SINGLE pi RPC
# session, verifying that the real pi processes all commands
# sequentially through its real JSONL pipeline.
# ────────────────────────────────────────────────────────────

TIA_PI_MULTI_BUDGET_MS=12000

printf '[startup 12/20] real tia pi multi-command RPC session (get_state + 3 bash)\n'
ms="$(pi_rpc_session "${TMP_DIR}/tia-rpc-multi.jsonl" "${TMP_DIR}/rpc-multi-bash.jsonl" tia pi)"
assert_latency_under_ms "tia-pi-rpc-multi" "${ms}" "${TIA_PI_MULTI_BUDGET_MS}"
python3 - <<'PY' "${TMP_DIR}/tia-rpc-multi.jsonl"
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    lines = [l.strip() for l in f if l.strip()]
assert len(lines) == 4, f"Expected 4 responses, got {len(lines)}"

r0 = json.loads(lines[0])
assert r0['command'] == 'get_state' and r0['success'] is True

r1 = json.loads(lines[1])
assert r1['command'] == 'bash' and r1['success'] is True
assert r1['data']['exitCode'] == 0
assert 'hello stdin' in r1['data']['output']

r2 = json.loads(lines[2])
assert r2['command'] == 'bash' and r2['success'] is True
assert r2['data']['exitCode'] == 0
assert '10000' in r2['data']['output']

r3 = json.loads(lines[3])
assert r3['command'] == 'bash' and r3['success'] is True
assert r3['data']['exitCode'] == 0
assert 'COPY_OK' in r3['data']['output']
PY
# Verify the copy made by the real pi bash tool is byte-identical.
cmp -s "${ROOT_DIR}/payloads/tiny.txt" "${TMP_DIR}/rpc-bash-copied.txt"

# ────────────────────────────────────────────────────────────
# Stage 7: REAL tia pi --version through wrapper
# ────────────────────────────────────────────────────────────

WRAPPER_BUDGET_MS=5000

printf '[startup 13/20] real tia pi --version (full wrapper path)\n'
if command -v tia >/dev/null 2>&1; then
	ms="$(time_real_cmd "${TMP_DIR}/tia-version.txt" tia pi --version)"
	assert_latency_under_ms "tia-wrapper" "${ms}" "${WRAPPER_BUDGET_MS}"
	assert_file_not_empty "${TMP_DIR}/tia-version.txt"
else
	printf 'skipped (tia not on PATH)\n'
fi

# ────────────────────────────────────────────────────────────
# Stage 8: Compiled harness cold-start (sanity check that the
# benchmark tooling itself starts quickly on real payloads)
# ────────────────────────────────────────────────────────────

COMPILED_BUDGET_MS=4000

printf '[startup 14/20] compiled burst harness cold-start (fast read x1 on real 5MB payload)\n'
ms="$(time_real_cmd "${TMP_DIR}/burst-coldstart.json" "${ROOT_DIR}/bin/pi-tool-override-burst" fast read 1)"
assert_latency_under_ms "burst-coldstart" "${ms}" "${COMPILED_BUDGET_MS}"
assert_json_field_eq "${TMP_DIR}/burst-coldstart.json" "mode" "fast"
assert_json_field_eq "${TMP_DIR}/burst-coldstart.json" "tool" "read"
assert_json_field_eq "${TMP_DIR}/burst-coldstart.json" "iterations" "1"
assert_json_field_gt "${TMP_DIR}/burst-coldstart.json" "elapsedMs" "0"

printf '[startup 15/20] compiled stream harness cold-start (fast read x1 on real 5MB payload)\n'
ms="$(time_real_cmd "${TMP_DIR}/stream-coldstart.json" "${ROOT_DIR}/bin/pi-tool-override-stream-burst" fast read 1)"
assert_latency_under_ms "stream-coldstart" "${ms}" "${COMPILED_BUDGET_MS}"
assert_json_field_eq "${TMP_DIR}/stream-coldstart.json" "mode" "fast"
assert_json_field_eq "${TMP_DIR}/stream-coldstart.json" "tool" "read"
assert_json_field_eq "${TMP_DIR}/stream-coldstart.json" "iterations" "1"
assert_json_field_gt "${TMP_DIR}/stream-coldstart.json" "elapsedMs" "0"
assert_json_field_gt "${TMP_DIR}/stream-coldstart.json" "updatesPerIteration" "0"

# ────────────────────────────────────────────────────────────
# Stage 9: Daemon latency (real daemon, real tool calls)
# ────────────────────────────────────────────────────────────

DAEMON_READY_BUDGET_MS=4000
FIRST_RESPONSE_BUDGET_MS=3000

printf '[startup 16/20] daemon ready + first-response latency (real daemon, real read)\n'
"${ROOT_DIR}/bin/pi-tool-request-loop" daemon fast read 1 > "${TMP_DIR}/daemon-ready.json"
assert_json_field_eq "${TMP_DIR}/daemon-ready.json" "transport" "daemon"
assert_json_field_eq "${TMP_DIR}/daemon-ready.json" "mode" "fast"
assert_json_field_eq "${TMP_DIR}/daemon-ready.json" "tool" "read"
assert_json_field_eq "${TMP_DIR}/daemon-ready.json" "iterations" "1"
python3 - <<'PY' "${TMP_DIR}/daemon-ready.json" "${DAEMON_READY_BUDGET_MS}" "${FIRST_RESPONSE_BUDGET_MS}"
import json, sys
path, ready_budget, first_budget = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
with open(path, 'r', encoding='utf-8') as f:
    obj = json.load(f)
ready_ms = obj['daemonReadyMs']
first_ms = obj['firstResponseMs']
assert ready_ms is not None and ready_ms >= 0
assert first_ms is not None and first_ms >= 0
assert obj['perIterationMs'] > 0, "perIterationMs must be positive (real work)"
assert obj['elapsedMs'] > 0, "elapsedMs must be positive (real work)"
if ready_ms > ready_budget:
    raise SystemExit(f"FAIL daemon ready: {ready_ms:.1f}ms > {ready_budget:.0f}ms")
if first_ms > first_budget:
    raise SystemExit(f"FAIL daemon first response: {first_ms:.1f}ms > {first_budget:.0f}ms")
PY

# ────────────────────────────────────────────────────────────
# Stage 10: Hyperfine — REAL tia pi vs stock pi RPC startup
# Uses hyperfine for statistically rigorous comparison of the
# REAL tia pi compiled binary vs the REAL stock pi, both
# through the full RPC startup path with a real get_state.
# ────────────────────────────────────────────────────────────

printf '[startup 17/20] hyperfine: real tia pi vs stock pi RPC startup\n'
hyperfine \
	--shell=none \
	--warmup 1 \
	--runs 4 \
	--export-json "${TMP_DIR}/rpc-startup-bench.json" \
	--command-name 'stock pi (node)' \
	"bash -c 'ANTHROPIC_API_KEY=dummy timeout 25s pi ${PI_RPC_FLAGS[*]} < ${TMP_DIR}/rpc-get-state.jsonl > /dev/null 2>&1'" \
	--command-name 'tia pi (compiled)' \
	"bash -c 'ANTHROPIC_API_KEY=dummy timeout 25s tia pi ${PI_RPC_FLAGS[*]} < ${TMP_DIR}/rpc-get-state.jsonl > /dev/null 2>&1'" \
	>/dev/null
python3 - <<'PY' "${TMP_DIR}/rpc-startup-bench.json"
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    obj = json.load(f)
results = {item['command']: item['mean'] for item in obj['results']}
stock_s = results.get('stock pi (node)')
tia_s = results.get('tia pi (compiled)')
assert stock_s is not None and tia_s is not None
print(f"  stock pi RPC: {stock_s*1000:.0f}ms")
print(f"  tia pi RPC:   {tia_s*1000:.0f}ms")
print(f"  speedup:      {stock_s/tia_s:.2f}x")
assert tia_s < stock_s, (
    f"FAIL: tia pi ({tia_s*1000:.0f}ms) must be faster than stock pi ({stock_s*1000:.0f}ms)"
)
PY

# ────────────────────────────────────────────────────────────
# Stage 11: Hyperfine — native binary micro-benchmarks
# ────────────────────────────────────────────────────────────

printf '[startup 18/20] hyperfine native cold-start on real payloads\n'
hyperfine \
	--shell=none \
	--warmup 2 \
	--runs 6 \
	--export-json "${TMP_DIR}/native-startup.json" \
	--command-name 'fastdrain (tiny)' \
	"${ROOT_DIR}/bin/fastdrain ${ROOT_DIR}/payloads/tiny.txt" \
	--command-name 'fastcopy (tiny)' \
	"${ROOT_DIR}/bin/fastcopy ${ROOT_DIR}/payloads/tiny.txt ${TMP_DIR}/hf-copy.txt" \
	--command-name 'fastread-window (tiny)' \
	"${ROOT_DIR}/bin/fastread-window ${ROOT_DIR}/payloads/tiny.txt 1 10" \
	>/dev/null
python3 - <<'PY' "${TMP_DIR}/native-startup.json"
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    obj = json.load(f)
for item in obj['results']:
    mean_ms = item['mean'] * 1000
    name = item['command']
    for code in item.get('exit_codes', []):
        assert code == 0, f"FAIL {name}: non-zero exit code {code}"
    if mean_ms > 100:
        raise SystemExit(f"FAIL {name}: mean {mean_ms:.1f}ms > 100ms")
    print(f"  {name}: {mean_ms:.1f}ms")
PY
cmp -s "${ROOT_DIR}/payloads/tiny.txt" "${TMP_DIR}/hf-copy.txt"

# ────────────────────────────────────────────────────────────
# Stage 12: Daemon amortization (real tool calls)
# ────────────────────────────────────────────────────────────

printf '[startup 19/20] daemon amortization: real warm per-request < real cold per-spawn\n'
"${ROOT_DIR}/bin/pi-tool-request-loop" spawn fast read 3 > "${TMP_DIR}/spawn-loop.json"
"${ROOT_DIR}/bin/pi-tool-request-loop" daemon fast read 3 > "${TMP_DIR}/daemon-loop.json"
assert_json_field_eq "${TMP_DIR}/spawn-loop.json" "transport" "spawn"
assert_json_field_eq "${TMP_DIR}/spawn-loop.json" "mode" "fast"
assert_json_field_eq "${TMP_DIR}/spawn-loop.json" "tool" "read"
assert_json_field_eq "${TMP_DIR}/spawn-loop.json" "iterations" "3"
assert_json_field_gt "${TMP_DIR}/spawn-loop.json" "elapsedMs" "0"
assert_json_field_eq "${TMP_DIR}/daemon-loop.json" "transport" "daemon"
assert_json_field_eq "${TMP_DIR}/daemon-loop.json" "mode" "fast"
assert_json_field_eq "${TMP_DIR}/daemon-loop.json" "tool" "read"
assert_json_field_eq "${TMP_DIR}/daemon-loop.json" "iterations" "3"
assert_json_field_gt "${TMP_DIR}/daemon-loop.json" "elapsedMs" "0"
python3 - <<'PY' "${TMP_DIR}/spawn-loop.json" "${TMP_DIR}/daemon-loop.json"
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    spawn = json.load(f)
with open(sys.argv[2], 'r', encoding='utf-8') as f:
    daemon = json.load(f)
spawn_per = spawn['perIterationMs']
daemon_per = daemon['perIterationMs']
print(f"  spawn per-iter:  {spawn_per:.1f}ms")
print(f"  daemon per-iter: {daemon_per:.1f}ms")
assert spawn_per > 0 and daemon_per > 0
assert daemon_per < spawn_per, (
    f"FAIL daemon amortization: daemon {daemon_per:.1f}ms >= spawn {spawn_per:.1f}ms"
)
PY

# ────────────────────────────────────────────────────────────
# Stage 13: REAL tia pi RPC bash through hyperfine
# Statistically measures the full end-to-end latency of
# launching tia pi in RPC mode and executing a real bash
# command vs the stock pi doing the same.
# ────────────────────────────────────────────────────────────

printf '[startup 20/20] hyperfine: real tia pi vs stock pi RPC bash tool\n'
# NOTE: the RPC "bash" command goes through pi's built-in bash executor,
# NOT through the fast-tools extension (which only applies to model-triggered
# tool calls).  So the startup speedup is the dominant factor here; the tool
# execution time is identical.  We verify both complete successfully and
# report the comparison, but only the pure startup speedup (test 17) is
# asserted.
hyperfine \
	--shell=none \
	--warmup 1 \
	--runs 3 \
	--export-json "${TMP_DIR}/rpc-bash-bench.json" \
	--command-name 'stock pi bash' \
	"bash -c 'ANTHROPIC_API_KEY=dummy timeout 25s pi ${PI_RPC_FLAGS[*]} < ${TMP_DIR}/rpc-bash-echo.jsonl > /dev/null 2>&1'" \
	--command-name 'tia pi bash' \
	"bash -c 'ANTHROPIC_API_KEY=dummy timeout 25s tia pi ${PI_RPC_FLAGS[*]} < ${TMP_DIR}/rpc-bash-echo.jsonl > /dev/null 2>&1'" \
	>/dev/null
python3 - <<'PY' "${TMP_DIR}/rpc-bash-bench.json"
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    obj = json.load(f)
results = {item['command']: item['mean'] for item in obj['results']}
stock_s = results.get('stock pi bash')
tia_s = results.get('tia pi bash')
assert stock_s is not None and stock_s > 0, "stock pi bash did not complete"
assert tia_s is not None and tia_s > 0, "tia pi bash did not complete"
# Verify all runs exited successfully.
for item in obj['results']:
    for code in item.get('exit_codes', []):
        assert code == 0, f"FAIL {item['command']}: non-zero exit code {code}"
print(f"  stock pi bash: {stock_s*1000:.0f}ms")
print(f"  tia pi bash:   {tia_s*1000:.0f}ms")
print(f"  ratio:         {stock_s/tia_s:.2f}x")
PY

bash "${ROOT_DIR}/bench/cleanup-processes.sh" >/dev/null

printf 'Startup latency tests passed.\n'
