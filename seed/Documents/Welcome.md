# Welcome to LumaDesk

This is your persistent Linux home directory.

## What is real

- **Terminal** opens a PTY-backed Bash login shell as the `webos` user.
- **Files** reads and writes this home volume.
- **Services** talks to systemd, which runs as PID 1 in the container.
- **System Monitor** reads live CPU, memory, disk, network, and process data.

Your files survive image upgrades because `/home/webos` is a named Docker volume.

## Useful commands

```bash
uname -a
systemctl --no-pager status lumadesk.service
journalctl -u lumadesk.service -n 50 --no-pager
ls -la ~/Documents
```

Have fun building.
