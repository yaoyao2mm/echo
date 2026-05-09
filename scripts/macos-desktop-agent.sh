#!/usr/bin/env bash
set -euo pipefail

APP_NAME="Echo Desktop Agent"
LABEL="com.echo.voice.desktop-agent"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$ROOT_DIR/dist/Echo Codex.app"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/EchoVoice"
OUT_LOG="$LOG_DIR/desktop-agent.out.log"
ERR_LOG="$LOG_DIR/desktop-agent.err.log"
APP_LOG="$LOG_DIR/desktop-app.log"
APP_OUT_LOG="$LOG_DIR/desktop-agent-app.out.log"
APP_ERR_LOG="$LOG_DIR/desktop-agent-app.err.log"
ENV_FILE="$ROOT_DIR/.env"

usage() {
  cat <<EOF
Usage: scripts/macos-desktop-agent.sh <command>

Commands:
  install     Create/update the macOS launchd service
  start       Start the desktop agent
  stop        Stop the desktop agent
  restart     Restart the desktop agent
  status      Show launchd status and recent logs
  logs        Follow desktop agent logs
  app         Build/open the Echo desktop app, which can manage the app agent itself
  settings    Open the local desktop settings page
  doctor      Check relay reachability through the same network/proxy settings
  uninstall   Stop and remove the launchd service
  print-env   Print loaded desktop-agent environment

The service reads configuration from:
  $ENV_FILE

Required values:
  ECHO_RELAY_URL=https://voice.example.com
  ECHO_TOKEN=...

Useful values:
  ECHO_CODEX_WORKSPACES=echo=/absolute/path/to/project
  ECHO_CODEX_APP_PATH=/absolute/path/to/Codex.app/Contents/Resources/codex
  ECHO_PROXY_URL=system
EOF
}

ensure_macos() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "This helper is for macOS launchd only." >&2
    exit 1
  fi
}

