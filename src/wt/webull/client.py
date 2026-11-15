"""A read-only client for the Webull Australia OpenAPI (ADR 0011).

Why not the official SDK: it carries order placement, replacement and cancellation for every region, plus gRPC and
MQTT dependencies. This client is the few read requests the journal needs, signed by hand, behind one gate:

  * `_send` refuses any (method, path) not in `ALLOWED` before it builds a request, signs anything or opens a socket.
    The allowlist holds the account, balance, position and order-history reads and the two token calls. Every
    order path (preview, place, replace, cancel) is outside it, as is anything Webull adds later.
  * Only the two Webull Australia hosts are accepted (production and Webull's public test environment).
  * Credentials are never logged, never put in an exception and never in a repr. Errors carry the HTTP status and
    Webull's error code only.

Signing follows the SDK in use since 16 Oct 2026 (webull-openapi-python-sdk 3.0.4, `default_signature_composer`):
HMAC-SHA256 over the URL-encoded path, the sorted query and signing headers and, for a body, the upper-case SHA-256
hex of its compact JSON, keyed by the app secret plus "&". The AU docs' worked example still shows the older
SHA-1/MD5 variant; the text, the SDK and our own calls agree on SHA-256.

Token (2FA): the first call creates a token, which Webull holds PENDING until the owner approves it in the Webull app,
then NORMAL; it lapses after 15 days without a call. Each creation sends the owner an SMS, so an unattended job may
create one at most every `TOKEN_RETRY_S`; until it is approved the job exits with `NeedsApproval` and pages.
"""
from __future__ import annotations

import base64
import datetime as dt
import hashlib
import hmac
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

PROD_HOST = "api.webull.com.au"
TEST_HOST = "au-api.uat.webullbroker.com"        # Webull's public test environment (shared test accounts)
HOSTS = frozenset({PROD_HOST, TEST_HOST})

# The whole surface: every request this package may send. Reads, plus the two token calls 2FA needs.
ALLOWED: frozenset[tuple[str, str]] = frozenset({
    ("GET", "/trading/accounts/list"),
    ("GET", "/trading/assets/balances/get"),
    ("GET", "/trading/assets/positions/list"),
    ("GET", "/trading/orders/historical-orders/list"),
    ("GET", "/trading/orders/open-orders/list"),
    ("GET", "/trading/orders/get"),
    ("POST", "/auth/tokens/create"),
    ("POST", "/auth/tokens/check"),
})

TIMEOUT_S = 20.0
MIN_GAP_S = 1.05                 # order history allows 40 per 2 s, accounts 10 per 30 s: one call a second is safe
TOKEN_RETRY_S = 6 * 3600         # at most one new token (one SMS to the owner) per 6 hours
APPROVAL_WAIT_S = 290            # Webull expires an unapproved token after 5 minutes
CRED_KEYS = ("WEBULL_APP_KEY", "WEBULL_APP_SECRET")


class WriteRefused(RuntimeError):
    """A request outside the read-only allowlist. Raised before anything is sent."""


class WebullError(RuntimeError):
    """Webull answered with an error. Carries the HTTP status and Webull's error code, never a request detail."""

    def __init__(self, status: int, code: str = "") -> None:
        super().__init__(f"Webull HTTP {status}{f' {code}' if code else ''}")
        self.status = status
        self.code = code


class NeedsApproval(RuntimeError):
    """The token is waiting for the owner's approval in the Webull app (or a new one may not be created yet)."""


class StillWaiting(NeedsApproval):
    """A token was asked for within TOKEN_RETRY_S and not approved: the owner was told then; don't tell them again."""


@dataclass(frozen=True)
class Credentials:
    app_key: str
    app_secret: str

    def __repr__(self) -> str:                        # never print either value
        return "Credentials(<redacted>)"

    __str__ = __repr__

    @classmethod
    def from_file(cls, path: Path) -> Credentials:
        """KEY=VALUE lines (the systemd credential written by wt-set-webull-secret). Missing values raise, unnamed."""
        vals: dict[str, str] = {}
        for line in path.read_text().splitlines():
            k, sep, v = line.partition("=")
            if sep and k.strip() in CRED_KEYS:
                vals[k.strip()] = v.strip()
        missing = [k for k in CRED_KEYS if not vals.get(k)]
        if missing:
            raise ValueError(f"credential file lacks {', '.join(missing)}")
        return cls(vals["WEBULL_APP_KEY"], vals["WEBULL_APP_SECRET"])


