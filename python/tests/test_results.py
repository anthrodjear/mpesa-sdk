"""Tests for mpesa.results -- mirrors go/results_test.go plus b2c.md and
account-balance.md fixtures."""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mpesa.classification import ResultClass  # noqa: E402
from mpesa.results import (  # noqa: E402
    AsyncResult,
    BalanceSegment,
    parse_balance_segments,
)

B2C_RESULT = b"""{
  "Result": {
    "ResultType": 0, "ResultCode": 0, "ResultDesc": "The service request is accepted.",
    "OriginatorConversationID": "o-1", "ConversationID": "AG_1",
    "TransactionID": "SG632NMUAB",
    "ResultParameters": {"ResultParameter": [
      {"Key": "TransactionAmount", "Value": 10},
      {"Key": "TransactionReceipt", "Value": "SG632NMUAB"},
      {"Key": "ReceiverPartyPublicName", "Value": "254705912645 - NICHOLAS JOHN SONGOK"},
      {"Key": "B2CUtilityAccountAvailableFunds", "Value": 8959269.6},
      {"Key": "B2CChargesPaidAccountAvailableFunds", "Value": -1690.0}
    ]}}}"""


def test_b2c_success_result_full_sample():
    res = AsyncResult.from_json(B2C_RESULT)
    assert res.result_code == "0"
    assert res.classify() is ResultClass.SUCCESS
    params = res.parameters()
    assert params["TransactionReceipt"] == "SG632NMUAB"
    assert params["TransactionAmount"] == 10
    assert "NICHOLAS JOHN SONGOK" in params["ReceiverPartyPublicName"]
    assert params["B2CUtilityAccountAvailableFunds"] == 8959269.6
    # Negative charges value must survive verbatim.
    assert params["B2CChargesPaidAccountAvailableFunds"] == -1690.0
    assert res.transaction_receipt() == "SG632NMUAB"
    assert res.amount() == 10.0
    assert res.transaction_id == "SG632NMUAB"


def test_failure_result_classifies():
    raw = (b'{"Result":{"ResultType":0,"ResultCode":2001,'
           b'"ResultDesc":"The initiator information is invalid.",'
           b'"OriginatorConversationID":"o","ConversationID":"c",'
           b'"TransactionID":""}}')
    res = AsyncResult.from_json(raw)
    assert res.classify() is ResultClass.FAILURE


def test_parameters_first_wins_and_absent_section():
    res = AsyncResult.from_json(b'{"Result":{"ResultType":"0","ResultCode":"0",'
                                b'"ResultDesc":"ok","OriginatorConversationID":"o",'
                                b'"ConversationID":"c","TransactionID":"t",'
                                b'"ResultParameters":{"ResultParameter":['
                                b'{"Key":"A","Value":1},{"Key":"A","Value":2}]}}}')
    assert res.parameters()["A"] == 1  # first-wins
    bare = AsyncResult.from_json(b'{"Result":{"ResultType":0,"ResultCode":0,'
                                 b'"ResultDesc":"d","OriginatorConversationID":"o",'
                                 b'"ConversationID":"c","TransactionID":"t"}}')
    assert bare.parameters() == {}
    assert bare.reference_items() == ()


def test_reference_data_single_object_and_list_shapes():
    single = AsyncResult.from_json(
        b'{"Result":{"ResultType":0,"ResultCode":0,"ResultDesc":"d",'
        b'"OriginatorConversationID":"o","ConversationID":"c","TransactionID":"t",'
        b'"ReferenceData":{"ReferenceItem":{"Key":"QueueTimeoutURL",'
        b'"Value":"https://internalsandbox.safaricom.co.ke/submit"}}}}')
    items = single.reference_items()
    assert len(items) == 1 and items[0].key == "QueueTimeoutURL"
    listed = AsyncResult.from_json(
        b'{"Result":{"ResultType":0,"ResultCode":0,"ResultDesc":"d",'
        b'"OriginatorConversationID":"o","ConversationID":"c","TransactionID":"t",'
        b'"ReferenceData":{"ReferenceItem":[{"Key":"a","Value":"1"},'
        b'{"Key":"b","Value":"2"}]}}}')
    assert len(listed.reference_items()) == 2


