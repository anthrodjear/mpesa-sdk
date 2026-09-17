"""Regression tests for the scoped hardening round.

Covers, per item: session-clone trust boundary (cookies/auth/proxies/
trust_env), QR caller-mutation parity, Config fail-fast (colon/ASCII),
TokenManager base_url allowlist, the shared ``mpesa._limits`` module and
its back-compat re-exports, O(1) first-wins accessors, the shared
streaming reader, the corrected Go-parity docstring, the B2C
OriginatorConversationID contract (<20 chars, required), the CJK
oversize gate, and the ``coerce_amount`` edge table.
"""

import dataclasses
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest
import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mpesa import MpesaClient  # noqa: E402
from mpesa._limits import (  # noqa: E402
    MAX_BODY_BYTES,
    check_body_size,
    read_capped,
)
from mpesa.auth import TokenManager  # noqa: E402
from mpesa.callbacks import StkCallbackResult  # noqa: E402
from mpesa.coercion import coerce_amount  # noqa: E402
from mpesa.config import Config  # noqa: E402
from mpesa.enums import CommandID, QRTrxCode  # noqa: E402
from mpesa.requests_async import B2CPayoutRequest  # noqa: E402
from mpesa.requests_sync import QRCodeRequest  # noqa: E402
from mpesa.responses import STKPushResponse  # noqa: E402
from mpesa.results import AsyncResult  # noqa: E402

T0 = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
PASSKEY = "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919"
OAUTH_OK = '{"access_token":"tok-1","expires_in":"3599"}'
QR_OK = ('{"ResponseCode":"AG_x","RequestID":"r",'
         '"ResponseDescription":"QR Code Successfully Generated",'
         '"QRCode":"imgdata"}')
CB = "https://mydomain.com/path"


class FakeResponse:
    """Minimal streaming fake: iter_content + close, recording closes."""

    def __init__(self, status_code=200, text="{}", chunks=None):
        self.status_code = status_code
        self._text = text
        self._chunks = chunks
        self.headers = {"content-type": "application/json"}
        self.closed_calls = 0

    def iter_content(self, chunk_size):
        # Pre-chunked wire streams yield verbatim (mirrors the
        # StreamOnlyResponse pattern in test_auth.py); otherwise slice the
        # encoded text. Slicing a LIST would yield lists, not bytes, so the
        # two paths must stay distinct.
        if self._chunks is not None:
            yield from self._chunks
            return
        blob = self._text.encode()
        for i in range(0, len(blob), chunk_size):
            yield blob[i:i + chunk_size]

    def close(self):
        self.closed_calls += 1


class FakeSession:
    """Duck-typed session without cookies/auth/proxies/trust_env attrs."""

    def __init__(self, queue):
        self.headers = {}
        self.adapters = {}
        self.verify = False
        self.calls = []
        self.queue = list(queue)

    def request(self, method, url, json=None, params=None, timeout=None,
                allow_redirects=True, headers=None, stream=False):
        self.calls.append({"kind": method, "url": url})
        return self.queue.pop(0)

    def get(self, url, **kwargs):
        self.calls.append({"kind": "GET", "url": url, **kwargs})
        return self.queue.pop(0)


def _b2c(**over):
    """Valid B2C payout model (OCID always in-contract)."""
    base = dict(originator_conversation_id="ocid-123",
                initiator_name="testapi", security_credential="cred",
                command_id=CommandID.BUSINESS_PAYMENT, amount=10,
                party_a="600992", party_b="254705912645", remarks="ok",
                queue_time_out_url=CB, result_url=CB)
    base.update(over)
    return B2CPayoutRequest(**base)


# ---- 1. session-clone hardening -------------------------------------------

def test_clone_isolates_cookies_auth_proxies_trust_env():
    """The clone deep-copies cookies, drops auth, snapshots proxies and
    refuses env pickup -- later caller mutations stay invisible."""
    source = requests.Session()
    source.cookies.set("sess", "caller-value")
    source.auth = ("user", "pass")
    source.proxies = {"http": "http://proxy-a:8080"}
    source.trust_env = True  # caller opts into env pickup: must not inherit
    cfg = Config(consumer_key="k", consumer_secret="s", shortcode="174379",
                 passkey=PASSKEY, now=lambda: T0, http_client=source)
    client = MpesaClient(cfg)
    clone = client._session
    assert clone is not source
    # Cookies: equal content, independent jar.
    assert clone.cookies.get("sess") == "caller-value"
    assert clone.cookies is not source.cookies
    source.cookies.set("sess", "mutated")
    assert clone.cookies.get("sess") == "caller-value"
    # Auth: ambient credential dropped on the clone, kept on the caller.
    assert clone.auth is None
    assert source.auth == ("user", "pass")
    # Proxies: snapshot, not shared.
    assert clone.proxies == {"http": "http://proxy-a:8080"}
    source.proxies["http"] = "http://evil:8080"
    assert clone.proxies == {"http": "http://proxy-a:8080"}
    # trust_env forced off (no netrc/env pickup); TLS forced on.
    assert clone.trust_env is False
    assert source.trust_env is True  # caller's own flag untouched
    assert clone.verify is True


