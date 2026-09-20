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
from pathlib import Path

password = os.environ.get("WEBOS_PASSWORD", "")
secret = os.environ.get("WEBOS_SECRET", "")
if len(password) < 12:
    raise SystemExit("WEBOS_PASSWORD must contain at least 12 characters")
if len(secret) < 32:
    raise SystemExit("WEBOS_SECRET must contain at least 32 characters")
path = Path(os.environ.get("WEBOS_CONFIG", "/run/lumadesk-bootstrap.json"))
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps({"password": password, "secret": secret}), encoding="utf-8")
path.chmod(0o600)
PY
unset WEBOS_PASSWORD WEBOS_SECRET
exec "$@"
