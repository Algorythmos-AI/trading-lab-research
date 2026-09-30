"""SigV4 signing for R2 is checked against AWS's published S3 example ("GET Object", bytes=0-9)."""
import datetime as dt

from wt.ops import r2


def test_sigv4_matches_the_aws_get_object_example():
    headers = r2.sign(
        "GET", "examplebucket.s3.amazonaws.com", "/test.txt", {"range": "bytes=0-9"}, r2.EMPTY_SHA256,
        "AKIAIOSFODNN7EXAMPLE", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        dt.datetime(2013, 5, 24, tzinfo=dt.UTC), region="us-east-1")
    assert headers["authorization"] == (
        "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, "
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, "
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41")


def test_conditional_headers_are_signed(monkeypatch):
    seen = {}

    class Resp:
        status_code, content = 412, b""
        headers = {"Date": "Wed, 30 Sep 2026 01:00:00 GMT", "ETag": '"x"'}

    def request(method, url, data, headers, timeout):
        seen.update(method=method, url=url, headers=headers)
        return Resp()
    monkeypatch.setattr(r2.requests, "request", request)
    c = r2.R2("acct", "ak", "sk")
    out = c.put("wt-leases", "paper-b", b"{}", if_none_match="*")
    assert out.status == 412 and out.server_time == dt.datetime(2026, 9, 30, 1, 0, tzinfo=dt.UTC)
    assert seen["url"] == "https://acct.r2.cloudflarestorage.com/wt-leases/paper-b"
    assert seen["headers"]["if-none-match"] == "*" and "if-none-match" in seen["headers"]["authorization"]
