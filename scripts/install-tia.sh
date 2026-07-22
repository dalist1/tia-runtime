#!/usr/bin/env bash

set -euo pipefail

ACTION="${1:-install}"
if [[ "$#" -gt 0 ]]; then
	shift
fi
for arg in "$@"; do
	printf 'Error: unsupported installer option: %s\n' "${arg}" >&2
	exit 1
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
ORIGINAL_PATH="${PATH}"
export PATH="${TIA_BIN_DIR}:${PATH}"
TIA_CMD_PATH="${TIA_BIN_DIR}/tia"
TIA_PI_BIN="${TIA_ROOT}/bin/pi"
TIA_PI_STREAM_BIN="${TIA_ROOT}/bin/pi-stream-fast"
TIA_PI_STREAM_RUNTIME_DIR="${TIA_ROOT}/stream-runtime"
TIA_PI_AGENT_DIR="${TIA_ROOT}/pi-agent"
TIA_EXTENSION_PATH="${TIA_PI_AGENT_DIR}/extensions/fast-tools.ts"
TIA_FAST_TOOLS_DIR="${TIA_PI_AGENT_DIR}/fast-tools"
TIA_FFF_EXTENSION_DIR="${TIA_PI_AGENT_DIR}/extensions/fff"
TIA_FFF_STATE_DIR="${TIA_PI_AGENT_DIR}/fff"
TIA_FFF_SOURCE_FILE="${TIA_ROOT}/fff-source.txt"
TIA_FFF_PACKAGE_VERSION="${TIA_FFF_PACKAGE_VERSION:-nightly}"
if [[ -z "${TIA_FFF_SOURCE:-}" && -f "${TIA_FFF_SOURCE_FILE}" ]]; then
	TIA_FFF_SOURCE="$(tr -d '[:space:]' < "${TIA_FFF_SOURCE_FILE}")"
fi
TIA_FFF_SOURCE="${TIA_FFF_SOURCE:-vanilla}"
TIA_PI_PACKAGE_VERSION="${TIA_PI_PACKAGE_VERSION:-0.81.1}"
TIA_OPTIMIZATION_VERSION="${TIA_OPTIMIZATION_VERSION:-}"
if [[ -z "${TIA_OPTIMIZATION_VERSION}" && -f "${ROOT_DIR}/OPTIMIZATION_VERSION" ]]; then
	TIA_OPTIMIZATION_VERSION="$(tr -d '[:space:]' < "${ROOT_DIR}/OPTIMIZATION_VERSION")"
fi
TIA_OPTIMIZATION_VERSION="${TIA_OPTIMIZATION_VERSION:-2026-07-low-level-v4}"
PACKAGE_NAME_PI="@earendil-works/pi-coding-agent"

usage() {
	cat <<EOF2
Usage:
  install-tia.sh install
  install-tia.sh uninstall
  install-tia.sh status

Installs the tia-runtime launcher command so you can run:
  tia pi [args...]

Environment:
  TIA_FFF_SOURCE  FFF source: vanilla (npm @ff-labs/pi-fff) or fork (edxeth/fff GitHub).
                  Set to "fork" to use the forked FFF pi-fff extension.
  TIA_PROXY_CHECK_INTERVAL_SECONDS
                  Cache cliproxy service checks for this many seconds (default: 30; 0 disables caching).
EOF2
}

die() {
	printf 'Error: %s\n' "$*" >&2
	exit 1
}

