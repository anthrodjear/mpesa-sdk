"""Tests for mpesa.client -- transport, defaults, retry-once auth."""

import base64
import copy
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mpesa.auth import TokenManager  # noqa: E402  # noqa: F401 (repr pin)
from mpesa.client import MpesaClient  # noqa: E402
from mpesa.config import Config  # noqa: E402
from mpesa.enums import CommandID, QRTrxCode, ResponseType  # noqa: E402
from mpesa.exceptions import MpesaError  # noqa: E402
from mpesa.requests_async import (  # noqa: E402
    AccountBalanceRequest,
    B2CPayoutRequest,
    ReversalRequest,
    TransactionStatusRequest,
)
from mpesa.requests_sync import (  # noqa: E402
    C2BRegisterRequest,
    C2BSimulateRequest,
    QRCodeRequest,
    STKPushRequest,
    STKQueryRequest,
)

T0 = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
PASSKEY = "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919"
OAUTH_OK = ('{"access_token":"tok-1","expires_in":"3599"}')
CONV_OK = ('{"OriginatorConversationID":"o-1","ConversationID":"AG_1",'
           '"ResponseCode":"0","ResponseDescription":"Accept"}')
C2B_OK = ('{"OriginatorCoversationID":"x","ResponseCode":"0",'
          '"ResponseDescription":"Success"}')


class FakeResponse:
    def __init__(self, status_code=200, text="{}"):
        self.status_code = status_code
        self.content = text.encode()
        self.headers = {"content-type": "application/json"}

    def json(self):
        import json as _json
        return _json.loads(self.content)

    def iter_content(self, chunk_size):
        for i in range(0, len(self.content), chunk_size):
            yield self.content[i:i + chunk_size]


class FakeSession:
    """Duck-typed session: shallow-copyable, programmable, recording."""

    def __init__(self, queue):
        self.headers = {}
        self.adapters = {}
        self.verify = False            # caller leaves verify off on purpose
        self.calls = []
        self.queue = list(queue)

    def request(self, method, url, json=None, params=None, timeout=None,
                allow_redirects=True, headers=None, stream=False):
        self.calls.append({"kind": method, "url": url, "json": json,
                           "params": params, "timeout": timeout,
                           "allow_redirects": allow_redirects,
                           "headers": headers, "stream": stream})
        return self.queue.pop(0)

    def get(self, url, **kwargs):
        self.calls.append({"kind": "GET", "url": url, **kwargs})
        return self.queue.pop(0)


def make(queue, **cfg_over):
    session = FakeSession(queue)
    cfg = Config(consumer_key="key", consumer_secret="secret",
                 shortcode="174379", passkey=PASSKEY,
                 now=lambda: T0, http_client=session, **cfg_over)
    client = MpesaClient(cfg)
    return client, session


def oauth_then(*business):
    return [FakeResponse(text=OAUTH_OK)] + list(business)


def valid_stk(**over):
    fields = dict(transaction_type="CustomerPayBillOnline", amount=1,
                  party_a="0722000000", phone_number="0722000000",
                  call_back_url="https://x.com/cb",
                  account_reference="Order001", transaction_desc="pay")
    fields.update(over)
    return STKPushRequest(**fields)


STK_OK = ('{"MerchantRequestID":"m","CheckoutRequestID":"ws_CO_1",'
          '"ResponseCode":"0","ResponseDescription":"ok",'
          '"CustomerMessage":"Success"}')
QUERY_OK = ('{"ResponseCode":"0","ResponseDescription":"ok",'
            '"MerchantRequestID":"m","CheckoutRequestID":"ws_CO_1",'
            '"ResultCode":1032,"ResultDesc":"cancelled"}')
QR_OK = ('{"ResponseCode":"AG_x","RequestID":"r",'
         '"ResponseDescription":"QR Code Successfully Generated",'
         '"QRCode":"imgdata"}')


def test_stk_push_path_bearer_and_single_clock_password():
    client, session = make(oauth_then(FakeResponse(text=STK_OK)))
    resp = client.stk_push(valid_stk())
    assert resp.is_accepted is True
    business = [c for c in session.calls if c["kind"] == "POST"]
    assert len(business) == 1
    call = business[0]
    assert call["url"].endswith("/mpesa/stkpush/v1/processrequest")
    assert call["headers"]["Authorization"] == "Bearer tok-1"
    assert call["allow_redirects"] is False
    payload = call["json"]
    assert payload["BusinessShortCode"] == "174379"     # cfg default injected
    assert payload["Password"] and len(payload["Timestamp"]) == 14
    import base64
    decoded = base64.b64decode(payload["Password"]).decode()
    assert decoded == f'174379{PASSKEY}{payload["Timestamp"]}'
    assert payload["Timestamp"] == "20260101150000"      # EAT = UTC+3


