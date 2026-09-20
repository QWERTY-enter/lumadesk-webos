#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

run_entrypoint() {
  # Expansion is intentionally deferred to the child shell after entrypoint cleanup.
  # shellcheck disable=SC2016
  env \
    WEBOS_PASSWORD='Railway7$' \
    WEBOS_SECRET="${1:-}" \
    WEBOS_STATE="$tmp/state" \
    WEBOS_CONFIG="$tmp/bootstrap.json" \
    WEBOS_RUNTIME=auto \
    "$root/scripts/entrypoint.sh" sh -c \
      'test -z "${WEBOS_PASSWORD+x}" && test -z "${WEBOS_SECRET+x}"'
}

# A nine-character password is accepted and a strong secret is generated.
run_entrypoint ""
first=$(python3 - "$tmp/bootstrap.json" <<'PY'
import json
import sys
config = json.load(open(sys.argv[1], encoding="utf-8"))
assert config["password"] == "Railway7$"
assert len(config["secret"]) >= 32
print(config["secret"])
PY
)

# A supplied secret that is too short falls back to the same persisted secret.
run_entrypoint short
second=$(python3 - "$tmp/bootstrap.json" <<'PY'
import json
import sys
print(json.load(open(sys.argv[1], encoding="utf-8"))["secret"])
PY
)
test "$first" = "$second"
test "$(stat -c %a "$tmp/state/session-secret")" = 600

# Passwords shorter than eight characters remain rejected.
if WEBOS_PASSWORD=short WEBOS_STATE="$tmp/other" WEBOS_CONFIG="$tmp/rejected.json" \
  "$root/scripts/entrypoint.sh" true 2>/dev/null; then
  echo "entrypoint accepted an undersized password" >&2
  exit 1
fi

echo "entrypoint compatibility tests passed"