def compact(body: Mapping[str, Any]) -> str:
    return json.dumps(body, ensure_ascii=False, separators=(",", ":"))


def sign(path: str, query: Mapping[str, str], body: str | None, app_key: str, app_secret: str, host: str,
         timestamp: str, nonce: str) -> str:
    """The x-signature value (see the module note)."""
    params = {"x-app-key": app_key, "x-signature-algorithm": "HMAC-SHA256", "x-signature-version": "1.0",
              "x-signature-nonce": nonce, "x-timestamp": timestamp, "host": host}
    for k, v in query.items():
        params[k] = f"{params[k]}&{v}" if k in params else str(v)
    text = path + "&" + "&".join(f"{k}={params[k]}" for k in sorted(params))
    if body is not None:
        text += "&" + hashlib.sha256(body.encode()).hexdigest().upper()
    encoded = urllib.parse.quote(text, safe="")
    mac = hmac.new((app_secret + "&").encode(), encoded.encode(), hashlib.sha256).digest()
    return base64.b64encode(mac).decode()


Opener = Callable[[urllib.request.Request, float], tuple[int, bytes]]


def _urlopen(req: urllib.request.Request, timeout: float) -> tuple[int, bytes]:
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:      # noqa: S310 (https only, host checked)
            return int(r.status), bytes(r.read())
    except urllib.error.HTTPError as e:
        return int(e.code), e.read()


