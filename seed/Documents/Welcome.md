# Welcome to LumaDesk

This is your Linux home directory.

## What is real

- **Terminal** opens a PTY-backed Bash login shell as the `webos` user.
- **Files** reads and writes this home directory.
- **System Monitor** reads live CPU, memory, disk, network, and process data.
- **Services** controls systemd when deployed through the privileged Linux Docker Compose stack.

On Railway and other restricted platforms, LumaDesk automatically uses compatibility mode. Terminal, files, editing, and monitoring remain available, while systemd service control is disabled because the host does not expose privileged cgroups.

Files survive upgrades when `/home/webos` is backed by a Docker or platform volume. On Railway, mount a volume and set `WEBOS_HOME` to a directory within it.

## Useful commands

```bash
uname -a
ls -la ~/Documents
# Full systemd mode only:
systemctl --no-pager status lumadesk.service
journalctl -u lumadesk.service -n 50 --no-pager
```

Have fun building.
