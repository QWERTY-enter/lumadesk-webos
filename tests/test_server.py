"""Security- and behavior-focused tests for the LumaDesk backend."""
import asyncio
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

_TEST_ROOT = tempfile.TemporaryDirectory()
os.environ.update(
    WEBOS_PASSWORD="unit-test-password",
    WEBOS_SECRET="unit-test-secret-that-is-longer-than-thirty-two-characters",
    WEBOS_HOME=str(Path(_TEST_ROOT.name) / "home"),
    WEBOS_STATE=str(Path(_TEST_ROOT.name) / "state"),
    WEBOS_USER=os.environ.get("USER", "webos"),
)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))
import server  # noqa: E402
import aiohttp  # noqa: E402
from aiohttp import web  # noqa: E402
from aiohttp.test_utils import TestClient, TestServer  # noqa: E402


class SessionTests(unittest.TestCase):
    def test_signed_session_round_trip(self):
        token, issued = server.issue_session()
        parsed = server.parse_session(token)
        self.assertEqual(parsed["user"], issued["user"])
        self.assertEqual(parsed["csrf"], issued["csrf"])

    def test_tampered_session_is_rejected(self):
        token, _ = server.issue_session()
        changed = ("A" if token[0] != "A" else "B") + token[1:]
        self.assertIsNone(server.parse_session(changed))


class SecretPersistenceTests(unittest.TestCase):
    def test_automatic_secret_is_strong_and_reused(self):
        original = server.STATE_DIR
        try:
            with tempfile.TemporaryDirectory() as temporary:
                server.STATE_DIR = Path(temporary)
                first = server._persistent_session_secret()
                second = server._persistent_session_secret()
                self.assertEqual(first, second)
                self.assertGreaterEqual(len(first), 32)
                mode = (Path(temporary) / "session-secret").stat().st_mode & 0o777
                self.assertEqual(mode, 0o600)
        finally:
            server.STATE_DIR = original


class WorkspacePathTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        server.HOME_ROOT.mkdir(parents=True, exist_ok=True)
        (server.HOME_ROOT / "inside.txt").write_text("ok")

    def test_normal_path_resolves_in_home(self):
        self.assertEqual(server.resolve_home("/inside.txt"), server.HOME_ROOT / "inside.txt")

    def test_parent_traversal_is_rejected(self):
        with self.assertRaises(web.HTTPForbidden):
            server.resolve_home("/../etc/passwd", must_exist=False)

    def test_escaping_symlink_is_rejected(self):
        link = server.HOME_ROOT / "outside"
        link.unlink(missing_ok=True)
        link.symlink_to("/etc")
        with self.assertRaises(web.HTTPForbidden):
            server.resolve_home("/outside/passwd")

    def test_unsafe_names_are_rejected(self):
        for name in ("", ".", "..", "a/b", "line\nbreak"):
            with self.subTest(name=name), self.assertRaises(web.HTTPBadRequest):
                server.safe_name(name)


class ApiTestCase(unittest.IsolatedAsyncioTestCase):
    """Starts the real application and signs in through the public login route."""

    async def asyncSetUp(self):
        server.HOME_ROOT.mkdir(parents=True, exist_ok=True)
        self.client = TestClient(TestServer(server.create_app()))
        await self.client.start_server()
        response = await self.client.post("/api/login", json={"password": os.environ["WEBOS_PASSWORD"]})
        self.assertEqual(response.status, 200, await response.text())
        payload = await response.json()
        self.assertTrue(payload["ok"])
        self.headers = {"X-LumaDesk-CSRF": payload["csrf"]}

    async def asyncTearDown(self):
        await self.client.close()

    def write(self, relative: str, content: str = "hello") -> Path:
        path = server.HOME_ROOT / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return path

    async def trash_listing(self) -> dict:
        response = await self.client.get("/api/trash")
        self.assertEqual(response.status, 200, await response.text())
        return await response.json()

    def reset_workspace(self) -> None:
        for child in list(server.HOME_ROOT.iterdir()):
            if child.is_dir() and not child.is_symlink():
                shutil.rmtree(child)
            else:
                child.unlink()


class VersionTests(ApiTestCase):
    async def test_version_is_reported_over_http(self):
        health = await (await self.client.get("/healthz")).json()
        self.assertEqual(health["version"], server.APP_VERSION)
        session = await (await self.client.get("/api/session")).json()
        self.assertTrue(session["authenticated"])
        self.assertEqual(session["version"], server.APP_VERSION)


