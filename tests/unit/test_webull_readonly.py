"""The Webull package reads the owner's account and can do nothing else (ADR 0011). Fixtures only, no network."""
from __future__ import annotations

import ast
import datetime as dt
import json
import re
import stat
import urllib.request
from pathlib import Path
from typing import Any

import pytest

from wt.webull import client as wc
from wt.webull import journal, publish, pull
from wt.webull.client import (ALLOWED, Credentials, NeedsApproval, ReadOnlyClient, StillWaiting, TokenStore, WriteRefused,
                              sign)

PKG = Path(wc.__file__).parent
ROOT = PKG.parents[2]
ORDER_WORDS = re.compile(r"(place|replace|cancel|preview|modify|amend)", re.I)
CREDS = Credentials("k123", "sec789-very-secret")


# ---- the signature -----------------------------------------------------------------------------------------------

def test_signature_matches_webulls_own_sdk_byte_for_byte():
    # Vectors computed with Webull's SDK 3.0.4 signature composer for the same inputs.
    args = ("k123", "sec789", "api.webull.com.au", "2026-11-15T21:00:00Z", "n456")
    q = {"account_id": "A1", "start_time": "2026-11-14T00:00:00.000Z"}
    assert sign("/trading/orders/historical-orders/list", q, None, *args) == "JBsgSNYE3ydOLIGky3zHYFljt8+TfexU4QoHJr3WnWA="
    assert sign("/auth/tokens/check", {}, '{"token":"t1"}', *args) == "9mY3mQ0Bi5d8bNdhuTc/Pzk6/Z2anHZA6UNM7B0xIL0="


# ---- nothing but reads -------------------------------------------------------------------------------------------

def test_the_allowlist_holds_reads_and_the_two_token_calls_only():
    assert {p for m, p in ALLOWED if m != "GET"} == {"/auth/tokens/create", "/auth/tokens/check"}
    assert not [p for _m, p in ALLOWED if ORDER_WORDS.search(p)]


class Recorder:
    def __init__(self, answers: list[tuple[int, Any]] | None = None) -> None:
        self.sent: list[urllib.request.Request] = []
        self.answers = list(answers or [])

    def __call__(self, req: urllib.request.Request, timeout: float) -> tuple[int, bytes]:
        self.sent.append(req)
        status, body = self.answers.pop(0) if self.answers else (200, [])
        return status, json.dumps(body).encode()


def make(tmp_path: Path, answers: list[tuple[int, Any]] | None = None, token: dict[str, Any] | None = None,
         now: float = 1_800_000_000.0) -> tuple[ReadOnlyClient, Recorder, TokenStore]:
    rec, store = Recorder(answers), TokenStore(tmp_path / "token.json")
    if token is not None:
        store.save(token)
    clock = [now]

    def sleep(s: float) -> None:
        clock[0] += s
    return ReadOnlyClient(CREDS, store, opener=rec, clock=lambda: clock[0], sleep=sleep), rec, store


@pytest.mark.parametrize("method,path", [
    ("POST", "/trading/orders/place"), ("POST", "/trading/orders/preview"), ("POST", "/trading/orders/replace"),
    ("POST", "/trading/orders/cancel"), ("GET", "/trading/orders/place"), ("POST", "/trading/accounts/list"),
    ("DELETE", "/trading/orders/get"), ("POST", "/openapi/trade/order/place"),
])
def test_an_order_request_is_refused_before_anything_is_sent(tmp_path, method, path):
    c, rec, _ = make(tmp_path, token={"token": "t", "status": "NORMAL"})
    with pytest.raises(WriteRefused):
        c._send(method, path, body={"qty": 1})
    assert rec.sent == []


