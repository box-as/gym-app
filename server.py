#!/usr/bin/env python3
"""RepState username/password sync server with per-user private SQLite state."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import threading
import time
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
PUBLIC_DIR = ROOT / "public"
DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
DB_PATH = DATA_DIR / "repstate.sqlite3"
PORT = int(os.environ.get("PORT", "8000"))
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "1") != "0"
COOKIE_NAME = "repstate_session"
SESSION_SECONDS = 30 * 24 * 60 * 60
MAX_BODY_BYTES = 1_500_000
PASSWORD_ITERATIONS = 310_000
PASSWORD_MIN_CHARS = 10
PASSWORD_MAX_CHARS = 256
USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,32}$")

# These optional variables are used only to import the old one-account
# installation. They are no longer required for new installs or signups.
LEGACY_USERNAME = os.environ.get("SYNC_USERNAME", "").strip() or os.environ.get("SYNC_EMAIL", "").strip()
LEGACY_PASSWORD_HASH = os.environ.get("SYNC_PASSWORD_HASH", "").strip()

DATA_DIR.mkdir(parents=True, exist_ok=True)


def connect_db() -> sqlite3.Connection:
    db = sqlite3.connect(DB_PATH, timeout=15)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    db.execute("PRAGMA busy_timeout=15000")
    db.execute("PRAGMA synchronous=FULL")
    return db


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def normalize_username(username: str) -> str:
    return username.strip().casefold()


def decode_legacy_verifier(value: str) -> tuple[bytes, bytes] | None:
    if not value:
        return None
    try:
        encoded = value.encode("ascii")
        decoded = base64.urlsafe_b64decode(encoded + b"=" * (-len(encoded) % 4))
        if len(decoded) != 48:
            raise ValueError("expected 16-byte salt plus 32-byte digest")
        return decoded[:16], decoded[16:]
    except Exception as exc:
        raise SystemExit("SYNC_PASSWORD_HASH must be a base64url PBKDF2 verifier") from exc


def hash_password(password: str, salt: bytes | None = None) -> tuple[bytes, bytes]:
    actual_salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), actual_salt, PASSWORD_ITERATIONS, dklen=32
    )
    return actual_salt, digest


def password_matches(password: str, salt: bytes, expected_digest: bytes) -> bool:
    if len(password) > PASSWORD_MAX_CHARS:
        return False
    candidate = hash_password(password, salt)[1]
    return hmac.compare_digest(candidate, expected_digest)


def table_columns(db: sqlite3.Connection, table: str) -> set[str]:
    return {row["name"] for row in db.execute(f"PRAGMA table_info({table})")}


def table_exists(db: sqlite3.Connection, table: str) -> bool:
    return db.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone() is not None


def ensure_legacy_user(db: sqlite3.Connection) -> int | None:
    """Create the old configured account once, never replacing its saved password."""
    if LEGACY_USERNAME and LEGACY_PASSWORD_HASH:
        verifier = decode_legacy_verifier(LEGACY_PASSWORD_HASH)
        if verifier is None:
            return None
        salt, digest = verifier
        username = LEGACY_USERNAME[:254]
        username_norm = normalize_username(username)
        row = db.execute(
            "SELECT id FROM users WHERE username_norm=?", (username_norm,)
        ).fetchone()
        if row:
            db.execute("UPDATE users SET is_legacy=1 WHERE id=?", (row["id"],))
            return int(row["id"])
        cur = db.execute(
            "INSERT INTO users(username, username_norm, password_salt, password_hash, created_at, is_legacy) "
            "VALUES(?, ?, ?, ?, ?, 1)",
            (username, username_norm, salt, digest, utc_now()),
        )
        return int(cur.lastrowid)

    row = db.execute("SELECT id FROM users WHERE is_legacy=1 ORDER BY id LIMIT 1").fetchone()
    return int(row["id"]) if row else None


def initialize_db() -> None:
    with connect_db() as db:
        db.execute("PRAGMA journal_mode=WAL")
        db.executescript(
            "CREATE TABLE IF NOT EXISTS users ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT,"
            "username TEXT NOT NULL,"
            "username_norm TEXT NOT NULL UNIQUE,"
            "password_salt BLOB NOT NULL,"
            "password_hash BLOB NOT NULL,"
            "created_at TEXT NOT NULL,"
            "is_legacy INTEGER NOT NULL DEFAULT 0);"
            "CREATE TABLE IF NOT EXISTS user_tracker_state ("
            "user_id INTEGER PRIMARY KEY,"
            "payload TEXT NOT NULL,"
            "revision INTEGER NOT NULL,"
            "updated_at TEXT NOT NULL,"
            "FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);"
        )

        # Preserve the old table and records; add a user reference to existing
        # sessions and copy its single tracker row into the new per-user table.
        if not table_exists(db, "sessions"):
            db.execute(
                "CREATE TABLE sessions ("
                "token_hash TEXT PRIMARY KEY,"
                "user_id INTEGER NOT NULL,"
                "expires_at INTEGER NOT NULL,"
                "FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE)"
            )
        elif "user_id" not in table_columns(db, "sessions"):
            db.execute("ALTER TABLE sessions ADD COLUMN user_id INTEGER")

        legacy_user_id = ensure_legacy_user(db)
        if legacy_user_id is not None:
            db.execute(
                "UPDATE sessions SET user_id=? WHERE user_id IS NULL", (legacy_user_id,)
            )

        if table_exists(db, "tracker_state"):
            old_state = db.execute(
                "SELECT payload, revision, updated_at FROM tracker_state WHERE id=1"
            ).fetchone()
            if old_state is not None:
                existing = (
                    db.execute(
                        "SELECT 1 FROM user_tracker_state WHERE user_id=?",
                        (legacy_user_id,),
                    ).fetchone()
                    if legacy_user_id is not None
                    else None
                )
                if not existing:
                    if legacy_user_id is None:
                        raise SystemExit(
                            "Legacy tracker data exists but no legacy account credentials are available; "
                            "refusing to start until the account can be preserved."
                        )
                    db.execute(
                        "INSERT INTO user_tracker_state(user_id, payload, revision, updated_at) "
                        "VALUES(?, ?, ?, ?)",
                        (
                            legacy_user_id,
                            old_state["payload"],
                            old_state["revision"],
                            old_state["updated_at"],
                        ),
                    )

        db.execute("DELETE FROM sessions WHERE expires_at <= ?", (int(time.time()),))


_attempts: dict[tuple[str, str], list[float]] = {}
_attempts_lock = threading.Lock()


def rate_limited(scope: str, key: str, limit: int, window_seconds: int) -> bool:
    now = time.time()
    bucket_key = (scope, key)
    with _attempts_lock:
        recent = [stamp for stamp in _attempts.get(bucket_key, []) if now - stamp < window_seconds]
        limited = len(recent) >= limit
        if not limited:
            recent.append(now)
        _attempts[bucket_key] = recent
        return limited


def cookie_value(handler: "Handler") -> str:
    raw = handler.headers.get("Cookie", "")
    for item in raw.split(";"):
        name, sep, value = item.strip().partition("=")
        if sep and name == COOKIE_NAME:
            return value
    return ""


def token_digest(handler: "Handler") -> str:
    token = cookie_value(handler)
    if not token or len(token) > 256:
        return ""
    return hashlib.sha256(token.encode("ascii", "ignore")).hexdigest()


def session_user(handler: "Handler") -> dict | None:
    digest = token_digest(handler)
    if not digest:
        return None
    with connect_db() as db:
        row = db.execute(
            "SELECT s.user_id, s.expires_at, u.username, u.is_legacy "
            "FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?",
            (digest,),
        ).fetchone()
        if not row:
            return None
        if row["expires_at"] <= int(time.time()):
            db.execute("DELETE FROM sessions WHERE token_hash=?", (digest,))
            return None
        return {
            "id": int(row["user_id"]),
            "username": row["username"],
            "legacy": bool(row["is_legacy"]),
        }


def session_cookie(token: str, max_age: int = SESSION_SECONDS) -> str:
    return (
        f"{COOKIE_NAME}={token}; Path=/; Max-Age={max_age}; HttpOnly; SameSite=Strict"
        + ("; Secure" if COOKIE_SECURE else "")
    )


def create_session(db: sqlite3.Connection, user_id: int) -> tuple[str, str]:
    token = secrets.token_urlsafe(32)
    digest = hashlib.sha256(token.encode("ascii")).hexdigest()
    expires = int(time.time()) + SESSION_SECONDS
    db.execute(
        "INSERT INTO sessions(token_hash, user_id, expires_at) VALUES(?, ?, ?)",
        (digest, user_id, expires),
    )
    return token, digest


class Handler(SimpleHTTPRequestHandler):
    server_version = "RepStateSync/2.0"
    sys_version = ""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC_DIR), **kwargs)

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
            "img-src 'self' data:; font-src 'self' https://fonts.gstatic.com; "
            "connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
        )
        if COOKIE_SECURE:
            self.send_header("Strict-Transport-Security", "max-age=31536000")
        if not urlsplit(self.path).path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt: str, *args) -> None:
        # Do not log request bodies or credentials.
        super().log_message(fmt, *args)

    def json_response(
        self, status: int, payload: dict, extra_headers: dict | None = None
    ) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def read_json(self) -> dict | None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return None
        if length <= 0 or length > MAX_BODY_BYTES:
            return None
        try:
            value = json.loads(self.rfile.read(length))
            return value if isinstance(value, dict) else None
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None

    def same_origin(self) -> bool:
        origin = self.headers.get("Origin")
        if not origin:
            return True
        try:
            parsed = urlsplit(origin)
        except ValueError:
            return False
        host = self.headers.get("Host", "").lower()
        return bool(parsed.netloc.lower() == host and parsed.scheme in ("https", "http"))

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path == "/api/healthz":
            self.json_response(200, {"ok": True})
            return
        if path == "/api/session":
            user = session_user(self)
            self.json_response(
                200,
                {
                    "authenticated": bool(user),
                    "username": user["username"] if user else None,
                    "legacy": user["legacy"] if user else False,
                },
            )
            return
        if path == "/api/state":
            user = session_user(self)
            if not user:
                self.json_response(401, {"error": "unauthorized"})
                return
            with connect_db() as db:
                row = db.execute(
                    "SELECT payload, revision, updated_at FROM user_tracker_state WHERE user_id=?",
                    (user["id"],),
                ).fetchone()
            if row is None:
                self.json_response(200, {"state": None, "revision": 0, "updatedAt": None})
            else:
                self.json_response(
                    200,
                    {
                        "state": json.loads(row["payload"]),
                        "revision": row["revision"],
                        "updatedAt": row["updated_at"],
                    },
                )
            return
        if path.startswith("/api/"):
            self.json_response(404, {"error": "not_found"})
            return
        super().do_GET()

    def authenticate(self, username: str, password: str) -> sqlite3.Row | None:
        username_norm = normalize_username(username)
        with connect_db() as db:
            row = db.execute(
                "SELECT id, username, password_salt, password_hash, is_legacy "
                "FROM users WHERE username_norm=?",
                (username_norm,),
            ).fetchone()
        if row is None:
            # Keep nonexistent-user failures close in cost to password failures.
            hash_password(password[:PASSWORD_MAX_CHARS], b"RepStateLoginSalt")
            return None
        return row if password_matches(password, row["password_salt"], row["password_hash"]) else None

    def do_POST(self) -> None:
        path = urlsplit(self.path).path
        allowed = {"/api/login", "/api/register", "/api/password", "/api/logout"}
        if path not in allowed:
            self.json_response(404, {"error": "not_found"})
            return
        if not self.same_origin():
            self.json_response(403, {"error": "origin_not_allowed"})
            return

        if path in ("/api/login", "/api/register"):
            data = self.read_json()
            username = str((data or {}).get("username", "")).strip()
            password = str((data or {}).get("password", ""))
            client = self.headers.get("X-Real-IP", self.client_address[0])[:128]
            if path == "/api/register":
                if rate_limited("register", client, limit=8, window_seconds=3600):
                    self.json_response(429, {"error": "too_many_attempts"})
                    return
                if not USERNAME_RE.fullmatch(username):
                    self.json_response(400, {"error": "invalid_username"})
                    return
                if not PASSWORD_MIN_CHARS <= len(password) <= PASSWORD_MAX_CHARS:
                    self.json_response(400, {"error": "invalid_password"})
                    return
                username_norm = normalize_username(username)
                with connect_db() as db:
                    db.execute("BEGIN IMMEDIATE")
                    if db.execute(
                        "SELECT 1 FROM users WHERE username_norm=?", (username_norm,)
                    ).fetchone():
                        db.rollback()
                        self.json_response(409, {"error": "username_taken"})
                        return
                    salt, digest = hash_password(password)
                    cur = db.execute(
                        "INSERT INTO users(username, username_norm, password_salt, password_hash, created_at, is_legacy) "
                        "VALUES(?, ?, ?, ?, ?, 0)",
                        (username, username_norm, salt, digest, utc_now()),
                    )
                    user_id = int(cur.lastrowid)
                    token, _ = create_session(db, user_id)
                self.json_response(
                    201,
                    {"ok": True, "username": username, "legacy": False},
                    {"Set-Cookie": session_cookie(token)},
                )
                return

            if rate_limited("login", client, limit=10, window_seconds=300):
                self.json_response(429, {"error": "too_many_attempts"})
                return
            if not username or len(username) > 254 or len(password) > PASSWORD_MAX_CHARS:
                self.json_response(401, {"error": "invalid_credentials"})
                return
            user = self.authenticate(username, password)
            if not user:
                self.json_response(401, {"error": "invalid_credentials"})
                return
            with connect_db() as db:
                token, _ = create_session(db, int(user["id"]))
            self.json_response(
                200,
                {
                    "ok": True,
                    "username": user["username"],
                    "legacy": bool(user["is_legacy"]),
                },
                {"Set-Cookie": session_cookie(token)},
            )
            return

        if path == "/api/password":
            user = session_user(self)
            if not user:
                self.json_response(401, {"error": "unauthorized"})
                return
            data = self.read_json()
            current = str((data or {}).get("currentPassword", ""))
            new_password = str((data or {}).get("newPassword", ""))
            client = self.headers.get("X-Real-IP", self.client_address[0])[:128]
            if rate_limited("password", f"{client}:{user['id']}", limit=8, window_seconds=3600):
                self.json_response(429, {"error": "too_many_attempts"})
                return
            if not PASSWORD_MIN_CHARS <= len(new_password) <= PASSWORD_MAX_CHARS:
                self.json_response(400, {"error": "invalid_password"})
                return
            with connect_db() as db:
                row = db.execute(
                    "SELECT password_salt, password_hash FROM users WHERE id=?", (user["id"],)
                ).fetchone()
                if not row or not password_matches(current, row["password_salt"], row["password_hash"]):
                    self.json_response(401, {"error": "invalid_current_password"})
                    return
                salt, digest = hash_password(new_password)
                db.execute(
                    "UPDATE users SET password_salt=?, password_hash=? WHERE id=?",
                    (salt, digest, user["id"]),
                )
                current_token = token_digest(self)
                db.execute(
                    "DELETE FROM sessions WHERE user_id=? AND token_hash<>?",
                    (user["id"], current_token),
                )
            self.json_response(200, {"ok": True})
            return

        # Logout is idempotent; the browser always receives an expired cookie.
        digest = token_digest(self)
        if digest:
            with connect_db() as db:
                db.execute("DELETE FROM sessions WHERE token_hash=?", (digest,))
        self.json_response(
            200,
            {"ok": True},
            {"Set-Cookie": session_cookie("", max_age=0)},
        )

    def do_PUT(self) -> None:
        if urlsplit(self.path).path != "/api/state":
            self.json_response(404, {"error": "not_found"})
            return
        if not self.same_origin():
            self.json_response(403, {"error": "origin_not_allowed"})
            return
        user = session_user(self)
        if not user:
            self.json_response(401, {"error": "unauthorized"})
            return
        data = self.read_json()
        if not data or not isinstance(data.get("state"), dict):
            self.json_response(400, {"error": "invalid_state"})
            return
        state = data["state"]
        if not isinstance(state.get("settings", {}), dict):
            self.json_response(400, {"error": "invalid_settings"})
            return
        for key in ("logs", "checkins", "sessionDates", "milestones", "syncMeta"):
            if key in state and not isinstance(state[key], dict):
                self.json_response(400, {"error": "invalid_state"})
                return
        try:
            expected = int(data.get("revision", 0))
            payload = json.dumps(state, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
        except (TypeError, ValueError):
            self.json_response(400, {"error": "invalid_state"})
            return
        if len(payload.encode("utf-8")) > MAX_BODY_BYTES:
            self.json_response(413, {"error": "state_too_large"})
            return

        updated_at = utc_now()
        with connect_db() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT payload, revision, updated_at FROM user_tracker_state WHERE user_id=?",
                (user["id"],),
            ).fetchone()
            current_revision = row["revision"] if row else 0
            if expected != current_revision:
                current = json.loads(row["payload"]) if row else None
                db.rollback()
                self.json_response(
                    409,
                    {
                        "error": "conflict",
                        "state": current,
                        "revision": current_revision,
                        "updatedAt": row["updated_at"] if row else None,
                    },
                )
                return
            new_revision = current_revision + 1
            db.execute(
                "INSERT INTO user_tracker_state(user_id, payload, revision, updated_at) "
                "VALUES(?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET "
                "payload=excluded.payload, revision=excluded.revision, updated_at=excluded.updated_at",
                (user["id"], payload, new_revision, updated_at),
            )
        self.json_response(200, {"ok": True, "revision": new_revision, "updatedAt": updated_at})

    def do_OPTIONS(self) -> None:
        self.json_response(405, {"error": "method_not_allowed"})


if __name__ == "__main__":
    if not PUBLIC_DIR.is_dir():
        raise SystemExit(f"Static app directory not found: {PUBLIC_DIR}")
    initialize_db()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    print(f"RepState sync server listening on 0.0.0.0:{PORT}", flush=True)
    server.serve_forever()
