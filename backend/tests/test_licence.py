"""
Licence verification, expiry, grace and the free-tier live-session ledger.

Tests sign with a throwaway key pair and patch `PUBLIC_KEYS`, so nothing here
depends on the real signing key — and a leak of the real key would not make
these tests pass.
"""
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)

from cryptography.hazmat.primitives import serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey  # noqa: E402

from backend.core import account, licence  # noqa: E402
from backend import entitlements  # noqa: E402

DAY = 86400

_SIGNING_KEY = Ed25519PrivateKey.generate()
_PUBLIC_HEX = _SIGNING_KEY.public_key().public_bytes(
    encoding=serialization.Encoding.Raw,
    format=serialization.PublicFormat.Raw,
).hex()
TEST_KEYS = {"k1": _PUBLIC_HEX}


def make_token(signer=None, **overrides) -> str:
    """A valid Pro token, unless an override makes it otherwise."""
    now = int(time.time())
    payload = {
        "v": 1, "kid": "k1", "prod": licence.PRODUCT,
        "lic": "lic_test", "tier": "pro", "plan": "annual", "seats": 1,
        "holder": "Test Holder",
        "iat": now, "exp": now + 30 * DAY, "sub_exp": now + 365 * DAY,
    }
    payload.update(overrides)
    payload = {k: v for k, v in payload.items() if v is not ...}
    body = licence.b64url_encode(
        json.dumps(payload, separators=(",", ":"), sort_keys=True).encode())
    signed = f"{licence.TOKEN_PREFIX}.{body}".encode("ascii")
    signature = licence.b64url_encode((signer or _SIGNING_KEY).sign(signed))
    return f"{licence.TOKEN_PREFIX}.{body}.{signature}"