load_env() {
  if [[ -f "$ENV_FILE" ]]; then
  local parsed_env
    parsed_env="$(node - "$ENV_FILE" <<'NODE'
const fs = require("node:fs");
const dotenv = require("dotenv");

const wanted = [
  "ECHO_RELAY_URL",
  "ECHO_TOKEN",
  "ECHO_CODEX_WORKSPACES",
  "ECHO_CODEX_ENABLED",
  "ECHO_CODEX_APP_PATH",
  "ECHO_CODEX_SANDBOX",
  "ECHO_CODEX_APPROVAL_POLICY",
  "ECHO_CODEX_APPROVAL_TIMEOUT_MS",
  "ECHO_CODEX_ALLOWED_PERMISSION_MODES",
  "ECHO_CODEX_WORKTREE_MODE",
  "ECHO_CODEX_WORKTREE_ROOT",
  "ECHO_CODEX_WORKTREE_RETENTION_DAYS",
  "ECHO_CODEX_SESSION_CONCURRENCY",
  "ECHO_CODEX_MAX_EVENTS",
  "ECHO_CODEX_TIMEOUT_MS",
  "ECHO_CLAUDE_ENABLED",
  "ECHO_CLAUDE_COMMAND",
  "ECHO_CLAUDE_BASE_URL",
  "ECHO_CLAUDE_AUTH_TOKEN",
  "ECHO_CLAUDE_MODEL",
  "ECHO_CLAUDE_SUPPORTED_MODELS",
  "ECHO_CLAUDE_PERMISSION_MODE",
  "ECHO_CLAUDE_PROFILE",
  "ECHO_CLAUDE_ALLOWED_PERMISSION_MODES",
  "ECHO_CLAUDE_REASONING_EFFORT",
  "ECHO_CLAUDE_APPROVAL_TIMEOUT_MS",
  "ECHO_CLAUDE_TIMEOUT_MS",
  "ECHO_CLAUDE_WORKTREE_MODE",
  "ECHO_CLAUDE_SUBAGENT_MODEL",
  "ECHO_CLAUDE_AGENT_TEAMS_ENABLED",
  "ECHO_AGENT_BACKENDS_JSON",
  "ECHO_PROXY_URL",
  "ECHO_PROXY_FALLBACK_DIRECT",
  "ECHO_NO_PROXY",
  "ECHO_HTTP_TIMEOUT_MS",
  "ECHO_VOLCENGINE_CODING_ENABLED",
  "ECHO_VOLCENGINE_CODING_BACKEND_ID",
  "ECHO_VOLCENGINE_CODING_BASE_URL",
  "ECHO_VOLCENGINE_CODING_COMMAND",
  "ECHO_VOLCENGINE_CODING_MODEL",
  "ECHO_VOLCENGINE_CODING_PERMISSION_MODE",
  "ECHO_VOLCENGINE_CODING_PROFILE",
  "ECHO_VOLCENGINE_CODING_REASONING_EFFORT",
  "ECHO_VOLCENGINE_CODING_APPROVAL_TIMEOUT_MS",
  "ECHO_VOLCENGINE_CODING_TIMEOUT_MS",
  "ECHO_VOLCENGINE_CODING_SUPPORTED_MODELS",
  "ECHO_VOLCENGINE_CODING_ALLOWED_PERMISSION_MODES",
  "ECHO_VOLCENGINE_CODING_WORKTREE_MODE",
  "ECHO_VOLCENGINE_CODING_SUBAGENT_MODEL",
  "ECHO_VOLCENGINE_CODING_AGENT_TEAMS_ENABLED",
  "ECHO_VOLCENGINE_CODING_API_KEY",
  "METIO_VOLCENGINE_CODING_API_KEY",
  "METIO_VOLCENGINE_CODING_CHAT_MODEL",
  "METIO_VOLCENGINE_CODING_ANTHROPIC_BASE_URL",
  "VOLCENGINE_CODING_ANTHROPIC_BASE_URL",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "VOLCENGINE_CODING_API_KEY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ECHO_SETTINGS_HOST",
  "ECHO_SETTINGS_PORT"
];

const file = process.argv[2];
const parsed = dotenv.parse(fs.readFileSync(file));
for (const key of wanted) {
  if (Object.prototype.hasOwnProperty.call(parsed, key)) {
    console.log(`export ${key}=${JSON.stringify(parsed[key])}`);
  }
}
NODE
)"
    eval "$parsed_env"
  fi

  : "${ECHO_RELAY_URL:=}"
  : "${ECHO_TOKEN:=}"
  : "${ECHO_CODEX_WORKSPACES:=$ROOT_DIR}"
  : "${ECHO_CODEX_ENABLED:=true}"
  : "${ECHO_CODEX_APP_PATH:=}"
  : "${ECHO_CODEX_SANDBOX:=workspace-write}"
  : "${ECHO_CODEX_APPROVAL_POLICY:=on-request}"
  : "${ECHO_CODEX_APPROVAL_TIMEOUT_MS:=300000}"
  : "${ECHO_CODEX_ALLOWED_PERMISSION_MODES:=strict,approve,full}"
  : "${ECHO_CODEX_WORKTREE_MODE:=off}"
  : "${ECHO_CODEX_WORKTREE_ROOT:=$HOME/.echo-voice/worktrees}"
  : "${ECHO_CODEX_WORKTREE_RETENTION_DAYS:=14}"
  : "${ECHO_CODEX_SESSION_CONCURRENCY:=3}"
  : "${ECHO_CODEX_MAX_EVENTS:=500}"
  : "${ECHO_CODEX_TIMEOUT_MS:=1800000}"
  : "${ECHO_CLAUDE_ENABLED:=false}"
  : "${ECHO_CLAUDE_COMMAND:=claude}"
  : "${ECHO_CLAUDE_BASE_URL:=}"
  : "${ECHO_CLAUDE_AUTH_TOKEN:=}"
  : "${ECHO_CLAUDE_MODEL:=}"
  : "${ECHO_CLAUDE_SUPPORTED_MODELS:=sonnet,opus}"
  : "${ECHO_CLAUDE_PERMISSION_MODE:=strict}"
  : "${ECHO_CLAUDE_PROFILE:=}"
  : "${ECHO_CLAUDE_ALLOWED_PERMISSION_MODES:=strict}"
  : "${ECHO_CLAUDE_REASONING_EFFORT:=}"
  : "${ECHO_CLAUDE_APPROVAL_TIMEOUT_MS:=300000}"
  : "${ECHO_CLAUDE_TIMEOUT_MS:=1800000}"
  : "${ECHO_CLAUDE_WORKTREE_MODE:=$ECHO_CODEX_WORKTREE_MODE}"
  : "${ECHO_CLAUDE_SUBAGENT_MODEL:=}"
  : "${ECHO_CLAUDE_AGENT_TEAMS_ENABLED:=false}"
  : "${ECHO_AGENT_BACKENDS_JSON:=}"
  : "${ECHO_PROXY_URL:=}"
  : "${ECHO_PROXY_FALLBACK_DIRECT:=true}"
  : "${ECHO_NO_PROXY:=localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,.local}"
  : "${ECHO_HTTP_TIMEOUT_MS:=60000}"
  : "${ECHO_VOLCENGINE_CODING_ENABLED:=false}"
  : "${ECHO_VOLCENGINE_CODING_BACKEND_ID:=volcengine-coding-plan}"
  : "${ECHO_VOLCENGINE_CODING_BASE_URL:=}"
  : "${ECHO_VOLCENGINE_CODING_COMMAND:=claude}"
  : "${ECHO_VOLCENGINE_CODING_MODEL:=ark-code-latest}"
  : "${ECHO_VOLCENGINE_CODING_PERMISSION_MODE:=approve}"
  : "${ECHO_VOLCENGINE_CODING_PROFILE:=}"
  : "${ECHO_VOLCENGINE_CODING_REASONING_EFFORT:=}"
  : "${ECHO_VOLCENGINE_CODING_APPROVAL_TIMEOUT_MS:=300000}"
  : "${ECHO_VOLCENGINE_CODING_TIMEOUT_MS:=1800000}"
  : "${ECHO_VOLCENGINE_CODING_SUPPORTED_MODELS:=}"
  : "${ECHO_VOLCENGINE_CODING_ALLOWED_PERMISSION_MODES:=strict,approve,full}"
  : "${ECHO_VOLCENGINE_CODING_WORKTREE_MODE:=$ECHO_CODEX_WORKTREE_MODE}"
  : "${ECHO_VOLCENGINE_CODING_SUBAGENT_MODEL:=}"
  : "${ECHO_VOLCENGINE_CODING_AGENT_TEAMS_ENABLED:=false}"
  : "${ECHO_VOLCENGINE_CODING_API_KEY:=}"
  : "${METIO_VOLCENGINE_CODING_API_KEY:=}"
  : "${METIO_VOLCENGINE_CODING_CHAT_MODEL:=}"
  : "${METIO_VOLCENGINE_CODING_ANTHROPIC_BASE_URL:=}"
  : "${VOLCENGINE_CODING_ANTHROPIC_BASE_URL:=}"
  : "${ANTHROPIC_BASE_URL:=}"
  : "${ANTHROPIC_AUTH_TOKEN:=}"
  : "${ANTHROPIC_API_KEY:=}"
  : "${ANTHROPIC_MODEL:=}"
  : "${VOLCENGINE_CODING_API_KEY:=}"
  : "${HTTP_PROXY:=}"
  : "${HTTPS_PROXY:=}"
  : "${NO_PROXY:=}"
  : "${ECHO_SETTINGS_HOST:=127.0.0.1}"
  : "${ECHO_SETTINGS_PORT:=3891}"
  : "${USER:=$(id -un)}"
  : "${LOGNAME:=$USER}"
  : "${SHELL:=/bin/zsh}"
  : "${CODEX_HOME:=$HOME/.codex}"
  : "${LANG:=en_US.UTF-8}"
}

