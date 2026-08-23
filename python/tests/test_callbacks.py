"""Tests for mpesa.callbacks -- mirrors go/callbacks_test.go."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mpesa.callbacks import StkCallbackResult  # noqa: E402
from mpesa.classification import ResultClass  # noqa: E402

SUCCESS_RAW = b"""{
    "Body": {"stkCallback": {
        "MerchantRequestID": "29115-34620561-1",
        "CheckoutRequestID": "ws_CO_191220191020363925",
        "ResultCode": 0,
        "ResultDesc": "The service request is processed successfully.",
        "CallbackMetadata": {"Item": [
            {"Name": "Amount", "Value": 1.0},
            {"Name": "MpesaReceiptNumber", "Value": "NLJ7RT61SV"},
            {"Name": "TransactionDate", "Value": 20191219102115},
            {"Name": "PhoneNumber", "Value": 254708374149}
        ]}
    }}}"""


def test_success_callback_full_metadata():
    res = StkCallbackResult.from_json(SUCCESS_RAW)
    assert res.merchant_request_id == "29115-34620561-1"
    assert res.checkout_request_id == "ws_CO_191220191020363925"
    assert res.result_code == "0"
    assert res.classify() is ResultClass.SUCCESS
    assert res.amount() == 1.0
    assert isinstance(res.amount(), float)
    assert res.mpesa_receipt() == "NLJ7RT61SV"
    # Integral magnitudes preserved exactly -- never float-corrupted.
    assert res.transaction_date() == 20191219102115
    phone = res.phone_number()
    assert phone == "254708374149" and phone.isascii()


def test_failure_callback_absent_metadata_tolerated():
    raw = (b'{"Body":{"stkCallback":{"MerchantRequestID":"x",'
           b'"CheckoutRequestID":"ws_CO_1","ResultCode":1037,'
           b'"ResultDesc":"DS timeout"}}}')
    res = StkCallbackResult.from_json(raw)
    assert res.metadata() == {}
    assert res.amount() is None
    assert res.mpesa_receipt() is None
    assert res.transaction_date() is None
    assert res.phone_number() is None
    assert res.classify() is ResultClass.INDETERMINATE


def test_duplicate_metadata_first_wins_and_counted():
    raw = (b'{"Body":{"stkCallback":{"CheckoutRequestID":"ws_CO_1",'
           b'"ResultCode":"0","MerchantRequestID":"m","ResultDesc":"ok",'
           b'"CallbackMetadata":{"Item":['
           b'{"Name":"MpesaReceiptNumber","Value":"AAA111"},'
           b'{"Name":"Amount","Value":10},'
           b'{"Name":"MpesaReceiptNumber","Value":"BBB222"}]}}}}')
    res = StkCallbackResult.from_json(raw)
    assert res.mpesa_receipt() == "AAA111"
    assert res.metadata()["Amount"] == 10
    assert res.duplicate_keys() == 1


def test_absent_or_null_values_surface_as_none():
    raw = (b'{"Body":{"stkCallback":{"CheckoutRequestID":"ws_CO_1",'
           b'"ResultCode":1,"MerchantRequestID":"m","ResultDesc":"fail",'
           b'"CallbackMetadata":{"Item":['
           b'{"Name":"Ghost"},'
           b'{"Name":"Nothing","Value":null}]}}}}')
    md = StkCallbackResult.from_json(raw).metadata()
    assert "Ghost" in md and md["Ghost"] is None
    assert md["Nothing"] is None


@pytest.mark.parametrize(
    "raw",
    [
        b"{}",
        b'{"Body":{}}',
        b'{"Body":[]}',
        b'{"Body":{"nope":1}}',
        b"{oops",
    ],
)
def test_hostile_shapes_raise_value_error_naming_path(raw):
    with pytest.raises(ValueError):
        StkCallbackResult.from_json(raw)


def test_missing_inner_scalar_names_path():
    raw = b'{"Body":{"stkCallback":{"MerchantRequestID":"x"}}}'
    with pytest.raises(ValueError, match="Body.stkCallback.CheckoutRequestID"):
        StkCallbackResult.from_json(raw)


def test_classify_wiring_across_encodings():
    for code, want in (("0", ResultClass.SUCCESS), ("1032", ResultClass.FAILURE),
                       ("1037", ResultClass.INDETERMINATE)):
        res = StkCallbackResult.from_json(
            '{"Body":{"stkCallback":{"MerchantRequestID":"m",'
            '"CheckoutRequestID":"c","ResultCode":%s,"ResultDesc":"d"}}}' % code)
        assert res.classify() is want


def test_frozen_immutability_pin():
    res = StkCallbackResult.from_json(SUCCESS_RAW)
    with pytest.raises(AttributeError):
        res.result_desc = "mutate"  # type: ignore[misc]


def test_oversize_body_rejected():
    with pytest.raises(ValueError, match="exceeds 1048576"):
        StkCallbackResult.from_json('{"Body":"' + "A" * 1_048_577 + '"}')
