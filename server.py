"""Firebird same-origin application. Run `python server.py --help` for commands.

The public frontend is an allowlist, never this source directory. SQLite needs a
persistent local volume. No passwords, session tokens or mail bodies are logged.
"""
from __future__ import annotations

import argparse
import hashlib
import html
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import time
from datetime import date, datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

from flask import Flask, g, jsonify, request, send_from_directory
from werkzeug.exceptions import HTTPException
from werkzeug.security import check_password_hash, generate_password_hash

ROOT = Path(__file__).resolve().parent
STATIC_FILES = frozenset({
    "index.html", "Firebird.html", "styles.css", "ux.css", "community.css",
    "bento.css", "theme.css", "theme.js", "catalog.js", "matcher.js", "app.js", "ux.js",
    "community-data.js", "community.js", "bento.js", "accounts.css", "accounts.js",
    "assistant.js", "assistant-local.js", "assistant.css", "translations.js", "account-translations.js", "i18n.js", "ai-config.json",
    "guest-store.js", "demo-translations.js",
})
SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
 password_hash TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 0,
 subscribed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY, user_id INTEGER REFERENCES users(id),
 csrf TEXT NOT NULL, expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
 token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
 purpose TEXT NOT NULL, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS tokens_user ON tokens(user_id,purpose);
CREATE TABLE IF NOT EXISTS rate_limits (
 bucket TEXT NOT NULL, stamp INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_bucket ON rate_limits(bucket,stamp);
CREATE TABLE IF NOT EXISTS orders (
 id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
 request_id TEXT NOT NULL, provider_id TEXT NOT NULL, provider_name TEXT NOT NULL,
 provider_city TEXT NOT NULL, event_date TEXT NOT NULL, budget INTEGER NOT NULL,
 wishes TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL,
 UNIQUE(user_id,request_id), CHECK(status IN ('pending','accepted','declined','cancelled'))
);
CREATE UNIQUE INDEX IF NOT EXISTS accepted_slot ON orders(provider_id,event_date)
 WHERE status='accepted';
CREATE TABLE IF NOT EXISTS outbox (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id),
 recipient TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
 available_at INTEGER NOT NULL, lease_until INTEGER NOT NULL DEFAULT 0,
 claim_token TEXT, created_at INTEGER NOT NULL, last_error TEXT
);
CREATE INDEX IF NOT EXISTS outbox_ready ON outbox(status,available_at);
CREATE TABLE IF NOT EXISTS guest_orders (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL,
 request_id TEXT NOT NULL, creator_hash TEXT NOT NULL,
 provider_id TEXT NOT NULL, provider_name TEXT NOT NULL, provider_city TEXT NOT NULL,
 event_date TEXT NOT NULL, budget INTEGER NOT NULL, wishes TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'awaiting_email', created_at INTEGER NOT NULL,
 verified_at INTEGER,
 UNIQUE(creator_hash,request_id),
 CHECK(status IN ('awaiting_email','pending','accepted','declined','cancelled'))
);
CREATE UNIQUE INDEX IF NOT EXISTS guest_accepted_slot ON guest_orders(provider_id,event_date)
 WHERE status='accepted';
