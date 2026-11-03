"""Client tests for the three NEW endpoint families
(B2B Express Checkout, Tax Remittance, Bill Manager).

Mirrors tests/test_client.py's fake-session style: OAuth is the first
canned reply, every assertion is made against the recorded call, and a
validation failure must leave the session with ZERO calls (validation
happens before any network I/O).
"""

import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import requests

from mpesa import MpesaClient
from mpesa.config import Config
from mpesa.enums import CommandID
from mpesa.exceptions import MpesaError
from mpesa.limits import ServiceLimits, TransactionLimits
from mpesa.requests_async import B2BRequest, TaxRemittanceRequest
from mpesa.requests_sync import (
    BillDeleteRequest,
    BillQueryRequest,
    BillRegisterRequest,
    BillUpdateRequest,
)

T0 = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
OAUTH_OK = '{"access_token":"tok-1","expires_in":"3599"}'
CONV_OK = ('{"OriginatorConversationID":"o-1","ConversationID":"AG_1",'
           '"ResponseCode":"0","ResponseDescription":"Accept"}')
BILL_ACK = ('{"ResponseCode":"0","ResponseDescription":"ok",'
            '"ConversationID":"AG_9","OriginatorConversationID":"o-9",'
            '"BillRefNumber":"INV-001"}')
CB = "https://mydomain.com/path"


class FakeResponse:
    def __init__(self, status_code=200, text="{}"):
        self.status_code = status_code
        self.content = text.encode()
        self.headers = {"content-type": "application/json"}

    def iter_content(self, chunk_size):
        for i in range(0, len(self.content), chunk_size):
            yield self.content[i:i + chunk_size]

    def close(self):
        pass


class FakeSession:
    """Duck-typed session: shallow-copyable, programmable, recording."""

    def __init__(self, queue):
        self.headers = {}
        self.adapters = {}
        self.verify = False
        self.calls = []
        self.queue = list(queue)

    def request(self, method, url, json=None, params=None, timeout=None,
                allow_redirects=True, headers=None, stream=False):
        self.calls.append({"kind": method, "url": url, "json": json,
                           "headers": headers})
        return self.queue.pop(0)

    def get(self, url, **kwargs):
        self.calls.append({"kind": "GET", "url": url, **kwargs})
        return self.queue.pop(0)


def make(*replies, limits=None, track_daily=False, shortcode="174379"):
    session = FakeSession(replies)
    cfg = Config(consumer_key="key", consumer_secret="secret",
                 shortcode=shortcode, passkey="p" * 10,
                 now=lambda: T0, http_client=session,
                 limits=limits, track_daily=track_daily)
    return MpesaClient(cfg), session


def posts(session):
    return [c for c in session.calls if c["kind"] == "POST"]


def b2b(**over):
    fields = dict(initiator="testapi", security_credential="cred",
                  command_id=CommandID.BUSINESS_PAY_BILL, amount=1000,
                  party_a="600000", party_b="600123",
                  account_reference="INV-001", remarks="Payment for services",
                  queue_time_out_url="https://x.com/t",
                  result_url="https://x.com/r")
    fields.update(over)
    return B2BRequest(**fields)


def tax(**over):
    fields = dict(initiator="testapi", security_credential="cred",
                  command_id=CommandID.TAX_REMITTANCE, amount=5000,
                  party_a="600000", party_b="572700",
                  account_reference="TAX-2024-Q3", remarks="VAT Q3 2024",
                  tax_period="2024Q3", tax_obligation="VAT",
                  tax_payer_pin="A001234567X",
                  queue_time_out_url="https://x.com/t",
                  result_url="https://x.com/r")
    fields.update(over)
    return TaxRemittanceRequest(**fields)


def bill_register(**over):
    fields = dict(bill_ref_number="INV-001", bill_name="Invoice 001",
                  amount=1000, expiry_date="2024-12-31",
                  call_back_url=CB, payer_number="254712345678",
                  payer_name="John Doe")
    fields.update(over)
    return BillRegisterRequest(**fields)


# ---------------------------------------------------------------------
# happy paths: path, body, Bearer
# ---------------------------------------------------------------------

