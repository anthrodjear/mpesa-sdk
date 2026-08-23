"""Tests for mpesa.exceptions -- hostile-input safety and envelope parsing.

Mirrors the intent of go/errors_test.go: the wire envelope parses cleanly,
hostile bodies are sanitized to single capped lines, HTML pages yield a
diagnostic, and from_response never raises on garbage bytes.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mpesa.exceptions import MpesaError  # noqa: E402

ENVELOPE = (
    b'{"requestId":"43169-3253970-1","errorCode":"500.001.1001",'
    b'"errorMessage":"[MerchantValidate] - Wrong credentials"}'
)


def test_envelope_parse_and_str():
    err = MpesaError.from_response(500, ENVELOPE, "application/json")
    assert err.status_code == 500
    assert err.request_id == "43169-3253970-1"
    assert err.error_code == "500.001.1001"
    assert err.error_message == "[MerchantValidate] - Wrong credentials"
    rendered = str(err)
    assert rendered.startswith("mpesa: HTTP 500 ")
    assert (
        "[MerchantValidate] - Wrong credentials [500.001.1001] "
        "requestId=43169-3253970-1" in rendered
    )


def test_hostile_field_single_line_capped():
    # Control runes travel as valid JSON escapes (\u001b, \n, \x07, ZWSP);
    # after decoding they must be stripped and the field capped at 512.
    evil = "\x1b[31mred\x1b[0m\nsecond\x07line\u200b(zwsp)" + "A" * 600
    body = json.dumps({"requestId": evil}).encode("utf-8")
    err = MpesaError.from_response(400, body)
    assert err.error_code is None
    assert err.error_message is None
    rid = err.request_id
    assert rid is not None
    assert len(rid) == 512, "field must be capped at exactly 512 chars"
    for forbidden in ("\x1b", "\n", "\r", "\x07", "\u200b"):
        assert forbidden not in rid


def test_html_page_diagnostic():
    page = b"<html><body>Request blocked by WAF</body></html>"
    err = MpesaError.from_response(502, page, "text/html; charset=utf-8")
    assert err.request_id is None
    assert err.error_code is None
    msg = err.error_message or ""
    assert "text/html; charset=utf-8" in msg
    assert f"{len(page)} bytes" in msg
    assert "Request blocked by WAF" in msg
    assert str(err).startswith("mpesa: HTTP 502 unparseable error body")


def test_from_response_never_raises_on_garbage():
    cases = [
        b"",
        b"\xff\xfe\x00garbage",
        b"{not json at all",
        b"[1, 2, 3]",
        b'"plain string"',
        b'{"requestId": 123, "errorCode": null}',
        b"\xef\xbb\xbf{\"requestId\":\"bom-prefixed\"}",
        bytes(range(256)),
    ]
    for i, blob in enumerate(cases):
        err = MpesaError.from_response(400 + i, blob)
        assert isinstance(err, MpesaError)
        assert isinstance(str(err), str)
