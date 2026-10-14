"""
Only this app may use the local backend (audit 180-C3).

Reproduced first against the running backend: a WebSocket to /mock/voice and
/audio/stream from ``Origin: https://evil.example`` was accepted (101), and
``<img src=".../mock/pronounce?text=…">`` needs no Origin at all.
"""
import unittest

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)
from fastapi.testclient import TestClient  # noqa: E402
from starlette.websockets import WebSocketDisconnect  # noqa: E402

from backend.core import local_guard  # noqa: E402
from backend.main import app  # noqa: E402

APP = "http://tauri.localhost"
EVIL = "https://evil.example"


def client(**kw):
    return TestClient(app, base_url="http://127.0.0.1:8000", **kw)


class GuardTest(unittest.TestCase):
    def setUp(self):
        self.c = client()
        self.token = local_guard.TOKEN

    def test_a_request_without_the_token_is_refused_and_says_why(self):
        r = self.c.get("/status", headers={"origin": APP})
        self.assertEqual(r.status_code, 401)
        self.assertEqual(r.headers.get("x-irb-auth"), "required")
        self.assertEqual(r.headers.get("access-control-allow-origin"), APP, "the app can read why")

    def test_the_app_with_its_token_gets_through(self):
        r = self.c.get("/status", headers={"origin": APP, "x-irb-token": self.token})
        self.assertEqual(r.status_code, 200)

    def test_the_token_may_come_as_a_query_where_headers_cannot(self):
        r = self.c.get(f"/status?t={self.token}")
        self.assertEqual(r.status_code, 200)

    def test_a_wrong_token_is_refused(self):
        r = self.c.get("/status", headers={"x-irb-token": "guess"})
        self.assertEqual(r.status_code, 401)

    def test_another_website_is_refused_even_holding_the_token(self):
        r = self.c.get("/status", headers={"origin": EVIL, "x-irb-token": self.token})
        self.assertEqual(r.status_code, 403)

    def test_dns_rebinding_is_refused(self):
        # The page's own domain, pointed at 127.0.0.1: its Host is still its own.
        r = self.c.get("/status", headers={"host": "rebind.evil.example:8000", "x-irb-token": self.token})
        self.assertEqual(r.status_code, 403)

    def test_an_img_tag_cannot_spend_on_speech(self):
        # No Origin, no token: exactly what <img src> sends.
        r = self.c.get("/mock/pronounce?text=hello")
        self.assertEqual(r.status_code, 401)

    def test_only_the_app_can_read_the_token(self):
        ok = self.c.get("/handshake", headers={"origin": APP})
        self.assertEqual(ok.status_code, 200)
        self.assertEqual(ok.json()["token"], self.token)
        self.assertEqual(self.c.get("/handshake").status_code, 403, "no Origin: not a page we know")
        self.assertEqual(self.c.get("/handshake", headers={"origin": EVIL}).status_code, 403)

    def test_the_sign_in_redirect_still_arrives_from_the_system_browser(self):
        r = self.c.get("/account/complete?code=")
        self.assertNotIn(r.status_code, (401, 403))

    def test_a_page_cannot_reach_the_typed_code_route(self):
        # Half of what makes the typed-code route safe: it is a POST on the
        # guarded API, so nothing a browser can send reaches it. (The other
        # half is the address check in account.complete_with_code — the guard
        # stops pages, not people.)
        body = {"code": "ATTACKER-CODE", "email": "victim@example.com"}
        for headers in ({}, {"origin": EVIL}, {"origin": APP}):
            r = self.c.post("/account/code", json=body, headers=headers)
            self.assertIn(r.status_code, (401, 403), headers)

    def test_that_refusal_is_the_guard_and_not_a_missing_route(self):
        # The test above passes for a path that does not exist, so on its own
        # it cannot tell "the guard refused this" from "nobody wired it up".
        # With the token the route has to answer for itself. An empty address
        # is refused before any network call, so this proves the handler is
        # there without reaching the service.
        r = self.c.post("/account/code", json={"code": "x", "email": ""},
                        headers={"origin": APP, "x-irb-token": self.token})
        self.assertNotEqual(r.status_code, 404, "the route is wired up")
        self.assertEqual(r.status_code, 400, "and it refused on its own terms")

        # The control: a path nobody serves, through the same guard.
        missing = self.c.post("/account/no-such-thing", json={},
                              headers={"origin": APP, "x-irb-token": self.token})
        self.assertEqual(missing.status_code, 404)

    def test_connecting_a_calendar_can_finish(self):
        # Google and Microsoft redirect the *system browser* to this path, so
        # it arrives with no token and no Origin of ours. It was refused with a
        # 401, which meant connecting a calendar could never complete in the
        # packaged app — and no test noticed, because the calendar tests call
        # oauth_finish directly instead of going through HTTP.
        for provider in ("google", "microsoft"):
            r = self.c.get(f"/calendar/oauth/{provider}/callback?state=x&code=y")
            self.assertNotIn(r.status_code, (401, 403), provider)

    def test_a_forged_callback_still_cannot_attach_a_calendar(self):
        # What makes letting it through safe: the state has to be one this
        # backend issued. Without it the flow refuses, so a page that forges a
        # callback cannot connect a calendar of its choosing.
        r = self.c.get("/calendar/oauth/google/callback?state=not-ours&code=y")
        self.assertNotIn(r.status_code, (401, 403))
        self.assertIn("expired", r.text.lower())

    def test_the_exemption_is_only_that_one_shape(self):
        # A neighbouring path must not inherit the exemption.
        for path in ("/calendar/events", "/calendar/oauth/google/callback/extra",
                     "/calendar/oauth//callback", "/calendar/oauth/google/start"):
            self.assertIn(self.c.get(path).status_code, (401, 403), path)

    def test_the_exemption_is_for_the_browser_coming_back_only(self):
        # A POST to the same path is not the browser returning from a sign-in.
        self.assertIn(self.c.post("/calendar/oauth/google/callback").status_code, (401, 403))

    def test_a_cors_preflight_is_answered_for_the_app(self):
        r = self.c.options("/status", headers={
            "origin": APP, "access-control-request-method": "GET",
            "access-control-request-headers": "x-irb-token",
        })
        self.assertEqual(r.status_code, 200)


