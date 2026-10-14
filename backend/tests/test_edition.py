"""The open-source edition's switch (backend/edition.py). Written down first (CLAUDE.md, Testing,
rule 3), one test each:

1. The iReliabee app slips into own-keys mode: never, unless it is the open edition.
2. The open edition, signed out, cannot use its own keys or a Pro feature: it must, it has no account.
3. Signing in to iReliabee in the open edition makes the account an admin: it never does; the
   service's grants decide, exactly as in the app.
4. The open edition talks to the hosted service before the user switches it on: it never does.
"""
from backend.tests import _env  # noqa: F401

from unittest import mock

import pytest

from backend import edition, entitlements
from backend.core import account, hosted


@pytest.fixture
def open_edition(monkeypatch):
    monkeypatch.setattr(edition, "OPEN", True)


@pytest.fixture
def signed_out(monkeypatch):
    monkeypatch.setattr(account, "_load", lambda: {})


def signed_in_as(monkeypatch, admin: bool):
    monkeypatch.setattr(account, "_load", lambda: {"refresh_token": "r", "account": {"email": "a@example.com", "admin": admin}})


def test_the_app_signed_out_has_no_own_keys_and_no_pro(monkeypatch, signed_out):
    monkeypatch.delenv("IRELIABEE_EDITION", raising=False)
    assert edition.is_open() is False
    status = account.status()
    assert status["admin"] is False and status["edition"] == "app"
    assert hosted.is_admin() is False
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-local-test")
    assert hosted.own_key("ANTHROPIC_API_KEY") is None
    with mock.patch.object(entitlements.licence, "is_pro", return_value=False), \
         mock.patch.object(entitlements.licence, "allows", return_value=False):
        assert entitlements.allows("notebook") is False


def test_the_open_edition_signed_out_runs_on_its_own_keys_with_every_feature(monkeypatch, open_edition, signed_out):
    status = account.status()
    assert status["signed_in"] is False and status["admin"] is True and status["edition"] == "open"
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-local-test")
    assert hosted.own_key("ANTHROPIC_API_KEY") == "sk-ant-local-test"
    with mock.patch.object(entitlements.licence, "is_pro", return_value=False), \
         mock.patch.object(entitlements.licence, "allows", return_value=False):
        assert entitlements.allows("notebook") is True
        entitlements.check_pro("live")   # raises 402 if not allowed


def test_signing_in_in_the_open_edition_follows_the_services_grants(monkeypatch, open_edition):
    monkeypatch.setenv("IRELIABEE_HOSTED", "1")            # off by default; see the tests below
    signed_in_as(monkeypatch, admin=False)
    assert account.status()["admin"] is False   # a hosted account uses credits, as in the app
    signed_in_as(monkeypatch, admin=True)
    assert account.status()["admin"] is True


def test_the_development_switch(monkeypatch, signed_out):
    monkeypatch.setenv("IRELIABEE_EDITION", "open")
    assert edition.is_open() and account.status()["admin"] is True


# -- The hosted service, off by default in the open edition --------------------

def test_the_app_always_offers_the_hosted_service(monkeypatch, signed_out):
    monkeypatch.delenv("IRELIABEE_EDITION", raising=False)
    monkeypatch.delenv("IRELIABEE_HOSTED", raising=False)
    assert edition.hosted_enabled() is True
    assert account.status()["hosted"] is True


def test_the_open_edition_never_calls_the_service_unless_switched_on(monkeypatch, open_edition):
    monkeypatch.delenv("IRELIABEE_HOSTED", raising=False)
    assert edition.hosted_enabled() is False
    with mock.patch("requests.post") as post, mock.patch("requests.get") as get:
        with pytest.raises(account.HostedOff):
            account.request_sign_in("a@example.com")
        with pytest.raises(account.HostedOff):
            account._get("/account", "t")
        post.assert_not_called()
        get.assert_not_called()


def test_a_kept_sign_in_counts_for_nothing_while_the_service_is_off(monkeypatch, open_edition):
    monkeypatch.delenv("IRELIABEE_HOSTED", raising=False)
    signed_in_as(monkeypatch, admin=False)
    status = account.status()
    assert status["signed_in"] is False and status["hosted"] is False and status["admin"] is True


def test_the_open_edition_can_switch_the_service_on(monkeypatch, open_edition, signed_out):
    monkeypatch.setenv("IRELIABEE_HOSTED", "1")
    assert edition.hosted_enabled() is True and account.status()["hosted"] is True


def test_the_open_edition_asks_for_a_key_not_a_sign_in(monkeypatch, open_edition, signed_out):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    with pytest.raises(hosted.NotAvailable, match="Anthropic key"):
        hosted.anthropic_credentials()
