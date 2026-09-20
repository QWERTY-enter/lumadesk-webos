#!/bin/sh
set -eu

# Keep credentials out of systemd's manager environment. Docker administrators
# can still inspect container configuration, but unprivileged workspace shells
# cannot retrieve secrets with `systemctl show-environment`.
umask 077
mkdir -p /run
python3 - <<'PY'
import json
import os
import secrets
import sys
from pathlib import Path

password = os.environ.get("WEBOS_PASSWORD", "")
if len(password) < 8:
    raise SystemExit("WEBOS_PASSWORD must contain at least 8 characters")

state_dir = Path(os.environ.get("WEBOS_STATE", "/var/lib/lumadesk")).expanduser()
state_dir.mkdir(parents=True, exist_ok=True)
secret_path = state_dir / "session-secret"
secret = os.environ.get("WEBOS_SECRET", "").strip()

if len(secret) < 32:
    try:
        saved = secret_path.read_text(encoding="utf-8").strip()
    except OSError:
        saved = ""
    if len(saved) >= 32:
        secret = saved
        print(f"LumaDesk: using automatic session secret from {secret_path}", file=sys.stderr)
    else:
        secret = secrets.token_hex(32)
        temporary = secret_path.with_name(f".{secret_path.name}.{os.getpid()}.tmp")
        temporary.write_text(secret, encoding="utf-8")
        temporary.chmod(0o600)
        temporary.replace(secret_path)
        print(f"LumaDesk: generated an automatic session secret at {secret_path}", file=sys.stderr)

config_path = Path(os.environ.get("WEBOS_CONFIG", "/run/lumadesk-bootstrap.json"))
config_path.parent.mkdir(parents=True, exist_ok=True)
config_path.write_text(json.dumps({"password": password, "secret": secret}), encoding="utf-8")
config_path.chmod(0o600)
PY
unset WEBOS_PASSWORD WEBOS_SECRET

runtime=${WEBOS_RUNTIME:-auto}
if [ "$runtime" = "railway" ] || [ "$runtime" = "standalone" ]; then
    echo "LumaDesk: starting in $runtime compatibility mode (systemd service control disabled)" >&2
    exec /usr/bin/python3 /opt/lumadesk/server.py
fi

if [ "$runtime" = "auto" ] && \
   [ -n "${RAILWAY_PROJECT_ID:-}${RAILWAY_ENVIRONMENT_ID:-}${RAILWAY_SERVICE_ID:-}" ]; then
    export WEBOS_RUNTIME=railway
    echo "LumaDesk: Railway detected; starting without systemd on PORT=${PORT:-8080}" >&2
    exec /usr/bin/python3 /opt/lumadesk/server.py
fi

exec "$@"
