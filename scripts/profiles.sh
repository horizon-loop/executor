#!/usr/bin/env bash
# horizon-loop fork: one Executor daemon per client profile (hard isolation:
# separate data dir, database, credentials, bearer token, port, process), run
# as macOS launchd agents from this checkout. The web UI switches between them
# through its server menu; `open` registers every profile there in one go.
#
#   scripts/profiles.sh add <name> [port]   register a profile (ports from 4801)
#   scripts/profiles.sh remove <name>       stop it and forget it (data kept)
#   scripts/profiles.sh up [name...]        build the UI if needed, start daemons
#   scripts/profiles.sh down [name...]      stop daemons
#   scripts/profiles.sh restart [name...]   rebuild the UI, restart daemons
#   scripts/profiles.sh status              ports, pids, health
#   scripts/profiles.sh token <name>        print the profile's bearer token
#   scripts/profiles.sh mcp <name>          print the omp/Claude mcp.json entry
#   scripts/profiles.sh open [name]         open the web UI with every profile registered
#   scripts/profiles.sh logs <name>         follow the daemon log
#
# Profiles live in $EXECUTOR_PROFILES_HOME (default ~/.executor-profiles):
# `profiles.tsv` (name<TAB>port) plus one data dir per profile. Client names
# stay out of the repository.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
home_dir="${EXECUTOR_PROFILES_HOME:-$HOME/.executor-profiles}"
registry="$home_dir/profiles.tsv"
agents_dir="$HOME/Library/LaunchAgents"
label_prefix="sh.executor.profile"
first_port=4801
bun_bin="$(command -v bun || true)"

die() { echo "profiles: $*" >&2; exit 1; }
[ "$(uname)" = Darwin ] || die "launchd agents are macOS-only."
[ -n "$bun_bin" ] || die "bun not found on PATH."
mkdir -p "$home_dir"
touch "$registry"

names() { cut -f1 "$registry"; }
port_of() { awk -F'\t' -v n="$1" '$1 == n { print $2 }' "$registry"; }
require() { [ -n "$(port_of "$1")" ] || die "unknown profile '$1' (see: $0 status)"; }
label_of() { echo "$label_prefix.$1"; }
plist_of() { echo "$agents_dir/$(label_of "$1").plist"; }
data_of() { echo "$home_dir/$1"; }
token_file() { echo "$(data_of "$1")/server-control/auth.json"; }
targets() { if [ "$#" -gt 0 ]; then for n in "$@"; do require "$n"; echo "$n"; done; else names; fi; }

ensure_ui() {
  if [ "${1:-}" = force ] || [ ! -f "$repo/apps/local/dist/index.html" ]; then
    echo "building web UI…"
    (cd "$repo/apps/local" && "$bun_bin" run build >/dev/null 2>&1) ||
      die "web UI build failed (run: cd apps/local && bun run build)"
  fi
}

write_plist() {
  local name="$1" port data
  port="$(port_of "$name")"
  data="$(data_of "$name")"
  mkdir -p "$data" "$agents_dir"
  cat >"$(plist_of "$name")" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$(label_of "$name")</string>
  <key>ProgramArguments</key>
  <array>
    <string>$bun_bin</string><string>run</string><string>$repo/apps/local/src/serve.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$repo/apps/local</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key><string>$port</string>
    <key>EXECUTOR_DATA_DIR</key><string>$data</string>
    <key>EXECUTOR_SCOPE_DIR</key><string>$data</string>
    <key>PATH</key><string>$PATH</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$data/daemon.log</string>
  <key>StandardErrorPath</key><string>$data/daemon.log</string>
</dict>
</plist>
EOF
}

healthy() { curl -fs -o /dev/null --max-time 2 "http://127.0.0.1:$(port_of "$1")/api/health"; }

wait_ready() {
  local name="$1" i
  for i in $(seq 1 60); do
    healthy "$name" && [ -s "$(token_file "$name")" ] && return 0
    sleep 0.5
  done
  die "'$name' did not come up; see $0 logs $name"
}