def test_clone_tolerates_duck_typed_sessions_without_security_attrs():
    """Fakes exposing only headers/adapters/verify still clone cleanly."""
    session = FakeSession([FakeResponse(text=OAUTH_OK),
                           FakeResponse(text=QR_OK)])
    cfg = Config(consumer_key="k", consumer_secret="s", shortcode="174379",
                 passkey=PASSKEY, now=lambda: T0, http_client=session)
    client = MpesaClient(cfg)
    assert client._session.trust_env is False
    assert client._session.verify is True


# ---- 2. QR caller-mutation parity ------------------------------------------

def test_generate_qr_code_leaves_caller_object_untouched():
    """validate() normalises trx_code/cpi/size in place -- the client must
    apply that to a copy (parity with the other 8 endpoints)."""
    session = FakeSession([FakeResponse(text=OAUTH_OK),
                           FakeResponse(text=QR_OK)])
    cfg = Config(consumer_key="k", consumer_secret="s", shortcode="174379",
                 passkey=PASSKEY, now=lambda: T0, http_client=session)
    client = MpesaClient(cfg)
    req = QRCodeRequest(merchant_name="TEST SUPERMARKET", ref_no="Invoice",
                        amount=1, trx_code="BG", cpi="174379", size=" 300 ")
    before = dataclasses.asdict(req)
    resp = client.generate_qr_code(req)
    assert resp.qr_code == "imgdata"
    # Caller object byte-identical: str trx_code kept, padding kept,
    # validation sentinel unset.
    assert dataclasses.asdict(req) == before
    assert req.trx_code == "BG" and isinstance(req.trx_code, str)
    assert req.size == " 300 "
    assert req._validated is False


# ---- 3. Config fail-fast ----------------------------------------------------

@pytest.mark.parametrize("key", ["key:with-colon", "a:b:c", ":"])
def test_config_rejects_colon_in_consumer_key(key):
    """A ':' would split the Basic-auth pair ambiguously (Go parity)."""
    with pytest.raises(ValueError, match="must not contain ':'"):
        Config(consumer_key=key, consumer_secret="s")


@pytest.mark.parametrize("kwargs", [
    {"consumer_key": "k\u00e9y", "consumer_secret": "s"},
    {"consumer_key": "key", "consumer_secret": "s\u00e9cret"},
    {"consumer_key": "\u0661\u0662", "consumer_secret": "s"},
])
def test_config_rejects_non_ascii_credentials(kwargs):
    """Non-ASCII bytes cannot round-trip latin-1 Basic-auth encoding."""
    with pytest.raises(ValueError, match="must be ASCII"):
        Config(**kwargs)


# ---- 4. TokenManager allowlist ---------------------------------------------

@pytest.mark.parametrize("host", [
    "https://sandbox.safaricom.co.ke",
    "https://sandbox.safaricom.co.ke/",  # trailing slash tolerated
    "https://api.safaricom.co.ke",
    "https://api.safaricom.co.ke/",
])
def test_token_manager_accepts_trusted_hosts(host):
    """Construction against either Daraja deployment succeeds (no network)."""
    TokenManager(FakeSession([]), host, "k", "s")


@pytest.mark.parametrize("host", [
    "https://evil.example.com",
    "https://sandbox.safaricom.co.ke.evil.com",
    "http://sandbox.safaricom.co.ke",  # wrong scheme
    "https://sandbox.safaricom.co.ke.evil.com/",
    "",
])
def test_token_manager_rejects_untrusted_hosts(host):
    """An attacker host must never receive the Basic-auth credential."""
    with pytest.raises(ValueError, match="untrusted OAuth base_url"):
        TokenManager(FakeSession([]), host, "k", "s")


def test_token_manager_docstring_states_trusted_config_boundary():
    """The class docstring must document the trusted-config boundary."""
    assert "TRUSTED-CONFIG BOUNDARY" in TokenManager.__doc__


# ---- 5. shared limits module -------------------------------------------------

