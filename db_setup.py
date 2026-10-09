"""
TLLH-WA Database Setup
Run once: python db_setup.py
Creates tllh_data.db with all required tables and default config.
"""

import sqlite3
import os
import json
from pathlib import Path

DB_PATH = os.getenv("DB_PATH", "./tllh_data.db")


def setup():
    print("[DB SETUP] Initializing tllh_data.db ...")
    con = sqlite3.connect(DB_PATH)
    cur = con.cursor()

    # ------------------------------------------------------------------ #
    # messages – all incoming/outgoing messages
    # ------------------------------------------------------------------ #
    cur.execute("""
        CREATE TABLE IF NOT EXISTS messages (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            msg_id      TEXT    NOT NULL UNIQUE,
            chat_jid    TEXT    NOT NULL,
            sender_jid  TEXT    NOT NULL,
            sender_name TEXT,
            msg_type    TEXT    NOT NULL DEFAULT 'text',
            content     TEXT,
            media_path  TEXT,
            timestamp   INTEGER NOT NULL,
            is_from_me  INTEGER NOT NULL DEFAULT 0,
            raw_json    TEXT,
            created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_msg_chat_ts ON messages (chat_jid, timestamp DESC)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_msg_ts ON messages (timestamp DESC)")

    # ------------------------------------------------------------------ #
    # deleted_msgs – anti-delete vault
    # ------------------------------------------------------------------ #
    cur.execute("""
        CREATE TABLE IF NOT EXISTS deleted_msgs (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            orig_msg_id     TEXT    NOT NULL,
            chat_jid        TEXT    NOT NULL,
            sender_jid      TEXT    NOT NULL,
            sender_name     TEXT,
            deleted_by_jid  TEXT,
            deleted_by_name TEXT,
            msg_type        TEXT,
            content         TEXT,
            media_path      TEXT,
            original_ts     INTEGER,
            deleted_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
            raw_json        TEXT
        )
    """)

    # ------------------------------------------------------------------ #
    # view_once_media – intercepted view-once files
    # ------------------------------------------------------------------ #
    cur.execute("""
        CREATE TABLE IF NOT EXISTS view_once_media (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            msg_id      TEXT    NOT NULL UNIQUE,
            chat_jid    TEXT    NOT NULL,
            sender_jid  TEXT    NOT NULL,
            sender_name TEXT,
            media_type  TEXT    NOT NULL,
            file_path   TEXT    NOT NULL,
            file_size   INTEGER,
            timestamp   INTEGER NOT NULL,
            created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        )
    """)

    # ------------------------------------------------------------------ #
    # permissions – per-room access control
    # ------------------------------------------------------------------ #
    cur.execute("""
        CREATE TABLE IF NOT EXISTS permissions (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_jid    TEXT    NOT NULL UNIQUE,
            chat_name   TEXT,
            is_active   INTEGER NOT NULL DEFAULT 1,
            added_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
            stopped_at  INTEGER
        )
    """)

    # ------------------------------------------------------------------ #
    # settings – global key/value config store
    # ------------------------------------------------------------------ #
    cur.execute("""
        CREATE TABLE IF NOT EXISTS settings (
            key         TEXT PRIMARY KEY,
            value       TEXT NOT NULL,
            updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        )
    """)

    # Default settings
    defaults = {
        "global_lock": "true",        # locked by default until .unlock
        "hidden_chats": "[]",         # JSON list of hidden JIDs
        "self_jid": "",               # populated on first connect
        "bot_name": "TLLH Agent",
    }
    for k, v in defaults.items():
        cur.execute("""
            INSERT INTO settings (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO NOTHING
        """, (k, v))

    # ------------------------------------------------------------------ #
    # contacts – cached contact metadata & profile pic paths
    # ------------------------------------------------------------------ #
    cur.execute("""
        CREATE TABLE IF NOT EXISTS contacts (
            jid         TEXT PRIMARY KEY,
            name        TEXT,
            push_name   TEXT,
            pp_path     TEXT,
            is_group    INTEGER NOT NULL DEFAULT 0,
            last_seen   INTEGER,
            updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        )
    """)

    con.commit()
    con.close()

    # Ensure directory structure exists
    for d in [
        "./arsiv/tek_seferlik",
        "./cache/pp",
        "./static",
        "./templates",
    ]:
        Path(d).mkdir(parents=True, exist_ok=True)

    print("[DB SETUP] Done. All tables created, directories ready.")


if __name__ == "__main__":
    setup()