def test_the_package_has_no_order_code_and_no_webull_sdk():
    for f in sorted(PKG.glob("*.py")):
        tree = ast.parse(f.read_text())
        docs = {id(n.body[0].value) for n in ast.walk(tree)
                if isinstance(n, ast.Module | ast.FunctionDef | ast.ClassDef) and n.body
                and isinstance(n.body[0], ast.Expr) and isinstance(n.body[0].value, ast.Constant)}
        for n in ast.walk(tree):
            if isinstance(n, ast.Constant) and isinstance(n.value, str) and id(n) not in docs:
                assert not re.search(r"/(trading|openapi)/\S*" + ORDER_WORDS.pattern, n.value, re.I), (f.name, n.value)
            if isinstance(n, ast.Import | ast.ImportFrom):
                names = [a.name for a in n.names] + ([n.module] if isinstance(n, ast.ImportFrom) and n.module else [])
                assert not any(x == "webull" or x.startswith("webull.") for x in names), (f.name, names)
                assert "requests" not in names or f.name == "publish.py", f.name   # only the publisher posts, to the site
    text = (PKG / "client.py").read_text()
    assert text.count("urllib.request.Request(") == 1 and text.count("urllib.request.urlopen(") == 1   # one way out, through the gate


def test_only_the_pull_job_and_the_package_use_the_client():
    users = [p for p in (ROOT / "src").rglob("*.py")
             if re.search(r"wt\.webull\.client|from wt\.webull import client", p.read_text()) and PKG not in p.parents]
    assert users == []


def test_no_webull_sdk_in_the_lockfile():
    assert not re.search(r"^webull", (ROOT / "requirements.lock.txt").read_text(), re.M | re.I)


# ---- credentials and tokens ----------------------------------------------------------------------------------------

def test_credentials_never_print_and_errors_never_carry_them(tmp_path):
    assert "sec789" not in repr(CREDS) and "sec789" not in str(CREDS) and "k123" not in repr(CREDS)
    c, _rec, _ = make(tmp_path, answers=[(401, {"error_code": "TOKEN_INVALID", "message": "sec789-very-secret"})],
                      token={"token": "t", "status": "NORMAL"})
    with pytest.raises(wc.WebullError) as e:
        c.accounts()
    assert "sec789" not in str(e.value) and e.value.code == "TOKEN_INVALID"
    assert json.loads((tmp_path / "token.json").read_text())["status"] == "INVALID"


def test_credentials_file_needs_both_values(tmp_path):
    p = tmp_path / "webull"
    p.write_text("WEBULL_APP_KEY=abc\n")
    with pytest.raises(ValueError) as e:
        Credentials.from_file(p)
    assert "abc" not in str(e.value)
    p.write_text("WEBULL_APP_KEY=abc\nWEBULL_APP_SECRET=def\nOTHER=x\n")
    assert Credentials.from_file(p).app_secret == "def"


def test_the_token_file_is_owner_only(tmp_path):
    TokenStore(tmp_path / "token.json").save({"token": "t", "status": "NORMAL"})
    assert stat.S_IMODE((tmp_path / "token.json").stat().st_mode) == 0o600


def test_the_secret_is_sent_only_as_a_signature(tmp_path):
    c, rec, _ = make(tmp_path, answers=[(200, [{"account_id": "1"}])], token={"token": "t", "status": "NORMAL"})
    c.accounts()
    req = rec.sent[0]
    assert req.full_url.startswith("https://api.webull.com.au/") and req.get_method() == "GET"
    assert "sec789" not in json.dumps(dict(req.header_items())) + req.full_url


def test_a_new_token_is_asked_for_at_most_once_in_six_hours(tmp_path):
    now = 1_800_000_000.0
    c, rec, store = make(tmp_path, answers=[(200, {"token": "new", "status": "PENDING"})] + [(200, {"status": "PENDING"})] * 80,
                         now=now)
    with pytest.raises(NeedsApproval) as e:
        c.accounts()
    assert not isinstance(e.value, StillWaiting)
    assert [r.full_url.rsplit("/", 1)[-1] for r in rec.sent].count("create") == 1
    c2, rec2, _ = make(tmp_path, now=now + 3600)
    store2 = TokenStore(tmp_path / "token.json")
    assert store2.load()["status"] == "EXPIRED"
    with pytest.raises(StillWaiting):
        c2.accounts()
    assert rec2.sent == []


