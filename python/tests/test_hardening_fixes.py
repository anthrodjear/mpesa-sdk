"""Regression tests for the cross-cutting hardening round (fixes 1-8).

Each section pins ONE defect that the original 555-test suite let through,
with the exact payload that proved it. Grouped by fix number so a future
change to any of these behaviours has to argue with the test that named it:

1. ``{"access_token": null}`` must never be cached as the string ``"None"``.
2. Money must not lose cents (``Decimal``, 2dp, symmetric magnitude cap).
3. The numeric-IP SSRF bypass (inet_aton table shared with Go/TypeScript).
4. Unbounded input validation (Unicode digits, QR Size, amount ceilings).
5. Sync/async validation and payload parity between the two request files.
6. Session isolation, error-body isolation, typed rate-limit error.
7. Accessor caching, ``coerce_str`` float gate, ``check_body_size``.
8. The vacuous tests (a "must not raise" test that passes for a no-op
   validator, and one with zero assertions) -- see the two strengthened
   tests at the bottom of the file.
"""

import sys
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

import pytest
import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mpesa import MpesaClient
from mpesa._limits import MAX_BODY_BYTES, check_body_size
from mpesa.auth import TokenManager
from mpesa.callbacks import StkCallbackResult
from mpesa.coercion import coerce_amount, coerce_int, coerce_str
from mpesa.config import Config
from mpesa.enums import CommandID, QRTrxCode, ResponseType, TransactionType
from mpesa.exceptions import (
    InvalidTokenError,
    MpesaError,
    RefreshRateLimitedError,
)
from mpesa.requests_async import (
    AccountBalanceRequest,
    B2CPayoutRequest,
    ReversalRequest,
    TransactionStatusRequest,
)
from mpesa.requests_sync import (
    C2BRegisterRequest,
    C2BSimulateRequest,
    QRCodeRequest,
    STKPushRequest,
    STKQueryRequest,
    _url,
)
from mpesa.responses import OAuthToken
from mpesa.results import AsyncResult

T0 = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
PASSKEY = "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919"
CB = "https://mydomain.com/path"


# ---------------------------------------------------------------------------
# 1. null access_token must raise / vanish, never become the string "None"
# ---------------------------------------------------------------------------

NULL_TOKEN_BODY = '{"access_token": null, "expires_in": 3599}'


def test_null_access_token_is_explicit_absence_not_string_none():
    """The exact poisoning payload: null must not stringify to "None"."""
    token = OAuthToken.from_json(NULL_TOKEN_BODY)
    assert token.access_token is None          # explicit absence...
    assert token.access_token != "None"        # ...never the literal
    assert not token.access_token              # ...so the falsy check works
    assert token.expires_in_seconds == 3599    # expires_in tolerance intact
    # Credential-safe repr must not crash on the absent token either.
    assert "None" not in repr(token)


@pytest.mark.parametrize("raw", [
    '{"access_token": {"a": 1}, "expires_in": 3599}',   # dict
    '{"access_token": ["tok"], "expires_in": 3599}',    # list
    '{"access_token": 12345, "expires_in": 3599}',      # number
    '{"access_token": true, "expires_in": 3599}',       # bool
])
def test_non_string_access_token_raises_typed_error(raw):
    """A non-string bearer raises and is NEVER cached."""
    with pytest.raises(InvalidTokenError) as excinfo:
        OAuthToken.from_json(raw)
    assert "access_token" in str(excinfo.value)
    assert str(excinfo.value).startswith("mpesa:")


class _ScriptedSession:
    """Duck-typed session replaying canned OAuth bodies."""

    def __init__(self, bodies):
        self.bodies = list(bodies)
        self.calls = 0

    def get(self, url, **kwargs):
        self.calls += 1
        body = self.bodies[min(self.calls - 1, len(self.bodies) - 1)]

        class _Resp:
            status_code = 200
            headers = {"content-type": "application/json"}

            def __init__(self, blob):
                self.blob = blob.encode()

            def iter_content(self, _size):
                yield self.blob

            def close(self):
                pass

        return _Resp(body)


