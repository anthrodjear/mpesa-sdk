"""Tests for mpesa.exceptions -- hostile-input safety and envelope parsing.

Mirrors the intent of go/errors_test.go: the wire envelope parses cleanly,
hostile bodies are sanitized to single capped lines, HTML pages yield a
diagnostic, and from_response never raises on garbage bytes.
"""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mpesa.coercion import coerce_str
from mpesa.exceptions import MpesaError, _envelope_value

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
    # Caller-facing text is GENERIC (go/errors.go parity): the upstream
    # body must never travel inside the exception, because any
    # logger.exception() on the path would ship it off-box.
    assert err.error_message == "unexpected error response from gateway"
    assert "WAF" not in str(err)
    assert str(err).startswith("mpesa: HTTP 502 unexpected error response")


def test_unparseable_body_diagnostics_are_opt_in_only():
    """The raw body reaches the OPT-IN logger and nothing else."""
    page = b"<html><body>Request blocked by WAF</body></html>"
    seen: list[tuple] = []

    def sink(status_code, content_type, body):
        seen.append((status_code, content_type, body))

    err = MpesaError.from_response(502, page, "text/html; charset=utf-8",
                                   error_logger=sink)
    assert "WAF" not in str(err)                     # still generic for callers
    assert seen == [(502, "text/html; charset=utf-8", page)]

    # Default (no logger): diagnostics are DISCARDED, not stashed anywhere.
    err_default = MpesaError.from_response(502, page, "text/html; charset=utf-8")
    assert err_default is not err
    assert "WAF" not in str(err_default)
    assert vars(err_default) == vars(MpesaError.from_response(502, page))


def test_error_logger_that_raises_never_masks_the_typed_error():
    def exploding_sink(status_code, content_type, body):
        raise RuntimeError("logger is down")

    err = MpesaError.from_response(500, b"<html>oops</html>", "text/html",
                                   error_logger=exploding_sink)
    assert err.status_code == 500
    assert err.error_message == "unexpected error response from gateway"


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


# ---------------------------------------------------------------------------
# Envelope members that arrive as non-strings (D1)
# ---------------------------------------------------------------------------

def test_numeric_error_code_survives_as_its_wire_string():
    """A bare-number ``errorCode`` must not be DROPPED.

    The gateway sends ``"errorCode": 401`` as a number in some captures.
    Go's ``FlexString`` (go/coercion.go:23-47) coerces it to ``"401"`` and
    TypeScript's ``coerceEnvelopeField`` (typescript/src/errors.ts:59) does
    the same, so Python dropping the member made one engine lose the
    gateway's error code while the other two kept it.

    The 401 RETRY is not what this is about: the retry probe keys on the
    DOTTED code ``"401.003.01"`` (mpesa/client.py), which a bare number
    never matched in any engine.
    """
    body = json.dumps({"requestId": "r-1", "errorCode": 401,
                       "errorMessage": "Invalid token"}).encode("utf-8")
    err = MpesaError.from_response(401, body, "application/json")
    assert err.error_code == "401"
    # The other members are untouched by the coercion.
    assert err.request_id == "r-1"
    assert err.error_message == "Invalid token"


def test_boolean_envelope_member_becomes_its_json_text():
    """``true``/``false`` are rendered as JSON text, not dropped."""
    body = json.dumps({"requestId": "r-1", "errorCode": True,
                       "errorMessage": "boom"}).encode("utf-8")
    err = MpesaError.from_response(400, body, "application/json")
    assert err.error_code == "true"

    body = json.dumps({"requestId": "r-1", "errorCode": False,
                       "errorMessage": "boom"}).encode("utf-8")
    err = MpesaError.from_response(400, body, "application/json")
    assert err.error_code == "false"


def test_null_envelope_member_counts_as_absent():
    """A JSON null is absence, not the literal text "None"."""
    body = json.dumps({"requestId": "r-1", "errorCode": None,
                       "errorMessage": "boom"}).encode("utf-8")
    err = MpesaError.from_response(400, body, "application/json")
    assert err.error_code is None
    assert err.request_id == "r-1"
    assert err.error_message == "boom"


@pytest.mark.parametrize("member", [[1, 2], {"a": 1}])
def test_non_scalar_envelope_member_counts_as_absent_while_others_survive(member):
    """An array/object member is absent; the OTHER members survive.

    This is the documented divergence with Go (see
    contract/known-divergences.md): Go's ``FlexString`` rejects an array or
    an object as a HARD error, so the WHOLE envelope is lost there, while
    Python keeps the survivors.
    """
    body = json.dumps({"requestId": "r-1", "errorCode": member,
                       "errorMessage": "boom"}).encode("utf-8")
    err = MpesaError.from_response(400, body, "application/json")
    assert err.error_code is None
    assert err.request_id == "r-1"
    assert err.error_message == "boom"