class TokenStore:
    """The access token, as JSON in a 0600 file in the job's state directory."""

    def __init__(self, path: Path) -> None:
        self.path = path

    def load(self) -> dict[str, Any]:
        try:
            d = json.loads(self.path.read_text())
            return d if isinstance(d, dict) else {}
        except (OSError, ValueError):
            return {}

    def save(self, d: Mapping[str, Any]) -> None:
        tmp = self.path.with_suffix(".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(dict(d), f)
        os.replace(tmp, self.path)


class ReadOnlyClient:
    """The read requests the journal needs, and nothing else."""

    def __init__(self, creds: Credentials, tokens: TokenStore, host: str = PROD_HOST, opener: Opener = _urlopen,
                 clock: Callable[[], float] = time.time, sleep: Callable[[float], None] = time.sleep,
                 log: Callable[[str], None] = lambda _m: None) -> None:
        if host not in HOSTS:
            raise ValueError("not a Webull Australia host")
        self._creds, self._tokens, self._host = creds, tokens, host
        self._open, self._clock, self._sleep, self._log = opener, clock, sleep, log
        self._last = 0.0

    # ---- the gate -------------------------------------------------------------------------------------------------
    def _send(self, method: str, path: str, query: Mapping[str, str] | None = None,
              body: Mapping[str, Any] | None = None, token: str | None = None) -> Any:
        if (method, path) not in ALLOWED:
            raise WriteRefused(f"{method} {path} is not a read this client may send")
        q = {k: str(v) for k, v in (query or {}).items()}
        raw = compact(body) if body is not None else None
        for attempt in range(6):
            wait = self._last + MIN_GAP_S - self._clock()
            if wait > 0:
                self._sleep(wait)
            ts = dt.datetime.fromtimestamp(self._clock(), dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
            nonce = uuid.uuid4().hex
            headers = {"x-app-key": self._creds.app_key, "x-timestamp": ts, "x-signature-algorithm": "HMAC-SHA256",
                       "x-signature-version": "1.0", "x-signature-nonce": nonce, "x-version": "v3",
                       "x-signature": sign(path, q, raw, self._creds.app_key, self._creds.app_secret, self._host, ts, nonce)}
            if token:
                headers["x-access-token"] = token
            if raw is not None:
                headers["Content-Type"] = "application/json"
            url = f"https://{self._host}{path}" + (f"?{urllib.parse.urlencode(q)}" if q else "")
            req = urllib.request.Request(url, data=raw.encode() if raw is not None else None, method=method, headers=headers)
            status, data = self._open(req, TIMEOUT_S)
            self._last = self._clock()
            if status == 429 and attempt < 5:
                self._sleep(3.0 * (attempt + 1))
                continue
            if 200 <= status < 300:
                return json.loads(data) if data else None
            raise WebullError(status, _code(data))
        raise WebullError(429, "RATE_LIMITED")

    # ---- token ----------------------------------------------------------------------------------------------------
    def token(self) -> str:
        """An approved token: the stored one, or a new one the owner approves within APPROVAL_WAIT_S."""
        st = self._tokens.load()
        if st.get("status") == "NORMAL" and st.get("token"):
            return str(st["token"])
        if st.get("token") and st.get("status") == "PENDING" and self._clock() - float(st.get("created", 0)) < APPROVAL_WAIT_S:
            return self._await(st)
        if self._clock() - float(st.get("created", 0)) < TOKEN_RETRY_S:
            raise StillWaiting("a token was requested recently and not approved; not asking again yet")
        r = self._send("POST", "/auth/tokens/create", body={})
        st = {"token": r.get("token"), "status": r.get("status"), "created": self._clock()}
        self._tokens.save(st)
        if st["status"] == "NORMAL":
            return str(st["token"])
        self._log("webull: waiting for the owner to approve the new token in the Webull app")
        return self._await(st)

    def _await(self, st: dict[str, Any]) -> str:
        deadline = float(st.get("created", self._clock())) + APPROVAL_WAIT_S
        while self._clock() < deadline:
            r = self._send("POST", "/auth/tokens/check", body={"token": st["token"]})
            status = r.get("status")
            if status == "NORMAL":
                st = {**st, "status": "NORMAL"}
                self._tokens.save(st)
                return str(st["token"])
            if status in ("INVALID", "EXPIRED"):
                break
            self._sleep(5.0)
        self._tokens.save({**st, "status": "EXPIRED"})
        raise NeedsApproval("the token was not approved in time")

    def _read(self, path: str, query: Mapping[str, str] | None = None) -> Any:
        tok = self.token()
        try:
            return self._send("GET", path, query, token=tok)
        except WebullError as e:
            if e.status == 401 or "TOKEN" in e.code.upper():
                self._tokens.save({**self._tokens.load(), "status": "INVALID"})
            raise

    # ---- the reads ------------------------------------------------------------------------------------------------
    def accounts(self) -> list[dict[str, Any]]:
        r = self._read("/trading/accounts/list")
        return list(r) if isinstance(r, list) else []

    def balance(self, account_id: str) -> dict[str, Any]:
        r = self._read("/trading/assets/balances/get", {"account_id": account_id})
        return dict(r) if isinstance(r, dict) else {}

    def positions(self, account_id: str) -> list[dict[str, Any]]:
        r = self._read("/trading/assets/positions/list", {"account_id": account_id})
        rows = r.get("data") if isinstance(r, dict) else r
        return list(rows) if isinstance(rows, list) else []

    def order_history(self, account_id: str, start: dt.datetime, end: dt.datetime) -> list[dict[str, Any]]:
        """Order groups placed in [start, end). Webull returns at most 100; the caller slices a full answer."""
        def f(t: dt.datetime) -> str:
            return t.astimezone(dt.UTC).strftime("%Y-%m-%dT%H:%M:%S.000Z")
        r = self._read("/trading/orders/historical-orders/list",
                       {"account_id": account_id, "start_time": f(start), "end_time": f(end)})
        rows = r.get("data") if isinstance(r, dict) else r
        return list(rows) if isinstance(rows, list) else []

    def open_orders(self, account_id: str) -> list[dict[str, Any]]:
        r = self._read("/trading/orders/open-orders/list", {"account_id": account_id})
        rows = r.get("data") if isinstance(r, dict) else r
        return list(rows) if isinstance(rows, list) else []


def _code(data: bytes) -> str:
    try:
        d = json.loads(data)
    except ValueError:
        return ""
    c = d.get("error_code") if isinstance(d, dict) else None
    return c if isinstance(c, str) and c.replace("_", "").isalnum() and len(c) <= 64 else ""
