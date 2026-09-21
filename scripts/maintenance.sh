#!/usr/bin/env bash
set -euo pipefail

home=${WEBOS_HOME:-/home/webos}
trash="$home/.local/share/Trash/files"
trash_info="$home/.local/share/Trash/info"
mkdir -p "$trash" "$trash_info"
chown webos:webos "$trash" "$trash_info" 2>/dev/null || true

# Purge files that have remained in the desktop Trash for 30 days.
find "$trash" -mindepth 1 -maxdepth 1 -mtime +30 -exec rm -rf -- {} + 2>/dev/null || true
# Drop the matching metadata sidecars, including ones whose payload is already gone.
find "$trash_info" -mindepth 1 -maxdepth 1 -name '*.trashinfo' -mtime +30 -delete 2>/dev/null || true
shopt -s nullglob
for meta in "$trash_info"/*.trashinfo; do
  entry="$trash/$(basename "$meta" .trashinfo)"
  [ -e "$entry" ] || [ -L "$entry" ] || rm -f -- "$meta"
done
# Remove stale app-owned temporary files without touching active sessions.
find /tmp -maxdepth 1 -type f -name 'lumadesk-*' -mtime +2 -delete 2>/dev/null || true