def test_b2b_payment_path_body_and_bearer():
    client, session = make(*[FakeResponse(text=OAUTH_OK),
                             FakeResponse(text=CONV_OK)])
    ack = client.b2b_payment(b2b())
    assert ack.response_code == "0"
    assert len(posts(session)) == 1
    call = posts(session)[0]
    assert call["url"].endswith("/mpesa/b2b/v3/paymentrequest")
    assert call["headers"]["Authorization"] == "Bearer tok-1"
    body = call["json"]
    assert body["Initiator"] == "testapi"
    assert body["CommandID"] == "BusinessPayBill"
    assert body["Amount"] == 1000
    assert body["PartyA"] == "600000"
    assert body["PartyB"] == "600123"
    assert body["AccountReference"] == "INV-001"
    assert body["SecurityCredential"] == "cred"


def test_b2b_payment_defaults_injected_and_caller_not_mutated():
    client, session = make(*[FakeResponse(text=OAUTH_OK),
                             FakeResponse(text=CONV_OK)])
    req = b2b()
    original_id = req.originator_conversation_id
    client.b2b_payment(req)
    body = posts(session)[0]["json"]
    # Client-side defaults.
    assert len(body["OriginatorConversationID"]) == 16
    assert all(ch in "0123456789abcdefABCDEF"
               for ch in body["OriginatorConversationID"])
    assert body["SenderIdentifierType"] == "4"
    assert body["ReceiverIdentifierType"] == "4"
    # The caller's object is untouched (requests are values).
    assert req.originator_conversation_id == original_id
    assert req.sender_identifier_type == ""
    assert req.receiver_identifier_type == ""


def test_tax_remittance_path_body_and_bearer():
    client, session = make(*[FakeResponse(text=OAUTH_OK),
                             FakeResponse(text=CONV_OK)])
    ack = client.tax_remittance(tax())
    assert ack.response_code == "0"
    call = posts(session)[0]
    assert call["url"].endswith("/mpesa/b2b/v1/remittax")
    assert call["headers"]["Authorization"] == "Bearer tok-1"
    body = call["json"]
    assert body["CommandID"] == "TaxRemittance"
    assert body["TaxPeriod"] == "2024Q3"
    assert body["TaxObligation"] == "VAT"
    assert body["TaxPayerPIN"] == "A001234567X"
    assert body["Amount"] == 5000
    assert len(body["OriginatorConversationID"]) == 16


def test_tax_remittance_defaults_injected_and_caller_not_mutated():
    client, session = make(*[FakeResponse(text=OAUTH_OK),
                             FakeResponse(text=CONV_OK)])
    req = tax(command_id=None, sender_identifier_type="",
              receiver_identifier_type="")
    client.tax_remittance(req)
    body = posts(session)[0]["json"]
    assert body["CommandID"] == "TaxRemittance"
    assert body["SenderIdentifierType"] == "4"
    assert body["ReceiverIdentifierType"] == "4"
    assert req.command_id is None          # caller's object untouched
    assert req.sender_identifier_type == ""


def test_all_four_bill_paths_and_bodies():
    client, session = make(*[FakeResponse(text=OAUTH_OK)] +
                             [FakeResponse(text=BILL_ACK)] * 4)
    r_ack = client.bill_register(bill_register())
    q_ack = client.bill_query(BillQueryRequest(bill_ref_number="INV-001"))
    u_ack = client.bill_update(BillUpdateRequest(bill_ref_number="INV-001",
                                                amount=1500))
    d_ack = client.bill_delete(BillDeleteRequest(bill_ref_number="INV-001"))
    for ack in (r_ack, q_ack, u_ack, d_ack):
        assert ack.response_code == "0"
        assert ack.conversation_id == "AG_9"
        assert ack.originator_conversation_id == "o-9"
    called = posts(session)
    assert [c["url"].split("/")[4] for c in called] == [
        "billmanager"] * 4
    assert [c["url"].rsplit("/", 1)[-1] for c in called] == [
        "register", "query", "update", "delete"]
    assert all(c["url"].endswith("/mpesa/billmanager/v1/" + op)
               for c, op in zip(called, ("register", "query", "update",
                                         "delete"), strict=True))
    assert all(c["headers"]["Authorization"] == "Bearer tok-1"
               for c in called)
    assert called[0]["json"]["ShortCode"] == "174379"      # cfg default
    assert called[0]["json"]["BillRefNumber"] == "INV-001"
    assert called[1]["json"] == {"ShortCode": "174379", "BillRefNumber": "INV-001"}
    assert called[3]["json"] == {"ShortCode": "174379", "BillRefNumber": "INV-001"}


