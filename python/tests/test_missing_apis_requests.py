"""Request-model tests for the three NEW endpoint families:
B2B Express Checkout, Tax Remittance and Bill Manager.

Mirrors the conventions of tests/test_requests_models.py: every model
here must (a) refuse an unvalidated ``to_payload()``, (b) validate
BEFORE any network I/O, (c) keep secrets and PII out of every text form,
and (d) resolve its tier ceiling through the SHARED limits helpers.
"""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mpesa.enums import CommandID
from mpesa.limits import TransactionLimits
from mpesa.requests_async import B2BRequest, TaxRemittanceRequest
from mpesa.requests_sync import (
    BillDeleteRequest,
    BillQueryRequest,
    BillRegisterRequest,
    BillUpdateRequest,
)

CB = "https://mydomain.com/path"
T = "https://mydomain.com/timeout"
R = "https://mydomain.com/result"
SECRET_CRED = "S3cr3t-Cr3d"


def b2b(**over):
    fields = dict(originator_conversation_id="oc-1234",
                  initiator="testapi", security_credential=SECRET_CRED,
                  command_id=CommandID.BUSINESS_PAY_BILL, amount=1000,
                  sender_identifier_type="4", receiver_identifier_type="4",
                  party_a="600000", party_b="600123",
                  account_reference="INV-001", remarks="Payment for services",
                  queue_time_out_url=T, result_url=R)
    fields.update(over)
    return B2BRequest(**fields)


def tax(**over):
    fields = dict(originator_conversation_id="oc-5678",
                  initiator="testapi", security_credential=SECRET_CRED,
                  command_id=CommandID.TAX_REMITTANCE, amount=5000,
                  sender_identifier_type="4", receiver_identifier_type="4",
                  party_a="600000", party_b="572700",
                  account_reference="TAX-2024-Q3", remarks="VAT Q3 2024",
                  tax_period="2024Q3", tax_obligation="VAT",
                  tax_payer_pin="A001234567X",
                  queue_time_out_url=T, result_url=R)
    fields.update(over)
    return TaxRemittanceRequest(**fields)


def bill_register(**over):
    fields = dict(short_code="600992", bill_ref_number="INV-001",
                  bill_name="Invoice 001", amount=1000,
                  expiry_date="2024-12-31", call_back_url=CB,
                  payer_number="254712345678", payer_name="John Doe")
    fields.update(over)
    return BillRegisterRequest(**fields)


# ---------------------------------------------------------------------
# wire contracts
# ---------------------------------------------------------------------

def test_b2b_payload_keys_are_exact():
    req = b2b()
    req.validate()
    payload = req.to_payload()
    assert payload["Initiator"] == "testapi"
    # NOT B2C's "InitiatorName": B2B uses its own key.
    assert "InitiatorName" not in payload
    assert payload["CommandID"] == "BusinessPayBill"
    assert payload["SenderIdentifierType"] == "4"   # dataset default
    assert payload["ReceiverIdentifierType"] == "4"
    assert payload["Amount"] == 1000
    assert payload["PartyA"] == "600000"
    assert payload["PartyB"] == "600123"
    assert payload["AccountReference"] == "INV-001"
    assert payload["Remarks"] == "Payment for services"
    assert payload["QueueTimeOutURL"] == T
    assert payload["ResultURL"] == R
    assert set(payload) == {
        "OriginatorConversationID", "Initiator", "SecurityCredential",
        "CommandID", "SenderIdentifierType", "ReceiverIdentifierType",
        "Amount", "PartyA", "PartyB", "AccountReference", "Remarks",
        "QueueTimeOutURL", "ResultURL", }
    # Typo regression guard: the wire key is RECEIVERd, never RECIEVERd.
    assert "RecieverIdentifierType" not in payload
    assert "RecieverIdentifierType" not in json.dumps(payload)


def test_b2b_buy_goods_command_accepted():
    req = b2b(command_id=CommandID.BUSINESS_BUY_GOODS)
    req.validate()
    assert req.to_payload()["CommandID"] == "BusinessBuyGoods"


def test_b2b_optional_fields_before_client_defaults():
    """Direct validate() fills the identifier defaults; the ID and the
    credentials stay the caller's responsibility (client injects the ID).
    """
    req = b2b(originator_conversation_id="oc-1234",
              sender_identifier_type="", receiver_identifier_type="")
    req.validate()
    assert req.sender_identifier_type == "4"
    assert req.receiver_identifier_type == "4"
    assert req.to_payload()["OriginatorConversationID"] == "oc-1234"


