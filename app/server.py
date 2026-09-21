#!/usr/bin/env python3
"""LumaDesk OS backend.

A small authenticated aiohttp server that exposes a real container home,
process table, systemd service manager and PTY-backed shell to the browser.
"""
from __future__ import annotations

import asyncio
import base64
import errno
import fcntl
import hashlib
import hmac
import json
import logging
import mimetypes
import os
import platform
import pty
import pwd
import re
import secrets
import shutil
import signal
import socket
import struct
import subprocess
import sys
import termios
import time
from collections import defaultdict, deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote, unquote, urlsplit

import psutil
from aiohttp import WSMsgType, web

APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"
HOME_ROOT = Path(os.environ.get("WEBOS_HOME", "/home/webos")).expanduser().resolve()
STATE_DIR = Path(os.environ.get("WEBOS_STATE", "/var/lib/lumadesk")).expanduser()
WEBOS_USER = os.environ.get("WEBOS_USER", "webos")
BOOT_CONFIG: dict[str, str] = {}
try:
    BOOT_CONFIG = json.loads(Path(os.environ.get("WEBOS_CONFIG", "/run/lumadesk-bootstrap.json")).read_text())
except (OSError, ValueError, TypeError):
    pass
PASSWORD = os.environ.get("WEBOS_PASSWORD", BOOT_CONFIG.get("password", ""))
SECRET_TEXT = os.environ.get("WEBOS_SECRET", BOOT_CONFIG.get("secret", ""))
COOKIE_NAME = "lumadesk_session"
SESSION_SECONDS = int(os.environ.get("WEBOS_SESSION_SECONDS", "28800"))
DEMO_MODE = os.environ.get("WEBOS_DEMO", "false").lower() in {"1", "true", "yes"}
MIN_PASSWORD_LENGTH = 8
TRASH_STAMP_RE = re.compile(r"^\d{8}-\d{6}(?:-\d+)?-")


def _read_version() -> str:
    """Report the packaged release version, tolerating source checkouts."""
    override = os.environ.get("WEBOS_VERSION", "").strip()
    if override:
        return override
    for candidate in (APP_DIR / "VERSION", APP_DIR.parent / "VERSION"):
        try:
            text = candidate.read_text(encoding="utf-8").strip()
        except OSError:
            continue
        if text:
            return text
    return "dev"


APP_VERSION = _read_version()


def _configured_port() -> int:
    raw = os.environ.get("WEBOS_PORT") or os.environ.get("PORT") or "8080"
    try:
        port = int(raw)
    except ValueError as exc:
        raise SystemExit(f"Invalid HTTP port: {raw!r}") from exc
    if not 1 <= port <= 65535:
        raise SystemExit(f"HTTP port must be between 1 and 65535, got {port}")
    return port


PORT = _configured_port()
HOST = os.environ.get("WEBOS_HOST", "0.0.0.0")
MAX_TEXT_FILE = 2 * 1024 * 1024
MAX_UPLOAD = 25 * 1024 * 1024
UNIT_RE = re.compile(r"^[A-Za-z0-9_.:@\\-]+\.service$")
PROTECTED_UNITS = {
    "lumadesk.service",
    "dbus.service",
    "systemd-journald.service",
    "systemd-logind.service",
    "systemd-udevd.service",
    "networking.service",
}

