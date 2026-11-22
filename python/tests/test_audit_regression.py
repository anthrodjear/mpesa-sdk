"""Regression pins for the cross-language audit fixes (Python side).

Every test here is deterministic and network-free: fakes mimic the wire
shapes, clocks are injected, and deadlines use ``time.monotonic()`` offsets
rather than real sleeping. Each test pins ONE fixed behaviour so a future
refactor that regresses it fails with a precise name.
"""

from __future__ import annotations

import json
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mpesa._limits import read_capped
from mpesa.auth import TokenManager
from mpesa.callbacks import StkCallbackResult
from mpesa.classification import ResultClass, classify_result_code
from mpesa.client import MpesaClient
from mpesa.config import Config
from mpesa.enums import CommandID
from mpesa.exceptions import MpesaError
from mpesa.helpers import normalize_phone
from mpesa.requests_async import B2CPayoutRequest, TransactionStatusRequest
from mpesa.requests_sync import STKPushRequest
from mpesa.responses import QRCodeResponse, STKPushResponse

T0 = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
PASSKEY = "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919"
CB = "https://mydomain.com/path"


class FakeResponse:
    """Minimal streaming fake: iter_content + close, recording closes."""

    def __init__(self, chunks=None):
        self._chunks = [b"{}"] if chunks is None else list(chunks)
        self.closed_calls = 0

    def iter_content(self, chunk_size):
        yield from self._chunks

    def close(self):
        self.closed_calls += 1


def _cfg(**over):
    base = dict(consumer_key="key", consumer_secret="secret",
                shortcode="174379", passkey=PASSKEY, now=lambda: T0)
    base.update(over)
    return Config(**base)


def _valid_stk():
    return STKPushRequest(
        transaction_type="CustomerPayBillOnline", amount=1,
        party_a="0722000000", phone_number="0722000000",
        call_back_url=CB, account_reference="Order001",
        transaction_desc="pay")


# ---- 1. log-injection: Zl/Zp stripped from MpesaError text ------------------

def test_zl_zp_separators_stripped_from_mpesa_error_text():
    """U+2028/U+2029 render as real line breaks in log viewers, so the
    sanitizer must remove them from the envelope text before it reaches
    ``__str__`` (and therefore every ``logger.exception`` on the path)."""
    body = json.dumps({
        "requestId": "r1",
        "errorCode": "500.001.1001",
        "errorMessage": "bad\u2028line\u2029para",
    }).encode()
    err = MpesaError.from_response(500, body)
    assert "\u2028" not in str(err)
    assert "\u2029" not in str(err)
    assert "\u2028" not in (err.error_message or "")
    assert "\u2029" not in (err.error_message or "")
    assert "badlinepara" in err.error_message


# ---- 2. timeout: non-finite / non-positive rejected at construction --------

@pytest.mark.parametrize("bad", [
    float("inf"), float("-inf"), float("nan"), 1e309, 0, -1,
])
def test_non_finite_and_non_positive_timeout_rejected(bad):
    """A non-finite timeout would fail deep inside socket.settimeout (or be
    silently masked); fail fast at Config->Client construction instead."""
    with pytest.raises(ValueError, match="finite positive"):
        MpesaClient(_cfg(timeout_seconds=bad))


# ---- 3. accounting: blank passkey must not spend the daily quota -----------

def test_stk_push_blank_passkey_does_not_consume_daily_quota():
    """generate_password can refuse a blank passkey; accruing before that
    fallible step spent quota even though no request was dispatched."""
    client = MpesaClient(_cfg(passkey="   ", track_daily=True))
    with pytest.raises(ValueError, match="passkey must not be empty"):
        client.stk_push(_valid_stk())
    assert client.daily_spend == {}


# ---- 4. OAuth: short-TTL cadence is below the real expiry ------------------

def test_short_ttl_cadence_is_below_ttl():
    """A 60s floor on a <=60s TTL would SERVE THE BEARER AFTER EXPIRY.
    The short-TTL branch uses half the TTL (1s minimum) instead."""
    assert TokenManager._cadence(30) == 15.0
    assert TokenManager._cadence(30) < 30
    assert TokenManager._cadence(60) == 30.0
    assert TokenManager._cadence(60) < 60


# ---- 5. decoder: non-standard NaN/Infinity literals rejected ---------------

@pytest.mark.parametrize("literal", ["NaN", "Infinity", "-Infinity"])
def test_nonstandard_json_constant_rejected_by_response_decoder(literal):
    """Python's json accepts these literals; Go/TS reject the same bytes.
    The parse_constant hook keeps nonsense out of classification/caches."""
    raw = ('{"MerchantRequestID":"m","CheckoutRequestID":"c",'
           '"ResponseCode":"0","ResponseDescription":"ok",'
           f'"CustomerMessage":{literal}}}')
    with pytest.raises(ValueError, match="non-standard JSON literal"):
        STKPushResponse.from_json(raw)


# ---- 6. decoder: long QRCode preserved verbatim ----------------------------