need_cmd() {
	command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

ensure_directory() {
	local path="$1"
	if [[ -L "${path}" && ! -d "${path}" ]]; then
		rm -f "${path}"
	fi
	mkdir -p "${path}"
	[[ -d "${path}" ]] || die "Could not create directory: ${path}"
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
	[[ -n "${path}" ]] || return 1
	local dir prev_dir=""
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
		prev_dir="${dir}"
		dir="$(dirname "${dir}")"
		if [[ "${dir}" == "${prev_dir}" ]]; then
			break
		fi
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
	[[ -z "${PI_PACKAGE_DIR:-}" || "${PI_PACKAGE_DIR}" == "${TIA_ROOT}/bin" ]] || return 0

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
	rm -rf "${TIA_FAST_TOOLS_DIR}"
	mkdir -p "${TIA_FAST_TOOLS_DIR}"

	local helper_names="fastdrain fastcopy"
	local built_any=0
	local helper

	if [[ -d "${ROOT_DIR}/native" ]] && command -v zig >/dev/null 2>&1; then
		for helper in ${helper_names}; do
			[[ -f "${ROOT_DIR}/native/${helper}.c" ]] || continue
			zig cc -O3 -pipe -march=native -s \
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
	fi

	if [[ "${TIA_REQUIRE_FAST_HELPERS:-0}" == "1" ]]; then
		if [[ "${built_any}" != "1" ]]; then
			die "native fast-tool helpers were not installed"
		fi
		local missing=""
		for helper in ${helper_names}; do
			[[ -x "${TIA_FAST_TOOLS_DIR}/${helper}" ]] || missing="${missing} ${helper}"
		done
		if [[ -n "${missing}" ]]; then
			die "native fast-tool helpers missing:${missing}"
		fi
	fi
}

install_fff_extension() {
	if [[ "${TIA_ENABLE_FFF:-1}" == "0" ]]; then
		rm -rf "${TIA_FFF_EXTENSION_DIR}"
		return 0
	fi

	case "${TIA_FFF_SOURCE}" in
		vanilla|fork)
			;;
		*)
			die "Unsupported TIA_FFF_SOURCE: ${TIA_FFF_SOURCE}"
			;;
	esac
	mkdir -p "${TIA_ROOT}"
	printf '%s\n' "${TIA_FFF_SOURCE}" > "${TIA_FFF_SOURCE_FILE}"

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
    "@edxeth/pi-fff": "${TIA_FFF_PACKAGE_VERSION}",
    "@edxeth/fff-node": "${TIA_FFF_PACKAGE_VERSION}"
  },
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": "*",
    "@mariozechner/pi-tui": "*",
    "@sinclair/typebox": "*"
  }
}
EOF2

	cat > "${TIA_FFF_EXTENSION_DIR}/index.ts" <<'EOF2'
