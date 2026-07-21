#!/usr/bin/env bash

set -euo pipefail

PINNED_ZIG_NIGHTLY_VERSION="0.17.0-dev.1441+d5181a9c9"
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
		x86_64-linux) ZIG_SHASUM="b9d2b068e4245b3de4b1e3acb43a214e46f366a7cbc77d573edc1425a4403cdd" ;;
		aarch64-linux) ZIG_SHASUM="769f8cb8c14bd794510b739a7247e737ece062bf4b2b63b8b8e4154c54cc3e95" ;;
		x86_64-macos) ZIG_SHASUM="b41f7b7ed076d84cb2f9794316f947017af26b27f5c11d5d5b735942612b4cc4" ;;
		aarch64-macos) ZIG_SHASUM="4351e5c97daa1ae4eba6cf7df4d194b5f64c6d450886134b36b148a1ead70c7d" ;;
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
