"""Shared test setup: one temp DB, and a way to run as a licensed user.

Imported first by every test module so that, however the modules are combined
in one `unittest` run, they all share the same database and every
`_ensure_column()` (run at feature-module import) lands on it.
"""
import tempfile
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

from backend.core import sessions as sess

_TMP = tempfile.TemporaryDirectory()
sess.DB_DIR = Path(_TMP.name)
sess.DB_PATH = sess.DB_DIR / "sessions.db"

# Never the developer's own sign-in: a test that reads the real account.json
# passes or fails depending on who is signed in on the machine running it.
# Signed out unless a test says otherwise.
from backend.core import account as _account  # noqa: E402
_account.ACCOUNT_PATH = Path(_TMP.name) / "account.json"

# Nor the developer's own provider keys: load_env() reads ~/.config/ireliabee/.env
# into the environment, so a machine with a search key configured ran different
# code from one without it (and test_people's "only with a key" test failed on
# the machine that had one). Tests that want a key set it themselves.
import os  # noqa: E402
from backend.core import config as _config  # noqa: E402
_config.ENV_PATH = Path(_TMP.name) / ".env"                 # never exists: load_env() does nothing
_config.CONFIG_PATH = Path(_TMP.name) / "config.json"
for _key in ("TAVILY_API_KEY", "BRAVE_SEARCH_API_KEY", *(k for k in list(os.environ) if k.endswith("_API_KEY"))):
    os.environ.pop(_key, None)

# Nor any other file in the developer's own config and data folders. Every one
# of these is computed from the real home folder when its module is imported,
# so patching config.CONFIG_PATH alone was not enough: the relay tests wrote a
# test port and pairing key into the real ~/.config/ireliabee/relay.json, which
# is how the Claude Code bridge finds the installed app — and on 13 Oct it then
# pointed at a port nothing listened on. test_env_paths.py checks every
# module-level path built this way, so a new one cannot slip past this list.
_HOME = Path(_TMP.name)
from backend.core import appdirs as _appdirs  # noqa: E402
_appdirs.CONFIG_DIR = _HOME
_appdirs.DATA_DIR = _HOME
_account.CONFIG_DIR = _HOME
_config.CONFIG_DIR = _HOME

from backend.core import licence as _licence  # noqa: E402
_licence.CONFIG_DIR = _HOME
_licence.LICENCE_PATH = _HOME / "licence.json"

from backend.core import screen_capture as _screen_capture  # noqa: E402
_screen_capture.DATA_DIR = _HOME
_screen_capture.CAPTURE_DIR = _HOME / "screens"

from backend import screen_capture_xp as _screen_capture_xp  # noqa: E402
_screen_capture_xp.DATA_DIR = _HOME
_screen_capture_xp.CAPTURE_DIR = _HOME / "screens"

from backend import relay as _relay  # noqa: E402
_relay.CONFIG_DIR = _HOME
_relay.RELAY_INFO_PATH = _HOME / "relay.json"

from backend import relay_bridge as _relay_bridge  # noqa: E402
_relay_bridge.RELAY_CONFIG_PATH = _HOME / "relay.json"

from backend import assistant_runner as _assistant_runner  # noqa: E402
_assistant_runner.CONFIG_DIR = _HOME
_assistant_runner.RUN_DIR = _HOME / "assistant"

from backend import dictionary as _dictionary  # noqa: E402
_dictionary.DATA_DIR = _HOME
_dictionary.DB_PATH = _HOME / "dictionary.db"


@contextmanager
def pro():
    """
    Run the block as a user with a Pro licence.

    For tests of a paid feature that are not about licensing itself: they want
    the feature, not the gate. The gates and the signature checking are covered
    properly in `test_licence.py`.
    """
    from backend.core import licence
    with mock.patch.object(licence, "is_pro", return_value=True):
        yield
