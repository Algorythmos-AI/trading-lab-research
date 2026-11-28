"""The suite never reaches the network (tests/conftest.py `_no_network`): an outbound connection fails the test that
makes it; loopback still works for local servers and helpers."""
import socket

import pytest
import requests


def test_an_outbound_connection_is_refused_before_anything_is_sent() -> None:
    with pytest.raises(OSError, match="never reach the network"):
        socket.create_connection(("203.0.113.7", 443), timeout=1)          # TEST-NET-3: never routed anyway


def test_requests_to_a_real_host_fail_in_the_test_not_on_the_wire() -> None:
    with pytest.raises(requests.exceptions.ConnectionError):
        requests.get("https://203.0.113.7/", timeout=1)


def test_loopback_is_still_allowed() -> None:
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)
    try:
        c = socket.create_connection(srv.getsockname(), timeout=1)
        c.close()
    finally:
        srv.close()


def test_a_name_lookup_is_refused_before_any_dns_query() -> None:
    with pytest.raises(OSError, match="name lookup"):
        socket.getaddrinfo("data.alpaca.markets", 443)
    with pytest.raises(requests.exceptions.ConnectionError):
        requests.get("https://data.alpaca.markets/v2/stocks/bars", timeout=1)
    assert socket.getaddrinfo("localhost", 80)                          # local names still resolve