def test_b2b_originator_id_required_on_direct_validate():
    with pytest.raises(ValueError, match="OriginatorConversationID"):
        b2b(originator_conversation_id="").validate()


def test_tax_payload_keys_are_exact():
    req = tax()
    req.validate()
    payload = req.to_payload()
    assert payload["CommandID"] == "TaxRemittance"
    assert payload["TaxPeriod"] == "2024Q3"
    assert payload["TaxObligation"] == "VAT"
    assert payload["TaxPayerPIN"] == "A001234567X"
    assert set(payload) == {
        "OriginatorConversationID", "Initiator", "SecurityCredential",
        "CommandID", "SenderIdentifierType", "ReceiverIdentifierType",
        "Amount", "PartyA", "PartyB", "AccountReference", "Remarks",
        "QueueTimeOutURL", "ResultURL", "TaxPeriod", "TaxObligation",
        "TaxPayerPIN" }
    # Typo regression guard: the wire key is RECEIVERd, never RECIEVERd.
    assert "RecieverIdentifierType" not in payload
    assert "RecieverIdentifierType" not in json.dumps(payload)


def test_tax_remittance_payload_round_trips_json():
    req = tax()
    req.validate()
    # Wire keys survive a JSON round-trip verbatim (casing contractual).
    payload = req.to_payload()
    assert json.loads(json.dumps(payload)) == payload


# ---------------------------------------------------------------------
# CommandID restriction (mirror ReversalRequest)
# ---------------------------------------------------------------------

@pytest.mark.parametrize("bad", [
    CommandID.SALARY_PAYMENT,          # B2C-only
    CommandID.BUSINESS_PAYMENT,        # B2C-only
    CommandID.REVERSAL,
    CommandID.ACCOUNT_BALANCE,
    CommandID.TAX_REMITTANCE,          # tax-only, not B2B
    "NotACommand",
    None,
])
def test_b2b_rejects_command_id_outside_its_set(bad):
    with pytest.raises(ValueError, match=r"B2B CommandID"):
        b2b(command_id=bad).validate()


@pytest.mark.parametrize("bad", [
    CommandID.BUSINESS_PAY_BILL,        # B2B-only, not tax
    CommandID.BUSINESS_BUY_GOODS,
    CommandID.BUSINESS_PAYMENT,
    "PayeRemittance",
    None,
])
def test_tax_remittance_rejects_command_id_other_than_tax(bad):
    with pytest.raises(ValueError, match=r"TaxRemittance CommandID"):
        tax(command_id=bad).validate()


# ---------------------------------------------------------------------
# shared-helper validation
# ---------------------------------------------------------------------

@pytest.mark.parametrize("over", [
    dict(party_a="123"),                # shortcode shape
    dict(party_b="abcdefghi"),           # not digits
    dict(party_b="12345678901"),         # 11 digits
    dict(initiator=" "),                 # required
    dict(security_credential=""),        # required
    dict(amount=0),
    dict(amount=-1),
    dict(account_reference=""),           # required
    dict(remarks=""),                    # required
    dict(remarks="x" * 101),             # cap
    dict(queue_time_out_url="nope"),     # URL shape
    dict(result_url="https://localhost/x"),  # SSRF blocklist
    dict(originator_conversation_id="x" * 20),  # printable cap
])
def test_b2b_rejection_table(over):
    with pytest.raises(ValueError):
        b2b(**over).validate()


@pytest.mark.parametrize("over", [
    dict(tax_period=""),                 # required
    dict(tax_obligation=""),             # required
    dict(tax_period="x" * 17),          # cap
    dict(tax_obligation="x" * 33),       # cap
    dict(tax_payer_pin=""),              # required
    dict(tax_payer_pin="A\t001"),        # non-printable
    dict(amount=0),
    dict(party_a="1"),                   # shortcode shape
])
def test_tax_remittance_rejection_table(over):
    with pytest.raises(ValueError):
        tax(**over).validate()


