#!/usr/bin/env bash

set -euo pipefail

ACTION="${1:-install}"
SOURCE_PATH="${BASH_SOURCE[0]:-$0}"
if [[ -f "${SOURCE_PATH}" ]]; then
	ROOT_DIR="$(cd -- "$(dirname -- "${SOURCE_PATH}")/.." && pwd)"
else
	ROOT_DIR="$(pwd)"
fi
INSTALL_BASE_URL="${INSTALL_BASE_URL:-https://raw.githubusercontent.com/dalist1/tia/main/scripts}"
XDG_DATA_HOME="${XDG_DATA_HOME:-${HOME}/.local/share}"
XDG_BIN_HOME="${XDG_BIN_HOME:-${HOME}/.local/bin}"
TIA_ROOT="${TIA_ROOT:-${XDG_DATA_HOME}/tia}"
LEGACY_MAX_ROOT="${MAX_ROOT:-${XDG_DATA_HOME}/max-sandbox}"
TIA_BIN_DIR="${XDG_BIN_HOME}"
TIA_CMD_PATH="${TIA_BIN_DIR}/tia"
LEGACY_MAX_CMD_PATH="${TIA_BIN_DIR}/max"
TIA_PI_BIN="${TIA_ROOT}/bin/pi"
TIA_PI_AGENT_DIR="${TIA_ROOT}/pi-agent"
TIA_OPENCODE_BIN_DIR="${TIA_ROOT}/opencode-bin"
TIA_EXTENSION_PATH="${TIA_PI_AGENT_DIR}/extensions/fast-tools.ts"
INSTALL_LEGACY_MAX_ALIAS="${INSTALL_LEGACY_MAX_ALIAS:-1}"
PACKAGE_NAME_PI="@mariozechner/pi-coding-agent"

usage() {
	cat <<EOF
Usage:
  install-tia.sh install
  install-tia.sh uninstall
  install-tia.sh status

Installs the tia runtime command so you can run:
  tia pi [args...]
  tia opencode [args...]

By default it also creates a legacy `max` alias. Set INSTALL_LEGACY_MAX_ALIAS=0 to skip that.
EOF
}

die() {
	printf 'Error: %s\n' "$*" >&2
	exit 1
}

need_cmd() {
	command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

copy_or_fetch_script_asset() {
	local relative_path="$1"
	local destination="$2"
	local local_path="${ROOT_DIR}/scripts/${relative_path}"

	mkdir -p "$(dirname -- "${destination}")"

	if [[ -f "${local_path}" ]]; then
		cp "${local_path}" "${destination}"
		return 0
	fi

	[[ -n "${INSTALL_BASE_URL}" ]] || die "Could not locate scripts/${relative_path} locally. Set INSTALL_BASE_URL to a host serving the scripts directory."
	need_cmd curl
	curl -fsSL "${INSTALL_BASE_URL}/${relative_path}" > "${destination}"
}

realpath_py() {
	python3 - "$1" <<'PY'
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
}

is_pi_package_dir() {
	local dir="$1"
	local package_json="${dir}/package.json"
	[[ -f "${package_json}" ]] || return 1
	python3 - "${package_json}" <<'PY'
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    data = json.load(f)
raise SystemExit(0 if data.get('name') == '@mariozechner/pi-coding-agent' else 1)
PY
}

find_pi_package_dir() {
	local path="$1"
	local dir
	if [[ -d "${path}" ]]; then
		dir="${path}"
	else
		dir="$(dirname "${path}")"
	fi
	while true; do
		if is_pi_package_dir "${dir}"; then
			printf '%s\n' "${dir}"
			return 0
		fi
		if [[ "${dir}" == "/" ]]; then
			break
		fi
		dir="$(dirname "${dir}")"
	done
	return 1
}

resolve_opencode_direct_bin() {
	if ! command -v opencode >/dev/null 2>&1; then
		return 1
	fi

	local shim resolved package_root platform arch candidate
	shim="$(command -v opencode)"
	resolved="$(realpath_py "${shim}")"
	package_root="$(cd -- "$(dirname -- "${resolved}")/.." && pwd)"

	case "$(uname -s)" in
		Linux) platform="linux" ;;
		Darwin) platform="darwin" ;;
		*) return 1 ;;
	esac

	case "$(uname -m)" in
		x86_64|amd64) arch="x64" ;;
		aarch64|arm64) arch="arm64" ;;
		armv7*|armv6*|arm) arch="arm" ;;
		*) return 1 ;;
	esac

	for candidate in \
		"${package_root}/../opencode-${platform}-${arch}/bin/opencode" \
		"${package_root}/../opencode-${platform}-${arch}-baseline/bin/opencode" \
		"${package_root}/../opencode-${platform}-${arch}-musl/bin/opencode" \
		"${package_root}/../opencode-${platform}-${arch}-baseline-musl/bin/opencode"
	do
		if [[ -x "${candidate}" ]]; then
			printf '%s\n' "${candidate}"
			return 0
		fi
	done

	return 1
}

