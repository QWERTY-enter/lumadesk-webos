"""Small security-focused unit tests for the LumaDesk backend."""
import os
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
from aiohttp import web  # noqa: E402


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


if __name__ == "__main__":
    unittest.main()