def test_tax_obligation_is_free_text_not_an_enum():
    """Any Safaricom obligation string is accepted (VAT/PAYE/Excise/...)."""
    for obligation in ("VAT", "PAYE", "Excise", "Rental Tax", "Turnover Tax"):
        req = tax(tax_obligation=obligation)
        req.validate()
        assert req.tax_obligation == obligation


def test_identifier_type_length_capped_at_12():
    with pytest.raises(ValueError, match="SenderIdentifierType"):
        b2b(sender_identifier_type="1234567890123456").validate()
    with pytest.raises(ValueError, match="ReceiverIdentifierType"):
        b2b(receiver_identifier_type="1234567890123456").validate()
    req = b2b(sender_identifier_type="1", receiver_identifier_type="2")
    req.validate()
    assert req.sender_identifier_type == "1"
    assert req.receiver_identifier_type == "2"


def test_free_text_fields_are_trimmed():
    req = b2b(account_reference="  INV-002  ", remarks="  padded  ")
    req.validate()
    assert req.account_reference == "INV-002"
    assert req.remarks == "padded"


def test_both_parties_are_shortcodes_not_msisdn():
    """A business pays a business: neither party is phone-normalized."""
    # "254712345678" is a valid MSISDN for _phone but 12 digits -- too long
    # for a shortcode, so B2B must reject it rather than normalize it.
    with pytest.raises(ValueError, match="PartyA"):
        b2b(party_a="254712345678").validate()


# ---------------------------------------------------------------------
# limits
# ---------------------------------------------------------------------

def test_b2b_uses_the_b2b_bucket():
    b2b(amount=250_000).validate()                      # boundary accepted
    with pytest.raises(ValueError, match="b2b"):
        b2b(amount=250_001).validate()


def test_tax_uses_the_tax_bucket():
    tax(amount=250_000).validate()
    with pytest.raises(ValueError, match="tax"):
        tax(amount=250_001).validate()


def test_bill_register_uses_the_bill_bucket():
    bill_register(amount=250_000).validate()
    with pytest.raises(ValueError, match="bill"):
        bill_register(amount=250_001).validate()


def test_bill_update_uses_the_bill_bucket():
    req = BillUpdateRequest(short_code="600992", bill_ref_number="INV-001",
                            amount=250_000)
    req.validate()
    with pytest.raises(ValueError, match="bill"):
        BillUpdateRequest(short_code="600992", bill_ref_number="INV-001",
                          amount=250_001).validate()


def test_new_buckets_are_independent():
    """Raising b2b leaves tax and bill at the documented default."""
    from mpesa.limits import ServiceLimits
    raised = TransactionLimits(b2b=ServiceLimits(max_per_transaction=1_000_000))
    b2b(amount=500_000).validate(limits=raised)     # the raised bound honours
    with pytest.raises(ValueError, match="tax"):
        tax(amount=250_001).validate(limits=raised)  # untouched: default 250k
    with pytest.raises(ValueError, match="bill"):
        bill_register(amount=250_001).validate(limits=raised)


def test_unvalidated_models_refuse_to_payload():
    for req in (b2b(), tax(), bill_register()):
        with pytest.raises(RuntimeError, match=r"validate\(\) before to_payload"):
            req.to_payload()


# ---------------------------------------------------------------------
# Bill Manager: payload shape and optional fields
# ---------------------------------------------------------------------

def test_bill_register_payload_and_optionals():
    req = bill_register()
    req.validate()
    payload = req.to_payload()
    assert payload["BillRefNumber"] == "INV-001"
    assert payload["BillName"] == "Invoice 001"
    assert payload["Amount"] == 1000
    assert payload["ExpiryDate"] == "2024-12-31"
    assert payload["CallBackURL"] == CB
    assert payload["PayerNumber"] == "254712345678"
    assert payload["PayerName"] == "John Doe"
    assert set(payload) == {"ShortCode", "BillRefNumber", "BillName", "Amount",
                            "ExpiryDate", "CallBackURL", "PayerNumber",
                            "PayerName"}


def test_bill_register_optionals_omitted_when_absent():
    """No credential payload fields; optionals are dropped, not nulled."""
    req = bill_register(payer_number="", payer_name="")
    req.validate()
    payload = req.to_payload()
    assert "PayerNumber" not in payload
    assert "PayerName" not in payload


def test_bill_register_payer_number_normalized():
    req = bill_register(payer_number="0712345678")
    req.validate()
    assert req.payer_number == "254712345678"


