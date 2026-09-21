# LumaDesk OS

A Docker-hosted Linux workspace with a custom browser desktop, a real PTY shell, persistent files, live process/system data, and **systemd running as PID 1**.

[![CI](https://github.com/QWERTY-enter/lumadesk-webos/actions/workflows/ci.yml/badge.svg)](https://github.com/QWERTY-enter/lumadesk-webos/actions/workflows/ci.yml)
[![Release](https://github.com/QWERTY-enter/lumadesk-webos/actions/workflows/release.yml/badge.svg)](https://github.com/QWERTY-enter/lumadesk-webos/releases)

**Debian 13 · systemd · Docker · linux/amd64 · MIT licensed**

Published image: `ghcr.io/qwerty-enter/lumadesk-webos:1.2.0`

> LumaDesk is a real Debian userspace, but it is still a container. It shares the Linux host kernel. If you need a separately booted kernel, kernel modules, or stronger tenant isolation, use a VM rather than Docker.

## Included

- Glass-style responsive web desktop with windows, dock, launcher, lock screen, themes, and keyboard shortcuts
- Password authentication, signed HTTP-only sessions, CSRF checks, login throttling, and strict browser security headers
- PTY-backed Bash terminal using xterm.js with multiple tabs; shells run as the unprivileged `webos` account
- Persistent file manager with workspace search, upload (including drag-and-drop), download, create, edit, rename, right-click actions, and a restorable Trash
- systemd service manager with state, start/stop/restart, startup state, and journal viewer
- Live CPU, RAM, storage, host details, and process manager based on `/proc`/psutil
- Debian tools including Git, curl, nano, Vim, procps, iproute2, ping, cron, and journal access for the workspace user
- Named volumes for `/home/webos` and application state
- Optional Caddy gateway with automatic public HTTPS and WebSocket proxying
- A systemd maintenance timer that cleans 30-day-old Trash entries and their metadata sidecars

## Architecture

```text
Browser
   │ HTTPS + WebSocket
   ▼
Caddy (optional public profile)
   │
   ▼
LumaDesk aiohttp service ── PTY/Bash as webos
   │          │
   │          ├──────────── /home/webos named volume
   │          ├──────────── /proc metrics and webos processes
   │          └──────────── systemctl + journalctl
   ▼
systemd (PID 1 in the Debian container)
```

The backend starts as root so it can query/control systemd and then explicitly drops the terminal child to UID/GID 1000. The file API is constrained to `/home/webos`, including resolved-symlink checks. Core units such as LumaDesk, D-Bus, journald, logind, udev, and getty are protected from browser stop/restart actions.

## Requirements

- A **Linux server** with Docker Engine 24+ and Docker Compose v2
- cgroup v2 mounted at `/sys/fs/cgroup`
- Ability to use `privileged: true` (required by this systemd-in-container design)
- For public mode: a domain pointing to the server and inbound TCP 80/443 (plus UDP 443 for HTTP/3)

Docker Desktop can run many parts of the project, but systemd/cgroup behavior varies. Native Linux Docker Engine is the supported target.

## Railway deployment (compatibility mode)

Railway does not expose privileged containers or writable cgroups, so it cannot run the full systemd PID 1 mode. LumaDesk detects Railway automatically and starts a compatibility runtime instead. The browser desktop, PTY terminal, files, editor, uploads, downloads, process list, and live metrics work; the **Services** app and systemd maintenance timer are disabled.

1. Deploy this GitHub repository or `ghcr.io/qwerty-enter/lumadesk-webos:1.2.0` as a Railway service.
2. Add this service variable in the Railway dashboard:

```dotenv
WEBOS_PASSWORD=replace-with-a-unique-password
```

`WEBOS_SECRET` is no longer required. If it is missing or shorter than 32 characters, LumaDesk securely generates one. Railway injects `PORT` automatically, and LumaDesk now listens on it.

3. Configure the Railway health-check path as `/healthz`, then generate a public domain.
4. Optional but recommended: attach a Railway Volume at `/data` and add:

```dotenv
WEBOS_HOME=/data/home
WEBOS_STATE=/data/state
```

This preserves files and the generated session secret across redeployments. Without a volume, workspace files and active sessions are ephemeral. If setting a password containing `$` through a shell rather than the Railway UI, wrap it in single quotes, for example: `WEBOS_PASSWORD='Example47$'`.

To force compatibility mode on another restricted platform, set `WEBOS_RUNTIME=standalone`. Use Docker Compose on a Linux VPS when full systemd service control is required.

## Quick start with the released image

```bash
git clone https://github.com/QWERTY-enter/lumadesk-webos.git
cd lumadesk-webos
chmod +x scripts/*.sh
./scripts/setup.sh
# Save the printed password.
docker compose pull webos
docker compose up -d --no-build
```

This pulls `ghcr.io/qwerty-enter/lumadesk-webos:1.2.0` for `linux/amd64`. Open <http://127.0.0.1:8080> through an SSH tunnel or from the host itself.

To build locally from the checked-out source instead:

```bash
docker compose up -d --build
```

For a remote server, a safe private tunnel is:

```bash
ssh -L 8080:127.0.0.1:8080 user@your-server
```

Then browse to <http://127.0.0.1:8080> on your computer.

## Public HTTPS deployment

1. Point `os.example.com` to the server.
2. Permit ports 80 and 443 in the host firewall/security group.
3. Generate configuration with the public profile:

```bash
./scripts/setup.sh --domain os.example.com
# Or replace an existing generated file:
./scripts/setup.sh --domain os.example.com --force
docker compose pull webos gateway
docker compose up -d --no-build
```

The helper writes `COMPOSE_PROFILES=public`, so Caddy starts automatically, obtains a certificate, and proxies both HTTP and terminal WebSocket traffic. The application port remains bound to `127.0.0.1` as a local maintenance path.

Check startup:

```bash
docker compose ps
docker compose logs -f gateway webos
curl -I https://os.example.com/healthz
```

## Credentials

`./scripts/setup.sh` creates:

- a random 28-character login password;
- a random 64-character HMAC secret;
- `.env` with mode `0600`.

To choose your own password:

```bash
WEBOS_PASSWORD='a-long-unique-password' ./scripts/setup.sh --force
```

Passwords must contain at least 8 characters; 12 or more is strongly recommended. `WEBOS_SECRET` is optional and is generated automatically when omitted or too short. Do not commit `.env`; it is ignored by Git and excluded from Docker builds.

## Files, Trash, and recovery

Deleting an item in the Files app moves it to `~/.local/share/Trash/files` and writes a
FreeDesktop `~/.local/share/Trash/info/<name>.trashinfo` sidecar that records the original
path and deletion time. The Files sidebar exposes a **Trash** place where you can:

- restore an item to its original folder (a ` (2)` suffix is added when the name is taken);
- permanently delete a single item;
- empty the whole Trash.

The same operations are available over the authenticated API:

```text
GET  /api/files/search          ?q=term[&path=/folder][&hidden=1] → bounded workspace search
GET  /api/trash                 list trashed items with their original paths
POST /api/trash/restore         {"name": "<stored name>"}
POST /api/trash/purge           {"name": "<stored name>"}
POST /api/trash/empty           remove everything in the Trash
```

Items older than 30 days are purged by the maintenance timer, and orphaned sidecars are
removed with them.

## Managing the real init system

```bash
# Container boot state
docker compose exec webos systemctl is-system-running

# Web app service
docker compose exec webos systemctl status lumadesk.service

# Logs
docker compose exec webos journalctl -u lumadesk.service -n 100 --no-pager

# Timers
docker compose exec webos systemctl list-timers --all

# Graceful init shutdown/restart through Docker
docker compose restart webos
```

`docker stop` sends `SIGRTMIN+3`, systemd's container shutdown signal, and Compose allows a 30-second graceful stop period.

## Persistence and backup

The image can be rebuilt without replacing user files. Docker volumes are:

- `lumadesk_lumadesk-home`
- `lumadesk_lumadesk-state`
- Caddy data/config volumes in public mode

Example home backup:

```bash
docker run --rm \
  -v lumadesk_lumadesk-home:/source:ro \
  -v "$PWD":/backup \
  alpine tar czf /backup/lumadesk-home.tgz -C /source .
```

Restore into a stopped stack after taking a second safety backup.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl` + `Alt` + `T` | Open/focus Terminal |
| `Ctrl` + `Space` | Open application launcher |
| `Alt` + `F4` | Close active window |
| `Ctrl`/`Cmd` + `S` | Save in the text editor |
| `Esc` | Close launcher, menus, or status panels |

Inside the Files app: right-click an item for Open, Download, Rename, and Move to Trash; `Enter` opens the selection, `F2` renames it, and `Delete` moves it to Trash. The search field queries the whole folder tree. In the Terminal, `+` opens another shell tab and each tab closes on its own `×`.

## Security notes

This stack deliberately uses a privileged container so systemd can manage cgroups. Treat that as a meaningful trust boundary reduction:

- Run it only on a host dedicated to trusted workloads.
- Keep Docker and the host kernel patched.
- Never mount `/var/run/docker.sock`, the host root filesystem, or sensitive host directories into this container.
- Keep the direct application bind on `127.0.0.1`; use Caddy or a trusted reverse proxy for public access.
- Use a unique password and put the public endpoint behind an identity-aware proxy or VPN if possible.
- The browser shell is non-root and has no sudo grant. It belongs to `systemd-journal` for log inspection; the authenticated web backend remains privileged to operate service units.
- LumaDesk is intended for one trusted administrator, not hostile multi-tenant hosting.

## Troubleshooting

### Container loops or systemd reports cgroup errors

Confirm the host uses cgroup v2:

```bash
stat -fc %T /sys/fs/cgroup   # expected: cgroup2fs
docker info | grep -i cgroup
```

Also verify that your Compose release supports `cgroup: host` and that Docker is allowed to create privileged containers.

### Login succeeds but returns to the login screen

- With direct HTTP, set `WEBOS_SECURE_COOKIE=auto` or `false`.
- With HTTPS, keep `auto` (recommended) or use `true`.
- Ensure a custom reverse proxy forwards `X-Forwarded-Proto: https`.

### Terminal does not connect

Your proxy must support WebSocket upgrades for `/ws/terminal`. Caddy does this automatically. Check:

```bash
docker compose logs webos
docker compose exec webos systemctl status lumadesk.service
```

### Caddy cannot obtain a certificate

Check DNS, firewall rules, and that no other service owns ports 80/443. Public certificate authorities will not issue certificates for bare IP addresses or private hostnames.

## Development preview without Docker

The web app can run directly on Linux for interface development. Service controls will reflect the development host and may be denied by its policy.

```bash
cd app
export WEBOS_DEMO=true
export WEBOS_PASSWORD=preview-access-2026
export WEBOS_HOME="$PWD/.demo-home"
export WEBOS_STATE="$PWD/.demo-state"
python3 server.py
```

Open <http://127.0.0.1:8080> and use `preview-access-2026`. Never use demo mode on a public machine.

Run the backend tests (auth, workspace paths, Trash lifecycle, PTY terminal) with:

```bash
python3 -m unittest discover -s tests -v
```

The desktop interface has its own DOM smoke test, which loads the real `index.html` and
`app.js` in jsdom and drives the Files, Trash, and Settings flows:

```bash
npm ci
npm run test:frontend
```

## Project layout

```text
.github/workflows/         CI, GHCR image publishing, and GitHub Releases
app/server.py              Auth, REST APIs, Trash, service manager, PTY WebSocket
app/static/                Desktop interface and vendored xterm assets
systemd/                   Main service and maintenance timer units
seed/                      First-run files copied into the home volume
scripts/setup.sh           Credential/environment generator
scripts/maintenance.sh     Trash cleanup task
Dockerfile                 Debian + systemd image
Caddyfile                  Optional automatic HTTPS gateway
docker-compose.yml         Runtime, cgroup, persistence, and public profile
VERSION / CHANGELOG.md     Release version and history
```

MIT licensed. The vendored xterm.js files retain their own MIT notices under `app/static/vendor/`.
