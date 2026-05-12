#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
RESULT_DIR="${RESULT_DIR:-${ROOT_DIR}/results-native-search-live-smoke}"
QUERY="${QUERY:-native search markdown documentation}"
CONTENT_CHARS="${CONTENT_CHARS:-12000}"
URLS="${URLS:-https://ziglang.org/learn/,https://bun.sh/docs,https://www.sqlite.org/docs.html}"
LIVE_DELAY_MS="${LIVE_DELAY_MS:-2500}"

if [[ "${TIA_NATIVE_SEARCH_LIVE:-0}" != "1" ]]; then
  cat >&2 <<EOF
This live smoke intentionally makes a few real network requests from Zig.
Re-run with TIA_NATIVE_SEARCH_LIVE=1 to confirm.
Defaults: 3 documentation URLs, exact URLs only, LIVE_DELAY_MS=2500.
EOF
  exit 2
fi

mkdir -p "${RESULT_DIR}"
bash "${ROOT_DIR}/bench/build-native-search-zig.sh" >/dev/null
tr ',' '\n' <<< "${URLS}" | sed '/^[[:space:]]*$/d' > "${RESULT_DIR}/live-urls.txt"

printf 'Running live native-search smoke with Zig exact-URL fetch/extract/rank. Results: %s\n' "${RESULT_DIR}"
printf 'Request policy: exact URL list only, Zig delay=%s ms.\n' "${LIVE_DELAY_MS}"

start_ms="$(python3 -c 'import time; print(int(time.time() * 1000))')"
"${ROOT_DIR}/bin/native-search-zig" \
  --urls \
  "${QUERY}" \
  5 \
  "${CONTENT_CHARS}" \
  "${RESULT_DIR}/live-urls.txt" \
  "${LIVE_DELAY_MS}" \
  0 > "${RESULT_DIR}/zig-search.md"
end_ms="$(python3 -c 'import time; print(int(time.time() * 1000))')"
elapsed_ms="$((end_ms - start_ms))"
url_count="$(wc -l < "${RESULT_DIR}/live-urls.txt")"

{
  printf '# native search live + full zig fetch/extract/ranking\n\n'
  printf 'Live exact URL count: %s\n\n' "${url_count}"
  printf 'Elapsed: %s ms\n\n' "${elapsed_ms}"
  printf 'Inter-request delay: %s ms\n\n' "${LIVE_DELAY_MS}"
  printf 'Zig search output: %s\n\n' "${RESULT_DIR}/zig-search.md"
  printf 'Live URLs:\n'
  while IFS= read -r url; do
    printf -- '- %s\n' "${url}"
  done < "${RESULT_DIR}/live-urls.txt"
} > "${RESULT_DIR}/summary.md"
cat "${RESULT_DIR}/summary.md"
