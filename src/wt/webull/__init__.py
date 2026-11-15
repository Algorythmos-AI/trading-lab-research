"""The owner's Webull Australia account, read only (ADR 0011).

Webull is the record of the owner's own manual trades. This package reads it and nothing else: `client` can send
only the read requests on its allowlist, `pull` runs as its own user with the key as a systemd credential, and
`journal` and `publish` turn what was read into the Trades page's journal. No module here can place, change or
cancel an order, and a test (tests/unit/test_webull_readonly.py) keeps it that way.
"""