CREATE TABLE IF NOT EXISTS guest_owners (
 order_id TEXT NOT NULL REFERENCES guest_orders(id) ON DELETE CASCADE,
 session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
 PRIMARY KEY(order_id,session_hash)
);
CREATE TABLE IF NOT EXISTS guest_tokens (
 token_hash TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES guest_orders(id) ON DELETE CASCADE,
 expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS guest_outbox (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL,
 order_id TEXT NOT NULL REFERENCES guest_orders(id) ON DELETE CASCADE,
 recipient TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
 available_at INTEGER NOT NULL, lease_until INTEGER NOT NULL DEFAULT 0,
 claim_token TEXT, created_at INTEGER NOT NULL, last_error TEXT
);
CREATE INDEX IF NOT EXISTS guest_outbox_ready ON guest_outbox(status,available_at);
CREATE TRIGGER IF NOT EXISTS account_slot_excludes_guests_insert
 BEFORE INSERT ON orders WHEN NEW.status='accepted' AND EXISTS
 (SELECT 1 FROM guest_orders WHERE provider_id=NEW.provider_id AND event_date=NEW.event_date AND status='accepted')
 BEGIN SELECT RAISE(ABORT,'accepted slot occupied'); END;
CREATE TRIGGER IF NOT EXISTS account_slot_excludes_guests_update
 BEFORE UPDATE ON orders WHEN NEW.status='accepted' AND EXISTS
 (SELECT 1 FROM guest_orders WHERE provider_id=NEW.provider_id AND event_date=NEW.event_date AND status='accepted')
 BEGIN SELECT RAISE(ABORT,'accepted slot occupied'); END;
CREATE TRIGGER IF NOT EXISTS guest_slot_excludes_accounts_insert
 BEFORE INSERT ON guest_orders WHEN NEW.status='accepted' AND EXISTS
 (SELECT 1 FROM orders WHERE provider_id=NEW.provider_id AND event_date=NEW.event_date AND status='accepted')
 BEGIN SELECT RAISE(ABORT,'accepted slot occupied'); END;
CREATE TRIGGER IF NOT EXISTS guest_slot_excludes_accounts_update
 BEFORE UPDATE ON guest_orders WHEN NEW.status='accepted' AND EXISTS
 (SELECT 1 FROM orders WHERE provider_id=NEW.provider_id AND event_date=NEW.event_date AND status='accepted')
 BEGIN SELECT RAISE(ABORT,'accepted slot occupied'); END;
CREATE TABLE IF NOT EXISTS inbox (
 id TEXT PRIMARY KEY, recipient TEXT NOT NULL, subject TEXT NOT NULL,
 body TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS catalog_seen (provider_id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);
"""


class APIError(Exception):
    def __init__(self, message, code="invalid_request", status=400):
        self.message, self.code, self.status = message, code, status


def digest(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def now():
    return int(time.time())


class ClosingConnection(sqlite3.Connection):
    """Unlike sqlite's default transaction-only context, also release the handle."""
    def __exit__(self, exc_type, exc_value, traceback):
        try:
            return super().__exit__(exc_type, exc_value, traceback)
        finally:
            self.close()


def connect_db(app):
    connection = sqlite3.connect(app.config["DATABASE"], timeout=15, isolation_level=None, factory=ClosingConnection)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys=ON")
    connection.execute("PRAGMA busy_timeout=15000")
    return connection


def catalog(app):
    raw = Path(app.config["CATALOG_PATH"]).read_text(encoding="utf-8-sig")
    marker = "const data="
    if marker not in raw:
        raise RuntimeError("Unrecognized catalog format")
    data, _ = json.JSONDecoder().raw_decode(raw.split(marker, 1)[1].lstrip())
    if not isinstance(data.get("catalog"), list) or not data.get("calendarThrough"):
        raise RuntimeError("Invalid catalog")
    providers = {str(p["id"]): p for p in data["catalog"]}
    if len(providers) != len(data["catalog"]):
        raise RuntimeError("Duplicate provider IDs")
    date.fromisoformat(data["calendarThrough"])
    return data, providers


def public_user(row):
    if row is None:
        return None
    return {"id": row["id"], "name": row["name"], "email": row["email"],
            "verified": bool(row["verified"]), "subscribed": bool(row["subscribed"])}


def public_order(row):
    return {"id": row["id"], "providerId": row["provider_id"],
            "providerName": row["provider_name"], "date": row["event_date"],
            "budget": row["budget"], "wishes": row["wishes"], "status": row["status"],
            "createdAt": datetime.fromtimestamp(row["created_at"], timezone.utc).isoformat()}


def json_http(url, body, headers=None):
    req = Request(url, data=json.dumps(body).encode(), method="POST", headers={
        "Content-Type": "application/json", "User-Agent": "Firebird/1.0", **(headers or {})})
    with urlopen(req, timeout=12) as response:
        return json.loads(response.read(1024 * 1024).decode())


def enqueue(db, user, subject, body, kind="transactional"):
    ident = str(uuid4())
    db.execute("INSERT INTO outbox(id,kind,user_id,recipient,subject,body,available_at,created_at) "
               "VALUES (?,?,?,?,?,?,?,?)", (ident, kind, user["id"], user["email"], subject, body, now(), now()))
    return ident


def enqueue_guest(db, order, subject, body, kind="transactional"):
    ident = str(uuid4())
    db.execute("INSERT INTO guest_outbox(id,kind,order_id,recipient,subject,body,available_at,created_at) "
               "VALUES (?,?,?,?,?,?,?,?)", (ident, kind, order["id"], order["email"], subject, body, now(), now()))
    return ident


def occupied_slot(db, provider_id, event_date):
    return bool(db.execute(
        "SELECT 1 FROM orders WHERE provider_id=? AND event_date=? AND status='accepted' "
        "UNION ALL SELECT 1 FROM guest_orders WHERE provider_id=? AND event_date=? AND status='accepted' LIMIT 1",
        (provider_id, event_date, provider_id, event_date)).fetchone())


def available_provider(app, db, provider_id, event_date):
    catalog_data, providers = catalog(app)
    provider = providers.get(provider_id)
    if not provider:
        raise APIError("Подрядчик не найден.", "provider_not_found", 404)
    try:
        parsed_date = date.fromisoformat(event_date)
        if parsed_date.isoformat() != event_date:
            raise ValueError()
    except (ValueError, TypeError):
        raise APIError("Проверьте дату и идентификатор заявки.")
    today = date.fromisoformat(app.config["TODAY"]) if app.config["TODAY"] else datetime.now(ZoneInfo(app.config["TIMEZONE"])).date()
    first = max(today, date.fromisoformat(catalog_data.get("calendarFrom", today.isoformat())))
    if parsed_date < first or parsed_date > date.fromisoformat(catalog_data["calendarThrough"]):
        raise APIError("Дата вне доступного периода каталога.", "date_out_of_range")
    if event_date in provider.get("busy_dates", []) or occupied_slot(db, provider_id, event_date):
        raise APIError("Подрядчик занят на выбранную дату.", "date_unavailable", 409)
    return provider


def issue_token(db, user_id, purpose, seconds):
    token = secrets.token_urlsafe(32)
    # A newer verification/reset message invalidates older links, not unsubscribe links.
    if purpose in {"verify", "reset"}:
        db.execute("UPDATE tokens SET used=1 WHERE user_id=? AND purpose=?", (user_id, purpose))
    db.execute("INSERT INTO tokens(token_hash,user_id,purpose,expires) VALUES (?,?,?,?)",
               (digest(token), user_id, purpose, now() + seconds))
    return token


def token_user(db, token, purpose):
    if not isinstance(token, str) or not 32 <= len(token) <= 128:
        raise APIError("Ссылка недействительна или устарела.", "invalid_token")
    row = db.execute("SELECT * FROM tokens WHERE token_hash=? AND purpose=? AND used=0 AND expires>?",
                     (digest(token), purpose, now())).fetchone()
    if not row:
        raise APIError("Ссылка недействительна или устарела.", "invalid_token")
    return row["user_id"]


def create_app(config=None):
    app = Flask(__name__, static_folder=None)
    app.config.from_mapping(
        DEVELOPMENT=os.environ.get("FIREBIRD_DEV") == "1",
        DATABASE=os.environ.get("FIREBIRD_DATABASE", str(ROOT / "instance" / "firebird.sqlite3")),
        PUBLIC_URL=os.environ.get("FIREBIRD_PUBLIC_URL", "http://127.0.0.1:4173"),
        CATALOG_PATH=str(ROOT / "catalog.js"), STATIC_ROOT=str(ROOT),
        TURNSTILE_SITE_KEY=os.environ.get("TURNSTILE_SITE_KEY", ""),
        TURNSTILE_SECRET_KEY=os.environ.get("TURNSTILE_SECRET_KEY", ""),
        TURNSTILE_HOSTNAME=os.environ.get("TURNSTILE_HOSTNAME", ""),
        RESEND_API_KEY=os.environ.get("RESEND_API_KEY", ""),
        MAIL_FROM=os.environ.get("FIREBIRD_MAIL_FROM", ""),
        TRUSTED_PROXY=os.environ.get("FIREBIRD_TRUSTED_PROXY", ""),
        MAX_CONTENT_LENGTH=16384, SESSION_TTL=60 * 60 * 24 * 7,
        TIMEZONE=os.environ.get("FIREBIRD_TIMEZONE", "Asia/Almaty"),
        TESTING=False, TODAY=None, CAPTCHA_VERIFY=None, MAIL_SEND=None,
    )
    if config:
        app.config.update(config)
    origin = urlsplit(app.config["PUBLIC_URL"])
    if origin.path not in {"", "/"} or origin.query or origin.fragment or origin.username or not origin.hostname:
        raise RuntimeError("PUBLIC_URL must be a bare, absolute origin")
    app.config["PUBLIC_URL"] = f"{origin.scheme}://{origin.netloc}"
    if app.config["DEVELOPMENT"]:
        if origin.hostname not in {"localhost", "127.0.0.1", "::1"} or origin.scheme != "http":
            raise RuntimeError("Development mode requires an HTTP loopback origin")
    else:
        missing = [k for k in ("TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY", "RESEND_API_KEY", "MAIL_FROM")
                   if not app.config[k]]
        if origin.scheme != "https" or missing:
            raise RuntimeError("Production requires HTTPS PUBLIC_URL, Turnstile keys, RESEND_API_KEY and MAIL_FROM")
    if (app.config["CAPTCHA_VERIFY"] or app.config["MAIL_SEND"] or app.config["TODAY"]) and not app.config["TESTING"]:
        raise RuntimeError("Test overrides are forbidden outside TESTING")
    if not Path(app.config["DATABASE"]).is_absolute():
        raise RuntimeError("DATABASE must be an absolute persistent filesystem path")
    if app.config["TRUSTED_PROXY"]:
        # Exactly one known proxy; wildcard trust would let callers spoof rate-limit IPs.
        ipaddress.ip_address(app.config["TRUSTED_PROXY"])
    app.config["TURNSTILE_HOSTNAME"] = app.config["TURNSTILE_HOSTNAME"] or origin.hostname
    app.config["TRUSTED_HOSTS"] = [origin.hostname]
    app.config["COOKIE_NAME"] = "firebird_dev" if app.config["DEVELOPMENT"] else "__Host-firebird"
    ZoneInfo(app.config["TIMEZONE"])
    Path(app.config["DATABASE"]).parent.mkdir(parents=True, exist_ok=True)
    with connect_db(app) as db:
        db.execute("PRAGMA journal_mode=WAL")
        db.executescript(SCHEMA)
    catalog(app)
    dummy_password = generate_password_hash(secrets.token_urlsafe(32), method="scrypt")

    def db():
        if "db" not in g:
            g.db = connect_db(app)
        return g.db

    @app.teardown_appcontext
    def close_db(_error):
        connection = g.pop("db", None)
        if connection:
            if connection.in_transaction:
                connection.rollback()
            connection.close()

    def session(create=False):
        if "session" not in g:
            token = request.cookies.get(app.config["COOKIE_NAME"], "")
            g.session = db().execute("SELECT * FROM sessions WHERE token_hash=? AND expires>?",
                                     (digest(token), now())).fetchone() if len(token) <= 128 else None
        if g.session is None and create:
            rotate_session(None)
        return g.session

    def rotate_session(user_id):
        previous = session(False)
        token = secrets.token_urlsafe(32)
        owns_guest = previous and db().execute("SELECT 1 FROM guest_owners WHERE session_hash=? LIMIT 1", (previous["token_hash"],)).fetchone()
        ttl = app.config["SESSION_TTL"] if user_id is not None or owns_guest else min(app.config["SESSION_TTL"], 7200)
        db().execute("INSERT INTO sessions(token_hash,user_id,csrf,expires) VALUES (?,?,?,?)",
                     (digest(token), user_id, secrets.token_urlsafe(32), now() + ttl))
        if previous:
            # Rotate credentials without losing the browser's independent guest requests.
            db().execute("INSERT OR IGNORE INTO guest_owners(order_id,session_hash) "
                         "SELECT order_id,? FROM guest_owners WHERE session_hash=?", (digest(token), previous["token_hash"]))
            db().execute("DELETE FROM sessions WHERE token_hash=?", (previous["token_hash"],))
        g.cookie = token
        g.session = db().execute("SELECT * FROM sessions WHERE token_hash=?", (digest(token),)).fetchone()
        return g.session

    def user(required=True, verified=False):
        current = session(False)
        row = db().execute("SELECT * FROM users WHERE id=?", (current["user_id"],)).fetchone() if current else None
        if required and row is None:
            raise APIError("Сначала войдите в аккаунт.", "authentication_required", 401)
        if verified and not row["verified"]:
            raise APIError("Подтвердите адрес электронной почты.", "email_unverified", 403)
        return row

    def data():
        result = request.get_json(silent=True)
        if not isinstance(result, dict):
            raise APIError("Ожидается JSON-объект.")
        return result

    def string(payload, key, minimum=1, maximum=100, trim=True):
        value = payload.get(key)
        if not isinstance(value, str):
            raise APIError(f"Заполните поле {key}.")
        value = value.strip() if trim else value
        if not minimum <= len(value) <= maximum or any(ord(c) < 32 and c not in "\n\t" for c in value):
            raise APIError(f"Проверьте поле {key}.")
        return value

    def email_address(payload):
        value = string(payload, "email", 3, 254).casefold()
        if not re.fullmatch(r"[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}", value):
            raise APIError("Введите корректный email.")
        return value

    def password(payload):
        return string(payload, "password", 12, 128, trim=False)

    def throttle(action, email=None, limit=8, window=900):
        buckets = [(f"{action}:ip:{request.remote_addr}", limit * 3)]
        if email:
            buckets.append((f"{action}:identity:{email}", limit))
        connection = db()
        connection.execute("BEGIN IMMEDIATE")
        try:
            connection.execute("DELETE FROM rate_limits WHERE stamp<?", (now() - 86400,))
            for key, maximum in buckets:
                key = digest(key)
                count = connection.execute("SELECT count(*) FROM rate_limits WHERE bucket=? AND stamp>?",
                                           (key, now() - window)).fetchone()[0]
                if count >= maximum:
                    raise APIError("Слишком много попыток. Повторите позже.", "rate_limited", 429)
                connection.execute("INSERT INTO rate_limits(bucket,stamp) VALUES (?,?)", (key, now()))
            connection.commit()
        except Exception:
            connection.rollback()
            raise

    def captcha(payload, action):
        if app.config["DEVELOPMENT"]:
            return
        token = payload.get("captchaToken")
        if not isinstance(token, str) or not 1 <= len(token) <= 2048:
            raise APIError("Пройдите проверку на бота.", "captcha_required")
        try:
            if app.config["TESTING"] and app.config["CAPTCHA_VERIFY"]:
                valid = app.config["CAPTCHA_VERIFY"](token, action)
            else:
                result = json_http("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
                    "secret": app.config["TURNSTILE_SECRET_KEY"], "response": token,
                    "idempotency_key": str(uuid4()),
                })
                valid = (result.get("success") is True and result.get("action") == action
                         and result.get("hostname") == app.config["TURNSTILE_HOSTNAME"])
        except (OSError, ValueError, HTTPError, URLError):
            raise APIError("Проверка на бота временно недоступна. Повторите позже.", "captcha_unavailable", 503)
        if not valid:
            raise APIError("Проверка на бота не пройдена. Повторите её.", "captcha_failed")

    def send_token(row, purpose):
        connection = db()
        token = issue_token(connection, row["id"], purpose, 86400 if purpose == "verify" else 1800)
        connection.execute("UPDATE outbox SET status='skipped',body='' WHERE user_id=? AND kind=? AND status='pending'",
                           (row["id"], "auth_" + purpose))
        verb = "Подтвердите email" if purpose == "verify" else "Сброс пароля"
        duration = "24 часа" if purpose == "verify" else "30 минут"
        link = app.config["PUBLIC_URL"] + "/?" + purpose + "=" + token
        enqueue(connection, row, "Firebird — " + verb,
                f"{verb}: {link}\n\nСсылка действует {duration} и используется один раз. "
                "Если вы не отправляли запрос, просто проигнорируйте это письмо.", "auth_" + purpose)

    @app.before_request
    def security_checks():
        # In development even alternate launchers must not expose the no-CAPTCHA mode remotely.
        if app.config["DEVELOPMENT"] and request.remote_addr not in {"127.0.0.1", "::1"}:
            raise APIError("Development mode is loopback-only.", "loopback_only", 403)
        if request.method not in {"GET", "HEAD", "OPTIONS"}:
            if request.headers.get("Origin") != app.config["PUBLIC_URL"]:
                raise APIError("Недопустимый источник запроса.", "origin_rejected", 403)
            current = session(False)
            provided = request.headers.get("X-CSRF-Token", "")
            if request.path == "/unsubscribe":
                provided = request.form.get("csrf", "")
            if not current or not secrets.compare_digest(provided, current["csrf"]):
                raise APIError("Сессия формы устарела. Обновите страницу.", "csrf_failed", 403)

    @app.after_request
    def headers(response):
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; "
            "style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; "
            "connect-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; "
            "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
        )
        if not app.config["DEVELOPMENT"]:
            response.headers["Strict-Transport-Security"] = "max-age=31536000"
        if request.path.startswith("/api/") or request.path in {"/unsubscribe", "/", "/index.html", "/Firebird.html"}:
            response.headers["Cache-Control"] = "no-store"
        if "cookie" in g:
            response.set_cookie(app.config["COOKIE_NAME"], g.cookie, secure=not app.config["DEVELOPMENT"],
                                httponly=True, samesite="Lax", path="/", max_age=app.config["SESSION_TTL"])
        return response

    @app.errorhandler(APIError)
    def handle_api_error(error):
        response = jsonify(error=error.message, code=error.code)
        if error.status == 429:
            response.headers["Retry-After"] = "900"
        return response, error.status

    @app.errorhandler(HTTPException)
    def handle_http_error(error):
        return jsonify(error="Запрос не может быть обработан.", code=f"http_{error.code}"), error.code

    @app.errorhandler(Exception)
    def handle_unexpected(error):
        # Do not log exception/request text: external responses can contain secrets.
        app.logger.error("Request failed (%s)", type(error).__name__)
        return jsonify(error="Временная ошибка сервера.", code="server_error"), 500

    @app.get("/healthz")
    def health():
        db().execute("SELECT 1")
        return jsonify(ok=True)

    @app.get("/api/config")
    def api_config():
        return jsonify(available=True, guestOrders=True, development=app.config["DEVELOPMENT"],
                       captchaSiteKey="" if app.config["DEVELOPMENT"] else app.config["TURNSTILE_SITE_KEY"],
                       captchaRequired=not app.config["DEVELOPMENT"], mailReady=not app.config["DEVELOPMENT"])

    @app.get("/api/session")
    def api_session():
        if session(False) is None:
            throttle("session", limit=100, window=900)
        current = session(True)
        return jsonify(user=public_user(user(False)), csrfToken=current["csrf"])

    @app.post("/api/auth/register")
    def register():
        payload = data()
        name = string(payload, "name", 2, 80)
        email = email_address(payload)
        secret = password(payload)
        throttle("register", email, limit=3, window=3600)
        captcha(payload, "register")
        encoded = generate_password_hash(secret, method="scrypt")
        connection = db()
        connection.execute("BEGIN IMMEDIATE")
        if not connection.execute("SELECT 1 FROM users WHERE email=?", (email,)).fetchone():
            ident = connection.execute("INSERT INTO users(name,email,password_hash,created_at) VALUES (?,?,?,?)",
                                       (name, email, encoded, now())).lastrowid
            send_token(connection.execute("SELECT * FROM users WHERE id=?", (ident,)).fetchone(), "verify")
        connection.commit()
        return jsonify(message="Если адрес ещё не зарегистрирован, письмо для подтверждения поставлено в очередь. Проверьте почту."), 202

    @app.post("/api/auth/login")
    def login():
        payload = data()
        email = email_address(payload)
        secret = string(payload, "password", 1, 128, trim=False)
        throttle("login", email)
        captcha(payload, "login")
        row = db().execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
        valid = check_password_hash(row["password_hash"] if row else dummy_password, secret)
        if not row or not valid:
            raise APIError("Неверный email или пароль.", "invalid_credentials", 401)
        current = rotate_session(row["id"])
        return jsonify(user=public_user(row), csrfToken=current["csrf"])

    @app.post("/api/auth/logout")
    def logout():
        current = rotate_session(None)
        return jsonify(message="Вы вышли из аккаунта.", user=None, csrfToken=current["csrf"])

    @app.post("/api/auth/forgot")
    def forgot():
        payload = data()
        email = email_address(payload)
        throttle("forgot", email, limit=3, window=3600)
        captcha(payload, "forgot")
        connection = db()
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
        if row:
            send_token(row, "reset")
        connection.commit()
        return jsonify(message="Если аккаунт существует, письмо для сброса пароля поставлено в очередь."), 202

    @app.post("/api/auth/reset")
    def reset():
        payload = data()
        secret = password(payload)
        throttle("reset", limit=5)
        captcha(payload, "reset")
        encoded = generate_password_hash(secret, method="scrypt")
        connection = db()
        connection.execute("BEGIN IMMEDIATE")
        ident = token_user(connection, payload.get("token"), "reset")
        connection.execute("UPDATE users SET password_hash=? WHERE id=?", (encoded, ident))
        connection.execute("UPDATE tokens SET used=1 WHERE user_id=? AND purpose='reset'", (ident,))
        connection.execute("DELETE FROM sessions WHERE user_id=?", (ident,))
        connection.commit()
        g.session = None
        current = rotate_session(None)
        return jsonify(message="Пароль изменён. Войдите заново.", user=None, csrfToken=current["csrf"])

    @app.post("/api/auth/verify")
    def verify():
        payload = data()
        throttle("verify", limit=10)
        connection = db()
        connection.execute("BEGIN IMMEDIATE")
        ident = token_user(connection, payload.get("token"), "verify")
        connection.execute("UPDATE users SET verified=1 WHERE id=?", (ident,))
        connection.execute("UPDATE tokens SET used=1 WHERE user_id=? AND purpose='verify'", (ident,))
        connection.commit()
        return jsonify(message="Email подтверждён. Теперь доступны заявки и подписка.", user=public_user(user(False)))

    @app.post("/api/auth/resend")
    def resend():
        row = user()
        payload = data()
        throttle("resend", row["email"], limit=3, window=3600)
        captcha(payload, "resend")
        if not row["verified"]:
            db().execute("BEGIN IMMEDIATE")
            send_token(row, "verify")
            db().commit()
        return jsonify(message="Письмо подтверждения поставлено в очередь, если email ещё не подтверждён."), 202

    @app.post("/api/subscription")
    def subscription():
        row = user(verified=True)
        payload = data()
        if type(payload.get("enabled")) is not bool:
            raise APIError("Укажите состояние подписки.")
        db().execute("UPDATE users SET subscribed=? WHERE id=?", (int(payload["enabled"]), row["id"]))
        return jsonify(user=public_user(db().execute("SELECT * FROM users WHERE id=?", (row["id"],)).fetchone()))

    @app.get("/api/orders")
    def list_orders():
        row = user()
        orders = db().execute("SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC,id DESC", (row["id"],)).fetchall()
        return jsonify(orders=[public_order(order) for order in orders])

    @app.post("/api/orders")
    def create_order():
        row = user(verified=True)
        payload = data()
        provider_id = string(payload, "providerId", 1, 80)
        event_date = string(payload, "date", 10, 10)
        wishes = string(payload, "wishes", 0, 2000) if "wishes" in payload else ""
        budget = payload.get("budget")
        if type(budget) is not int or not 1 <= budget <= 1_000_000_000:
            raise APIError("Бюджет должен быть целым числом от 1 до 1 000 000 000 ₸.")
        request_id = payload.get("requestId")
        try:
            if not isinstance(request_id, str) or str(UUID(request_id)) != request_id.lower():
                raise ValueError()
            parsed_date = date.fromisoformat(event_date)
            if parsed_date.isoformat() != event_date:
                raise ValueError()
        except (ValueError, AttributeError):
            raise APIError("Проверьте дату и идентификатор заявки.")
        catalog_data, providers = catalog(app)
        provider = providers.get(provider_id)
        if not provider:
            raise APIError("Подрядчик не найден.", "provider_not_found", 404)
        today = date.fromisoformat(app.config["TODAY"]) if app.config["TODAY"] else datetime.now(ZoneInfo(app.config["TIMEZONE"])).date()
        first = max(today, date.fromisoformat(catalog_data.get("calendarFrom", today.isoformat())))
        if parsed_date < first or parsed_date > date.fromisoformat(catalog_data["calendarThrough"]):
            raise APIError("Дата вне доступного периода каталога.", "date_out_of_range")
        throttle("orders", str(row["id"]), limit=10, window=3600)
        connection = db()
        existing = connection.execute("SELECT * FROM orders WHERE user_id=? AND request_id=?", (row["id"], request_id)).fetchone()
        if existing:
            if (existing["provider_id"], existing["event_date"], existing["budget"], existing["wishes"]) != (provider_id, event_date, budget, wishes):
                raise APIError("Этот идентификатор уже использован для другой заявки.", "idempotency_conflict", 409)
            return jsonify(order=public_order(existing))
        captcha(payload, "order")
        connection.execute("BEGIN IMMEDIATE")
        # Recheck after acquiring the write lock, including concurrent retries.
        existing = connection.execute("SELECT * FROM orders WHERE user_id=? AND request_id=?", (row["id"], request_id)).fetchone()
        if existing:
            connection.rollback()
            if (existing["provider_id"], existing["event_date"], existing["budget"], existing["wishes"]) != (provider_id, event_date, budget, wishes):
                raise APIError("Этот идентификатор уже использован.", "idempotency_conflict", 409)
            return jsonify(order=public_order(existing))
        if event_date in provider.get("busy_dates", []) or occupied_slot(connection, provider_id, event_date):
            raise APIError("Подрядчик занят на выбранную дату.", "date_unavailable", 409)
        ident = str(uuid4())
        connection.execute("INSERT INTO orders(id,user_id,request_id,provider_id,provider_name,provider_city,event_date,budget,wishes,created_at) "
                           "VALUES (?,?,?,?,?,?,?,?,?,?)", (ident, row["id"], request_id, provider_id,
                            str(provider["anon_name"]), str(provider.get("city", "")), event_date, budget, wishes, now()))
        enqueue(connection, row, "Firebird — заявка сохранена",
                f"Заявка {ident}\nПодрядчик: {provider['anon_name']}\nДата: {event_date}\nПредварительный бюджет: {budget} ₸\n"
                "Это запрос, а не подтверждённая бронь. Каталог содержит анонимизированные/демонстрационные профили; "
                "контактов для автоматической отправки подрядчикам нет. Статус доступен в личном кабинете.")
        result = connection.execute("SELECT * FROM orders WHERE id=?", (ident,)).fetchone()
        connection.commit()
        return jsonify(order=public_order(result)), 201

    @app.post("/api/orders/<ident>/cancel")
    def cancel_order(ident):
        row = user()
        connection = db()
        connection.execute("BEGIN IMMEDIATE")
        order = connection.execute("SELECT * FROM orders WHERE id=? AND user_id=?", (ident, row["id"])).fetchone()
        if not order:
            raise APIError("Заявка не найдена.", "order_not_found", 404)
        if order["status"] in {"accepted", "declined"}:
            raise APIError("Статус уже изменён оператором; обратитесь к владельцу сайта.", "order_locked", 409)
        connection.execute("UPDATE orders SET status='cancelled' WHERE id=?", (ident,))
        result = connection.execute("SELECT * FROM orders WHERE id=?", (ident,)).fetchone()
        connection.commit()
        return jsonify(order=public_order(result))

    def owned_guest(ident):
        current = session(False)
        order = db().execute("SELECT o.* FROM guest_orders o JOIN guest_owners a ON a.order_id=o.id "
                             "WHERE o.id=? AND a.session_hash=?", (ident, current["token_hash"])).fetchone() if current else None
        if not order:
            raise APIError("Заявка не найдена.", "order_not_found", 404)
        return order

    @app.get("/api/guest-orders")
    def list_guest_orders():
        current = session(False)
        rows = db().execute("SELECT o.* FROM guest_orders o JOIN guest_owners a ON a.order_id=o.id "
                            "WHERE a.session_hash=? ORDER BY o.created_at DESC,o.id DESC LIMIT 100",
                            (current["token_hash"],)).fetchall() if current else []
        return jsonify(orders=[public_order(row) for row in rows])

    @app.post("/api/guest-orders")
    def create_guest_order():
        payload = data()
        permitted = {"name", "email", "providerId", "date", "budget", "wishes", "requestId", "captchaToken"}
        if set(payload) - permitted:
            raise APIError("Неизвестное поле заявки.")
        name = string(payload, "name", 2, 80)
        email = email_address(payload)
        provider_id = string(payload, "providerId", 1, 80)
        event_date = string(payload, "date", 10, 10)
        wishes = string(payload, "wishes", 0, 2000) if "wishes" in payload else ""
        budget = payload.get("budget")
        if type(budget) is not int or not 1 <= budget <= 1_000_000_000:
            raise APIError("Бюджет должен быть целым числом от 1 до 1 000 000 000 ₸.")
        request_id = payload.get("requestId")
        try:
            if not isinstance(request_id, str) or str(UUID(request_id)) != request_id.lower():
                raise ValueError()
            request_id = request_id.lower()
            if date.fromisoformat(event_date).isoformat() != event_date:
                raise ValueError()
        except (ValueError, AttributeError):
            raise APIError("Проверьте дату и идентификатор заявки.")
        current = session(False)  # POST security checks have already required a session.
        throttle("guest_orders", email, limit=5, window=3600)
        connection = db()

        def existing_order():
            existing = connection.execute("SELECT o.* FROM guest_orders o JOIN guest_owners a ON a.order_id=o.id "
                                          "WHERE o.request_id=? AND a.session_hash=?", (request_id, current["token_hash"])).fetchone()
            if existing and (existing["name"], existing["email"], existing["provider_id"], existing["event_date"],
                             existing["budget"], existing["wishes"]) != (name, email, provider_id, event_date, budget, wishes):
                raise APIError("Этот идентификатор уже использован для другой заявки.", "idempotency_conflict", 409)
            return existing

        existing = existing_order()
        if existing:
            return jsonify(order=public_order(existing))
        captcha(payload, "guest_order")
        connection.execute("BEGIN IMMEDIATE")
        existing = existing_order()
        if existing:
            connection.rollback()
            return jsonify(order=public_order(existing))
        provider = available_provider(app, connection, provider_id, event_date)
        ident = str(uuid4())
        connection.execute("INSERT INTO guest_orders(id,name,email,request_id,creator_hash,provider_id,provider_name,"
                           "provider_city,event_date,budget,wishes,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                           (ident, name, email, request_id, current["token_hash"], provider_id, str(provider["anon_name"]),
                            str(provider.get("city", "")), event_date, budget, wishes, now()))
        connection.execute("INSERT INTO guest_owners(order_id,session_hash) VALUES (?,?)", (ident, current["token_hash"]))
        connection.execute("UPDATE sessions SET expires=? WHERE token_hash=?", (now() + app.config["SESSION_TTL"], current["token_hash"]))
        token = secrets.token_urlsafe(32)
        connection.execute("INSERT INTO guest_tokens(token_hash,order_id,expires) VALUES (?,?,?)", (digest(token), ident, now() + 86400))
        result = connection.execute("SELECT * FROM guest_orders WHERE id=?", (ident,)).fetchone()
        enqueue_guest(connection, result, "Firebird — подтвердите заявку без регистрации",
                      f"Подтвердите ваш email для заявки {ident}: {app.config['PUBLIC_URL']}/?guest={token}\n\n"
                      f"Подрядчик: {provider['anon_name']}\nДата: {event_date}\nПредварительный бюджет: {budget} ₸\n\n"
                      "Ссылка действует 24 часа. Откройте её и нажмите кнопку подтверждения. "
                      "До подтверждения заявка не передаётся в работу и не бронирует дату. "
                      "Аккаунт не создаётся. Если вы не отправляли заявку, проигнорируйте письмо.", "guest_verify")
        connection.commit()
        return jsonify(order=public_order(result)), 201

    @app.post("/api/guest-orders/verify")
    def verify_guest_order():
        payload = data()
        token = payload.get("token")
        if set(payload) != {"token"} or not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", token):
            raise APIError("Ссылка недействительна или устарела.", "invalid_token")
        throttle("guest_verify", limit=10)
        connection = db()
        connection.execute("BEGIN IMMEDIATE")
        link = connection.execute("SELECT * FROM guest_tokens WHERE token_hash=? AND expires>?", (digest(token), now())).fetchone()
        if not link:
            raise APIError("Ссылка недействительна или устарела.", "invalid_token")
        order = connection.execute("SELECT * FROM guest_orders WHERE id=?", (link["order_id"],)).fetchone()
        current = session(False)
        owner = connection.execute("SELECT 1 FROM guest_owners WHERE order_id=? AND session_hash=?",
                                   (order["id"], current["token_hash"])).fetchone()
        if link["used"]:
            # A retry after a lost HTTP response is safe only in the confirming browser.
            if not owner or not order["verified_at"]:
                raise APIError("Ссылка недействительна или устарела.", "invalid_token")
            connection.rollback()
            return jsonify(order=public_order(order))
        if order["status"] != "awaiting_email":
            raise APIError("Заявка уже закрыта.", "order_locked", 409)
        available_provider(app, connection, order["provider_id"], order["event_date"])
        connection.execute("UPDATE guest_orders SET status='pending',verified_at=? WHERE id=?", (now(), order["id"]))
        connection.execute("UPDATE guest_tokens SET used=1 WHERE token_hash=?", (digest(token),))
        connection.execute("INSERT OR IGNORE INTO guest_owners(order_id,session_hash) VALUES (?,?)", (order["id"], current["token_hash"]))
        connection.execute("UPDATE sessions SET expires=? WHERE token_hash=?", (now() + app.config["SESSION_TTL"], current["token_hash"]))
        enqueue_guest(connection, order, "Firebird — заявка сохранена",
                      f"Заявка {order['id']} подтверждена и ожидает рассмотрения оператором.\n"
                      f"Подрядчик: {order['provider_name']}\nДата: {order['event_date']}\nБюджет: {order['budget']} ₸\n\n"
                      "Это запрос, а не подтверждённая бронь. Текущий каталог анонимизирован/демонстрационный; "
                      "автоматической отправки подрядчикам нет. Статус доступен в этом браузере на сайте. "
                      "При обращении к оператору укажите номер заявки.")
        result = connection.execute("SELECT * FROM guest_orders WHERE id=?", (order["id"],)).fetchone()
        connection.commit()
        return jsonify(order=public_order(result))

    @app.post("/api/guest-orders/<ident>/cancel")
    def cancel_guest_order(ident):
        connection = db()
        connection.execute("BEGIN IMMEDIATE")
        order = owned_guest(ident)
        if order["status"] in {"accepted", "declined"}:
            raise APIError("Статус уже изменён оператором; обратитесь к владельцу сайта.", "order_locked", 409)
        if order["status"] != "cancelled":
            connection.execute("UPDATE guest_orders SET status='cancelled' WHERE id=?", (ident,))
            connection.execute("UPDATE guest_tokens SET used=1 WHERE order_id=?", (ident,))
            connection.execute("UPDATE guest_outbox SET status='skipped',body='' WHERE order_id=? AND kind='guest_verify' AND status='pending'", (ident,))
            if order["verified_at"]:
                enqueue_guest(connection, order, "Firebird — заявка отменена", f"Заявка {ident} отменена по вашему запросу.")
        result = connection.execute("SELECT * FROM guest_orders WHERE id=?", (ident,)).fetchone()
        connection.commit()
        return jsonify(order=public_order(result))

    @app.route("/unsubscribe", methods=["GET", "POST"])
    def unsubscribe():
        token = request.args.get("token") if request.method == "GET" else request.form.get("token")
        connection = db()
        if request.method == "GET":
            token_user(connection, token, "unsubscribe")
            current = session(True)
            # GET is only a confirmation page: mail scanners cannot unsubscribe a user.
            return ("<!doctype html><html lang='ru'><meta charset='utf-8'><meta name='viewport' content='width=device-width'>"
                    "<title>Firebird — подписка</title><link rel='stylesheet' href='/styles.css'><main>"
                    "<h1>Отписаться от новых подрядчиков?</h1><p>Письма о заявках и безопасности останутся доступны.</p>"
                    "<form method='post' action='/unsubscribe'><input type='hidden' name='token' value='" + html.escape(token, quote=True) +
                    "'><input type='hidden' name='csrf' value='" + html.escape(current["csrf"], quote=True) +
                    "'><button type='submit'>Подтвердить отписку</button></form><p><a href='/'>Вернуться на сайт</a></p></main></html>")
        connection.execute("BEGIN IMMEDIATE")
        ident = token_user(connection, token, "unsubscribe")
        connection.execute("UPDATE users SET subscribed=0 WHERE id=?", (ident,))
        connection.execute("UPDATE tokens SET used=1 WHERE user_id=? AND purpose='unsubscribe'", (ident,))
        connection.commit()
        return "<!doctype html><html lang='ru'><meta charset='utf-8'><title>Firebird</title><h1>Вы отписались</h1><a href='/'>Вернуться на сайт</a></html>"

    @app.get("/")
    def home():
        return send_from_directory(app.config["STATIC_ROOT"], "index.html")

    @app.get("/<path:filename>")
    def asset(filename):
        if filename not in STATIC_FILES:
            raise APIError("Файл не найден.", "not_found", 404)
        return send_from_directory(app.config["STATIC_ROOT"], filename)

    return app