class TrashTests(ApiTestCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.reset_workspace()

    async def test_delete_list_restore_round_trip(self):
        self.write("Documents/notes.txt", "restore me")
        deleted = await self.client.delete("/api/file?path=/Documents/notes.txt", headers=self.headers)
        self.assertEqual(deleted.status, 200, await deleted.text())
        self.assertFalse((server.HOME_ROOT / "Documents" / "notes.txt").exists())

        listing = await self.trash_listing()
        self.assertEqual(listing["count"], 1)
        entry = listing["entries"][0]
        self.assertEqual(entry["label"], "notes.txt")
        self.assertEqual(entry["original"], "/Documents/notes.txt")
        self.assertEqual(entry["type"], "file")

        restored = await self.client.post("/api/trash/restore", json={"name": entry["name"]}, headers=self.headers)
        body = await restored.json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["path"], "/Documents/notes.txt")
        self.assertEqual((server.HOME_ROOT / "Documents" / "notes.txt").read_text(), "restore me")
        self.assertEqual((await self.trash_listing())["count"], 0)

    async def test_restore_renames_when_the_original_name_is_taken(self):
        self.write("Documents/report.md", "old copy")
        await self.client.delete("/api/file?path=/Documents/report.md", headers=self.headers)
        self.write("Documents/report.md", "new copy")

        entry = (await self.trash_listing())["entries"][0]
        restored = await self.client.post("/api/trash/restore", json={"name": entry["name"]}, headers=self.headers)
        body = await restored.json()
        self.assertEqual(body["path"], "/Documents/report (2).md")
        self.assertEqual((server.HOME_ROOT / "Documents" / "report.md").read_text(), "new copy")
        self.assertEqual((server.HOME_ROOT / "Documents" / "report (2).md").read_text(), "old copy")

    async def test_trash_names_cannot_escape_the_trash(self):
        self.write("keep.txt", "still here")
        for name in ("../keep.txt", "..", "a/b", "", "missing-entry"):
            with self.subTest(name=name):
                response = await self.client.post("/api/trash/purge", json={"name": name}, headers=self.headers)
                self.assertIn(response.status, (400, 404))
        self.assertTrue((server.HOME_ROOT / "keep.txt").exists())

    async def test_purge_and_empty_remove_payloads_and_metadata(self):
        self.write("Projects/scratch.py", "print(1)")
        self.write("Projects/deep/inner.log", "log line")
        for path in ("/Projects/scratch.py", "/Projects/deep"):
            response = await self.client.delete(f"/api/file?path={path}", headers=self.headers)
            self.assertEqual(response.status, 200, await response.text())

        files_dir, info_dir = server.trash_directories()
        self.assertEqual(len(list(files_dir.iterdir())), 2)
        self.assertEqual(len(list(info_dir.glob("*.trashinfo"))), 2)

        first = (await self.trash_listing())["entries"][0]["name"]
        purged = await self.client.post("/api/trash/purge", json={"name": first}, headers=self.headers)
        self.assertTrue((await purged.json())["ok"])
        self.assertEqual(len(list(files_dir.iterdir())), 1)
        self.assertEqual(len(list(info_dir.glob("*.trashinfo"))), 1)

        emptied = await self.client.post("/api/trash/empty", json={}, headers=self.headers)
        self.assertEqual((await emptied.json())["removed"], 1)
        self.assertEqual(list(files_dir.iterdir()), [])
        self.assertEqual(list(info_dir.glob("*.trashinfo")), [])

    async def test_trash_requires_authentication_and_csrf(self):
        anonymous = TestClient(TestServer(server.create_app()))
        await anonymous.start_server()
        self.addAsyncCleanup(anonymous.close)
        self.assertEqual((await anonymous.get("/api/trash")).status, 401)

        forged = await self.client.post("/api/trash/empty", json={}, headers={"X-LumaDesk-CSRF": "wrong-token"})
        self.assertEqual(forged.status, 403)


class TerminalSocketTests(ApiTestCase):
    async def test_terminal_streams_a_real_shell(self):
        if not shutil.which("bash"):
            self.skipTest("bash is not installed")
        async with self.client.ws_connect("/ws/terminal") as socket:
            ready = await asyncio.wait_for(socket.receive(), timeout=20)
            self.assertEqual(ready.type, aiohttp.WSMsgType.TEXT)
            self.assertEqual(json.loads(ready.data)["type"], "ready")
            await socket.send_json({"type": "input", "data": "echo lumadesk-pty-check\r"})
            collected = bytearray()
            async for message in socket:
                if message.type == aiohttp.WSMsgType.BINARY:
                    collected.extend(message.data)
                    if b"lumadesk-pty-check" in bytes(collected):
                        break
            self.assertIn(b"lumadesk-pty-check", bytes(collected))


if __name__ == "__main__":
    unittest.main()
