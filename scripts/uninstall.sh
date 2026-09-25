#!/bin/bash
set -euo pipefail

readonly USER_ID="$(id -u)"
readonly LAUNCH_AGENTS_DIR="${HOME}/Library/LaunchAgents"
readonly SERVICE_LABEL="com.local.codex-usage-notifier"
readonly ROTATE_LABEL="com.local.codex-usage-notifier.logrotate"
readonly SERVICE_PLIST="${LAUNCH_AGENTS_DIR}/${SERVICE_LABEL}.plist"
readonly ROTATE_PLIST="${LAUNCH_AGENTS_DIR}/${ROTATE_LABEL}.plist"
readonly TRASH_SUFFIX="$(date '+%Y%m%d-%H%M%S')"

launchctl bootout "gui/${USER_ID}" "${SERVICE_PLIST}" >/dev/null 2>&1 || true
launchctl bootout "gui/${USER_ID}" "${ROTATE_PLIST}" >/dev/null 2>&1 || true

# Plists are small generated files. Preserve logs, state, .env, and config so a
# future reinstall resumes without duplicate notifications.
if [[ -f "${SERVICE_PLIST}" ]]; then
  mv "${SERVICE_PLIST}" "${HOME}/.Trash/${SERVICE_LABEL}.${TRASH_SUFFIX}.plist"
fi
if [[ -f "${ROTATE_PLIST}" ]]; then
  mv "${ROTATE_PLIST}" "${HOME}/.Trash/${ROTATE_LABEL}.${TRASH_SUFFIX}.plist"
fi

echo "LaunchAgents were unloaded and moved to Trash. Logs and state were preserved."