def scan_catalog(app):
    """Atomic baseline/event recording; previously seen IDs never notify twice."""
    _, providers = catalog(app)
    with connect_db(app) as db:
        db.execute("BEGIN IMMEDIATE")
        old = {r[0] for r in db.execute("SELECT provider_id FROM catalog_seen")}
        initialized = db.execute("SELECT 1 FROM metadata WHERE key='catalog_initialized'").fetchone()
        new_ids = sorted(set(providers) - old)
        db.executemany("INSERT OR IGNORE INTO catalog_seen(provider_id) VALUES (?)", [(key,) for key in providers])
        if not initialized:
            db.execute("INSERT INTO metadata(key,value) VALUES ('catalog_initialized','1')")
        elif new_ids:
            for recipient in db.execute("SELECT * FROM users WHERE verified=1 AND subscribed=1").fetchall():
                token = issue_token(db, recipient["id"], "unsubscribe", 86400 * 365)
                names = "\n".join(f"• {providers[key]['anon_name']} — {providers[key].get('city', '')}" for key in new_ids)
                body = ("В каталоге появились новые подрядчики:\n" + names + "\n\nОткрыть каталог: " + app.config["PUBLIC_URL"] +
                        "/\nПрофили текущего каталога анонимизированы/демонстрационные.\n\nОтписаться: " +
                        app.config["PUBLIC_URL"] + "/unsubscribe?token=" + token)
                enqueue(db, recipient, "Firebird — новые подрядчики", body, "broadcast")
        db.commit()
    return len(new_ids) if initialized else 0