def test_bill_manager_caller_object_not_mutated():
    client, _ = make(*[FakeResponse(text=OAUTH_OK)] +
                     [FakeResponse(text=BILL_ACK)] * 4)
    req = bill_register(short_code="")
    client.bill_register(req)
    # The caller's shortcode stays empty; the config default travels only
    # on the internal dataclasses.replace() copy.
    assert req.short_code == ""
    assert req.bill_ref_number == "INV-001"
    # The other bill models behave the same way.
    q = BillQueryRequest(short_code="", bill_ref_number="INV-001")
    client.bill_query(q)
    assert q.short_code == ""
    u = BillUpdateRequest(short_code="", bill_ref_number="INV-001")
    client.bill_update(u)
    assert u.short_code == ""
    d = BillDeleteRequest(short_code="", bill_ref_number="INV-001")
    client.bill_delete(d)
    assert d.short_code == ""


# ---------------------------------------------------------------------
# validation happens BEFORE any network I/O
# ---------------------------------------------------------------------

@pytest.mark.parametrize("call,req", [
    (lambda c, r: c.b2b_payment(r), lambda: b2b(command_id=CommandID.REVERSAL)),
    (lambda c, r: c.b2b_payment(r), lambda: b2b(party_a="123")),
    (lambda c, r: c.b2b_payment(r), lambda: b2b(initiator=" ")),
    (lambda c, r: c.b2b_payment(r), lambda: b2b(account_reference="")),
    (lambda c, r: c.tax_remittance(r), lambda: tax(command_id=CommandID.BUSINESS_PAY_BILL)),
    (lambda c, r: c.tax_remittance(r), lambda: tax(tax_payer_pin="")),
    (lambda c, r: c.tax_remittance(r), lambda: tax(party_b="abc")),
    (lambda c, r: c.tax_remittance(r), lambda: tax(tax_period="")),
    (lambda c, r: c.bill_register(r), lambda: bill_register(bill_ref_number="")),
    (lambda c, r: c.bill_register(r), lambda: bill_register(bill_name="")),
    (lambda c, r: c.bill_register(r), lambda: bill_register(expiry_date="")),
    (lambda c, r: c.bill_query(r), lambda: BillQueryRequest()),
    (lambda c, r: c.bill_query(r), lambda: BillQueryRequest(short_code="1")),
    (lambda c, r: c.bill_update(r), lambda: BillUpdateRequest(bill_ref_number="")),
    (lambda c, r: c.bill_delete(r), lambda: BillDeleteRequest(bill_ref_number="x" * 40)),
])
def test_validation_before_network_zero_calls(call, req):
    client, session = make([])                     # empty queue: no replies
    with pytest.raises(ValueError):
        call(client, req())
    assert session.calls == []                     # nothing at all
    assert posts(session) == []


def test_secret_travels_despite_being_log_invisible():
    """`repr` hides the PIN; the transport still carries it."""
    client, _ = make(*[FakeResponse(text=OAUTH_OK), FakeResponse(text=CONV_OK)])
    ack = client.tax_remittance(tax())
    assert ack.response_code == "0"


# ---------------------------------------------------------------------
# per-transaction ceiling
# ---------------------------------------------------------------------

@pytest.mark.parametrize("call,req", [
    (lambda c, r: c.b2b_payment(r), lambda: b2b(amount=250_001)),
    (lambda c, r: c.tax_remittance(r), lambda: tax(amount=250_001)),
    (lambda c, r: c.bill_register(r), lambda: bill_register(amount=250_001)),
])
def test_per_transaction_ceiling_rejected_before_network(call, req):
    client, session = make([])
    with pytest.raises(ValueError, match="per-transaction ceiling"):
        call(client, req())
    assert session.calls == []                     # never reached OAuth


def test_bill_update_ceiling_only_when_amount_supplied():
    client, _ = make(*[FakeResponse(text=OAUTH_OK), FakeResponse(text=CONV_OK)])
    # 250_001 on a partial update still trips the bill ceiling.
    with pytest.raises(ValueError, match="per-transaction ceiling"):
        client.bill_update(BillUpdateRequest(bill_ref_number="INV-001",
                                            amount=250_001))


