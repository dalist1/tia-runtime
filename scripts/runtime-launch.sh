#!/usr/bin/env bash
set -euo pipefail
# __TIA_CONFIG__
TIA_PI_AGENT_DIR="${TIA_PI_AGENT_DIR:-$TIA_ROOT/pi-agent}"
TIA_FFF_STATE_DIR="$TIA_PI_AGENT_DIR/fff"

should_use_fast_stream() {
 [[ "${TIA_DISABLE_FAST_STREAM:-0}" != 1 ]] || return 1
 local arg expect="" json=0 rpc=0 ephemeral=0
 for arg in "$@"; do
  if [[ -n "$expect" ]]; then
   if [[ "$expect" == mode ]]; then
    [[ "$arg" != json ]] || json=1
    [[ "$arg" != rpc ]] || rpc=1
   fi
   expect=""; continue
  fi
  case "$arg" in
   --mode) expect=mode ;;
   --mode=json) json=1 ;;
   --mode=rpc) rpc=1 ;;
   --no-session) ephemeral=1 ;;
   --provider|--model|--thinking) expect=value ;;
   --provider=*|--model=*|--thinking=*) ;;
   --no-extensions|--no-skills|--no-prompt-templates|--no-themes|--no-tools|--no-context-files|--print|-p) ;;
   -*|@*) return 1 ;;
  esac
 done
 [[ -z "$expect" && "$json" == 1 && "$rpc" == 0 && "$ephemeral" == 1 ]]
}
ensure_proxy() {
 [[ "${PI_NO_PROXY_AUTO_START:-0}" != 1 ]] || return 0
 if command -v systemctl >/dev/null 2>&1; then
  local marker="$TIA_ROOT/.cliproxy-checked" checked=0 interval="${TIA_PROXY_CHECK_INTERVAL_SECONDS:-30}"
  if [[ -r "$marker" ]]; then read -r checked < "$marker" || checked=0; fi
  if [[ "$checked" =~ ^[0-9]+$ && "$interval" =~ ^[0-9]+$ && $((EPOCHSECONDS-checked)) -ge 0 && $((EPOCHSECONDS-checked)) -lt "$interval" ]]; then return 0; fi
  systemctl --user is-active --quiet cliproxyapi 2>/dev/null || systemctl --user start cliproxyapi >/dev/null 2>&1 || true
  printf '%s\n' "$EPOCHSECONDS" > "$marker" 2>/dev/null || true
 fi
}
shell_agent_dir() {
 local dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
 [[ "$dir" != "$TIA_PI_AGENT_DIR" ]] || dir="$HOME/.pi/agent"
 printf '%s' "$dir"
}
refresh_shell_agent_links() {
 local shell cached="" marker="$TIA_PI_AGENT_DIR/.shell-links-source" name src dest tmp
 shell="$(shell_agent_dir)"
 [[ -d "$TIA_PI_AGENT_DIR" ]] || mkdir -p "$TIA_PI_AGENT_DIR" || return 0
 if [[ -r "$marker" ]]; then
  read -r cached < "$marker" || cached=""
  if [[ "$cached" == "$shell" && ( ! -d "$shell" || ! "$shell" -nt "$marker" ) ]]; then return 0; fi
 fi
 for name in auth.json models.json settings.json keybindings.json; do
  src="$shell/$name" dest="$TIA_PI_AGENT_DIR/$name"
  if [[ -f "$src" ]]; then
   [[ "$(readlink "$dest" 2>/dev/null)" != "$src" ]] || continue
   [[ ! -e "$dest" || -L "$dest" ]] || continue
   tmp="$(mktemp "$dest.tmp.XXXXXX" 2>/dev/null)" || continue
   rm -f "$tmp" || true
   ln -s "$src" "$tmp" || { rm -f "$tmp" || true; continue; }
   mv -f "$tmp" "$dest" || { rm -f "$tmp" || true; continue; }
  elif [[ -L "$dest" ]]; then
   rm -f "$dest" || true
  fi
 done
 printf '%s\n' "$shell" > "$marker" 2>/dev/null || true
}
read_host_pi_version() {
 HOST_PI_VERSION=""
 [[ -n "${TIA_HOST_PI_PACKAGE_DIR:-}" && -r "$TIA_HOST_PI_PACKAGE_DIR/package.json" ]] || return 1
 local text
 text="$(<"$TIA_HOST_PI_PACKAGE_DIR/package.json")"
 [[ "$text" =~ \"version\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]] || return 1
 HOST_PI_VERSION="${BASH_REMATCH[1]}"
}
sync_with_host_pi() {
 [[ "${TIA_AUTO_SYNC:-1}" != 0 ]] && read_host_pi_version && [[ "$HOST_PI_VERSION" != "$TIA_PI_VERSION" ]] || return 0
 local log="$TIA_ROOT/logs/sync-$HOST_PI_VERSION.log"
 if [[ ! -e "$log" ]]; then
  ( umask 077; : > "$log" && setsid "$TIA_DISPATCHER" sync --background >> "$log" 2>&1 < /dev/null & ) || return 0
  [[ ! -t 2 ]] || printf 'tia: host pi %s differs from this runtime (%s); building a synchronized generation in the background (log: %s)\n' "$HOST_PI_VERSION" "$TIA_PI_VERSION" "$log" >&2
 elif [[ -t 2 ]]; then
  printf 'tia: host pi %s differs from this runtime (%s); a sync is running or failed (log: %s). Run tia sync to retry.\n' "$HOST_PI_VERSION" "$TIA_PI_VERSION" "$log" >&2
 fi
}
configure_fff_env() {
 if [[ -L "$TIA_FFF_STATE_DIR" && ! -d "$TIA_FFF_STATE_DIR" ]]; then rm -f "$TIA_FFF_STATE_DIR"; fi
 [[ -d "$TIA_FFF_STATE_DIR" ]] || mkdir -p "$TIA_FFF_STATE_DIR"
 local arg prev="" mode=""
 for arg in "$@"; do
  if [[ "$prev" == --fff-mode ]]; then mode="$arg"; break; fi
  case "$arg" in --fff-mode=*) mode="${arg#--fff-mode=}"; break ;; esac
  prev="$arg"
 done
 export PI_FFF_MODE="${mode:-${PI_FFF_MODE:-override}}"
 export FFF_FRECENCY_DB="${FFF_FRECENCY_DB:-$TIA_FFF_STATE_DIR/frecency.sqlite}"
 export FFF_HISTORY_DB="${FFF_HISTORY_DB:-$TIA_FFF_STATE_DIR/history.sqlite}"
}
case "${1:-}" in
 status)
  printf '%-24s%s\n' 'tia version:' "$TIA_VERSION" 'tia root:' "$TIA_ROOT" 'tia-runtime installed:' 'yes' 'tia pi available:' 'yes' 'generation:' "$TIA_GENERATION_ID" 'generation dir:' "$G" 'tia pi bin:' "$G/bin/pi" 'tia stream:' "$G/bin/pi-stream-fast" 'tia pi agent:' "$TIA_PI_AGENT_DIR" 'optimization:' "$TIA_OPTIMIZATION_VERSION" 'pi version:' "$TIA_PI_VERSION" 'full pi build:' "$TIA_FULL_BUILD_MODE" 'ESM bytecode:' "$TIA_FULL_BYTECODE" 'shell pi agent:' "$(shell_agent_dir)" 'history mode:' 'shared across generations; not rolled back' 'cliproxy auto-start:' 'enabled for tia pi when systemd user services are available' 'fast stream:' 'enabled by default for --mode json --no-session (set TIA_DISABLE_FAST_STREAM=1 to opt out)' 'fff extension:' "$TIA_FFF_STATUS" 'fff state:' "$TIA_FFF_STATE_DIR" 'pi package:' "$G/bin" 'pi source:' "$TIA_PI_SOURCE" 'host pi:' "$(read_host_pi_version && printf '%s' "$HOST_PI_VERSION" || printf 'not tracked')"
  exit 0 ;;
 sync)
  [[ "$#" == 1 || ( "$#" == 2 && "$2" == --background ) ]] || { echo 'Usage: tia sync' >&2; exit 1; }
  [[ -n "${TIA_HOST_PI_PACKAGE_DIR:-}" ]] || { echo "This runtime was installed with Pi source '$TIA_PI_SOURCE'; rerun the installer to change it." >&2; exit 1; }
  read_host_pi_version || { echo "Host Pi not found at $TIA_HOST_PI_PACKAGE_DIR" >&2; exit 1; }
  if [[ "$HOST_PI_VERSION" == "$TIA_PI_VERSION" ]]; then echo "tia runtime already matches host pi $HOST_PI_VERSION"; exit 0; fi
  [[ "$#" == 2 ]] || rm -f "$TIA_ROOT/logs/sync-$HOST_PI_VERSION.log"
  exec env -i HOME="$HOME" PATH="$PATH" ${BUN_INSTALL:+BUN_INSTALL="$BUN_INSTALL"} ${TIA_PRESERVE_FAST_TOOLS:+TIA_PRESERVE_FAST_TOOLS="$TIA_PRESERVE_FAST_TOOLS"} ${HTTP_PROXY:+HTTP_PROXY="$HTTP_PROXY"} ${HTTPS_PROXY:+HTTPS_PROXY="$HTTPS_PROXY"} ${NO_PROXY:+NO_PROXY="$NO_PROXY"} \
   flock --nonblock --no-fork "$TIA_ROOT/.upgrade.lock" "$TIA_BUN" "$G/source/runtime-manager.ts" "$TIA_ROOT" "$TIA_DISPATCHER" "$G/source" ;;
 pi) shift ;;
 *) echo 'Usage: tia {pi|status|sync|verify|generations|rollback|select|recover|prune|uninstall} [args...]' >&2; exit 1 ;;
