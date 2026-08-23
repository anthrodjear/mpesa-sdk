"""Tests for request models -- mirrors go/requests_wire_test.go plus a
validate rejection table. json.dumps key asserts guard wire-key traps."""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mpesa.enums import (  # noqa: E402
    CommandID,
    QRTrxCode,
    ResponseType,
    TransactionType,
)
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

CB = "https://mydomain.com/path"


def stk_good(**over):
    fields = dict(
        business_short_code="174379",
        transaction_type=TransactionType.CUSTOMER_PAY_BILL_ONLINE,
        amount=1, party_a="254722000000", party_b="174379",
        phone_number="254722111111", call_back_url=CB,
        account_reference="accountref", transaction_desc="txndesc",
    )
    fields.update(over)
    return STKPushRequest(**fields)


def test_stk_push_wire_keys_and_client_injected_absent():
    req = stk_good()
    req.validate()
    payload = req.to_payload()
    encoded = json.dumps(payload)
    for key in ("BusinessShortCode", "Amount", "PartyA", "PartyB",
                "PhoneNumber", "CallBackURL", "AccountReference", "TransactionDesc"):
        assert key in payload
    assert '"Password"' not in encoded and '"Timestamp"' not in encoded
    assert json.loads(encoded)["TransactionType"] == "CustomerPayBillOnline"
    assert isinstance(json.loads(encoded)["Amount"], int)


def test_stk_query_payload():
    req = STKQueryRequest(business_short_code="174379", checkout_request_id="ws_CO_1")
    req.validate()
    assert set(req.to_payload()) == {"BusinessShortCode", "CheckoutRequestID"}


def test_b2c_official_spellings():
    req = B2CPayoutRequest(
        originator_conversation_id="600997_Test_32et3241ed8yu",
        initiator_name="testapi", security_credential="cred",
        command_id=CommandID.BUSINESS_PAYMENT, amount=10, party_a="600992",
        party_b="+254705912645", remarks="remarked",
        queue_time_out_url="https://mydomain.com/timeout",
        result_url="https://mydomain.com/result", occassion="ChristmasPay",
    )
    req.validate()
    assert req.party_b == "254705912645"  # normalized in place
    payload = req.to_payload()
    encoded = json.dumps(payload)
    for key in ("Occassion", "InitiatorName", "QueueTimeOutURL", "ResultURL",
                "OriginatorConversationID"):
        assert f'"{key}"' in encoded, key
    assert '"Initiator"' not in encoded   # B2C uses InitiatorName only
    assert '"Occasion"' not in encoded    # double-s Occassion on this endpoint


def test_transaction_status_single_s_occasion():
    req = TransactionStatusRequest(
        initiator="testapi", security_credential="cred",
        command_id=CommandID.TX_STATUS_QUERY, transaction_id="NLJ7RT61SV",
        party_a="600992", result_url=CB, queue_time_out_url=CB, remarks="r",
        occasion="note",
    )
    req.validate()
    encoded = json.dumps(req.to_payload())
    assert '"Occasion": "note"' in encoded
    assert '"Occassion"' not in encoded   # double-s belongs to B2C only
    assert '"OriginalConversationID"' not in encoded  # omitempty parity


def test_reversal_misspelled_identifier_default_and_override():
    base = dict(
        initiator="testapi", security_credential="cred",
        command_id=CommandID.REVERSAL, transaction_id="NLJ7RT61SV", amount=10,
        receiver_party="600992", remarks="duplicate charge",
        result_url=CB, queue_time_out_url=CB,
    )
    defaulted = ReversalRequest(**base)
    defaulted.validate()
    payload = json.dumps(defaulted.to_payload())
    assert '"RecieverIdentifierType": "11"' in payload
    assert '"ReceiverIdentifierType"' not in payload  # correct spelling never emitted
    overridden = ReversalRequest(**base, receiver_identifier_type="4")
    overridden.validate()
    assert '"RecieverIdentifierType": "4"' in json.dumps(overridden.to_payload())


