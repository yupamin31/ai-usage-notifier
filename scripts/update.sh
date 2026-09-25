#!/bin/bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${PROJECT_DIR}"
if [[ -d .git ]]; then
  git pull --ff-only
fi

"${SCRIPT_DIR}/install.sh"

echo "Update completed. Your .env and config/config.json were preserved."