loaded() { launchctl print "gui/$(id -u)/$(label_of "$1")" >/dev/null 2>&1; }

stop() {
  local i
  launchctl bootout "gui/$(id -u)/$(label_of "$1")" 2>/dev/null || true
  # bootout returns before launchd finishes unloading; a bootstrap racing it fails with EIO.
  for i in $(seq 1 40); do loaded "$1" || break; sleep 0.25; done
  rm -f "$(plist_of "$1")"
}

start() {
  stop "$1"
  write_plist "$1"
  launchctl bootstrap "gui/$(id -u)" "$(plist_of "$1")"
  wait_ready "$1"
  echo "$1: http://127.0.0.1:$(port_of "$1")"
}

token() { jq -r .token "$(token_file "$1")"; }

cmd="${1:-status}"
shift || true
case "$cmd" in
  add)
    name="${1:?usage: $0 add <name> [port]}"
    [[ "$name" =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "names are lowercase letters, digits, dashes."
    [ -z "$(port_of "$name")" ] || die "'$name' already exists on port $(port_of "$name")."
    port="${2:-}"
    if [ -z "$port" ]; then
      port=$first_port
      while cut -f2 "$registry" | grep -qx "$port"; do port=$((port + 1)); done
    fi
    printf '%s\t%s\n' "$name" "$port" >>"$registry"
    echo "added $name on port $port (start it: $0 up $name)"
    ;;
  remove)
    name="${1:?usage: $0 remove <name>}"
    require "$name"
    stop "$name"
    awk -F'\t' -v n="$name" '$1 != n' "$registry" >"$registry.tmp" && mv "$registry.tmp" "$registry"
    echo "removed $name (data left in $(data_of "$name"))"
    ;;
  up)
    ensure_ui
    for n in $(targets "$@"); do start "$n"; done
    ;;
  restart)
    ensure_ui force
    for n in $(targets "$@"); do start "$n"; done
    ;;
  down)
    for n in $(targets "$@"); do stop "$n"; echo "$n: stopped"; done
    ;;
  status)
    printf '%-14s %-6s %-8s %s\n' PROFILE PORT PID STATE
    for n in $(names); do
      pid="$(launchctl list 2>/dev/null | awk -v l="$(label_of "$n")" '$3 == l { print $1 }')"
      state=stopped
      [ -n "$pid" ] && state=loaded
      healthy "$n" && state=healthy
      printf '%-14s %-6s %-8s %s\n' "$n" "$(port_of "$n")" "${pid:--}" "$state"
    done
    ;;
  token)
    require "${1:?usage: $0 token <name>}"
    token "$1"
    ;;
  mcp)
    name="${1:?usage: $0 mcp <name>}"
    require "$name"
    cat <<EOF
"executor": {
  "type": "http",
  "url": "http://127.0.0.1:$(port_of "$name")/mcp",
  "headers": {
    "Authorization": "!printf 'Bearer %s' \"\$(jq -r .token $(token_file "$name"))\""
  }
}
EOF
    echo "(toolkit endpoint: http://127.0.0.1:$(port_of "$name")/mcp/toolkits/<slug>)"
    ;;
  open)
    first="${1:-$(names | head -1)}"
    require "$first"
    json="["
    for n in $(names); do
      healthy "$n" || continue
      json="$json{\"name\":\"$n\",\"origin\":\"http://127.0.0.1:$(port_of "$n")\",\"token\":\"$(token "$n")\"},"
    done
    json="${json%,}]"
    servers="$(printf '%s' "$json" | base64 | tr '+/' '-_' | tr -d '=\n')"
    open "http://127.0.0.1:$(port_of "$first")/?_token=$(token "$first")#servers=$servers"
    ;;
  logs)
    require "${1:?usage: $0 logs <name>}"
    tail -f "$(data_of "$1")/daemon.log"
    ;;
  *)
    sed -n '2,21p' "$0"
    exit 1
    ;;
esac
