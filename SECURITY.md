# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 1.x | Yes |

## Reporting a vulnerability

Please do not open a public issue for an unpatched vulnerability. Use GitHub's **Security → Report a vulnerability** private reporting flow for this repository. Include reproduction steps, affected endpoints, and any suggested mitigation.

## Deployment boundary

LumaDesk deliberately runs a privileged container to support systemd and cgroups. It is intended for a single trusted administrator on a dedicated Linux host. It is not a hostile multi-tenant sandbox and does not provide a separate kernel. Keep the host and Docker Engine patched, use HTTPS or a private tunnel, and never mount the Docker socket or host root into the container.