require_config() {
  load_env
  local missing=0

  if [[ -z "$ECHO_RELAY_URL" ]]; then
    echo "Missing ECHO_RELAY_URL in $ENV_FILE" >&2
    missing=1
  fi

  if [[ -z "$ECHO_TOKEN" ]]; then
    echo "Missing ECHO_TOKEN in $ENV_FILE" >&2
    missing=1
  fi

  if [[ "$missing" -ne 0 ]]; then
    cat >&2 <<EOF

Create $ENV_FILE with at least:

ECHO_RELAY_URL=https://voice.example.com
ECHO_TOKEN=your-pairing-token
ECHO_CODEX_WORKSPACES=echo=/absolute/path/to/project
EOF
    exit 1
  fi
}

node_path() {
  command -v node
}

agent_args_json() {
  local node_bin
  node_bin="$(node_path)"
  printf '    <string>%s</string>\n' "$node_bin"
  printf '    <string>%s</string>\n' "$ROOT_DIR/src/desktop-agent.js"
}

env_entry() {
  local key="$1"
  local value="$2"
  printf '    <key>%s</key>\n' "$key"
  printf '    <string>%s</string>\n' "$(xml_escape "$value")"
}

xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  value="${value//\"/&quot;}"
  value="${value//\'/&apos;}"
  printf '%s' "$value"
}

