"""
The signed-in account on this computer (docs/hosted-pivot.md, step 2).

Most of these are about not locking people out. A sign-in system that fails
closed on a flaky network is worse than no sign-in system, because the failure
arrives exactly when someone is about to go into a meeting.
"""
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)
from backend.core import account  # noqa: E402


class AccountTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        patch = mock.patch.object(account, "ACCOUNT_PATH", Path(self._tmp.name) / "account.json")
        patch.start()
        self.addCleanup(patch.stop)

    def write(self, **data):
        account._save(data)


class SignedOutTest(AccountTestCase):
    def test_nobody_is_signed_in_to_start_with(self):
        status = account.status()
        self.assertFalse(status["signed_in"])
        self.assertIsNone(status["account"])
        self.assertIsNone(status["balance"])
        self.assertFalse(status["admin"])

    def test_no_token_is_not_an_error(self):
        # The ordinary state before sign-in, not a failure.
        self.assertIsNone(account.access_token())

    def test_a_corrupt_file_reads_as_signed_out(self):
        account.ACCOUNT_PATH.write_text("{ not json", encoding="utf-8")
        self.assertFalse(account.status()["signed_in"])

    def test_the_device_id_is_always_available(self):
        # The service labels sessions with it, so it must exist before sign-in.
        self.assertTrue(account.status()["device"]["id"])


class SignInTest(AccountTestCase):
    def test_an_obvious_non_address_is_caught_before_a_request(self):
        with mock.patch.object(account, "_post") as post:
            with self.assertRaises(account.AccountError):
                account.request_sign_in("not-an-email")
            post.assert_not_called()

    def test_the_port_is_sent_so_the_link_knows_where_to_come_back(self):
        with mock.patch.object(account, "_post", return_value={"message": "ok"}) as post:
            account.request_sign_in("a@b.co", port=8123)
        self.assertEqual(post.call_args[0][1]["port"], 8123)

    def test_completing_stores_both_tokens(self):
        with mock.patch.object(account, "_post", return_value={
            "refresh_token": "r-token", "access_token": "a-token",
            "account": {"id": "acc_1", "email": "a@b.co"},
        }):
            who = account.complete("code-123", self._started())
        self.assertEqual(who["email"], "a@b.co")
        status = account.status()
        self.assertTrue(status["signed_in"])
        self.assertEqual(status["account"]["email"], "a@b.co")

    def test_the_device_is_identified_when_trading_the_code(self):
        with mock.patch.object(account, "_post", return_value={
            "refresh_token": "r", "access_token": "a", "account": {},
        }) as post:
            state = self._started()
            account.complete("code", state)
        sent = post.call_args[0][1]
        self.assertTrue(sent["device"])
        self.assertTrue(sent["device_label"])

    def test_an_incomplete_answer_is_refused_rather_than_half_stored(self):
        state = self._started()
        with mock.patch.object(account, "_post", return_value={"access_token": "a"}):
            with self.assertRaises(account.AccountError):
                account.complete("code", state)
        self.assertFalse(account.status()["signed_in"])

    def _started(self) -> str:
        """Ask for a link, as the app does, and return the nonce it carried."""
        with mock.patch.object(account, "_post", return_value={"message": "ok"}) as post:
            account.request_sign_in("a@b.co", port=8000)
        return post.call_args[0][1]["state"]

    def test_a_sign_in_the_app_did_not_start_is_refused(self):
        # Audit 182-M1: a web page sends the browser to /account/complete
        # with a code it got for its own account. No nonce, or the wrong one.
        self._started()
        with mock.patch.object(account, "_post") as post:
            for state in ("", "a-guess-of-the-right-shape-000"):
                with self.assertRaises(account.AccountError):
                    account.complete("attacker-code", state)
            post.assert_not_called()
        self.assertFalse(account.status()["signed_in"])

    def test_one_link_signs_in_once(self):
        state = self._started()
        answer = {"refresh_token": "r", "access_token": "a", "account": {}}
        with mock.patch.object(account, "_post", return_value=answer):
            account.complete("code", state)
            with self.assertRaises(account.AccountError):
                account.complete("code-2", state)

    def test_an_empty_code_never_reaches_the_network(self):
        with mock.patch.object(account, "_post") as post:
            with self.assertRaises(account.AccountError):
                account.complete("")
            post.assert_not_called()


