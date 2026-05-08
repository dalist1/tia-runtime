#!/usr/bin/env bash

set -euo pipefail

ACTION="${1:-install}"
if [[ "$#" -gt 0 ]]; then
	shift
fi
TIA_INSTALL_NATIVE_SEARCH="${TIA_ENABLE_NATIVE_SEARCH:-0}"
for arg in "$@"; do
	case "${arg}" in
		--search)
			TIA_INSTALL_NATIVE_SEARCH=1
			;;
		--no-search)
			TIA_INSTALL_NATIVE_SEARCH=0
			;;
		*)
			printf 'Error: unsupported installer option: %s\n' "${arg}" >&2
			exit 1
			;;
	esac
done
SOURCE_PATH="${BASH_SOURCE[0]:-$0}"
if [[ -f "${SOURCE_PATH}" ]]; then
	ROOT_DIR="$(cd -- "$(dirname -- "${SOURCE_PATH}")/.." && pwd)"
else
	ROOT_DIR="$(pwd)"
fi
INSTALL_BASE_URL="${INSTALL_BASE_URL:-https://raw.githubusercontent.com/dalist1/tia-runtime/main/scripts}"
RUNTIME_NAME="tia-runtime"
XDG_DATA_HOME="${XDG_DATA_HOME:-${HOME}/.local/share}"
XDG_BIN_HOME="${XDG_BIN_HOME:-${HOME}/.local/bin}"
TIA_ROOT="${TIA_ROOT:-${XDG_DATA_HOME}/tia}"
TIA_BIN_DIR="${XDG_BIN_HOME}"
TIA_CMD_PATH="${TIA_BIN_DIR}/tia"
TIA_PI_BIN="${TIA_ROOT}/bin/pi"
TIA_PI_STREAM_BIN="${TIA_ROOT}/bin/pi-stream-fast"
TIA_PI_AGENT_DIR="${TIA_ROOT}/pi-agent"
TIA_EXTENSION_PATH="${TIA_PI_AGENT_DIR}/extensions/fast-tools.ts"
TIA_NATIVE_SEARCH_EXTENSION_DIR="${TIA_PI_AGENT_DIR}/extensions/native-search"
TIA_FAST_TOOLS_DIR="${TIA_PI_AGENT_DIR}/fast-tools"
TIA_FFF_EXTENSION_DIR="${TIA_PI_AGENT_DIR}/extensions/fff"
TIA_FFF_STATE_DIR="${TIA_PI_AGENT_DIR}/fff"
TIA_FFF_PACKAGE_VERSION="${TIA_FFF_PACKAGE_VERSION:-nightly}"
TIA_FFF_SOURCE="${TIA_FFF_SOURCE:-vanilla}"
TIA_PI_PACKAGE_VERSION="${TIA_PI_PACKAGE_VERSION:-0.74.0}"
PACKAGE_NAME_PI="@earendil-works/pi-coding-agent"