export { default } from "@edxeth/pi-fff/src/index.ts";
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
	ensure_directory "${TIA_FFF_STATE_DIR}"

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
	if [[ -n "${PI_PACKAGE_DIR:-}" && "${PI_PACKAGE_DIR}" != "${TIA_ROOT}/bin" ]] && is_pi_package_dir "${PI_PACKAGE_DIR}"; then
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

	if [[ -L "${pi_package_dir}/dist" ]]; then
		local real_cli
		real_cli="$(realpath_bun "${pi_package_dir}/dist/cli.js" 2>/dev/null)" || true
		if [[ -n "${real_cli}" ]]; then
			pi_package_dir="$(dirname "$(dirname "${real_cli}")")"
		fi
	fi

	bun build --compile --minify "${pi_package_dir}/dist/cli.js" --outfile "${TIA_PI_BIN}"
	rm -rf "${TIA_PI_AGENT_DIR}/extensions"
	mkdir -p "$(dirname -- "${TIA_EXTENSION_PATH}")"
	copy_or_fetch_script_asset "fast-tools-extension.ts" "${TIA_EXTENSION_PATH}"
	local pi_node_modules
	pi_node_modules="$(dirname -- "$(dirname -- "${pi_package_dir}")")"
	ln -sfn "${pi_node_modules}" "${TIA_PI_AGENT_DIR}/node_modules"
	install_fast_tool_helpers
	install_fff_extension

	copy_or_fetch_script_asset "pi-stream-fast.ts" "${TIA_ROOT}/pi-stream-fast.ts"
	rm -rf "${TIA_PI_STREAM_RUNTIME_DIR}"
	mkdir -p "${TIA_PI_STREAM_RUNTIME_DIR}"
	local pi_ai_dir catalog_builder
	pi_ai_dir="$(dirname -- "${pi_package_dir}")/pi-ai"
	[[ -f "${pi_ai_dir}/dist/api/anthropic-messages.js" ]] || die "Could not locate pi-ai stream implementations"
	[[ -f "${pi_package_dir}/dist/core/model-resolver.js" ]] || die "Could not locate pi default model definitions"
	catalog_builder="${TIA_ROOT}/build-stream-catalog.ts"
	copy_or_fetch_script_asset "build-stream-catalog.ts" "${catalog_builder}"
	bun "${catalog_builder}" \
		"${pi_ai_dir}/dist/models.generated.js" \
		"${pi_package_dir}/dist/core/model-resolver.js" \
		"${TIA_PI_STREAM_RUNTIME_DIR}"
	rm -f "${catalog_builder}"
	bun build --target=bun --format=esm --minify --splitting \
		--entry-naming='[name].mjs' \
		--chunk-naming='chunks/[name]-[hash].mjs' \
		--outdir="${TIA_PI_STREAM_RUNTIME_DIR}" \
		"${pi_ai_dir}/dist/api/anthropic-messages.js" \
		"${pi_ai_dir}/dist/api/azure-openai-responses.js" \
		"${pi_ai_dir}/dist/api/bedrock-converse-stream.js" \
		"${pi_ai_dir}/dist/api/google-generative-ai.js" \
		"${pi_ai_dir}/dist/api/google-vertex.js" \
		"${pi_ai_dir}/dist/api/mistral-conversations.js" \
		"${pi_ai_dir}/dist/api/openai-codex-responses.js" \
		"${pi_ai_dir}/dist/api/openai-completions.js" \
		"${pi_ai_dir}/dist/api/openai-responses.js" \
		"${pi_ai_dir}/dist/oauth.js" >/dev/null
	bun -e 'const fs=require("node:fs"); const [path, packageDir, runtimeDir, defaultsPath]=process.argv.slice(1); const marker="{} /* __TIA_DEFAULT_MODELS__ */"; const input=fs.readFileSync(path, "utf8"); if (!input.includes(marker)) throw new Error("default model marker not found"); const output=input.replaceAll("__PI_PACKAGE_DIR__", packageDir).replaceAll("__STREAM_RUNTIME_DIR__", runtimeDir).replace(marker, fs.readFileSync(defaultsPath, "utf8")); fs.writeFileSync(path, output);' \
		"${TIA_ROOT}/pi-stream-fast.ts" \
		"${pi_package_dir}" \
		"${TIA_PI_STREAM_RUNTIME_DIR}" \
		"${TIA_PI_STREAM_RUNTIME_DIR}/default-models.json"
	if ! bun build --compile --minify --bytecode "${TIA_ROOT}/pi-stream-fast.ts" --outfile "${TIA_PI_STREAM_BIN}" >/dev/null 2>&1; then
		bun build --compile --minify "${TIA_ROOT}/pi-stream-fast.ts" --outfile "${TIA_PI_STREAM_BIN}"
	fi
	rm -rf "${pi_bin_dir}/dist" "${pi_bin_dir}/theme" "${pi_bin_dir}/assets" "${pi_bin_dir}/export-html" "${pi_bin_dir}/package.json" "${pi_bin_dir}/README.md" "${pi_bin_dir}/CHANGELOG.md" "${pi_bin_dir}/docs" "${pi_bin_dir}/examples"
	ln -s "${pi_package_dir}/dist/modes/interactive/theme" "${pi_bin_dir}/theme"
	ln -s "${pi_package_dir}/dist/modes/interactive/assets" "${pi_bin_dir}/assets"
	ln -s "${pi_package_dir}/dist/core/export-html" "${pi_bin_dir}/export-html"
	ln -s "${pi_package_dir}/package.json" "${pi_bin_dir}/package.json"
	ln -s "${pi_package_dir}/README.md" "${pi_bin_dir}/README.md"
	ln -s "${pi_package_dir}/CHANGELOG.md" "${pi_bin_dir}/CHANGELOG.md"
	ln -s "${pi_package_dir}/docs" "${pi_bin_dir}/docs"
	ln -s "${pi_package_dir}/examples" "${pi_bin_dir}/examples"
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

write_tia_wrapper() {
	mkdir -p "${TIA_BIN_DIR}"
	local installed_pi_version="unknown"
	if [[ -f "${TIA_ROOT}/pi-package-dir.txt" ]]; then
		local installed_pi_dir
		installed_pi_dir="$(cat "${TIA_ROOT}/pi-package-dir.txt")"
		if is_pi_package_dir "${installed_pi_dir}"; then
			installed_pi_version="$(pi_package_version "${installed_pi_dir}")"
		fi
	fi
	cat > "${TIA_CMD_PATH}" <<EOF2
#!/usr/bin/env bash
set -euo pipefail
TIA_ROOT="${TIA_ROOT}"
TIA_PI_BIN="${TIA_PI_BIN}"
TIA_PI_STREAM_BIN="${TIA_PI_STREAM_BIN}"
TIA_PI_AGENT_DIR="${TIA_PI_AGENT_DIR}"
TIA_FFF_STATE_DIR="${TIA_FFF_STATE_DIR}"
TIA_FFF_SOURCE_FILE="${TIA_FFF_SOURCE_FILE}"
TIA_OPTIMIZATION_VERSION="${TIA_OPTIMIZATION_VERSION}"
TIA_PI_VERSION="${installed_pi_version}"

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
      -*)
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
    local marker="\${TIA_ROOT}/.cliproxy-checked" checked=0 interval="\${TIA_PROXY_CHECK_INTERVAL_SECONDS:-30}"
    if [[ -r "\${marker}" ]]; then
      read -r checked < "\${marker}" || checked=0
    fi
    if [[ "\${checked}" =~ ^[0-9]+$ && "\${interval}" =~ ^[0-9]+$ && \$((EPOCHSECONDS - checked)) -ge 0 && \$((EPOCHSECONDS - checked)) -lt "\${interval}" ]]; then
      return 0
    fi
    systemctl --user is-active --quiet cliproxyapi 2>/dev/null || systemctl --user start cliproxyapi >/dev/null 2>&1 || true
    printf '%s\n' "\${EPOCHSECONDS}" > "\${marker}" 2>/dev/null || true
  fi
}