def test_bill_register_payer_number_rejects_garbage():
    with pytest.raises(ValueError, match="PayerNumber"):
        bill_register(payer_number="not-a-phone").validate()


def test_bill_query_payload_is_two_keys():
    req = BillQueryRequest(short_code="600992", bill_ref_number="INV-001")
    req.validate()
    assert req.to_payload() == {"ShortCode": "600992",
                                "BillRefNumber": "INV-001"}


def test_bill_delete_payload_is_two_keys():
    req = BillDeleteRequest(short_code="600992", bill_ref_number="INV-001")
    req.validate()
    assert req.to_payload() == {"ShortCode": "600992",
                                "BillRefNumber": "INV-001"}


def test_bill_update_omits_unset_optionals():
    """Partial update: only the two keys are sent, no zero Amount."""
    req = BillUpdateRequest(short_code="600992", bill_ref_number="INV-001",
                            amount=1500)
    req.validate()
    payload = req.to_payload()
    assert payload == {"ShortCode": "600992", "BillRefNumber": "INV-001",
                       "Amount": 1500}


def test_bill_update_with_no_optionals_sends_exactly_two_keys():
    """The exact two-key body (Go and TypeScript pin the same shape)."""
    req = BillUpdateRequest(short_code="600992", bill_ref_number="INV-001")
    req.validate()
    assert req.to_payload() == {"ShortCode": "600992",
                                "BillRefNumber": "INV-001"}


def test_bill_update_none_amount_is_the_unset_sentinel():
    """``amount=None`` is the documented "not supplied" spelling; validate()
    normalizes it (and 0) and _clean drops the key either way."""
    for unset in (None, 0):
        req = BillUpdateRequest(short_code="600992",
                                bill_ref_number="INV-001", amount=unset)
        req.validate()
        assert req.amount is None
        assert "Amount" not in req.to_payload()


@pytest.mark.parametrize("blank", ["", "   "])
def test_bill_manager_drops_whitespace_only_payer_fields(blank):
    """A whitespace-only payer field counts as NOT SUPPLIED in all three
    engines: the key is DROPPED, never sent as spaces."""
    reg = bill_register(payer_number=blank, payer_name=blank)
    reg.validate()
    payload = reg.to_payload()
    assert "PayerNumber" not in payload
    assert "PayerName" not in payload

    up = BillUpdateRequest(short_code="600992", bill_ref_number="INV-001",
                           payer_number=blank, payer_name=blank)
    up.validate()
    up_payload = up.to_payload()
    assert "PayerNumber" not in up_payload
    assert "PayerName" not in up_payload
    assert up_payload == {"ShortCode": "600992", "BillRefNumber": "INV-001"}


def test_bill_update_omits_amount_when_not_supplied():
    req = BillUpdateRequest(short_code="600992", bill_ref_number="INV-001",
                            expiry_date="2025-01-31")
    req.validate()
    payload = req.to_payload()
    # Amount must NOT serialize as 0 -- that would zero the live bill.
    assert "Amount" not in payload
    assert payload["ExpiryDate"] == "2025-01-31"


def test_bill_update_omits_url_when_not_supplied():
    req = BillUpdateRequest(short_code="600992", bill_ref_number="INV-001",
                            payer_name="Jane Doe")
    req.validate()
    payload = req.to_payload()
    assert "CallBackURL" not in payload
    assert payload["PayerName"] == "Jane Doe"


def test_bill_update_rejects_bad_amount_when_supplied():
    # 0 is deliberately NOT in this list: on UPDATE a zero amount means
    # "leave the amount alone" (see test_bill_update_omits_amount_when_not_supplied).
    for bad in (-5, "100", 1.5, True):
        with pytest.raises(ValueError):
            BillUpdateRequest(short_code="600992", bill_ref_number="INV-001",
                              amount=bad).validate()


def test_bill_update_bad_url_rejected_when_supplied():
    with pytest.raises(ValueError, match="CallBackURL"):
        BillUpdateRequest(short_code="600992", bill_ref_number="INV-001",
                          call_back_url="ftp://x.com/y").validate()