usage() {
	cat <<EOF2
Usage:
  install-tia.sh install [--search]
  install-tia.sh uninstall
  install-tia.sh status

Installs the tia-runtime launcher command so you can run:
  tia pi [args...]

Options:
  --search     Install the native_search extension. Runtime invocations do not need --search.
  --no-search  Remove/skip the native_search extension (default unless TIA_ENABLE_NATIVE_SEARCH=1).

Environment:
  TIA_FFF_SOURCE  FFF source: vanilla (npm @ff-labs/pi-fff) or fork (edxeth/fff GitHub).
                  Set to "fork" to use the forked FFF pi-fff extension.
EOF2
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

realpath_bun() {
	bun -e 'console.log(require("node:fs").realpathSync(process.argv[1]))' "$1"
}

is_pi_package_dir() {
	local dir="$1"
	local package_json="${dir}/package.json"
	[[ -f "${package_json}" ]] || return 1
	[[ -f "${dir}/dist/cli.js" ]] || return 1
	bun -e 'const data=require(process.argv[1]); process.exit(data.name === "@earendil-works/pi-coding-agent" ? 0 : 1)' "${package_json}"
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

pi_package_version() {
	local dir="$1"
	bun -e 'const data=require(process.argv[1]); console.log(data.version ?? "")' "${dir}/package.json"
}

bun_global_pi_package_dir() {
	local global_bin global_root
	global_bin="$(bun pm bin -g 2>/dev/null || true)"
	if [[ -n "${global_bin}" && "$(basename -- "${global_bin}")" == "bin" ]]; then
		global_root="$(dirname -- "${global_bin}")"
	else
		global_root="${HOME}/.bun"
	fi
	printf '%s\n' "${global_root}/install/global/node_modules/${PACKAGE_NAME_PI}"
}

ensure_pi_package_version() {
	local package_dir="$1"

	[[ "${TIA_SKIP_PI_PACKAGE_INSTALL:-0}" != "1" ]] || return 0
	[[ -z "${PI_PACKAGE_DIR:-}" ]] || return 0

	if [[ "${TIA_PI_PACKAGE_VERSION}" != "latest" ]] && is_pi_package_dir "${package_dir}"; then
		local installed_version
		installed_version="$(pi_package_version "${package_dir}")"
		if [[ "${installed_version}" == "${TIA_PI_PACKAGE_VERSION}" ]]; then
			return 0
		fi
	fi

	printf 'Installing %s@%s\n' "${PACKAGE_NAME_PI}" "${TIA_PI_PACKAGE_VERSION}" >&2
	bun install -g "${PACKAGE_NAME_PI}@${TIA_PI_PACKAGE_VERSION}" >/dev/null
}

install_fast_tool_helpers() {
	mkdir -p "${TIA_FAST_TOOLS_DIR}"

	local helper_names="fastdrain fastedit fastread-window fastcopy fastwrite"
	local built_any=0
	local helper

	if [[ -d "${ROOT_DIR}/native" ]] && command -v gcc >/dev/null 2>&1; then
		for helper in ${helper_names}; do
			[[ -f "${ROOT_DIR}/native/${helper}.c" ]] || continue
			gcc -O3 -pipe -march=native -s \
				-o "${TIA_FAST_TOOLS_DIR}/${helper}" \
				"${ROOT_DIR}/native/${helper}.c"
			built_any=1
		done
	elif [[ -d "${ROOT_DIR}/bin" ]]; then
		for helper in ${helper_names}; do
			if [[ -x "${ROOT_DIR}/bin/${helper}" ]]; then
				cp "${ROOT_DIR}/bin/${helper}" "${TIA_FAST_TOOLS_DIR}/${helper}"
				built_any=1
			fi
		done
	fi

	if [[ "${built_any}" == "1" ]]; then
		chmod +x "${TIA_FAST_TOOLS_DIR}"/* 2>/dev/null || true
	elif [[ "${TIA_REQUIRE_FAST_HELPERS:-0}" == "1" ]]; then
		die "native fast-tool helpers were not installed"
	fi
}

install_native_search_extension() {
	if [[ "${TIA_INSTALL_NATIVE_SEARCH}" != "1" ]]; then
		rm -rf "${TIA_NATIVE_SEARCH_EXTENSION_DIR}"
		rm -f "${TIA_FAST_TOOLS_DIR}/native-search-zig"
		return 0
	fi

	rm -rf "${TIA_NATIVE_SEARCH_EXTENSION_DIR}"
	mkdir -p "${TIA_NATIVE_SEARCH_EXTENSION_DIR}"
	local file
	for file in \
		config.ts \
		discover.ts \
		http.ts \
		index.ts \
		text.ts \
		tool.ts \
		types.ts \
		native-search.zig; do
		copy_or_fetch_script_asset \
			"native-search-extension/${file}" \
			"${TIA_NATIVE_SEARCH_EXTENSION_DIR}/${file}"
	done

	if command -v zig >/dev/null 2>&1; then
		zig build-exe \
			-O ReleaseFast \
			-fsingle-threaded \
			-fstrip \
			--cache-dir "${TIA_ROOT}/zig-cache" \
			--global-cache-dir "${HOME}/.cache/zig" \
			"${TIA_NATIVE_SEARCH_EXTENSION_DIR}/native-search.zig" \
			-femit-bin="${TIA_FAST_TOOLS_DIR}/native-search-zig" >/dev/null
	elif [[ -x "${ROOT_DIR}/bin/native-search-zig" ]]; then
		cp "${ROOT_DIR}/bin/native-search-zig" "${TIA_FAST_TOOLS_DIR}/native-search-zig"
	fi
}

install_fff_extension() {
	if [[ "${TIA_ENABLE_FFF:-1}" == "0" ]]; then
		rm -rf "${TIA_FFF_EXTENSION_DIR}"
		return 0
	fi

	# Clean stale marker files when switching between fork and vanilla
	rm -f "${TIA_FFF_EXTENSION_DIR}/fff-extension.ts" "${TIA_FFF_EXTENSION_DIR}/query.ts"

	if [[ "${TIA_FFF_SOURCE}" == "fork" ]]; then
		install_fff_extension_fork
	else
		install_fff_extension_vanilla
	fi
}

install_fff_extension_vanilla() {
	mkdir -p "${TIA_FFF_EXTENSION_DIR}" "${TIA_FFF_STATE_DIR}"
	cat > "${TIA_FFF_EXTENSION_DIR}/package.json" <<EOF2
{
  "name": "tia-pi-fff-extension",
  "private": true,
  "type": "module",
  "dependencies": {
    "@ff-labs/pi-fff": "${TIA_FFF_PACKAGE_VERSION}",
    "@ff-labs/fff-node": "${TIA_FFF_PACKAGE_VERSION}"
  }
}
EOF2
	cat > "${TIA_FFF_EXTENSION_DIR}/index.ts" <<'EOF2'
export { default } from "@ff-labs/pi-fff/src/index.ts";
EOF2

	install_fff_extension_install
}

install_fff_extension_fork() {
	mkdir -p "${TIA_FFF_EXTENSION_DIR}" "${TIA_FFF_STATE_DIR}"

	cat > "${TIA_FFF_EXTENSION_DIR}/package.json" <<EOF2
{
  "name": "tia-pi-fff-extension",
  "private": true,
  "type": "module",
  "dependencies": {
    "@ff-labs/fff-node": "${TIA_FFF_PACKAGE_VERSION}"
  },
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": "*",
    "@mariozechner/pi-tui": "*",
    "@sinclair/typebox": "*"
  }
}
EOF2

	need_cmd curl
	curl -fsSL \
		"https://raw.githubusercontent.com/edxeth/fff/main/packages/pi-fff/src/index.ts" \
		-o "${TIA_FFF_EXTENSION_DIR}/fff-extension.ts"
	curl -fsSL \
		"https://raw.githubusercontent.com/edxeth/fff/main/packages/pi-fff/src/query.ts" \
		-o "${TIA_FFF_EXTENSION_DIR}/query.ts"

	cat > "${TIA_FFF_EXTENSION_DIR}/index.ts" <<'EOF2'
export { default } from "./fff-extension.ts";
EOF2

	install_fff_extension_install
}

install_fff_extension_install() {
	local install_log="${TIA_ROOT}/pi-fff-install.log"
	: > "${install_log}"
	if command -v npm >/dev/null 2>&1; then
		rm -rf "${TIA_FFF_EXTENSION_DIR}/node_modules" "${TIA_FFF_EXTENSION_DIR}/bun.lock" "${TIA_FFF_EXTENSION_DIR}/package-lock.json"
		if (cd "${TIA_FFF_EXTENSION_DIR}" && npm install --omit=dev --legacy-peer-deps >> "${install_log}" 2>&1); then
			return 0
		fi
	fi

	rm -rf "${TIA_FFF_EXTENSION_DIR}/node_modules" "${TIA_FFF_EXTENSION_DIR}/bun.lock" "${TIA_FFF_EXTENSION_DIR}/package-lock.json"
	if (cd "${TIA_FFF_EXTENSION_DIR}" && bun install --production --omit=peer >> "${install_log}" 2>&1); then
		return 0
	fi

	rm -rf "${TIA_FFF_EXTENSION_DIR}"
	if [[ "${TIA_REQUIRE_FFF:-0}" == "1" ]]; then
		die "FFF pi extension install failed (see ${install_log})"
	fi
	printf 'Warning: FFF pi extension was not installed (see %s). Set TIA_REQUIRE_FFF=1 to make this fatal, or TIA_ENABLE_FFF=0 to skip.\n' "${install_log}" >&2
}

install_pi_sandbox() {
	need_cmd bun
	mkdir -p "$(dirname -- "${TIA_PI_BIN}")" "$(dirname -- "${TIA_EXTENSION_PATH}")"

	local pi_path pi_resolved pi_package_dir pi_bin_dir base_agent_dir bun_global_pi_dir prefer_bun_global
	bun_global_pi_dir="$(bun_global_pi_package_dir)"
	prefer_bun_global=1
	if [[ "${TIA_SKIP_PI_PACKAGE_INSTALL:-0}" == "1" ]]; then
		prefer_bun_global=0
	fi
	ensure_pi_package_version "${bun_global_pi_dir}"

	pi_path="$(command -v pi 2>/dev/null || true)"
	pi_resolved=""
	if [[ -n "${pi_path}" ]]; then
		pi_resolved="$(realpath_bun "${pi_path}")"
	fi
	pi_package_dir=""
	if [[ -n "${PI_PACKAGE_DIR:-}" ]] && is_pi_package_dir "${PI_PACKAGE_DIR}"; then
		pi_package_dir="${PI_PACKAGE_DIR}"
	elif [[ "${prefer_bun_global}" == "1" ]] && is_pi_package_dir "${bun_global_pi_dir}"; then
		pi_package_dir="${bun_global_pi_dir}"
	elif pi_package_dir="$(find_pi_package_dir "${pi_resolved}" 2>/dev/null)"; then
		:
	elif is_pi_package_dir "${HOME}/.bun/install/global/node_modules/${PACKAGE_NAME_PI}"; then
		pi_package_dir="${HOME}/.bun/install/global/node_modules/${PACKAGE_NAME_PI}"
	elif [[ -f "${TIA_ROOT}/pi-package-dir.txt" ]] && is_pi_package_dir "$(cat "${TIA_ROOT}/pi-package-dir.txt")"; then
		pi_package_dir="$(cat "${TIA_ROOT}/pi-package-dir.txt")"
	else
		die "Could not locate ${PACKAGE_NAME_PI} package directory"
	fi
	pi_bin_dir="$(dirname -- "${TIA_PI_BIN}")"
	base_agent_dir="${PI_CODING_AGENT_DIR:-${HOME}/.pi/agent}"
	if [[ "${base_agent_dir}" == "${TIA_PI_AGENT_DIR}" ]]; then
		base_agent_dir="${HOME}/.pi/agent"
	fi

	# Resolve symlinks in pi_package_dir — when PI_PACKAGE_DIR is inherited from
	# a running tia shell it may point at the sandbox bin dir instead of the real
	# pi package. resolve dist/cli.js up two levels to find the actual package root.
	if [[ -L "${pi_package_dir}/dist" ]]; then
		local real_cli
		real_cli="$(realpath_bun "${pi_package_dir}/dist/cli.js" 2>/dev/null)" || true
		if [[ -n "${real_cli}" ]]; then
			pi_package_dir="$(dirname "$(dirname "${real_cli}")")"
		fi
	fi

	bun build --compile "${pi_package_dir}/dist/cli.js" --outfile "${TIA_PI_BIN}"
	copy_or_fetch_script_asset "fast-tools-extension.ts" "${TIA_EXTENSION_PATH}"
	install_fast_tool_helpers
	install_native_search_extension
	install_fff_extension

	copy_or_fetch_script_asset "pi-stream-fast.ts" "${TIA_ROOT}/pi-stream-fast.ts"
	bun -e 'const fs=require("node:fs"); const [path, packageDir]=process.argv.slice(1); fs.writeFileSync(path, fs.readFileSync(path, "utf8").replaceAll("__PI_PACKAGE_DIR__", packageDir));' "${TIA_ROOT}/pi-stream-fast.ts" "${pi_package_dir}"
	bun build --compile "${TIA_ROOT}/pi-stream-fast.ts" --outfile "${TIA_PI_STREAM_BIN}"
	ln -sfn "${pi_package_dir}/dist/modes/interactive/theme" "${pi_bin_dir}/theme"
	ln -sfn "${pi_package_dir}/dist/modes/interactive/assets" "${pi_bin_dir}/assets"
	ln -sfn "${pi_package_dir}/dist/core/export-html" "${pi_bin_dir}/export-html"
	ln -sfn "${pi_package_dir}/package.json" "${pi_bin_dir}/package.json"
	ln -sfn "${pi_package_dir}/README.md" "${pi_bin_dir}/README.md"
	ln -sfn "${pi_package_dir}/CHANGELOG.md" "${pi_bin_dir}/CHANGELOG.md"
	ln -sfn "${pi_package_dir}/docs" "${pi_bin_dir}/docs"
	ln -sfn "${pi_package_dir}/examples" "${pi_bin_dir}/examples"
	rm -f "${TIA_PI_AGENT_DIR}/auth.json" "${TIA_PI_AGENT_DIR}/models.json" "${TIA_PI_AGENT_DIR}/settings.json" "${TIA_PI_AGENT_DIR}/keybindings.json"
	if [[ -f "${base_agent_dir}/auth.json" ]]; then
		ln -s "${base_agent_dir}/auth.json" "${TIA_PI_AGENT_DIR}/auth.json"
	fi
	if [[ -f "${base_agent_dir}/models.json" ]]; then
		ln -s "${base_agent_dir}/models.json" "${TIA_PI_AGENT_DIR}/models.json"
	fi
	if [[ -f "${base_agent_dir}/settings.json" ]]; then
		ln -s "${base_agent_dir}/settings.json" "${TIA_PI_AGENT_DIR}/settings.json"
	fi
	if [[ -f "${base_agent_dir}/keybindings.json" ]]; then
		ln -s "${base_agent_dir}/keybindings.json" "${TIA_PI_AGENT_DIR}/keybindings.json"
	fi

	printf '%s\n' "${pi_package_dir}" > "${TIA_ROOT}/pi-package-dir.txt"
}

cleanup_removed_features() {
	rm -f "${TIA_ROOT}/opencode-command.txt"
	rm -rf "${TIA_ROOT}/opencode"
}

write_tia_wrapper() {
	mkdir -p "${TIA_BIN_DIR}"
	cat > "${TIA_CMD_PATH}" <<EOF2
#!/usr/bin/env bash
set -euo pipefail
TIA_ROOT="${TIA_ROOT}"
TIA_PI_BIN="${TIA_PI_BIN}"
TIA_PI_STREAM_BIN="${TIA_PI_STREAM_BIN}"
TIA_PI_AGENT_DIR="${TIA_PI_AGENT_DIR}"
TIA_FFF_STATE_DIR="${TIA_FFF_STATE_DIR}"

should_use_fast_stream() {
  [[ "\${TIA_DISABLE_FAST_STREAM:-0}" != "1" ]] || return 1
  local arg expect=""
  local has_json=0
  local has_rpc=0
  local has_no_session=0
  for arg in "\$@"; do
    if [[ -n "\${expect}" ]]; then
      case "\${expect}" in
        mode)
          [[ "\${arg}" == "json" ]] && has_json=1
          [[ "\${arg}" == "rpc" ]] && has_rpc=1
          ;;
      esac
      expect=""
      continue
    fi

    case "\${arg}" in
      --mode)
        expect="mode"
        ;;
      --mode=json)
        has_json=1
        ;;
      --mode=rpc)
        has_rpc=1
        ;;
      --no-session)
        has_no_session=1
        ;;
      --provider|--model|--thinking)
        expect="value"
        ;;
      --provider=*|--model=*|--thinking=*)
        ;;
      --no-extensions|--no-skills|--no-prompt-templates|--no-themes|--no-tools|--no-context-files|--print|-p)
        ;;
      --*)
        return 1
        ;;
      @*)
        return 1
        ;;
    esac
  done
  [[ -z "\${expect}" && "\${has_json}" == "1" && "\${has_no_session}" == "1" && "\${has_rpc}" != "1" ]]
}

ensure_cliproxy_started() {
  [[ "\${PI_NO_PROXY_AUTO_START:-0}" != "1" ]] || return 0
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user start cliproxyapi >/dev/null 2>&1 || true
  fi
}

refresh_shell_agent_links() {
  local shell_agent_dir="\${PI_CODING_AGENT_DIR:-\${HOME}/.pi/agent}"
  if [[ "\${shell_agent_dir}" == "\${TIA_PI_AGENT_DIR}" ]]; then
    shell_agent_dir="\${HOME}/.pi/agent"
  fi
  mkdir -p "\${TIA_PI_AGENT_DIR}"

  for name in auth.json models.json settings.json keybindings.json; do
    local src="\${shell_agent_dir}/\${name}"
    local dest="\${TIA_PI_AGENT_DIR}/\${name}"
    if [[ -f "\${src}" ]]; then
      local tmp
      tmp="\$(mktemp "\${dest}.tmp.XXXXXX")"
      rm -f "\${tmp}"
      ln -s "\${src}" "\${tmp}"
      mv -f "\${tmp}" "\${dest}"
    else
      rm -f "\${dest}"
    fi
  done
}

configure_fff_env() {
  mkdir -p "\${TIA_FFF_STATE_DIR}"
  local arg prev="" cli_mode=""
  for arg in "\$@"; do
    if [[ "\${prev}" == "--fff-mode" ]]; then
      cli_mode="\${arg}"
      break
    fi
    case "\${arg}" in
      --fff-mode=*)
        cli_mode="\${arg#--fff-mode=}"
        break
        ;;
    esac
    prev="\${arg}"
  done
  if [[ -n "\${cli_mode}" ]]; then
    export PI_FFF_MODE="\${cli_mode}"
  else
    export PI_FFF_MODE="\${PI_FFF_MODE:-override}"
  fi
  export FFF_FRECENCY_DB="\${FFF_FRECENCY_DB:-\${TIA_FFF_STATE_DIR}/frecency.sqlite}"
  export FFF_HISTORY_DB="\${FFF_HISTORY_DB:-\${TIA_FFF_STATE_DIR}/history.sqlite}"
}

subcommand="\${1:-}"
if [[ -z "\${subcommand}" ]]; then
  echo "Usage: tia {pi|status} [args...]" >&2
  exit 1
fi
shift || true

case "\${subcommand}" in
  pi)
    [[ -x "\${TIA_PI_BIN}" ]] || {
      echo "tia pi is not installed. Re-run: bash install.sh tia install" >&2
      exit 1
    }
    ensure_cliproxy_started
    refresh_shell_agent_links
    configure_fff_env "\$@"
    export TIA_ACTIVE=1
    export TIA_COMMAND="tia pi"
    export PI_CODING_AGENT_DIR="\${TIA_PI_AGENT_DIR}"
    export PI_PACKAGE_DIR="${TIA_ROOT}/bin"
    if should_use_fast_stream "\$@"; then
      exec "\${TIA_PI_STREAM_BIN}" "\$@"
    fi
    exec "\${TIA_PI_BIN}" "\$@"
    ;;
  status)
    echo "tia root:            \t\${TIA_ROOT}"
    if [[ -x "\${TIA_PI_BIN}" ]]; then
      echo "tia pi available:    \tyes"
    else
      echo "tia pi available:    \tno"
    fi
    echo "tia pi bin:          \t\${TIA_PI_BIN}"
    echo "tia stream:          \t\${TIA_PI_STREAM_BIN}"
    echo "tia pi agent:        \t\${TIA_PI_AGENT_DIR}"
    echo "shell pi agent:      \t\${PI_CODING_AGENT_DIR:-\${HOME}/.pi/agent}"
    echo "history mode:        \tunchanged by tia pi startup"
    echo "cliproxy auto-start:\tenabled for tia pi when systemd user services are available"
    echo "fast stream:         \tenabled by default for --mode json --no-session (set TIA_DISABLE_FAST_STREAM=1 to opt out)"
    if [[ -f "\${TIA_PI_AGENT_DIR}/extensions/native-search/index.ts" ]]; then
      echo "native search:       \tinstalled (native_search tool enabled)"
    else
      echo "native search:       \tnot installed"
    fi
    if [[ -f "\${TIA_PI_AGENT_DIR}/extensions/fff/index.ts" ]]; then
      fff_source="vanilla"
      if [[ -f "\${TIA_PI_AGENT_DIR}/extensions/fff/fff-extension.ts" ]]; then
        fff_source="fork (edxeth/fff)"
      fi
      echo "fff extension:       \tenabled (source: \${fff_source}, mode: \${PI_FFF_MODE:-override})"
    else
      echo "fff extension:       \tnot installed"
    fi
    echo "fff state:           \t\${TIA_FFF_STATE_DIR}"
    echo "pi package:          \t${TIA_ROOT}/bin"
    ;;
  *)
    echo "Unknown subcommand: \t\${subcommand}" >&2
    exit 1
    ;;
esac
EOF2
	chmod +x "${TIA_CMD_PATH}"
}

install_all() {
	need_cmd bun
	cleanup_removed_features
	install_pi_sandbox
	write_tia_wrapper
	printf 'Installed %s command at %s\n' "${RUNTIME_NAME}" "${TIA_CMD_PATH}"
	printf 'Run: tia pi\n'
	if [[ ":${PATH}:" != *":${TIA_BIN_DIR}:"* ]]; then
		printf 'Note: %s is not on PATH in this shell.\n' "${TIA_BIN_DIR}" >&2
	fi
}

uninstall_all() {
	rm -f "${TIA_CMD_PATH}"
	rm -f "${TIA_BIN_DIR}/max"
	rm -rf "${TIA_ROOT}"
	printf 'Removed %s command and runtime assets.\n' "${RUNTIME_NAME}"
}

status_all() {
	printf '%s command: %s\n' "${RUNTIME_NAME}" "${TIA_CMD_PATH}"
	[[ -x "${TIA_CMD_PATH}" ]] && printf '%s installed: yes\n' "${RUNTIME_NAME}" || printf '%s installed: no\n' "${RUNTIME_NAME}"
	printf '%s root: %s\n' "${RUNTIME_NAME}" "${TIA_ROOT}"
	if [[ -f "${TIA_ROOT}/pi-package-dir.txt" && -x "${TIA_PI_BIN}" ]]; then
		printf 'tia pi available:    yes\n'
	else
		printf 'tia pi available:    no\n'
	fi
	printf 'tia pi bin:          %s\n' "${TIA_PI_BIN}"
	printf 'tia stream:          %s\n' "${TIA_PI_STREAM_BIN}"
	printf 'tia ext:             %s\n' "${TIA_EXTENSION_PATH}"
	printf 'tia pi agent:        %s\n' "${TIA_PI_AGENT_DIR}"
	printf 'shell pi agent:      %s\n' "${PI_CODING_AGENT_DIR:-${HOME}/.pi/agent}"
	printf 'history mode:        unchanged by tia pi startup\n'
	printf 'cliproxy auto-start: enabled for tia pi when systemd user services are available\n'
	printf 'fast stream:         enabled by default for --mode json --no-session (set TIA_DISABLE_FAST_STREAM=1 to opt out)\n'
	if [[ -f "${TIA_NATIVE_SEARCH_EXTENSION_DIR}/index.ts" ]]; then
		printf 'native search:       installed (native_search tool enabled)\n'
	else
		printf 'native search:       not installed\n'
	fi
	if [[ -f "${TIA_FFF_EXTENSION_DIR}/index.ts" ]]; then
		local fff_source="vanilla"
		if [[ -f "${TIA_FFF_EXTENSION_DIR}/fff-extension.ts" ]]; then
			fff_source="fork (edxeth/fff)"
		fi
		printf 'fff extension:       enabled (source: %s, mode: %s)\n' "${fff_source}" "${PI_FFF_MODE:-override}"
	else
		printf 'fff extension:       not installed\n'
	fi
	printf 'fff state:           %s\n' "${TIA_FFF_STATE_DIR}"
	printf 'pi package:          %s\n' "${TIA_ROOT}/bin"
}

case "${ACTION}" in
	install)
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
