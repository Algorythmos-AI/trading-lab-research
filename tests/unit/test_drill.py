"""make watchdog-drill: the client passes only when both DRILL pages (late p4, recovered p2) were sent."""
from __future__ import annotations

import pytest

from wt.ops import drill


class R:
    def __init__(self, status, body):
        self.status_code, self.ok, self.body = status, 200 <= status < 300, body

    def json(self):
        return self.body


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setenv("DASHBOARD_INGEST_URL", "https://lab.example/api/ingest")
    monkeypatch.setenv("CRON_SECRET", "c")
    monkeypatch.setenv("VERCEL_AUTOMATION_BYPASS_SECRET", "b")


def test_drill_posts_with_both_headers_and_passes_on_two_sent_pages(env, monkeypatch):
    seen = {}

    def post(url, headers, timeout):
        seen.update(url=url, headers=headers)
        return R(200, {"pages": [{"kind": "late", "priority": 4, "result": "sent"},
                                 {"kind": "recovered", "priority": 2, "result": "sent"}]})
    monkeypatch.setattr(drill.requests, "post", post)
    assert drill.main() == 0
    assert seen["url"] == "https://lab.example/api/cron/watchdog-drill"
    assert seen["headers"] == {"authorization": "Bearer c", "x-vercel-protection-bypass": "b"}


@pytest.mark.parametrize("pages", [
    [],
    [{"kind": "late", "priority": 4, "result": "sent"}],
    [{"kind": "late", "priority": 4, "result": "failed"}, {"kind": "recovered", "priority": 2, "result": "sent"}],
    [{"kind": "late", "priority": 4, "result": "skipped"}, {"kind": "recovered", "priority": 2, "result": "skipped"}],
])
def test_drill_fails_unless_both_pages_went_out(env, monkeypatch, pages):
    monkeypatch.setattr(drill.requests, "post", lambda url, headers, timeout: R(200, {"pages": pages}))
    assert drill.main() == 1


def test_drill_needs_its_configuration(monkeypatch):
    monkeypatch.delenv("CRON_SECRET", raising=False)
    monkeypatch.setenv("DASHBOARD_INGEST_URL", "https://lab.example/api/ingest")
    assert drill.main() == 2