esac
if [[ "${1:-}" == update ]]; then
 case "${2:-}" in
 ''|--self|self|pi|--all|--force) echo 'Runtime generations are immutable; rerun the tia installer to upgrade.' >&2; exit 1 ;;
 esac
 for arg in "$@"; do
  [[ "$arg" != --all && "$arg" != --self ]] || { echo 'Runtime generations are immutable; rerun the tia installer to upgrade.' >&2; exit 1; }
 done
fi
export TIA_ACTIVE=1 TIA_COMMAND="tia pi" TIA_GENERATION_DIR="$G"
export PI_PACKAGE_DIR="$G/bin"
sync_with_host_pi
if should_use_fast_stream "$@"; then
 ensure_proxy
 if [[ -n "${PI_CODING_AGENT_DIR:-}" && "$PI_CODING_AGENT_DIR" != "$TIA_PI_AGENT_DIR" ]]; then
  export TIA_STREAM_AGENT_DIR="$PI_CODING_AGENT_DIR"
 else
  refresh_shell_agent_links
  export TIA_STREAM_AGENT_DIR="$TIA_PI_AGENT_DIR"
 fi
 export PI_CODING_AGENT_DIR="$TIA_PI_AGENT_DIR"
 exec "$G/bin/pi-stream-fast" "$@"
fi
ensure_proxy
refresh_shell_agent_links
configure_fff_env "$@"
export PI_CODING_AGENT_DIR="$TIA_PI_AGENT_DIR"
export TIA_AGENT_EXTENSIONS_DIR="$G/extensions"
export TIA_FAST_TOOLS_DIR="$G/fast-tools"
export NODE_PATH="$G/pi/node_modules"
exec "$G/bin/pi" "$@"
