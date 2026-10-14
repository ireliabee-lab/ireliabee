"""
Which build this is: the iReliabee app, or its open-source edition.

The open edition (AGPL-3.0, published by ``scripts/export_open_edition.py``) runs on the user's own
provider keys, with every feature, without an iReliabee account; signing in to iReliabee to use its
hosted AI and credits stays an option. The app built here is the hosted one: own keys are a grant
the service gives (docs/hosted-pivot.md), never a local switch.

The export sets ``OPEN = True`` in the copy it publishes. ``IRELIABEE_EDITION=open`` does the same
in a development run, to try the open edition from this tree. Neither costs iReliabee anything: in
own-keys mode the calls go to the providers on the user's keys, and the hosted proxy still checks
every account's credits on its side.

In the open edition the hosted service is **off by default**: nothing talks to it, and the sign-in
form is not offered, until the user turns it on with ``IRELIABEE_HOSTED=1``. The app is always
hosted; that is what it is.
"""
import os

#: Set to True by the export, in the open edition's copy of this file only.
OPEN = True

_ON = {"1", "true", "yes", "on"}


def is_open() -> bool:
    return OPEN or os.environ.get("IRELIABEE_EDITION", "").strip().lower() == "open"


def name() -> str:
    return "open" if is_open() else "app"


def hosted_enabled() -> bool:
    """Whether this build may sign in to, and call, the hosted iReliabee service."""
    if not is_open():
        return True
    return os.environ.get("IRELIABEE_HOSTED", "").strip().lower() in _ON