def test_an_approved_token_is_kept(tmp_path):
    c, rec, store = make(tmp_path, answers=[(200, {"token": "new", "status": "PENDING"}), (200, {"status": "NORMAL"}),
                                            (200, [{"account_id": "9"}])])
    assert c.accounts() == [{"account_id": "9"}]
    assert store.load()["status"] == "NORMAL"
    assert rec.sent[-1].get_header("X-access-token") == "new"


# ---- the pull job ---------------------------------------------------------------------------------------------------

class FakeClient:
    def __init__(self, by_day: dict[dt.date, list[dict[str, Any]]]) -> None:
        self.by_day, self.calls = by_day, 0

    def accounts(self) -> list[dict[str, Any]]:
        return [{"account_id": "ACC1"}]

    def order_history(self, aid: str, a: dt.datetime, b: dt.datetime) -> list[dict[str, Any]]:
        self.calls += 1
        return [g for d, gs in self.by_day.items() for g in gs if a.date() <= d < b.date() or (a.date() == d and a < b)]

    def balance(self, aid: str) -> dict[str, Any]:
        return {"total_cash_balance": "1500", "total_market_value": "0", "account_currency_assets": [
            {"currency": "AUD", "cash_balance": "0"}, {"currency": "USD", "cash_balance": "1000"}]}

    def positions(self, aid: str) -> list[dict[str, Any]]:
        return []


def group(oid: str, side: str, price: float, at: str, sym: str = "SPY") -> dict[str, Any]:
    return {"client_order_id": f"c{oid}", "orders": [{
        "order_id": oid, "instrument_type": "OPTION", "symbol": sym, "side": side, "filled_quantity": "1",
        "filled_price": str(price), "filled_time_at": at, "place_time_at": at, "status": "FILLED",
        "legs": [{"option_type": "CALL", "strike_price": "600", "option_expire_date": at[:10]}]}]}


def test_pull_backfills_then_marks_the_history_complete(tmp_path, monkeypatch):
    monkeypatch.setattr(pull, "HISTORY_FROM", dt.date(2026, 10, 1))
    days = {dt.date(2026, 10, 14): [group("1", "BUY", 1.0, "2026-10-14T14:00:00Z"), group("2", "SELL", 1.5, "2026-10-14T14:05:00Z")]}
    fake = FakeClient(days)
    now = dt.datetime(2026, 11, 14, 23, 0, tzinfo=dt.UTC)                 # Saturday evening: the long budget
    pull.run(fake, tmp_path, now, clock=lambda: 0.0)                       # type: ignore[arg-type]
    h = json.loads((tmp_path / "history.json").read_text())
    assert h["complete"] and h["through"] == "2026-11-10"
    saved = json.loads((tmp_path / "orders" / "2026-10-14.json").read_text())
    assert [g["orders"][0]["order_id"] for g in saved] == ["1", "2"]
    assert not (tmp_path / "orders" / "2026-11-02.json").exists()          # an empty month is one probe, no files
    row = json.loads((tmp_path / "account.jsonl").read_text().splitlines()[0])
    assert "ACC1" not in json.dumps(row) and row["usd_cash"] == 1000.0
    for p in (tmp_path / "history.json", tmp_path / "account.jsonl", tmp_path / "orders" / "2026-10-14.json"):
        assert stat.S_IMODE(p.stat().st_mode) & 0o007 == 0                 # nothing for "other"