install_pi_sandbox() {
	need_cmd bun
	need_cmd pi
	mkdir -p "$(dirname -- "${TIA_PI_BIN}")" "$(dirname -- "${TIA_EXTENSION_PATH}")"

	local pi_path pi_resolved pi_package_dir pi_bin_dir base_agent_dir
	pi_path="$(command -v pi)"
	pi_resolved="$(realpath_py "${pi_path}")"
	pi_package_dir="$(find_pi_package_dir "${pi_resolved}")" || die "Could not locate ${PACKAGE_NAME_PI} package directory"
	pi_bin_dir="$(dirname -- "${TIA_PI_BIN}")"
	base_agent_dir="${PI_CODING_AGENT_DIR:-${HOME}/.pi/agent}"

	bun build --compile "${pi_package_dir}/dist/cli.js" --outfile "${TIA_PI_BIN}"
	ln -sfn "${pi_package_dir}/dist/modes/interactive/theme" "${pi_bin_dir}/theme"
	ln -sfn "${pi_package_dir}/dist/core/export-html" "${pi_bin_dir}/export-html"
	copy_or_fetch_script_asset "fast-tools-extension.ts" "${TIA_EXTENSION_PATH}"

	if [[ -f "${base_agent_dir}/auth.json" ]]; then
		ln -sfn "${base_agent_dir}/auth.json" "${TIA_PI_AGENT_DIR}/auth.json"
	fi
	if [[ -f "${base_agent_dir}/models.json" ]]; then
		ln -sfn "${base_agent_dir}/models.json" "${TIA_PI_AGENT_DIR}/models.json"
	fi
	if [[ -f "${base_agent_dir}/settings.json" ]]; then
		ln -sfn "${base_agent_dir}/settings.json" "${TIA_PI_AGENT_DIR}/settings.json"
	fi

	printf '%s\n' "${pi_package_dir}" > "${TIA_ROOT}/pi-package-dir.txt"
}

