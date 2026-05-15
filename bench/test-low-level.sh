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
	bun -e 'const fs=require("node:fs"); const [path, field, expectedRaw]=process.argv.slice(1); let value=JSON.parse(fs.readFileSync(path,"utf8")); for (const part of field.split(".")) value=value[part]; const expected = expectedRaw === "True" ? "true" : expectedRaw === "False" ? "false" : expectedRaw; if (String(value) !== expected) { console.error(`Expected ${field}=${expectedRaw}, got ${value}`); process.exit(1); }' "${path}" "${field}" "${expected}"
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
bun -e 'const text=require("node:fs").readFileSync(process.argv[1],"utf8"); if (!text.startsWith("line-4500\nline-4501\nline-4502\n") || !text.includes("Use offset=4504 to continue.")) process.exit(1);' "${TMP_DIR}/fastread-slice.txt"
printf 'native write exactness ✓\n' > "${TMP_DIR}/fastwrite-expected.txt"
"${ROOT_DIR}/bin/fastwrite" "${TMP_DIR}/fastwrite-target.txt" \
	< "${TMP_DIR}/fastwrite-expected.txt" > "${TMP_DIR}/fastwrite.json"
assert_json_field_eq "${TMP_DIR}/fastwrite.json" "ok" "True"
cmp -s "${TMP_DIR}/fastwrite-expected.txt" "${TMP_DIR}/fastwrite-target.txt"

if [[ -x "${ROOT_DIR}/bin/fastread-window-gcc" && -x "${ROOT_DIR}/bin/fastwrite-gcc" ]]; then
	printf '[low-level C/gcc] verify read/write comparison helpers\n'
	"${ROOT_DIR}/bin/fastread-window-gcc" "${ROOT_DIR}/payloads/lines-10k.txt" 4501 3 > "${TMP_DIR}/fastread-gcc-slice.txt"
	cmp -s "${TMP_DIR}/fastread-slice.txt" "${TMP_DIR}/fastread-gcc-slice.txt"
	"${ROOT_DIR}/bin/fastwrite-gcc" "${TMP_DIR}/fastwrite-gcc-target.txt" \
		< "${TMP_DIR}/fastwrite-expected.txt" > "${TMP_DIR}/fastwrite-gcc.json"
	assert_json_field_eq "${TMP_DIR}/fastwrite-gcc.json" "ok" "True"
	cmp -s "${TMP_DIR}/fastwrite-expected.txt" "${TMP_DIR}/fastwrite-gcc-target.txt"
fi

printf '[low-level candidates] benchmark active native helpers against gcc comparison binaries\n'
read_candidate_commands=(
	--command-name 'pure Zig read helper'
	"${ROOT_DIR}/bin/fastread-window ${ROOT_DIR}/payloads/jsonl-5m.txt 1 12000 > /dev/null"
)
write_candidate_commands=(
	--command-name 'zig cc write helper'
	"${ROOT_DIR}/bin/fastwrite ${TMP_DIR}/candidate-zigcc-write.txt < ${ROOT_DIR}/payloads/jsonl-5m.txt > /dev/null"
)
if [[ -x "${ROOT_DIR}/bin/fastread-window-gcc" && -x "${ROOT_DIR}/bin/fastwrite-gcc" ]]; then
	read_candidate_commands+=(
		--command-name 'gcc read helper'
		"${ROOT_DIR}/bin/fastread-window-gcc ${ROOT_DIR}/payloads/jsonl-5m.txt 1 12000 > /dev/null"
	)
	write_candidate_commands+=(
		--command-name 'gcc write helper'
		"${ROOT_DIR}/bin/fastwrite-gcc ${TMP_DIR}/candidate-gcc-write.txt < ${ROOT_DIR}/payloads/jsonl-5m.txt > /dev/null"
	)
fi
hyperfine --warmup 1 --runs 4 --export-json "${TMP_DIR}/read-candidates.json" "${read_candidate_commands[@]}" >/dev/null
hyperfine --warmup 1 --runs 4 --export-json "${TMP_DIR}/write-candidates.json" "${write_candidate_commands[@]}" >/dev/null
bun -e 'for (const path of process.argv.slice(1)) { const obj=require(path); for (const item of obj.results) if (item.mean <= 0 || !(item.exit_codes ?? []).every((code) => code === 0)) process.exit(1); }' "${TMP_DIR}/read-candidates.json" "${TMP_DIR}/write-candidates.json"

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

printf '[low-level write] verify exact write reliability\n'
"${ROOT_DIR}/bin/pi-tool-override-burst" fast write 4 > "${TMP_DIR}/compiled-write.json"
assert_json_field_eq "${TMP_DIR}/compiled-write.json" "mode" "fast"
assert_json_field_eq "${TMP_DIR}/compiled-write.json" "tool" "write"
"${ROOT_DIR}/bin/pi-tool-request-loop" daemon fast write 4 > "${TMP_DIR}/daemon-write.json"
assert_json_field_eq "${TMP_DIR}/daemon-write.json" "transport" "daemon"
assert_json_field_eq "${TMP_DIR}/daemon-write.json" "tool" "write"
bun "${ROOT_DIR}/bench/write-reliability.ts" 20 > "${TMP_DIR}/write-reliability.json"
assert_json_field_eq "${TMP_DIR}/write-reliability.json" "ok" "True"

