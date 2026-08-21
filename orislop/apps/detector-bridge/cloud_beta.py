from __future__ import annotations

from collections import defaultdict, deque
from dataclasses import dataclass
from datetime import datetime, timezone
import base64
import hashlib
import hmac
import json
import math
import os
import re
import secrets
import threading
import time
from typing import Any, Callable
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen
import uuid


ACCESS_TOKEN_SECONDS = 15 * 60
REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60
PER_MINUTE_CANDIDATES = 30
PER_DAY_CANDIDATES = 500
MAX_ANALYZE_BATCH_SIZE = 10
SUPPORTED_PLATFORMS = {"youtube", "instagram", "tiktok", "linkedin"}
PRODUCT_EVENT_SCHEMA_VERSION = 1
MAX_PRODUCT_EVENT_BATCH_SIZE = 20
PRODUCT_EVENT_RETENTION_DAYS = min(90, max(1, int(os.environ.get("ORISLOP_PRODUCT_EVENT_RETENTION_DAYS", "30"))))
PRODUCT_EVENT_NAMES = {
    "scan_batch_started", "scan_batch_completed", "request_failed", "request_retried",
    "request_deduplicated", "decision_presented", "correction_submitted", "manual_skip",
    "attention_response", "feature_toggled", "adapter_health",
}
PRODUCT_EVENT_ATTRIBUTE_FIELDS = {
    "platform", "inferenceMode", "performanceMode", "outcome", "status", "verdict",
    "reasonCode", "requestKind", "correction", "satisfaction", "feature", "adapterState",
    "cacheState", "durationBucket", "retryAfterBucket", "modelIds", "batchSize", "itemCount",
    "hiddenCount", "retryCount", "dedupeCount", "queueDepthBucket",
}
PRODUCT_EVENT_ID = re.compile(r"^[A-Za-z0-9_-]{16,96}$")
PRODUCT_EVENT_TOKEN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@+\-]{0,119}$")