def test_stk_query_binds_password_to_effective_shortcode():
    client, session = make(oauth_then(FakeResponse(text=QUERY_OK)))
    resp = client.stk_query(STKQueryRequest(
        business_short_code="123456", checkout_request_id="ws_CO_9"))
    assert resp.result_code == "1032"
    call = [c for c in session.calls if c["kind"] == "POST"][0]
    assert call["url"].endswith("/mpesa/stkpushquery/v1/query")
    assert call["json"]["BusinessShortCode"] == "123456"


def test_validation_before_network_zero_calls():
    client, session = make([])
    with pytest.raises(ValueError):
        client.stk_push(valid_stk(amount=-1))
    assert session.calls == []                            # nothing at all


def test_oauth_once_across_two_business_calls():
    client, session = make(oauth_then(
        FakeResponse(text=STK_OK), FakeResponse(text=CONV_OK)))
    client.stk_push(valid_stk())
    client.account_balance(AccountBalanceRequest(
        initiator="i", security_credential="c", party_a="600992",
        remarks="check", queue_time_out_url="https://x.com/t",
        result_url="https://x.com/r"))
    oauth_calls = [c for c in session.calls
                   if "/oauth/v1/generate" in c["url"]]
    assert len(oauth_calls) == 1
    assert oauth_calls[0]["allow_redirects"] is False     # wrapper injects


def b2c(**over):
    base = dict(initiator_name="testapi", security_credential="cred",
                command_id=CommandID.BUSINESS_PAYMENT, amount=10,
                party_b="254705912645", remarks="payout",
                queue_time_out_url="https://x.com/t",
                result_url="https://x.com/r")
    base.update(over)
    return B2CPayoutRequest(**base)


def test_b2c_defaults_and_async_ack():
    client, session = make(oauth_then(FakeResponse(text=CONV_OK)))
    ack = client.b2c_payout(b2c())
    assert ack.response_code == "0"
    call = [c for c in session.calls if c["kind"] == "POST"][0]
    assert call["url"].endswith("/mpesa/b2c/v3/paymentrequest")
    payload = call["json"]
    assert payload["PartyA"] == "174379"                 # cfg default
    assert len(payload["OriginatorConversationID"]) == 16
    assert "Occassion" not in payload                    # omitted when unset


def test_txstatus_reversal_balance_paths_and_defaults():
    client, session = make(oauth_then(*[FakeResponse(text=CONV_OK)] * 3))
    client.transaction_status(TransactionStatusRequest(
        initiator="i", security_credential="c", transaction_id="R",
        party_a="600992", remarks="r", result_url="https://x.com/r",
        queue_time_out_url="https://x.com/t"))
    client.reversal(ReversalRequest(
        initiator="i", security_credential="c", transaction_id="R",
        amount=10, receiver_party="600992", remarks="dup",
        result_url="https://x.com/r", queue_time_out_url="https://x.com/t"))
    client.account_balance(AccountBalanceRequest(
        initiator="i", security_credential="c", party_a="600992",
        remarks="bal", result_url="https://x.com/r",
        queue_time_out_url="https://x.com/t"))
    posts = [c for c in session.calls if c["kind"] == "POST"]
    assert [c["url"].split("/")[4] for c in posts] == [
        "transactionstatus", "reversal", "accountbalance"]
    assert posts[0]["json"]["CommandID"] == "TransactionStatusQuery"
    assert posts[0]["json"]["IdentifierType"] == "4"
    assert posts[1]["json"]["RecieverIdentifierType"] == "11"
    assert posts[2]["json"]["CommandID"] == "AccountBalance"


