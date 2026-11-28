import ipaddress
import socket
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent / "unit"))   # shared helpers (spec_bars.py)

import pytest  # noqa: E402


@pytest.fixture(autouse=True)
def _deterministic_host(monkeypatch):
    """Host-dependent code (wt.ops.host) must not change with the machine running the tests: default to the Mac's
    launchd unless a test sets WT_HOST itself. Health-check pings stay off unless a test configures them."""
    monkeypatch.setenv("WT_HOST", "launchd")
    monkeypatch.delenv("HC_PING_KEY", raising=False)
    monkeypatch.delenv("WT_ENV_FILE", raising=False)


_real_connect = socket.socket.connect
_real_connect_ex = socket.socket.connect_ex


def _loopback(address: object) -> bool:
    """A unix socket or a loopback address: the only places a unit test may connect to."""
    if not isinstance(address, tuple):
        return True                                   # AF_UNIX paths (multiprocessing, local helpers)
    host = str(address[0])
    if host in ("localhost", ""):
        return True
    try:
        return ipaddress.ip_address(host.split("%")[0]).is_loopback
    except ValueError:
        return False                                  # a host name: resolving it would already be the network


class NetworkBlocked(OSError):
    """A unit test tried to reach the network. The suite is CI-safe: fixtures and tmp_path only (AGENTS.md)."""


def _guarded_connect(self: socket.socket, address: object) -> None:
    if not _loopback(address):
        raise NetworkBlocked(f"unit tests never reach the network: connect to {address!r} refused")
    return _real_connect(self, address)


def _guarded_connect_ex(self: socket.socket, address: object) -> int:
    if not _loopback(address):
        raise NetworkBlocked(f"unit tests never reach the network: connect to {address!r} refused")
    return _real_connect_ex(self, address)


@pytest.fixture(autouse=True)
def _no_network(monkeypatch):
    """Every outbound connection but loopback fails the test that makes it, so an unmocked request is caught in CI
    instead of reaching Alpaca, ntfy or GitHub from a developer's machine."""
    monkeypatch.setattr(socket.socket, "connect", _guarded_connect)
    monkeypatch.setattr(socket.socket, "connect_ex", _guarded_connect_ex)
