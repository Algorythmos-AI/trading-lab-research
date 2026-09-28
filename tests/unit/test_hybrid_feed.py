"""HybridFeed: SIP up to the free plan's delay, IEX after it; boundary bar de-duplicated; 403 falls back to IEX."""
import pandas as pd
import pytest
import requests

from wt.data.alpaca import HybridFeed

NOW = pd.Timestamp("2026-09-28 13:00", tz="UTC")                      # 09:00 ET


class Fake:
    def __init__(self, sip_403=False):
        self.calls, self.sip_403 = [], sip_403

    def bars(self, symbols, timeframe, start, end, feed="sip", adjustment="raw"):
        self.calls.append((feed, start, end))
        if feed == "sip" and self.sip_403:
            r = requests.Response()
            r.status_code = 403
            raise requests.HTTPError(response=r)
        t = pd.date_range(pd.Timestamp(start), pd.Timestamp(end), freq="1min")   # both ends inclusive, like Alpaca
        return pd.DataFrame({"symbol": "AA", "t": t, "o": 1.0, "h": 1.0, "l": 1.0, "c": 1.0 if feed == "sip" else 2.0,
                             "v": 100, "n": 1, "vw": 1.0})

    def news(self, *a):
        return ["passthrough"]


def feed(fake):
    return HybridFeed(fake, now=lambda: NOW)


def test_window_split_at_cutoff_and_boundary_kept_once():
    f = Fake()
    b = feed(f).bars(["AA"], "1Min", "2026-09-28T12:35:00Z", "2026-09-28T13:00:00Z", feed="hybrid")
    assert f.calls == [("sip", "2026-09-28T12:35:00Z", "2026-09-28T12:44:00Z"), ("iex", "2026-09-28T12:44:00Z", "2026-09-28T13:00:00Z")]
    assert not b.duplicated(["symbol", "t"]).any() and len(b) == 26
    assert (b[b.t <= "2026-09-28 12:44Z"].src == "sip").all() and (b[b.t > "2026-09-28 12:44Z"].src == "iex").all()


def test_old_window_is_pure_sip_and_new_window_pure_iex():
    f = Fake()
    h = feed(f)
    h.bars(["AA"], "1Min", "2026-09-28T08:00:00Z", "2026-09-28T12:00:00Z", feed="hybrid")
    assert [c[0] for c in f.calls] == ["sip"]
    f.calls.clear()
    h.bars(["AA"], "1Min", "2026-09-28T12:50:00Z", "2026-09-28T13:00:00Z", feed="hybrid")
    assert [c[0] for c in f.calls] == ["iex"] and h.sip_through is None


def test_sip_refusal_falls_back_to_iex_for_whole_window():
    f = Fake(sip_403=True)
    b = feed(f).bars(["AA"], "1Min", "2026-09-28T12:35:00Z", "2026-09-28T13:00:00Z", feed="hybrid")
    assert f.calls[-1] == ("iex", "2026-09-28T12:35:00Z", "2026-09-28T13:00:00Z") and (b.src == "iex").all()


def test_other_feeds_and_calls_pass_through():
    f = Fake()
    h = feed(f)
    h.bars(["AA"], "1Min", "2026-09-28T12:35:00Z", "2026-09-28T13:00:00Z", feed="sip")
    assert f.calls == [("sip", "2026-09-28T12:35:00Z", "2026-09-28T13:00:00Z")] and h.news() == ["passthrough"]


def test_other_http_errors_propagate():
    class Boom(Fake):
        def bars(self, *a, **k):
            r = requests.Response()
            r.status_code = 500
            raise requests.HTTPError(response=r)
    with pytest.raises(requests.HTTPError):
        feed(Boom()).bars(["AA"], "1Min", "2026-09-28T12:35:00Z", "2026-09-28T13:00:00Z", feed="hybrid")