logging.basicConfig(
    level=os.environ.get("WEBOS_LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
LOG = logging.getLogger("lumadesk")
LOGIN_ATTEMPTS: dict[str, deque[float]] = defaultdict(deque)


def _runtime_mode() -> str:
    requested = os.environ.get("WEBOS_RUNTIME", "auto").lower()
    if requested in {"railway", "standalone"}:
        return requested
    try:
        return "systemd" if Path("/proc/1/comm").read_text().strip() == "systemd" else "standalone"
    except OSError:
        return "standalone"


def _persistent_session_secret() -> str:
    """Load or atomically create a signing secret in the application state dir."""
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    secret_path = STATE_DIR / "session-secret"
    lock_path = STATE_DIR / ".session-secret.lock"
    with lock_path.open("a", encoding="utf-8") as lock:
        os.chmod(lock_path, 0o600)
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            existing = secret_path.read_text(encoding="utf-8").strip()
        except OSError:
            existing = ""
        if len(existing) >= 32:
            return existing
        generated = secrets.token_hex(32)
        temporary = secret_path.with_name(f".{secret_path.name}.{os.getpid()}.tmp")
        temporary.write_text(generated, encoding="utf-8")
        os.chmod(temporary, 0o600)
        temporary.replace(secret_path)
        return generated


def _validate_config() -> bytes:
    global SECRET_TEXT
    if DEMO_MODE and not PASSWORD:
        # Demo mode is only intended for a private development preview.
        globals()["PASSWORD"] = "preview-access-2026"
    if len(PASSWORD) < MIN_PASSWORD_LENGTH:
        raise SystemExit(f"WEBOS_PASSWORD must contain at least {MIN_PASSWORD_LENGTH} characters")
    if len(SECRET_TEXT) < 32:
        if DEMO_MODE:
            SECRET_TEXT = secrets.token_hex(32)
            LOG.warning("WEBOS_SECRET is unset; using an ephemeral demo secret")
        else:
            try:
                SECRET_TEXT = _persistent_session_secret()
                LOG.warning(
                    "WEBOS_SECRET is unset or too short; using an auto-generated secret from %s",
                    STATE_DIR / "session-secret",
                )
            except OSError as exc:
                SECRET_TEXT = secrets.token_hex(32)
                LOG.warning(
                    "Could not persist an automatic WEBOS_SECRET (%s); sessions will reset when this instance restarts",
                    exc,
                )
    return SECRET_TEXT.encode("utf-8")


RUNTIME_MODE = _runtime_mode()
SECRET = _validate_config()


def _user_identity() -> tuple[int, int, str]:
    try:
        account = pwd.getpwnam(WEBOS_USER)
        return account.pw_uid, account.pw_gid, account.pw_shell or "/bin/bash"
    except KeyError:
        return os.getuid(), os.getgid(), os.environ.get("SHELL", "/bin/bash")


WEBOS_UID, WEBOS_GID, WEBOS_SHELL = _user_identity()


def _b64encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64decode(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def issue_session() -> tuple[str, dict[str, Any]]:
    now = int(time.time())
    payload = {
        "user": WEBOS_USER,
        "iat": now,
        "exp": now + SESSION_SECONDS,
        "csrf": secrets.token_urlsafe(24),
    }
    encoded = _b64encode(json.dumps(payload, separators=(",", ":")).encode())
    signature = _b64encode(hmac.new(SECRET, encoded.encode(), hashlib.sha256).digest())
    return f"{encoded}.{signature}", payload


def parse_session(token: str | None) -> dict[str, Any] | None:
    if not token or "." not in token:
        return None
    try:
        encoded, supplied = token.rsplit(".", 1)
        expected = _b64encode(hmac.new(SECRET, encoded.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(supplied, expected):
            return None
        payload = json.loads(_b64decode(encoded))
        if payload.get("exp", 0) < time.time() or payload.get("user") != WEBOS_USER:
            return None
        return payload
    except (ValueError, TypeError, json.JSONDecodeError):
        return None


def secure_cookie_for(request: web.Request) -> bool:
    setting = os.environ.get("WEBOS_SECURE_COOKIE", "auto").lower()
    if setting in {"1", "true", "yes"}:
        return True
    if setting in {"0", "false", "no"}:
        return False
    return request.headers.get("X-Forwarded-Proto", request.scheme).split(",")[0].strip() == "https"


def json_response(data: Any, status: int = 200) -> web.Response:
    return web.json_response(data, status=status, dumps=lambda value: json.dumps(value, separators=(",", ":")))


@web.middleware
async def error_middleware(request: web.Request, handler):
    try:
        return await handler(request)
    except web.HTTPException as exc:
        if request.path.startswith("/api/"):
            return json_response({"ok": False, "error": exc.reason}, exc.status)
        raise
    except asyncio.TimeoutError:
        return json_response({"ok": False, "error": "The operation timed out"}, 504)
    except Exception as exc:  # keep internals out of HTTP responses
        LOG.exception("Unhandled error on %s %s", request.method, request.path)
        return json_response({"ok": False, "error": "Internal server error"}, 500)


@web.middleware
async def auth_middleware(request: web.Request, handler):
    public = (
        request.path in {"/", "/healthz", "/manifest.webmanifest", "/api/login", "/api/session"}
        or request.path.startswith("/static/")
    )
    session = parse_session(request.cookies.get(COOKIE_NAME))
    request["session"] = session
    if not public and not session:
        raise web.HTTPUnauthorized(reason="Authentication required")
    if session and request.method not in {"GET", "HEAD", "OPTIONS"} and request.path != "/api/login":
        supplied = request.headers.get("X-LumaDesk-CSRF", "")
        if not hmac.compare_digest(supplied, str(session.get("csrf", ""))):
            raise web.HTTPForbidden(reason="Invalid request token")
    return await handler(request)


@web.middleware
async def security_headers(request: web.Request, handler):
    response = await handler(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "SAMEORIGIN"
    response.headers["Referrer-Policy"] = "same-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    if request.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    if "Content-Security-Policy" not in response.headers:
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; "
            "img-src 'self' data: blob:; connect-src 'self' ws: wss:; font-src 'self'; "
            "object-src 'none'; base-uri 'self'; frame-ancestors 'self'"
        )
    if request.headers.get("X-Forwarded-Proto", "").split(",")[0].strip() == "https":
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return response


async def index(_: web.Request) -> web.FileResponse:
    return web.FileResponse(STATIC_DIR / "index.html")


async def manifest(_: web.Request) -> web.FileResponse:
    return web.FileResponse(STATIC_DIR / "manifest.webmanifest")


async def health(_: web.Request) -> web.Response:
    return json_response(
        {
            "ok": True,
            "service": "lumadesk",
            "version": APP_VERSION,
            "runtime": RUNTIME_MODE,
            "time": datetime.now(timezone.utc).isoformat(),
        }
    )


async def login(request: web.Request) -> web.Response:
    remote = request.headers.get("X-Forwarded-For", request.remote or "unknown").split(",")[0].strip()
    now = time.monotonic()
    attempts = LOGIN_ATTEMPTS[remote]
    while attempts and attempts[0] < now - 300:
        attempts.popleft()
    if len(attempts) >= 8:
        return json_response({"ok": False, "error": "Too many attempts; wait five minutes"}, 429)
    try:
        body = await request.json()
    except (json.JSONDecodeError, web.HTTPBadRequest):
        raise web.HTTPBadRequest(reason="Expected a JSON request")
    supplied = str(body.get("password", ""))
    if not hmac.compare_digest(supplied.encode(), PASSWORD.encode()):
        attempts.append(now)
        await asyncio.sleep(min(0.2 * len(attempts), 1.2))
        return json_response({"ok": False, "error": "Incorrect password"}, 401)
    attempts.clear()
    token, payload = issue_session()
    response = json_response({"ok": True, "user": WEBOS_USER, "csrf": payload["csrf"]})
    response.set_cookie(
        COOKIE_NAME,
        token,
        max_age=SESSION_SECONDS,
        httponly=True,
        secure=secure_cookie_for(request),
        samesite="Lax",
        path="/",
    )
    return response


async def session_info(request: web.Request) -> web.Response:
    session = request["session"]
    if not session:
        return json_response({"authenticated": False})
    return json_response(
        {
            "authenticated": True,
            "user": session["user"],
            "csrf": session["csrf"],
            "expires": session["exp"],
            "host": socket.gethostname(),
            "demo": DEMO_MODE,
            "runtime": RUNTIME_MODE,
            "version": APP_VERSION,
        }
    )


async def logout(request: web.Request) -> web.Response:
    response = json_response({"ok": True})
    response.del_cookie(COOKIE_NAME, path="/")
    return response


def _within_home(path: Path) -> bool:
    try:
        return os.path.commonpath((str(HOME_ROOT), str(path))) == str(HOME_ROOT)
    except ValueError:
        return False


def resolve_home(raw: str | None, *, must_exist: bool = True) -> Path:
    raw = raw or "/"
    if "\x00" in raw:
        raise web.HTTPBadRequest(reason="Invalid path")
    relative = raw.lstrip("/")
    if any(part == ".." for part in Path(relative).parts):
        raise web.HTTPForbidden(reason="Path leaves the workspace")
    candidate = HOME_ROOT / relative
    try:
        resolved = candidate.resolve(strict=must_exist)
    except FileNotFoundError:
        raise web.HTTPNotFound(reason="File not found")
    if not _within_home(resolved):
        raise web.HTTPForbidden(reason="Path leaves the workspace")
    return resolved


def client_path(path: Path) -> str:
    if path == HOME_ROOT:
        return "/"
    return "/" + path.relative_to(HOME_ROOT).as_posix()


def safe_name(name: str) -> str:
    name = name.strip()
    if (
        not name
        or name in {".", ".."}
        or len(name) > 160
        or "/" in name
        or "\\" in name
        or any(ord(ch) < 32 for ch in name)
    ):
        raise web.HTTPBadRequest(reason="Invalid file name")
    return name


def own(path: Path) -> None:
    try:
        os.chown(path, WEBOS_UID, WEBOS_GID)
    except PermissionError:
        pass


def entry_json(entry: os.DirEntry[str]) -> dict[str, Any]:
    stat = entry.stat(follow_symlinks=False)
    is_link = entry.is_symlink()
    is_dir = entry.is_dir(follow_symlinks=False)
    return {
        "name": entry.name,
        "path": client_path(Path(entry.path)),
        "type": "directory" if is_dir else "file",
        "symlink": is_link,
        "size": stat.st_size,
        "modified": int(stat.st_mtime),
        "hidden": entry.name.startswith("."),
        "mime": None if is_dir else (mimetypes.guess_type(entry.name)[0] or "application/octet-stream"),
    }


async def list_files(request: web.Request) -> web.Response:
    folder = resolve_home(request.query.get("path", "/"))
    if not folder.is_dir():
        raise web.HTTPBadRequest(reason="Not a folder")
    show_hidden = request.query.get("hidden") == "1"
    try:
        entries = [entry_json(e) for e in os.scandir(folder) if show_hidden or not e.name.startswith(".")]
    except PermissionError:
        raise web.HTTPForbidden(reason="Permission denied")
    entries.sort(key=lambda item: (item["type"] != "directory", item["name"].casefold()))
    return json_response(
        {
            "ok": True,
            "path": client_path(folder),
            "parent": None if folder == HOME_ROOT else client_path(folder.parent),
            "entries": entries,
        }
    )


async def read_file(request: web.Request) -> web.Response:
    path = resolve_home(request.query.get("path"))
    if not path.is_file():
        raise web.HTTPBadRequest(reason="Not a file")
    size = path.stat().st_size
    if size > MAX_TEXT_FILE:
        raise web.HTTPRequestEntityTooLarge(max_size=MAX_TEXT_FILE, actual_size=size)
    content = path.read_bytes()
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError:
        return json_response(
            {
                "ok": True,
                "path": client_path(path),
                "name": path.name,
                "binary": True,
                "size": size,
                "mime": mimetypes.guess_type(path.name)[0] or "application/octet-stream",
            }
        )
    return json_response(
        {
            "ok": True,
            "path": client_path(path),
            "name": path.name,
            "binary": False,
            "size": size,
            "mime": mimetypes.guess_type(path.name)[0] or "text/plain",
            "content": text,
        }
    )


async def raw_file(request: web.Request) -> web.StreamResponse:
    path = resolve_home(request.query.get("path"))
    if not path.is_file():
        raise web.HTTPBadRequest(reason="Not a file")
    response = web.FileResponse(path)
    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    response.content_type = mime
    response.headers["Content-Security-Policy"] = "sandbox; default-src 'none'; style-src 'unsafe-inline'"
    if request.query.get("download") == "1" or not mime.startswith("image/"):
        response.headers["Content-Disposition"] = f"attachment; filename*=UTF-8''{quote(path.name)}"
    return response


async def create_entry(request: web.Request) -> web.Response:
    data = await request.json()
    parent = resolve_home(data.get("parent", "/"))
    if not parent.is_dir():
        raise web.HTTPBadRequest(reason="Parent is not a folder")
    name = safe_name(str(data.get("name", "")))
    target = resolve_home(client_path(parent / name), must_exist=False)
    if target.exists():
        raise web.HTTPConflict(reason="That name already exists")
    kind = data.get("type", "file")
    if kind == "directory":
        target.mkdir(mode=0o755)
    elif kind == "file":
        target.touch(mode=0o644)
    else:
        raise web.HTTPBadRequest(reason="Unknown entry type")
    own(target)
    return json_response({"ok": True, "path": client_path(target)}, 201)


async def save_file(request: web.Request) -> web.Response:
    data = await request.json()
    path = resolve_home(data.get("path"))
    if not path.is_file():
        raise web.HTTPBadRequest(reason="Not a file")
    content = data.get("content", "")
    if not isinstance(content, str):
        raise web.HTTPBadRequest(reason="Content must be text")
    encoded = content.encode("utf-8")
    if len(encoded) > MAX_TEXT_FILE:
        raise web.HTTPRequestEntityTooLarge(max_size=MAX_TEXT_FILE, actual_size=len(encoded))
    temporary = path.with_name(f".{path.name}.{secrets.token_hex(4)}.tmp")
    temporary.write_bytes(encoded)
    os.chmod(temporary, path.stat().st_mode & 0o777 or 0o644)
    own(temporary)
    temporary.replace(path)
    return json_response({"ok": True, "size": len(encoded)})


async def rename_entry(request: web.Request) -> web.Response:
    data = await request.json()
    source = resolve_home(data.get("path"))
    if source == HOME_ROOT:
        raise web.HTTPForbidden(reason="Cannot rename the workspace root")
    target = resolve_home(client_path(source.with_name(safe_name(str(data.get("name", ""))))), must_exist=False)
    if target.exists():
        raise web.HTTPConflict(reason="That name already exists")
    source.rename(target)
    return json_response({"ok": True, "path": client_path(target)})


async def delete_entry(request: web.Request) -> web.Response:
    source = resolve_home(request.query.get("path"))
    if source == HOME_ROOT:
        raise web.HTTPForbidden(reason="Cannot delete the workspace root")
    files, info = trash_directories()
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    target = files / f"{stamp}-{source.name}"
    counter = 1
    while target.exists():
        target = files / f"{stamp}-{counter}-{source.name}"
        counter += 1
    source.rename(target)
    _write_trash_info(info, target.name, source)
    return json_response({"ok": True, "trashed": True, "name": target.name})


def unique_destination(folder: Path, name: str) -> Path:
    target = folder / name
    stem, suffix = Path(name).stem, Path(name).suffix
    number = 2
    while target.exists():
        target = folder / f"{stem} ({number}){suffix}"
        number += 1
    return target


async def upload_files(request: web.Request) -> web.Response:
    folder = resolve_home(request.query.get("path", "/"))
    if not folder.is_dir():
        raise web.HTTPBadRequest(reason="Upload destination is not a folder")
    reader = await request.multipart()
    uploaded: list[dict[str, Any]] = []
    total = 0
    async for field in reader:
        if not field.filename:
            continue
        name = safe_name(Path(field.filename).name)
        destination = unique_destination(folder, name)
        with destination.open("wb") as stream:
            while chunk := await field.read_chunk(64 * 1024):
                total += len(chunk)
                if total > MAX_UPLOAD:
                    stream.close()
                    destination.unlink(missing_ok=True)
                    raise web.HTTPRequestEntityTooLarge(max_size=MAX_UPLOAD, actual_size=total)
                stream.write(chunk)
        os.chmod(destination, 0o644)
        own(destination)
        uploaded.append({"name": destination.name, "path": client_path(destination)})
    if not uploaded:
        raise web.HTTPBadRequest(reason="No files were supplied")
    return json_response({"ok": True, "files": uploaded}, 201)


# Trash: a FreeDesktop-style `~/.local/share/Trash` with `files/` payloads and
# `info/*.trashinfo` sidecars so the browser can list, restore, and purge items.
def trash_directories() -> tuple[Path, Path]:
    files = HOME_ROOT / ".local" / "share" / "Trash" / "files"
    info = HOME_ROOT / ".local" / "share" / "Trash" / "info"
    for folder in (files, info):
        folder.mkdir(parents=True, exist_ok=True)
        own(folder)
    return files, info


def trash_info_path(info_dir: Path, name: str) -> Path:
    return info_dir / f"{name}.trashinfo"


def _write_trash_info(info_dir: Path, name: str, original: Path) -> None:
    relative = original.relative_to(HOME_ROOT).as_posix()
    stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
    body = f"[Trash Info]\nPath={quote(relative, safe='/')}\nDeletionDate={stamp}\n"
    target = trash_info_path(info_dir, name)
    target.write_text(body, encoding="utf-8")
    os.chmod(target, 0o644)
    own(target)


def _read_trash_info(info_dir: Path, name: str) -> dict[str, Any]:
    try:
        raw = trash_info_path(info_dir, name).read_text(encoding="utf-8")
    except OSError:
        return {}
    result: dict[str, Any] = {}
    for line in raw.splitlines():
        key, _, value = line.partition("=")
        key = key.strip()
        if key == "Path":
            result["path"] = unquote(value.strip())
        elif key == "DeletionDate":
            try:
                result["deleted"] = int(datetime.fromisoformat(value.strip()).timestamp())
            except ValueError:
                continue
    return result


def trash_entry(files_dir: Path, name: str) -> Path:
    """Resolve a Trash payload by its stored name, staying inside the Trash."""
    safe = safe_name(name)
    entry = files_dir / safe
    if not entry.exists() and not entry.is_symlink():
        raise web.HTTPNotFound(reason="That Trash item no longer exists")
    return entry


def _remove_tree(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink()
    else:
        shutil.rmtree(path)


def _trash_display_name(stored: str, meta: dict[str, Any]) -> str:
    if meta.get("path"):
        return Path(meta["path"]).name or stored
    # Entries created before sidecars existed keep their `stamp-name` prefix.
    return TRASH_STAMP_RE.sub("", stored) or stored


async def list_trash(_: web.Request) -> web.Response:
    files_dir, info_dir = trash_directories()
    entries: list[dict[str, Any]] = []
    total = 0
    try:
        scan = list(os.scandir(files_dir))
    except PermissionError:
        raise web.HTTPForbidden(reason="Permission denied")
    for item in scan:
        try:
            stat = item.stat(follow_symlinks=False)
        except OSError:
            continue
        meta = _read_trash_info(info_dir, item.name)
        total += stat.st_size
        entries.append(
            {
                "name": item.name,
                "label": _trash_display_name(item.name, meta),
                "original": f"/{meta['path']}" if meta.get("path") else None,
                "type": "directory" if item.is_dir(follow_symlinks=False) else "file",
                "size": stat.st_size,
                "deleted": meta.get("deleted") or int(stat.st_mtime),
            }
        )
    entries.sort(key=lambda entry: (entry["deleted"], entry["name"]), reverse=True)
    return json_response({"ok": True, "count": len(entries), "size": total, "entries": entries})


async def restore_trash(request: web.Request) -> web.Response:
    data = await request.json()
    files_dir, info_dir = trash_directories()
    entry = trash_entry(files_dir, str(data.get("name", "")))
    meta = _read_trash_info(info_dir, entry.name)
    relative = (meta.get("path") or _trash_display_name(entry.name, meta)).lstrip("/")
    if not relative or any(part in {"", ".."} for part in Path(relative).parts):
        raise web.HTTPBadRequest(reason="The recorded Trash location is not valid")
    parent = HOME_ROOT / Path(relative).parent
    parent.mkdir(parents=True, exist_ok=True)
    own(parent)
    destination = unique_destination(parent, Path(relative).name)
    if not _within_home(destination):
        raise web.HTTPForbidden(reason="Path leaves the workspace")
    entry.rename(destination)
    own(destination)
    trash_info_path(info_dir, entry.name).unlink(missing_ok=True)
    return json_response({"ok": True, "name": destination.name, "path": client_path(destination)})


async def purge_trash(request: web.Request) -> web.Response:
    data = await request.json()
    files_dir, info_dir = trash_directories()
    entry = trash_entry(files_dir, str(data.get("name", "")))
    _remove_tree(entry)
    trash_info_path(info_dir, entry.name).unlink(missing_ok=True)
    return json_response({"ok": True, "name": entry.name})


async def empty_trash(_: web.Request) -> web.Response:
    files_dir, info_dir = trash_directories()
    removed = 0
    for item in list(os.scandir(files_dir)):
        try:
            _remove_tree(Path(item.path))
            removed += 1
        except OSError as exc:
            LOG.warning("Could not purge %s from the Trash: %s", item.name, exc)
    for meta in list(info_dir.glob("*.trashinfo")):
        meta.unlink(missing_ok=True)
    return json_response({"ok": True, "removed": removed})


async def run_command(*args: str, timeout: float = 12) -> tuple[int, str, str]:
    process = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env={**os.environ, "LC_ALL": "C", "SYSTEMD_COLORS": "0"},
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout)
    except asyncio.TimeoutError:
        process.kill()
        await process.communicate()
        raise
    return process.returncode, stdout.decode(errors="replace")[:500_000], stderr.decode(errors="replace")[:50_000]


async def service_list(_: web.Request) -> web.Response:
    if RUNTIME_MODE != "systemd":
        return json_response(
            {
                "ok": True,
                "available": False,
                "services": [],
                "message": "Service control requires systemd mode; this deployment is running in platform compatibility mode.",
            }
        )
    if not shutil.which("systemctl"):
        return json_response({"ok": True, "available": False, "services": [], "message": "systemd is unavailable"})
    code, output, error = await run_command(
        "systemctl", "list-units", "--type=service", "--all", "--no-legend", "--no-pager", "--plain"
    )
    if code != 0 and not output:
        return json_response({"ok": True, "available": False, "services": [], "message": error.strip()})
    _, unit_files, _ = await run_command(
        "systemctl", "list-unit-files", "--type=service", "--no-legend", "--no-pager", "--plain"
    )
    enabled: dict[str, str] = {}
    for line in unit_files.splitlines():
        parts = line.split()
        if len(parts) >= 2:
            enabled[parts[0]] = parts[1]
    services = []
    for line in output.splitlines():
        line = line.strip().lstrip("●").strip()
        parts = line.split(None, 4)
        if len(parts) < 5 or not parts[0].endswith(".service"):
            continue
        unit, load, active, sub, description = parts
        services.append(
            {
                "unit": unit,
                "load": load,
                "active": active,
                "sub": sub,
                "description": description,
                "enabled": enabled.get(unit, "unknown"),
                "protected": unit in PROTECTED_UNITS or unit.startswith(("getty@", "container-getty@")),
            }
        )
    services.sort(key=lambda item: (item["active"] != "active", item["unit"]))
    return json_response({"ok": True, "available": True, "services": services})


async def service_action(request: web.Request) -> web.Response:
    if RUNTIME_MODE != "systemd":
        raise web.HTTPConflict(reason="Service control is unavailable in platform compatibility mode")
    unit = request.match_info["unit"]
    action = request.match_info["action"]
    if not UNIT_RE.fullmatch(unit) or action not in {"start", "stop", "restart", "enable", "disable"}:
        raise web.HTTPBadRequest(reason="Invalid service operation")
    if unit in PROTECTED_UNITS or unit.startswith(("getty@", "container-getty@")):
        raise web.HTTPForbidden(reason="This core service is protected")
    code, output, error = await run_command("systemctl", action, unit, timeout=20)
    if code:
        return json_response({"ok": False, "error": (error or output).strip() or "systemctl failed"}, 409)
    return json_response({"ok": True, "unit": unit, "action": action, "output": output.strip()})


async def service_logs(request: web.Request) -> web.Response:
    if RUNTIME_MODE != "systemd":
        raise web.HTTPConflict(reason="Service journals are unavailable in platform compatibility mode")
    unit = request.match_info["unit"]
    if not UNIT_RE.fullmatch(unit):
        raise web.HTTPBadRequest(reason="Invalid service name")
    code, output, error = await run_command(
        "journalctl", "-u", unit, "-n", "160", "--no-pager", "--output=short-iso", timeout=15
    )
    return json_response({"ok": code == 0, "unit": unit, "logs": output or error})


def collect_system() -> dict[str, Any]:
    memory = psutil.virtual_memory()
    swap = psutil.swap_memory()
    disk = psutil.disk_usage("/")
    network = psutil.net_io_counters()
    try:
        load = list(os.getloadavg())
    except OSError:
        load = [0, 0, 0]
    os_name = platform.system()
    os_version = platform.release()
    try:
        release = {}
        for line in Path("/etc/os-release").read_text().splitlines():
            if "=" in line:
                key, value = line.split("=", 1)
                release[key] = value.strip('"')
        os_name = release.get("PRETTY_NAME", os_name)
    except OSError:
        pass
    return {
        "hostname": socket.gethostname(),
        "os": os_name,
        "kernel": os_version,
        "architecture": platform.machine(),
        "container": Path("/.dockerenv").exists() or os.environ.get("container") == "docker",
        "uptime": int(time.time() - psutil.boot_time()),
        "cpu": {
            "percent": psutil.cpu_percent(interval=0.12),
            "count": psutil.cpu_count(),
            "frequency": round(psutil.cpu_freq().current) if psutil.cpu_freq() else None,
            "load": load,
        },
        "memory": {"total": memory.total, "used": memory.used, "available": memory.available, "percent": memory.percent},
        "swap": {"total": swap.total, "used": swap.used, "percent": swap.percent},
        "disk": {"total": disk.total, "used": disk.used, "free": disk.free, "percent": disk.percent},
        "network": {"sent": network.bytes_sent, "received": network.bytes_recv},
        "processes": len(psutil.pids()),
        "time": int(time.time()),
    }


async def system_info(_: web.Request) -> web.Response:
    return json_response({"ok": True, "system": await asyncio.to_thread(collect_system)})


def collect_processes() -> list[dict[str, Any]]:
    rows = []
    for process in psutil.process_iter(["pid", "name", "username", "cpu_percent", "memory_percent", "status", "create_time"]):
        try:
            info = process.info
            rows.append(
                {
                    "pid": info["pid"],
                    "name": info["name"] or "—",
                    "user": info["username"] or "—",
                    "cpu": round(info["cpu_percent"] or 0, 1),
                    "memory": round(info["memory_percent"] or 0, 1),
                    "status": info["status"],
                    "started": int(info["create_time"] or 0),
                    "controllable": info["username"] == WEBOS_USER and info["pid"] not in {1, os.getpid()},
                }
            )
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    rows.sort(key=lambda item: (item["cpu"], item["memory"]), reverse=True)
    return rows[:100]


async def process_list(_: web.Request) -> web.Response:
    return json_response({"ok": True, "processes": await asyncio.to_thread(collect_processes)})


async def process_signal(request: web.Request) -> web.Response:
    try:
        pid = int(request.match_info["pid"])
    except ValueError:
        raise web.HTTPBadRequest(reason="Invalid process ID")
    data = await request.json()
    requested = data.get("signal", "TERM")
    sig = signal.SIGKILL if requested == "KILL" else signal.SIGTERM
    if pid in {1, os.getpid()}:
        raise web.HTTPForbidden(reason="Core processes are protected")
    try:
        process = psutil.Process(pid)
        if process.username() != WEBOS_USER:
            raise web.HTTPForbidden(reason="Only workspace-user processes can be ended")
        process.send_signal(sig)
    except psutil.NoSuchProcess:
        raise web.HTTPNotFound(reason="Process no longer exists")
    except psutil.AccessDenied:
        raise web.HTTPForbidden(reason="Permission denied")
    return json_response({"ok": True, "pid": pid, "signal": requested})


async def terminal_socket(request: web.Request) -> web.WebSocketResponse:
    origin = request.headers.get("Origin")
    expected_host = request.headers.get("X-Forwarded-Host", request.host).split(",")[0].strip().lower()
    if origin and urlsplit(origin).netloc.lower() != expected_host:
        raise web.HTTPForbidden(reason="WebSocket origin does not match this workspace")
    ws = web.WebSocketResponse(heartbeat=25, max_msg_size=128 * 1024)
    await ws.prepare(request)
    pid = -1
    master = -1
    loop = asyncio.get_running_loop()
    outgoing: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=256)

    try:
        pid, master = pty.fork()
        if pid == 0:  # child
            try:
                os.chdir(HOME_ROOT)
                if os.geteuid() == 0 and WEBOS_UID != 0:
                    os.initgroups(WEBOS_USER, WEBOS_GID)
                    os.setgid(WEBOS_GID)
                    os.setuid(WEBOS_UID)
                env = {
                    **os.environ,
                    "HOME": str(HOME_ROOT),
                    "USER": WEBOS_USER,
                    "LOGNAME": WEBOS_USER,
                    "SHELL": WEBOS_SHELL,
                    "TERM": "xterm-256color",
                    "COLORTERM": "truecolor",
                }
                os.execvpe(WEBOS_SHELL, [WEBOS_SHELL, "-l"], env)
            except Exception:
                os._exit(127)
        os.set_blocking(master, False)

        def on_pty_output() -> None:
            try:
                chunk = os.read(master, 65536)
                if not chunk:
                    loop.remove_reader(master)
                    outgoing.put_nowait(None)
                else:
                    try:
                        outgoing.put_nowait(chunk)
                    except asyncio.QueueFull:
                        pass
            except OSError as exc:
                if exc.errno not in {errno.EIO, errno.EBADF}:
                    LOG.debug("PTY read failed: %s", exc)
                try:
                    loop.remove_reader(master)
                except Exception:
                    pass
                try:
                    outgoing.put_nowait(None)
                except asyncio.QueueFull:
                    pass

        loop.add_reader(master, on_pty_output)

        async def sender() -> None:
            while True:
                chunk = await outgoing.get()
                if chunk is None:
                    break
                await ws.send_bytes(chunk)

        sender_task = asyncio.create_task(sender())
        await ws.send_json({"type": "ready", "user": WEBOS_USER, "host": socket.gethostname()})
        async for message in ws:
            if message.type == WSMsgType.TEXT:
                try:
                    payload = json.loads(message.data)
                except json.JSONDecodeError:
                    continue
                if payload.get("type") == "input":
                    os.write(master, str(payload.get("data", "")).encode())
                elif payload.get("type") == "resize":
                    rows = max(2, min(int(payload.get("rows", 24)), 200))
                    cols = max(10, min(int(payload.get("cols", 80)), 500))
                    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
            elif message.type in {WSMsgType.ERROR, WSMsgType.CLOSE, WSMsgType.CLOSED}:
                break
        sender_task.cancel()
    finally:
        if master >= 0:
            try:
                loop.remove_reader(master)
            except Exception:
                pass
            try:
                os.close(master)
            except OSError:
                pass
        if pid > 0:
            try:
                os.killpg(pid, signal.SIGHUP)
            except ProcessLookupError:
                pass
            reaped = False
            for _ in range(20):
                try:
                    reaped = os.waitpid(pid, os.WNOHANG)[0] == pid
                except ChildProcessError:
                    reaped = True
                if reaped:
                    break
                await asyncio.sleep(0.05)
            if not reaped:
                try:
                    os.killpg(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                try:
                    await asyncio.sleep(0.02)
                    os.waitpid(pid, 0)
                except ChildProcessError:
                    pass
    return ws


def create_app() -> web.Application:
    HOME_ROOT.mkdir(parents=True, exist_ok=True)
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    app = web.Application(
        middlewares=[error_middleware, security_headers, auth_middleware],
        client_max_size=32 * 1024 * 1024,
    )
    app.router.add_get("/", index)
    app.router.add_get("/manifest.webmanifest", manifest)
    app.router.add_get("/healthz", health)
    app.router.add_post("/api/login", login)
    app.router.add_get("/api/session", session_info)
    app.router.add_post("/api/logout", logout)
    app.router.add_get("/api/system", system_info)
    app.router.add_get("/api/processes", process_list)
    app.router.add_post("/api/processes/{pid}/signal", process_signal)
    app.router.add_get("/api/files", list_files)
    app.router.add_get("/api/file", read_file)
    app.router.add_get("/api/file/raw", raw_file)
    app.router.add_post("/api/files/create", create_entry)
    app.router.add_put("/api/file", save_file)
    app.router.add_post("/api/files/rename", rename_entry)
    app.router.add_delete("/api/file", delete_entry)
    app.router.add_post("/api/files/upload", upload_files)
    app.router.add_get("/api/trash", list_trash)
    app.router.add_post("/api/trash/restore", restore_trash)
    app.router.add_post("/api/trash/purge", purge_trash)
    app.router.add_post("/api/trash/empty", empty_trash)
    app.router.add_get("/api/services", service_list)
    app.router.add_post("/api/services/{unit}/{action}", service_action)
    app.router.add_get("/api/services/{unit}/logs", service_logs)
    app.router.add_get("/ws/terminal", terminal_socket)
    app.router.add_static("/static/", STATIC_DIR, show_index=False, append_version=True)
    return app


if __name__ == "__main__":
    LOG.info(
        "Starting LumaDesk on %s:%s (home=%s, runtime=%s, demo=%s)",
        HOST,
        PORT,
        HOME_ROOT,
        RUNTIME_MODE,
        DEMO_MODE,
    )
    web.run_app(create_app(), host=HOST, port=PORT, access_log=LOG)