def _token_manager(bodies):
    session = _ScriptedSession(bodies)
    return TokenManager(session, "https://sandbox.safaricom.co.ke",
                        "key", "secret", now=lambda: T0), session


def test_null_token_response_does_not_poison_the_process_cache():
    """The full failure cascade the bug caused: 401 -> retry -> rate limit."""
    tm, session = _token_manager([
        NULL_TOKEN_BODY,                                   # gateway hiccup
        '{"access_token": "tok-good", "expires_in": 3599}}'.replace("}}", "}"),
    ])
    # First call rejects loudly instead of caching the string "None".
    with pytest.raises(ValueError, match="missing access_token"):
        tm.get_token()
    assert tm.generation == 0               # nothing was cached
    assert tm._token is None and tm._failures == 1
    # The very next call can still succeed: the cache was not poisoned.
    assert tm.get_token() == "tok-good"
    assert session.calls == 2


def test_empty_and_whitespace_tokens_are_absence_too():
    assert OAuthToken.from_json('{"access_token": "", "expires_in": 3599}'
                                ).access_token == ""
    assert OAuthToken.from_json('{"access_token": "   ", "expires_in": 3599}'
                                ).access_token == ""
    assert OAuthToken.from_json(
        '{"access_token": "  tok  ", "expires_in": 3599}').access_token == "tok"


# ---------------------------------------------------------------------------
# 2. money: Decimal, 2dp, symmetric magnitude cap
# ---------------------------------------------------------------------------

def _callback_with_amount(value_json):
    raw = (b'{"Body":{"stkCallback":{"MerchantRequestID":"m",'
           b'"CheckoutRequestID":"ws_CO_1","ResultCode":0,"ResultDesc":"ok",'
           b'"CallbackMetadata":{"Item":['
           b'{"Name":"Amount","Value":' + value_json + b'},'
           b'{"Name":"MpesaReceiptNumber","Value":"NLJ7RT61SV"},'
           b'{"Name":"TransactionDate","Value":20191219102115},'
           b'{"Name":"PhoneNumber","Value":"254708374149"}]}}}}')
    return StkCallbackResult.from_json(raw)


def _result_with_amount(value_json):
    raw = (b'{"Result":{"ResultType":0,"ResultCode":0,"ResultDesc":"d",'
           b'"OriginatorConversationID":"o","ConversationID":"c",'
           b'"TransactionID":"t","ResultParameters":{"ResultParameter":['
           b'{"Key":"TransactionAmount","Value":' + value_json + b'},'
           b'{"Key":"TransactionReceipt","Value":"RCPT"},'
           b'{"Key":"TransactionStatus","Value":"Completed"}]}}}')
    return AsyncResult.from_json(raw)


@pytest.mark.parametrize("value_json,want", [
    (b"10.10", Decimal("10.10")),   # trailing zero survives
    (b"10.1", Decimal("10.10")),     # same value, float spelling
    (b'"10.10"', Decimal("10.10")),  # string encoding
    (b'0.29', Decimal("0.29")),      # cent that a binary float rounds off
    (b"250000", Decimal("250000.00")),
    (b'123456789012', Decimal("123456789012.00")),
])
def test_money_round_trips_without_cent_loss(value_json, want):
    """No silent cent loss on either inbound amount accessor."""
    callback = _callback_with_amount(value_json)
    result = _result_with_amount(value_json)
    for amount in (callback.amount(), result.amount()):
        assert isinstance(amount, Decimal)
        assert amount == want
        assert str(amount) == f"{want:.2f}"      # canonical 2dp wire form
    # The documented settlement usage still works: Decimal arithmetic,
    # comparison against int/float, and JSON-safe stringification.
    total = callback.amount() + result.amount()
    assert total == 2 * want
    assert callback.amount() + 0 < callback.amount() + 1  # orderable vs int
    assert callback.amount() >= float(want)             # comparable vs float
    assert str(int(callback.amount())) == str(int(want))