def test_qr_refno_never_refnumber():
    req = QRCodeRequest(merchant_name="TEST SUPERMARKET", ref_no="Invoice Test",
                        amount=1, trx_code=QRTrxCode.BUY_GOODS, cpi="174379", size="300")
    req.validate()
    payload = req.to_payload()
    assert "RefNo" in payload and "RefNumber" not in payload
    assert json.dumps(payload) == (
        '{"MerchantName": "TEST SUPERMARKET", "RefNo": "Invoice Test", '
        '"Amount": 1, "TrxCode": "BG", "CPI": "174379", "Size": "300"}'
    )


def test_c2b_register_and_simulate_keys():
    reg = C2BRegisterRequest(short_code="174379",
                             response_type=ResponseType.COMPLETED,
                             confirmation_url="https://a.com/c",
                             validation_url="https://a.com/v")
    reg.validate()
    assert set(reg.to_payload()) == {"ShortCode", "ResponseType",
                                     "ConfirmationURL", "ValidationURL"}
    sim = C2BSimulateRequest(short_code="174379",
                             command_id=CommandID.C2B_PAYBILL_ONLINE,
                             amount=5, msisdn="0712345678", bill_ref_number="acct-1")
    sim.validate()
    sim_payload = sim.to_payload()
    assert "ResponseType" not in sim_payload           # register-only key
    assert set(sim_payload) == {"ShortCode", "CommandID", "Amount",
                                "Msisdn", "BillRefNumber"}
    assert sim_payload["Msisdn"] == "254712345678"     # normalized


@pytest.mark.parametrize(
    "mutate,fragment",
    [
        (lambda r: setattr(r, "business_short_code", ""), "BusinessShortCode is required"),
        (lambda r: setattr(r, "transaction_type", None),
         "(CustomerPayBillOnline | CustomerBuyGoodsOnline)"),
        (lambda r: setattr(r, "transaction_type", "CustomerPaybillOnline"), "TransactionType"),
        (lambda r: setattr(r, "amount", -1), "Amount"),
        (lambda r: setattr(r, "amount", True), "whole number"),
        (lambda r: setattr(r, "amount", 1.5), "whole number"),
        (lambda r: setattr(r, "party_a", "12345"), "invalid PartyA"),
        (lambda r: setattr(r, "account_reference", "x" * 13), "exceeds 12"),
        (lambda r: setattr(r, "transaction_desc", "x" * 14), "exceeds 13"),
        (lambda r: setattr(r, "call_back_url", "ftp://x.com"), "absolute http(s) URL"),
    ],
)
def test_stk_push_validate_rejections(mutate, fragment):
    req = stk_good()
    mutate(req)
    with pytest.raises(ValueError) as excinfo:
        req.validate()
    assert fragment in str(excinfo.value)


def test_query_requires_checkout_id():
    with pytest.raises(ValueError, match="CheckoutRequestID is required"):
        STKQueryRequest(checkout_request_id=" ").validate()


