"""Tests for mpesa.responses_models -- mirrors go/responses_test.go."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mpesa.classification import ResultClass, classify_result_code  # noqa: E402
from mpesa.responses_models import (  # noqa: E402
    B2CResponse,
    C2BAckResponse,
    ConversationResponse,
    OAuthToken,
    QRCodeResponse,
    STKPushResponse,
    STKQueryResponse,
)

STK_RAW = (
    '{"MerchantRequestID":"29115-34620561-1","CheckoutRequestID":"ws_CO_1",'
    '"ResponseCode":"0","ResponseDescription":"Success. Request accepted '
    'for processing","CustomerMessage":"Success"}'
)


def test_c2b_ack_parses_misspelled_field_from_raw():
    ack = C2BAckResponse.from_json(
        '{"OriginatorCoversationID":"x","ResponseCode":"0",'
        '"ResponseDescription":"Success"}')
    assert ack.originator_conversation_id == "x"
    assert ack.response_code == "0"


def test_c2b_correctly_spelled_key_fails_loudly():
    with pytest.raises(ValueError) as excinfo:
        C2BAckResponse.from_json({"OriginatorConversationID": "x",
                                  "ResponseCode": "0",
                                  "ResponseDescription": ""})
    assert "OriginatorCoversationID" in str(excinfo.value)  # misspelling expected


def test_query_result_code_string_and_int_normalize():
    for code in ('"1032"', "1032"):
        resp = STKQueryResponse.from_json(
            '{"ResponseCode":"0","ResponseDescription":"ok",'
            '"MerchantRequestID":"m","CheckoutRequestID":"ws_CO_1",'
            f'"ResultCode":{code},"ResultDesc":"cancelled"}}')
        assert resp.result_code == "1032"
        assert classify_result_code(resp.result_code) is ResultClass.FAILURE


@pytest.mark.parametrize("raw,want_ttl", [
    ("3599", 3599), (3599, 3599), (3599.0, 3599),
    (None, None), ("abc", None),
])
def test_oauth_token_expires_in_paths(raw, want_ttl):
    token = OAuthToken.from_json({"access_token": "t", "expires_in": raw})
    assert token.expires_in_seconds == want_ttl


def test_qr_opaque_code_preserved_verbatim():
    qr = QRCodeResponse.from_json({
        "ResponseCode": "AG_20191219_000043fdf61864fe9ff5",
        "RequestID": "16738-27456357-1",
        "ResponseDescription": "QR Code Successfully Generated",
        "QRCode": "imgdata",
    })
    assert qr.response_code == "AG_20191219_000043fdf61864fe9ff5"
    assert qr.qr_code == "imgdata"


def test_int_response_code_is_accepted_leniently():
    resp = STKPushResponse.from_json({
        "MerchantRequestID": "m", "CheckoutRequestID": "c",
        "ResponseCode": 0, "ResponseDescription": None,
        "CustomerMessage": None,
    })
    assert resp.is_accepted is True
    assert resp.response_description == ""


def test_b2c_alias_is_conversation_response():
    payload = {"OriginatorConversationID": "o-1", "ConversationID": "AG_1",
               "ResponseCode": "0", "ResponseDescription": "Accept"}
    assert B2CResponse is ConversationResponse
    assert B2CResponse.from_json(payload).conversation_id == "AG_1"


@pytest.mark.parametrize("cls,data,key", [
    (STKPushResponse, {"MerchantRequestID": "m"}, "CustomerMessage"),
    (STKQueryResponse,
     {"ResponseCode": "0", "ResultCode": 0}, "CheckoutRequestID"),
    (C2BAckResponse, {"ResponseCode": "0"}, "OriginatorCoversationID"),
    (QRCodeResponse, {"ResponseCode": "AG_x"}, "QRCode"),
    (OAuthToken, {}, "access_token"),
])
def test_missing_key_errors_list_every_absent_key(cls, data, key):
    with pytest.raises(ValueError) as excinfo:
        cls.from_json(data)
    message = str(excinfo.value)
    assert f"unexpected {cls.__name__} response shape" in message
    for wire_key in cls._WIRE.values():
        if wire_key not in data:
            assert wire_key in message
    assert key in message


def test_extra_keys_ignored():
    resp = ConversationResponse.from_json({
        "OriginatorConversationID": "o", "ConversationID": "c",
        "ResponseCode": "0", "ResponseDescription": "ok",
        "UnexpectedExtra": "ignored",
    })
    assert resp.response_code == "0"


@pytest.mark.parametrize("bad", [
    b"", b"{oops", b"\xff\xfe\x00", '["array"]', '"scalar"',
])
def test_garbage_inputs_value_error_only(bad):
    for cls in (STKPushResponse, QRCodeResponse):
        with pytest.raises(ValueError):
            cls.from_json(bad)


def test_deep_nesting_value_error_not_recursion_error():
    # Built locally so pytest never renders a 100k-char test id.
    blob = "[" * 100_000
    with pytest.raises(ValueError, match="RecursionError"):
        STKPushResponse.from_json(blob)


def test_oversize_body_rejected_before_parse():
    with pytest.raises(ValueError, match="exceeds 1048576"):
        STKPushResponse.from_json('{"x":"' + "A" * 1_048_577 + '"}')


def test_oauth_token_repr_never_leaks_token():
    token = OAuthToken.from_json({"access_token": "SECRET-TOKEN-123",
                                  "expires_in": "3599"})
    rendered = repr(token)
    assert "SECRET-TOKEN-123" not in rendered
    assert "<redacted 16ch>" in rendered


def test_frozen_immutability_pin():
    resp = STKPushResponse.from_json(STK_RAW)
    with pytest.raises(AttributeError):
        resp.customer_message = "mutate"  # type: ignore[misc]
