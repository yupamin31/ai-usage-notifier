#!/bin/bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly ENV_FILE="${PROJECT_DIR}/.env"
printf 'Discord Bot token: '
IFS= read -r -s bot_token
printf '\n'

if [[ -z "${bot_token}" ]]; then
  echo "Bot token cannot be empty." >&2
  exit 1
fi

printf 'Channel ID: '
IFS= read -r channel_id

if [[ ! "${channel_id}" =~ ^[0-9]{17,20}$ ]]; then
  echo "Channel ID must contain 17-20 digits." >&2
  exit 1
fi

umask 077
{
  printf 'DISCORD_BOT_TOKEN=%s\n' "${bot_token}"
  printf 'DISCORD_CHANNEL_ID=%s\n' "${channel_id}"
} > "${ENV_FILE}"
chmod 600 "${ENV_FILE}"

unset bot_token
echo "Discord Bot settings saved to ${ENV_FILE} (mode 600)."