def test_qrcode_longer_than_4096_preserved_verbatim():
    """QRCode is an opaque data-URI/base64 payload; the generic 4096-char
    diagnostic cap would silently produce a broken QR. The 1 MiB body cap
    is the only bound needed here."""
    long_qr = "A" * 5000
    payload = {"ResponseCode": "AG_x", "RequestID": "r",
               "ResponseDescription": "ok", "QRCode": long_qr}
    resp = QRCodeResponse.from_json(payload)
    assert resp.qr_code == long_qr


# ---- 7. callbacks: bare stkCallback body (no Body wrapper) parses ----------

def test_bare_stk_callback_body_parses_without_body_wrapper():
    """Replayed captures and upstream forwarders hand us the already
    unwrapped Body.stkCallback shape; Go/TS accept it too."""
    payload = {"MerchantRequestID": "m", "CheckoutRequestID": "ws_CO_1",
               "ResultCode": "0", "ResultDesc": "ok"}
    result = StkCallbackResult.from_json(payload)
    assert result.merchant_request_id == "m"
    assert result.checkout_request_id == "ws_CO_1"
    assert result.result_code == "0"


# ---- 8. classification: exponent notation never settles --------------------

def test_exponent_notation_result_code_is_indeterminate():
    """float("0e0") == 0.0 would settle in Python; the plain-decimal gate
    keeps money-path decisions aligned with Go/TS, which reject it."""
    assert classify_result_code("0e0") is ResultClass.INDETERMINATE
    assert classify_result_code("0E0") is ResultClass.INDETERMINATE


# ---- 9. phone: length gate counts UTF-8 bytes, not code points -------------

def test_phone_length_gate_counts_utf8_bytes():
    """11 CJK chars = 33 UTF-8 bytes (> 32 gate) but only 11 code points.
    A char-count gate let this through the fail-fast check in Python only."""
    with pytest.raises(ValueError, match="too long"):
        normalize_phone("你" * 11)


# ---- 10. async requests: PartyA stored trimmed after validation ------------

def test_party_a_is_stored_trimmed_after_validation():
    """Both B2C and TransactionStatus validated a trimmed copy but shipped
    the raw untrimmed value; the normalized value must be stored back."""
    b2c = B2CPayoutRequest(
        originator_conversation_id="ocid-123", initiator_name="testapi",
        security_credential="cred", command_id=CommandID.BUSINESS_PAYMENT,
        amount=10, party_a="  600992  ", party_b="254705912645",
        remarks="ok", queue_time_out_url=CB, result_url=CB)
    b2c.validate()
    assert b2c.party_a == "600992"
    assert b2c.to_payload()["PartyA"] == "600992"

    status = TransactionStatusRequest(
        initiator="testapi", security_credential="cred",
        transaction_id="NLJ7RT61SV", party_a="  600992  ",
        remarks="status check", result_url=CB, queue_time_out_url=CB)
    status.validate()
    assert status.party_a == "600992"
    assert status.to_payload()["PartyA"] == "600992"


# ---- 11. transport: read_capped honors a total monotonic deadline ----------

def test_read_capped_deadline_is_optional_and_enforced():
    """An expired total budget raises a typed TimeoutError and still
    releases the response; an omitted or live deadline keeps the historic
    byte-cap-only behaviour intact for existing callers."""
    live = FakeResponse(chunks=[b'{"a":', b"1}"])
    assert read_capped(live, "probe response",
                       deadline=time.monotonic() + 60.0) == b'{"a":1}'
    assert live.closed_calls == 1

    legacy = FakeResponse(chunks=[b'{"b":2}'])
    assert read_capped(legacy, "probe response") == b'{"b":2}'

    expired = FakeResponse(chunks=[b"a", b"b"])
    with pytest.raises(TimeoutError, match="exceeded request deadline"):
        read_capped(expired, "probe response",
                    deadline=time.monotonic() - 1.0)
    assert expired.closed_calls == 1


class _TricklingResponse:
    """A response whose single iter_content read blocks until close().

    Models the slowloris case: the per-socket read timeout resets on every
    byte, so only a real wall-clock watchdog can interrupt the read.
    """

    def __init__(self) -> None:
        self.released = threading.Event()
        self.closed_calls = 0

    def iter_content(self, chunk_size):
        self.released.wait(5.0)
        yield b"trickle"

    def close(self) -> None:
        self.closed_calls += 1
        self.released.set()


def test_read_capped_deadline_interrupts_a_blocked_body_read():
    """The watchdog must close a trickling response at the deadline.

    Without the watchdog this test takes >5 s (the fake's own wait) and
    returns bytes instead of raising TimeoutError.
    """
    response = _TricklingResponse()
    started = time.monotonic()
    with pytest.raises(TimeoutError, match="exceeded request deadline"):
        read_capped(response, "slow response",
                    deadline=started + 0.05)
    assert time.monotonic() - started < 2.0
    assert response.closed_calls >= 1
