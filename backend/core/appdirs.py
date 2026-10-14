"""
Per-user config and data directories, with a migration from the pre-rebrand
``interview-coach`` folders to the ``ireliabee`` ones so existing users keep
their sessions, CVs, stories and API keys after the rename.

It runs on every start, not once, and brings names across one at a time —
because for two months it ran and did nothing. The packaged backend created
``~/.config/ireliabee`` for its log before this module was imported, so the
folder existed, held almost nothing, and the real settings stayed in the old
one. Nothing here ever overwrites or deletes.
"""
from __future__ import annotations

import shutil
from pathlib import Path

APP_SLUG = "ireliabee"
_LEGACY_SLUG = "interview-coach"


def _resolve(new: Path, legacy: Path) -> Path:
    """
    Return `new`, bringing anything still under `legacy` across.

    Two cases, and the difference matters because getting it wrong loses
    somebody’s API keys or their sessions:

    * `new` is not there at all — move the whole legacy folder into place.
    * `new` is there already — fill in only the names it does not have, and
      never touch a name it does.

    The second case used to be treated as "already migrated, nothing to do",
    which is why this did nothing at all in the packaged app from v0.4.1: the
    backend created ``~/.config/ireliabee`` to open its log file before this
    module was imported, so the folder always existed. Testing for an *empty*
    folder would not have helped either — by then it held a log, and an
    account file for anyone who signed in after upgrading.

    Nothing is ever overwritten and nothing is ever deleted. A name present in
    both folders keeps the copy in `new` and leaves the legacy one exactly where
    it is, for a person to compare: silently preferring one sessions database
    over another is how you lose someone’s week of notebooks.
    """
    if not legacy.is_dir():
        return new
    if not new.exists():
        new.parent.mkdir(parents=True, exist_ok=True)
        try:
            legacy.rename(new)          # atomic on the same filesystem
        except OSError:
            # Cross-device, or a destination that appeared under us.
            shutil.copytree(legacy, new, dirs_exist_ok=True)
        return new
    try:
        leftovers = sorted(legacy.iterdir())
    except OSError:
        return new                      # unreadable: leave it alone entirely
    for item in leftovers:
        target = new / item.name
        if target.exists():
            continue                    # the newer folder wins, always
        try:
            shutil.move(str(item), str(target))
        except OSError:
            pass                        # in use, or gone: try again next start
    return new


CONFIG_DIR = _resolve(Path.home() / ".config" / APP_SLUG,
                      Path.home() / ".config" / _LEGACY_SLUG)
DATA_DIR = _resolve(Path.home() / ".local" / "share" / APP_SLUG,
                    Path.home() / ".local" / "share" / _LEGACY_SLUG)
