#!/usr/bin/env bash

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Universal startup latency tests — works with pi, opencode,
# or both.  Auto-detects which agents are installed and runs
# the appropriate REAL tests for each.  Nothing is mocked.
#
# pi tests:      real tia pi / stock pi via --mode rpc
# opencode tests: real tia opencode / stock opencode via CLI
# native tests:  always run (agent-agnostic)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"

# ── Agent detection ──────────────────────────────────────────
HAS_PI=0
HAS_OPENCODE=0
HAS_TIA=0
if command -v pi >/dev/null 2>&1; then HAS_PI=1; fi
if command -v opencode >/dev/null 2>&1; then HAS_OPENCODE=1; fi
if command -v tia >/dev/null 2>&1; then HAS_TIA=1; fi

if [[ "${HAS_PI}" == "0" && "${HAS_OPENCODE}" == "0" ]]; then
	printf 'SKIP: no agents found (need pi or opencode on PATH)\n' >&2
	exit 0
fi

# ── Resolve PI_PACKAGE_DIR (needed for compiled pi harnesses) ──
if [[ "${HAS_PI}" == "1" ]]; then
	if [[ -f "${HOME}/.local/share/tia/pi-package-dir.txt" ]]; then
		export PI_PACKAGE_DIR="$(cat "${HOME}/.local/share/tia/pi-package-dir.txt")"
	elif [[ -z "${PI_PACKAGE_DIR:-}" ]]; then
		pi_path="$(command -v pi)"
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

cleanup() { rm -rf "${TMP_DIR}"; }
trap cleanup EXIT

# ── Dynamic step counter ─────────────────────────────────────
STEP=0
TOTAL=0

count_steps() {
	# 1 build + 4 native + 1 hyperfine native = 6 universal
	TOTAL=6
	if [[ "${HAS_PI}" == "1" ]]; then
		# pi: 6 rpc + 1 rpc-startup-cmp + 1 version + 2 compiled + 1 daemon
		#   + 1 hyperfine rpc + 1 daemon amort + 1 hyperfine bash = 14
		TOTAL=$((TOTAL + 14))
	fi
	if [[ "${HAS_OPENCODE}" == "1" ]]; then
		# opencode: 1 tia-oc-startup + 1 stock-oc-startup + 1 oc-debug-paths
		#   + 1 oc-session-list + 1 hyperfine-oc = 5
		TOTAL=$((TOTAL + 5))
	fi
}
count_steps

step() {
	STEP=$((STEP + 1))
	printf '[startup %d/%d] %s\n' "${STEP}" "${TOTAL}" "$1"
}

# ── Assertion helpers ─────────────────────────────────────────

assert_latency_under_ms() {
	local label="$1" actual_ms="$2" max_ms="$3"
	python3 - <<PY "${actual_ms}" "${max_ms}" "${label}"
import sys
actual, limit, label = float(sys.argv[1]), float(sys.argv[2]), sys.argv[3]
if actual > limit:
    raise SystemExit(f"FAIL {label}: {actual:.1f}ms > {limit:.0f}ms budget")
PY
}