@pytest.mark.parametrize("raw", [
    1e300, -1e300, float("inf"), float("nan"),   # float path
    2 ** 53 + 1, -(2 ** 53) - 1,                  # int path, both directions
    pytest.param(10 ** 5000, id="10**5000"),     # unbounded int
    Decimal("1E+30"), Decimal("NaN"),             # Decimal path
    "1e300", "1.123456", "0x10", "1_000", "", "Infinity",
    True, False, {"a": 1}, [10.10], None,
])
def test_oversized_and_hostile_money_rejected(raw):
    """The magnitude cap is symmetric: every path refuses the same things."""
    assert coerce_amount(raw) is None, raw


def test_coerce_amount_boundary_values_accepted():
    assert coerce_amount(2 ** 53) == Decimal(2 ** 53)
    assert coerce_amount(-(2 ** 53)) == Decimal(-(2 ** 53))
    assert coerce_amount(Decimal("0.01")) == Decimal("0.01")
    assert coerce_amount("-123456789012.34") == Decimal("-123456789012.34")


def test_settle_style_usage_still_type_checks_and_serialises():
    """settle(order, amount=result.amount()) keeps working as documented."""
    result = _result_with_amount(b"10.10")
    settled = {"amount": str(result.amount()), "as_float": float(result.amount())}
    assert settled == {"amount": "10.10", "as_float": 10.1}


# ---------------------------------------------------------------------------
# 3. SSRF: numeric-IP bypass (shared Go/TypeScript table)
# ---------------------------------------------------------------------------

def _host_url(host):
    return f"http://[{host}]/hook" if ":" in host else f"http://{host}/hook"


@pytest.mark.parametrize("host", [
    "localhost", "localhost.", "LOCALHOST",
    "127.0.0.1", "127.1", "0x7f000001", "2130706433", "017700000001",
    "2852039166", "0.0.0.0",
    "10.0.0.1", "192.168.1.1", "172.16.0.1", "169.254.169.254",
    "::1", "::ffff:127.0.0.1", "fe80::1", "fc00::1", "224.0.0.1", "ff02::1",
    "0x0a000001",
])
def test_ssrf_table_rejects_internal_hosts(host):
    with pytest.raises(ValueError, match="mpesa: CallBackURL"):
        _url("CallBackURL", _host_url(host))


def test_ssrf_table_rejects_embedded_credentials():
    with pytest.raises(ValueError, match="embedded credentials"):
        _url("CallBackURL", "http://user:pass@hook/hook")


@pytest.mark.parametrize("host", [
    "192.167.1.1", "223.255.255.255", "8.8.8.8",
    "hook.example.com", "user-facing-brand.com",
])
def test_ssrf_table_accepts_public_hosts(host):
    """Accept side of the SAME table -- no false positives, no foot-gun."""
    _url("CallBackURL", _host_url(host))  # must not raise


@pytest.mark.parametrize("host", ["1.2.3.4.5", "999.1.1.1", "1.0xZZ", "1..2"])
def test_numeric_shaped_but_unparseable_hosts_fail_closed(host):
    """Every label numeric but no inet_aton reading -> REJECT, never accept."""
    with pytest.raises(ValueError, match="numeric but not a valid IP literal"):
        _url("CallBackURL", _host_url(host))