write_plist() {
  require_config
  mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>

  <key>ProgramArguments</key>
  <array>
$(agent_args_json)
  </array>

  <key>WorkingDirectory</key>
  <string>$(xml_escape "$ROOT_DIR")</string>

  <key>EnvironmentVariables</key>
  <dict>
$(env_entry "PATH" "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")
$(env_entry "HOME" "$HOME")
$(env_entry "USER" "$USER")
$(env_entry "LOGNAME" "$LOGNAME")
$(env_entry "SHELL" "$SHELL")
$(env_entry "CODEX_HOME" "$CODEX_HOME")
$(env_entry "LANG" "$LANG")
$(env_entry "ECHO_RELAY_URL" "$ECHO_RELAY_URL")
$(env_entry "ECHO_TOKEN" "$ECHO_TOKEN")
$(env_entry "ECHO_CODEX_WORKSPACES" "$ECHO_CODEX_WORKSPACES")
$(env_entry "ECHO_CODEX_ENABLED" "$ECHO_CODEX_ENABLED")
$(env_entry "ECHO_CODEX_APP_PATH" "$ECHO_CODEX_APP_PATH")
$(env_entry "ECHO_CODEX_SANDBOX" "$ECHO_CODEX_SANDBOX")
$(env_entry "ECHO_CODEX_APPROVAL_POLICY" "$ECHO_CODEX_APPROVAL_POLICY")
$(env_entry "ECHO_CODEX_APPROVAL_TIMEOUT_MS" "$ECHO_CODEX_APPROVAL_TIMEOUT_MS")
$(env_entry "ECHO_CODEX_ALLOWED_PERMISSION_MODES" "$ECHO_CODEX_ALLOWED_PERMISSION_MODES")
$(env_entry "ECHO_CODEX_WORKTREE_MODE" "$ECHO_CODEX_WORKTREE_MODE")
$(env_entry "ECHO_CODEX_WORKTREE_ROOT" "$ECHO_CODEX_WORKTREE_ROOT")
$(env_entry "ECHO_CODEX_WORKTREE_RETENTION_DAYS" "$ECHO_CODEX_WORKTREE_RETENTION_DAYS")
$(env_entry "ECHO_CODEX_SESSION_CONCURRENCY" "$ECHO_CODEX_SESSION_CONCURRENCY")
$(env_entry "ECHO_CODEX_MAX_EVENTS" "$ECHO_CODEX_MAX_EVENTS")
$(env_entry "ECHO_CODEX_TIMEOUT_MS" "$ECHO_CODEX_TIMEOUT_MS")
$(env_entry "ECHO_CLAUDE_ENABLED" "$ECHO_CLAUDE_ENABLED")
$(env_entry "ECHO_CLAUDE_COMMAND" "$ECHO_CLAUDE_COMMAND")
$(env_entry "ECHO_CLAUDE_BASE_URL" "$ECHO_CLAUDE_BASE_URL")
$(env_entry "ECHO_CLAUDE_AUTH_TOKEN" "$ECHO_CLAUDE_AUTH_TOKEN")
$(env_entry "ECHO_CLAUDE_MODEL" "$ECHO_CLAUDE_MODEL")
$(env_entry "ECHO_CLAUDE_SUPPORTED_MODELS" "$ECHO_CLAUDE_SUPPORTED_MODELS")
$(env_entry "ECHO_CLAUDE_PERMISSION_MODE" "$ECHO_CLAUDE_PERMISSION_MODE")
$(env_entry "ECHO_CLAUDE_PROFILE" "$ECHO_CLAUDE_PROFILE")
$(env_entry "ECHO_CLAUDE_ALLOWED_PERMISSION_MODES" "$ECHO_CLAUDE_ALLOWED_PERMISSION_MODES")
$(env_entry "ECHO_CLAUDE_REASONING_EFFORT" "$ECHO_CLAUDE_REASONING_EFFORT")
$(env_entry "ECHO_CLAUDE_APPROVAL_TIMEOUT_MS" "$ECHO_CLAUDE_APPROVAL_TIMEOUT_MS")
$(env_entry "ECHO_CLAUDE_TIMEOUT_MS" "$ECHO_CLAUDE_TIMEOUT_MS")
$(env_entry "ECHO_CLAUDE_WORKTREE_MODE" "$ECHO_CLAUDE_WORKTREE_MODE")
$(env_entry "ECHO_CLAUDE_SUBAGENT_MODEL" "$ECHO_CLAUDE_SUBAGENT_MODEL")
$(env_entry "ECHO_CLAUDE_AGENT_TEAMS_ENABLED" "$ECHO_CLAUDE_AGENT_TEAMS_ENABLED")
$(env_entry "ECHO_AGENT_BACKENDS_JSON" "$ECHO_AGENT_BACKENDS_JSON")
$(env_entry "ECHO_PROXY_URL" "$ECHO_PROXY_URL")
$(env_entry "ECHO_PROXY_FALLBACK_DIRECT" "$ECHO_PROXY_FALLBACK_DIRECT")
$(env_entry "ECHO_NO_PROXY" "$ECHO_NO_PROXY")
$(env_entry "ECHO_HTTP_TIMEOUT_MS" "$ECHO_HTTP_TIMEOUT_MS")
$(env_entry "ECHO_VOLCENGINE_CODING_ENABLED" "$ECHO_VOLCENGINE_CODING_ENABLED")
$(env_entry "ECHO_VOLCENGINE_CODING_BACKEND_ID" "$ECHO_VOLCENGINE_CODING_BACKEND_ID")
$(env_entry "ECHO_VOLCENGINE_CODING_BASE_URL" "$ECHO_VOLCENGINE_CODING_BASE_URL")
$(env_entry "ECHO_VOLCENGINE_CODING_COMMAND" "$ECHO_VOLCENGINE_CODING_COMMAND")
$(env_entry "ECHO_VOLCENGINE_CODING_MODEL" "$ECHO_VOLCENGINE_CODING_MODEL")
$(env_entry "ECHO_VOLCENGINE_CODING_PERMISSION_MODE" "$ECHO_VOLCENGINE_CODING_PERMISSION_MODE")
$(env_entry "ECHO_VOLCENGINE_CODING_PROFILE" "$ECHO_VOLCENGINE_CODING_PROFILE")
$(env_entry "ECHO_VOLCENGINE_CODING_REASONING_EFFORT" "$ECHO_VOLCENGINE_CODING_REASONING_EFFORT")
$(env_entry "ECHO_VOLCENGINE_CODING_APPROVAL_TIMEOUT_MS" "$ECHO_VOLCENGINE_CODING_APPROVAL_TIMEOUT_MS")
$(env_entry "ECHO_VOLCENGINE_CODING_TIMEOUT_MS" "$ECHO_VOLCENGINE_CODING_TIMEOUT_MS")
$(env_entry "ECHO_VOLCENGINE_CODING_SUPPORTED_MODELS" "$ECHO_VOLCENGINE_CODING_SUPPORTED_MODELS")
$(env_entry "ECHO_VOLCENGINE_CODING_ALLOWED_PERMISSION_MODES" "$ECHO_VOLCENGINE_CODING_ALLOWED_PERMISSION_MODES")
$(env_entry "ECHO_VOLCENGINE_CODING_WORKTREE_MODE" "$ECHO_VOLCENGINE_CODING_WORKTREE_MODE")
$(env_entry "ECHO_VOLCENGINE_CODING_SUBAGENT_MODEL" "$ECHO_VOLCENGINE_CODING_SUBAGENT_MODEL")
$(env_entry "ECHO_VOLCENGINE_CODING_AGENT_TEAMS_ENABLED" "$ECHO_VOLCENGINE_CODING_AGENT_TEAMS_ENABLED")
$(env_entry "ECHO_VOLCENGINE_CODING_API_KEY" "$ECHO_VOLCENGINE_CODING_API_KEY")
$(env_entry "METIO_VOLCENGINE_CODING_API_KEY" "$METIO_VOLCENGINE_CODING_API_KEY")
$(env_entry "METIO_VOLCENGINE_CODING_CHAT_MODEL" "$METIO_VOLCENGINE_CODING_CHAT_MODEL")
$(env_entry "METIO_VOLCENGINE_CODING_ANTHROPIC_BASE_URL" "$METIO_VOLCENGINE_CODING_ANTHROPIC_BASE_URL")
$(env_entry "VOLCENGINE_CODING_ANTHROPIC_BASE_URL" "$VOLCENGINE_CODING_ANTHROPIC_BASE_URL")
$(env_entry "ANTHROPIC_BASE_URL" "$ANTHROPIC_BASE_URL")
$(env_entry "ANTHROPIC_AUTH_TOKEN" "$ANTHROPIC_AUTH_TOKEN")
$(env_entry "ANTHROPIC_API_KEY" "$ANTHROPIC_API_KEY")
$(env_entry "ANTHROPIC_MODEL" "$ANTHROPIC_MODEL")
$(env_entry "VOLCENGINE_CODING_API_KEY" "$VOLCENGINE_CODING_API_KEY")
$(env_entry "HTTP_PROXY" "$HTTP_PROXY")
$(env_entry "HTTPS_PROXY" "$HTTPS_PROXY")
$(env_entry "NO_PROXY" "$NO_PROXY")
  </dict>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$OUT_LOG")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$ERR_LOG")</string>