class WebSocketGuardTest(unittest.TestCase):
    def setUp(self):
        self.c = client()

    def test_another_website_cannot_open_the_microphone(self):
        with self.assertRaises(WebSocketDisconnect):
            with self.c.websocket_connect(f"/audio/stream?t={local_guard.TOKEN}", headers={"origin": EVIL}):
                pass

    def test_no_token_no_socket(self):
        for path in ("/audio/stream", "/mock/voice"):
            with self.assertRaises(WebSocketDisconnect):
                with self.c.websocket_connect(path, headers={"origin": APP}):
                    pass

    def test_the_verdict_for_the_app_itself(self):
        scope = {
            "type": "websocket", "path": "/mock/voice",
            "headers": [(b"host", b"127.0.0.1:8000"), (b"origin", APP.encode())],
            "query_string": f"t={local_guard.TOKEN}".encode(),
        }
        self.assertEqual(local_guard.verdict(scope)[0], True)


class PackagedOriginsTest(unittest.TestCase):
    def test_the_dev_server_is_not_trusted_in_the_packaged_app(self):
        self.assertNotIn("http://localhost:5173", local_guard.APP_ORIGINS)
        self.assertIn("http://tauri.localhost", local_guard.APP_ORIGINS)



class InjectionTest(unittest.TestCase):
    """Audit 182-H1: one written key must not become any other setting."""

    def setUp(self):
        import tempfile
        from pathlib import Path
        from unittest import mock
        from backend.core import config
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.env = Path(self.dir.name) / ".env"
        p = mock.patch.object(config, "ENV_PATH", self.env)
        p.start()
        self.addCleanup(p.stop)
        self.config = config

    def test_a_newline_in_a_key_is_refused(self):
        with self.assertRaises(self.config.BadKeyValue):
            self.config._write_env_var("DEEPGRAM_API_KEY", "abc\nIRELIABEE_LOCAL_TOKEN=known")
        self.assertFalse(self.env.exists() and "IRELIABEE" in self.env.read_text())

    def test_the_apps_own_settings_are_never_read_from_dotenv(self):
        import os
        self.env.write_text("IRELIABEE_API=https://attacker.example\nDEEPGRAM_API_KEY=dg-ok\n")
        saved = os.environ.pop("IRELIABEE_API", None)
        saved_dg = os.environ.get("DEEPGRAM_API_KEY")
        try:
            self.config.load_env()
            self.assertNotEqual(os.environ.get("IRELIABEE_API"), "https://attacker.example")
            self.assertEqual(os.environ.get("DEEPGRAM_API_KEY"), "dg-ok")
        finally:
            os.environ.pop("IRELIABEE_API", None)
            if saved is not None:
                os.environ["IRELIABEE_API"] = saved
            if saved_dg is None:
                os.environ.pop("DEEPGRAM_API_KEY", None)
            else:
                os.environ["DEEPGRAM_API_KEY"] = saved_dg

    def test_dotenv_cannot_supply_the_token(self):
        import os
        self.env.write_text("IRELIABEE_LOCAL_TOKEN=" + "a" * 40 + "\n")
        os.environ.pop("IRELIABEE_LOCAL_TOKEN", None)
        self.config.load_env()
        self.assertNotIn("IRELIABEE_LOCAL_TOKEN", os.environ)