def test_bill_update_big_amount_accepted_at_boundary():
    ack = ('{"ResponseCode":"0","ResponseDescription":"ok",'
           '"ConversationID":"c","OriginatorConversationID":"o"}')
    client, session = make(*[FakeResponse(text=OAUTH_OK), FakeResponse(text=ack)])
    client.bill_update(BillUpdateRequest(bill_ref_number="INV-001",
                                        amount=250_000))
    assert posts(session)[0]["json"]["Amount"] == 250_000


# ---------------------------------------------------------------------
# daily quota: accrue + rollback (RequestException only)
# ---------------------------------------------------------------------

def test_new_buckets_accrue_independently():
    ack = ('{"ResponseCode":"0","ResponseDescription":"ok",'
           '"ConversationID":"c","OriginatorConversationID":"o"}')
    limits = TransactionLimits(
        b2b=ServiceLimits(1_000_000, 10_000),
        tax=ServiceLimits(1_000_000, 10_000),
        bill=ServiceLimits(1_000_000, 10_000),
    )
    client, _ = make(*[FakeResponse(text=OAUTH_OK), FakeResponse(text=CONV_OK),
                       FakeResponse(text=CONV_OK), FakeResponse(text=ack)],
                     limits=limits, track_daily=True)
    client.b2b_payment(b2b(amount=9_000))
    assert client.daily_spend == {"b2b": 9_000}
    client.tax_remittance(tax(amount=5_000))
    assert client.daily_spend == {"b2b": 9_000, "tax": 5_000}
    client.bill_register(bill_register(amount=4_000))
    assert client.daily_spend == {"b2b": 9_000, "tax": 5_000, "bill": 4_000}
    # One more 1k bill pushes it over the bill bucket only.
    with pytest.raises(ValueError, match="per-day ceiling"):
        client.bill_register(bill_register(amount=7_000))
    assert client.daily_spend == {"b2b": 9_000, "tax": 5_000, "bill": 4_000}


def test_bill_query_and_delete_never_accrue():
    limits = TransactionLimits(bill=ServiceLimits(1_000_000, 10_000))
    client, _ = make(*[FakeResponse(text=OAUTH_OK)] +
                     [FakeResponse(text=BILL_ACK)] * 2,
                     limits=limits, track_daily=True)
    client.bill_query(BillQueryRequest(bill_ref_number="INV-001"))
    client.bill_delete(BillDeleteRequest(bill_ref_number="INV-001"))
    assert client.daily_spend == {}


def test_bill_update_without_amount_never_accrues():
    limits = TransactionLimits(bill=ServiceLimits(1, 1))
    client, _ = make(*[FakeResponse(text=OAUTH_OK),
                       FakeResponse(text=BILL_ACK)],
                     limits=limits, track_daily=True)
    # No amount: the 1-KES daily ceiling must be irrelevant.
    client.bill_update(BillUpdateRequest(bill_ref_number="INV-001",
                                        payer_name="Jane"))
    assert client.daily_spend == {}


class TransportFailSession(FakeSession):
    def request(self, method, url, json=None, params=None, timeout=None,
                allow_redirects=True, headers=None, stream=False):
        self.calls.append({"kind": method, "url": url, "json": json})
        if method == "POST":
            raise requests.exceptions.ConnectionError("simulated blip")
        return self.queue.pop(0)


@pytest.mark.parametrize("call,req,service", [
    (lambda c, r: c.b2b_payment(r), lambda: b2b(amount=5_000), "b2b"),
    (lambda c, r: c.tax_remittance(r), lambda: tax(amount=5_000), "tax"),
    (lambda c, r: c.bill_register(r), lambda: bill_register(amount=5_000), "bill"),
])
def test_transport_error_rolls_back(call, req, service):
    """A network blip refunds the reservation (Go recordTransportRollback
    parity) on EVERY new amount-bearing endpoint.
    """
    limits = TransactionLimits(
        b2b=ServiceLimits(1_000_000, 10_000),
        tax=ServiceLimits(1_000_000, 10_000),
        bill=ServiceLimits(1_000_000, 10_000))
    session = TransportFailSession([FakeResponse(text=OAUTH_OK)])
    cfg = Config(consumer_key="key", consumer_secret="secret",
                 shortcode="174379", passkey="p" * 10,
                 now=lambda: T0, http_client=session,
                 limits=limits, track_daily=True)
    client = MpesaClient(cfg)
    with pytest.raises(requests.exceptions.ConnectionError):
        call(client, req())
    assert client.daily_spend == {service: 0}


