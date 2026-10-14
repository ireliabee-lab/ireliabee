/**
 * Which build this is: the iReliabee app, or its open-source edition (backend/edition.py is the
 * backend's half). The export (scripts/export_open_edition.py) flips both constants in the copy it
 * publishes, and nowhere else.
 */

/** The open-source edition: the user's own keys, every feature, no account needed. */
export const OPEN_EDITION = true;

/**
 * Whether the app checks a release feed and offers updates. The open edition does not: it has no
 * feed of ours to follow. A fork that publishes its own sets this, and the updater's endpoint and
 * public key in src-tauri/tauri.conf.json.
 */
export const AUTO_UPDATE = false;