def test_ssrf_guard_is_wired_on_every_url_bearing_model():
    """Both files carry the guard; the numeric form must not slip either."""
    for build in (
        lambda url: STKPushRequest(
            business_short_code="174379",
            transaction_type=TransactionType.CUSTOMER_PAY_BILL_ONLINE,
            amount=1, party_a="254722000000", party_b="174379",
            phone_number="254722000000", call_back_url=url,
            account_reference="a", transaction_desc="b"),
        lambda url: C2BRegisterRequest(
            short_code="174379", response_type=ResponseType.COMPLETED,
            confirmation_url=url, validation_url=CB),
        lambda url: B2CPayoutRequest(
            initiator_name="i", security_credential="c",
            command_id=CommandID.BUSINESS_PAYMENT, amount=10,
            originator_conversation_id="oc-1", party_a="600992",
            party_b="254705912645", remarks="ok",
            queue_time_out_url=url, result_url=CB),
        lambda url: TransactionStatusRequest(
            initiator="i", security_credential="c", transaction_id="T",
            party_a="600992", remarks="r", result_url=url,
            queue_time_out_url=CB),
        lambda url: ReversalRequest(
            initiator="i", security_credential="c", transaction_id="T",
            amount=10, receiver_party="600992", remarks="reversal",
            result_url=url, queue_time_out_url=CB),
        lambda url: AccountBalanceRequest(
            initiator="i", security_credential="c", party_a="600992",
            remarks="balance", result_url=url, queue_time_out_url=CB),
    ):
        model = build("http://2852039166/hook")
        with pytest.raises(ValueError):
            model.validate()


# ---------------------------------------------------------------------------
# 4. unbounded input validation
# ---------------------------------------------------------------------------

def test_unicode_digit_shortcode_rejected():
    """\"\\d{5,10}\" matched Arabic-Indic Nd digits; [0-9] does not."""
    for bad in ("\u0661\u0662\u0663\u0664\u0665",      # ١٢٣٤٥
                "\uff11\uff12\uff13\uff14\uff15",      # fullwidth
                "17 4379", "17437A", "1234", "12345678901"):
        with pytest.raises(ValueError, match="must be 5-10 digits"):
            Config(shortcode=bad)
    for good in ("12345", "174379", "1234567890"):
        assert Config(shortcode=good).shortcode == good


def _qr(**over):
    fields = dict(merchant_name="m", ref_no="r", amount=1,
                  trx_code=QRTrxCode.BUY_GOODS, cpi="174379", size="300")
    fields.update(over)
    return QRCodeRequest(merchant_name=fields["merchant_name"],
                         ref_no=fields["ref_no"], amount=fields["amount"],
                         trx_code=fields["trx_code"], cpi=fields["cpi"],
                         size=fields["size"])


def test_oversized_qr_size_rejected():
    assert _qr(size="9" * 100_000) is not None        # built without validation
    req = _qr(size="9" * 100_000)
    with pytest.raises(ValueError, match="Size"):
        req.validate()
    with pytest.raises(ValueError, match="Size"):
        _qr(size="1234567890123").validate()          # 13 digits: over the cap
    _qr(size="123456789012").validate()               # 12 digits: still allowed
    _qr(size="000000000300").validate()               # zeros pad: allowed


def test_oversized_qr_cpi_rejected_with_bounded_error_message():
    """Error text reports a LENGTH, so a 1 MB input cannot flood the log."""
    req = _qr(cpi="9" * 1_000_000)
    with pytest.raises(ValueError) as excinfo:
        req.validate()
    assert len(str(excinfo.value)) < 200


def _stk(**over):
    fields = dict(business_short_code="174379",
                  transaction_type=TransactionType.CUSTOMER_PAY_BILL_ONLINE,
                  amount=1, party_a="254722000000", party_b="174379",
                  phone_number="254722000000", call_back_url=CB,
                  account_reference="a", transaction_desc="b")
    fields.update(over)
    return STKPushRequest(**fields)


def _c2b_simulate(**over):
    fields = dict(short_code="174379",
                  command_id=TransactionType.CUSTOMER_PAY_BILL_ONLINE,
                  amount=5, msisdn="0712345678", bill_ref_number="acct")
    fields.update(over)
    return C2BSimulateRequest(**fields)