def send_mail(app, message):
    if app.config["TESTING"] and app.config["MAIL_SEND"]:
        app.config["MAIL_SEND"](dict(message), message["id"])
        return
    if app.config["DEVELOPMENT"]:
        with connect_db(app) as db:
            db.execute("INSERT OR IGNORE INTO inbox(id,recipient,subject,body,created_at) VALUES (?,?,?,?,?)",
                       (message["id"], message["recipient"], message["subject"], message["body"], now()))
        return
    json_http("https://api.resend.com/emails", {
        "from": app.config["MAIL_FROM"], "to": [message["recipient"]],
        "subject": message["subject"], "text": message["body"],
    }, {"Authorization": "Bearer " + app.config["RESEND_API_KEY"], "Idempotency-Key": message["id"]})


def run_worker_once(app, batch_size=30):
    """Lease queue items atomically. Resend deduplicates crash-retries for 24h.

    Stop retrying at 23h (or 7 attempts), never cross provider idempotency expiry.
    Delivery is best-effort, not an assertion that the recipient opened a message.
    """
    added = scan_catalog(app)
    sent = failed = skipped = 0
    for _ in range(batch_size):
        claim = secrets.token_urlsafe(24)
        with connect_db(app) as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("UPDATE outbox SET status='dead',body='',last_error='retry_window_expired' "
                       "WHERE status IN ('pending','processing') AND created_at<?", (now() - 23 * 3600,))
            message = db.execute("SELECT * FROM outbox WHERE attempts<7 AND "
                                 "((status='pending' AND available_at<=?) OR (status='processing' AND lease_until<?)) "
                                 "ORDER BY created_at,id LIMIT 1", (now(), now())).fetchone()
            if not message:
                db.commit()
                break
            owner = db.execute("SELECT verified,subscribed FROM users WHERE id=?", (message["user_id"],)).fetchone()
            if message["kind"] == "broadcast" and (not owner or not owner["verified"] or not owner["subscribed"]):
                db.execute("UPDATE outbox SET status='skipped',body='' WHERE id=?", (message["id"],))
                db.commit()
                skipped += 1
                continue
            db.execute("UPDATE outbox SET status='processing',claim_token=?,lease_until=?,attempts=attempts+1 WHERE id=?",
                       (claim, now() + 180, message["id"]))
            db.commit()
        try:
            send_mail(app, message)
        except (OSError, ValueError, HTTPError, URLError, RuntimeError):
            attempts = message["attempts"] + 1
            with connect_db(app) as db:
                db.execute("UPDATE outbox SET status=?,available_at=?,lease_until=0,claim_token=NULL,last_error='delivery_failed', "
                           "body=CASE WHEN ? THEN '' ELSE body END "
                           "WHERE id=? AND claim_token=?", ("dead" if attempts >= 7 else "pending",
                            now() + min(30 * (2 ** attempts), 3600), attempts >= 7, message["id"], claim))
            failed += 1
        else:
            with connect_db(app) as db:
                db.execute("UPDATE outbox SET status='sent',body='',lease_until=0,claim_token=NULL,last_error=NULL "
                           "WHERE id=? AND claim_token=?", (message["id"], claim))
            sent += 1
    with connect_db(app) as db:
        db.execute("DELETE FROM sessions WHERE expires<?", (now(),))
        db.execute("DELETE FROM tokens WHERE expires<?", (now() - 86400,))
        db.execute("DELETE FROM inbox WHERE created_at<?", (now() - 7 * 86400,))
        db.execute("DELETE FROM outbox WHERE status IN ('sent','dead','skipped') AND created_at<?", (now() - 30 * 86400,))
    guest = run_guest_worker_once(app, batch_size)
    sent += guest["sent"]
    failed += guest["failed"]
    skipped += guest["skipped"]
    return {"newProviders": added, "sent": sent, "failed": failed, "skipped": skipped}