</dict>
</plist>
EOF

  plutil -lint "$PLIST" >/dev/null
}

bootout() {
  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
}

bootstrap() {
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
}

kickstart() {
  launchctl kickstart -k "gui/$(id -u)/$LABEL"
}

install_service() {
  ensure_macos
  write_plist
  bootout
  bootstrap
  echo "$APP_NAME installed and started."
  echo "Logs: $OUT_LOG"
}

start_service() {
  ensure_macos
  if [[ ! -f "$PLIST" ]]; then
    write_plist
    bootstrap
  else
    kickstart
  fi
  echo "$APP_NAME started."
}

stop_service() {
  ensure_macos
  bootout
  echo "$APP_NAME stopped."
}

restart_service() {
  ensure_macos
  if launch_agent_loaded; then
    write_plist
    bootout
    bootstrap
    echo "$APP_NAME restarted."
    return
  fi

  local app_pid
  app_pid="$(find_app_agent_pid || true)"
  if [[ -n "$app_pid" ]]; then
    echo "Restarting app-managed $APP_NAME pid $app_pid."
    kill -TERM "$app_pid"
    echo "If the Echo desktop app is managing the agent, it will start again automatically."
    return
  fi

  write_plist
  bootout
  bootstrap
  echo "$APP_NAME restarted."
}