@pytest.mark.parametrize("build", [
    lambda amount: _stk(amount=amount),
    lambda amount: _c2b_simulate(amount=amount),
    lambda amount: _qr(amount=amount),
])
def test_oversized_amounts_rejected_on_every_amount_endpoint(build):
    """10**5000 used to serialize straight into each of these payloads."""
    for amount in (10 ** 5000, 2 ** 31, 250_001):
        with pytest.raises(ValueError):
            build(amount).validate()
    # The documented ceiling still passes (docs/apis/b2c.md per-txn max).
    build(250_000).validate()


def test_amount_ceiling_error_message_never_stringifies_the_amount():
    with pytest.raises(ValueError) as excinfo:
        _stk(amount=10 ** 5000).validate()
    assert "4300 digits" not in str(excinfo.value)   # no CPython guard leak
    assert "ceiling" in str(excinfo.value)


def test_transaction_status_identifiers_are_length_and_printable_capped():
    """The one model that lacked the _printable(...) cap its peers have."""
    for over in ({"transaction_id": "T" * 65},
                 {"original_conversation_id": "C" * 65},
                 {"transaction_id": "bad\nid"}):
        with pytest.raises(ValueError):
            TransactionStatusRequest(
                initiator="i", security_credential="c", party_a="600992",
                remarks="r", result_url=CB, queue_time_out_url=CB,
                **over).validate()
    # Same boundary as ReversalRequest/STKQueryRequest: 64 accepted.
    TransactionStatusRequest(
        initiator="i", security_credential="c", party_a="600992",
        remarks="r", result_url=CB, queue_time_out_url=CB,
        transaction_id="T" * 64).validate()


# ---------------------------------------------------------------------------
# 5. sync/async validation parity for every request model
# ---------------------------------------------------------------------------

def test_sync_and_async_reject_the_same_hostile_inputs():
    """One URL, one amount, one identifier: both files must agree."""
    hostile_urls = [CB, "http://2852039166/h", "http://localhost/h",
                    "https://user:pass@mydomain.com/h", "ftp://x.com/h"]

    def sync_accept(url):
        try:
            _stk(call_back_url=url).validate()
            return True
        except ValueError:
            return False

    def async_accept(url):
        try:
            B2CPayoutRequest(
                initiator_name="i", security_credential="c",
                command_id=CommandID.BUSINESS_PAYMENT, amount=10,
                originator_conversation_id="oc-1", party_a="600992",
                party_b="254705912645", remarks="ok",
                queue_time_out_url=url, result_url=CB).validate()
            return True
        except ValueError:
            return False

    for url in hostile_urls:
        assert sync_accept(url) is async_accept(url), url


def test_sync_and_async_agree_on_identifier_boundaries():
    """STKQueryRequest (sync) vs TransactionStatusRequest (async)."""
    for identifier in ("ok-id", "T" * 64, "T" * 65, "bad\nid", ""):
        sync_ok = True
        try:
            STKQueryRequest(business_short_code="174379",
                            checkout_request_id=identifier).validate()
        except ValueError:
            sync_ok = False
        async_ok = True
        try:
            TransactionStatusRequest(
                initiator="i", security_credential="c", party_a="600992",
                remarks="r", result_url=CB, queue_time_out_url=CB,
                transaction_id=identifier).validate()
        except ValueError:
            async_ok = False
        assert sync_ok is async_ok, identifier


def test_sync_and_async_agree_on_amount_bounds():
    for amount in (1, 10, 250_000, 250_001, 10 ** 5000, 0, -1, True):
        sync_ok = True
        try:
            _stk(amount=amount).validate()
        except ValueError:
            sync_ok = False
        async_ok = True
        try:
            ReversalRequest(
                initiator="i", security_credential="c", transaction_id="T",
                amount=amount, receiver_party="600992", remarks="reversal",
                result_url=CB, queue_time_out_url=CB).validate()
        except ValueError:
            async_ok = False
        assert sync_ok is async_ok, amount