def run_guest_worker_once(app, batch_size=30):
    """Guests share the durable delivery rules, without creating any user row."""
    sent = failed = skipped = 0
    with connect_db(app) as db:
        db.execute("BEGIN IMMEDIATE")
        db.execute("UPDATE guest_orders SET status='cancelled' WHERE status='awaiting_email' AND created_at<=?", (now() - 86400,))
        db.execute("UPDATE guest_outbox SET status='dead',body='',last_error='retry_window_expired' "
                   "WHERE status IN ('pending','processing') AND created_at<?", (now() - 23 * 3600,))
        db.commit()
    for _ in range(batch_size):
        claim = secrets.token_urlsafe(24)
        with connect_db(app) as db:
            db.execute("BEGIN IMMEDIATE")
            message = db.execute("SELECT * FROM guest_outbox WHERE attempts<7 AND "
                                 "((status='pending' AND available_at<=?) OR (status='processing' AND lease_until<?)) "
                                 "ORDER BY created_at,id LIMIT 1", (now(), now())).fetchone()
            if not message:
                db.commit()
                break
            owner = db.execute("SELECT status,verified_at FROM guest_orders WHERE id=?", (message["order_id"],)).fetchone()
            if not owner or (message["kind"] == "guest_verify" and owner["status"] != "awaiting_email"):
                db.execute("UPDATE guest_outbox SET status='skipped',body='' WHERE id=?", (message["id"],))
                db.commit()
                skipped += 1
                continue
            db.execute("UPDATE guest_outbox SET status='processing',claim_token=?,lease_until=?,attempts=attempts+1 WHERE id=?",
                       (claim, now() + 180, message["id"]))
            db.commit()
        try:
            send_mail(app, message)
        except (OSError, ValueError, HTTPError, URLError, RuntimeError):
            attempts = message["attempts"] + 1
            with connect_db(app) as db:
                db.execute("UPDATE guest_outbox SET status=?,available_at=?,lease_until=0,claim_token=NULL,last_error='delivery_failed', "
                           "body=CASE WHEN ? THEN '' ELSE body END WHERE id=? AND claim_token=?",
                           ("dead" if attempts >= 7 else "pending", now() + min(30 * (2 ** attempts), 3600),
                            attempts >= 7, message["id"], claim))
            failed += 1
        else:
            with connect_db(app) as db:
                db.execute("UPDATE guest_outbox SET status='sent',body='',lease_until=0,claim_token=NULL,last_error=NULL "
                           "WHERE id=? AND claim_token=?", (message["id"], claim))
            sent += 1
    with connect_db(app) as db:
        db.execute("DELETE FROM guest_tokens WHERE expires<?", (now() - 86400,))
        db.execute("DELETE FROM guest_outbox WHERE status IN ('sent','dead','skipped') AND created_at<?", (now() - 30 * 86400,))
    return {"sent": sent, "failed": failed, "skipped": skipped}


