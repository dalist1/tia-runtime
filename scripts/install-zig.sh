#!/usr/bin/env bash

set -euo pipefail

ZIG_VERSION="${ZIG_VERSION:-0.16.0}"
if [[ -z "${ZIG_ARCHIVE_PLATFORM:-}" ]]; then
	case "$(uname -m)-$(uname -s)" in
		x86_64-Linux) ZIG_ARCHIVE_PLATFORM="x86_64-linux" ;;
		aarch64-Linux|arm64-Linux) ZIG_ARCHIVE_PLATFORM="aarch64-linux" ;;
		*)
			printf 'Unsupported Zig platform: %s-%s\n' "$(uname -m)" "$(uname -s)" >&2
			exit 1
			;;
	esac
fi
XDG_DATA_HOME="${XDG_DATA_HOME:-${HOME}/.local/share}"
XDG_BIN_HOME="${XDG_BIN_HOME:-${HOME}/.local/bin}"
INSTALL_ROOT="${ZIG_INSTALL_ROOT:-${XDG_DATA_HOME}/tia-runtime}"
ZIG_DIR="${INSTALL_ROOT}/zig-${ZIG_ARCHIVE_PLATFORM}-${ZIG_VERSION}"
ZIG_BIN="${ZIG_DIR}/zig"
ZIG_LINK="${XDG_BIN_HOME}/zig"

need_cmd() {
	command -v "$1" >/dev/null 2>&1 || {
		printf 'Missing required command: %s\n' "$1" >&2
		exit 1
	}
}

if [[ "${ZIG_VERSION}" == "stable" || "${ZIG_VERSION}" == "latest" ]]; then
	need_cmd python3
	ZIG_VERSION="$(python3 - <<'PY'
import json, urllib.request
with urllib.request.urlopen('https://ziglang.org/download/index.json', timeout=20) as r:
    data = json.load(r)
for key in data:
    if key != 'master':
        print(key)
        break
PY
)"
	ZIG_DIR="${INSTALL_ROOT}/zig-${ZIG_ARCHIVE_PLATFORM}-${ZIG_VERSION}"
	ZIG_BIN="${ZIG_DIR}/zig"
fi

if [[ ! -x "${ZIG_BIN}" ]]; then
	need_cmd curl
	need_cmd tar
	tmp_dir="$(mktemp -d)"
	cleanup() { rm -rf "${tmp_dir}"; }
	trap cleanup EXIT

	url="https://ziglang.org/download/${ZIG_VERSION}/zig-${ZIG_ARCHIVE_PLATFORM}-${ZIG_VERSION}.tar.xz"
	printf 'Downloading Zig %s from %s\n' "${ZIG_VERSION}" "${url}" >&2
	curl -fsSL "${url}" -o "${tmp_dir}/zig.tar.xz"
	mkdir -p "${INSTALL_ROOT}"
	tar -xf "${tmp_dir}/zig.tar.xz" -C "${INSTALL_ROOT}"
fi

mkdir -p "${XDG_BIN_HOME}"
ln -sfn "${ZIG_BIN}" "${ZIG_LINK}"

printf '%s\n' "${ZIG_LINK}"
"${ZIG_LINK}" version