def test_envelope_coercion_agrees_with_coerce_str_on_scalars():
    """The local envelope helper and the shared coercion agree on the
    scalars listed here.

    That is the WHOLE claim: the two are not the same function, and the
    cases this test does NOT list are covered (or explicitly ruled out)
    by ``test_envelope_coercion_known_differences_from_coerce_str`` --
    the differences are pinned there, not hidden here.
    """
    cases = ["401", "Invalid token", 401, 0, 3599.0, 1.5, -7, True, False,
             None]
    for raw in cases:
        assert _envelope_value(raw) == (coerce_str(raw) or ""), raw


def test_envelope_coercion_known_differences_from_coerce_str():
    """Every known difference between the two coercions, named and pinned.

    ``coerce_str`` is the general-purpose wire-value canonicaliser;
    ``_envelope_value`` is the member-level half of the error envelope's
    contract. They are deliberately not interchangeable, so each known
    difference -- and the one case where the two now AGREE -- is
    asserted here rather than left for a reader to rediscover:

    * WHITESPACE-PADDED STRING -- ``coerce_str`` trims it, the envelope
      helper passes it through untouched (the envelope carries a trace
      id, not a canonicalisable value).
    * NON-FINITE FLOAT -- ``coerce_str`` renders NaN/Infinity as
      "nan"/"inf", the envelope helper treats the member as ABSENT so it
      can never reach the caller as text.
    * OUT-OF-MAGNITUDE INTEGRAL FLOAT -- the two AGREE ("1e+30"):
      beyond +/-2**53 both fall back to ``repr``, so the envelope never
      prints the ~19 spurious digits of ``str(int(1e30))``.
    """
    # Whitespace-padded string: the trimming difference.
    assert _envelope_value("  x  ") == "  x  "
    assert coerce_str("  x  ") == "x"

    # Non-finite float: absence in the envelope, text in coerce_str.
    assert _envelope_value(float("nan")) == ""
    assert _envelope_value(float("inf")) == ""
    assert coerce_str(float("nan")) == "nan"
    assert coerce_str(float("inf")) == "inf"

    # Out-of-magnitude integral float: the two agree on the honest
    # repr() rendering (the D1-era 31-digit expansion is gone).
    assert _envelope_value(1e30) == "1e+30"
    assert coerce_str(1e30) == "1e+30"


def test_out_of_magnitude_integral_float_is_not_expanded():
    """An integral float beyond 2**53 must not be turned into digits.

    ``str(int(1e30))`` prints 31 digits carrying ~19 spurious ones
    ("1000000000000000019884624838656") -- exactly the corruption the
    coercion module's magnitude rule exists to prevent. The envelope
    helper mirrors ``coerce_str``: within +/-2**53 the integer text is
    produced, beyond it the honest ``repr`` rendering wins.
    """
    assert _envelope_value(1e30) == "1e+30"
    assert _envelope_value(1e30) != "1000000000000000019884624838656"
    assert _envelope_value(3599.0) == "3599"
    assert _envelope_value(2 ** 53) == str(2 ** 53)

    # End to end: the member survives as its repr form, not as digits.
    body = json.dumps({"requestId": "r-1", "errorCode": 1e30,
                       "errorMessage": "boom"}).encode("utf-8")
    err = MpesaError.from_response(400, body, "application/json")
    assert err.error_code == "1e+30"
    assert err.request_id == "r-1"
    assert err.error_message == "boom"


def test_non_finite_float_member_counts_as_absent():
    """``NaN`` / ``Infinity`` are absence, not the text "nan"/"inf".

    Python's ``json`` decoder accepts the bare ``NaN``/``Infinity``
    literals (Go's and TypeScript's reject them outright), so the
    envelope helper must refuse a non-finite member itself -- the same
    defence in depth ``mpesa.results`` applies to balance floats.
    """
    for literal in ("NaN", "Infinity", "-Infinity"):
        body = ('{"requestId":"r-1","errorCode":%s,"errorMessage":"boom"}'
                % literal).encode("utf-8")
        err = MpesaError.from_response(400, body, "application/json")
        assert err.error_code is None, literal
        assert err.request_id == "r-1"
        assert err.error_message == "boom"