def update_order_status(app, ident, status):
    """Local operator-only workflow; no public role elevation endpoint."""
    if status not in {"accepted", "declined", "cancelled"}:
        raise ValueError("Operator status must be accepted, declined or cancelled")
    with connect_db(app) as db:
        db.execute("BEGIN IMMEDIATE")
        order = db.execute("SELECT * FROM orders WHERE id=?", (ident,)).fetchone()
        table = "orders"
        if not order:
            order = db.execute("SELECT * FROM guest_orders WHERE id=?", (ident,)).fetchone()
            table = "guest_orders"
        allowed_prior = {"pending", "accepted"} if status == "cancelled" else {"pending"}
        if table == "guest_orders" and status == "cancelled":
            allowed_prior.add("awaiting_email")
        if not order or order["status"] not in allowed_prior:
            raise ValueError("This order cannot transition to the requested status")
        if status == "accepted":
            try:
                available_provider(app, db, order["provider_id"], order["event_date"])
            except APIError as error:
                raise ValueError("Provider/date no longer available") from error
        db.execute(f"UPDATE {table} SET status=? WHERE id=?", (status, ident))
        label = {"accepted": "принята оператором", "declined": "отклонена оператором",
                 "cancelled": "отменена оператором"}[status]
        body = (f"Заявка {ident} {label}.\nДата: {order['event_date']}.\n"
                "Проверьте условия напрямую с оператором; оплата через этот сайт не производится.")
        if table == "guest_orders":
            if order["verified_at"]:
                enqueue_guest(db, order, "Firebird — статус заявки", body)
            if status == "cancelled":
                db.execute("UPDATE guest_tokens SET used=1 WHERE order_id=?", (ident,))
                db.execute("UPDATE guest_outbox SET status='skipped',body='' WHERE order_id=? AND kind='guest_verify' AND status='pending'", (ident,))
        else:
            owner = db.execute("SELECT * FROM users WHERE id=?", (order["user_id"],)).fetchone()
            enqueue(db, owner, "Firebird — статус заявки", body)
        db.commit()