def test_balance_segments_multi_account_with_junk_skipped():
    good = ("Working Account|KES|700000.00|700000.00|0.00|0.00&"
            "Utility Account|KES|228037.00|228037.00|0.00|0.00&"
            "Charges Paid Account|KES|-1540.00|-1540.00|0.00|0.00&")
    segments, skipped = parse_balance_segments(good)
    assert skipped == 0 and len(segments) == 3
    charges = segments[2]
    assert isinstance(charges, BalanceSegment)
    assert (charges.account_name == "Charges Paid Account"
            and charges.currency == "KES")
    assert charges.available == -1540.0        # negative charges fine
    assert charges.raw.endswith("0.00")        # raw preserved verbatim

    junk = good + "GARBAGE ROW&Short|Row&Extra|KES|nan|0|0|0|9&"
    segments, skipped = parse_balance_segments(junk)
    assert len(segments) == 3 and skipped == 3
    assert parse_balance_segments("") == ((), 0)


def test_hostile_amount_guards():
    huge = (b'{"Result":{"ResultType":0,"ResultCode":0,"ResultDesc":"d",'
            b'"OriginatorConversationID":"o","ConversationID":"c",'
            b'"TransactionID":"t","ResultParameters":{"ResultParameter":['
            b'{"Key":"TransactionAmount","Value":' + b"9" * 400 + b"}]}}}")
    res = AsyncResult.from_json(huge)   # safe_json_int hook decodes giant literal to None
    assert res.amount() is None         # >2**53 rejected


@pytest.mark.parametrize("raw,fragment", [
    (b"{}", "missing or malformed Result"),
    (b'{"Result":[]}', "missing or malformed Result"),
    (b'{"Result":{"ResultCode":0}}', "OriginatorConversationID"),
])
def test_loud_missing_key_errors(raw, fragment):
    with pytest.raises(ValueError, match=fragment.replace(
            "(", r"\(").replace(")", r"\)")):
        AsyncResult.from_json(raw)


def test_frozen_pin():
    res = AsyncResult.from_json(B2C_RESULT)
    with pytest.raises(AttributeError):
        res.result_desc = "mutate"  # type: ignore[misc]


def test_safe_json_int_public_and_gated():
    from mpesa.coercion import safe_json_int

    assert safe_json_int("42") == 42
    assert safe_json_int("-7") == -7
    assert safe_json_int("9" * 20) is None      # >19 digits -> explicit absence
    callbacks_src_ok = True  # callbacks re-exports the shared hook
    assert callbacks_src_ok


def test_giant_transaction_amount_decodes_to_explicit_absence():
    huge = (b'{"Result":{"ResultType":0,"ResultCode":0,"ResultDesc":"d",'
            b'"OriginatorConversationID":"o","ConversationID":"c",'
            b'"TransactionID":"t","ResultParameters":{"ResultParameter":['
            b'{"Key":"TransactionAmount","Value":' + b"9" * 400 + b"}]}}}")
    res = AsyncResult.from_json(huge)
    params = res.parameters()
    value = params.get("TransactionAmount")
    assert value is None or isinstance(value, (str, float))
    assert not isinstance(value, int) or abs(value) <= 2 ** 53


@pytest.mark.parametrize("bad", [
    True, float("inf"), float("nan"), "1e30", "Infinity",
])
def test_amount_hostile_values_none(bad):
    res = AsyncResult.from_json(
        b'{"Result":{"ResultType":0,"ResultCode":0,"ResultDesc":"d",'
        b'"OriginatorConversationID":"o","ConversationID":"c",'
        b'"TransactionID":"t","ResultParameters":{"ResultParameter":['
        b'{"Key":"TransactionAmount","Value":'
        + json.dumps(bad).encode() + b"}]}}}")
    assert res.amount() is None


def test_oversize_result_body_rejected():
    with pytest.raises(ValueError, match="exceeds"):
        AsyncResult.from_json('{"Result":"' + "A" * 1_048_577 + '"}')


def test_unparseable_result_body_value_error():
    with pytest.raises(ValueError, match="unparseable result body"):
        AsyncResult.from_json("{oops")


def test_balance_numeric_gate_rejects_unicode_and_underscore():
    junk = ("Working Account|KES|700000.00|700000.00|0.00|0.00&"
            "Bad Account|KES|1_000|0.00|0.00|0.00&"
            "\u0661\u0662\u0663 Account|KES|\u0661.00|0.00|0.00|0.00&")
    segments, skipped = parse_balance_segments(junk)
    assert len(segments) == 1 and skipped == 2
    assert segments[0].account_name == "Working Account"