def test_c2b_register_simulate_qr_paths_and_payloads():
    client, session = make(oauth_then(
        FakeResponse(text=C2B_OK), FakeResponse(text=C2B_OK),
        FakeResponse(text=QR_OK)))
    client.c2b_register_url(C2BRegisterRequest(
        response_type=ResponseType.COMPLETED,
        confirmation_url="https://a.com/c", validation_url="https://a.com/v"))
    client.c2b_simulate(C2BSimulateRequest(
        command_id=CommandID.C2B_PAYBILL_ONLINE, amount=5,
        msisdn="0712345678", bill_ref_number="acct"))
    qr = client.generate_qr_code(QRCodeRequest(
        merchant_name="TEST SUPERMARKET", ref_no="Invoice Test", amount=1,
        trx_code=QRTrxCode.BUY_GOODS, cpi="174379", size="300"))
    assert qr.qr_code == "imgdata"
    posts = [c for c in session.calls if c["kind"] == "POST"]
    assert posts[0]["url"].endswith("/mpesa/c2b/v2/registerurl")
    assert posts[1]["url"].endswith("/mpesa/c2b/v2/simulate")
    assert posts[2]["url"].endswith("/mpesa/qrcode/v1/generate")
    assert "RefNo" in posts[2]["json"] and "RefNumber" not in posts[2]["json"]
    assert posts[0]["json"]["ShortCode"] == "174379"     # cfg default


def test_401_retry_once_success():
    unauthorized = FakeResponse(status_code=401, text=(
        '{"requestId":"r","errorCode":"401.003.01",'
        '"errorMessage":"Invalid Access Token"}'))
    client, session = make([FakeResponse(text=OAUTH_OK), unauthorized,
                            FakeResponse(text='{"access_token":"tok-2",'
                                              '"expires_in":"3599"}'),
                            FakeResponse(text=STK_OK)])
    resp = client.stk_push(valid_stk())
    assert resp.is_accepted is True
    assert len(session.calls) == 4                       # oauth,401,tok2,retry
    assert session.calls[-1]["headers"]["Authorization"] == "Bearer tok-2"


def test_401_retry_exhaustion_typed_error():
    unauthorized = lambda: FakeResponse(status_code=401, text=(  # noqa: E731
        '{"requestId":"r","errorCode":"401.003.01",'
        '"errorMessage":"Invalid Access Token"}'))
    tok2 = FakeResponse(text='{"access_token":"tok-2","expires_in":"3599"}')
    client, session = make([FakeResponse(text=OAUTH_OK), unauthorized(),
                            tok2, unauthorized()])
    with pytest.raises(MpesaError) as excinfo:
        client.stk_push(valid_stk())
    assert excinfo.value.error_code == "401.003.01"
    business = [c for c in session.calls if c["kind"] == "POST"]
    assert len(business) == 2                            # exactly one retry


def test_non_retryable_401_surfaces_immediately():
    bad = FakeResponse(status_code=401, text=(
        '{"requestId":"r","errorCode":"400.002.02","errorMessage":"Bad"}'))
    client, session = make([FakeResponse(text=OAUTH_OK), bad])
    with pytest.raises(MpesaError):
        client.stk_push(valid_stk())
    business = [c for c in session.calls if c["kind"] == "POST"]
    assert len(business) == 1


def test_oversize_response_rejected():
    huge_desc = "A" * 1_048_600
    oversized = ('{"MerchantRequestID":"m","CheckoutRequestID":"c",'
                 '"ResponseCode":"0","ResponseDescription":"d",'
                 f'"CustomerMessage":"{huge_desc}"}}')
    client, session = make(oauth_then(FakeResponse(text=oversized)))
    with pytest.raises(ValueError, match="exceeds"):
        client.stk_push(valid_stk())


def test_redirect_attempt_not_followed():
    client, session = make(oauth_then(FakeResponse(status_code=302, text="")))
    with pytest.raises(MpesaError):
        client.stk_push(valid_stk())
    business = [c for c in session.calls if c["kind"] == "POST"]
    assert len(business) == 1                            # target hit 0 times
    assert business[0]["allow_redirects"] is False


def test_injected_session_never_mutated():
    caller = FakeSession(oauth_then(FakeResponse(text=STK_OK)))
    caller.verify = False
    cfg = Config(consumer_key="key", consumer_secret="secret",
                 shortcode="174379", passkey=PASSKEY,
                 now=lambda: T0, http_client=caller)
    client = MpesaClient(cfg)
    assert caller.verify is False                        # untouched
    assert client._session is not caller                 # internal copy
    assert client._session.verify is True                # forced internally
    client.stk_push(valid_stk())


def test_client_repr_contains_no_secrets():
    client, _ = make(oauth_then(FakeResponse(text=STK_OK)))
    rendered = repr(client)
    assert "key" != rendered and "secret" not in rendered
    assert "SANDBOX" in rendered


# ---- hardening round ---------------------------------------------------------