class GuardEdgesTest(unittest.TestCase):
    def test_a_non_ascii_token_is_refused_not_a_crash(self):
        r = client().get("/status?t=%C3%A9")
        self.assertEqual(r.status_code, 401)


class KeyEndpointTest(unittest.TestCase):
    """Provider keys are the admin's (audit 178-M13)."""

    def test_an_ordinary_account_cannot_write_a_provider_key(self):
        from unittest import mock
        from fastapi import HTTPException
        from backend.core import hosted
        from backend.routers import config as config_router
        with mock.patch.object(hosted, "is_admin", return_value=False), \
             mock.patch.object(config_router, "_write_env_var") as write:
            with self.assertRaises(HTTPException) as caught:
                config_router.set_key(config_router.SetKeyRequest(env_var="ANTHROPIC_API_KEY", value="sk"))
        self.assertEqual(caught.exception.status_code, 403)
        write.assert_not_called()



class HandedOverTokenTest(unittest.TestCase):
    """Audit 182-H2: the desktop app makes the token and the backend never hands it out."""

    def test_the_apps_token_is_taken_once_and_leaves_the_environment(self):
        import os
        from unittest import mock
        with mock.patch.dict(os.environ, {"IRELIABEE_LOCAL_TOKEN": "f" * 64}):
            self.assertEqual(local_guard._token_from_the_app(), "f" * 64)
            self.assertNotIn("IRELIABEE_LOCAL_TOKEN", os.environ, "no child process inherits it")

    def test_a_short_or_odd_token_is_ignored(self):
        import os
        from unittest import mock
        for bad in ("short", "x" * 40 + "\n", "a b" * 20):
            with mock.patch.dict(os.environ, {"IRELIABEE_LOCAL_TOKEN": bad}):
                self.assertEqual(local_guard._token_from_the_app(), "")

    def test_the_packaged_backend_never_hands_out_its_token(self):
        from unittest import mock
        with mock.patch.object(local_guard, "FROM_APP", True):
            r = client().get("/handshake", headers={"origin": APP})
        self.assertEqual(r.status_code, 403)
        self.assertNotIn(local_guard.TOKEN, r.text)

    def test_only_the_real_backend_can_prove_who_it_is(self):
        import hashlib
        import hmac
        r = client().get("/identify?n=challenge-123")      # no token sent
        self.assertEqual(r.status_code, 200)
        expected = hmac.new(local_guard.TOKEN.encode(), b"challenge-123", hashlib.sha256).hexdigest()
        self.assertEqual(r.json()["proof"], expected)
        self.assertNotIn(local_guard.TOKEN, r.text, "the proof reveals nothing")


if __name__ == "__main__":
    unittest.main()