refresh_shell_agent_links() {
  local shell_agent_dir="\${PI_CODING_AGENT_DIR:-\${HOME}/.pi/agent}"
  if [[ "\${shell_agent_dir}" == "\${TIA_PI_AGENT_DIR}" ]]; then
    shell_agent_dir="\${HOME}/.pi/agent"
  fi
  [[ -d "\${TIA_PI_AGENT_DIR}" ]] || mkdir -p "\${TIA_PI_AGENT_DIR}" || return 0
  local marker="\${TIA_PI_AGENT_DIR}/.shell-links-source" cached_source=""
  if [[ -r "\${marker}" ]]; then
    read -r cached_source < "\${marker}" || cached_source=""
    if [[ "\${cached_source}" == "\${shell_agent_dir}" && ( ! -d "\${shell_agent_dir}" || ! "\${shell_agent_dir}" -nt "\${marker}" ) ]]; then
      return 0
    fi
  fi

  for name in auth.json models.json settings.json keybindings.json; do
    local src="\${shell_agent_dir}/\${name}"
    local dest="\${TIA_PI_AGENT_DIR}/\${name}"
    if [[ -f "\${src}" ]]; then
      [[ "\$(readlink "\${dest}" 2>/dev/null)" == "\${src}" ]] && continue
      local tmp
      tmp="\$(mktemp "\${dest}.tmp.XXXXXX" 2>/dev/null)" || continue
      rm -f "\${tmp}" || true
      ln -s "\${src}" "\${tmp}" || { rm -f "\${tmp}" || true; continue; }
      mv -f "\${tmp}" "\${dest}" || { rm -f "\${tmp}" || true; continue; }
    else
      rm -f "\${dest}" || true
    fi
  done
  printf '%s\n' "\${shell_agent_dir}" > "\${marker}" 2>/dev/null || true
  return 0
}

