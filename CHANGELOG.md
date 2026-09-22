# Changelog

All notable changes to LumaDesk OS are documented here. Versions follow Semantic Versioning.

## [1.4.0] - 2026-09-22

### Added

- **Production hardening pass** across security, reliability, and observability
  (both the full systemd runtime and Railway/standalone compatibility mode).
- Sliding-window API rate limiting for `/api` and `/ws` traffic
  (`WEBOS_RATE_LIMIT`, default 600 requests/minute/client, `0` disables) with
  `429` responses that carry `Retry-After`.
- Concurrent terminal session cap (`WEBOS_MAX_TERMINALS`, default 16) so a
  runaway client cannot fork-bomb the container; the handshake returns `429`
  when the cap is reached.
- `GET /metrics` with Prometheus text exposition (request counters, terminal
  sessions, uptime, build info, store jobs, resident memory). Access requires
  a signed session or, for unattended scrapers, `WEBOS_METRICS_TOKEN`
  (16+ characters, passed through the root-only bootstrap file like the
  password).
- `X-Request-ID` on every response (client-supplied ids are echoed when
  well-formed); unhandled-error logs now include the correlation id.
- Same-origin `Origin` verification on authenticated mutating requests as
  defense in depth beside the CSRF token.
- `/healthz` now reports `checks` (`home_writable`, `state_writable`) and
  `uptime`, returning `503` when the workspace or state directory is broken.
- `scripts/backup.sh` for timestamped home/state volume archives plus the
  `.env` credentials file, with restore guidance in the README.
- Compose `pids_limit: 1024` and JSON-file log rotation (10 MB × 5) for both
  services.
- CI: shell-syntax check for `backup.sh`, `docker compose config` validation
  for both profiles, and smoke assertions for health checks, request ids, and
  `/metrics` authentication. Dependabot now watches GitHub Actions and the
  Docker base image weekly.

### Changed

- Middleware order guarantees security headers and request ids on error
  responses; `429` JSON errors preserve `Retry-After`.
- Terminal input is bounded (64 KB per message) and PTY buffer backpressure
  drops input instead of tearing down the session.
- The login throttle table and rate-limit buckets prune idle clients so
  spoofed source addresses cannot grow them without bound.
- Active PTY sessions are closed gracefully (SIGHUP, then SIGKILL) during
  service shutdown.
- Image, Compose, and setup references point at `1.4.0`.

## [1.3.0] - 2026-09-21

### Added

- **Store**: a CasaOS-style app catalog with 41 entries across System, Development,
  Networking, Media, Utilities, Shortcuts, and Links.
  - `package` entries install real Debian packages inside the container through an
    allowlisted catalog (the client sends a catalog id, never a package name).
  - `shortcut` entries add a launcher tile and desktop icon that opens a Terminal running
    a preset command; `link` entries open an external HTTPS resource.
  - Routes: `GET /api/store`, `POST /api/store/{id}/install|uninstall`,
    `GET /api/store/jobs/{job}`. Installs run as background jobs behind a global lock with
    a queryable log, and installed state persists in `$WEBOS_STATE/installed-apps.json`.
  - Install status comes from `dpkg-query`, so bundled tools show as already installed.
- Store UI: searchable card grid, category chips with counts, install/uninstall with live
  job progress, a job log drawer, and Open actions that launch the app.
- Installed shortcuts render in the launcher and on the desktop, and the Terminal accepts a
  startup command so launchers open ready-to-use sessions.
- Backend tests for catalog integrity, install/uninstall round trips, job failure logging,
  runtime capability reporting, and CSRF/auth on every Store route.

### Changed

- Package installation reports `409` with an actionable message when the process is not
  running as root (Railway/compatibility runtimes) instead of failing mid-install.
- Image, Compose, and setup references point at `1.3.0`.

## [1.2.0] - 2026-09-21

### Added

- Workspace search: `GET /api/files/search?q=…[&path=…][&hidden=1]` walks the workspace
  case-insensitively, skips the Trash, caps results at 200 (with a `truncated` flag), and
  bounds the scan so a large home cannot stall the API.