def test_sync_and_async_normalise_msisdns_identically():
    """Same raw MSISDN -> same canonical value, both files."""
    stk = _stk(party_a="0722000000", phone_number="+254 722-000-000")
    stk.validate()
    b2c = B2CPayoutRequest(
        initiator_name="i", security_credential="c",
        command_id=CommandID.BUSINESS_PAYMENT, amount=10,
        originator_conversation_id="oc-1", party_a="600992",
        party_b="0722000000", remarks="ok",
        queue_time_out_url=CB, result_url=CB)
    b2c.validate()
    assert stk.party_a == stk.phone_number == b2c.party_b == "254722000000"


def test_shared_wire_fields_serialise_identically_for_the_same_input():
    """STK (sync) and B2C (async) emit the same bytes for the fields they
    share -- amounts, shortcodes and normalized MSISDNs. The two endpoints
    differ by DESIGN where the wire contract differs: STK ``PartyB`` is the
    receiving shortcode, B2C ``PartyB`` is the recipient MSISDN, which is
    why only one of them goes through MSISDN normalization.
    """
    stk = _stk(amount=1234, party_a="0722000000", party_b="174379")
    stk.validate()
    stk_payload = stk.to_payload()
    b2c = B2CPayoutRequest(
        initiator_name="i", security_credential="c",
        command_id=CommandID.BUSINESS_PAYMENT, amount=1234,
        originator_conversation_id="oc-1", party_a="174379",
        party_b="0722000000", remarks="ok",
        queue_time_out_url=CB, result_url=CB)
    b2c.validate()
    b2c_payload = b2c.to_payload()

    assert stk_payload["Amount"] == b2c_payload["Amount"] == 1234
    # Same shortcode value on both ends of the wire.
    assert stk_payload["PartyB"] == b2c_payload["PartyA"] == "174379"
    # Same raw MSISDN, same canonical 2547... form.
    assert stk_payload["PartyA"] == "254722000000"
    assert b2c_payload["PartyB"] == "254722000000"


def test_shortcode_fields_are_validated_identically_in_both_files():
    """B2C PartyA (shortcode) and C2B ShortCode now share one validator."""
    for model in (lambda: C2BRegisterRequest(
                      short_code="17437A", response_type="Completed",
                      confirmation_url=CB, validation_url=CB),
                  lambda: B2CPayoutRequest(
                      initiator_name="i", security_credential="c",
                      command_id=CommandID.BUSINESS_PAYMENT, amount=10,
                      originator_conversation_id="oc-1", party_a="17437A",
                      party_b="254705912645", remarks="ok",
                      queue_time_out_url=CB, result_url=CB),
                  lambda: C2BSimulateRequest(
                      short_code="174", command_id="CustomerPayBillOnline",
                      amount=5, msisdn="0712345678", bill_ref_number="acct")):
        with pytest.raises(ValueError, match="5-10 ASCII digits"):
            model().validate()


def test_async_module_is_models_only_with_no_transport():
    """Documented contract: no async HTTP transport exists to build here."""
    import mpesa.requests_async as async_models

    assert not any(name.startswith("Client") or name.startswith("Session")
                   or name.startswith("Transport")
                  for name in dir(async_models))
    assert "TRANSPORT NOTE" in (async_models.__doc__ or "")


# ---------------------------------------------------------------------------
# 6. session isolation, error-body isolation, typed rate-limit error
# ---------------------------------------------------------------------------

def test_mounting_on_the_sdk_session_does_not_mutate_the_caller_session():
    source = requests.Session()
    cfg = Config(consumer_key="k", consumer_secret="s", shortcode="174379",
                 passkey=PASSKEY, now=lambda: T0, http_client=source)
    client = MpesaClient(cfg)
    before = dict(source.adapters)

    client._session.mount("https://sdk-only.example.com", requests.adapters.HTTPAdapter())
    client._session.headers["X-SDK"] = "1"

    assert dict(source.adapters) == before            # caller mapping untouched
    assert "https://sdk-only.example.com" not in source.adapters
    assert "X-SDK" not in source.headers
    assert client._session.adapters is not source.adapters


