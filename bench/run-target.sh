#!/usr/bin/env bash

set -euo pipefail

TARGET="${1:?missing target}"
PAYLOAD="${2:?missing payload}"
ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

case "${TARGET}" in
	bash-dev-null)
		bash "${ROOT_DIR}/bench/bash-read-dev-null.sh" < "${PAYLOAD}"
		;;
	bash-count-lines)
		bash "${ROOT_DIR}/bench/bash-count-lines.sh" < "${PAYLOAD}"
		;;
	bash-slurp-python3)
		bash "${ROOT_DIR}/bench/bash-slurp-python3.sh" < "${PAYLOAD}"
		;;
	bun-console-lines)
		bun "${ROOT_DIR}/bench/bun-console-lines.ts" < "${PAYLOAD}"
		;;
	bun-stream-bytes)
		bun "${ROOT_DIR}/bench/bun-stream-bytes.ts" < "${PAYLOAD}"
		;;
	bun-response-text)
		bun "${ROOT_DIR}/bench/bun-response-text.ts" < "${PAYLOAD}"
		;;
	*)
		printf 'Unsupported target: %s\n' "${TARGET}" >&2
		exit 1
		;;
esac
