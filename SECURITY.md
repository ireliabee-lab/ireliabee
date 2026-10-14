# Security

Please do not report security problems in public issues. Email **support@ireliabee.co.uk**
with what you found and how to reproduce it, and we will reply within a few working days.

Things that are working as intended:

- The local backend refuses requests without the app's per-launch token, from a non-loopback
  `Host`, or from a foreign `Origin` (`backend/core/local_guard.py`). A `401` from its port in a
  browser is that lock.
- Provider keys are stored in plain text in `~/.config/ireliabee/.env`, readable by your user
  account only where the filesystem allows. Anyone with access to your account can read them.
