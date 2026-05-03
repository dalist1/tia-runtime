#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
RESULT_DIR="${RESULT_DIR:-${ROOT_DIR}/results-native-search-zig-smoke}"
RUNS="${RUNS:-10}"
WARMUP="${WARMUP:-2}"
QUERY="${QUERY:-native search markdown documentation}"
CONTENT_CHARS="${CONTENT_CHARS:-12000}"
REPEAT="${REPEAT:-500}"
CORPUS="${RESULT_DIR}/raw-corpus.tsv"

mkdir -p "${RESULT_DIR}"
bash "${ROOT_DIR}/bench/build-native-search-zig.sh" >/dev/null
"${ROOT_DIR}/bin/native-search-zig" --fixture "${REPEAT}" "${CORPUS}"

printf 'Running full Zig native search benchmark into %s (runs=%s warmup=%s repeat=%s)\n' "${RESULT_DIR}" "${RUNS}" "${WARMUP}" "${REPEAT}"
printf 'This benchmark performs zero network requests and uses only Zig for fixture generation + search.\n'

hyperfine \
  --warmup "${WARMUP}" \
  --runs "${RUNS}" \
  --export-json "${RESULT_DIR}/native-search-zig.json" \
  --export-markdown "${RESULT_DIR}/native-search-zig.md" \
  --command-name "native search full Zig extract+rank" \
  "${ROOT_DIR}/bin/native-search-zig '${QUERY}' 3 ${CONTENT_CHARS} ${CORPUS} > /dev/null"

printf 'Wrote full Zig native search benchmark results to %s\n' "${RESULT_DIR}"