def test_pull_stops_when_the_budget_is_spent(tmp_path, monkeypatch):
    monkeypatch.setattr(pull, "HISTORY_FROM", dt.date(2026, 10, 1))
    fake = FakeClient({dt.date(2026, 10, d): [group(str(d), "BUY", 1.0, f"2026-10-{d:02d}T14:00:00Z")] for d in range(1, 31)})
    t = [0.0]

    def clock() -> float:
        t[0] += 3.0
        return t[0]
    pull.run(fake, tmp_path, dt.datetime(2026, 11, 16, 15, 0, tzinfo=dt.UTC), clock=clock)  # type: ignore[arg-type]
    h = json.loads((tmp_path / "history.json").read_text())
    assert not h["complete"] and h["through"] < "2026-10-31"


def test_main_needs_a_credential_and_says_nothing_secret(tmp_path, capsys):
    assert pull.main(["--state", str(tmp_path), "--creds", str(tmp_path / "missing")]) == 2
    assert "wt-set-webull-secret" in capsys.readouterr().out


# ---- the journal and its publisher -----------------------------------------------------------------------------------

def test_journal_matches_fifo_and_expires_a_held_option():
    gs = [group("1", "BUY", 1.0, "2026-10-14T14:00:00Z"), group("2", "BUY", 2.0, "2026-10-14T14:01:00Z"),
          group("3", "SELL", 1.5, "2026-10-14T14:05:00Z")]
    doc = journal.build(gs, dt.datetime(2026, 10, 15, 12, 0, tzinfo=dt.UTC))
    assert [(t["entry"], t["exit"], t["pnl"], t["close"]) for t in doc["trades"]] == [(1.0, 1.5, 50.0, "order"), (2.0, 0.0, -200.0, "expired")]
    assert doc["open"] == [] and doc["gaps"] == [] and doc["fills"] == 3
    assert "ACC" not in json.dumps(doc) and not any(t["id"] in ("1", "2", "3") for t in doc["trades"])


def write_src(src: Path, *, complete: bool = True, ok: bool = True) -> None:
    (src / "orders").mkdir(parents=True)
    (src / "orders" / "2026-11-13.json").write_text(json.dumps([group("1", "BUY", 1.0, "2026-11-13T15:00:00Z"),
                                                                 group("2", "SELL", 1.4, "2026-11-13T15:03:00Z")]))
    (src / "history.json").write_text(json.dumps({"from": "2023-11-01", "through": "2026-11-12", "complete": complete}))
    (src / "status.json").write_text(json.dumps({"at": "2026-11-13T21:00:00Z", "ok": ok}))
    rows = [{"at": "2026-11-13T14:00:00Z", "cash": 1400.0, "market_value": 0, "unrealized": 0, "aud_cash": 0, "usd_cash": 1000.0, "usd_market_value": 0},
            {"at": "2026-11-13T20:00:00Z", "cash": 1456.0, "market_value": 0, "unrealized": 0, "aud_cash": 0, "usd_cash": 1040.0, "usd_market_value": 0},
            {"at": "2026-11-13T20:30:00Z", "cash": 2856.0, "market_value": 0, "unrealized": 0, "aud_cash": 0, "usd_cash": 2040.0, "usd_market_value": 0}]
    (src / "account.jsonl").write_text("\n".join(json.dumps(r) for r in rows) + "\n{\"at\": cut short")


SEED = {"money": {"as_of": "2026-11-12T21:00:00Z", "currency": "AUD", "account_value": 1396.0, "cash": 1396.0,
                  "positions": 0.0, "usd_rate": 1.4, "complete_from": "2023-11-01",
                  "transfers": [{"date": "2026-10-20", "amount": -2867.0, "source": "detected"}],
                  "values": [{"date": "2026-11-12", "value": 1396.0}]}}