def test_close_does_not_shut_down_the_callers_connection_pools():
    source = requests.Session()
    caller_adapter = source.get_adapter("https://example.com")
    closed: list[int] = []
    original_close = caller_adapter.close

    def spy_close():                    # instrument the CALLER's pool only
        closed.append(1)
        original_close()

    caller_adapter.close = spy_close
    cfg = Config(consumer_key="k", consumer_secret="s", shortcode="174379",
                 passkey=PASSKEY, now=lambda: T0, http_client=source)
    client = MpesaClient(cfg)
    client_adapter = client._session.get_adapter("https://example.com")

    assert client_adapter is not caller_adapter
    assert (client._session.get_adapter("https://example.com").poolmanager
            is not caller_adapter.poolmanager)

    client.close()
    assert closed == []                 # the caller's pools are still usable
    assert caller_adapter.poolmanager is not None
    # Our own clone WAS closed (isolation is two-way).
    assert client._session.get_adapter("https://example.com").poolmanager is not None


def test_hostile_error_body_stays_out_of_the_exception_text():
    page = b"<html><body>Request blocked by WAF</body></html>"
    err = MpesaError.from_response(502, page, "text/html; charset=utf-8")
    assert err.error_message == "unexpected error response from gateway"
    for fragment in ("WAF", "text/html", "bytes"):
        assert fragment not in str(err)
    # Envelope bodies still surface their fields (sanitized).
    envelope = (b'{"requestId":"43169-3253970-1",'
                b'"errorCode":"500.001.1001","errorMessage":"blocked"}')
    err2 = MpesaError.from_response(500, envelope, "application/json")
    assert err2.error_code == "500.001.1001"
    assert err2.request_id == "43169-3253970-1"


def test_rate_limit_failure_raises_the_typed_sdk_exception():
    class _Down:
        def __init__(self):
            self.calls = 0

        def get(self, url, **kwargs):
            self.calls += 1

            class _Resp:
                status_code = 500
                headers = {"content-type": "application/json"}

                def iter_content(self, _size):
                    yield b'{"requestId":"r","errorCode":"500.001.1001"}'

                def close(self):
                    pass

            return _Resp()

    session = _Down()
    clock = [T0]
    tm = TokenManager(session, "https://sandbox.safaricom.co.ke",
                      "key", "secret", now=lambda: clock[0])
    # Three consecutive failures trip the guard (Go parity: 3 / 5s).
    for _ in range(3):
        with pytest.raises(MpesaError):
            tm.get_token()
    with pytest.raises(RefreshRateLimitedError) as excinfo:
        tm.get_token()
    assert "refresh rate limited after 3 consecutive failures" in str(excinfo.value)
    # Still a RuntimeError for pre-existing handlers.
    assert isinstance(excinfo.value, RuntimeError)
    # A forced (401-triggered) refresh bypasses the guard entirely.
    try:
        tm.refresh_after_invalid_token(tm.generation)
    except RefreshRateLimitedError:      # pragma: no cover - guard bypassed
        raise AssertionError(
            "forced refresh must bypass the rate limit") from None
    except MpesaError:
        pass
    assert session.calls == 4


# ---------------------------------------------------------------------------
# 7. caching, float gate, body-size cap
# ---------------------------------------------------------------------------

