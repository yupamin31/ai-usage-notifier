#!/bin/bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly USER_HOME="${HOME}"
readonly USER_ID="$(id -u)"
readonly LAUNCH_AGENTS_DIR="${USER_HOME}/Library/LaunchAgents"
readonly LOG_DIR="${CODEX_NOTIFIER_LOG_DIR:-${USER_HOME}/Library/Logs/CodexNotifier}"
readonly STATE_DIR="${CODEX_NOTIFIER_STATE_DIR:-${USER_HOME}/Library/Application Support/CodexNotifier}"
readonly SERVICE_LABEL="com.local.codex-usage-notifier"
readonly ROTATE_LABEL="com.local.codex-usage-notifier.logrotate"
readonly SERVICE_PLIST="${LAUNCH_AGENTS_DIR}/${SERVICE_LABEL}.plist"
readonly ROTATE_PLIST="${LAUNCH_AGENTS_DIR}/${ROTATE_LABEL}.plist"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install it with: brew install node" >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required. Reinstall Node.js with: brew reinstall node" >&2
  exit 1
fi

readonly NODE_PATH="$(command -v node)"
readonly NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( NODE_MAJOR < 22 )); then
  echo "Node.js 22 or newer is required (found $(node --version))." >&2
  exit 1
fi

mkdir -p "${LAUNCH_AGENTS_DIR}" "${LOG_DIR}" "${STATE_DIR}/providers"
chmod 700 "${LOG_DIR}" "${STATE_DIR}" "${STATE_DIR}/providers"

if [[ ! -f "${PROJECT_DIR}/config/config.json" ]]; then
  cp "${PROJECT_DIR}/config/config.example.json" "${PROJECT_DIR}/config/config.json"
  echo "Created config/config.json"
fi
if [[ ! -f "${PROJECT_DIR}/.env" ]]; then
  cp "${PROJECT_DIR}/.env.example" "${PROJECT_DIR}/.env"
  echo "Created .env from .env.example"
fi
chmod 600 "${PROJECT_DIR}/.env" "${PROJECT_DIR}/config/config.json"

cd "${PROJECT_DIR}"
if [[ -f package-lock.json ]]; then
  npm ci
else
  npm install
fi
npm run check

escape_sed_replacement() {
  printf '%s' "$1" | sed -e 's/[&|]/\\&/g'
}

xml_escape() {
  printf '%s' "$1" | sed \
    -e 's/&/\&amp;/g' \
    -e 's/</\&lt;/g' \
    -e 's/>/\&gt;/g' \
    -e 's/"/\&quot;/g' \
    -e "s/'/\\&apos;/g"
}

render_plist() {
  local template="$1"
  local destination="$2"
  local project_escaped home_escaped node_escaped log_escaped
  project_escaped="$(escape_sed_replacement "$(xml_escape "${PROJECT_DIR}")")"
  home_escaped="$(escape_sed_replacement "$(xml_escape "${USER_HOME}")")"
  node_escaped="$(escape_sed_replacement "$(xml_escape "${NODE_PATH}")")"
  log_escaped="$(escape_sed_replacement "$(xml_escape "${LOG_DIR}")")"
  sed \
    -e "s|__PROJECT_DIR__|${project_escaped}|g" \
    -e "s|__USER_HOME__|${home_escaped}|g" \
    -e "s|__NODE_PATH__|${node_escaped}|g" \
    -e "s|__LOG_DIR__|${log_escaped}|g" \
    "${template}" > "${destination}"
  chmod 600 "${destination}"
  plutil -lint "${destination}" >/dev/null
}

render_plist "${PROJECT_DIR}/launchd/${SERVICE_LABEL}.plist.template" "${SERVICE_PLIST}"
render_plist "${PROJECT_DIR}/launchd/${ROTATE_LABEL}.plist.template" "${ROTATE_PLIST}"

if grep -q 'DISCORD_BOT_TOKEN=replace-me' "${PROJECT_DIR}/.env"; then
  echo
  echo "Installation files are ready, but the service was not started."
  echo "1. Run ./scripts/configure-discord-bot.sh"
  echo "2. Run ./scripts/install.sh again"
  exit 0
fi

launchctl bootout "gui/${USER_ID}" "${SERVICE_PLIST}" >/dev/null 2>&1 || true
launchctl bootout "gui/${USER_ID}" "${ROTATE_PLIST}" >/dev/null 2>&1 || true
launchctl bootstrap "gui/${USER_ID}" "${SERVICE_PLIST}"
launchctl bootstrap "gui/${USER_ID}" "${ROTATE_PLIST}"
launchctl enable "gui/${USER_ID}/${SERVICE_LABEL}"
launchctl enable "gui/${USER_ID}/${ROTATE_LABEL}"
launchctl kickstart "gui/${USER_ID}/${SERVICE_LABEL}"

echo
echo "Codex Usage Notifier is installed and running."
echo "Status: launchctl print gui/${USER_ID}/${SERVICE_LABEL}"
echo "Logs:   tail -f '${LOG_DIR}/notifier-$(date +%F).log'"
