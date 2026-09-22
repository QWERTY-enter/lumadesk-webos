#!/usr/bin/env bash
set -euo pipefail

# Backup the LumaDesk named volumes (workspace home and application state)
# plus the local .env credentials file into timestamped archives.
#
# Usage: ./scripts/backup.sh [output-directory]
# Restore is documented in the README ("Persistence and backup").

cd "$(dirname "$0")/.."

project="${COMPOSE_PROJECT_NAME:-lumadesk}"
out="${1:-$PWD/backups}"
stamp="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$out"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required to read the LumaDesk volumes." >&2
  exit 1
fi

wrote=0
for volume in "${project}_lumadesk-home" "${project}_lumadesk-state"; do
  if ! docker volume inspect "$volume" >/dev/null 2>&1; then
    echo "Skipping missing volume: $volume" >&2
    continue
  fi
  target="${out}/${volume}-${stamp}.tgz"
  docker run --rm \
    -v "${volume}:/source:ro" \
    -v "${out}:/backup" \
    alpine:3 \
    tar czf "/backup/$(basename "$target")" -C /source .
  chmod 600 "$target"
  echo "Wrote $target"
  wrote=$((wrote + 1))
done

if [[ -f .env ]]; then
  umask 077
  cp .env "${out}/env-${stamp}"
  echo "Wrote ${out}/env-${stamp} (mode 600)"
  wrote=$((wrote + 1))
fi

if ((wrote == 0)); then
  echo "Nothing to back up: no LumaDesk volumes or .env found." >&2
  echo "Start the stack once (docker compose up -d) or set COMPOSE_PROJECT_NAME." >&2
  exit 1
fi

echo "Backup finished: $wrote file(s) in $out"
echo "Verify restores on a stopped stack after keeping a second safety copy."
