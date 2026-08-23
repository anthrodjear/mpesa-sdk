"""Tests for mpesa.enums -- wire-value fidelity and json round-trips."""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mpesa.enums import (  # noqa: E402
    ORGANIZATION_SHORTCODE,
    RECEIVER_IDENTIFIER_ORG,
    CommandID,
    Environment,
    QRTrxCode,
    ResponseType,
    TransactionType,
)


def test_environment_base_urls():
    assert Environment.SANDBOX.base_url == "https://sandbox.safaricom.co.ke"
    assert Environment.PRODUCTION.base_url == "https://api.safaricom.co.ke"
    assert Environment.SANDBOX.value == Environment.SANDBOX.base_url


def test_environment_is_not_str_mixin():
    assert not isinstance(Environment.SANDBOX, str)


def test_transaction_type_wire_values():
    assert TransactionType.CUSTOMER_PAY_BILL_ONLINE == "CustomerPayBillOnline"
    assert TransactionType.CUSTOMER_BUY_GOODS_ONLINE == "CustomerBuyGoodsOnline"
    assert len(TransactionType) == 2


def test_command_id_wire_values_and_count():
    expected = {
        "SalaryPayment",
        "BusinessPayment",
        "PromotionPayment",
        "TransactionStatusQuery",
        "TransactionReversal",
        "AccountBalance",
        "CustomerPayBillOnline",
        "CustomerBuyGoodsOnline",
    }
    assert {m.value for m in CommandID} == expected
    assert len(CommandID) == 8


def test_response_type_sentence_case():
    assert ResponseType.COMPLETED == "Completed"
    assert ResponseType.CANCELLED == "Cancelled"
    assert ResponseType.COMPLETED != "COMPLETED"
    assert len(ResponseType) == 2


def test_qr_trx_codes():
    assert [m.value for m in QRTrxCode] == ["BG", "WA", "PB", "SM", "SB"]
    assert len(QRTrxCode) == 5


def test_identifier_constants():
    assert ORGANIZATION_SHORTCODE == "4"
    assert RECEIVER_IDENTIFIER_ORG == "11"


def test_json_dumps_emits_wire_values_directly():
    payload = {
        "TransactionType": TransactionType.CUSTOMER_PAY_BILL_ONLINE,
        "CommandID": CommandID.BUSINESS_PAYMENT,
        "ResponseType": ResponseType.COMPLETED,
        "TrxCode": QRTrxCode.PAYBILL,
    }
    encoded = json.dumps(payload)
    assert "CustomerPayBillOnline" in encoded
    assert "BusinessPayment" in encoded
    assert '"Completed"' in encoded
    assert '"PB"' in encoded
    assert ".value" not in encoded  # members serialize bare, no wrappers


def test_json_round_trip_back_to_members():
    blob = json.dumps({"CommandID": CommandID.TX_STATUS_QUERY})
    decoded = json.loads(blob)["CommandID"]
    assert decoded == "TransactionStatusQuery"
    assert CommandID(decoded) is CommandID.TX_STATUS_QUERY