def _b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _b64decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _json_b64(payload: dict[str, Any]) -> str:
    return _b64url(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8"))


def _utc_iso(timestamp: float | None = None) -> str:
    return datetime.fromtimestamp(timestamp or time.time(), tz=timezone.utc).isoformat()


class AuthError(ValueError):
    pass


class QuotaError(ValueError):
    pass


class AccessTokens:
    def __init__(self, secret: str) -> None:
        if len(secret.encode("utf-8")) < 32:
            raise RuntimeError("ORISLOP_TOKEN_SECRET must contain at least 32 bytes")
        self.secret = secret.encode("utf-8")

    def issue(self, user_id: str, session_id: str) -> tuple[str, int]:
        now = int(time.time())
        payload = {
            "sub": user_id,
            "sid": session_id,
            "iat": now,
            "exp": now + ACCESS_TOKEN_SECONDS,
            "iss": "https://api.orislop.com",
            "aud": "orislop-extension",
            "typ": "access",
        }
        header = _json_b64({"alg": "HS256", "typ": "JWT"})
        encoded_payload = _json_b64(payload)
        signing_input = f"{header}.{encoded_payload}".encode("ascii")
        signature = _b64url(hmac.new(self.secret, signing_input, hashlib.sha256).digest())
        return f"{header}.{encoded_payload}.{signature}", ACCESS_TOKEN_SECONDS

    def verify(self, token: str) -> dict[str, Any]:
        try:
            header, encoded_payload, signature = token.split(".", 2)
            signing_input = f"{header}.{encoded_payload}".encode("ascii")
            expected = _b64url(hmac.new(self.secret, signing_input, hashlib.sha256).digest())
            if not hmac.compare_digest(signature, expected):
                raise AuthError("Invalid access token")
            token_header = json.loads(_b64decode(header))
            payload = json.loads(_b64decode(encoded_payload))
        except AuthError:
            raise
        except Exception as error:
            raise AuthError("Malformed access token") from error
        if token_header != {"alg": "HS256", "typ": "JWT"}:
            raise AuthError("Invalid access token header")
        if (
            payload.get("typ") != "access"
            or payload.get("aud") != "orislop-extension"
            or payload.get("iss") != "https://api.orislop.com"
            or not isinstance(payload.get("sub"), str)
            or not payload.get("sub")
            or not isinstance(payload.get("sid"), str)
            or not payload.get("sid")
        ):
            raise AuthError("Invalid access token claims")
        try:
            issued_at = int(payload.get("iat", 0))
            expires_at = int(payload.get("exp", 0))
        except (TypeError, ValueError) as error:
            raise AuthError("Invalid access token timestamps") from error
        now = int(time.time())
        if issued_at <= 0 or issued_at > now + 60 or expires_at <= issued_at:
            raise AuthError("Invalid access token timestamps")
        if expires_at <= now:
            raise AuthError("Access token expired")
        return payload


class MemoryBetaStore:
    def __init__(self) -> None:
        self.users: dict[str, dict[str, Any]] = {}
        self.sessions: dict[str, dict[str, Any]] = {}
        self.decisions: dict[str, dict[str, Any]] = {}
        self.feedback: dict[str, dict[str, Any]] = {}
        self.product_events: dict[str, dict[str, Any]] = {}
        self.lock = threading.RLock()

    def upsert_user(self, google_subject: str, email: str, name: str) -> dict[str, Any]:
        user_id = hashlib.sha256(f"google:{google_subject}".encode()).hexdigest()[:32]
        with self.lock:
            existing = self.users.get(user_id, {})
            user = {
                "id": user_id,
                "google_subject": google_subject,
                "email": email,
                "name": name,
                "revoked": bool(existing.get("revoked", False)),
                "created_at": existing.get("created_at", _utc_iso()),
            }
            self.users[user_id] = user
            return dict(user)

    def get_user(self, user_id: str) -> dict[str, Any] | None:
        with self.lock:
            value = self.users.get(user_id)
            return dict(value) if value else None

    def create_session(self, user_id: str, refresh_hash: str, expires_at: float, session_id: str | None = None) -> str:
        session_id = session_id or uuid.uuid4().hex
        with self.lock:
            self.sessions[session_id] = {
                "id": session_id,
                "user_id": user_id,
                "refresh_hash": refresh_hash,
                "previous_hash": "",
                "expires_at": expires_at,
                "revoked": False,
            }
        return session_id

    def session_active(self, session_id: str, user_id: str) -> bool:
        with self.lock:
            session = self.sessions.get(session_id)
            user = self.users.get(user_id)
            return bool(
                session and user and session["user_id"] == user_id and not session["revoked"]
                and not user["revoked"] and session["expires_at"] > time.time()
            )

    def rotate_refresh(self, session_id: str, presented_hash: str, replacement_hash: str, expires_at: float) -> str:
        with self.lock:
            session = self.sessions.get(session_id)
            if not session or session["revoked"] or session["expires_at"] <= time.time():
                raise AuthError("Refresh session is expired or revoked")
            if hmac.compare_digest(presented_hash, session.get("previous_hash", "")):
                session["revoked"] = True
                raise AuthError("Refresh token reuse detected; session revoked")
            if not hmac.compare_digest(presented_hash, session["refresh_hash"]):
                raise AuthError("Invalid refresh token")
            session["previous_hash"] = session["refresh_hash"]
            session["refresh_hash"] = replacement_hash
            session["expires_at"] = expires_at
            return session["user_id"]

    def revoke_session(self, session_id: str) -> None:
        with self.lock:
            if session_id in self.sessions:
                self.sessions[session_id]["revoked"] = True

    def revoke_user(self, user_id: str) -> None:
        with self.lock:
            if user_id in self.users:
                self.users[user_id]["revoked"] = True
            for session in self.sessions.values():
                if session["user_id"] == user_id:
                    session["revoked"] = True

    def delete_user(self, user_id: str) -> None:
        with self.lock:
            self.users.pop(user_id, None)
            self.sessions = {key: value for key, value in self.sessions.items() if value["user_id"] != user_id}
            decision_ids = {key for key, value in self.decisions.items() if value.get("userId") == user_id}
            self.decisions = {key: value for key, value in self.decisions.items() if key not in decision_ids}
            self.feedback = {key: value for key, value in self.feedback.items() if value.get("userId") != user_id}

    def save_decision(self, decision: dict[str, Any]) -> None:
        with self.lock:
            self.decisions[decision["decisionId"]] = json.loads(json.dumps(decision))

    def get_decision(self, decision_id: str) -> dict[str, Any] | None:
        with self.lock:
            value = self.decisions.get(decision_id)
            return json.loads(json.dumps(value)) if value else None

    def save_feedback(self, feedback: dict[str, Any]) -> None:
        with self.lock:
            self.feedback[feedback["feedbackId"]] = json.loads(json.dumps(feedback))

    def save_product_events(self, installation_hash: str, events: list[dict[str, Any]]) -> dict[str, int]:
        accepted = 0
        duplicate = 0
        with self.lock:
            for event in events:
                event_id = event["eventId"]
                if event_id in self.product_events:
                    duplicate += 1
                    continue
                self.product_events[event_id] = {"installationHash": installation_hash, **json.loads(json.dumps(event))}
                accepted += 1
            while len(self.product_events) > 5000:
                self.product_events.pop(next(iter(self.product_events)))
        return {"accepted": accepted, "duplicate": duplicate}

    def delete_product_events(self, installation_hash: str) -> int:
        with self.lock:
            before = len(self.product_events)
            self.product_events = {
                key: value for key, value in self.product_events.items()
                if value.get("installationHash") != installation_hash
            }
            return before - len(self.product_events)


class PostgresBetaStore(MemoryBetaStore):
    """Managed-Postgres persistence. In-memory maps retain only transient media jobs."""

    def __init__(self, database_url: str) -> None:
        super().__init__()
        try:
            import psycopg
        except ImportError as error:
            raise RuntimeError("psycopg is required when DATABASE_URL is configured") from error
        self.psycopg = psycopg
        self.database_url = database_url
        self._initialize()

    def _connect(self):
        return self.psycopg.connect(self.database_url)

    def _initialize(self) -> None:
        statements = """
        CREATE TABLE IF NOT EXISTS beta_users (
          id TEXT PRIMARY KEY, google_subject TEXT UNIQUE NOT NULL, email TEXT NOT NULL,
          display_name TEXT NOT NULL, revoked BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS beta_sessions (
          id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES beta_users(id) ON DELETE CASCADE,
          refresh_hash TEXT NOT NULL, previous_hash TEXT NOT NULL DEFAULT '',
          expires_at TIMESTAMPTZ NOT NULL, revoked BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS beta_decisions (
          id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES beta_users(id) ON DELETE CASCADE,
          content_key TEXT NOT NULL, platform TEXT NOT NULL, model_bundle_version TEXT,
          outcome JSONB NOT NULL, feedback_state TEXT NOT NULL DEFAULT 'none',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL
        );
        CREATE TABLE IF NOT EXISTS beta_feedback (
          id TEXT PRIMARY KEY, decision_id TEXT NOT NULL REFERENCES beta_decisions(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES beta_users(id) ON DELETE CASCADE,
          payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          expires_at TIMESTAMPTZ NOT NULL
        );
        CREATE TABLE IF NOT EXISTS product_events (
          id TEXT PRIMARY KEY, installation_hash TEXT NOT NULL, session_hash TEXT NOT NULL,
          schema_version INTEGER NOT NULL, event_name TEXT NOT NULL, extension_version TEXT NOT NULL,
          attributes JSONB NOT NULL, occurred_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL
        );
        CREATE INDEX IF NOT EXISTS product_events_installation_hash_idx ON product_events (installation_hash);
        CREATE INDEX IF NOT EXISTS product_events_expires_at_idx ON product_events (expires_at);
        """
        with self._connect() as connection:
            with connection.cursor() as cursor:
                cursor.execute(statements)

    def upsert_user(self, google_subject: str, email: str, name: str) -> dict[str, Any]:
        user_id = hashlib.sha256(f"google:{google_subject}".encode()).hexdigest()[:32]
        with self._connect() as connection, connection.cursor() as cursor:
            cursor.execute(
                """INSERT INTO beta_users (id,google_subject,email,display_name) VALUES (%s,%s,%s,%s)
                ON CONFLICT (google_subject) DO UPDATE SET email=EXCLUDED.email,display_name=EXCLUDED.display_name
                RETURNING id,google_subject,email,display_name,revoked,created_at""",
                (user_id, google_subject, email, name),
            )
            row = cursor.fetchone()
        return {"id": row[0], "google_subject": row[1], "email": row[2], "name": row[3], "revoked": row[4], "created_at": row[5].isoformat()}

    def get_user(self, user_id: str) -> dict[str, Any] | None:
        with self._connect() as connection, connection.cursor() as cursor:
            cursor.execute("SELECT id,google_subject,email,display_name,revoked,created_at FROM beta_users WHERE id=%s", (user_id,))
            row = cursor.fetchone()
        return None if row is None else {"id": row[0], "google_subject": row[1], "email": row[2], "name": row[3], "revoked": row[4], "created_at": row[5].isoformat()}

    def create_session(self, user_id: str, refresh_hash: str, expires_at: float, session_id: str | None = None) -> str:
        session_id = session_id or uuid.uuid4().hex
        with self._connect() as connection, connection.cursor() as cursor:
            cursor.execute(
                "INSERT INTO beta_sessions (id,user_id,refresh_hash,expires_at) VALUES (%s,%s,%s,to_timestamp(%s))",
                (session_id, user_id, refresh_hash, expires_at),
            )
        return session_id

    def session_active(self, session_id: str, user_id: str) -> bool:
        with self._connect() as connection, connection.cursor() as cursor:
            cursor.execute(
                """SELECT 1 FROM beta_sessions s JOIN beta_users u ON u.id=s.user_id
                WHERE s.id=%s AND s.user_id=%s AND NOT s.revoked AND NOT u.revoked AND s.expires_at>now()""",
                (session_id, user_id),
            )
            return cursor.fetchone() is not None

    def rotate_refresh(self, session_id: str, presented_hash: str, replacement_hash: str, expires_at: float) -> str:
        reused = False
        user_id = ""
        with self._connect() as connection, connection.cursor() as cursor:
            cursor.execute("SELECT user_id,refresh_hash,previous_hash,revoked,expires_at>now() FROM beta_sessions WHERE id=%s FOR UPDATE", (session_id,))
            row = cursor.fetchone()
            if not row or row[3] or not row[4]:
                raise AuthError("Refresh session is expired or revoked")
            if row[2] and hmac.compare_digest(presented_hash, row[2]):
                cursor.execute("UPDATE beta_sessions SET revoked=TRUE WHERE id=%s", (session_id,))
                reused = True
            elif not hmac.compare_digest(presented_hash, row[1]):
                raise AuthError("Invalid refresh token")
            else:
                cursor.execute(
                    "UPDATE beta_sessions SET previous_hash=refresh_hash,refresh_hash=%s,expires_at=to_timestamp(%s) WHERE id=%s",
                    (replacement_hash, expires_at, session_id),
                )
                user_id = row[0]
        if reused:
            raise AuthError("Refresh token reuse detected; session revoked")
        return user_id

    def revoke_session(self, session_id: str) -> None:
        with self._connect() as connection, connection.cursor() as cursor:
            cursor.execute("UPDATE beta_sessions SET revoked=TRUE WHERE id=%s", (session_id,))

    def revoke_user(self, user_id: str) -> None:
        with self._connect() as connection, connection.cursor() as cursor:
            cursor.execute("UPDATE beta_users SET revoked=TRUE WHERE id=%s", (user_id,))
            cursor.execute("UPDATE beta_sessions SET revoked=TRUE WHERE user_id=%s", (user_id,))

    def delete_user(self, user_id: str) -> None:
        with self._connect() as connection, connection.cursor() as cursor:
            cursor.execute("DELETE FROM beta_users WHERE id=%s", (user_id,))

    def save_decision(self, decision: dict[str, Any]) -> None:
        with self._connect() as connection, connection.cursor() as cursor:
            cursor.execute("DELETE FROM beta_feedback WHERE expires_at<=now()")
            cursor.execute("DELETE FROM beta_decisions WHERE expires_at<=now()")
            cursor.execute(
                """INSERT INTO beta_decisions (id,user_id,content_key,platform,model_bundle_version,outcome,expires_at)
                VALUES (%s,%s,%s,%s,%s,%s::jsonb,now()+interval '30 days')
                ON CONFLICT (id) DO UPDATE SET model_bundle_version=EXCLUDED.model_bundle_version,outcome=EXCLUDED.outcome""",
                (decision["decisionId"], decision["userId"], decision["contentKey"], decision["platform"], decision.get("modelBundleVersion"), json.dumps(decision)),
            )

    def get_decision(self, decision_id: str) -> dict[str, Any] | None:
        with self._connect() as connection, connection.cursor() as cursor:
            cursor.execute("SELECT outcome FROM beta_decisions WHERE id=%s AND expires_at>now()", (decision_id,))
            row = cursor.fetchone()
        return None if row is None else dict(row[0])

    def save_feedback(self, feedback: dict[str, Any]) -> None:
        with self._connect() as connection, connection.cursor() as cursor:
            cursor.execute("DELETE FROM beta_feedback WHERE expires_at<=now()")
            cursor.execute("DELETE FROM beta_decisions WHERE expires_at<=now()")
            cursor.execute(
                """INSERT INTO beta_feedback (id,decision_id,user_id,payload,expires_at)
                VALUES (%s,%s,%s,%s::jsonb,now()+interval '90 days')""",
                (feedback["feedbackId"], feedback["decisionId"], feedback["userId"], json.dumps(feedback)),
            )
            cursor.execute("UPDATE beta_decisions SET feedback_state=%s WHERE id=%s", (feedback["kind"], feedback["decisionId"]))

    def save_product_events(self, installation_hash: str, events: list[dict[str, Any]]) -> dict[str, int]:
        accepted = 0
        duplicate = 0
        with self._connect() as connection, connection.cursor() as cursor:
            cursor.execute("DELETE FROM product_events WHERE expires_at<=now()")
            for event in events:
                cursor.execute(
                    """INSERT INTO product_events
                    (id,installation_hash,session_hash,schema_version,event_name,extension_version,attributes,occurred_at,expires_at)
                    VALUES (%s,%s,%s,%s,%s,%s,%s::jsonb,%s::timestamptz,now()+(%s * interval '1 day'))
                    ON CONFLICT (id) DO NOTHING""",
                    (
                        event["eventId"], installation_hash, event["sessionHash"], event["schemaVersion"],
                        event["eventName"], event["extensionVersion"], json.dumps(event["attributes"]),
                        event["occurredAt"], PRODUCT_EVENT_RETENTION_DAYS,
                    ),
                )
                if cursor.rowcount == 1:
                    accepted += 1
                else:
                    duplicate += 1
        return {"accepted": accepted, "duplicate": duplicate}

    def delete_product_events(self, installation_hash: str) -> int:
        with self._connect() as connection, connection.cursor() as cursor:
            cursor.execute("DELETE FROM product_events WHERE installation_hash=%s", (installation_hash,))
            return max(0, int(cursor.rowcount or 0))


class GoogleOidc:
    def __init__(
        self,
        client_id: str,
        token_exchange: Callable[[dict[str, str]], dict[str, Any]] | None = None,
        verifier: Callable[..., dict[str, Any]] | None = None,
        allowed_extension_ids: set[str] | None = None,
    ) -> None:
        self.client_id = client_id
        self.token_exchange = token_exchange or self._exchange
        self.verifier = verifier
        self.allowed_extension_ids = set(allowed_extension_ids or ())

    def _exchange(self, fields: dict[str, str]) -> dict[str, Any]:
        request = Request(
            "https://oauth2.googleapis.com/token",
            data=urlencode(fields).encode("utf-8"),
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            method="POST",
        )
        with urlopen(request, timeout=20) as response:
            return json.loads(response.read().decode("utf-8"))

    def authenticate(self, body: dict[str, Any]) -> dict[str, str]:
        code = str(body.get("code") or "")
        verifier = str(body.get("codeVerifier") or "")
        redirect_uri = str(body.get("redirectUri") or "")
        expected_nonce = str(body.get("nonce") or "")
        if not code or len(verifier) < 43 or not expected_nonce:
            raise AuthError("OAuth code, PKCE verifier, and nonce are required")
        redirect = urlparse(redirect_uri)
        host = (redirect.hostname or "").lower()
        extension_match = re.fullmatch(r"([a-p]{32})\.chromiumapp\.org", host)
        try:
            redirect_port = redirect.port
        except ValueError as error:
            raise AuthError("OAuth redirect URI is malformed") from error
        if (
            redirect.scheme != "https"
            or extension_match is None
            or redirect_port is not None
            or redirect.path != "/oauth2"
            or redirect.query
            or redirect.fragment
            or redirect.username is not None
            or redirect.password is not None
        ):
            raise AuthError("OAuth redirect URI is not a Chrome extension redirect")
        extension_id = extension_match.group(1)
        if self.allowed_extension_ids and extension_id not in self.allowed_extension_ids:
            raise AuthError("OAuth redirect URI is not registered for this Orislop release")
        token_payload = self.token_exchange({
            "code": code,
            "client_id": self.client_id,
            "redirect_uri": redirect_uri,
            "grant_type": "authorization_code",
            "code_verifier": verifier,
        })
        id_token_value = str(token_payload.get("id_token") or "")
        if not id_token_value:
            raise AuthError("Google did not return an ID token")
        if self.verifier is not None:
            claims = self.verifier(id_token_value, self.client_id)
        else:
            try:
                from google.auth.transport import requests as google_requests
                from google.oauth2 import id_token
            except ImportError as error:
                raise RuntimeError("google-auth is required for Google sign-in") from error
            claims = id_token.verify_oauth2_token(id_token_value, google_requests.Request(), self.client_id)
        if claims.get("iss") not in {"accounts.google.com", "https://accounts.google.com"}:
            raise AuthError("Invalid Google token issuer")
        if claims.get("aud") != self.client_id or int(claims.get("exp", 0)) <= int(time.time()):
            raise AuthError("Google ID token is expired or for a different client")
        if not hmac.compare_digest(str(claims.get("nonce") or ""), expected_nonce):
            raise AuthError("Google ID token nonce mismatch")
        if claims.get("email_verified") is not True:
            raise AuthError("A verified Google account is required")
        return {
            "subject": str(claims["sub"]),
            "email": str(claims["email"]),
            "name": str(claims.get("name") or claims["email"]),
        }


class AuthManager:
    def __init__(self, store: MemoryBetaStore, google_oidc: GoogleOidc, token_secret: str) -> None:
        self.store = store
        self.google_oidc = google_oidc
        self.tokens = AccessTokens(token_secret)
        self.refresh_pepper = hashlib.sha256((token_secret + ":refresh").encode()).digest()

    def _refresh_hash(self, token: str) -> str:
        return hmac.new(self.refresh_pepper, token.encode("utf-8"), hashlib.sha256).hexdigest()

    def _new_refresh(self, session_id: str) -> str:
        return f"{session_id}.{secrets.token_urlsafe(48)}"

    def google_login(self, body: dict[str, Any]) -> dict[str, Any]:
        identity = self.google_oidc.authenticate(body)
        user = self.store.upsert_user(identity["subject"], identity["email"], identity["name"])
        if user["revoked"]:
            raise AuthError("This beta account has been revoked")
        session_id = uuid.uuid4().hex
        refresh = self._new_refresh(session_id)
        self.store.create_session(
            user["id"], self._refresh_hash(refresh), time.time() + REFRESH_TOKEN_SECONDS, session_id=session_id
        )
        access, expires_in = self.tokens.issue(user["id"], session_id)
        return {"accessToken": access, "expiresIn": expires_in, "refreshToken": refresh, "user": public_user(user)}

    def refresh(self, refresh_token: str) -> dict[str, Any]:
        session_id, separator, _ = refresh_token.partition(".")
        if not separator or not session_id:
            raise AuthError("Malformed refresh token")
        replacement = self._new_refresh(session_id)
        user_id = self.store.rotate_refresh(
            session_id,
            self._refresh_hash(refresh_token),
            self._refresh_hash(replacement),
            time.time() + REFRESH_TOKEN_SECONDS,
        )
        user = self.store.get_user(user_id)
        if not user or user["revoked"]:
            raise AuthError("Account is unavailable")
        access, expires_in = self.tokens.issue(user_id, session_id)
        return {"accessToken": access, "expiresIn": expires_in, "refreshToken": replacement, "user": public_user(user)}

    def authenticate_access(self, authorization: str) -> dict[str, Any]:
        if not authorization.startswith("Bearer "):
            raise AuthError("Access token required")
        claims = self.tokens.verify(authorization[7:].strip())
        if not self.store.session_active(str(claims["sid"]), str(claims["sub"])):
            raise AuthError("Session is expired or revoked")
        user = self.store.get_user(str(claims["sub"]))
        if not user:
            raise AuthError("Account not found")
        return {"claims": claims, "user": user}

    def logout(self, session_id: str) -> None:
        self.store.revoke_session(session_id)


def public_user(user: dict[str, Any]) -> dict[str, Any]:
    return {"id": user["id"], "email": user["email"], "name": user["name"]}


class CandidateQuota:
    def __init__(self) -> None:
        self.minute: dict[str, deque[float]] = defaultdict(deque)
        self.day: dict[tuple[str, str], int] = defaultdict(int)
        self.lock = threading.Lock()

    def consume(self, user_id: str) -> dict[str, int]:
        now = time.time()
        day_key = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        with self.lock:
            window = self.minute[user_id]
            while window and now - window[0] >= 60:
                window.popleft()
            if len(window) >= PER_MINUTE_CANDIDATES:
                raise QuotaError("30-candidate per-minute quota exceeded")
            if self.day[(user_id, day_key)] >= PER_DAY_CANDIDATES:
                raise QuotaError("500-candidate daily quota exceeded")
            window.append(now)
            self.day[(user_id, day_key)] += 1
            return {
                "minuteRemaining": PER_MINUTE_CANDIDATES - len(window),
                "dayRemaining": PER_DAY_CANDIDATES - self.day[(user_id, day_key)],
            }

    def status(self, user_id: str) -> dict[str, int]:
        now = time.time()
        day_key = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        with self.lock:
            window = self.minute[user_id]
            while window and now - window[0] >= 60:
                window.popleft()
            return {
                "minuteRemaining": max(0, PER_MINUTE_CANDIDATES - len(window)),
                "dayRemaining": max(0, PER_DAY_CANDIDATES - self.day[(user_id, day_key)]),
            }


class RolloutGuard:
    def __init__(self) -> None:
        self.jobs: deque[dict[str, Any]] = deque(maxlen=100)
        self.hides: deque[bool] = deque(maxlen=100)
        self.wrong_hide_times: deque[float] = deque()
        self.forced_shadow_reason = ""
        self.lock = threading.Lock()

    def record_job(self, *, latency_ms: int, failed: bool = False, oom: bool = False) -> None:
        with self.lock:
            self.jobs.append({"latency_ms": latency_ms, "failed": failed or oom})
            if len(self.jobs) == 100:
                failures = sum(1 for job in self.jobs if job["failed"])
                warm_latencies = sorted(job["latency_ms"] for job in self.jobs if not job["failed"])
                p95 = warm_latencies[min(len(warm_latencies) - 1, math.ceil(len(warm_latencies) * 0.95) - 1)] if warm_latencies else 999999
                if failures / 100 > 0.05:
                    self.forced_shadow_reason = "GPU OOM/5xx exceeded 5% over 100 jobs"
                elif p95 > 5000:
                    self.forced_shadow_reason = "Warm P95 exceeded five seconds over 100 jobs"

    def record_hide_feedback(self, revealed: bool, confirmed_wrong: bool) -> None:
        now = time.time()
        with self.lock:
            self.hides.append(revealed)
            if len(self.hides) == 100 and sum(self.hides) / 100 > 0.20:
                self.forced_shadow_reason = "Reveal-after-hide exceeded 20% over 100 hides"
            if confirmed_wrong:
                self.wrong_hide_times.append(now)
                while self.wrong_hide_times and now - self.wrong_hide_times[0] > 24 * 60 * 60:
                    self.wrong_hide_times.popleft()
                if len(self.wrong_hide_times) >= 5:
                    self.forced_shadow_reason = "Five confirmed wrong-hide reports arrived within 24 hours"

    def state(self) -> dict[str, Any]:
        with self.lock:
            return {"forcedShadow": bool(self.forced_shadow_reason), "reason": self.forced_shadow_reason}


@dataclass
class PendingDecision:
    user_id: str
    platform: str
    candidate: dict[str, Any]
    content_key: str
    submitted_at: float


class CloudBetaController:
    def __init__(self, store: MemoryBetaStore, content_secret: str) -> None:
        self.store = store
        self.content_secret = content_secret.encode("utf-8")
        self.pending: dict[str, PendingDecision] = {}
        self.quota = CandidateQuota()
        self.guard = RolloutGuard()
        self.lock = threading.Lock()

    def _content_key(self, platform: str, item_identifier: str) -> str:
        return hmac.new(self.content_secret, f"{platform}:{item_identifier}".encode(), hashlib.sha256).hexdigest()

    def analyze(self, user_id: str, body: dict[str, Any], service: Any, direct_media_validator: Callable[[str], bool]) -> dict[str, Any]:
        platform = str(body.get("platform") or "").lower()
        item_identifier = str(body.get("itemIdentifier") or "")[:300]
        media_url = str(body.get("directMediaUrl") or "")[:4000]
        if platform not in SUPPORTED_PLATFORMS or not item_identifier:
            raise ValueError("platform and itemIdentifier are required")
        if not direct_media_validator(media_url):
            raise ValueError("An approved, unexpired direct media URL is required")
        quota = self.quota.consume(user_id)
        decision_id = uuid.uuid4().hex
        priority = 0 if str(body.get("priority") or "current").lower() in {"current", "0", "high"} else 10
        candidate = {
            "id": decision_id,
            "url": "",
            "mediaUrl": media_url,
            "language": str(body.get("language") or "unknown")[:20],
            "priority": priority,
        }
        pending = PendingDecision(user_id, platform, candidate, self._content_key(platform, item_identifier), time.time())
        with self.lock:
            self.pending[decision_id] = pending
        result = service.submit([candidate], "heavy")[0]
        response = self._format(decision_id, pending, result)
        self.store.save_decision(response)
        return {**response, "quota": quota}

    def analyze_batch(
        self,
        user_id: str,
        body: dict[str, Any],
        service: Any,
        direct_media_validator: Callable[[str], bool],
    ) -> dict[str, Any]:
        candidates = body.get("candidates")
        if not isinstance(candidates, list) or not 1 <= len(candidates) <= MAX_ANALYZE_BATCH_SIZE:
            raise ValueError(f"candidates must contain 1 to {MAX_ANALYZE_BATCH_SIZE} items")
        results: list[dict[str, Any]] = []
        for raw in candidates:
            if not isinstance(raw, dict):
                results.append({"clientId": "", "status": "unavailable", "error": "Candidate must be an object"})
                continue
            client_id = str(raw.get("clientId") or "")[:80]
            try:
                result = self.analyze(user_id, raw, service, direct_media_validator)
                results.append({"clientId": client_id, **result})
            except (QuotaError, ValueError) as error:
                results.append({
                    "clientId": client_id,
                    "status": "unavailable",
                    "automaticSkipEligible": False,
                    "error": str(error)[:240],
                })
        return {"results": results, "quota": self.quota.status(user_id)}

    def get_analysis(self, user_id: str, decision_id: str, service: Any) -> dict[str, Any]:
        stored = self.store.get_decision(decision_id)
        if not stored or stored.get("userId") != user_id:
            raise ValueError("Decision not found")
        with self.lock:
            pending = self.pending.get(decision_id)
        if pending is None:
            if stored.get("status") in {"pending", "provisional"}:
                interrupted = {
                    **stored,
                    "status": "error",
                    "automaticSkipEligible": False,
                    "rolloutMode": "shadow",
                    "fallbackActive": True,
                    "reason": "Cloud Heavy analysis was interrupted; Local Fast remained active",
                    "shadowFallbackReason": "Analysis worker restarted before completion; resubmit the item",
                }
                self.store.save_decision(interrupted)
                return interrupted
            return stored
        result = service.submit([pending.candidate], "heavy")[0]
        response = self._format(decision_id, pending, result)
        if result.get("status") in {"ready", "error"}:
            with self.lock:
                self.pending.pop(decision_id, None)
            latency = response["latency"]["completionMs"]
            cloud_error = result.get("cloudHeavy", {}) if isinstance(result.get("cloudHeavy"), dict) else {}
            error_text = f"{result.get('error') or ''} {cloud_error.get('error') or ''}".lower()
            failed = result.get("status") == "error" or cloud_error.get("available") is False
            self.guard.record_job(latency_ms=latency, failed=failed, oom="out of memory" in error_text or "oom" in error_text)
        self.store.save_decision(response)
        return response

    def _format(self, decision_id: str, pending: PendingDecision, result: dict[str, Any]) -> dict[str, Any]:
        guard_state = self.guard.state()
        automatic = bool(result.get("automaticSkipEligible")) and not guard_state["forcedShadow"]
        rollout = "shadow" if guard_state["forcedShadow"] else result.get("rolloutMode", "shadow")
        completion_ms = round((time.time() - pending.submitted_at) * 1000)
        return {
            "decisionId": decision_id,
            "userId": pending.user_id,
            "contentKey": pending.content_key,
            "platform": pending.platform,
            "status": result.get("status", "pending"),
            "modelBundleVersion": result.get("modelBundleVersion"),
            "spatialFamilyProbability": result.get("spatialFamilyProbability"),
            "componentSpatialScores": result.get("componentSpatialScores"),
            "motionProbability": result.get("motionProbability"),
            "thresholds": result.get("thresholds"),
            "consensusBasis": result.get("consensusBasis"),
            "rolloutMode": rollout,
            "latency": {"completionMs": completion_ms},
            "automaticSkipEligible": automatic,
            "synthetic": bool(result.get("synthetic")),
            "reason": result.get("reason", "Cloud Heavy analysis pending"),
            "fallbackActive": (
                result.get("status") == "error"
                or (isinstance(result.get("cloudHeavy"), dict) and result["cloudHeavy"].get("available") is False)
            ),
            "shadowFallbackReason": guard_state["reason"],
            "createdAt": _utc_iso(pending.submitted_at),
        }

    def feedback(
        self,
        user_id: str,
        body: dict[str, Any],
        diagnostic_promoter: Callable[[str, str], dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        decision_id = str(body.get("decisionId") or "")
        kind = str(body.get("kind") or "")[:40]
        decision = self.store.get_decision(decision_id)
        if not decision or decision.get("userId") != user_id:
            raise ValueError("Decision not found")
        if kind not in {"reveal", "undo", "correct", "wrong_hide", "wrong_keep", "report"}:
            raise ValueError("Unsupported feedback kind")
        feedback = {
            "feedbackId": uuid.uuid4().hex,
            "decisionId": decision_id,
            "userId": user_id,
            "kind": kind,
            "note": str(body.get("note") or "")[:1000],
            "createdAt": _utc_iso(),
        }
        if body.get("includeDiagnosticClip") is True:
            if kind not in {"wrong_hide", "wrong_keep", "report"}:
                raise ValueError("Diagnostic clips are allowed only for explicit error reports")
            if diagnostic_promoter is None:
                raise RuntimeError("Diagnostic clip promotion is unavailable")
            feedback["diagnosticClip"] = diagnostic_promoter(decision_id, user_id)
        self.store.save_feedback(feedback)
        if decision.get("automaticSkipEligible"):
            self.guard.record_hide_feedback(kind in {"reveal", "undo", "wrong_hide"}, kind == "wrong_hide")
        return feedback

    def product_events(self, body: dict[str, Any]) -> dict[str, Any]:
        if body.get("schemaVersion") != PRODUCT_EVENT_SCHEMA_VERSION:
            raise ValueError("Unsupported product event schema version")
        raw_events = body.get("events")
        if not isinstance(raw_events, list) or not 1 <= len(raw_events) <= MAX_PRODUCT_EVENT_BATCH_SIZE:
            raise ValueError(f"events must contain 1 to {MAX_PRODUCT_EVENT_BATCH_SIZE} items")
        installation_id = ""
        normalized: list[dict[str, Any]] = []
        now = time.time()
        for raw in raw_events:
            event = validate_product_event(raw, now)
            if not installation_id:
                installation_id = event.pop("installationId")
            elif event.get("installationId") != installation_id:
                raise ValueError("All events in a batch must use one installation identifier")
            else:
                event.pop("installationId")
            session_id = event.pop("sessionId")
            event["sessionHash"] = hmac.new(self.content_secret, f"session:{session_id}".encode(), hashlib.sha256).hexdigest()
            normalized.append(event)
        installation_hash = self.product_installation_hash(installation_id)
        result = self.store.save_product_events(installation_hash, normalized)
        return {
            **result,
            "received": len(normalized),
            "retentionDays": PRODUCT_EVENT_RETENTION_DAYS,
            "schemaVersion": PRODUCT_EVENT_SCHEMA_VERSION,
        }

    def delete_product_events(self, installation_id: str) -> int:
        if not PRODUCT_EVENT_ID.fullmatch(str(installation_id or "")):
            raise ValueError("A valid installation identifier is required")
        return self.store.delete_product_events(self.product_installation_hash(installation_id))

    def product_installation_hash(self, installation_id: str) -> str:
        return hmac.new(self.content_secret, f"installation:{installation_id}".encode(), hashlib.sha256).hexdigest()


def validate_product_event(raw: Any, now: float | None = None) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError("Each product event must be an object")
    allowed_fields = {
        "schemaVersion", "eventId", "eventName", "occurredAt", "installationId",
        "sessionId", "extensionVersion", "attributes",
    }
    if set(raw) - allowed_fields:
        raise ValueError("Product event contains unsupported fields")
    if raw.get("schemaVersion") != PRODUCT_EVENT_SCHEMA_VERSION:
        raise ValueError("Unsupported product event schema version")
    for key in ("eventId", "installationId", "sessionId"):
        if not PRODUCT_EVENT_ID.fullmatch(str(raw.get(key) or "")):
            raise ValueError(f"Invalid {key}")
    event_name = str(raw.get("eventName") or "")
    if event_name not in PRODUCT_EVENT_NAMES:
        raise ValueError("Unsupported product event name")
    occurred_at = str(raw.get("occurredAt") or "")
    try:
        occurred_timestamp = datetime.fromisoformat(occurred_at.replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError) as error:
        raise ValueError("Invalid product event timestamp") from error
    current = now or time.time()
    if occurred_timestamp < current - 7 * 24 * 60 * 60 or occurred_timestamp > current + 5 * 60:
        raise ValueError("Product event timestamp is outside the accepted window")
    extension_version = str(raw.get("extensionVersion") or "unknown")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._+\-]{0,31}", extension_version):
        raise ValueError("Invalid extension version")
    attributes = raw.get("attributes")
    if not isinstance(attributes, dict) or set(attributes) - PRODUCT_EVENT_ATTRIBUTE_FIELDS:
        raise ValueError("Product event attributes are invalid")
    normalized_attributes: dict[str, Any] = {}
    for key, value in attributes.items():
        if key == "modelIds":
            if not isinstance(value, list) or len(value) > 8:
                raise ValueError("modelIds must be a bounded array")
            models = [str(model) for model in value]
            if any(not PRODUCT_EVENT_TOKEN.fullmatch(model) for model in models):
                raise ValueError("Invalid model identifier")
            normalized_attributes[key] = models
        elif key in {"batchSize", "itemCount", "hiddenCount", "retryCount", "dedupeCount", "queueDepthBucket"}:
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= value <= 10000:
                raise ValueError(f"Invalid numeric attribute {key}")
            normalized_attributes[key] = int(value)
        else:
            token = str(value)
            if not PRODUCT_EVENT_TOKEN.fullmatch(token):
                raise ValueError(f"Invalid product event attribute {key}")
            normalized_attributes[key] = token
    return {
        "schemaVersion": PRODUCT_EVENT_SCHEMA_VERSION,
        "eventId": str(raw["eventId"]),
        "eventName": event_name,
        "occurredAt": datetime.fromtimestamp(occurred_timestamp, tz=timezone.utc).isoformat(),
        "installationId": str(raw["installationId"]),
        "sessionId": str(raw["sessionId"]),
        "extensionVersion": extension_version,
        "attributes": normalized_attributes,
    }


def build_beta_services() -> tuple[MemoryBetaStore, AuthManager, CloudBetaController] | tuple[None, None, None]:
    client_id = os.environ.get("ORISLOP_GOOGLE_OAUTH_CLIENT_ID", "").strip()
    token_secret = os.environ.get("ORISLOP_TOKEN_SECRET", "").strip()
    content_secret = os.environ.get("ORISLOP_CONTENT_HMAC_SECRET", token_secret).strip()
    if not client_id or not token_secret or not content_secret:
        return None, None, None
    database_url = os.environ.get("DATABASE_URL", "").strip()
    store: MemoryBetaStore = PostgresBetaStore(database_url) if database_url else MemoryBetaStore()
    allowed_extension_ids = {
        parsed.hostname
        for origin in os.environ.get("ORISLOP_ALLOWED_EXTENSION_ORIGINS", "").split(",")
        if (parsed := urlparse(origin.strip())).scheme == "chrome-extension"
        and parsed.hostname is not None
        and re.fullmatch(r"[a-p]{32}", parsed.hostname)
    }
    oidc = GoogleOidc(client_id, allowed_extension_ids=allowed_extension_ids)
    return store, AuthManager(store, oidc, token_secret), CloudBetaController(store, content_secret)
