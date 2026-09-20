# Changelog

All notable changes to LumaDesk OS are documented here. Versions follow Semantic Versioning.

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

[1.0.1]: https://github.com/QWERTY-enter/lumadesk-webos/releases/tag/v1.0.1
[1.0.0]: https://github.com/QWERTY-enter/lumadesk-webos/releases/tag/v1.0.0