status_service() {
  ensure_macos
  echo "Service: $LABEL"
  echo "Plist:   $PLIST"
  echo
  echo "App-managed agent:"
  find_app_agent_process || true
  echo
  echo "LaunchAgent:"
  launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | redact_sensitive | sed -n '1,80p' || echo "Not loaded."
  echo
  echo "Recent app stdout:"
  tail -n 20 "$APP_OUT_LOG" 2>/dev/null || true
  echo
  echo "Recent app stderr:"
  tail -n 20 "$APP_ERR_LOG" 2>/dev/null || true
  echo
  echo "Recent app shell:"
  tail -n 20 "$APP_LOG" 2>/dev/null || true
  echo
  echo "Recent LaunchAgent stdout:"
  tail -n 20 "$OUT_LOG" 2>/dev/null || true
  echo
  echo "Recent LaunchAgent stderr:"
  tail -n 20 "$ERR_LOG" 2>/dev/null || true
}

follow_logs() {
  ensure_macos
  mkdir -p "$LOG_DIR"
  touch "$OUT_LOG" "$ERR_LOG" "$APP_LOG" "$APP_OUT_LOG" "$APP_ERR_LOG"
  tail -f "$APP_LOG" "$APP_OUT_LOG" "$APP_ERR_LOG" "$OUT_LOG" "$ERR_LOG"
}

doctor_network() {
  load_env
  node "$ROOT_DIR/scripts/network-doctor.js"
}

open_settings() {
  load_env
  if [[ -d "$APP_DIR" ]]; then
    open_app
    return
  fi

  if [[ -x "$ROOT_DIR/desktop-app/node_modules/.bin/electron" ]]; then
    pnpm --dir "$ROOT_DIR" --filter echo-voice-desktop-app start
  else
    echo "Native settings app is not installed yet."
    echo "Run: pnpm run desktop:app:install"
    echo "Opening browser fallback for now."
    node "$ROOT_DIR/scripts/desktop-settings.js" --open
  fi
}

open_app() {
  ensure_macos
  if [[ ! -d "$APP_DIR" ]]; then
    "$ROOT_DIR/scripts/macos-create-app.sh"
  fi
  env -u ELECTRON_RUN_AS_NODE open "$APP_DIR"
  echo "Echo desktop app opened."
}

launch_agent_loaded() {
  launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1
}

find_app_agent_pid() {
  ps -axo pid=,ppid=,command= | awk -v script="$ROOT_DIR/src/desktop-agent.js" '
    index($0, script) > 0 && $0 !~ /awk -v script/ {
      print $1
      exit
    }
  '
}

find_app_agent_process() {
  local line
  line="$(
    ps -axo pid=,ppid=,command= | awk -v script="$ROOT_DIR/src/desktop-agent.js" '
      index($0, script) > 0 && $0 !~ /awk -v script/ {
        print $0
        exit
      }
    '
  )"
  if [[ -n "$line" ]]; then
    echo "$line"
  else
    echo "Not running."
  fi
}