def test_publish_carries_the_money_history_over_and_finds_a_deposit(tmp_path):
    src, state, sent = tmp_path / "out", tmp_path / "var", []
    write_src(src)
    rc = publish.run(src, state, read_back=lambda: SEED, send=lambda b: (sent.append(json.loads(b)), (True, "HTTP 200"))[1])
    assert rc == 0 and len(sent) == 1
    doc = sent[0]
    assert doc["schema_version"] == 2 and doc["as_of"] == "2026-11-13T21:00:00Z"
    m = doc["money"]
    assert m["values"][0] == {"date": "2026-11-12", "value": 1396.0} and m["account_value"] == 2856.0
    assert [t["amount"] for t in m["transfers"]] == [-2867.0, 1400.0]    # the 40 USD trade at 1.4 is not a deposit
    # Unchanged on the next run: nothing sent, and the seed is never read twice.
    rc = publish.run(src, state, read_back=lambda: pytest.fail("seed read twice"), send=lambda b: pytest.fail("resent"))
    assert rc == 0


def test_publish_sends_nothing_without_a_full_history_a_good_read_or_the_seed(tmp_path):
    def never(_b: bytes) -> tuple[bool, str]:
        raise AssertionError("sent")
    a = tmp_path / "a"
    write_src(a / "out", complete=False)
    assert publish.run(a / "out", a / "var", read_back=lambda: SEED, send=never) == 0
    b = tmp_path / "b"
    write_src(b / "out", ok=False)
    assert publish.run(b / "out", b / "var", read_back=lambda: SEED, send=never) == 0
    c = tmp_path / "c"
    write_src(c / "out")
    assert publish.run(c / "out", c / "var", read_back=lambda: None, send=never) == 1
    assert not (c / "var" / "money_seed.json").exists()


def test_reconcile_counts_disagreements_only():
    doc = {"open": [{"symbol": "SPY", "kind": "call", "qty": 2, "side": "long"},
                    {"symbol": "TSLA", "kind": "stock", "qty": 5, "side": "long"}]}
    same = {"positions": [{"symbol": "SPY261113C00600000", "instrument_type": "OPTION", "quantity": "2"},
                          {"symbol": "TSLA", "instrument_type": "EQUITY", "quantity": "5"}]}
    assert publish.reconcile(doc, same) == 0
    assert publish.reconcile(doc, {"positions": []}) == 2


# ---- the host units ------------------------------------------------------------------------------------------------

OCI = ROOT / "deploy" / "oci"


def test_the_pull_unit_holds_the_key_alone_and_runs_locked_down():
    unit = (OCI / "systemd" / "wt-webull-pull.service").read_text()
    for needle in ("User=wt-webull", "LoadCredential=webull:/etc/wt/webull.env", "StateDirectory=wt-webull",
                   "UMask=0027", "NoNewPrivileges=yes", "ProtectSystem=strict", "CapabilityBoundingSet=\n",
                   "InaccessiblePaths=-/run/wt-secrets", "OnFailure=wt-alert@%n.service", "OnSuccess=wt-webull-publish.service",
                   "-m wt.webull.pull"):
        assert needle in unit, needle
    assert "EnvironmentFile" not in unit and "WEBULL_APP" not in unit
    pub = (OCI / "systemd" / "wt-webull-publish.service").read_text()
    assert "User=wt\n" in pub and "InaccessiblePaths=-/etc/wt/webull.env" in pub and "LoadCredential" not in pub
    assert "WEBULL" not in (OCI / "bin" / "wt-set-secrets").read_text()            # never among the shared secrets
    assert "WEBULL" not in (OCI / "bin" / "wt-fetch-secrets").read_text()


def test_the_secret_helper_hides_input_and_writes_root_only():
    sh = (OCI / "bin" / "wt-set-webull-secret").read_text()
    assert (OCI / "bin" / "wt-set-webull-secret").stat().st_mode & 0o111
    assert "read -rsp" in sh and "umask 077" in sh and "chmod 0600" in sh and "--shell /usr/sbin/nologin" in sh
    assert "echo \"$key\"" not in sh and "echo \"$secret\"" not in sh
    assert "systemctl start" not in sh.replace("then: sudo systemctl start", "")    # it starts nothing itself
    inst = (OCI / "bin" / "wt-install-units").read_text()
    assert "/etc/wt/webull.env" in inst and "wt-webull-pull.timer" in inst