- Files search field with debounced queries, result rows that show the containing folder,
  and Open / Download / Show containing folder / Move to Trash actions.
- Multi-tab Terminal: add, switch, and close independent PTY sessions in one window, each
  with its own WebSocket, scrollback, resize handling, and reconnect control.
- Backend tests for search scoping, Trash exclusion, result caps, and auth.
- Frontend smoke coverage for the search flow and terminal tab lifecycle.

### Changed

- The Terminal keeps its theme in one shared constant and reports per-session status
  (connecting, `user@host`, disconnected) in the window bar.
- Image, Compose, and setup references point at `1.2.0`.

## [1.1.0] - 2026-09-20

### Added

- Trash management: deleted items are recorded with FreeDesktop `*.trashinfo` metadata and can be listed, restored, permanently deleted, or emptied from a Trash view in the Files app (`GET /api/trash`, `POST /api/trash/restore|purge|empty`).
- Right-click context menus in the Files app for Open, Download, Rename, Move to Trash, New file/folder, and Upload.
- Drag-and-drop uploads onto the Files window, with a highlighted drop target.
- Files keyboard shortcuts: `Enter` opens, `F2` renames, `Delete` moves to Trash.
- Hidden-file (dotfile) visibility toggle in the Files toolbar and a matching Settings default.
- Settings workspace tab with a terminal font-size picker and a local-preference reset; the Settings sidebar tabs are now functional.
- Workspace storage meter in the Files sidebar, sourced from live disk usage.
- `/healthz` and `/api/session` now report the packaged application version, which the About page displays.
- Backend tests for the Trash lifecycle, CSRF protection on Trash routes, and a live PTY terminal session.

### Changed

- The maintenance timer also prunes orphaned `*.trashinfo` sidecars and honors `WEBOS_HOME`.
- The image ships the `VERSION` file so the runtime reports the real release version.
- Seeded workspaces now include a `Downloads` folder to match the Files sidebar.
- Published image, Compose, and setup references point at `1.1.0`.

## [1.0.1] - 2026-09-20

### Added

- Automatic Railway detection and a standalone compatibility runtime for hosts without privileged containers or writable cgroups.
- Native support for Railway's injected `PORT` variable and dynamic container health checks.
- Automatic persistent session-secret generation when `WEBOS_SECRET` is missing or shorter than 32 characters.
- Railway deployment and persistent-volume documentation.
- CI smoke test for the unprivileged Railway runtime.

### Changed

- Minimum `WEBOS_PASSWORD` length is now 8 characters (12 or more remains recommended).
- The desktop clearly reports when systemd service control is unavailable in compatibility mode.

## [1.0.0] - 2026-09-20

### Added

- Debian 13 Docker userspace with systemd running as PID 1.
- Responsive browser desktop with draggable windows, dock, launcher, themes, and lock screen.
- Authenticated PTY-backed Bash terminal running as the unprivileged `webos` account.
- Persistent home-volume file manager, upload/download, text editing, and Trash workflow.
- systemd unit manager with service actions and journal viewer.
- Live CPU, memory, storage, host, network, and process information.
- Password throttling, signed HTTP-only sessions, CSRF defense, strict security headers, and WebSocket origin checks.
- Optional Caddy profile with automatic HTTPS.
- Daily systemd maintenance timer and seeded first-run workspace.
- GitHub Actions CI, GHCR publishing, SBOM, provenance attestation, checksums, and release archives.

[1.4.0]: https://github.com/QWERTY-enter/lumadesk-webos/releases/tag/v1.4.0
[1.3.0]: https://github.com/QWERTY-enter/lumadesk-webos/releases/tag/v1.3.0
[1.2.0]: https://github.com/QWERTY-enter/lumadesk-webos/releases/tag/v1.2.0
[1.1.0]: https://github.com/QWERTY-enter/lumadesk-webos/releases/tag/v1.1.0
[1.0.1]: https://github.com/QWERTY-enter/lumadesk-webos/releases/tag/v1.0.1
[1.0.0]: https://github.com/QWERTY-enter/lumadesk-webos/releases/tag/v1.0.0