@pytest.mark.parametrize(
    "req",
    [
        B2CPayoutRequest(initiator_name="i", security_credential="c",
                         command_id=CommandID.ACCOUNT_BALANCE, amount=10,
                         party_a="600992", party_b="254705912645", remarks="ok",
                         queue_time_out_url=CB, result_url=CB),
        B2CPayoutRequest(initiator_name="i", security_credential="c",
                         command_id=CommandID.BUSINESS_PAYMENT, amount=5,
                         party_a="600992", party_b="254705912645", remarks="ok",
                         queue_time_out_url=CB, result_url=CB),
        B2CPayoutRequest(initiator_name="i", security_credential="c",
                         command_id=CommandID.BUSINESS_PAYMENT, amount=250001,
                         party_a="600992", party_b="254705912645", remarks="ok",
                         queue_time_out_url=CB, result_url=CB),
        B2CPayoutRequest(initiator_name="i", security_credential="c",
                         command_id=CommandID.BUSINESS_PAYMENT, amount=10,
                         party_a="600992", party_b="254705912645", remarks="x",
                         queue_time_out_url=CB, result_url=CB),
        TransactionStatusRequest(initiator="i", security_credential="c",
                                 party_a="600992", result_url=CB,
                                 queue_time_out_url=CB, remarks="r"),
        TransactionStatusRequest(initiator="i", security_credential="c",
                                 transaction_id="A", original_conversation_id="B",
                                 party_a="600992", result_url=CB,
                                 queue_time_out_url=CB, remarks="r"),
        ReversalRequest(initiator="i", security_credential="c",
                        command_id=CommandID.ACCOUNT_BALANCE, transaction_id="T",
                        amount=10, receiver_party="600992", remarks="ok",
                        result_url=CB, queue_time_out_url=CB),
        C2BRegisterRequest(short_code="174379", response_type="completed",
                           confirmation_url=CB, validation_url=CB),
        C2BSimulateRequest(short_code="174379",
                           command_id=TransactionType.CUSTOMER_PAY_BILL_ONLINE,
                           amount=5, msisdn="0712345678", bill_ref_number=" "),
        QRCodeRequest(merchant_name="m", ref_no="r", amount=1,
                      trx_code="XX", cpi="174379", size="300"),
        QRCodeRequest(merchant_name="m", ref_no="r", amount=1,
                      trx_code=QRTrxCode.SEND_MONEY, cpi="17a379", size="300"),
    ],
)
def test_validate_rejection_table(req):
    with pytest.raises(ValueError):
        req.validate()


# ---- consolidated-fix rounds -------------------------------------------------

def _b2c(**over):
    base = dict(initiator_name="testapi", security_credential="cred",
                command_id=CommandID.BUSINESS_PAYMENT, amount=10,
                party_a="600992", party_b="254705912645", remarks="ok",
                queue_time_out_url=CB, result_url=CB)
    base.update(over)
    return B2CPayoutRequest(**base)


def _txs(**over):
    base = dict(initiator="testapi", security_credential="cred",
                command_id=CommandID.TX_STATUS_QUERY, transaction_id="NLJ7RT61SV",
                party_a="600992", result_url=CB, queue_time_out_url=CB, remarks="r")
    base.update(over)
    return TransactionStatusRequest(**base)


def _rev(**over):
    base = dict(initiator="testapi", security_credential="cred",
                command_id=CommandID.REVERSAL, transaction_id="NLJ7RT61SV",
                amount=10, receiver_party="600992", remarks="duplicate charge",
                result_url=CB, queue_time_out_url=CB)
    base.update(over)
    return ReversalRequest(**base)


def _bal(**over):
    base = dict(initiator="testapi", security_credential="cred",
                command_id=CommandID.ACCOUNT_BALANCE, party_a="600992",
                remarks="balance check", queue_time_out_url=CB, result_url=CB)
    base.update(over)
    return AccountBalanceRequest(**base)


def test_credential_models_never_leak_via_any_text_form():
    leaky = {
        "B2C": _b2c(),
        "TxStatus": _txs(),
        "Reversal": _rev(),
        "Balance": _bal(),
    }
    for name, req in leaky.items():
        for rendered in (repr(req), f"{req}", str(req)):
            assert "testapi" not in rendered, name
            assert "cred" != rendered and "security_credential='cred'" not in rendered
            assert "credentials=REDACTED" in rendered, (name, rendered)


def test_to_payload_requires_validate_sentinel():
    with pytest.raises(RuntimeError, match=r"validate\(\) before to_payload"):
        stk_good().to_payload()