def test_limits_single_source_and_back_compat_reexports():
    """One cap value everywhere; legacy import paths keep working."""
    assert MAX_BODY_BYTES == 1_048_576
    import mpesa.auth as auth_mod
    import mpesa.callbacks as cb_mod
    import mpesa.client as client_mod
    import mpesa.responses as resp_mod
    import mpesa.results as res_mod
    assert cb_mod._MAX_BODY_BYTES == MAX_BODY_BYTES
    assert res_mod._MAX_BODY_BYTES == MAX_BODY_BYTES
    assert resp_mod._MAX_BODY_BYTES == MAX_BODY_BYTES
    assert auth_mod._MAX_BODY_BYTES == MAX_BODY_BYTES
    assert client_mod._MAX_RESPONSE_BYTES == MAX_BODY_BYTES
    for mod in (cb_mod, res_mod, resp_mod):
        assert callable(mod._check_body_size)


def test_check_body_size_measures_utf8_bytes_not_chars():
    """400k CJK chars (~1.2 MiB) must trip the 1 MiB gate as str AND bytes."""
    over_str = "\u4e2d" * 400_000
    assert len(over_str) < MAX_BODY_BYTES < len(over_str.encode("utf-8"))
    with pytest.raises(ValueError, match="exceeds 1048576 bytes"):
        check_body_size(over_str, "callback body")
    with pytest.raises(ValueError, match="exceeds 1048576 bytes"):
        check_body_size(over_str.encode("utf-8"), "callback body")


# ---- 6. first-wins O(1) accessors --------------------------------------------

def test_first_wins_accessors_agree_with_metadata_dict():
    """amount()/receipt/date/phone are O(1) gets over the shared dict."""
    raw = (b'{"Body":{"stkCallback":{"MerchantRequestID":"m",'
           b'"CheckoutRequestID":"c","ResultCode":0,"ResultDesc":"ok",'
           b'"CallbackMetadata":{"Item":['
           b'{"Name":"Amount","Value":5},'
           b'{"Name":"Amount","Value":9},'
           b'{"Name":"MpesaReceiptNumber","Value":"AAA"},'
           b'{"Name":"TransactionDate","Value":20191219102115},'
           b'{"Name":"PhoneNumber","Value":"254708374149"}]}}}}')
    res = StkCallbackResult.from_json(raw)
    md = res.metadata()
    assert res.amount() == md["Amount"] == 5.0  # first wins, not 9
    assert res.mpesa_receipt() == md["MpesaReceiptNumber"]
    assert res.transaction_date() == md["TransactionDate"]
    assert res.phone_number() == md["PhoneNumber"]
    assert not hasattr(res, "_lookup")  # linear-scan helper removed


def test_async_result_accessors_agree_with_parameters_dict():
    """transaction_receipt()/amount() are O(1) gets over parameters()."""
    raw = (b'{"Result":{"ResultType":0,"ResultCode":0,"ResultDesc":"d",'
           b'"OriginatorConversationID":"o","ConversationID":"c",'
           b'"TransactionID":"t","ResultParameters":{"ResultParameter":['
           b'{"Key":"TransactionAmount","Value":10},'
           b'{"Key":"TransactionAmount","Value":99},'
           b'{"Key":"TransactionReceipt","Value":"RCPT"}]}}}')
    res = AsyncResult.from_json(raw)
    params = res.parameters()
    assert res.amount() == params["TransactionAmount"] == 10.0
    assert res.transaction_receipt() == params["TransactionReceipt"]
    assert not hasattr(res, "_param")  # linear-scan helper removed


# ---- 7. shared streaming reader ----------------------------------------------

def test_read_capped_returns_body_and_releases_connection():
    """Small bodies stream through; the socket is always released."""
    resp = FakeResponse(text='{"a":1}')
    assert read_capped(resp, "probe response") == b'{"a":1}'
    assert resp.closed_calls == 1


def test_read_capped_aborts_before_parse_without_content_attr():
    """Oversize bodies abort mid-stream; no .content/.json ever touched."""
    over = b'{"x":"' + b"A" * (1 << 20) + b'"}'
    resp = FakeResponse(chunks=[over[:700_000], over[700_000:]])
    assert not hasattr(resp, "content")
    with pytest.raises(ValueError, match="exceeds 1048576 bytes"):
        read_capped(resp, "probe response")
    assert resp.closed_calls == 1


# ---- 8. Go-parity docstring ---------------------------------------------------

def test_refresh_docstring_claims_go_parity_not_deviation():
    """The stale 'Go trusts peer unconditionally' claim must be gone."""
    doc = TokenManager.refresh_after_invalid_token.__doc__ or ""
    assert "intentional deviation" not in doc
    assert "Go trusts the peer unconditionally" not in doc
    assert "go/client.go" in doc and "tokenFresh" in doc


