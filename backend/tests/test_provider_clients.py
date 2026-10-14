"""The provider clients are built for real, with the SDK versions the app ships (CI installs
backend/constraints.txt), and no network.

Other tests replace the providers, so nothing ever built a client. That hid a release-breaking bug:
0.4.14 passed an httpx.Timeout to every SDK, anthropic 1.7 (on httpx2) refuses one, and every Claude
call failed. Ways this can go wrong, written down first (CLAUDE.md, Testing, rule 3):

1. An SDK refuses the timeout or another option at construction: every call fails.
2. The limits are lost on the way: a provider that never answers holds a recap for half an hour.
"""
from backend.tests import _env  # noqa: F401

from unittest import mock

from backend.core import hosted, providers


def setup_function():
    providers._clients.clear()


def test_the_anthropic_client_builds_with_the_shipped_sdk_and_keeps_the_limits():
    with mock.patch.object(hosted, "anthropic_credentials", return_value=("sk-ant-test", None)):
        client = providers._anthropic_client()
    assert client.max_retries == 1
    assert client.timeout.read == 120.0 and client.timeout.connect == 10.0


def test_the_anthropic_client_builds_for_the_hosted_proxy_too():
    with mock.patch.object(hosted, "anthropic_credentials", return_value=("IRA1.token", "https://ireliabee.co.uk")):
        client = providers._anthropic_client()
    assert str(client.base_url).startswith("https://ireliabee.co.uk")


def test_the_openai_compatible_clients_build_and_keep_the_limits(monkeypatch):
    for provider, cfg in providers.PROVIDERS.items():
        if provider == "anthropic" or "env" not in cfg:
            continue
        monkeypatch.setenv(cfg["env"], "sk-test")
        client = providers._openai_client(provider)
        assert client.max_retries == 1, provider
        assert client.timeout.connect == 10.0, provider
