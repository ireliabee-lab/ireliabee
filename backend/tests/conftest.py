"""
The open edition's test set-up.

This build is the open edition (``backend/edition.py``, ``OPEN = True``): own keys, every feature,
and the hosted iReliabee service off unless ``IRELIABEE_HOSTED=1``. The modules below test the
hosted service's side of the app: signing in, credits, licences, the gates that close when signed
out, and the relay's fallbacks. That code still ships here, because the hosted service can be
switched on, so its tests still run, as the hosted app they were written for.
``test_edition.py`` covers the open edition's own defaults, and every other module runs as the
open edition.
"""
import pytest

HOSTED_APP_MODULES = {
    "test_account",
    "test_edition",       # its open-edition tests switch OPEN back on for themselves
    "test_hosted",
    "test_licence",
    "test_notebook",
    "test_reading",
    "test_relay_central",
    "test_suspended",
}


@pytest.fixture(autouse=True)
def _as_the_hosted_app(request, monkeypatch):
    if request.module.__name__.rsplit(".", 1)[-1] in HOSTED_APP_MODULES:
        from backend import edition
        monkeypatch.setattr(edition, "OPEN", False)
        monkeypatch.delenv("IRELIABEE_EDITION", raising=False)
    yield