build_fast_helpers() {
	mkdir -p "${TIA_OPENCODE_BIN_DIR}"

	rm -f "${TIA_OPENCODE_BIN_DIR}/cat" "${TIA_OPENCODE_BIN_DIR}/cat.c"
	if ! command -v gcc >/dev/null 2>&1; then
		cat > "${TIA_OPENCODE_BIN_DIR}/cp" <<EOF
#!/usr/bin/env bash
set -euo pipefail
real_cp="$(command -v cp)"
fastcopy="${TIA_OPENCODE_BIN_DIR}/fastcopy"
if [[ "\$#" -eq 2 && "\${1}" != -* && "\${2}" != -* && -f "\${1}" ]]; then
  exec "\${fastcopy}" "\${1}" "\${2}"
fi
exec "\${real_cp}" "\$@"
EOF
		chmod +x "${TIA_OPENCODE_BIN_DIR}/cp"
		return 0
	fi

	cat > "${TIA_OPENCODE_BIN_DIR}/fastdrain.c" <<'EOF'
#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
enum { BUFFER_SIZE = 1 << 20 };
static int drain_fd(int fd) {
    void *buffer = NULL;
    if (posix_memalign(&buffer, 4096, BUFFER_SIZE) != 0) return 1;
    for (;;) {
        ssize_t bytes_read = read(fd, buffer, BUFFER_SIZE);
        if (bytes_read == 0) break;
        if (bytes_read < 0) {
            if (errno == EINTR) continue;
            free(buffer);
            return 1;
        }
    }
    free(buffer);
    return 0;
}
int main(int argc, char **argv) {
    int fd = STDIN_FILENO;
    if (argc > 2) return 1;
    if (argc == 2) {
        fd = open(argv[1], O_RDONLY | O_CLOEXEC);
        if (fd < 0) return 1;
    }
    int status = drain_fd(fd);
    if (fd != STDIN_FILENO) close(fd);
    return status;
}
EOF

	cat > "${TIA_OPENCODE_BIN_DIR}/fastcopy.c" <<'EOF'
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <sys/sendfile.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
int main(int argc, char **argv) {
    if (argc != 3) return 1;
    int src_fd = open(argv[1], O_RDONLY | O_CLOEXEC);
    if (src_fd < 0) return 1;
    struct stat st;
    if (fstat(src_fd, &st) != 0) return 1;
    int dst_fd = open(argv[2], O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, st.st_mode & 0777);
    if (dst_fd < 0) return 1;
    if (sendfile(dst_fd, src_fd, NULL, (size_t)st.st_size) < 0 && errno != EINVAL && errno != ENOSYS) return 1;
    close(dst_fd);
    close(src_fd);
    return 0;
}
EOF

	cat > "${TIA_OPENCODE_BIN_DIR}/cp.c" <<EOF
#define _GNU_SOURCE
#include <errno.h>
#include <sys/stat.h>
#include <unistd.h>
static const char *REAL_CP = "$(command -v cp)";
static const char *FASTCOPY = "${TIA_OPENCODE_BIN_DIR}/fastcopy";
static int is_regular_file(const char *path) {
    struct stat st;
    if (stat(path, &st) != 0) return 0;
    return S_ISREG(st.st_mode);
}
int main(int argc, char **argv) {
    if (argc == 3 && argv[1][0] != '-' && argv[2][0] != '-' && is_regular_file(argv[1])) {
        execl(FASTCOPY, FASTCOPY, argv[1], argv[2], (char *)NULL);
    }
    execv(REAL_CP, argv);
    return errno ? errno : 1;
}
EOF

	gcc -O3 -pipe -march=native -s -o "${TIA_OPENCODE_BIN_DIR}/fastdrain" "${TIA_OPENCODE_BIN_DIR}/fastdrain.c"
	gcc -O3 -pipe -march=native -s -o "${TIA_OPENCODE_BIN_DIR}/fastcopy" "${TIA_OPENCODE_BIN_DIR}/fastcopy.c"
	gcc -O3 -pipe -march=native -s -o "${TIA_OPENCODE_BIN_DIR}/cp" "${TIA_OPENCODE_BIN_DIR}/cp.c"
	rm -f "${TIA_OPENCODE_BIN_DIR}"/*.c
}

write_tia_wrapper() {
	mkdir -p "${TIA_BIN_DIR}"
	local pi_package_dir opencode_direct_bin
	pi_package_dir="$(cat "${TIA_ROOT}/pi-package-dir.txt")"
	opencode_direct_bin="$(resolve_opencode_direct_bin || true)"

	cat > "${TIA_CMD_PATH}" <<EOF
#!/usr/bin/env bash
set -euo pipefail
TIA_ROOT="${TIA_ROOT}"
TIA_PI_BIN="${TIA_PI_BIN}"
TIA_PI_AGENT_DIR="${TIA_PI_AGENT_DIR}"
TIA_OPENCODE_BIN_DIR="${TIA_OPENCODE_BIN_DIR}"
PI_PACKAGE_DIR="${pi_package_dir}"
OPENCODE_DIRECT_BIN="${opencode_direct_bin}"

subcommand="\${1:-}"
if [[ -z "\${subcommand}" ]]; then
  echo "Usage: tia {pi|opencode|status} [args...]" >&2
  exit 1
fi
shift || true

case "\${subcommand}" in
  pi)
    export PI_CODING_AGENT_DIR="\${TIA_PI_AGENT_DIR}"
    export PI_PACKAGE_DIR="\${PI_PACKAGE_DIR}"
    exec "\${TIA_PI_BIN}" "\$@"
    ;;
  opencode)
    export PATH="\${TIA_OPENCODE_BIN_DIR}:\$PATH"
    if [[ -n "\${OPENCODE_DIRECT_BIN}" && -x "\${OPENCODE_DIRECT_BIN}" ]]; then
      exec "\${OPENCODE_DIRECT_BIN}" "\$@"
    fi
    exec opencode "\$@"
    ;;
  status)
    echo "tia root:      \	\${TIA_ROOT}"
    echo "tia pi bin:    \	\${TIA_PI_BIN}"
    echo "tia pi agent:  \	\${TIA_PI_AGENT_DIR}"
    echo "tia opencode:  \	\${TIA_OPENCODE_BIN_DIR}"
    echo "pi package:    \	\${PI_PACKAGE_DIR}"
    echo "opencode bin:  \	\${OPENCODE_DIRECT_BIN:-<shim>}"
    ;;
  *)
    echo "Unknown subcommand: \	\${subcommand}" >&2
    exit 1
    ;;
esac
EOF
	chmod +x "${TIA_CMD_PATH}"
}

legacy_max_is_managed() {
	[[ -e "${LEGACY_MAX_CMD_PATH}" ]] || return 1
	if [[ -L "${LEGACY_MAX_CMD_PATH}" ]]; then
		[[ "$(realpath_py "${LEGACY_MAX_CMD_PATH}")" == "$(realpath_py "${TIA_CMD_PATH}")" ]]
		return $?
	fi
	grep -q 'Usage: max {pi|opencode|status} \[args...\]' "${LEGACY_MAX_CMD_PATH}" 2>/dev/null
}

install_legacy_max_alias() {
	if [[ "${INSTALL_LEGACY_MAX_ALIAS}" != "1" ]]; then
		return 0
	fi
	mkdir -p "${TIA_BIN_DIR}"
	if [[ -e "${LEGACY_MAX_CMD_PATH}" ]] && ! legacy_max_is_managed; then
		printf 'Note: leaving existing max command untouched at %s\n' "${LEGACY_MAX_CMD_PATH}" >&2
		return 0
	fi
	ln -sfn "tia" "${LEGACY_MAX_CMD_PATH}"
}

install_all() {
	install_pi_sandbox
	build_fast_helpers
	write_tia_wrapper
	install_legacy_max_alias
	printf 'Installed tia command at %s\n' "${TIA_CMD_PATH}"
	printf 'Run: tia pi\n'
	if command -v opencode >/dev/null 2>&1; then
		printf 'Run: tia opencode\n'
	fi
	if [[ "${INSTALL_LEGACY_MAX_ALIAS}" == "1" ]]; then
		printf 'Legacy alias: %s -> tia\n' "${LEGACY_MAX_CMD_PATH}"
	fi
	if [[ ":${PATH}:" != *":${TIA_BIN_DIR}:"* ]]; then
		printf 'Note: %s is not on PATH in this shell.\n' "${TIA_BIN_DIR}" >&2
	fi
}

uninstall_all() {
	rm -f "${TIA_CMD_PATH}"
	if legacy_max_is_managed; then
		rm -f "${LEGACY_MAX_CMD_PATH}"
	fi
	rm -rf "${TIA_ROOT}"
	if [[ "${LEGACY_MAX_ROOT}" != "${TIA_ROOT}" ]]; then
		rm -rf "${LEGACY_MAX_ROOT}"
	fi
	printf 'Removed tia command and runtime assets.\n'
}

status_all() {
	printf 'tia command:   %s\n' "${TIA_CMD_PATH}"
	[[ -x "${TIA_CMD_PATH}" ]] && printf 'tia installed: yes\n' || printf 'tia installed: no\n'
	printf 'tia root:      %s\n' "${TIA_ROOT}"
	printf 'tia pi bin:    %s\n' "${TIA_PI_BIN}"
	printf 'tia ext:       %s\n' "${TIA_EXTENSION_PATH}"
	printf 'tia opencode:  %s\n' "${TIA_OPENCODE_BIN_DIR}"
	printf 'max alias:     %s\n' "${LEGACY_MAX_CMD_PATH}"
	[[ -x "${LEGACY_MAX_CMD_PATH}" ]] && printf 'max alias ok:  yes\n' || printf 'max alias ok:  no\n'
	if [[ -f "${TIA_ROOT}/pi-package-dir.txt" ]]; then
		printf 'pi package:    %s\n' "$(cat "${TIA_ROOT}/pi-package-dir.txt")"
	fi
	if [[ -d "${LEGACY_MAX_ROOT}" && "${LEGACY_MAX_ROOT}" != "${TIA_ROOT}" ]]; then
		printf 'legacy root:   %s\n' "${LEGACY_MAX_ROOT}"
	fi
	if command -v opencode >/dev/null 2>&1; then
		printf 'opencode dir:  %s\n' "$(resolve_opencode_direct_bin || echo '<shim>')"
	fi
}

case "${ACTION}" in
	install)
		need_cmd python3
		need_cmd bun
		need_cmd pi
		install_all
		;;
	uninstall|revert)
		uninstall_all
		;;
	status)
		status_all
		;;
	-h|--help|help)
		usage
		;;
	*)
		usage >&2
		die "Unsupported action: ${ACTION}"
		;;
esac
