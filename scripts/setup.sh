#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
umask 077

force=false
domain=""
while (($#)); do
  case "$1" in
    --force) force=true ;;
    --domain) shift; domain="${1:-}" ;;
    -h|--help)
      cat <<'EOF'
Usage: ./scripts/setup.sh [--domain os.example.com] [--force]

Creates .env with a random login password and signing secret. Set the
WEBOS_PASSWORD environment variable first to use your own password.
EOF
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

if [[ -e .env && "$force" != true ]]; then
  echo "A .env file already exists. Use --force to replace it." >&2
  exit 1
fi

random_hex() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex "$1"
  else head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

password="${WEBOS_PASSWORD:-$(random_hex 14)}"
secret="$(random_hex 32)"
if ((${#password} < 8)); then
  echo "WEBOS_PASSWORD must contain at least 8 characters." >&2
  exit 1
fi

# Compose treats single-quoted .env values literally. Refuse the one awkward
# character rather than risk writing a subtly different credential.
if [[ "$password" == *"'"* ]]; then
  echo "WEBOS_PASSWORD may not contain a single quote when using this setup helper." >&2
  exit 1
fi

profiles=""
secure="auto"
if [[ -n "$domain" ]]; then profiles="public"; fi

cat > .env <<EOF
WEBOS_PASSWORD='$password'
WEBOS_SECRET='$secret'
WEBOS_IMAGE=ghcr.io/qwerty-enter/lumadesk-webos:1.4.0
WEBOS_BIND=127.0.0.1
WEBOS_PORT=8080
WEBOS_DOMAIN=${domain:-os.example.com}
WEBOS_SECURE_COOKIE=$secure
WEBOS_SESSION_SECONDS=28800
COMPOSE_PROFILES=$profiles
TZ=UTC
EOF
chmod 600 .env

echo
echo "LumaDesk configuration created: $(pwd)/.env"
echo "Login password: $password"
if [[ -n "$domain" ]]; then
  echo "Public URL: https://$domain"
  echo "Point the domain's A/AAAA record at this server before starting."
else
  echo "Local URL: http://127.0.0.1:8080"
fi
echo
echo "Save the password now, then run: docker compose up -d --build"