def test_qr_size_ascii_digit_gate():
    for bad in ("\u0663\u0660\u0660", "\u00b2"):  # Arabic-Indic 300, superscript two
        req = QRCodeRequest(merchant_name="m", ref_no="r", amount=1,
                            trx_code=QRTrxCode.PAYBILL, cpi="174379", size=bad)
        with pytest.raises(ValueError):
            req.validate()
    ok = QRCodeRequest(merchant_name="m", ref_no="r", amount=1,
                       trx_code=QRTrxCode.PAYBILL, cpi="174379", size="300")
    ok.validate()


def test_url_regex_rejects_whitespace_in_target():
    req = stk_good(call_back_url="https://x.com/pa th")
    with pytest.raises(ValueError, match="CallBackURL"):
        req.validate()


def test_remarks_stripped_in_place():
    req = _b2c(remarks="  padded remark  ")
    req.validate()
    assert req.remarks == "padded remark"


def test_xor_identifiers_treat_whitespace_as_unset():
    with pytest.raises(ValueError, match="exactly one"):
        _txs(transaction_id="   ").validate()
    req = _txs(transaction_id="  NLJ7RT61SV  ")
    req.validate()
    assert req.transaction_id == "NLJ7RT61SV"


def test_clean_drops_only_none_and_empty_strings():
    from mpesa.requests_sync import _clean
    assert _clean({"A": 0, "B": None, "C": "", "D": False}) == {"A": 0, "D": False}


def test_stk_party_a_normalized_in_place():
    req = stk_good(party_a="0722000000", phone_number="0722111111")
    req.validate()
    assert req.party_a == "254722000000"
    assert req.phone_number == "254722111111"


def test_transaction_type_empty_string_is_required_message():
    with pytest.raises(ValueError, match=r"\(CustomerPayBillOnline \| CustomerBuyGoodsOnline\)"):
        stk_good(transaction_type="").validate()


def test_omission_pins():
    b2c = _b2c(); b2c.validate()
    assert '"Occassion"' not in json.dumps(b2c.to_payload())
    txs = _txs(); txs.validate()
    txs_encoded = json.dumps(txs.to_payload())
    assert '"Occasion"' not in txs_encoded
    assert '"IdentifierType"' not in txs_encoded
    rev = _rev(receiver_identifier_type=None); rev.validate()
    assert '"RecieverIdentifierType": "11"' in json.dumps(rev.to_payload())
    bal = _bal(); bal.validate()
    assert '"IdentifierType"' not in json.dumps(bal.to_payload())


@pytest.mark.parametrize(
    "req",
    [
        _b2c(party_b="123"),
        _b2c(queue_time_out_url="https://x.com/a b"),
        _b2c(result_url="nope"),
        _b2c(initiator_name=" "),
        _b2c(security_credential=""),
        _b2c(remarks="x" * 101),
        _txs(command_id=CommandID.REVERSAL),
        _txs(remarks=""),
        _txs(remarks="x" * 101),
        _rev(amount=0),
        _rev(remarks="x" * 101),
        _rev(transaction_id=" "),
        _bal(command_id=CommandID.BUSINESS_PAYMENT),
        C2BSimulateRequest(short_code="174379",
                           command_id=TransactionType.CUSTOMER_PAY_BILL_ONLINE,
                           amount=0, msisdn="0712345678", bill_ref_number="acct"),
        C2BSimulateRequest(short_code="174379",
                           command_id=CommandID.BUSINESS_PAYMENT,
                           amount=5, msisdn="0712345678", bill_ref_number="acct"),
        QRCodeRequest(merchant_name="m", ref_no="r", amount=1,
                      trx_code=QRTrxCode.SEND_MONEY, cpi="1234", size="300"),
        STKQueryRequest(checkout_request_id="x" * 65),
        C2BSimulateRequest(short_code="174379",
                           command_id=TransactionType.CUSTOMER_PAY_BILL_ONLINE,
                           amount=5, msisdn="254712345678",
                           bill_ref_number="bad\nref"),
    ],
)
def test_extended_rejection_table(req):
    with pytest.raises(ValueError):
        req.validate()
