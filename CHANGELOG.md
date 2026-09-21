# Changelog

All notable changes to LumaDesk OS are documented here. Versions follow Semantic Versioning.

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

[1.2.0]: https://github.com/QWERTY-enter/lumadesk-webos/releases/tag/v1.2.0
[1.1.0]: https://github.com/QWERTY-enter/lumadesk-webos/releases/tag/v1.1.0
[1.0.1]: https://github.com/QWERTY-enter/lumadesk-webos/releases/tag/v1.0.1
[1.0.0]: https://github.com/QWERTY-enter/lumadesk-webos/releases/tag/v1.0.0