class SignInByCodeTest(AccountTestCase):
    """
    The code typed in, when the loopback handoff could not land.

    This path has to work with nothing held in memory: the restart that moves
    this backend off the port the link was told about is the same event that
    loses the nonce. So the nonce cannot guard it, and the address does instead
    - which is the difference between "a code finishes a sign-in" and "a code
    somebody was talked into typing finishes *their* sign-in".
    """

    ANSWER = {"refresh_token": "r", "access_token": "a", "account": {"email": "a@b.co"}}

    def _started(self) -> str:
        """Ask for a link, as the app does, and return the nonce it carried."""
        with mock.patch.object(account, "_post", return_value={"message": "ok"}) as post:
            account.request_sign_in("a@b.co", port=8000)
        return post.call_args[0][1]["state"]

    def test_a_code_signs_in_with_no_link_ever_asked_for_here(self):
        # Nothing started in this process: no request_sign_in, so no nonce.
        # That is the case this whole path exists for.
        with mock.patch.object(account, "_post", return_value=self.ANSWER):
            who = account.complete_with_code("ABCD-EFGH-JKMN", "a@b.co")
        self.assertEqual(who["email"], "a@b.co")
        self.assertTrue(account.status()["signed_in"])

    def test_a_code_for_another_account_is_refused(self):
        # The attack the address replaces the nonce to stop: an attacker
        # redeems a link for their own account and gets the victim to type the
        # code, which would otherwise bind this computer to that account -
        # taking its free monthly credit with it, irreversibly for the month.
        answer = {"refresh_token": "r", "access_token": "a",
                  "account": {"email": "attacker@evil.example"}}
        with mock.patch.object(account, "_post", return_value=answer):
            with self.assertRaises(account.AccountError) as caught:
                account.complete_with_code("ABCD-EFGH-JKMN", "victim@example.com")
        self.assertIn("attacker@evil.example", str(caught.exception), "it names what it refused")
        self.assertFalse(account.status()["signed_in"], "and nothing was stored")

    def test_the_refused_token_is_handed_straight_back(self):
        # Refusing without revoking would leave an attacker holding a live
        # refresh token for a device they do not own.
        answer = {"refresh_token": "r-live", "access_token": "a",
                  "account": {"email": "attacker@evil.example"}}
        with mock.patch.object(account, "_post", return_value=answer) as post:
            with self.assertRaises(account.AccountError):
                account.complete_with_code("ABCD-EFGH-JKMN", "victim@example.com")
        revoked = [c for c in post.call_args_list if c[0][0] == "/auth/signout"]
        self.assertEqual(len(revoked), 1, "the token was given back")
        self.assertEqual(revoked[0][0][1]["refresh_token"], "r-live")

    def test_a_service_that_names_no_account_is_refused_too(self):
        # Fail closed: an answer we cannot check is not an answer we accept.
        for account_field in ({}, {"email": ""}, None):
            answer = {"refresh_token": "r", "access_token": "a", "account": account_field}
            with mock.patch.object(account, "_post", return_value=answer):
                with self.assertRaises(account.AccountError):
                    account.complete_with_code("ABCD-EFGH-JKMN", "a@b.co")
            self.assertFalse(account.status()["signed_in"], repr(account_field))

    def test_the_address_is_matched_however_it_was_typed(self):
        # One account per address however it was typed, the same rule the
        # service applies - or half these sign-ins fail on a capital letter.
        for typed in ("A@B.co", "  a@b.CO  ", "a@b.co"):
            self.setUp()
            with mock.patch.object(account, "_post", return_value=self.ANSWER):
                account.complete_with_code("ABCD-EFGH-JKMN", typed)
            self.assertTrue(account.status()["signed_in"], typed)

    def test_a_revoke_that_cannot_be_delivered_still_refuses(self):
        # Best effort: the sign-in is already being refused, and an unreachable
        # service is not a reason to report something the user cannot act on.
        answer = {"refresh_token": "r", "access_token": "a",
                  "account": {"email": "someone@else.example"}}
        calls = []

        def flaky(path, body):
            calls.append(path)
            if path == "/auth/signout":
                raise account.AccountUnreachable("no network")
            return answer

        with mock.patch.object(account, "_post", side_effect=flaky):
            with self.assertRaises(account.AccountError):
                account.complete_with_code("ABCD-EFGH-JKMN", "a@b.co")
        self.assertIn("/auth/signout", calls, "it still tried")
        self.assertFalse(account.status()["signed_in"])

    def test_it_is_sent_as_typed_for_the_service_to_fold(self):
        # One owner for the hyphens and the case - normaliseAuthCode, on the
        # service. A second copy of that rule here is one that can drift.
        with mock.patch.object(account, "_post", return_value=self.ANSWER) as post:
            account.complete_with_code("  abcd-efgh-jkmn  ", "a@b.co")
        self.assertEqual(post.call_args_list[0][0][1]["code"], "abcd-efgh-jkmn")

    def test_the_device_is_identified_as_on_the_loopback_path(self):
        with mock.patch.object(account, "_post", return_value=self.ANSWER) as post:
            account.complete_with_code("ABCD-EFGH-JKMN", "a@b.co")
        sent = post.call_args_list[0][0][1]
        self.assertTrue(sent["device"])
        self.assertTrue(sent["device_label"])

    def test_neither_half_on_its_own_reaches_the_network(self):
        with mock.patch.object(account, "_post") as post:
            for code, email in (("   ", "a@b.co"), ("ABCD-EFGH-JKMN", "  "),
                                ("ABCD-EFGH-JKMN", "not-an-address"), ("", "")):
                with self.assertRaises(account.AccountError):
                    account.complete_with_code(code, email)
            post.assert_not_called()

    def test_an_incomplete_answer_is_refused_rather_than_half_stored(self):
        with mock.patch.object(account, "_post", return_value={"access_token": "a"}):
            with self.assertRaises(account.AccountError):
                account.complete_with_code("ABCD-EFGH-JKMN", "a@b.co")
        self.assertFalse(account.status()["signed_in"])

    def test_a_refused_code_leaves_the_link_still_good(self):
        # Typing it wrong must not burn the sign-in: the pending nonce survives,
        # so the loopback handoff can still finish the job.
        state = self._started()
        with mock.patch.object(account, "_post", side_effect=account.AccountError("no")):
            with self.assertRaises(account.AccountError):
                account.complete_with_code("WRONG-CODE-HERE", "a@b.co")
        with mock.patch.object(account, "_post", return_value=self.ANSWER):
            account.complete("the-real-code", state)
        self.assertTrue(account.status()["signed_in"])

    def test_the_nonce_outlasts_the_link_and_the_code_it_mints(self):
        # The loopback button is offered for as long as the code lives, so the
        # window this app will still finish a sign-in in has to cover both:
        # 15 minutes of link plus 10 of code. At 20 the button was refused
        # while the code printed beside it still worked.
        self.assertGreaterEqual(
            account._STATE_TTL, (15 + 10) * 60,
            "MAGIC_LINK_TTL + AUTH_CODE_TTL, from website/functions/_shared/auth.js")


