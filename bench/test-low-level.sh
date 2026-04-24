#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
cleanup() {
	rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

assert_file_contains() {
	local path="$1"
	local pattern="$2"
	rg -n --fixed-strings "${pattern}" "${path}" >/dev/null || {
		printf 'Expected %s to contain: %s\n' "${path}" "${pattern}" >&2
		exit 1
	}
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

printf '[low-level 1/12] build fixtures and native helpers\n'
bash "${ROOT_DIR}/bench/build-tool-fixtures.sh" >/dev/null
bash "${ROOT_DIR}/bench/build-native.sh" >/dev/null
bash "${ROOT_DIR}/bench/build-pi-tool-override-burst.sh" >/dev/null

printf '[low-level 2/12] verify native fastcopy exact copy\n'
mkdir -p "${TMP_DIR}/copy"
"${ROOT_DIR}/bin/fastcopy" \
	"${ROOT_DIR}/payloads/jsonl-5m.txt" \
	"${TMP_DIR}/copy/copied.txt" > "${TMP_DIR}/fastcopy.json"
assert_json_field_eq "${TMP_DIR}/fastcopy.json" "ok" "True"
cmp -s "${ROOT_DIR}/payloads/jsonl-5m.txt" "${TMP_DIR}/copy/copied.txt"

printf '[low-level 3/12] verify native fastedit exact replacement\n'
cp "${ROOT_DIR}/payloads/lines-10k.txt" "${TMP_DIR}/edit-target.txt"
"${ROOT_DIR}/bin/fastedit" \
	"${TMP_DIR}/edit-target.txt" \
	"${ROOT_DIR}/payloads/edit-old.txt" \
	"${ROOT_DIR}/payloads/edit-new.txt" > "${TMP_DIR}/fastedit.json"
assert_file_contains "${TMP_DIR}/edit-target.txt" "line-4500-updated"
assert_json_field_eq "${TMP_DIR}/fastedit.json" "ok" "True"

printf '[low-level 4/12] verify native fastread-window exact slice\n'
"${ROOT_DIR}/bin/fastread-window" "${ROOT_DIR}/payloads/lines-10k.txt" 4501 3 > "${TMP_DIR}/fastread-slice.txt"
python3 - <<'PY' "${TMP_DIR}/fastread-slice.txt"
import sys
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    text = f.read()
assert text.startswith('line-4500\nline-4501\nline-4502\n')
assert 'Use offset=4504 to continue.' in text
PY

if [[ -x "${ROOT_DIR}/bin/fastread-window-zigcc" && -x "${ROOT_DIR}/bin/fastedit-zigcc" && -x "${ROOT_DIR}/bin/fastcopy-zigcc" ]]; then
	printf '[low-level zig] verify zig-built native helpers\n'
	"${ROOT_DIR}/bin/fastread-window-zigcc" "${ROOT_DIR}/payloads/lines-10k.txt" 4501 3 > "${TMP_DIR}/fastread-zig-slice.txt"
	cmp -s "${TMP_DIR}/fastread-slice.txt" "${TMP_DIR}/fastread-zig-slice.txt"
	"${ROOT_DIR}/bin/fastcopy-zigcc" \
		"${ROOT_DIR}/payloads/tiny.txt" \
		"${TMP_DIR}/copy/zig-copied.txt" > "${TMP_DIR}/fastcopy-zig.json"
	assert_json_field_eq "${TMP_DIR}/fastcopy-zig.json" "ok" "True"
	cmp -s "${ROOT_DIR}/payloads/tiny.txt" "${TMP_DIR}/copy/zig-copied.txt"
	cp "${ROOT_DIR}/payloads/lines-10k.txt" "${TMP_DIR}/edit-zig-target.txt"
	"${ROOT_DIR}/bin/fastedit-zigcc" \
		"${TMP_DIR}/edit-zig-target.txt" \
		"${ROOT_DIR}/payloads/edit-old.txt" \
		"${ROOT_DIR}/payloads/edit-new.txt" > "${TMP_DIR}/fastedit-zig.json"
	assert_file_contains "${TMP_DIR}/edit-zig-target.txt" "line-4500-updated"
fi

printf '[low-level 5/12] verify compiled fast read runner\n'
"${ROOT_DIR}/bin/pi-tool-override-burst" fast read 2 > "${TMP_DIR}/compiled-read.json"
assert_json_field_eq "${TMP_DIR}/compiled-read.json" "mode" "fast"
assert_json_field_eq "${TMP_DIR}/compiled-read.json" "tool" "read"
assert_json_field_eq "${TMP_DIR}/compiled-read.json" "iterations" "2"

printf '[low-level 6/12] verify compiled fast edit runner\n'
"${ROOT_DIR}/bin/pi-tool-override-burst" fast edit 2 > "${TMP_DIR}/compiled-edit.json"
assert_json_field_eq "${TMP_DIR}/compiled-edit.json" "mode" "fast"
assert_json_field_eq "${TMP_DIR}/compiled-edit.json" "tool" "edit"
assert_json_field_eq "${TMP_DIR}/compiled-edit.json" "iterations" "2"

printf '[low-level 7/12] verify compiled streaming runner\n'
"${ROOT_DIR}/bin/pi-tool-override-stream-burst" fast read 2 > "${TMP_DIR}/compiled-stream.json"
assert_json_field_eq "${TMP_DIR}/compiled-stream.json" "mode" "fast"
assert_json_field_eq "${TMP_DIR}/compiled-stream.json" "tool" "read"
python3 - <<'PY' "${TMP_DIR}/compiled-stream.json"
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    obj = json.load(f)
assert obj['iterations'] == 2
assert obj['updatesPerIteration'] > 0
assert obj['avgFirstUpdateMs'] is not None
assert obj['avgFirstUpdateMs'] >= 0
PY

printf '[low-level 8/12] verify compiled warm daemon loop\n'
"${ROOT_DIR}/bin/pi-tool-request-loop" daemon fast read 4 > "${TMP_DIR}/daemon-read.json"
assert_json_field_eq "${TMP_DIR}/daemon-read.json" "transport" "daemon"
assert_json_field_eq "${TMP_DIR}/daemon-read.json" "mode" "fast"
assert_json_field_eq "${TMP_DIR}/daemon-read.json" "tool" "read"
assert_json_field_eq "${TMP_DIR}/daemon-read.json" "iterations" "4"
python3 - <<'PY' "${TMP_DIR}/daemon-read.json"
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    obj = json.load(f)
assert obj['daemonReadyMs'] is not None
assert obj['firstResponseMs'] is not None
assert obj['firstResponseMs'] >= 0
PY

printf '[low-level 9/12] benchmark compiled vs bun edit path\n'
hyperfine \
	--shell=none \
	--warmup 1 \
	--runs 4 \
	--export-json "${TMP_DIR}/edit-bench.json" \
	--command-name 'stock (bun)' \
	"bun ${ROOT_DIR}/bench/pi-tool-override-burst.ts stock edit 12" \
	--command-name 'fast (bun+native)' \
	"bun ${ROOT_DIR}/bench/pi-tool-override-burst.ts fast edit 12" \
	--command-name 'fast (compiled+native)' \
	"${ROOT_DIR}/bin/pi-tool-override-burst fast edit 12" >/dev/null
python3 - <<'PY' "${TMP_DIR}/edit-bench.json"
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    obj = json.load(f)
results = {item['command']: item['mean'] for item in obj['results']}
assert results['fast (bun+native)'] < results['stock (bun)']
assert results['fast (compiled+native)'] < results['stock (bun)']
PY

printf '[low-level 10/12] benchmark compiled + native bash path\n'
hyperfine \
	--shell=none \
	--warmup 1 \
	--runs 4 \
	--export-json "${TMP_DIR}/bash-bench.json" \
	--command-name 'stock (bun)' \
	"bun ${ROOT_DIR}/bench/pi-tool-override-burst.ts stock bash 8" \
	--command-name 'fast (bun+native)' \
	"bun ${ROOT_DIR}/bench/pi-tool-override-burst.ts fast bash 8" \
	--command-name 'fast (compiled+native)' \
	"${ROOT_DIR}/bin/pi-tool-override-burst fast bash 8" >/dev/null
python3 - <<'PY' "${TMP_DIR}/bash-bench.json"
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    obj = json.load(f)
results = {item['command']: item['mean'] for item in obj['results']}
assert results['fast (bun+native)'] < results['stock (bun)']
assert results['fast (compiled+native)'] < results['stock (bun)']
PY

printf '[low-level 11/12] benchmark warm daemon vs cold spawn\n'
hyperfine \
	--shell=none \
	--warmup 1 \
	--runs 4 \
	--export-json "${TMP_DIR}/persistent-bench.json" \
	--command-name 'fast (compiled cold spawn-per-request)' \
	"${ROOT_DIR}/bin/pi-tool-request-loop spawn fast read 8" \
	--command-name 'fast (compiled warm daemon + native helpers)' \
	"${ROOT_DIR}/bin/pi-tool-request-loop daemon fast read 8" >/dev/null
python3 - <<'PY' "${TMP_DIR}/persistent-bench.json"
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    obj = json.load(f)
results = {item['command']: item['mean'] for item in obj['results']}
assert results['fast (compiled warm daemon + native helpers)'] < results['fast (compiled cold spawn-per-request)']
PY

printf '[low-level 12/12] benchmark compiled streaming path emits results\n'
hyperfine \
	--shell=none \
	--warmup 1 \
	--runs 3 \
	--export-json "${TMP_DIR}/stream-bench.json" \
	--command-name 'stock (bun)' \
	"bun ${ROOT_DIR}/bench/pi-tool-override-stream-burst.ts stock read 8" \
	--command-name 'fast (bun+native)' \
	"bun ${ROOT_DIR}/bench/pi-tool-override-stream-burst.ts fast read 8" \
	--command-name 'fast (compiled+native)' \
	"${ROOT_DIR}/bin/pi-tool-override-stream-burst fast read 8" >/dev/null
python3 - <<'PY' "${TMP_DIR}/stream-bench.json"
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    obj = json.load(f)
results = {item['command']: item['mean'] for item in obj['results']}
assert list(results) == ['stock (bun)', 'fast (bun+native)', 'fast (compiled+native)']
assert results['fast (bun+native)'] < results['stock (bun)']
assert results['fast (compiled+native)'] < results['stock (bun)']
PY

bash "${ROOT_DIR}/bench/cleanup-processes.sh" >/dev/null

printf 'Low-level tests passed.\n'