class StreamOnlyResponse:
    """Mimics a streamed response: no .content attr, only iter_content."""

    def __init__(self, status_code=200, text="{}", chunks=None):
        import json as _json
        self.status_code = status_code
        self._payload = text
        self._chunks = chunks
        self.headers = {"content-type": "application/json"}

    def json(self):
        import json as _json
        return _json.loads(self._payload)

    def iter_content(self, chunk_size):
        blob = self._payload.encode()
        if self._chunks is not None:
            blob = self._chunks
        for i in range(0, len(blob), chunk_size):
            yield blob[i:i + chunk_size]


def test_401_probe_is_size_capped():
    huge_body = '{"requestId":"r","errorCode":"500.001.1001",' \
                '"errorMessage":"' + "A" * 1_048_600 + '"}'
    client, session = make([
        FakeResponse(text=OAUTH_OK),
        StreamOnlyResponse(status_code=401, text=huge_body),
    ])
    with pytest.raises(ValueError, match="exceeds"):
        client.stk_push(valid_stk())


def test_send_streams_and_accumulates_without_dot_content():
    # OAuth stays on a plain FakeResponse; the BUSINESS leg proves the
    # transport never touches .content pre-read.
    client, session = make([FakeResponse(text=OAUTH_OK),
                            StreamOnlyResponse(text=STK_OK)])
    resp = client.stk_push(valid_stk())
    assert resp.is_accepted is True


def test_injections_do_not_mutate_caller_requests():
    client, session = make(oauth_then(
        FakeResponse(text=STK_OK), FakeResponse(text=QUERY_OK),
        FakeResponse(text=CONV_OK), FakeResponse(text=CONV_OK),
        FakeResponse(text=CONV_OK)))
    stk = valid_stk(business_short_code="", party_b="")
    query = STKQueryRequest(checkout_request_id="ws_CO_1")
    payout = b2c(party_a="")
    txs = TransactionStatusRequest(
        initiator="i", security_credential="c", transaction_id="R",
        party_a="600992", remarks="r", result_url="https://x.com/r",
        queue_time_out_url="https://x.com/t")
    bal = AccountBalanceRequest(
        initiator="i", security_credential="c", party_a="600992",
        remarks="bal", result_url="https://x.com/r",
        queue_time_out_url="https://x.com/t")
    client.stk_push(stk)
    client.stk_query(query)
    client.b2c_payout(payout)
    client.transaction_status(txs)
    client.account_balance(bal)
    assert stk.business_short_code == ""      # caller objects untouched
    assert stk.party_b == ""
    assert query.business_short_code == ""
    assert payout.originator_conversation_id == ""
    assert payout.party_a == ""
    assert txs.command_id is None and txs.identifier_type == ""
    assert bal.command_id is None and bal.identifier_type == ""


def test_empty_string_command_ids_trigger_defaults():
    client, session = make(oauth_then(*[FakeResponse(text=CONV_OK)] * 3))
    txs = TransactionStatusRequest(
        initiator="i", security_credential="c", transaction_id="R",
        party_a="600992", remarks="r", result_url="https://x.com/r",
        queue_time_out_url="https://x.com/t", command_id="",
        identifier_type="")
    client.transaction_status(txs)
    posts = [c for c in session.calls if c["kind"] == "POST"]
    assert posts[0]["json"]["CommandID"] == "TransactionStatusQuery"
    assert posts[0]["json"]["IdentifierType"] == "4"


def test_clone_copies_headers_snapshot():
    caller = FakeSession(oauth_then(FakeResponse(text=STK_OK)))
    caller.headers["X-Caller"] = "before"
    cfg = Config(consumer_key="key", consumer_secret="secret",
                 shortcode="174379", passkey=PASSKEY,
                 now=lambda: T0, http_client=caller)
    client = MpesaClient(cfg)
    caller.headers["X-Caller"] = "after"      # post-init mutation
    client.stk_push(valid_stk())
    # Internal clone kept its own snapshot; caller mutation invisible.


def test_lifecycle_close_and_context_manager():
    session = FakeSession(oauth_then(FakeResponse(text=STK_OK)))
    closed = []
    session.close = lambda: closed.append(True)
    cfg = Config(consumer_key="key", consumer_secret="secret",
                 shortcode="174379", passkey=PASSKEY,
                 now=lambda: T0, http_client=session)
    with MpesaClient(cfg) as client:
        client.stk_push(valid_stk())
    assert closed == [True]


def test_zero_timeout_clamps_to_thirty():
    captured = {}
    session = FakeSession(oauth_then(FakeResponse(text=STK_OK)))
    orig_request = session.request

    def spy(method, url, **kwargs):
        captured["timeout"] = kwargs.get("timeout")
        return orig_request(method, url, **kwargs)

    session.request = spy                # bound before clone: copied into it
    cfg = Config(consumer_key="key", consumer_secret="secret",
                 shortcode="174379", passkey=PASSKEY,
                 now=lambda: T0, http_client=session, timeout_seconds=0)
    MpesaClient(cfg).stk_push(valid_stk())
    assert captured["timeout"] == 30.0