# ---- 9. OriginatorConversationID contract -------------------------------------

@pytest.mark.parametrize("bad", ["", "   "])
def test_b2c_rejects_empty_originator_conversation_id(bad):
    """Empty/blank ids fail validate(); the client auto-fills before this."""
    with pytest.raises(ValueError, match="OriginatorConversationID is required"):
        _b2c(originator_conversation_id=bad).validate()


def test_b2c_rejects_overlong_originator_conversation_id():
    """Daraja contract is <20 chars: 19 passes, 20 fails."""
    _b2c(originator_conversation_id="x" * 19).validate()  # must not raise
    with pytest.raises(ValueError, match="exceeds 19 characters"):
        _b2c(originator_conversation_id="x" * 20).validate()


def test_client_autofill_satisfies_required_ocid():
    """client.b2c_payout fills the id first, so empty caller models work."""
    session = FakeSession([FakeResponse(text=OAUTH_OK),
                           FakeResponse(text=(
                               '{"OriginatorConversationID":"o",'
                               '"ConversationID":"c","ResponseCode":"0",'
                               '"ResponseDescription":"ok"}'))])
    cfg = Config(consumer_key="k", consumer_secret="s", shortcode="174379",
                 passkey=PASSKEY, now=lambda: T0, http_client=session)
    client = MpesaClient(cfg)
    req = _b2c(originator_conversation_id="", party_a="")
    ack = client.b2c_payout(req)
    assert ack.response_code == "0"
    assert req.originator_conversation_id == ""  # caller model untouched


# ---- 10a. CJK oversize end-to-end ----------------------------------------------

def test_cjk_oversize_rejected_end_to_end_str_and_bytes():
    """400k CJK chars (~1.2 MiB as UTF-8) rejected by every model, both forms."""
    over_str = '{"Body":"' + "\u4e2d" * 400_000 + '"}'
    over_bytes = over_str.encode("utf-8")
    assert len(over_bytes) > MAX_BODY_BYTES
    with pytest.raises(ValueError, match="exceeds"):
        StkCallbackResult.from_json(over_str)
    with pytest.raises(ValueError, match="exceeds"):
        StkCallbackResult.from_json(over_bytes)
    with pytest.raises(ValueError, match="exceeds"):
        AsyncResult.from_json(over_str)
    with pytest.raises(ValueError, match="exceeds"):
        AsyncResult.from_json(over_bytes)
    with pytest.raises(ValueError, match="exceeds"):
        STKPushResponse.from_json(over_str)
    with pytest.raises(ValueError, match="exceeds"):
        STKPushResponse.from_json(over_bytes)


# ---- 10b. coerce_amount edge table ----------------------------------------------

@pytest.mark.parametrize("raw,want", [
    ("123456789012", 123456789012.0),   # 12 int digits: valid
    ("1.123456", 1.123456),             # 6dp: valid
    (9007199254740992, 9007199254740992.0),  # 2**53: valid boundary
    ("1234567890123", None),            # 13 int digits: rejected
    ("1.1234567", None),                # 7dp: rejected
    ("1_000", None),                    # PEP 515 underscores
    ("0x10", None),                     # hex literal
    (" 0x10 ", None),                   # hex with padding
    ("\u0661\u0662\u0663", None),       # Arabic-Indic Nd digits
    ("\u00b2", None),                   # superscript two
    (float("inf"), None),               # non-finite float
    (float("-inf"), None),              # non-finite float
    (float("nan"), None),               # non-finite float
    (True, None),                       # bool is int subclass: refused
    (False, None),                      # bool is int subclass: refused
    (2 ** 53 + 1, None),                # precision loss boundary
    (-(2 ** 53) - 1, None),             # negative precision boundary
    ("Infinity", None),                 # non-decimal string
    ("1e30", None),                     # exponent form not in shape
    ("", None),                         # absent
    (None, None),                       # absent
    ({"a": 1}, None),                   # wrong type
])
def test_coerce_amount_edge_table(raw, want):
    """Daraja amount shape: <=12 int digits, <=6dp, ASCII decimal only."""
    got = coerce_amount(raw)
    if want is None:
        assert got is None, raw
    else:
        assert got == want, raw


def test_qr_trx_code_enum_coerces_but_caller_copy_isolated():
    """Sanity: validate() DOES normalise -- the fix isolates it on a copy."""
    req = QRCodeRequest(merchant_name="m", ref_no="r", amount=1,
                        trx_code="BG", cpi="174379", size="300")
    req.validate()
    assert req.trx_code is QRTrxCode.BUY_GOODS  # in-place on direct call