def test_bill_update_transport_error_rolls_back():
    limits = TransactionLimits(bill=ServiceLimits(1_000_000, 10_000))
    session = TransportFailSession([FakeResponse(text=OAUTH_OK)])
    cfg = Config(consumer_key="key", consumer_secret="secret",
                 shortcode="174379", passkey="p" * 10,
                 now=lambda: T0, http_client=session,
                 limits=limits, track_daily=True)
    client = MpesaClient(cfg)
    with pytest.raises(requests.exceptions.ConnectionError):
        client.bill_update(BillUpdateRequest(bill_ref_number="INV-001",
                                            amount=5_000))
    assert client.daily_spend == {"bill": 0}


@pytest.mark.parametrize("call,req,service", [
    (lambda c, r: c.b2b_payment(r), lambda: b2b(amount=5_000), "b2b"),
    (lambda c, r: c.tax_remittance(r), lambda: tax(amount=5_000), "tax"),
    (lambda c, r: c.bill_register(r), lambda: bill_register(amount=5_000), "bill"),
])
def test_gateway_error_keeps_reservation(call, req, service):
    """A gateway rejection KEEPS the reservation: the request WAS sent."""
    limits = TransactionLimits(
        b2b=ServiceLimits(1_000_000, 10_000),
        tax=ServiceLimits(1_000_000, 10_000),
        bill=ServiceLimits(1_000_000, 10_000))
    client, _ = make(*[FakeResponse(text=OAUTH_OK),
                       FakeResponse(status_code=500, text="{}")],
                     limits=limits, track_daily=True)
    with pytest.raises(MpesaError):
        call(client, req())
    assert client.daily_spend == {service: 5_000}


# ---------------------------------------------------------------------
# response decoding
# ---------------------------------------------------------------------

def test_bill_ack_response_model_decodes_all_keys():
    from mpesa.responses import BillAckResponse
    ack = BillAckResponse.from_json(
        '{"ResponseCode":"0","ResponseDescription":"ok",'
        '"ConversationID":"AG_9","OriginatorConversationID":"o-9",'
        '"BillRefNumber":"INV-001"}')
    assert ack.response_code == "0"
    assert ack.conversation_id == "AG_9"
    assert ack.originator_conversation_id == "o-9"
    assert ack.bill_ref_number == "INV-001"


def test_bill_ack_response_tolerates_absent_bill_ref_number():
    """OPTIONAL key: a missing BillRefNumber decodes to "", not an error."""
    from mpesa.responses import BillAckResponse
    ack = BillAckResponse.from_json(
        '{"ResponseCode":"0","ResponseDescription":"ok",'
        '"ConversationID":"AG_9","OriginatorConversationID":"o-9"}')
    assert ack.bill_ref_number == ""
    # ... also on the bytes and dict paths.
    ack2 = BillAckResponse.from_json(
        b'{"ResponseCode":"0","ResponseDescription":"ok",'
        b'"ConversationID":"c","OriginatorConversationID":"o"}')
    assert ack2.bill_ref_number == ""
    ack3 = BillAckResponse.from_json(
        {"ResponseCode": "0", "ResponseDescription": "ok",
         "ConversationID": "c", "OriginatorConversationID": "o"})
    assert ack3.bill_ref_number == ""


def test_bill_ack_response_still_requires_the_four_keys():
    from mpesa.responses import BillAckResponse
    for missing in ("ResponseCode", "ResponseDescription", "ConversationID",
                    "OriginatorConversationID"):
        body = {"ResponseCode": "0", "ResponseDescription": "ok",
                "ConversationID": "c", "OriginatorConversationID": "o"}
        body.pop(missing)
        with pytest.raises(ValueError, match="BillAckResponse"):
            BillAckResponse.from_json(body)


def test_bill_ack_number_coercion_is_lenient():
    """Safaricom flips str/int encodings; decodes both."""
    from mpesa.responses import BillAckResponse
    ack = BillAckResponse.from_json(
        '{"ResponseCode":0,"ResponseDescription":"ok",'
        '"ConversationID":123,"OriginatorConversationID":"o"}')
    assert ack.response_code == "0"
    assert ack.conversation_id == "123"
