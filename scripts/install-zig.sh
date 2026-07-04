#!/usr/bin/env bash

set -euo pipefail

PINNED_ZIG_NIGHTLY_VERSION="0.17.0-dev.1158+1d1193aa7"
ZIG_VERSION="${ZIG_VERSION:-${PINNED_ZIG_NIGHTLY_VERSION}}"
if [[ "${ZIG_VERSION}" == "nightly" || "${ZIG_VERSION}" == "master" ]]; then
	ZIG_VERSION="${PINNED_ZIG_NIGHTLY_VERSION}"
fi
if [[ -z "${ZIG_ARCHIVE_PLATFORM:-}" ]]; then
	case "$(uname -m)-$(uname -s)" in
		x86_64-Linux) ZIG_ARCHIVE_PLATFORM="x86_64-linux" ;;
		aarch64-Linux|arm64-Linux) ZIG_ARCHIVE_PLATFORM="aarch64-linux" ;;
		x86_64-Darwin) ZIG_ARCHIVE_PLATFORM="x86_64-macos" ;;
		aarch64-Darwin|arm64-Darwin) ZIG_ARCHIVE_PLATFORM="aarch64-macos" ;;
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
ZIG_ARCHIVE_URL=""

if [[ -z "${ZIG_SHASUM:-}" && "${ZIG_VERSION}" == "${PINNED_ZIG_NIGHTLY_VERSION}" ]]; then
	case "${ZIG_ARCHIVE_PLATFORM}" in
		x86_64-linux) ZIG_SHASUM="e5ff2fce71cb195dff6242b4f136df3ee18a7e456ba5333c0216cb59e37634eb" ;;
		aarch64-linux) ZIG_SHASUM="36756d399915678a572d6cc565008a9b6b469a4004af49efece205f13adac749" ;;
		x86_64-macos) ZIG_SHASUM="511fadf165623683419429e9d37a49284c9929db3b2746a0c1fa2bb3dae306e5" ;;
		aarch64-macos) ZIG_SHASUM="6cbe8b5f233e3794e440c76ae565c88fa9f12e394106d8a34dbcbe2d659eb2bc" ;;
	esac
fi

need_cmd() {
	command -v "$1" >/dev/null 2>&1 || {
		printf 'Missing required command: %s\n' "$1" >&2
		exit 1
	}
}

if [[ "${ZIG_VERSION}" == "stable" || "${ZIG_VERSION}" == "latest" ]]; then
	need_cmd bun
	ZIG_VERSION="$(bun -e 'const data = await fetch("https://ziglang.org/download/index.json").then((r) => r.json()); console.log(Object.keys(data).find((key) => key !== "master"));')"
	ZIG_DIR="${INSTALL_ROOT}/zig-${ZIG_ARCHIVE_PLATFORM}-${ZIG_VERSION}"
	ZIG_BIN="${ZIG_DIR}/zig"
elif [[ "${ZIG_VERSION}" == "nightly" || "${ZIG_VERSION}" == "master" ]]; then
	need_cmd bun
	ZIG_VERSION="$(bun -e 'const data = await fetch("https://ziglang.org/download/index.json").then((r) => r.json()); console.log(data.master.version);')"
	ZIG_ARCHIVE_URL="$(bun -e 'const platform = process.argv[1]; const data = await fetch("https://ziglang.org/download/index.json").then((r) => r.json()); const target = data.master[platform]; if (!target?.tarball) process.exit(1); console.log(target.tarball);' "${ZIG_ARCHIVE_PLATFORM}")"
	ZIG_DIR="${INSTALL_ROOT}/zig-${ZIG_ARCHIVE_PLATFORM}-${ZIG_VERSION}"
	ZIG_BIN="${ZIG_DIR}/zig"
fi

verify_archive() {
	local archive="$1"
	local actual=""
	if [[ -z "${ZIG_SHASUM:-}" ]]; then
		return 0
	fi
	if command -v sha256sum >/dev/null 2>&1; then
		read -r actual _ < <(sha256sum "${archive}")
	elif command -v shasum >/dev/null 2>&1; then
		read -r actual _ < <(shasum -a 256 "${archive}")
	else
		printf 'Missing required command: sha256sum or shasum\n' >&2
		exit 1
	fi
	if [[ "${actual}" != "${ZIG_SHASUM}" ]]; then
		printf 'Zig archive checksum mismatch for %s\nexpected: %s\nactual:   %s\n' "${archive}" "${ZIG_SHASUM}" "${actual}" >&2
		exit 1
	fi
}

if [[ ! -x "${ZIG_BIN}" ]]; then
	need_cmd curl
	need_cmd tar
	tmp_dir="$(mktemp -d)"
	cleanup() { rm -rf "${tmp_dir}"; }
	trap cleanup EXIT

	if [[ -n "${ZIG_ARCHIVE_URL:-}" ]]; then
		url="${ZIG_ARCHIVE_URL}"
	elif [[ "${ZIG_VERSION}" == *-dev.* ]]; then
		url="https://ziglang.org/builds/zig-${ZIG_ARCHIVE_PLATFORM}-${ZIG_VERSION}.tar.xz"
	else
		url="https://ziglang.org/download/${ZIG_VERSION}/zig-${ZIG_ARCHIVE_PLATFORM}-${ZIG_VERSION}.tar.xz"
	fi
	printf 'Downloading Zig %s from %s\n' "${ZIG_VERSION}" "${url}" >&2
	curl -fsSL "${url}" -o "${tmp_dir}/zig.tar.xz"
	verify_archive "${tmp_dir}/zig.tar.xz"
	mkdir -p "${INSTALL_ROOT}"
	tar -xf "${tmp_dir}/zig.tar.xz" -C "${INSTALL_ROOT}"
fi

mkdir -p "${XDG_BIN_HOME}"
ln -sfn "${ZIG_BIN}" "${ZIG_LINK}"

printf '%s\n' "${ZIG_LINK}"
"${ZIG_LINK}" version