class LicenceTestCase(unittest.TestCase):
    """Isolates the licence file and the signing keys for every test."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        patches = [
            mock.patch.object(licence, "LICENCE_PATH", Path(self._tmp.name) / "licence.json"),
            mock.patch.object(licence, "PUBLIC_KEYS", TEST_KEYS),
            # Signing in opens the gates too, so a developer's own account on
            # this machine must not leak into what these tests see.
            mock.patch.object(account, "ACCOUNT_PATH", Path(self._tmp.name) / "account.json"),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def install(self, token: str) -> licence.Entitlement:
        return licence.import_token(token)

    def sign_in(self) -> None:
        account._save({"refresh_token": "r", "account": {"email": "a@example.com"}})


# -- Signature and shape -----------------------------------------------------

class VerifyTest(LicenceTestCase):
    def test_a_genuine_token_verifies(self):
        payload = licence.verify_token(make_token())
        self.assertEqual(payload["tier"], "pro")
        self.assertEqual(payload["holder"], "Test Holder")

    def test_an_edited_payload_is_rejected(self):
        # Re-encode the payload with more seats but keep the original signature:
        # this is the obvious forgery, and it must fail.
        prefix, body, sig = make_token().split(".")
        payload = json.loads(licence._b64url_decode(body))
        payload["seats"] = 500
        forged = licence.b64url_encode(json.dumps(payload, separators=(",", ":"),
                                                 sort_keys=True).encode())
        with self.assertRaises(licence.LicenceError):
            licence.verify_token(f"{prefix}.{forged}.{sig}")

    def test_another_signing_key_is_rejected(self):
        with self.assertRaises(licence.LicenceError):
            licence.verify_token(make_token(signer=Ed25519PrivateKey.generate()))

    def test_a_token_for_another_product_is_rejected(self):
        with self.assertRaises(licence.LicenceError):
            licence.verify_token(make_token(prod="something-else"))

    def test_an_unknown_key_id_is_rejected(self):
        with self.assertRaises(licence.LicenceError):
            licence.verify_token(make_token(kid="k99"))

    def test_rubbish_is_rejected_without_crashing(self):
        for bad in ("", "hello", "IRL1.abc", "IRL1.$$$.$$$", "IRL2.a.b", "a.b.c"):
            with self.assertRaises(licence.LicenceError):
                licence.verify_token(bad)


# -- Expiry, grace and the clock ---------------------------------------------

class ExpiryTest(LicenceTestCase):
    def test_no_licence_means_free(self):
        ent = licence.evaluate()
        self.assertEqual(ent.state, "none")
        self.assertFalse(ent.is_pro)

    def test_a_current_licence_is_active(self):
        ent = self.install(make_token())
        self.assertEqual(ent.state, "active")
        self.assertTrue(ent.is_pro)
        self.assertEqual(ent.plan, "annual")

    def test_a_stale_token_keeps_working_during_grace(self):
        now = int(time.time())
        ent = self.install(make_token(exp=now - 2 * DAY))
        self.assertEqual(ent.state, "grace")
        self.assertTrue(ent.is_pro, "a failed refresh must not cut someone off immediately")
        self.assertIn("day", ent.message)

    def test_pro_stops_once_grace_runs_out(self):
        now = int(time.time())
        ent = self.install(make_token(exp=now - (licence.GRACE_DAYS + 1) * DAY))
        self.assertEqual(ent.state, "expired")
        self.assertFalse(ent.is_pro)

    def test_a_finished_subscription_ends_immediately_without_grace(self):
        # sub_exp is the real end date: grace covers a failed refresh, not a
        # licence that has genuinely run out.
        now = int(time.time())
        ent = self.install(make_token(exp=now + 10 * DAY, sub_exp=now - DAY))
        self.assertEqual(ent.state, "expired")
        self.assertFalse(ent.is_pro)

    def test_a_lifetime_licence_never_expires(self):
        far = int(time.time()) + 50 * 365 * DAY
        ent = self.install(make_token(plan="lifetime", sub_exp=None, exp=far))
        self.assertEqual(ent.state, "active")
        self.assertTrue(ent.is_pro)

    def test_winding_the_clock_back_does_not_revive_an_expired_licence(self):
        now = int(time.time())
        self.install(make_token(exp=now - (licence.GRACE_DAYS + 1) * DAY,
                                sub_exp=now - DAY))
        self.assertFalse(licence.evaluate().is_pro)

        # The store has now seen `now`. Pretend the user sets the clock back a year.
        with mock.patch.object(licence.time, "time", return_value=now - 365 * DAY):
            self.assertFalse(licence.evaluate().is_pro,
                             "the high-water clock mark should survive a rollback")

    def test_small_clock_drift_is_tolerated(self):
        store = licence.LicenceStore({"seen_at": int(time.time())})
        with mock.patch.object(licence.time, "time", return_value=int(time.time()) - 60):
            self.assertLess(abs(store.now() - int(time.time())), 120)


# -- Device binding ----------------------------------------------------------

class DeviceTest(LicenceTestCase):
    def test_a_licence_bound_to_another_machine_is_refused(self):
        ent = self.install(make_token(dev="not-this-machine"))
        self.assertEqual(ent.state, "invalid")
        self.assertFalse(ent.is_pro)
        self.assertIn("different computer", ent.message)

    def test_a_licence_bound_to_this_machine_works(self):
        ent = self.install(make_token(dev=licence.device_id()))
        self.assertTrue(ent.is_pro)

    def test_the_device_id_is_stable_and_not_the_raw_machine_id(self):
        first = licence.device_id()
        self.assertEqual(first, licence.device_id())
        self.assertEqual(len(first), 32)
        self.assertNotIn(licence._machine_id_raw() or "\0", first)


# -- Storage -----------------------------------------------------------------

class StoreTest(LicenceTestCase):
    def test_a_corrupt_licence_file_falls_back_to_free_rather_than_crashing(self):
        licence.LICENCE_PATH.write_text("{ not json", encoding="utf-8")
        self.assertEqual(licence.evaluate().state, "none")

    def test_editing_the_file_cannot_grant_pro(self):
        licence.LICENCE_PATH.write_text(
            json.dumps({"token": "IRL1.fake.fake", "revoked": False}), encoding="utf-8")
        ent = licence.evaluate()
        self.assertEqual(ent.state, "invalid")
        self.assertFalse(ent.is_pro)

    def test_deactivate_clears_the_licence_offline(self):
        self.install(make_token())
        self.assertTrue(licence.is_pro())
        ent = licence.deactivate()
        self.assertEqual(ent.state, "none")
        self.assertFalse(licence.is_pro())

    def test_revocation_is_honoured(self):
        self.install(make_token())
        store = licence.LicenceStore.load()
        store.data["revoked"] = True
        store.save()
        self.assertEqual(licence.evaluate().state, "revoked")
        self.assertFalse(licence.is_pro())


# -- Licence keys ------------------------------------------------------------

class KeyFormatTest(unittest.TestCase):
    def test_keys_are_tidied_into_groups(self):
        self.assertEqual(licence.normalise_key("irel abcde-fghij klmno pqrst"),
                         "IREL-ABCDE-FGHIJ-KLMNO-PQRST")

    def test_a_key_pasted_with_the_prefix_is_not_doubled(self):
        self.assertEqual(licence.normalise_key("IREL-ABCDE-FGHIJ-KLMNO-PQRST"),
                         "IREL-ABCDE-FGHIJ-KLMNO-PQRST")

    def test_an_obvious_typo_is_caught_before_any_network_call(self):
        self.assertFalse(licence.looks_like_key("IREL-ABC"))
        self.assertTrue(licence.looks_like_key("IREL-ABCDE-FGHIJ-KLMNO-PQRST"))


# -- Free live sessions ------------------------------------------------------

class LiveSessionTest(LicenceTestCase):
    """
    The free-session ledger.

    Enforcement is off in the running app (see `ENFORCE_FREE_LIMIT`): it counts
    sessions, which was the bring-your-own-key rule, and the hosted model
    counts minutes on the server instead. The counting is still tested, because
    it is what gets ported — a session that has already gone live must keep
    being allowed back, however the allowance is eventually measured.
    """

    def setUp(self):
        super().setUp()
        with entitlements._connect() as conn:
            conn.execute("DELETE FROM live_session_grants")
        patch = mock.patch.object(entitlements, "ENFORCE_FREE_LIMIT", True)
        patch.start()
        self.addCleanup(patch.stop)

    def test_the_free_tier_gets_two_live_sessions(self):
        self.assertEqual(entitlements.live_sessions_left(), 2)
        self.assertTrue(entitlements.claim_live_session(101)[0])
        self.assertEqual(entitlements.live_sessions_left(), 1)
        self.assertTrue(entitlements.claim_live_session(102)[0])
        self.assertEqual(entitlements.live_sessions_left(), 0)

        allowed, reason = entitlements.claim_live_session(103)
        self.assertFalse(allowed)
        self.assertIn("Pro", reason)

    def test_reconnecting_to_the_same_session_never_costs_a_second_grant(self):
        # A dropped call, a pause and resume, or switching between the microphone
        # and system audio all reopen the socket for the same session.
        for _ in range(10):
            self.assertTrue(entitlements.claim_live_session(201)[0])
        self.assertEqual(entitlements.live_sessions_left(), 1)

    def test_a_spent_session_may_always_go_live_again_even_at_the_limit(self):
        entitlements.claim_live_session(301)
        entitlements.claim_live_session(302)
        self.assertEqual(entitlements.live_sessions_left(), 0)
        self.assertTrue(entitlements.claim_live_session(301)[0],
                        "an in-progress call must never be cut off by the limit")

    def test_deleting_a_session_does_not_refund_its_grant(self):
        entitlements.claim_live_session(401)
        with entitlements._connect() as conn:
            conn.execute("DELETE FROM sessions WHERE id = 401")
        self.assertEqual(entitlements.live_sessions_left(), 1)

    def test_a_missing_session_id_fails_closed(self):
        allowed, _ = entitlements.claim_live_session(None)
        self.assertFalse(allowed)
        self.assertEqual(entitlements.live_sessions_left(), 2, "and spends nothing")

    def test_pro_does_not_touch_the_free_ledger(self):
        self.install(make_token())
        for sid in range(500, 510):
            self.assertTrue(entitlements.claim_live_session(sid)[0])
        self.assertEqual(entitlements.live_sessions_left(), 2,
                         "a licence that later lapses must not leave the free sessions spent")


# -- Gates -------------------------------------------------------------------

class GateTest(LicenceTestCase):
    def test_pro_features_are_closed_without_a_licence(self):
        for feature in licence.PRO_FEATURES:
            self.assertFalse(licence.allows(feature), feature)

    def test_pro_features_open_with_a_licence(self):
        self.install(make_token())
        for feature in licence.PRO_FEATURES:
            self.assertTrue(licence.allows(feature), feature)

    def test_anything_not_listed_as_pro_is_free(self):
        self.assertTrue(licence.allows("mock-interview"))
        self.assertTrue(licence.allows(""))

    def test_a_closed_gate_raises_402_with_a_usable_body(self):
        with self.assertRaises(Exception) as caught:
            entitlements.check_pro("export")
        exc = caught.exception
        self.assertEqual(exc.status_code, 402)
        self.assertEqual(exc.detail["error"], "pro_required")
        self.assertEqual(exc.detail["feature"], "export")
        self.assertTrue(exc.detail["message"])

    def test_every_pro_feature_has_something_to_tell_the_user(self):
        for feature in licence.PRO_FEATURES:
            self.assertIn(feature, entitlements._REASONS, f"{feature} has no explanation")

    def test_nothing_is_refused_while_enforcement_is_off(self):
        # The state the app actually ships in today.
        for sid in range(900, 910):
            allowed, _ = entitlements.claim_live_session(sid)
            self.assertTrue(allowed)
        self.assertFalse(entitlements.status()["enforced"])

    def test_status_reports_every_feature(self):
        status = entitlements.status()
        self.assertEqual(set(status["features"]), set(licence.PRO_FEATURES))
        self.assertFalse(any(status["features"].values()))
        self.assertEqual(status["free_live_sessions"]["limit"], 2)

        self.install(make_token())
        status = entitlements.status()
        self.assertTrue(all(status["features"].values()))
        self.assertTrue(status["can_start_live"])

    # The hosted model: the account is the entitlement (docs/hosted-pivot.md).

    def test_signing_in_opens_every_gate(self):
        self.sign_in()
        for feature in licence.PRO_FEATURES:
            entitlements.check_pro(feature)          # does not raise
        self.assertTrue(all(entitlements.status()["features"].values()))

    def test_signing_out_closes_them_again(self):
        self.sign_in()
        account._clear()
        with self.assertRaises(Exception) as caught:
            entitlements.check_pro("calendar")
        self.assertEqual(caught.exception.status_code, 402)

    def test_a_closed_gate_says_to_sign_in(self):
        # Nobody can buy a licence any more; pointing them at one is a dead end.
        with self.assertRaises(Exception) as caught:
            entitlements.check_pro("calendar")
        self.assertIn("Sign in", caught.exception.detail["message"])

    def test_the_dependency_form_follows_the_account_too(self):
        # The routers use this form; it must not keep asking the licence.
        gate = entitlements.require_pro("recap")
        with self.assertRaises(Exception):
            gate()
        self.sign_in()
        gate()


if __name__ == "__main__":
    unittest.main()