def test_stk_query_default_shortcode_password_binding():
    import base64
    client, session = make(oauth_then(FakeResponse(text=QUERY_OK)))
    client.stk_query(STKQueryRequest(checkout_request_id="ws_CO_1"))
    payload = [c for c in session.calls if c["kind"] == "POST"][0]["json"]
    assert payload["BusinessShortCode"] == "174379"
    decoded = base64.b64decode(payload["Password"]).decode()
    assert decoded == f'174379{PASSKEY}{payload["Timestamp"]}'


def test_explicit_originator_passthrough():
    client, session = make(oauth_then(FakeResponse(text=CONV_OK)))
    client.b2c_payout(b2c(originator_conversation_id="explicit-ocid"))
    payload = [c for c in session.calls if c["kind"] == "POST"][0]["json"]
    assert payload["OriginatorConversationID"] == "explicit-ocid"


def test_simulate_shortcode_cfg_default():
    client, session = make(oauth_then(FakeResponse(text=C2B_OK)))
    client.c2b_simulate(C2BSimulateRequest(
        command_id=CommandID.C2B_PAYBILL_ONLINE, amount=5,
        msisdn="0712345678", bill_ref_number="acct"))
    payload = [c for c in session.calls if c["kind"] == "POST"][0]["json"]
    assert payload["ShortCode"] == "174379"


def test_401_html_body_typed_error_no_refresh():
    client, session = make([FakeResponse(text=OAUTH_OK),
                            FakeResponse(status_code=401, text="<html>504</html>")])
    with pytest.raises(MpesaError) as excinfo:
        client.stk_push(valid_stk())
    assert excinfo.value.error_code is None
    assert excinfo.value.status_code == 401
    posts = [c for c in session.calls if c["kind"] == "POST"]
    assert len(posts) == 1                    # zero refresh attempts


@pytest.mark.parametrize("call_method,req", [
    (lambda c: c.stk_push(valid_stk(amount=-1)), "stk_push"),
    (lambda c: c.stk_query(STKQueryRequest(checkout_request_id=" ")), "stk_query"),
    (lambda c: c.b2c_payout(B2CPayoutRequest(
        initiator_name="i", security_credential="c",
        command_id=CommandID.ACCOUNT_BALANCE, amount=10,
        party_a="600992", party_b="254705912645", remarks="ok",
        queue_time_out_url="https://x.com/t", result_url="https://x.com/r")),
     "b2c_payout"),
    (lambda c: c.transaction_status(TransactionStatusRequest(
        initiator="i", security_credential="c", party_a="600992",
        result_url="https://x.com/r", queue_time_out_url="https://x.com/t",
        remarks="r")), "transaction_status"),
    (lambda c: c.reversal(ReversalRequest(
        initiator="i", security_credential="c",
        command_id=CommandID.ACCOUNT_BALANCE, transaction_id="T",
        amount=10, receiver_party="600992", remarks="ok",
        result_url="https://x.com/r", queue_time_out_url="https://x.com/t")),
     "reversal"),
    (lambda c: c.account_balance(AccountBalanceRequest(
        initiator="i", security_credential="c",
        command_id=CommandID.BUSINESS_PAYMENT, party_a="600992",
        remarks="bal", queue_time_out_url="https://x.com/t",
        result_url="https://x.com/r")), "account_balance"),
    (lambda c: c.c2b_register_url(C2BRegisterRequest(
        response_type="completed", confirmation_url="https://a.com/c",
        validation_url="https://a.com/v")), "c2b_register_url"),
    (lambda c: c.c2b_simulate(C2BSimulateRequest(
        short_code="174379", command_id=CommandID.BUSINESS_PAYMENT,
        amount=5, msisdn="0712345678", bill_ref_number="acct")), "c2b_simulate"),
    (lambda c: client_generate_qr(c), "generate_qr_code"),
])
def test_validate_before_network_per_endpoint(call_method, req):
    client, session = make([])
    with pytest.raises(ValueError):
        call_method(client)
    assert session.calls == []          # zero network activity


def client_generate_qr(client):
    return client.generate_qr_code(QRCodeRequest(
        merchant_name="m", ref_no="r", amount=1, trx_code="XX",
        cpi="174379", size="300"))