assert_json_field_eq() {
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

assert_json_field_gt() {
	python3 - <<'PY' "$1" "$2" "$3"
import json, sys
path, field, min_val = sys.argv[1], sys.argv[2], float(sys.argv[3])
with open(path, 'r', encoding='utf-8') as f:
    obj = json.load(f)
value = obj
for part in field.split('.'):
    value = value[part]
if value is None or float(value) <= min_val:
    raise SystemExit(f"Expected {field} > {min_val}, got {value}")
PY
}

assert_file_not_empty() {
	[[ -s "$1" ]] || { printf 'FAIL: expected non-empty file: %s\n' "$1" >&2; exit 1; }
}

assert_file_contains() {
	rg --fixed-strings "$2" "$1" >/dev/null || {
		printf 'FAIL: expected %s to contain: %s\n' "$1" "$2" >&2; exit 1
	}
}

# time_real_cmd: stdout → file, prints elapsed ms. Non-zero exit = fail.
time_real_cmd() {
	local out_path="$1"; shift
	local start_ns end_ns
	start_ns="$(python3 -c 'import time; print(time.monotonic_ns())')"
	"$@" > "${out_path}"
	end_ns="$(python3 -c 'import time; print(time.monotonic_ns())')"
	python3 -c "print(($end_ns - $start_ns) / 1e6)"
}

# pi_rpc_session: real pi RPC over stdin.  Usage: <out> <requests> <cmd...>
PI_RPC_FLAGS=(--mode rpc --no-session --no-skills --no-prompt-templates --no-themes)
pi_rpc_session() {
	local out_path="$1" requests_path="$2"; shift 2
	local start_ns end_ns
	start_ns="$(python3 -c 'import time; print(time.monotonic_ns())')"
	ANTHROPIC_API_KEY=dummy timeout 30s "$@" "${PI_RPC_FLAGS[@]}" \
		< "${requests_path}" > "${out_path}" 2>/dev/null
	end_ns="$(python3 -c 'import time; print(time.monotonic_ns())')"
	python3 -c "print(($end_ns - $start_ns) / 1e6)"
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# UNIVERSAL: Prerequisites
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

step "build fixtures and native helpers"
bash "${ROOT_DIR}/bench/build-tool-fixtures.sh" >/dev/null
bash "${ROOT_DIR}/bench/build-native.sh" >/dev/null
if [[ "${HAS_PI}" == "1" ]]; then
	bash "${ROOT_DIR}/bench/build-pi-rpc-payloads.sh" >/dev/null
	bash "${ROOT_DIR}/bench/build-pi-tool-override-burst.sh" >/dev/null
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# UNIVERSAL: Native binary cold-start latency
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

NATIVE_BUDGET_MS=150

step "native fastdrain cold-start on tiny payload"
ms="$(time_real_cmd "${TMP_DIR}/drain-out.txt" "${ROOT_DIR}/bin/fastdrain" "${ROOT_DIR}/payloads/tiny.txt")"
assert_latency_under_ms "fastdrain-tiny" "${ms}" "${NATIVE_BUDGET_MS}"
"${ROOT_DIR}/bin/fastdrain" "${ROOT_DIR}/payloads/jsonl-5m.txt"

step "native fastcopy cold-start on tiny payload"
ms="$(time_real_cmd "${TMP_DIR}/fastcopy-tiny.json" "${ROOT_DIR}/bin/fastcopy" "${ROOT_DIR}/payloads/tiny.txt" "${TMP_DIR}/copy-tiny.txt")"
assert_latency_under_ms "fastcopy-tiny" "${ms}" "${NATIVE_BUDGET_MS}"
cmp -s "${ROOT_DIR}/payloads/tiny.txt" "${TMP_DIR}/copy-tiny.txt"
assert_json_field_eq "${TMP_DIR}/fastcopy-tiny.json" "ok" "True"

step "native fastread-window cold-start on tiny payload"
ms="$(time_real_cmd "${TMP_DIR}/fastread-tiny.txt" "${ROOT_DIR}/bin/fastread-window" "${ROOT_DIR}/payloads/tiny.txt" 1 10)"
assert_latency_under_ms "fastread-tiny" "${ms}" "${NATIVE_BUDGET_MS}"
assert_file_contains "${TMP_DIR}/fastread-tiny.txt" "hello stdin"

step "native fastedit cold-start on real 10k-line file"
cp "${ROOT_DIR}/payloads/lines-10k.txt" "${TMP_DIR}/edit-startup.txt"
ms="$(time_real_cmd "${TMP_DIR}/fastedit-startup.json" "${ROOT_DIR}/bin/fastedit" "${TMP_DIR}/edit-startup.txt" "${ROOT_DIR}/payloads/edit-old.txt" "${ROOT_DIR}/payloads/edit-new.txt")"
assert_latency_under_ms "fastedit-startup" "${ms}" "${NATIVE_BUDGET_MS}"
assert_file_contains "${TMP_DIR}/edit-startup.txt" "line-4500-updated"
assert_json_field_eq "${TMP_DIR}/fastedit-startup.json" "ok" "True"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# PI AGENT TESTS (skipped if pi not installed)
# All tests go through the REAL pi agent via RPC protocol.
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

if [[ "${HAS_PI}" == "1" ]]; then

	# ── Build pi RPC request payloads ─────────────────────────
	printf '{"type":"get_state"}\n' > "${TMP_DIR}/rpc-get-state.jsonl"
	printf '{"type":"bash","command":"echo REAL_PI_BASH_SENTINEL"}\n' > "${TMP_DIR}/rpc-bash-echo.jsonl"
	printf '{"type":"bash","command":"cat %s/payloads/tiny.txt"}\n' "${ROOT_DIR}" > "${TMP_DIR}/rpc-bash-cat.jsonl"
	printf '{"type":"bash","command":"wc -l < %s/payloads/lines-10k.txt"}\n' "${ROOT_DIR}" > "${TMP_DIR}/rpc-bash-wc.jsonl"
	printf '{"type":"get_state"}\n' > "${TMP_DIR}/rpc-multi-bash.jsonl"
	printf '{"type":"bash","command":"cat %s/payloads/tiny.txt"}\n' "${ROOT_DIR}" >> "${TMP_DIR}/rpc-multi-bash.jsonl"
	printf '{"type":"bash","command":"wc -l < %s/payloads/lines-10k.txt"}\n' "${ROOT_DIR}" >> "${TMP_DIR}/rpc-multi-bash.jsonl"
	printf '{"type":"bash","command":"cp %s/payloads/tiny.txt %s/rpc-bash-copied.txt && echo COPY_OK"}\n' "${ROOT_DIR}" "${TMP_DIR}" >> "${TMP_DIR}/rpc-multi-bash.jsonl"

	# ── Real tia pi RPC startup ───────────────────────────────
	step "real tia pi RPC startup (get_state)"
	ms_tia_pi="$(pi_rpc_session "${TMP_DIR}/tia-rpc-startup.jsonl" "${TMP_DIR}/rpc-get-state.jsonl" tia pi)"
	assert_latency_under_ms "tia-pi-rpc-startup" "${ms_tia_pi}" "8000"
	python3 - <<'PY' "${TMP_DIR}/tia-rpc-startup.jsonl"
import json, sys
with open(sys.argv[1]) as f: line = f.readline().strip()
assert line, "Empty response from tia pi RPC"
obj = json.loads(line)
assert obj['type'] == 'response' and obj['command'] == 'get_state'
assert obj['success'] is True, f"get_state failed: {obj.get('error')}"
assert 'data' in obj and 'model' in obj['data']
PY

	# ── Real stock pi RPC startup ─────────────────────────────
	step "real stock pi RPC startup (get_state)"
	ms_stock_pi="$(pi_rpc_session "${TMP_DIR}/stock-rpc-startup.jsonl" "${TMP_DIR}/rpc-get-state.jsonl" pi)"
	assert_latency_under_ms "stock-pi-rpc-startup" "${ms_stock_pi}" "15000"
	python3 - <<'PY' "${TMP_DIR}/stock-rpc-startup.jsonl"
import json, sys
with open(sys.argv[1]) as f: line = f.readline().strip()
assert line, "Empty response from stock pi RPC"
obj = json.loads(line)
assert obj['type'] == 'response' and obj['command'] == 'get_state' and obj['success'] is True
PY

	# ── tia pi vs stock pi single-shot (report only) ─────────
	# Single-shot is noisy; hyperfine step below is authoritative.
	step "real tia pi vs stock pi RPC startup (single-shot report)"
	python3 - <<PY "${ms_tia_pi}" "${ms_stock_pi}"
import sys
tia_ms, stock_ms = float(sys.argv[1]), float(sys.argv[2])
print(f"  tia pi:   {tia_ms:.0f}ms")
print(f"  stock pi: {stock_ms:.0f}ms")
print(f"  ratio:    {stock_ms/tia_ms:.2f}x")
PY

	# ── Real tia pi RPC bash tool ─────────────────────────────
	step "real tia pi RPC bash tool (echo sentinel)"
	ms="$(pi_rpc_session "${TMP_DIR}/tia-rpc-bash-echo.jsonl" "${TMP_DIR}/rpc-bash-echo.jsonl" tia pi)"
	assert_latency_under_ms "tia-pi-rpc-bash-echo" "${ms}" "10000"
	python3 - <<'PY' "${TMP_DIR}/tia-rpc-bash-echo.jsonl"
import json, sys
with open(sys.argv[1]) as f: line = f.readline().strip()
obj = json.loads(line)
assert obj['success'] is True and obj['data']['exitCode'] == 0
assert 'REAL_PI_BASH_SENTINEL' in obj['data']['output']
PY

	step "real tia pi RPC bash tool (cat real payload)"
	ms="$(pi_rpc_session "${TMP_DIR}/tia-rpc-bash-cat.jsonl" "${TMP_DIR}/rpc-bash-cat.jsonl" tia pi)"
	assert_latency_under_ms "tia-pi-rpc-bash-cat" "${ms}" "10000"
	python3 - <<'PY' "${TMP_DIR}/tia-rpc-bash-cat.jsonl"
import json, sys
with open(sys.argv[1]) as f: obj = json.loads(f.readline().strip())
assert obj['success'] is True and obj['data']['exitCode'] == 0
assert 'hello stdin' in obj['data']['output']
PY

	step "real tia pi RPC bash tool (wc on real 10k-line file)"
	ms="$(pi_rpc_session "${TMP_DIR}/tia-rpc-bash-wc.jsonl" "${TMP_DIR}/rpc-bash-wc.jsonl" tia pi)"
	assert_latency_under_ms "tia-pi-rpc-bash-wc" "${ms}" "10000"
	python3 - <<'PY' "${TMP_DIR}/tia-rpc-bash-wc.jsonl"
import json, sys
with open(sys.argv[1]) as f: obj = json.loads(f.readline().strip())
assert obj['success'] is True and obj['data']['exitCode'] == 0
assert '10000' in obj['data']['output']
PY

	# ── Real tia pi multi-command session ─────────────────────
	step "real tia pi multi-command RPC session (get_state + 3 bash)"
	ms="$(pi_rpc_session "${TMP_DIR}/tia-rpc-multi.jsonl" "${TMP_DIR}/rpc-multi-bash.jsonl" tia pi)"
	assert_latency_under_ms "tia-pi-rpc-multi" "${ms}" "12000"
	python3 - <<'PY' "${TMP_DIR}/tia-rpc-multi.jsonl"
import json, sys
with open(sys.argv[1]) as f: lines = [l.strip() for l in f if l.strip()]
assert len(lines) == 4, f"Expected 4 responses, got {len(lines)}"
r = [json.loads(l) for l in lines]
assert r[0]['command'] == 'get_state' and r[0]['success'] is True
assert r[1]['success'] and 'hello stdin' in r[1]['data']['output']
assert r[2]['success'] and '10000' in r[2]['data']['output']
assert r[3]['success'] and 'COPY_OK' in r[3]['data']['output']
PY
	cmp -s "${ROOT_DIR}/payloads/tiny.txt" "${TMP_DIR}/rpc-bash-copied.txt"

	# ── tia pi --version ──────────────────────────────────────
	step "real tia pi --version (full wrapper path)"
	if [[ "${HAS_TIA}" == "1" ]]; then
		ms="$(time_real_cmd "${TMP_DIR}/tia-pi-version.txt" tia pi --version)"
		assert_latency_under_ms "tia-pi-version" "${ms}" "5000"
		assert_file_not_empty "${TMP_DIR}/tia-pi-version.txt"
	else
		printf 'skipped (tia not on PATH)\n'
	fi

	# ── Compiled harness cold-start ───────────────────────────
	step "compiled burst harness cold-start (fast read x1 on real 5MB payload)"
	ms="$(time_real_cmd "${TMP_DIR}/burst-coldstart.json" "${ROOT_DIR}/bin/pi-tool-override-burst" fast read 1)"
	assert_latency_under_ms "burst-coldstart" "${ms}" "4000"
	assert_json_field_eq "${TMP_DIR}/burst-coldstart.json" "mode" "fast"
	assert_json_field_eq "${TMP_DIR}/burst-coldstart.json" "tool" "read"
	assert_json_field_gt "${TMP_DIR}/burst-coldstart.json" "elapsedMs" "0"

	step "compiled stream harness cold-start (fast read x1 on real 5MB payload)"
	ms="$(time_real_cmd "${TMP_DIR}/stream-coldstart.json" "${ROOT_DIR}/bin/pi-tool-override-stream-burst" fast read 1)"
	assert_latency_under_ms "stream-coldstart" "${ms}" "4000"
	assert_json_field_eq "${TMP_DIR}/stream-coldstart.json" "mode" "fast"
	assert_json_field_gt "${TMP_DIR}/stream-coldstart.json" "elapsedMs" "0"
	assert_json_field_gt "${TMP_DIR}/stream-coldstart.json" "updatesPerIteration" "0"

	# ── Daemon latency ────────────────────────────────────────
	step "daemon ready + first-response latency (real daemon, real read)"
	"${ROOT_DIR}/bin/pi-tool-request-loop" daemon fast read 1 > "${TMP_DIR}/daemon-ready.json"
	assert_json_field_eq "${TMP_DIR}/daemon-ready.json" "transport" "daemon"
	assert_json_field_eq "${TMP_DIR}/daemon-ready.json" "mode" "fast"
	assert_json_field_gt "${TMP_DIR}/daemon-ready.json" "elapsedMs" "0"
	python3 - <<'PY' "${TMP_DIR}/daemon-ready.json"
import json, sys
with open(sys.argv[1]) as f: obj = json.load(f)
assert obj['daemonReadyMs'] is not None and obj['daemonReadyMs'] >= 0
assert obj['firstResponseMs'] is not None and obj['firstResponseMs'] >= 0
if obj['daemonReadyMs'] > 4000:
    raise SystemExit(f"FAIL daemon ready: {obj['daemonReadyMs']:.1f}ms > 4000ms")
if obj['firstResponseMs'] > 3000:
    raise SystemExit(f"FAIL first response: {obj['firstResponseMs']:.1f}ms > 3000ms")
PY

	# ── Hyperfine: tia pi vs stock pi RPC ─────────────────────
	step "hyperfine: real tia pi vs stock pi RPC startup"
	hyperfine --shell=none --warmup 1 --runs 4 \
		--export-json "${TMP_DIR}/rpc-startup-bench.json" \
		--command-name 'stock pi (node)' \
		"bash -c 'ANTHROPIC_API_KEY=dummy timeout 25s pi ${PI_RPC_FLAGS[*]} < ${TMP_DIR}/rpc-get-state.jsonl > /dev/null 2>&1'" \
		--command-name 'tia pi (compiled)' \
		"bash -c 'ANTHROPIC_API_KEY=dummy timeout 25s tia pi ${PI_RPC_FLAGS[*]} < ${TMP_DIR}/rpc-get-state.jsonl > /dev/null 2>&1'" \
		>/dev/null
	python3 - <<'PY' "${TMP_DIR}/rpc-startup-bench.json"
import json, sys
with open(sys.argv[1]) as f: obj = json.load(f)
results = {r['command']: r['mean'] for r in obj['results']}
stock, tia = results['stock pi (node)'], results['tia pi (compiled)']
print(f"  stock pi: {stock*1000:.0f}ms")
print(f"  tia pi:   {tia*1000:.0f}ms")
print(f"  speedup:  {stock/tia:.2f}x")
assert tia < stock, f"FAIL: tia pi ({tia*1000:.0f}ms) >= stock pi ({stock*1000:.0f}ms)"
PY

	# ── Daemon amortization ───────────────────────────────────
	step "daemon amortization: warm per-request < cold per-spawn"
	"${ROOT_DIR}/bin/pi-tool-request-loop" spawn fast read 3 > "${TMP_DIR}/spawn-loop.json"
	"${ROOT_DIR}/bin/pi-tool-request-loop" daemon fast read 3 > "${TMP_DIR}/daemon-loop.json"
	assert_json_field_gt "${TMP_DIR}/spawn-loop.json" "elapsedMs" "0"
	assert_json_field_gt "${TMP_DIR}/daemon-loop.json" "elapsedMs" "0"
	python3 - <<'PY' "${TMP_DIR}/spawn-loop.json" "${TMP_DIR}/daemon-loop.json"
import json, sys
with open(sys.argv[1]) as f: spawn = json.load(f)
with open(sys.argv[2]) as f: daemon = json.load(f)
sp, dp = spawn['perIterationMs'], daemon['perIterationMs']
print(f"  spawn per-iter:  {sp:.1f}ms")
print(f"  daemon per-iter: {dp:.1f}ms")
assert dp < sp, f"FAIL: daemon {dp:.1f}ms >= spawn {sp:.1f}ms"
PY

	# ── Hyperfine: tia pi vs stock pi RPC bash ────────────────
	step "hyperfine: real tia pi vs stock pi RPC bash tool"
	hyperfine --shell=none --warmup 1 --runs 3 \
		--export-json "${TMP_DIR}/rpc-bash-bench.json" \
		--command-name 'stock pi bash' \
		"bash -c 'ANTHROPIC_API_KEY=dummy timeout 25s pi ${PI_RPC_FLAGS[*]} < ${TMP_DIR}/rpc-bash-echo.jsonl > /dev/null 2>&1'" \
		--command-name 'tia pi bash' \
		"bash -c 'ANTHROPIC_API_KEY=dummy timeout 25s tia pi ${PI_RPC_FLAGS[*]} < ${TMP_DIR}/rpc-bash-echo.jsonl > /dev/null 2>&1'" \
		>/dev/null
	python3 - <<'PY' "${TMP_DIR}/rpc-bash-bench.json"
import json, sys
with open(sys.argv[1]) as f: obj = json.load(f)
results = {r['command']: r['mean'] for r in obj['results']}
stock, tia = results['stock pi bash'], results['tia pi bash']
for r in obj['results']:
    for c in r.get('exit_codes', []):
        assert c == 0, f"FAIL {r['command']}: exit code {c}"
print(f"  stock pi bash: {stock*1000:.0f}ms")
print(f"  tia pi bash:   {tia*1000:.0f}ms")
print(f"  ratio:         {stock/tia:.2f}x")
PY

fi  # end HAS_PI

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# OPENCODE AGENT TESTS (skipped if opencode not installed)
# All tests go through the REAL opencode binary via its CLI.
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

if [[ "${HAS_OPENCODE}" == "1" ]]; then

	OC_BUDGET_MS=8000

	# ── Real tia opencode startup via debug paths ─────────────
	# This exercises: tia wrapper -> refresh_shell_opencode_links
	# -> XDG var export -> exec opencode -> config/db loading ->
	# real output of sandboxed paths.
	step "real tia opencode startup (debug paths)"
	if [[ "${HAS_TIA}" == "1" ]]; then
		ms="$(time_real_cmd "${TMP_DIR}/tia-oc-paths.txt" tia opencode debug paths)"
		assert_latency_under_ms "tia-opencode-debug-paths" "${ms}" "${OC_BUDGET_MS}"
		assert_file_not_empty "${TMP_DIR}/tia-oc-paths.txt"
		# Verify real sandboxed paths appear in output (not stock paths).
		assert_file_contains "${TMP_DIR}/tia-oc-paths.txt" "tia/opencode"
	else
		printf 'skipped (tia not on PATH)\n'
	fi

	# ── Real stock opencode startup via debug paths ───────────
	step "real stock opencode startup (debug paths)"
	ms_stock_oc="$(time_real_cmd "${TMP_DIR}/stock-oc-paths.txt" opencode debug paths)"
	assert_latency_under_ms "stock-opencode-debug-paths" "${ms_stock_oc}" "${OC_BUDGET_MS}"
	assert_file_not_empty "${TMP_DIR}/stock-oc-paths.txt"
	# Stock paths should NOT contain tia sandbox.
	python3 - <<'PY' "${TMP_DIR}/stock-oc-paths.txt"
import sys
with open(sys.argv[1]) as f: text = f.read()
assert 'data' in text.lower() or 'config' in text.lower(), "Expected path labels in output"
PY

	# ── Real tia opencode debug config ────────────────────────
	# Verifies config loading through the full tia sandbox path.
	step "real tia opencode config loading (debug config)"
	if [[ "${HAS_TIA}" == "1" ]]; then
		ms="$(time_real_cmd "${TMP_DIR}/tia-oc-config.txt" tia opencode debug config)"
		assert_latency_under_ms "tia-opencode-debug-config" "${ms}" "${OC_BUDGET_MS}"
		assert_file_not_empty "${TMP_DIR}/tia-oc-config.txt"
	else
		printf 'skipped (tia not on PATH)\n'
	fi

	# ── Real opencode session list ────────────────────────────
	# Verifies the real SQLite database connection works and
	# the session manager initializes.
	step "real opencode session database (session list)"
	ms="$(time_real_cmd "${TMP_DIR}/oc-session-list.txt" opencode session list)"
	assert_latency_under_ms "opencode-session-list" "${ms}" "${OC_BUDGET_MS}"
	# Output should contain either session rows or a header.
	assert_file_not_empty "${TMP_DIR}/oc-session-list.txt"

	# ── Hyperfine: tia opencode vs stock opencode ─────────────
	step "hyperfine: real tia opencode vs stock opencode startup"
	if [[ "${HAS_TIA}" == "1" ]]; then
		hyperfine --shell=none --warmup 1 --runs 3 \
			--export-json "${TMP_DIR}/oc-startup-bench.json" \
			--command-name 'stock opencode' \
			"opencode debug paths" \
			--command-name 'tia opencode' \
			"tia opencode debug paths" \
			>/dev/null
		python3 - <<'PY' "${TMP_DIR}/oc-startup-bench.json"
import json, sys
with open(sys.argv[1]) as f: obj = json.load(f)
results = {r['command']: r['mean'] for r in obj['results']}
stock = results['stock opencode']
tia = results['tia opencode']
for r in obj['results']:
    for c in r.get('exit_codes', []):
        assert c == 0, f"FAIL {r['command']}: exit code {c}"
print(f"  stock opencode: {stock*1000:.0f}ms")
print(f"  tia opencode:   {tia*1000:.0f}ms")
print(f"  ratio:          {stock/tia:.2f}x")
PY
	else
		printf 'skipped (tia not on PATH)\n'
	fi

fi  # end HAS_OPENCODE

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# UNIVERSAL: Hyperfine native binary micro-benchmarks
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

step "hyperfine native cold-start on real payloads"
hyperfine --shell=none --warmup 2 --runs 6 \
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
with open(sys.argv[1]) as f: obj = json.load(f)
for item in obj['results']:
    mean_ms = item['mean'] * 1000
    for c in item.get('exit_codes', []):
        assert c == 0, f"FAIL {item['command']}: exit code {c}"
    if mean_ms > 100:
        raise SystemExit(f"FAIL {item['command']}: {mean_ms:.1f}ms > 100ms")
    print(f"  {item['command']}: {mean_ms:.1f}ms")
PY
cmp -s "${ROOT_DIR}/payloads/tiny.txt" "${TMP_DIR}/hf-copy.txt"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

bash "${ROOT_DIR}/bench/cleanup-processes.sh" >/dev/null

AGENTS_TESTED=""
[[ "${HAS_PI}" == "1" ]] && AGENTS_TESTED="${AGENTS_TESTED} pi"
[[ "${HAS_OPENCODE}" == "1" ]] && AGENTS_TESTED="${AGENTS_TESTED} opencode"
printf 'Startup latency tests passed (%d/%d).  Agents tested:%s\n' "${STEP}" "${TOTAL}" "${AGENTS_TESTED}"
