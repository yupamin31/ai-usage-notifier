#!/bin/bash
set -euo pipefail

readonly LOG_DIR="${1:?usage: rotate-logs.sh LOG_DIR [MAX_MB] [RETENTION_DAYS]}"
readonly MAX_MB="${2:-5}"
readonly RETENTION_DAYS="${3:-14}"
readonly MAX_BYTES="$((MAX_MB * 1024 * 1024))"
readonly TIMESTAMP="$(date '+%Y%m%d-%H%M%S')"

mkdir -p "${LOG_DIR}"

for name in launchd.stdout.log launchd.stderr.log logrotate.stderr.log; do
  file="${LOG_DIR}/${name}"
  [[ -f "${file}" ]] || continue
  size="$(stat -f '%z' "${file}")"
  if (( size >= MAX_BYTES )); then
    cp -p "${file}" "${file}.${TIMESTAMP}"
    : > "${file}"
    gzip -f "${file}.${TIMESTAMP}"
  fi
done

find "${LOG_DIR}" -type f \
  \( -name 'notifier-*.log*' -o -name 'launchd.*.log.*' -o -name 'logrotate.stderr.log.*' \) \
  -mtime "+${RETENTION_DAYS}" -delete
