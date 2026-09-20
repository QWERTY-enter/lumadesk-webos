#!/usr/bin/env bash
set -euo pipefail

trash=/home/webos/.local/share/Trash/files
mkdir -p "$trash"
chown webos:webos "$trash" 2>/dev/null || true

# Purge files that have remained in the desktop Trash for 30 days.
find "$trash" -mindepth 1 -maxdepth 1 -mtime +30 -exec rm -rf -- {} + 2>/dev/null || true
# Remove stale app-owned temporary files without touching active sessions.
find /tmp -maxdepth 1 -type f -name 'lumadesk-*' -mtime +2 -delete 2>/dev/null || true