configure_fff_env() {
  if [[ -L "\${TIA_FFF_STATE_DIR}" && ! -d "\${TIA_FFF_STATE_DIR}" ]]; then
    rm -f "\${TIA_FFF_STATE_DIR}"
  fi
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
    export TIA_ACTIVE=1
    export TIA_COMMAND="tia pi"
    if should_use_fast_stream "\$@"; then
      ensure_cliproxy_started
      TIA_STREAM_AGENT_DIR="\${PI_CODING_AGENT_DIR:-\${HOME}/.pi/agent}"
      if [[ "\${TIA_STREAM_AGENT_DIR}" == "\${TIA_PI_AGENT_DIR}" ]]; then
        TIA_STREAM_AGENT_DIR="\${HOME}/.pi/agent"
      fi
      export TIA_STREAM_AGENT_DIR
      export PI_CODING_AGENT_DIR="\${TIA_PI_AGENT_DIR}"
      export PI_PACKAGE_DIR="${TIA_ROOT}/bin"
      exec "\${TIA_PI_STREAM_BIN}" "\$@"
    fi
    ensure_cliproxy_started
    refresh_shell_agent_links
    configure_fff_env "\$@"
    export PI_CODING_AGENT_DIR="\${TIA_PI_AGENT_DIR}"
    export PI_PACKAGE_DIR="${TIA_ROOT}/bin"
    export NODE_PATH="\${TIA_PI_AGENT_DIR}/node_modules\${NODE_PATH:+:\${NODE_PATH}}"
    exec "\${TIA_PI_BIN}" "\$@"
    ;;
  status)
    printf '%-22s%s\n' 'tia root:' "\${TIA_ROOT}"
    if [[ -x "\${TIA_PI_BIN}" ]]; then
      printf '%-22s%s\n' 'tia pi available:' 'yes'
    else
      printf '%-22s%s\n' 'tia pi available:' 'no'
    fi
    printf '%-22s%s\n' 'tia pi bin:' "\${TIA_PI_BIN}"
    printf '%-22s%s\n' 'tia stream:' "\${TIA_PI_STREAM_BIN}"
    printf '%-22s%s\n' 'tia pi agent:' "\${TIA_PI_AGENT_DIR}"
    printf '%-22s%s\n' 'optimization:' "\${TIA_OPTIMIZATION_VERSION}"
    printf '%-22s%s\n' 'pi version:' "\${TIA_PI_VERSION}"
    printf '%-22s%s\n' 'shell pi agent:' "\${PI_CODING_AGENT_DIR:-\${HOME}/.pi/agent}"
    printf '%-22s%s\n' 'history mode:' 'unchanged by tia pi startup'
    printf '%-22s%s\n' 'cliproxy auto-start:' 'enabled for tia pi when systemd user services are available'
    printf '%-22s%s\n' 'fast stream:' 'enabled by default for --mode json --no-session (set TIA_DISABLE_FAST_STREAM=1 to opt out)'
    if [[ -f "\${TIA_PI_AGENT_DIR}/extensions/fff/index.ts" ]]; then
      fff_source="vanilla"
      if grep -q '@edxeth/pi-fff' "\${TIA_PI_AGENT_DIR}/extensions/fff/package.json" 2>/dev/null; then
        fff_source="fork (edxeth/fff)"
      elif [[ -f "\${TIA_FFF_SOURCE_FILE}" ]]; then
        fff_source="\$(cat "\${TIA_FFF_SOURCE_FILE}")"
      fi
      printf '%-22s%s\n' 'fff extension:' "enabled (source: \${fff_source}, mode: \${PI_FFF_MODE:-override})"
    else
      printf '%-22s%s\n' 'fff extension:' 'not installed'
    fi
    printf '%-22s%s\n' 'fff state:' "\${TIA_FFF_STATE_DIR}"
    printf '%-22s%s\n' 'pi package:' '${TIA_ROOT}/bin'
    ;;
  *)
    printf 'Unknown subcommand: %s\n' "\${subcommand}" >&2
    exit 1
    ;;
esac
EOF2
	chmod +x "${TIA_CMD_PATH}"
}

install_all() {
	need_cmd bun
	install_pi_sandbox
	write_tia_wrapper
	printf 'Installed %s command at %s\n' "${RUNTIME_NAME}" "${TIA_CMD_PATH}"
	if [[ ":${ORIGINAL_PATH}:" != *":${TIA_BIN_DIR}:"* ]]; then
		printf 'Note: %s is not on PATH in this shell. Add it to PATH, then run: tia pi\n' "${TIA_BIN_DIR}" >&2
		printf 'Run now: %s pi\n' "${TIA_CMD_PATH}"
	else
		printf 'Run: tia pi\n'
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
	printf 'optimization:        %s\n' "${TIA_OPTIMIZATION_VERSION}"
	if [[ -f "${TIA_ROOT}/pi-package-dir.txt" ]] && is_pi_package_dir "$(cat "${TIA_ROOT}/pi-package-dir.txt")"; then
		printf 'pi version:          %s\n' "$(pi_package_version "$(cat "${TIA_ROOT}/pi-package-dir.txt")")"
	else
		printf 'pi version:          unknown\n'
	fi
	printf 'shell pi agent:      %s\n' "${PI_CODING_AGENT_DIR:-${HOME}/.pi/agent}"
	printf 'history mode:        unchanged by tia pi startup\n'
	printf 'cliproxy auto-start: enabled for tia pi when systemd user services are available\n'
	printf 'fast stream:         enabled by default for --mode json --no-session (set TIA_DISABLE_FAST_STREAM=1 to opt out)\n'
	if [[ -f "${TIA_FFF_EXTENSION_DIR}/index.ts" ]]; then
		local fff_source="vanilla"
		if grep -q '@edxeth/pi-fff' "${TIA_FFF_EXTENSION_DIR}/package.json" 2>/dev/null; then
			fff_source="fork (edxeth/fff)"
		elif [[ -f "${TIA_FFF_SOURCE_FILE}" ]]; then
			fff_source="$(cat "${TIA_FFF_SOURCE_FILE}")"
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