def main():
    parser = argparse.ArgumentParser(description="Firebird server and local operator commands")
    parser.add_argument("command", choices=["serve", "worker", "inbox", "orders", "order-status"], nargs="?", default="serve")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--id")
    parser.add_argument("--status", choices=["accepted", "declined", "cancelled"])
    args = parser.parse_args()
    app = create_app()
    if args.command == "serve":
        from waitress import serve
        # Development intentionally cannot listen on a public interface.
        host = "127.0.0.1" if app.config["DEVELOPMENT"] else os.environ.get("FIREBIRD_BIND", "127.0.0.1")
        port = int(os.environ.get("PORT", "4173"))
        print("Firebird running (local development: mail stays in local inbox; CAPTCHA OFF)" if app.config["DEVELOPMENT"] else "Firebird running (production)")
        proxy_options = {}
        if app.config["TRUSTED_PROXY"] and not app.config["DEVELOPMENT"]:
            proxy_options = {"trusted_proxy": app.config["TRUSTED_PROXY"], "trusted_proxy_count": 1,
                             "trusted_proxy_headers": {"x-forwarded-for", "x-forwarded-proto"}}
        serve(app, host=host, port=port, threads=4, max_request_body_size=16384,
              clear_untrusted_proxy_headers=True, **proxy_options)
    elif args.command == "worker":
        while True:
            print(json.dumps(run_worker_once(app)))
            if args.once:
                break
            time.sleep(10)
    elif args.command == "inbox":
        if not app.config["DEVELOPMENT"]:
            raise SystemExit("Inbox inspection is only available with FIREBIRD_DEV=1")
        with connect_db(app) as db:
            for row in db.execute("SELECT * FROM inbox ORDER BY created_at DESC LIMIT 20"):
                print(json.dumps(dict(row), ensure_ascii=False))
    elif args.command == "orders":
        with connect_db(app) as db:
            for row in db.execute("SELECT orders.id,provider_id,provider_name,event_date,budget,wishes,status,orders.created_at,"
                                  "users.name AS customer_name,users.email AS customer_email,'account' AS source "
                                  "FROM orders JOIN users ON users.id=orders.user_id UNION ALL "
                                  "SELECT id,provider_id,provider_name,event_date,budget,wishes,status,created_at,name,email,'guest' "
                                  "FROM guest_orders ORDER BY created_at DESC LIMIT 100"):
                print(json.dumps({**public_order(row), "customerName": row["customer_name"],
                                  "customerEmail": row["customer_email"], "source": row["source"]}, ensure_ascii=False))
    elif args.command == "order-status":
        if not args.id or not args.status:
            parser.error("order-status requires --id and --status")
        update_order_status(app, args.id, args.status)
        print("Order updated")


if __name__ == "__main__":
    main()