printf '[low-level 7/12] verify compiled streaming runner\n'
"${ROOT_DIR}/bin/pi-tool-override-stream-burst" fast read 2 > "${TMP_DIR}/compiled-stream.json"
assert_json_field_eq "${TMP_DIR}/compiled-stream.json" "mode" "fast"
assert_json_field_eq "${TMP_DIR}/compiled-stream.json" "tool" "read"
bun -e 'const obj=require(process.argv[1]); if (obj.iterations !== 2 || obj.updatesPerIteration <= 0 || obj.avgFirstUpdateMs == null || obj.avgFirstUpdateMs < 0) process.exit(1);' "${TMP_DIR}/compiled-stream.json"

printf '[low-level 8/12] verify compiled warm daemon loop\n'
"${ROOT_DIR}/bin/pi-tool-request-loop" daemon fast read 4 > "${TMP_DIR}/daemon-read.json"
assert_json_field_eq "${TMP_DIR}/daemon-read.json" "transport" "daemon"
assert_json_field_eq "${TMP_DIR}/daemon-read.json" "mode" "fast"
assert_json_field_eq "${TMP_DIR}/daemon-read.json" "tool" "read"
assert_json_field_eq "${TMP_DIR}/daemon-read.json" "iterations" "4"
bun -e 'const obj=require(process.argv[1]); if (obj.daemonReadyMs == null || obj.firstResponseMs == null || obj.firstResponseMs < 0) process.exit(1);' "${TMP_DIR}/daemon-read.json"

printf '[low-level 9/12] benchmark retained edit candidates\n'
edit_commands=(
	--command-name 'fast (compiled+native)'
	"${ROOT_DIR}/bin/pi-tool-override-burst fast edit 12"
)
if [[ -x "${ROOT_DIR}/bin/fastedit-gcc" ]]; then
	edit_commands+=(
		--command-name 'fast (compiled+gcc comparison)'
		"env TIA_FASTEDIT_BIN=${ROOT_DIR}/bin/fastedit-gcc ${ROOT_DIR}/bin/pi-tool-override-burst fast edit 12"
	)
fi
hyperfine \
	--shell=none \
	--warmup 1 \
	--runs 4 \
	--export-json "${TMP_DIR}/edit-bench.json" \
	"${edit_commands[@]}" >/dev/null
bun -e 'const obj=require(process.argv[1]); for (const item of obj.results) if (item.mean <= 0 || !(item.exit_codes ?? []).every((code) => code === 0)) process.exit(1);' "${TMP_DIR}/edit-bench.json"

printf '[low-level 10/12] benchmark retained bash candidates\n'
bash_commands=(
	--command-name 'fast (compiled+native)'
	"${ROOT_DIR}/bin/pi-tool-override-burst fast bash 8"
)
if [[ -x "${ROOT_DIR}/bin/fastdrain-gcc" && -x "${ROOT_DIR}/bin/fastcopy-gcc" ]]; then
	bash_commands+=(
		--command-name 'fast (compiled+gcc comparison)'
		"env TIA_FASTDRAIN_BIN=${ROOT_DIR}/bin/fastdrain-gcc TIA_FASTCOPY_BIN=${ROOT_DIR}/bin/fastcopy-gcc ${ROOT_DIR}/bin/pi-tool-override-burst fast bash 8"
	)
fi
hyperfine \
	--shell=none \
	--warmup 1 \
	--runs 4 \
	--export-json "${TMP_DIR}/bash-bench.json" \
	"${bash_commands[@]}" >/dev/null
bun -e 'const obj=require(process.argv[1]); for (const item of obj.results) if (item.mean <= 0 || !(item.exit_codes ?? []).every((code) => code === 0)) process.exit(1);' "${TMP_DIR}/bash-bench.json"

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
bun -e 'const obj=require(process.argv[1]); const results=Object.fromEntries(obj.results.map((item)=>[item.command,item.mean])); if (!(results["fast (compiled warm daemon + native helpers)"] < results["fast (compiled cold spawn-per-request)"])) process.exit(1);' "${TMP_DIR}/persistent-bench.json"

printf '[low-level 12/12] benchmark retained streaming candidates emit results\n'
stream_commands=(
	--command-name 'fast (compiled+native)'
	"${ROOT_DIR}/bin/pi-tool-override-stream-burst fast read 8"
)
if [[ -x "${ROOT_DIR}/bin/fastread-window-gcc" ]]; then
	stream_commands+=(
		--command-name 'fast (compiled+gcc comparison read)'
		"env TIA_FASTREAD_BIN=${ROOT_DIR}/bin/fastread-window-gcc ${ROOT_DIR}/bin/pi-tool-override-stream-burst fast read 8"
	)
fi
hyperfine \
	--shell=none \
	--warmup 1 \
	--runs 3 \
	--export-json "${TMP_DIR}/stream-bench.json" \
	"${stream_commands[@]}" >/dev/null
bun -e 'const obj=require(process.argv[1]); for (const item of obj.results) if (item.mean <= 0 || !(item.exit_codes ?? []).every((code) => code === 0)) process.exit(1);' "${TMP_DIR}/stream-bench.json"

bash "${ROOT_DIR}/bench/cleanup-processes.sh" >/dev/null

printf 'Low-level tests passed.\n'
