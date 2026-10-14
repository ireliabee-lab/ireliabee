"""
User profile storage — one profile per user, stored in the sessions DB.

A profile is the personal context the LLM needs to give tailored answers:
name, background, target role, key strengths, weaknesses to defuse, and
free-form context. No hardcoded names anywhere in the codebase.
"""
from __future__ import annotations

import sqlite3
from datetime import datetime
from typing import Optional

from .sessions import _connect


def _ensure_schema():
    with _connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS profiles (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                name           TEXT NOT NULL,
                pronouns       TEXT,
                background     TEXT,
                target_role    TEXT,
                strengths      TEXT,
                weaknesses     TEXT,
                extra_context  TEXT,
                is_active      INTEGER NOT NULL DEFAULT 0,
                created_at     TEXT NOT NULL,
                updated_at     TEXT NOT NULL
            );
            """
        )
        # Add profile_id column to sessions (migration for older DBs)
        try:
            conn.execute("ALTER TABLE sessions ADD COLUMN profile_id INTEGER")
        except sqlite3.OperationalError:
            pass
        try:
            conn.execute("ALTER TABLE sessions ADD COLUMN template_id TEXT")
        except sqlite3.OperationalError:
            pass
        try:
            conn.execute("ALTER TABLE profiles ADD COLUMN experience_level TEXT")
        except sqlite3.OperationalError:
            pass
        # The CV this profile speaks from (roadmap 1.6): switching profile switches CV.
        try:
            conn.execute("ALTER TABLE profiles ADD COLUMN cv_id INTEGER")
        except sqlite3.OperationalError:
            pass
        # The fact they dread being asked about — a grade, a gap, a dismissal.
        # Named here so practice can rehearse it instead of the user bracing for it.
        try:
            conn.execute("ALTER TABLE profiles ADD COLUMN hard_question TEXT")
        except sqlite3.OperationalError:
            pass


_ensure_schema()


def create_profile(name: str, **fields) -> int:
    now = datetime.utcnow().isoformat(timespec="seconds")
    cols = ["name", "pronouns", "background", "target_role",
            "strengths", "weaknesses", "extra_context", "experience_level",
            "hard_question", "is_active", "created_at", "updated_at"]
    vals = [
        name,
        fields.get("pronouns", ""),
        fields.get("background", ""),
        fields.get("target_role", ""),
        fields.get("strengths", ""),
        fields.get("weaknesses", ""),
        fields.get("extra_context", ""),
        fields.get("experience_level", ""),
        fields.get("hard_question", ""),
        0,
        now, now,
    ]
    with _connect() as conn:
        cur = conn.execute(
            f"INSERT INTO profiles ({','.join(cols)}) VALUES ({','.join(['?'] * len(cols))})",
            vals,
        )
        pid = cur.lastrowid
    # If no active profile exists, make this the active one
    if get_active_profile() is None:
        set_active_profile(pid)
    return pid


def list_profiles() -> list[sqlite3.Row]:
    with _connect() as conn:
        cur = conn.execute(
            "SELECT * FROM profiles ORDER BY is_active DESC, updated_at DESC"
        )
        return cur.fetchall()


def get_profile(profile_id: int) -> Optional[sqlite3.Row]:
    with _connect() as conn:
        cur = conn.execute("SELECT * FROM profiles WHERE id = ?", (profile_id,))
        return cur.fetchone()


def get_active_profile() -> Optional[sqlite3.Row]:
    with _connect() as conn:
        cur = conn.execute("SELECT * FROM profiles WHERE is_active = 1 LIMIT 1")
        return cur.fetchone()


def set_active_profile(profile_id: int):
    with _connect() as conn:
        conn.execute("UPDATE profiles SET is_active = 0")
        conn.execute("UPDATE profiles SET is_active = 1 WHERE id = ?", (profile_id,))


def update_profile(profile_id: int, **fields):
    if not fields:
        return
    now = datetime.utcnow().isoformat(timespec="seconds")
    set_clause = ", ".join(f"{k} = ?" for k in fields)
    with _connect() as conn:
        conn.execute(
            f"UPDATE profiles SET {set_clause}, updated_at = ? WHERE id = ?",
            [*fields.values(), now, profile_id],
        )


def delete_profile(profile_id: int):
    with _connect() as conn:
        conn.execute("DELETE FROM profiles WHERE id = ?", (profile_id,))