class BackofficeTest(AccountTestCase):
    def test_the_link_is_asked_for_with_this_devices_token(self):
        self.write(refresh_token="r", access_token="admin-token",
                   access_expires=int(time.time()) + 900, account={})
        with mock.patch.object(account, "_post", return_value={"url": "https://x/v1/admin/enter?token=t"}) as post:
            self.assertEqual(account.backoffice_link(), "https://x/v1/admin/enter?token=t")
        post.assert_called_once_with("/admin/handoff", {}, token="admin-token")

    def test_signed_out_never_reaches_the_network(self):
        with mock.patch.object(account, "_post") as post:
            with self.assertRaises(account.AccountError):
                account.backoffice_link()
            post.assert_not_called()


class TokenTest(AccountTestCase):
    def test_a_fresh_token_is_used_as_is(self):
        self.write(refresh_token="r", access_token="still-good",
                   access_expires=int(time.time()) + 900, account={})
        with mock.patch.object(account, "_post") as post:
            self.assertEqual(account.access_token(), "still-good")
            post.assert_not_called()

    def test_a_token_near_expiry_is_replaced_before_it_fails(self):
        # Replaced early on purpose: a token that expires mid-request costs a
        # failed call, and the margin costs one extra refresh.
        self.write(refresh_token="r", access_token="nearly-stale",
                   access_expires=int(time.time()) + 30, account={})
        with mock.patch.object(account, "_post", return_value={
            "access_token": "brand-new", "account": {"email": "a@b.co"},
        }):
            self.assertEqual(account.access_token(), "brand-new")

    def test_a_refresh_failure_keeps_the_old_token_rather_than_signing_out(self):
        # Wifi dropping must not look the same as being revoked.
        self.write(refresh_token="r", access_token="old",
                   access_expires=int(time.time()) + 10, account={})
        with mock.patch.object(account, "_post",
                               side_effect=account.AccountError("Could not reach iReliabee.")):
            self.assertEqual(account.access_token(), "old")
        self.assertTrue(account.status()["signed_in"],
                        "a network blip must not sign someone out")

    def test_the_refreshed_account_is_remembered(self):
        self.write(refresh_token="r", access_token="old", access_expires=0,
                   account={"email": "a@b.co"})
        with mock.patch.object(account, "_post", return_value={
            "access_token": "new", "account": {"email": "a@b.co", "name": "Ama"},
        }):
            account.access_token()
        self.assertEqual(account.status()["account"]["name"], "Ama")

    def test_a_refresh_that_lands_after_signing_out_does_not_sign_back_in(self):
        self.write(refresh_token="r", access_token="old", access_expires=0, account={"email": "a@b.co"})

        def refresh_while_signing_out(path, body, token=None):
            with account._lock:          # what sign_out does, while this refresh is on its way
                account._clear()
            return {"access_token": "new", "account": {"email": "a@b.co"}}

        with mock.patch.object(account, "_post", side_effect=refresh_while_signing_out):
            self.assertIsNone(account.access_token())
        self.assertFalse(account.status()["signed_in"], "signing out must stick")
        self.assertFalse(account.ACCOUNT_PATH.exists())

    def test_callers_waiting_on_a_failed_refresh_do_not_each_try_again(self):
        # A slow, failing network: the old code queued one timeout per caller.
        import threading
        self.write(refresh_token="r", access_token="old", access_expires=0, account={})
        calls = []

        def slow_failure(*a, **k):
            calls.append(1)
            time.sleep(0.3)
            raise account.AccountError("Could not reach iReliabee.")

        got = []
        with mock.patch.object(account, "_post", side_effect=slow_failure):
            threads = [threading.Thread(target=lambda: got.append(account.access_token())) for _ in range(5)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
        self.assertEqual(len(calls), 1, "one attempt, shared by everyone waiting on it")
        self.assertEqual(got, ["old"] * 5)


class SignOutTest(AccountTestCase):
    def test_signing_out_clears_the_device(self):
        self.write(refresh_token="r", access_token="a", account={"email": "a@b.co"})
        with mock.patch.object(account, "_post", return_value={"ok": True}):
            account.sign_out()
        self.assertFalse(account.status()["signed_in"])

    def test_signing_out_works_offline(self):
        # Asked to sign out, so sign out — being unable to reach the service is
        # not a reason to keep someone signed in on a machine they are leaving.
        self.write(refresh_token="r", access_token="a", account={})
        with mock.patch.object(account, "_post",
                               side_effect=account.AccountError("offline")):
            account.sign_out()
        self.assertFalse(account.status()["signed_in"])


class StorageTest(AccountTestCase):
    def test_the_file_is_written_atomically(self):
        self.write(refresh_token="r", account={})
        # No stray temp file left behind to be read as state.
        leftovers = list(Path(self._tmp.name).glob("*.tmp"))
        self.assertEqual(leftovers, [])

    def test_tokens_are_not_readable_as_anything_but_this_account(self):
        self.write(refresh_token="r-secret", access_token="a-secret", account={})
        on_disk = json.loads(account.ACCOUNT_PATH.read_text(encoding="utf-8"))
        # They are stored in the clear, and that is deliberate: both are
        # revocable server-side, and encrypting them with a key next to them
        # would be theatre. The test records the decision.
        self.assertEqual(on_disk["refresh_token"], "r-secret")


if __name__ == "__main__":
    unittest.main()


class BalanceTest(AccountTestCase):
    """
    The credit balance.

    It lives on the server, where the user cannot edit it. But a laptop on a
    train still has to be able to say roughly what is left rather than showing
    a blank where a number should be, so the last known figure is cached with
    the time it was read.
    """

    def signed_in(self):
        self.write(refresh_token="r", access_token="a",
                   access_expires=int(time.time()) + 3600,
                   account={"email": "a@b.co"})

    def test_the_balance_is_read_from_the_service_and_cached(self):
        self.signed_in()
        with mock.patch.object(account, "_get", return_value={
            "account": {"email": "a@b.co"},
            "balance": {"credits": 4, "held": 0.5, "available": 3.5},
        }):
            balance = account.balance()
        self.assertEqual(balance["available"], 3.5)
        self.assertEqual(account.status()["balance"]["credits"], 4)

    def test_the_free_credit_status_reaches_the_account_screen(self):
        # One free credit per computer: the app says so when another account has it.
        self.signed_in()
        with mock.patch.object(account, "_get", return_value={
            "balance": {"credits": 0, "held": 0, "available": 0},
            "free": {"month": "2026-09", "granted": False, "elsewhere": True},
        }):
            account.balance()
        self.assertEqual(account.status()["free"], {"month": "2026-09", "granted": False, "elsewhere": True})

    def test_an_older_service_without_free_status_leaves_it_empty(self):
        self.signed_in()
        with mock.patch.object(account, "_get", return_value={"balance": {"credits": 2, "held": 0, "available": 2}}):
            account.balance()
        self.assertIsNone(account.status()["free"])

    def test_held_credits_are_kept_apart_from_the_balance(self):
        # "You have none" and "a session you are in is using them" are very
        # different things to read on the account screen.
        self.signed_in()
        with mock.patch.object(account, "_get", return_value={
            "balance": {"credits": 1, "held": 1, "available": 0},
        }):
            balance = account.balance()
        self.assertEqual(balance["credits"], 1)
        self.assertEqual(balance["held"], 1)
        self.assertEqual(balance["available"], 0)

    def test_a_cached_balance_survives_the_network_going_away(self):
        self.signed_in()
        with mock.patch.object(account, "_get", return_value={
            "balance": {"credits": 6, "held": 0, "available": 6},
        }):
            account.balance()

        with mock.patch.object(account, "_get", side_effect=account.AccountError("offline")):
            status = account.status(refresh=True)
        self.assertEqual(status["balance"]["credits"], 6,
                         "a flaky network must not blank the number")
        self.assertTrue(status["signed_in"])

    def test_asking_for_a_balance_signed_out_is_an_error_not_a_zero(self):
        with self.assertRaises(account.AccountError):
            account.balance()

    def test_a_balance_is_not_written_for_someone_who_signed_out_meanwhile(self):
        # The read is slow and the user pressed Sign out while it was in
        # flight; the answer must not resurrect a file we just deleted.
        self.signed_in()
        def slow_get(path, token):
            account._clear()
            return {"balance": {"credits": 3, "held": 0, "available": 3}}
        with mock.patch.object(account, "_get", side_effect=slow_get):
            account.balance()
        self.assertFalse(account.status()["signed_in"])
        self.assertIsNone(account.status()["balance"])


class AdminTest(AccountTestCase):
    def test_provider_keys_are_hidden_unless_the_service_says_otherwise(self):
        self.write(refresh_token="r", account={"email": "a@b.co"})
        self.assertFalse(account.status()["admin"])

    def test_the_service_is_what_grants_it(self):
        # Never the client: this flag is read from the account the service
        # returned, so it cannot be turned on locally.
        self.write(refresh_token="r", account={"email": "a@b.co", "admin": True})
        self.assertTrue(account.status()["admin"])

    def test_own_keys_and_the_backoffice_are_separate_grants(self):
        # Own keys without the backoffice: the key settings, and no button.
        self.write(refresh_token="r", account={"email": "a@b.co", "admin": True, "backoffice": False})
        status = account.status()
        self.assertTrue(status["admin"])
        self.assertFalse(status["backoffice"])
        # The backoffice without own keys: the button, and the app stays on credits.
        self.write(refresh_token="r", account={"email": "a@b.co", "admin": False, "backoffice": True})
        status = account.status()
        self.assertFalse(status["admin"])
        self.assertTrue(status["backoffice"])

    def test_a_service_from_before_the_split_gives_the_backoffice_to_owners_only(self):
        self.write(refresh_token="r", account={"email": "a@b.co", "admin": True})
        self.assertTrue(account.status()["backoffice"])
        self.write(refresh_token="r", account={"email": "a@b.co"})
        self.assertFalse(account.status()["backoffice"])

    def test_signed_out_has_neither(self):
        self.write(account={"email": "a@b.co", "admin": True, "backoffice": True})
        status = account.status()
        self.assertFalse(status["admin"])
        self.assertFalse(status["backoffice"])
