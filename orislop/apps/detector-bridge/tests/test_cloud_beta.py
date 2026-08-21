from __future__ import annotations

import hashlib
import hmac
import time
from datetime import datetime, timezone
from pathlib import Path
import sys
import unittest


BRIDGE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BRIDGE_ROOT))

from cloud_beta import (
    AccessTokens, AuthError, AuthManager, CandidateQuota, CloudBetaController, GoogleOidc,
    MemoryBetaStore, QuotaError, RolloutGuard, _b64url, _json_b64,
)


EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop"


def claims(_token: str, audience: str) -> dict:
    return {
        "iss": "https://accounts.google.com",
        "aud": audience,
        "exp": int(time.time()) + 300,
        "nonce": "expected-nonce",
        "email_verified": True,
        "sub": "google-user-1",
        "email": "beta@example.com",
        "name": "Beta User",
    }


class CloudBetaAuthTests(unittest.TestCase):
    def setUp(self) -> None:
        self.store = MemoryBetaStore()
        oidc = GoogleOidc(
            "chrome-client",
            token_exchange=lambda _fields: {"id_token": "signed"},
            verifier=claims,
            allowed_extension_ids={EXTENSION_ID},
        )
        self.auth = AuthManager(self.store, oidc, "a" * 32)
        self.body = {
            "code": "authorization-code",
            "codeVerifier": "v" * 64,
            "redirectUri": f"https://{EXTENSION_ID}.chromiumapp.org/oauth2",
            "nonce": "expected-nonce",
        }

    def test_google_login_access_and_refresh_rotation(self) -> None:
        login = self.auth.google_login(self.body)
        principal = self.auth.authenticate_access(f"Bearer {login['accessToken']}")
        self.assertEqual(principal["user"]["email"], "beta@example.com")
        refreshed = self.auth.refresh(login["refreshToken"])
        self.assertNotEqual(refreshed["refreshToken"], login["refreshToken"])
        with self.assertRaises(AuthError):
            self.auth.refresh(login["refreshToken"])
        with self.assertRaises(AuthError):
            self.auth.authenticate_access(f"Bearer {refreshed['accessToken']}")

    def test_nonce_mismatch_is_rejected(self) -> None:
        body = {**self.body, "nonce": "wrong"}
        with self.assertRaises(AuthError):
            self.auth.google_login(body)

    def test_google_login_rejects_unregistered_or_malformed_extension_redirects(self) -> None:
        for redirect_uri in [
            "https://ponmlkjihgfedcbaponmlkjihgfedcba.chromiumapp.org/oauth2",
            f"https://{EXTENSION_ID}.chromiumapp.org/not-oauth2",
            f"https://{EXTENSION_ID}.chromiumapp.org/oauth2?unexpected=1",
            "https://abcdefghijklmnop.chromiumapp.org/oauth2",
        ]:
            with self.subTest(redirect_uri=redirect_uri), self.assertRaises(AuthError):
                self.auth.google_login({**self.body, "redirectUri": redirect_uri})

    def test_access_token_rejects_a_signed_unexpected_jwt_header(self) -> None:
        tokens = AccessTokens("a" * 32)
        token, _ = tokens.issue("user", "session")
        _header, payload, _signature = token.split(".")
        replacement_header = _json_b64({"alg": "none", "typ": "JWT"})
        signing_input = f"{replacement_header}.{payload}".encode("ascii")
        replacement_signature = _b64url(hmac.new(tokens.secret, signing_input, hashlib.sha256).digest())
        with self.assertRaises(AuthError):
            tokens.verify(f"{replacement_header}.{payload}.{replacement_signature}")

    def test_logout_revokes_access_immediately(self) -> None:
        login = self.auth.google_login(self.body)
        principal = self.auth.authenticate_access(f"Bearer {login['accessToken']}")
        self.auth.logout(principal["claims"]["sid"])
        with self.assertRaises(AuthError):
            self.auth.authenticate_access(f"Bearer {login['accessToken']}")

    def test_candidate_quota_enforces_minute_limit(self) -> None:
        quota = CandidateQuota()
        for _ in range(30):
            quota.consume("user")
        with self.assertRaises(QuotaError):
            quota.consume("user")

    def test_account_deletion_removes_user_sessions_and_metadata(self) -> None:
        login = self.auth.google_login(self.body)
        principal = self.auth.authenticate_access(f"Bearer {login['accessToken']}")
        user_id = principal["user"]["id"]
        self.store.save_decision({"decisionId": "d1", "userId": user_id})
        self.store.delete_user(user_id)
        self.assertIsNone(self.store.get_user(user_id))
        self.assertIsNone(self.store.get_decision("d1"))
        with self.assertRaises(AuthError):
            self.auth.authenticate_access(f"Bearer {login['accessToken']}")

    def test_persisted_decision_never_contains_media_url(self) -> None:
        class Service:
            @staticmethod
            def submit(candidates, _profile):
                return [{"id": candidates[0]["id"], "status": "pending"}]

        user = self.store.upsert_user("subject", "a@example.com", "A")
        controller = CloudBetaController(self.store, "content-secret")
        response = controller.analyze(user["id"], {
            "platform": "youtube",
            "itemIdentifier": "short-1",
            "directMediaUrl": "https://rr1.example.googlevideo.com/videoplayback?secret=signed",
            "language": "en",
            "priority": "current",
        }, Service(), lambda _url: True)
        persisted = self.store.get_decision(response["decisionId"])
        self.assertNotIn("media", json_text(persisted).lower())
        self.assertNotIn("googlevideo", json_text(persisted).lower())
        self.assertEqual(len(persisted["contentKey"]), 64)

    def test_batch_analysis_is_bounded_and_preserves_client_mapping(self) -> None:
        class Service:
            @staticmethod
            def submit(candidates, _profile):
                return [{"id": candidates[0]["id"], "status": "pending"}]

        user = self.store.upsert_user("batch-subject", "batch@example.com", "Batch")
        controller = CloudBetaController(self.store, "content-secret")
        candidates = [{
            "clientId": f"card-{index}",
            "platform": "youtube",
            "itemIdentifier": f"short-{index}",
            "directMediaUrl": f"https://rr{index}.example.googlevideo.com/videoplayback?signed=1",
            "language": "en",
            "priority": "lookahead",
        } for index in range(10)]
        response = controller.analyze_batch(user["id"], {"candidates": candidates}, Service(), lambda _url: True)
        self.assertEqual([item["clientId"] for item in response["results"]], [f"card-{index}" for index in range(10)])
        self.assertTrue(all(item["status"] == "pending" for item in response["results"]))
        self.assertEqual(response["quota"]["minuteRemaining"], 20)
        with self.assertRaises(ValueError):
            controller.analyze_batch(user["id"], {"candidates": candidates + [candidates[0]]}, Service(), lambda _url: True)

    def test_batch_analysis_fails_open_per_candidate(self) -> None:
        class Service:
            @staticmethod
            def submit(candidates, _profile):
                return [{"id": candidates[0]["id"], "status": "pending"}]

        user = self.store.upsert_user("mixed-subject", "mixed@example.com", "Mixed")
        controller = CloudBetaController(self.store, "content-secret")
        response = controller.analyze_batch(user["id"], {"candidates": [{
            "clientId": "bad",
            "platform": "youtube",
            "itemIdentifier": "bad-media",
            "directMediaUrl": "https://example.com/not-approved.mp4",
        }, {
            "clientId": "good",
            "platform": "youtube",
            "itemIdentifier": "good-media",
            "directMediaUrl": "https://rr1.example.googlevideo.com/videoplayback?signed=1",
        }]}, Service(), lambda url: "googlevideo.com" in url)
        self.assertEqual(response["results"][0]["status"], "unavailable")
        self.assertFalse(response["results"][0]["automaticSkipEligible"])
        self.assertEqual(response["results"][1]["status"], "pending")

    def test_persisted_pending_analysis_fails_open_after_worker_restart(self) -> None:
        class Service:
            @staticmethod
            def submit(_candidates, _profile):
                raise AssertionError("a direct media URL must not be reconstructed after restart")

        user = self.store.upsert_user("restart-subject", "restart@example.com", "Restart")
        self.store.save_decision({
            "decisionId": "interrupted-decision",
            "userId": user["id"],
            "status": "pending",
            "automaticSkipEligible": False,
        })
        controller = CloudBetaController(self.store, "content-secret")
        result = controller.get_analysis(user["id"], "interrupted-decision", Service())
        self.assertEqual(result["status"], "error")
        self.assertFalse(result["automaticSkipEligible"])
        self.assertTrue(result["fallbackActive"])
        self.assertEqual(result["rolloutMode"], "shadow")
        self.assertIn("restarted", result["shadowFallbackReason"])

    def test_rollout_guard_reverts_on_latency_and_wrong_hides(self) -> None:
        latency_guard = RolloutGuard()
        for _ in range(100):
            latency_guard.record_job(latency_ms=6000)
        self.assertTrue(latency_guard.state()["forcedShadow"])
        wrong_guard = RolloutGuard()
        for _ in range(5):
            wrong_guard.record_hide_feedback(revealed=True, confirmed_wrong=True)
        self.assertTrue(wrong_guard.state()["forcedShadow"])

    def test_product_events_are_validated_pseudonymized_bounded_and_idempotent(self) -> None:
        controller = CloudBetaController(self.store, "product-content-secret")
        event = {
            "schemaVersion": 1,
            "eventId": "event_1234567890abcdef",
            "eventName": "scan_batch_completed",
            "occurredAt": datetime.now(tz=timezone.utc).isoformat(),
            "installationId": "install_1234567890abcdef",
            "sessionId": "session_1234567890abcdef",
            "extensionVersion": "1.3.0",
            "attributes": {
                "platform": "youtube",
                "inferenceMode": "hybrid",
                "performanceMode": "heavy",
                "outcome": "complete",
                "durationBucket": "1s_5s",
                "batchSize": 10,
                "modelIds": ["gonnerthetooner/orislop-fusion"],
            },
        }
        first = controller.product_events({"schemaVersion": 1, "events": [event]})
        second = controller.product_events({"schemaVersion": 1, "events": [event]})
        self.assertEqual(first["accepted"], 1)
        self.assertEqual(second["duplicate"], 1)
        persisted = self.store.product_events[event["eventId"]]
        self.assertNotIn("installationId", persisted)
        self.assertNotIn("sessionId", persisted)
        self.assertNotIn(event["installationId"], json_text(persisted))
        self.assertEqual(len(persisted["installationHash"]), 64)
        self.assertEqual(len(persisted["sessionHash"]), 64)
        self.assertEqual(controller.delete_product_events(event["installationId"]), 1)
        self.assertEqual(self.store.product_events, {})

    def test_product_events_reject_private_or_mixed_identity_fields(self) -> None:
        controller = CloudBetaController(self.store, "product-content-secret")
        base = {
            "schemaVersion": 1,
            "eventId": "event_1234567890abcdef",
            "eventName": "decision_presented",
            "occurredAt": datetime.now(tz=timezone.utc).isoformat(),
            "installationId": "install_1234567890abcdef",
            "sessionId": "session_1234567890abcdef",
            "extensionVersion": "1.3.0",
            "attributes": {"platform": "youtube", "verdict": "skip"},
        }
        with self.assertRaises(ValueError):
            controller.product_events({
                "schemaVersion": 1,
                "events": [{**base, "attributes": {**base["attributes"], "url": "https://private.example"}}],
            })
        with self.assertRaises(ValueError):
            controller.product_events({
                "schemaVersion": 1,
                "events": [base, {**base, "eventId": "event_abcdef1234567890", "installationId": "install_abcdef1234567890"}],
            })


def json_text(value) -> str:
    import json
    return json.dumps(value, sort_keys=True)


if __name__ == "__main__":
    unittest.main()