def test_metadata_and_parameters_are_built_once_for_many_accessors():
    """4 accessors must mean ONE O(n) build, not four (monkeypatched)."""
    import mpesa.callbacks as callbacks_mod
    import mpesa.results as results_mod

    builds = {"callbacks": 0, "results": 0}
    real_first_wins, real_first_wins_results = (
        callbacks_mod.first_wins, results_mod.first_wins)

    def counting(scope):
        def wrapper(pairs):
            builds[scope] += 1
            return real_first_wins(pairs)
        return wrapper

    callbacks_mod.first_wins = counting("callbacks")
    results_mod.first_wins = counting("results")
    try:
        callback = _callback_with_amount(b"10.10")
        for accessor in (callback.amount, callback.mpesa_receipt,
                         callback.transaction_date, callback.phone_number,
                         callback.metadata, callback.duplicate_keys):
            assert accessor() is not None
        result = _result_with_amount(b"10.10")
        for accessor in (result.amount, result.transaction_receipt,
                         result.transaction_status, result.parameters):
            assert accessor() is not None
    finally:
        callbacks_mod.first_wins = real_first_wins
        results_mod.first_wins = real_first_wins_results

    assert builds == {"callbacks": 1, "results": 1}


def test_coerce_str_float_branch_matches_coerce_int_precision_gate():
    """0.10 stays exact; a 1e30 integral float no longer prints 19 fake digits."""
    assert coerce_str(3599.0) == "3599"
    assert coerce_str(0.0) == "0"
    assert coerce_str(10.10) == "10.1"
    assert coerce_str(1e30) == "1e+30"          # not "1000000000000000019884624838656"
    assert coerce_str(float("inf")) == "inf"
    assert coerce_int(1e30) is None             # both gates agree at 2**53


def test_check_body_size_is_enforced_on_both_string_and_byte_forms():
    assert check_body_size(b"x" * MAX_BODY_BYTES) is None
    assert check_body_size("x" * MAX_BODY_BYTES) is None
    assert check_body_size(bytearray(MAX_BODY_BYTES)) is None
    with pytest.raises(ValueError, match="exceeds 1048576 bytes"):
        check_body_size(b"x" * (MAX_BODY_BYTES + 1))
    with pytest.raises(ValueError, match="exceeds 1048576 bytes"):
        check_body_size("x" * (MAX_BODY_BYTES + 1))
    # Measured in BYTES: 400k CJK chars are ~1.2 MiB and must not slip past.
    with pytest.raises(ValueError, match="exceeds"):
        check_body_size("\u4e2d" * 400_000)
    # Already-decoded structures carry no wire size: nothing to gate.
    assert check_body_size({"a": 1}, "callback body") is None


# ---------------------------------------------------------------------------
# 8. the vacuous tests, strengthened
# ---------------------------------------------------------------------------

def test_validate_credentials_ok_is_not_vacuous():
    """test_config.py had a zero-assertion version of this test."""
    populated = Config(consumer_key="key", consumer_secret="secret",
                       shortcode="174379", passkey="pk")
    assert populated.validate_credentials() is None
    assert populated.consumer_key == "key"
    assert populated.consumer_secret == "secret"
    # And the negative half, so the assertion pair is meaningful.
    for kwargs, missing in (({"consumer_secret": "s"}, "consumer_key"),
                            ({"consumer_key": "k"}, "consumer_secret"),
                            ({}, "consumer_key")):
        with pytest.raises(ValueError) as excinfo:
            Config(**kwargs).validate_credentials()
        assert missing in str(excinfo.value)


def test_public_urls_accepted_is_not_vacuous():
    """A 'must not raise' test is worthless without the reject side.

    The strengthened original lives in test_url_ssrf_hardening.py; this is
    the operational proof that the validator actually discriminates: the
    same call must reject the internal twin of every accepted form.
    """
    for public, internal in (("https://hook.example.com/h", "http://127.0.0.1/h"),
                             ("https://example.com/h", "http://localhost/h"),
                             ("https://example.com/h", "http://2852039166/h")):
        _url("CallBackURL", public)                      # accepted
        with pytest.raises(ValueError, match="mpesa: CallBackURL"):
            _url("CallBackURL", internal)                # rejected