uninstall_service() {
  ensure_macos
  bootout
  rm -f "$PLIST"
  echo "$APP_NAME uninstalled. Logs are still in $LOG_DIR."
}

print_env() {
  load_env
  cat <<EOF
ECHO_RELAY_URL=$ECHO_RELAY_URL
ECHO_TOKEN=${ECHO_TOKEN:+<set>}
ECHO_CODEX_WORKSPACES=$ECHO_CODEX_WORKSPACES
ECHO_CODEX_ENABLED=$ECHO_CODEX_ENABLED
ECHO_CODEX_APP_PATH=$ECHO_CODEX_APP_PATH
ECHO_CODEX_SANDBOX=$ECHO_CODEX_SANDBOX
ECHO_CODEX_APPROVAL_POLICY=$ECHO_CODEX_APPROVAL_POLICY
ECHO_CODEX_APPROVAL_TIMEOUT_MS=$ECHO_CODEX_APPROVAL_TIMEOUT_MS
ECHO_CODEX_ALLOWED_PERMISSION_MODES=$ECHO_CODEX_ALLOWED_PERMISSION_MODES
ECHO_CODEX_WORKTREE_MODE=$ECHO_CODEX_WORKTREE_MODE
ECHO_CODEX_WORKTREE_ROOT=$ECHO_CODEX_WORKTREE_ROOT
ECHO_CODEX_WORKTREE_RETENTION_DAYS=$ECHO_CODEX_WORKTREE_RETENTION_DAYS
ECHO_CODEX_SESSION_CONCURRENCY=$ECHO_CODEX_SESSION_CONCURRENCY
ECHO_CODEX_MAX_EVENTS=$ECHO_CODEX_MAX_EVENTS
ECHO_CODEX_TIMEOUT_MS=$ECHO_CODEX_TIMEOUT_MS
ECHO_CLAUDE_ENABLED=$ECHO_CLAUDE_ENABLED
ECHO_CLAUDE_COMMAND=$ECHO_CLAUDE_COMMAND
ECHO_CLAUDE_BASE_URL=$ECHO_CLAUDE_BASE_URL
ECHO_CLAUDE_AUTH_TOKEN=${ECHO_CLAUDE_AUTH_TOKEN:+<set>}
ECHO_CLAUDE_MODEL=$ECHO_CLAUDE_MODEL
ECHO_CLAUDE_SUPPORTED_MODELS=$ECHO_CLAUDE_SUPPORTED_MODELS
ECHO_CLAUDE_PERMISSION_MODE=$ECHO_CLAUDE_PERMISSION_MODE
ECHO_CLAUDE_PROFILE=$ECHO_CLAUDE_PROFILE
ECHO_CLAUDE_ALLOWED_PERMISSION_MODES=$ECHO_CLAUDE_ALLOWED_PERMISSION_MODES
ECHO_CLAUDE_REASONING_EFFORT=$ECHO_CLAUDE_REASONING_EFFORT
ECHO_CLAUDE_APPROVAL_TIMEOUT_MS=$ECHO_CLAUDE_APPROVAL_TIMEOUT_MS
ECHO_CLAUDE_TIMEOUT_MS=$ECHO_CLAUDE_TIMEOUT_MS
ECHO_CLAUDE_WORKTREE_MODE=$ECHO_CLAUDE_WORKTREE_MODE
ECHO_CLAUDE_SUBAGENT_MODEL=$ECHO_CLAUDE_SUBAGENT_MODEL
ECHO_CLAUDE_AGENT_TEAMS_ENABLED=$ECHO_CLAUDE_AGENT_TEAMS_ENABLED
ECHO_AGENT_BACKENDS_JSON=${ECHO_AGENT_BACKENDS_JSON:+<set>}
ECHO_PROXY_URL=${ECHO_PROXY_URL:+$(mask_proxy "$ECHO_PROXY_URL")}
ECHO_PROXY_FALLBACK_DIRECT=$ECHO_PROXY_FALLBACK_DIRECT
ECHO_NO_PROXY=$ECHO_NO_PROXY
ECHO_HTTP_TIMEOUT_MS=$ECHO_HTTP_TIMEOUT_MS
ECHO_VOLCENGINE_CODING_ENABLED=$ECHO_VOLCENGINE_CODING_ENABLED
ECHO_VOLCENGINE_CODING_BACKEND_ID=$ECHO_VOLCENGINE_CODING_BACKEND_ID
ECHO_VOLCENGINE_CODING_BASE_URL=$ECHO_VOLCENGINE_CODING_BASE_URL
ECHO_VOLCENGINE_CODING_COMMAND=$ECHO_VOLCENGINE_CODING_COMMAND
ECHO_VOLCENGINE_CODING_MODEL=$ECHO_VOLCENGINE_CODING_MODEL
ECHO_VOLCENGINE_CODING_PERMISSION_MODE=$ECHO_VOLCENGINE_CODING_PERMISSION_MODE
ECHO_VOLCENGINE_CODING_PROFILE=$ECHO_VOLCENGINE_CODING_PROFILE
ECHO_VOLCENGINE_CODING_REASONING_EFFORT=$ECHO_VOLCENGINE_CODING_REASONING_EFFORT
ECHO_VOLCENGINE_CODING_APPROVAL_TIMEOUT_MS=$ECHO_VOLCENGINE_CODING_APPROVAL_TIMEOUT_MS
ECHO_VOLCENGINE_CODING_TIMEOUT_MS=$ECHO_VOLCENGINE_CODING_TIMEOUT_MS
ECHO_VOLCENGINE_CODING_SUPPORTED_MODELS=$ECHO_VOLCENGINE_CODING_SUPPORTED_MODELS
ECHO_VOLCENGINE_CODING_ALLOWED_PERMISSION_MODES=$ECHO_VOLCENGINE_CODING_ALLOWED_PERMISSION_MODES
ECHO_VOLCENGINE_CODING_WORKTREE_MODE=$ECHO_VOLCENGINE_CODING_WORKTREE_MODE
ECHO_VOLCENGINE_CODING_SUBAGENT_MODEL=$ECHO_VOLCENGINE_CODING_SUBAGENT_MODEL
ECHO_VOLCENGINE_CODING_AGENT_TEAMS_ENABLED=$ECHO_VOLCENGINE_CODING_AGENT_TEAMS_ENABLED
ECHO_VOLCENGINE_CODING_API_KEY=${ECHO_VOLCENGINE_CODING_API_KEY:+<set>}
METIO_VOLCENGINE_CODING_API_KEY=${METIO_VOLCENGINE_CODING_API_KEY:+<set>}
METIO_VOLCENGINE_CODING_CHAT_MODEL=$METIO_VOLCENGINE_CODING_CHAT_MODEL
METIO_VOLCENGINE_CODING_ANTHROPIC_BASE_URL=$METIO_VOLCENGINE_CODING_ANTHROPIC_BASE_URL
VOLCENGINE_CODING_ANTHROPIC_BASE_URL=$VOLCENGINE_CODING_ANTHROPIC_BASE_URL
ANTHROPIC_BASE_URL=$ANTHROPIC_BASE_URL
ANTHROPIC_AUTH_TOKEN=${ANTHROPIC_AUTH_TOKEN:+<set>}
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:+<set>}
ANTHROPIC_MODEL=$ANTHROPIC_MODEL
ECHO_SETTINGS_HOST=$ECHO_SETTINGS_HOST
ECHO_SETTINGS_PORT=$ECHO_SETTINGS_PORT
ROOT_DIR=$ROOT_DIR
EOF
}

mask_proxy() {
  node -e '
const value = process.argv[1] || "";
try {
  const url = new URL(value);
  if (url.username) url.username = "<user>";
  if (url.password) url.password = "<password>";
  console.log(url.toString());
} catch {
  console.log(value);
}
' "$1"
}

redact_sensitive() {
  sed -E \
    -e 's/(ECHO_TOKEN => ).+/\1<set>/' \
    -e 's/(ECHO_CLAUDE_AUTH_TOKEN => ).+/\1<set>/' \
    -e 's/((ECHO_)?(OPENAI|LLM|METIO|VOLCENGINE)[A-Z0-9_]*API_KEY => ).+/\1<set>/' \
    -e 's#((HTTP|HTTPS)_PROXY => https?://)[^/@]+@#\1<credentials>@#'
}

main() {
  case "${1:-}" in
    install) install_service ;;
    start) start_service ;;
    stop) stop_service ;;
    restart) restart_service ;;
    status) status_service ;;
    logs) follow_logs ;;
    app) open_app ;;
    settings) open_settings ;;
    doctor) doctor_network ;;
    uninstall) uninstall_service ;;
    print-env) print_env ;;
    -h|--help|help|"") usage ;;
    *)
      echo "Unknown command: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
}

main "$@"
