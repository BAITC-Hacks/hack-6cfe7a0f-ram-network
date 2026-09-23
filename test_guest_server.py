"""Real passwordless guest-order lifecycle; all email and CAPTCHA stay offline."""
import concurrent.futures
import json
import re
import sqlite3
import time
import unittest
from unittest.mock import patch

import test_server as existing
from server import connect_db, create_app, run_worker_once, update_order_status


class GuestOrderTests(unittest.TestCase):
    # Share fixtures, not the existing test class (the 48 account tests run separately).
    for _name in ("setUp", "write_catalog", "capture_mail", "sql", "session", "post", "register",
                  "token", "verify", "login", "account", "order_payload", "create_order"):
        locals()[_name] = getattr(existing.ServerTestCase, _name)

    def payload(self, **changes):
        return {"name": "Гость Тестовый", "email": "guest@example.test", **self.order_payload(), **changes}

    def guest(self, client=None, **changes):
        response = self.post("/api/guest-orders", self.payload(**changes), client)
        self.assertEqual(response.status_code, 201, response.get_data(as_text=True))
        return response.json["order"]

    def guest_token(self, ident):
        body = self.sql("SELECT body FROM guest_outbox WHERE order_id=? AND kind='guest_verify'", (ident,))[0]["body"]
        return re.search(r"[?&]guest=([A-Za-z0-9_-]+)", body).group(1)

    def confirm(self, order, client=None):
        response = self.post("/api/guest-orders/verify", {"token": self.guest_token(order["id"])}, client)
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        return response.json["order"]

    def listed(self, client=None):
        response = (client or self.client).get("/api/guest-orders", base_url=self.origin)
        self.assertEqual(response.status_code, 200)
        return response.json["orders"]

    def test_guest_lifecycle_is_real_and_does_not_create_an_account(self):
        order = self.guest()
        self.assertEqual(order["status"], "awaiting_email")
        self.assertEqual(self.listed()[0]["id"], order["id"])
        self.assertEqual(self.confirm(order)["status"], "pending")
        self.assertIsNone(self.session()["user"])
        self.assertEqual(self.sql("SELECT count(*) AS n FROM users")[0]["n"], 0)
        self.assertEqual(self.sql("SELECT count(*) AS n FROM orders")[0]["n"], 0)
        self.assertTrue(self.client.get("/api/config", base_url=self.origin).json["guestOrders"])
        update_order_status(self.app, order["id"], "accepted")
        self.assertEqual(self.listed()[0]["status"], "accepted")
        self.assertEqual(self.post(f"/api/guest-orders/{order['id']}/cancel").status_code, 409)
        run_worker_once(self.app)
        self.assertTrue(any("принята оператором" in message[0]["body"] for message in self.mail))

    def test_email_confirmation_in_a_new_browser_grants_only_that_order(self):
        order = self.guest()
        other = self.app.test_client()
        self.assertEqual(self.listed(other), [])
        self.confirm(order, other)
        self.assertEqual(self.listed(other)[0]["id"], order["id"])
        self.assertIsNone(self.session(other)["user"])
        self.assertEqual(self.post(f"/api/guest-orders/{order['id']}/cancel", client=other).json["order"]["status"], "cancelled")

    def test_same_email_or_known_uuid_does_not_grant_access(self):
        order = self.guest()
        other = self.app.test_client()
        second = self.guest(other)
        self.assertEqual([row["id"] for row in self.listed(other)], [second["id"]])
        self.assertEqual(self.post(f"/api/guest-orders/{order['id']}/cancel", client=other).status_code, 404)
        self.assertNotIn("guest@example.test", json.dumps(self.listed()))
        self.assertTrue(all("email" not in row and "name" not in row for row in self.listed()))

    def test_identical_retry_is_idempotent_and_changed_payload_conflicts(self):
        payload = self.payload()
        first = self.post("/api/guest-orders", payload)
        second = self.post("/api/guest-orders", payload)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(first.json, second.json)
        self.assertEqual(self.sql("SELECT count(*) AS n FROM guest_outbox")[0]["n"], 1)
        for field, value in (("email", "another@example.test"), ("budget", 500000), ("name", "Другой гость")):
            with self.subTest(field=field):
                response = self.post("/api/guest-orders", {**payload, field: value})
                self.assertEqual(response.status_code, 409)

    def test_concurrent_create_with_same_session_and_request_id_has_one_row(self):
        self.session()
        cookie = self.client.get_cookie(self.app.config["COOKIE_NAME"], domain="localhost").value
        payload = self.payload()
        def send(_):
            client = self.app.test_client()
            client.set_cookie(self.app.config["COOKIE_NAME"], cookie, domain="localhost")
            return self.post("/api/guest-orders", payload, client)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(send, range(2)))
        self.assertEqual(sorted(r.status_code for r in responses), [200, 201])
        self.assertEqual(self.sql("SELECT count(*) AS n FROM guest_orders")[0]["n"], 1)
        self.assertEqual(self.sql("SELECT count(*) AS n FROM guest_outbox")[0]["n"], 1)

    def test_no_implicit_verification_on_get_and_unconfirmed_cannot_be_accepted(self):
        order = self.guest()
        with self.client.get("/?guest=" + self.guest_token(order["id"]), base_url=self.origin) as response:
            self.assertEqual(response.status_code, 200)
        self.assertEqual(self.listed()[0]["status"], "awaiting_email")
        with self.assertRaises(ValueError):
            update_order_status(self.app, order["id"], "accepted")

    def test_token_is_hashed_expiring_single_use_with_safe_same_session_retry(self):
        order = self.guest()
        token = self.guest_token(order["id"])
        self.assertNotEqual(self.sql("SELECT token_hash FROM guest_tokens")[0]["token_hash"], token)
        self.confirm(order)
        self.assertEqual(self.post("/api/guest-orders/verify", {"token": token}).status_code, 200)
        self.assertEqual(self.post("/api/guest-orders/verify", {"token": token}, self.app.test_client()).status_code, 400)
        another = self.guest(date="2026-10-12")
        token2 = self.guest_token(another["id"])
        self.sql("UPDATE guest_tokens SET expires=0 WHERE order_id=?", (another["id"],))
        self.assertEqual(self.post("/api/guest-orders/verify", {"token": token2}).status_code, 400)
        self.assertEqual(len(self.sql("SELECT * FROM guest_orders WHERE status='awaiting_email'")), 1)

    def test_verification_rechecks_calendar_and_busy_slots_before_consuming_link(self):
        order = self.guest()
        self.catalog["catalog"][0]["busy_dates"].append(order["date"])
        self.write_catalog()
        response = self.post("/api/guest-orders/verify", {"token": self.guest_token(order["id"])})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.sql("SELECT used FROM guest_tokens")[0]["used"], 0)
        self.assertEqual(self.listed()[0]["status"], "awaiting_email")
        self.catalog["catalog"][0]["busy_dates"] = []
        self.catalog["calendarThrough"] = "2026-10-01"
        self.write_catalog()
        self.assertEqual(self.post("/api/guest-orders/verify", {"token": self.guest_token(order["id"])}).json["code"], "date_out_of_range")

    def test_guest_accepted_slot_blocks_account_and_guest_requests(self):
        order = self.guest()
        self.confirm(order)
        update_order_status(self.app, order["id"], "accepted")
        self.account()
        self.assertEqual(self.post("/api/orders", self.order_payload()).status_code, 409)
        self.assertEqual(self.post("/api/guest-orders", self.payload()).status_code, 409)
        update_order_status(self.app, order["id"], "cancelled")
        self.assertEqual(self.post("/api/orders", self.order_payload()).status_code, 201)

    def test_account_accepted_slot_blocks_guest_confirmation(self):
        guest = self.guest()
        self.account()
        account = self.create_order()
        update_order_status(self.app, account["id"], "accepted")
        self.assertEqual(self.post("/api/guest-orders/verify", {"token": self.guest_token(guest["id"])}).status_code, 409)
        self.assertEqual(self.post("/api/guest-orders", self.payload()).status_code, 409)

    def test_concurrent_operator_acceptance_across_tables_has_one_winner(self):
        guest = self.guest()
        self.confirm(guest)
        self.account()
        account = self.create_order()
        def accept(ident):
            try:
                update_order_status(self.app, ident, "accepted")
                return True
            except ValueError:
                return False
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(accept, (guest["id"], account["id"])))
        self.assertEqual(sorted(results), [False, True])
        self.assertEqual(len(self.sql("SELECT id FROM orders WHERE status='accepted' UNION ALL SELECT id FROM guest_orders WHERE status='accepted'")), 1)

    def test_database_rejects_cross_table_double_booking_even_outside_operator(self):
        guest = self.guest()
        self.confirm(guest)
        self.account()
        account = self.create_order()
        update_order_status(self.app, guest["id"], "accepted")
        with self.assertRaises(sqlite3.IntegrityError):
            self.sql("UPDATE orders SET status='accepted' WHERE id=?", (account["id"],))

    def test_guest_ownership_survives_account_login_logout_but_not_cookie_replay(self):
        payload = self.payload()
        self.post("/api/guest-orders", payload)
        old_cookie = self.client.get_cookie(self.app.config["COOKIE_NAME"], domain="localhost").value
        self.account()
        self.assertEqual(len(self.listed()), 1)
        self.assertEqual(self.post("/api/guest-orders", payload).status_code, 200)
        self.post("/api/auth/logout")
        self.assertEqual(len(self.listed()), 1)
        expiries = self.sql("SELECT expires FROM sessions")
        self.assertTrue(all(row["expires"] >= int(time.time()) + self.app.config["SESSION_TTL"] - 10 for row in expiries))
        old = self.app.test_client()
        old.set_cookie(self.app.config["COOKIE_NAME"], old_cookie, domain="localhost")
        self.assertEqual(self.listed(old), [])

    def test_cancel_before_email_prevents_verification_and_suppresses_pending_mail(self):
        order = self.guest()
        token = self.guest_token(order["id"])
        for _ in range(2):
            self.assertEqual(self.post(f"/api/guest-orders/{order['id']}/cancel").json["order"]["status"], "cancelled")
        self.assertEqual(self.post("/api/guest-orders/verify", {"token": token}).status_code, 400)
        run_worker_once(self.app)
        self.assertEqual(self.mail, [])

    def test_validation_origin_csrf_and_rate_limits_are_not_bypassed(self):
        self.session()
        self.assertEqual(self.client.post("/api/guest-orders", json=self.payload(), base_url=self.origin).status_code, 403)
        self.assertEqual(self.post("/api/guest-orders", self.payload(), headers={"Origin": "https://attacker.test"}).status_code, 403)
        invalid = ({"userId": 1}, {"status": "accepted"}, {"name": ""}, {"email": "bad"}, {"budget": True},
                   {"budget": 0}, {"wishes": "a" * 2001}, {"date": "2026-10-10"}, {"date": "2020-01-01"}, {"requestId": "bad"})
        for change in invalid:
            with self.subTest(change=change):
                self.assertIn(self.post("/api/guest-orders", self.payload(**change)).status_code, (400, 409))
        self.sql("DELETE FROM rate_limits")
        for _ in range(5):
            self.guest()
        self.assertEqual(self.post("/api/guest-orders", self.payload()).status_code, 429)

    def test_production_captcha_requires_correct_guest_action(self):
        actions = []
        config = {**self.settings, "DEVELOPMENT": False, "PUBLIC_URL": "https://firebird.test",
                  "TURNSTILE_SITE_KEY": "site", "TURNSTILE_SECRET_KEY": "secret", "RESEND_API_KEY": "mail",
                  "MAIL_FROM": "test@firebird.test", "CAPTCHA_VERIFY": lambda token, action: actions.append(action) or token == "valid"}
        self.app = create_app(config)
        self.client = self.app.test_client()
        self.origin = "https://firebird.test"
        self.assertEqual(self.post("/api/guest-orders", self.payload(captchaToken="bad")).json["code"], "captcha_failed")
        self.assertEqual(self.post("/api/guest-orders", self.payload(captchaToken="valid")).status_code, 201)
        self.assertEqual(actions, ["guest_order", "guest_order"])

    def test_iso_week_dates_cannot_bypass_busy_date_or_slot_checks(self):
        # 2026-W41-6 is ten characters and parses to the busy calendar day 2026-10-10.
        self.assertEqual(self.post("/api/guest-orders", self.payload(date="2026-W41-6")).status_code, 400)
        self.account()
        self.assertEqual(self.post("/api/orders", self.order_payload(date="2026-W41-6")).status_code, 400)
        guest = self.guest()
        self.sql("UPDATE guest_orders SET event_date='2026-W41-6' WHERE id=?", (guest["id"],))
        self.assertEqual(self.post("/api/guest-orders/verify", {"token": self.guest_token(guest["id"])}).status_code, 400)
        self.sql("UPDATE guest_orders SET status='pending',verified_at=? WHERE id=?", (int(time.time()), guest["id"]))
        with self.assertRaises(ValueError):
            update_order_status(self.app, guest["id"], "accepted")

    def test_guest_delivery_retries_same_id_and_scrubs_body(self):
        self.guest()
        attempts = []
        def fail_once(message, key):
            attempts.append(key)
            if len(attempts) == 1:
                raise OSError("sensitive mail-service detail")
        self.app.config["MAIL_SEND"] = fail_once
        self.assertEqual(run_worker_once(self.app)["failed"], 1)
        row = self.sql("SELECT * FROM guest_outbox")[0]
        self.assertEqual(row["last_error"], "delivery_failed")
        self.assertTrue(row["body"])
        self.sql("UPDATE guest_outbox SET available_at=0")
        self.assertEqual(run_worker_once(self.app)["sent"], 1)
        self.assertEqual(attempts, [row["id"], row["id"]])
        self.assertEqual(self.sql("SELECT body FROM guest_outbox")[0]["body"], "")

    def test_concurrent_guest_workers_claim_once_and_recover_expired_leases(self):
        self.guest()
        self.sql("UPDATE guest_outbox SET status='processing',lease_until=0,claim_token='old'")
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: run_worker_once(self.app), range(2)))
        self.assertEqual(sum(result["sent"] for result in results), 1)
        self.assertEqual(len(self.mail), 1)

    def test_expired_unconfirmed_orders_close_and_old_mail_never_sends(self):
        order = self.guest()
        self.sql("UPDATE guest_orders SET created_at=?", (int(time.time()) - 86401,))
        self.sql("UPDATE guest_outbox SET created_at=?", (int(time.time()) - 86401,))
        run_worker_once(self.app)
        self.assertEqual(self.listed()[0]["status"], "cancelled")
        self.assertEqual(self.sql("SELECT status,body FROM guest_outbox")[0], {"status": "dead", "body": ""})
        self.assertEqual(self.mail, [])


if __name__ == "__main__":
    unittest.main()