@pytest.mark.parametrize("build", [
    lambda: BillQueryRequest(),
    lambda: BillDeleteRequest(bill_ref_number="  "),
    lambda: bill_register(bill_ref_number=""),
    lambda: bill_register(bill_name=""),
    lambda: bill_register(expiry_date=""),
    lambda: bill_register(call_back_url="localhost"),
    lambda: bill_register(bill_ref_number="x" * 33),
    lambda: bill_register(bill_name="n\nname"),
    lambda: bill_register(short_code="1743"),                 # too short
    lambda: bill_register(short_code="1743791234567"),        # too long
])
def test_bill_manager_rejection_table(build):
    with pytest.raises(ValueError):
        build().validate()


def test_bill_ref_number_trimmed():
    req = BillQueryRequest(short_code="600992", bill_ref_number="  INV-001  ")
    req.validate()
    assert req.bill_ref_number == "INV-001"


def test_bill_manager_models_carry_no_conversation_id():
    """Bill models have no OriginatorConversationID: nothing to seed."""
    assert not hasattr(bill_register(), "originator_conversation_id")


# ---------------------------------------------------------------------
# repr redaction
# ---------------------------------------------------------------------

def test_b2b_repr_never_leaks_credentials_or_urls():
    req = b2b()
    for rendered in (repr(req), f"{req}", str(req)):
        assert SECRET_CRED not in rendered
        assert "testapi" not in rendered
        assert T not in rendered
        assert R not in rendered
        assert "security_credential" not in rendered
        assert "initiator" not in rendered
        assert "credentials=REDACTED" in rendered
        # Safe fields are still visible.
        assert "party_a='600000'" in rendered
        assert "amount=1000" in rendered


def test_b2b_secret_fields_are_repr_suppressed_at_field_level():
    """The dataclass repr must also hide them, not just the override."""
    import dataclasses
    fields = {f.name: f for f in dataclasses.fields(B2BRequest)}
    assert fields["initiator"].repr is False
    assert fields["security_credential"].repr is False


def test_tax_remittance_repr_redacts_pin_and_credentials():
    req = tax()
    for rendered in (repr(req), f"{req}", str(req)):
        assert "A001234567X" not in rendered         # TaxPayerPIN (secret)
        assert SECRET_CRED not in rendered           # SecurityCredential
        assert "testapi" not in rendered             # Initiator
        assert T not in rendered
        assert R not in rendered
        assert "tax_payer_pin" not in rendered
        assert "tax_obligation" not in rendered
        assert "VAT" not in rendered
        assert "credentials=REDACTED" in rendered
        # Safe fields are still visible.
        assert "party_a='600000'" in rendered
        assert "amount=5000" in rendered
        assert "tax_period='2024Q3'" in rendered


def test_tax_payer_pin_is_repr_suppressed_at_field_level():
    import dataclasses
    fields = {f.name: f for f in dataclasses.fields(TaxRemittanceRequest)}
    assert fields["tax_payer_pin"].repr is False


def test_credential_secrets_survive_to_payload_despite_repr():
    """Redaction is a LOG boundary, not data loss: the secret still sends."""
    req = tax()
    req.validate()
    assert req.to_payload()["TaxPayerPIN"] == "A001234567X"
    assert req.to_payload()["SecurityCredential"] == SECRET_CRED


@pytest.mark.parametrize("build", [
    lambda: bill_register(),
    lambda: BillUpdateRequest(bill_ref_number="INV-001", amount=10,
                              payer_number="254712345678",
                              payer_name="John"),
    lambda: BillQueryRequest(bill_ref_number="INV-001"),
    lambda: BillDeleteRequest(bill_ref_number="INV-001"),
])
def test_bill_manager_repr_redacts_pii_not_ref(build):
    req = build()
    for rendered in (repr(req), f"{req}", str(req)):
        assert "John Doe" not in rendered              # PayerName
        assert "254712345678" not in rendered          # PayerNumber
        assert "John" not in rendered
        assert CB not in rendered                      # CallBackURL
        assert "call_back_url" not in rendered
        assert "credentials=REDACTED" in rendered
        # BillRefNumber is an identifier, NOT a secret: it stays visible.
        assert "bill_ref_number='INV-001'" in rendered


def test_bill_manager_repr_hides_short_code_field_name_only_when_set():
    """short_code is safe and visible when the caller set one."""
    req = bill_register(short_code="600992")
    rendered = repr(req)
    assert "short_code='600992'" in rendered
