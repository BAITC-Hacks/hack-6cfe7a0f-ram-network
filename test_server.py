"""Offline API/security regressions. Run: python -m unittest -v test_server.py.

Every test owns a temporary SQLite database and catalog. Test mail never leaves
the process, and production CAPTCHA tests use explicit TESTING-only callbacks.
"""

from __future__ import annotations

import copy
import json
import re
import tempfile
import time
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from server import STATIC_FILES, connect_db, create_app, run_worker_once, scan_catalog, update_order_status


PASSWORD = "Correct horse! Battery 831"
CATALOG = {
    "catalog": [
        {
            "id": "provider-a",
            "anon_name": "Первый подрядчик",
            "categories": ["Фотограф"],
            "city": "Алматы",
            "price_from_kzt": 100000,
            "busy_dates": ["2026-10-10"],
            "event_formats": ["свадьба"],
            "languages": ["русский"],
            "max_hours": 8,
            "description": "Проверяемый каталог для теста.",
            "synthetic": False,
        }
    ],
    "calendarFrom": "2026-09-23",
    "calendarThrough": "2026-12-31",
    "cities": ["Алматы"],
    "categories": ["Фотограф"],
    "formats": ["свадьба"],
    "languages": ["русский"],
}


class ServerTestCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="firebird-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.catalog_path = self.root / "catalog.js"
        self.catalog = copy.deepcopy(CATALOG)
        self.write_catalog()
        self.mail = []
        self.settings = {
            "TESTING": True,
            "DEVELOPMENT": True,
            "DATABASE": str(self.root / "test.sqlite3"),
            "PUBLIC_URL": "http://localhost",
            "CATALOG_PATH": str(self.catalog_path),
            "TODAY": "2026-09-23",
            "MAIL_SEND": self.capture_mail,
        }
        self.app = create_app(self.settings)
        self.client = self.app.test_client()
        self.origin = "http://localhost"

    def write_catalog(self):
        self.catalog_path.write_text(
            "(function(root){const data="
            + json.dumps(self.catalog, ensure_ascii=False)
            + ";root.FirebirdData=data;})(this);",
            encoding="utf-8",
        )

    def capture_mail(self, message, key):
        self.mail.append((dict(message), key))

    def sql(self, statement, parameters=()):
        db = connect_db(self.app)
        try:
            cursor = db.execute(statement, parameters)
            result = [dict(row) for row in cursor.fetchall()]
            db.commit()
            return result
        finally:
            db.close()

    def session(self, client=None):
        response = (client or self.client).get("/api/session", base_url=self.origin)
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertTrue(response.json.get("csrfToken"))
        return response.json

    def post(self, path, body=None, client=None, **kwargs):
        client = client or self.client
        headers = {
            "Origin": self.origin,
            "X-CSRF-Token": self.session(client)["csrfToken"],
        }
        headers.update(kwargs.pop("headers", {}))
        return client.post(
            path, json=body or {}, headers=headers, base_url=self.origin, **kwargs
        )

    def register(self, email="one@example.test", client=None, **fields):
        payload = {
            "name": "Анна Тестовая",
            "email": email,
            "password": PASSWORD,
            "captchaToken": "development-test",
        }
        payload.update(fields)
        return self.post("/api/auth/register", payload, client)

    def token(self, email="one@example.test", purpose="verify"):
        rows = self.sql("SELECT body FROM outbox WHERE recipient=? ORDER BY rowid DESC", (email,))
        for row in rows:
            match = re.search(r"[?&]" + purpose + r"=([A-Za-z0-9_-]+)", row["body"])
            if match:
                return match.group(1)
        self.fail(f"No {purpose} token found for test account {email}")

    def verify(self, email="one@example.test", client=None):
        return self.post("/api/auth/verify", {"token": self.token(email)}, client)

    def login(self, email="one@example.test", client=None, password=PASSWORD):
        return self.post(
            "/api/auth/login",
            {"email": email, "password": password, "captchaToken": "development-test"},
            client,
        )

    def account(self, email="one@example.test", client=None):
        response = self.register(email, client)
        self.assertIn(response.status_code, (200, 201, 202), response.get_data(as_text=True))
        response = self.verify(email, client)
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        response = self.login(email, client)
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        return response.json

    def order_payload(self, **changes):
        payload = {
            "providerId": "provider-a",
            "date": "2026-10-11",
            "budget": 150000,
            "wishes": "Съёмка вечером, без вспышки. <script>alert(1)</script>",
            "captchaToken": "development-test",
            "requestId": str(uuid.uuid4()),
        }
        payload.update(changes)
        return payload

    def create_order(self, client=None, **changes):
        response = self.post("/api/orders", self.order_payload(**changes), client)
        self.assertIn(response.status_code, (200, 201), response.get_data(as_text=True))
        self.assertIn("order", response.json)
        return response.json["order"]

    def test_anonymous_session_and_public_config_never_expose_secrets(self):
        self.assertIsNone(self.session()["user"])
        response = self.client.get("/api/config", base_url=self.origin)
        self.assertEqual(response.status_code, 200)
        for secret in ("password_hash", "TURNSTILE_SECRET_KEY", "RESEND_API_KEY", "DATABASE"):
            self.assertNotIn(secret, response.get_data(as_text=True))
        self.assertNotIn(str(self.root), response.get_data(as_text=True))

    def test_registration_verification_login_and_logout(self):
        self.account()
        session = self.session()
        self.assertEqual(session["user"]["email"], "one@example.test")
        self.assertNotIn("password_hash", json.dumps(session))
        self.assertEqual(self.post("/api/auth/logout").status_code, 200)
        self.assertIsNone(self.session()["user"])

    def test_password_is_hashed_not_stored_plaintext(self):
        self.account()
        users = self.sql("SELECT * FROM users")
        self.assertEqual(len(users), 1)
        self.assertNotEqual(users[0]["password_hash"], PASSWORD)
        self.assertNotIn(PASSWORD, json.dumps(users))

    def test_registration_does_not_authenticate_or_verify_user(self):
        self.assertIn(self.register().status_code, (200, 201, 202))
        self.assertIsNone(self.session()["user"])
        self.assertEqual(self.login().status_code, 200)
        self.assertFalse(self.session()["user"]["verified"])
        self.assertEqual(self.post("/api/orders", self.order_payload()).status_code, 403)
        self.assertEqual(self.post("/api/subscription", {"enabled": True}).status_code, 403)

    def test_registration_rejects_invalid_identity_and_short_password(self):
        for fields in ({"email": "invalid"}, {"password": "short"}, {"name": ""}):
            with self.subTest(fields=fields):
                self.assertEqual(self.register(**fields).status_code, 400)
        self.assertEqual(self.sql("SELECT COUNT(*) AS n FROM users")[0]["n"], 0)

    def test_verification_tokens_are_single_use(self):
        self.register()
        raw = self.token()
        self.assertEqual(self.post("/api/auth/verify", {"token": raw}).status_code, 200)
        self.assertNotEqual(self.post("/api/auth/verify", {"token": raw}).status_code, 200)
        token_rows = self.sql("SELECT * FROM tokens")
        self.assertNotIn(raw, json.dumps(token_rows))

    def test_expired_verification_token_cannot_verify(self):
        self.register()
        raw = self.token()
        self.sql("UPDATE tokens SET expires=0 WHERE purpose='verify'")
        self.assertEqual(self.post("/api/auth/verify", {"token": raw}).status_code, 400)
        self.assertEqual(self.sql("SELECT verified FROM users")[0]["verified"], 0)

    def test_resend_invalidates_older_verification_link(self):
        self.register()
        older = self.token()
        self.assertEqual(self.login().status_code, 200)
        self.assertEqual(self.post("/api/auth/resend", {"captchaToken": "development-test"}).status_code, 202)
        newer = self.token()
        self.assertNotEqual(older, newer)
        self.assertEqual(self.post("/api/auth/verify", {"token": older}).status_code, 400)
        self.assertEqual(self.post("/api/auth/verify", {"token": newer}).status_code, 200)
        messages = self.sql("SELECT status,body FROM outbox WHERE kind='auth_verify' ORDER BY rowid")
        self.assertEqual(messages[0], {"status": "skipped", "body": ""})
        self.assertEqual(messages[1]["status"], "pending")

    def test_reset_does_not_accept_verification_token(self):
        self.register()
        response = self.post(
            "/api/auth/reset",
            {"token": self.token(), "password": PASSWORD + "new", "captchaToken": "development-test"},
        )
        self.assertNotEqual(response.status_code, 200)

    def test_password_reset_revokes_every_active_session(self):
        self.account()
        second = self.app.test_client()
        self.assertEqual(self.login(client=second).status_code, 200)
        forgot = self.post("/api/auth/forgot", {"email": "one@example.test", "captchaToken": "development-test"})
        self.assertIn(forgot.status_code, (200, 202))
        raw = self.token(purpose="reset")
        new_password = PASSWORD + " new"
        response = self.post("/api/auth/reset", {"token": raw, "password": new_password, "captchaToken": "development-test"})
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertIsNone(self.session()["user"])
        self.assertIsNone(self.session(second)["user"])
        self.assertEqual(self.login().status_code, 401)
        self.assertEqual(self.login(password=new_password).status_code, 200)
        self.assertNotEqual(self.post("/api/auth/reset", {"token": raw, "password": PASSWORD, "captchaToken": "development-test"}).status_code, 200)

    def test_forgot_password_response_does_not_enumerate_accounts(self):
        self.account()
        known = self.post("/api/auth/forgot", {"email": "one@example.test", "captchaToken": "development-test"})
        unknown = self.post("/api/auth/forgot", {"email": "nobody@example.test", "captchaToken": "development-test"})
        self.assertEqual(known.status_code, unknown.status_code)
        self.assertEqual(known.json, unknown.json)

    def test_mutation_requires_csrf(self):
        self.session()
        for headers in ({"Origin": self.origin}, {"Origin": self.origin, "X-CSRF-Token": "wrong"}):
            with self.subTest(headers=headers):
                response = self.client.post("/api/auth/logout", json={}, headers=headers, base_url=self.origin)
                self.assertEqual(response.status_code, 403)

    def test_mutation_rejects_foreign_origin_even_with_valid_csrf(self):
        self.assertEqual(self.post("/api/auth/logout", headers={"Origin": "https://attacker.invalid"}).status_code, 403)

    def test_csrf_from_a_different_session_is_rejected(self):
        attacker = self.app.test_client()
        other_csrf = self.session(attacker)["csrfToken"]
        self.assertEqual(self.post("/api/auth/logout", headers={"X-CSRF-Token": other_csrf}).status_code, 403)

    def test_login_rotates_session_csrf(self):
        self.register()
        self.verify()
        old_csrf = self.session()["csrfToken"]
        self.assertEqual(self.login().status_code, 200)
        self.assertNotEqual(self.session()["csrfToken"], old_csrf)
        self.assertEqual(self.post("/api/auth/logout", headers={"X-CSRF-Token": old_csrf}).status_code, 403)

    def test_logout_revokes_replayed_session_cookie(self):
        self.account()
        cookie_name = self.app.config["COOKIE_NAME"]
        stolen = self.client.get_cookie(cookie_name).value
        self.assertEqual(self.post("/api/auth/logout").status_code, 200)
        replay = self.app.test_client()
        replay.set_cookie(cookie_name, stolen)
        self.assertIsNone(self.session(replay)["user"])

    def test_expired_session_loses_authentication(self):
        self.account()
        self.sql("UPDATE sessions SET expires=0")
        self.assertIsNone(self.session()["user"])

    def test_bruteforce_login_is_rate_limited(self):
        codes = []
        for _ in range(9):
            codes.append(self.login(email="unknown@example.test", password="wrong").status_code)
        self.assertEqual(codes[:8], [401] * 8)
        self.assertEqual(codes[-1], 429)

    def test_no_cors_permissions_are_granted_to_unknown_sites(self):
        response = self.client.get("/api/session", headers={"Origin": "https://attacker.invalid"}, base_url=self.origin)
        self.assertIsNone(response.headers.get("Access-Control-Allow-Origin"))

    def test_order_create_list_cancel(self):
        self.account()
        order = self.create_order()
        listing = self.client.get("/api/orders", base_url=self.origin)
        self.assertEqual(listing.status_code, 200)
        self.assertEqual([o["id"] for o in listing.json["orders"]], [order["id"]])
        result = self.post(f"/api/orders/{order['id']}/cancel")
        self.assertEqual(result.status_code, 200, result.get_data(as_text=True))
        self.assertEqual(result.json["order"]["status"], "cancelled")

    def test_order_owner_is_server_controlled(self):
        first = self.account()
        other = self.app.test_client()
        second = self.account("two@example.test", other)
        order = self.create_order(userId=second["user"]["id"], status="confirmed")
        own = self.client.get("/api/orders", base_url=self.origin).json["orders"]
        theirs = other.get("/api/orders", base_url=self.origin).json["orders"]
        self.assertEqual(len(own), 1)
        self.assertEqual(theirs, [])
        self.assertNotEqual(order["status"], "confirmed")
        self.assertIn(self.post(f"/api/orders/{order['id']}/cancel", client=other).status_code, (403, 404))

    def test_order_idempotency_deduplicates_exact_retry(self):
        self.account()
        payload = self.order_payload()
        first = self.post("/api/orders", payload)
        retry = self.post("/api/orders", payload)
        self.assertIn(first.status_code, (200, 201))
        self.assertIn(retry.status_code, (200, 201))
        self.assertEqual(first.json["order"]["id"], retry.json["order"]["id"])
        self.assertEqual(len(self.client.get("/api/orders", base_url=self.origin).json["orders"]), 1)

    def test_order_idempotency_key_cannot_change_payload(self):
        self.account()
        payload = self.order_payload()
        self.assertIn(self.post("/api/orders", payload).status_code, (200, 201))
        payload["budget"] += 1000
        self.assertEqual(self.post("/api/orders", payload).status_code, 409)

    def test_accepted_order_blocks_double_booking_and_cannot_be_cancelled_online(self):
        self.account()
        order = self.create_order()
        update_order_status(self.app, order["id"], "accepted")
        result = self.post("/api/orders", self.order_payload())
        self.assertEqual(result.status_code, 409)
        self.assertEqual(self.post(f"/api/orders/{order['id']}/cancel").status_code, 409)

    def test_operator_acceptance_rechecks_catalog_availability(self):
        self.account()
        order = self.create_order()
        self.catalog["catalog"][0]["busy_dates"].append("2026-10-11")
        self.write_catalog()
        with self.assertRaises(ValueError):
            update_order_status(self.app, order["id"], "accepted")
        self.assertEqual(self.sql("SELECT status FROM orders")[0]["status"], "pending")

    def test_operator_can_cancel_accepted_order_and_release_slot_but_cannot_reactivate(self):
        self.account()
        order = self.create_order()
        update_order_status(self.app, order["id"], "accepted")
        update_order_status(self.app, order["id"], "cancelled")
        self.assertEqual(self.sql("SELECT status FROM orders WHERE id=?", (order["id"],))[0]["status"], "cancelled")
        with self.assertRaises(ValueError):
            update_order_status(self.app, order["id"], "accepted")
        replacement = self.create_order()
        update_order_status(self.app, replacement["id"], "accepted")
        self.assertNotEqual(order["id"], replacement["id"])

    def test_order_validation(self):
        self.account()
        invalid = [
            {"providerId": "not-real"},
            {"date": "2026-09-22"},
            {"date": "2027-01-01"},
            {"date": "2026-02-30"},
            {"date": "2026-10-10"},
            {"budget": -1},
            {"budget": 1.5},
            {"budget": True},
            {"budget": 1000000001},
            {"wishes": "x" * 5001},
            {"requestId": ""},
        ]
        for fields in invalid:
            with self.subTest(fields={k: str(v)[:80] for k, v in fields.items()}):
                result = self.post("/api/orders", self.order_payload(**fields))
                self.assertIn(result.status_code, (400, 404, 409), result.get_data(as_text=True))
        self.assertEqual(self.client.get("/api/orders", base_url=self.origin).json["orders"], [])

    def test_unauthenticated_order_and_subscription_are_denied(self):
        self.assertEqual(self.client.get("/api/orders", base_url=self.origin).status_code, 401)
        self.assertEqual(self.post("/api/subscription", {"enabled": True}).status_code, 401)

    def test_subscription_requires_literal_boolean(self):
        self.account()
        for value in ("true", "false", 1, None):
            with self.subTest(value=value):
                self.assertEqual(self.post("/api/subscription", {"enabled": value}).status_code, 400)
        self.assertEqual(self.post("/api/subscription", {"enabled": True}).status_code, 200)
        self.assertEqual(self.post("/api/subscription", {"enabled": False}).status_code, 200)

    def test_static_server_never_serves_backend_or_database(self):
        forbidden = (
            "/server.py", "/test_server.py", "/requirements.txt", "/.env",
            "/instance/firebird.sqlite3", "/../server.py", "/%2e%2e/server.py",
            "/README.md", "/__pycache__/server.pyc",
        )
        for path in forbidden:
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path, base_url=self.origin).status_code, 404)

    def test_all_public_assets_are_available_and_have_security_headers(self):
        for filename in STATIC_FILES:
            with self.subTest(filename=filename):
                response = self.client.get("/" + filename, base_url=self.origin)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.headers.get("X-Content-Type-Options"), "nosniff")
                response.close()

    def test_oversized_or_nonobject_json_is_rejected(self):
        headers = {"Origin": self.origin, "X-CSRF-Token": self.session()["csrfToken"]}
        nonobject = self.client.post("/api/auth/register", json=["not", "an", "object"], headers=headers, base_url=self.origin)
        self.assertEqual(nonobject.status_code, 400)
        oversized = self.client.post("/api/auth/register", json={"name": "a" * 20000}, headers=headers, base_url=self.origin)
        self.assertEqual(oversized.status_code, 413)

    def test_production_requires_explicit_secure_configuration(self):
        settings = dict(self.settings, DEVELOPMENT=False)
        with self.assertRaises((RuntimeError, ValueError)):
            create_app(settings)

    def production_app(self, **changes):
        settings = dict(
            self.settings,
            DEVELOPMENT=False,
            PUBLIC_URL="https://example.test",
            TURNSTILE_SITE_KEY="test-site-key",
            TURNSTILE_SECRET_KEY="test-secret-not-real",
            RESEND_API_KEY="test-mail-not-real",
            MAIL_FROM="Firebird <no-reply@example.test>",
            CAPTCHA_VERIFY=lambda token, action: token == "accepted",
        )
        settings.update(changes)
        return create_app(settings)

    def test_production_cookie_is_secure_httponly_samesite(self):
        app = self.production_app()
        response = app.test_client().get("/api/session", base_url="https://example.test")
        header = response.headers.get("Set-Cookie", "")
        self.assertIn("Secure", header)
        self.assertIn("HttpOnly", header)
        self.assertIn("SameSite=Lax", header)

    def test_production_captcha_fails_closed(self):
        self.app = self.production_app()
        self.client = self.app.test_client()
        self.origin = "https://example.test"
        for i, token in enumerate(("", "bad-token", "development-test")):
            with self.subTest(token=token):
                response = self.register(email=f"bot{i}@example.test", captchaToken=token)
                self.assertIn(response.status_code, (400, 403))
        self.assertEqual(self.sql("SELECT COUNT(*) AS n FROM users")[0]["n"], 0)
        self.assertIn(self.register(captchaToken="accepted").status_code, (200, 201, 202))

    def test_turnstile_checks_success_action_and_hostname(self):
        self.app = self.production_app(CAPTCHA_VERIFY=None)
        self.client = self.app.test_client()
        self.origin = "https://example.test"
        invalid = [
            {"success": False, "action": "register", "hostname": "example.test"},
            {"success": True, "action": "login", "hostname": "example.test"},
            {"success": True, "action": "register", "hostname": "attacker.invalid"},
        ]
        for i, result in enumerate(invalid):
            with self.subTest(result=result), patch("server.json_http", return_value=result):
                self.assertEqual(self.register(email=f"bad{i}@example.test").status_code, 400)
        self.assertEqual(self.sql("SELECT COUNT(*) AS n FROM users")[0]["n"], 0)
        with patch("server.json_http", return_value={"success": True, "action": "register", "hostname": "example.test"}):
            self.assertEqual(self.register(email="accepted@example.test").status_code, 202)

    def test_turnstile_network_failure_never_bypasses_captcha(self):
        self.app = self.production_app(CAPTCHA_VERIFY=None)
        self.client = self.app.test_client()
        self.origin = "https://example.test"
        with patch("server.json_http", side_effect=OSError("offline in test")):
            self.assertEqual(self.register().status_code, 503)
        self.assertEqual(self.sql("SELECT COUNT(*) AS n FROM users")[0]["n"], 0)

    def test_development_bypass_rejects_public_origin_or_nonloopback_client(self):
        with self.assertRaises(RuntimeError):
            create_app(dict(self.settings, PUBLIC_URL="http://example.test"))
        response = self.client.get("/api/session", base_url=self.origin, environ_overrides={"REMOTE_ADDR": "203.0.113.42"})
        self.assertEqual(response.status_code, 403)

    def test_test_callbacks_are_forbidden_outside_test_mode(self):
        with self.assertRaises(RuntimeError):
            self.production_app(TESTING=False)

    def add_provider(self):
        second = copy.deepcopy(self.catalog["catalog"][0])
        second.update(id="provider-new", anon_name="Новый тестовый подрядчик")
        self.catalog["catalog"].append(second)
        self.write_catalog()

    def worker(self, **kwargs):
        with patch("server.send_mail", side_effect=lambda app, message: self.capture_mail(message, message["id"])):
            return run_worker_once(self.app, **kwargs)

    def test_catalog_baseline_never_broadcasts_old_profiles(self):
        self.account()
        self.post("/api/subscription", {"enabled": True})
        self.worker()
        self.assertEqual(self.sql("SELECT COUNT(*) AS n FROM outbox WHERE kind='broadcast'")[0]["n"], 0)

    def test_only_verified_opted_in_users_receive_new_provider_once(self):
        self.worker()
        self.account()
        self.post("/api/subscription", {"enabled": True})
        second = self.app.test_client()
        self.account("out@example.test", second)
        third = self.app.test_client()
        self.register("unverified@example.test", third)
        # Even inconsistent/imported subscribed=1 must not bypass verification.
        self.sql("UPDATE users SET subscribed=1 WHERE email='unverified@example.test'")
        self.worker()
        self.mail.clear()
        self.add_provider()
        result = self.worker()
        self.assertEqual(result["newProviders"], 1)
        broadcasts = [message for message, key in self.mail if message["kind"] == "broadcast"]
        self.assertEqual([message["recipient"] for message in broadcasts], ["one@example.test"])
        self.assertIn("Новый тестовый подрядчик", broadcasts[0]["body"])
        self.assertIn("/unsubscribe?token=", broadcasts[0]["body"])
        self.worker()
        self.assertEqual(len([message for message, key in self.mail if message["kind"] == "broadcast"]), 1)

    def test_queued_broadcast_rechecks_optout_before_delivery(self):
        self.worker()
        self.account()
        self.post("/api/subscription", {"enabled": True})
        self.worker()
        self.mail.clear()
        self.add_provider()
        self.assertEqual(scan_catalog(self.app), 1)
        self.post("/api/subscription", {"enabled": False})
        result = self.worker()
        self.assertEqual(result["skipped"], 1)
        self.assertEqual(self.mail, [])
        skipped = self.sql("SELECT status,body FROM outbox WHERE kind='broadcast'")[0]
        self.assertEqual(skipped, {"status": "skipped", "body": ""})

    def test_worker_retries_with_backoff_same_id_and_scrubs_sent_body(self):
        self.register()
        original = self.sql("SELECT * FROM outbox")[0]
        with patch("server.send_mail", side_effect=OSError("offline in test")):
            self.assertEqual(run_worker_once(self.app)["failed"], 1)
        pending = self.sql("SELECT * FROM outbox")[0]
        self.assertEqual(pending["status"], "pending")
        self.assertEqual(pending["attempts"], 1)
        self.assertGreater(pending["available_at"], int(time.time()))
        self.assertEqual(self.worker()["sent"], 0)
        self.sql("UPDATE outbox SET available_at=0")
        self.assertEqual(self.worker()["sent"], 1)
        self.assertEqual(self.mail[0][1], original["id"])
        sent = self.sql("SELECT status,body FROM outbox")[0]
        self.assertEqual(sent, {"status": "sent", "body": ""})
        self.assertEqual(self.worker()["sent"], 0)

    def test_worker_recovers_expired_lease_without_new_message_identity(self):
        self.register()
        original = self.sql("SELECT * FROM outbox")[0]
        self.sql("UPDATE outbox SET status='processing',attempts=1,lease_until=0,claim_token='crashed-worker'")
        self.assertEqual(self.worker()["sent"], 1)
        self.assertEqual(self.mail[0][1], original["id"])
        self.assertEqual(self.sql("SELECT attempts FROM outbox")[0]["attempts"], 2)

    def test_concurrent_workers_claim_each_message_only_once(self):
        self.register()
        self.register("two@example.test")
        with patch("server.send_mail", side_effect=lambda app, message: self.capture_mail(message, message["id"])):
            with ThreadPoolExecutor(max_workers=3) as pool:
                results = list(pool.map(lambda _: run_worker_once(self.app), range(3)))
        self.assertEqual(sum(result["sent"] for result in results), 2)
        self.assertEqual(len(self.mail), 2)
        self.assertEqual(len({key for message, key in self.mail}), 2)

    def test_worker_does_not_retry_beyond_provider_idempotency_window(self):
        self.register()
        self.sql("UPDATE outbox SET created_at=?", (int(time.time()) - 24 * 3600,))
        self.assertEqual(self.worker()["sent"], 0)
        dead = self.sql("SELECT status,body FROM outbox")[0]
        self.assertEqual(dead, {"status": "dead", "body": ""})

    def test_worker_stops_after_seven_attempts_and_scrubs_dead_body(self):
        self.register()
        self.sql("UPDATE outbox SET attempts=6")
        with patch("server.send_mail", side_effect=OSError("offline in test")):
            self.assertEqual(run_worker_once(self.app)["failed"], 1)
        dead = self.sql("SELECT status,attempts,body FROM outbox")[0]
        self.assertEqual(dead, {"status": "dead", "attempts": 7, "body": ""})
        self.assertEqual(self.worker()["sent"], 0)

    def test_unsubscribe_get_is_read_only_post_requires_csrf_and_token(self):
        self.worker()
        self.account()
        self.post("/api/subscription", {"enabled": True})
        self.worker()
        self.mail.clear()
        self.add_provider()
        self.worker()
        message = next(message for message, key in self.mail if message["kind"] == "broadcast")
        link = re.search(r"http://localhost/unsubscribe\?token=[A-Za-z0-9_-]+", message["body"]).group(0)
        token = parse_qs(urlsplit(link).query)["token"][0]
        mail_client = self.app.test_client()
        page = mail_client.get(link)
        self.assertEqual(page.status_code, 200)
        self.assertTrue(self.session()["user"]["subscribed"])
        self.assertEqual(mail_client.post("/unsubscribe", data={"token": token}, base_url=self.origin, headers={"Origin": self.origin}).status_code, 403)
        csrf = re.search(r"name='csrf' value='([^']+)'", page.get_data(as_text=True)).group(1)
        response = mail_client.post("/unsubscribe", data={"token": token, "csrf": csrf}, headers={"Origin": self.origin}, base_url=self.origin)
        self.assertEqual(response.status_code, 200)
        self.assertFalse(self.session()["user"]["subscribed"])



if __name__ == "__main__":
    unittest.main(verbosity=2)
