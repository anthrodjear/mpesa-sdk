"""Tests for mpesa.responses -- mirrors go/responses_test.go plus
lenient-decoding and missing-key contracts."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mpesa.classification import ResultClass, classify_result_code  # noqa: E402
from mpesa.responses import (  # noqa: E402
    B2CResponse,
    C2BAckResponse,
    ConversationResponse,
    OAuthToken,
    QRCodeResponse,
    STKPushResponse,
    STKQueryResponse,
)

STK_PUSH_RAW = (
    '{"MerchantRequestID":"29115-34620561-1",'
    '"CheckoutRequestID":"ws_CO_191220191020363925","ResponseCode":"0",'
    '"ResponseDescription":"Success. Request accepted for processing",'
    '"CustomerMessage":"Success. Request accepted for processing"}'
)


def test_stk_push_shape_and_is_accepted():
    resp = STKPushResponse.from_json(STK_PUSH_RAW)
    assert resp.merchant_request_id == "29115-34620561-1"
    assert resp.checkout_request_id == "ws_CO_191220191020363925"
    assert resp.is_accepted is True
    assert STKPushResponse(response_code="1").is_accepted is False


def test_c2b_ack_parses_misspelled_field():
    raw = (
        '{"OriginatorCoversationID":'
        '"53e3-4aa8-9fe0-8fb5e4092cdd3405976","ResponseCode":"0",'
        '"ResponseDescription":"Accept the service request successfully."}'
    )
    ack = C2BAckResponse.from_json(raw)
    assert ack.originator_conversation_id == "53e3-4aa8-9fe0-8fb5e4092cdd3405976"
    with pytest.raises(ValueError, match="OriginatorCoversationID"):
        C2BAckResponse.from_json({"OriginatorConversationID": "x",
                                  "ResponseCode": "0",
                                  "ResponseDescription": ""})


def test_stk_query_result_code_coerces_string_or_int():
    for code in ('"1032"', "1032"):
        resp = STKQueryResponse.from_json(
            '{"ResponseCode":"0","ResponseDescription":"ok",'
            '"MerchantRequestID":"m","CheckoutRequestID":"ws_CO_1",'
            f'"ResultCode":{code},"ResultDesc":"Request cancelled by user"}}')
        assert resp.result_code == "1032"
        assert classify_result_code(resp.result_code) is ResultClass.FAILURE


@pytest.mark.parametrize("raw,want_ttl", [
    ({"access_token": "t", "expires_in": "3599"}, 3599),
    ({"access_token": "t", "expires_in": 3599}, 3599),
    ({"access_token": "t", "expires_in": None}, None),
])
def test_oauth_token_expires_in_paths(raw, want_ttl):
    token = OAuthToken.from_json(raw)
    assert token.access_token == "t"
    assert token.expires_in_seconds == want_ttl


def test_qr_opaque_code_preserved_verbatim():
    qr = QRCodeResponse.from_json({
        "ResponseCode": "AG_20191219_000043fdf61864fe9ff5",
        "RequestID": "16738-27456357-1",
        "ResponseDescription": "QR Code Successfully Generated",
        "QRCode": "imgdata",
    })
    assert qr.response_code == "AG_20191219_000043fdf61864fe9ff5"
    assert qr.request_id == "16738-27456357-1"
    assert qr.qr_code == "imgdata"


def test_conversation_response_and_b2c_alias():
    payload = {
        "OriginatorConversationID": "o-1",
        "ConversationID": "AG_20240706_20106e9209f64bebd05b",
        "ResponseCode": "0",
        "ResponseDescription": "Accept the service request successfully.",
    }
    ack = ConversationResponse.from_json(payload)
    assert ack.conversation_id == "AG_20240706_20106e9209f64bebd05b"
    assert B2CResponse is ConversationResponse
    assert B2CResponse.from_json(payload) == ack


def test_missing_key_error_names_the_key():
    with pytest.raises(ValueError) as excinfo:
        STKPushResponse.from_json({"MerchantRequestID": "m"})
    message = str(excinfo.value)
    assert "unexpected STKPushResponse response shape" in message
    for key in ("CheckoutRequestID", "ResponseCode",
                "ResponseDescription", "CustomerMessage"):
        assert key in message  # ALL missing keys listed
    with pytest.raises(ValueError) as excinfo:
        ConversationResponse.from_json({"OriginatorConversationID": "o"})
    assert "ConversationID" in str(excinfo.value)


def test_garbage_never_raises_beyond_value_error():
    garbage = [b"", b"{oops", b"\xff\xfe\x00", '["array"]', '"scalar"', None]
    for blob in garbage:
        with pytest.raises(ValueError):
            STKPushResponse.from_json(blob)  # type: ignore[arg-type]
        with pytest.raises(ValueError):
            OAuthToken.from_json(blob)  # type: ignore[arg-type]


def test_bytes_str_dict_inputs_equivalent():
    as_dict = {"access_token": "abc", "expires_in": "3600"}
    from_str = OAuthToken.from_json(json := '{"access_token": "abc", "expires_in": "3600"}')
    from_bytes = OAuthToken.from_json(json.encode())
    assert OAuthToken.from_json(as_dict) == from_str == from_bytes


def test_recursion_bomb_becomes_value_error():
    with pytest.raises(ValueError, match="RecursionError"):
        STKPushResponse.from_json("[" * 100_000)


def test_oversize_body_rejected_before_parse():
    with pytest.raises(ValueError, match="exceeds 1048576 bytes"):
        STKPushResponse.from_json('{"x":"' + "A" * 1_048_577 + '"}')


def test_oauth_token_repr_never_leaks_token():
    token = OAuthToken.from_json({"access_token": "SECRET-TOKEN-123",
                                  "expires_in": "3599"})
    rendered = repr(token)
    assert "SECRET-TOKEN-123" not in rendered
    assert "<redacted 16ch>" in rendered
    assert "expires_in_seconds=3599" in rendered


def test_int_response_code_is_accepted_leniently():
    resp = STKPushResponse.from_json({
        "MerchantRequestID": "m", "CheckoutRequestID": "c",
        "ResponseCode": 0, "ResponseDescription": None,
        "CustomerMessage": None,
    })
    assert resp.response_code == "0"
    assert resp.is_accepted is True
    assert resp.response_description == ""  # null coerced to empty string


def test_parse_error_includes_decoder_position_not_body():
    marker_body = '{"SECRET-MARKER": '
    with pytest.raises(ValueError) as excinfo:
        STKPushResponse.from_json(marker_body)
    message = str(excinfo.value)
    assert "position" in message
    assert "SECRET-MARKER" not in message


@pytest.mark.parametrize("cls", [STKQueryResponse, C2BAckResponse, QRCodeResponse])
def test_missing_key_errors_name_keys_per_class(cls):
    with pytest.raises(ValueError) as excinfo:
        cls.from_json({})
    message = str(excinfo.value)
    for key in cls._WIRE.values():
        assert key in message


@pytest.mark.parametrize("raw,want_ttl", [
    ({"access_token": "t", "expires_in": "abc"}, None),
    ({"access_token": "t", "expires_in": 1.5}, None),
    ({"access_token": "t", "expires_in": 3599.0}, 3599),
])
def test_expires_in_hostile_paths(raw, want_ttl):
    assert OAuthToken.from_json(raw).expires_in_seconds == want_ttl


def test_extra_keys_ignored_and_models_frozen():
    resp = STKQueryResponse.from_json({
        "ResponseCode": "0", "ResponseDescription": "ok",
        "MerchantRequestID": "m", "CheckoutRequestID": "ws_CO_1",
        "ResultCode": 1032, "ResultDesc": "cancelled",
        "UnexpectedExtra": "ignored",
    })
    assert resp.result_code == "1032"
    with pytest.raises(AttributeError):
        resp.result_desc = "mutate"  # type: ignore[misc]


def test_giant_int_field_decodes_to_explicit_absence():
    # Mirrors the results/callbacks giant-int rows: a 400-digit integer
    # must not survive as an unbounded value anywhere in the model.
    raw = (
        '{"MerchantRequestID":"m","CheckoutRequestID":"c",'
        '"ResponseCode":' + "9" * 400 + ','
        '"ResponseDescription":"ok","CustomerMessage":"hi"}'
    )
    resp = STKPushResponse.from_json(raw)
    assert resp.response_code == ""            # hostile magnitude -> absence
    assert resp.is_accepted is False

    token = OAuthToken.from_json(
        {"access_token": "t", "expires_in": int("7" * 400)})
    token2 = OAuthToken.from_json(
        '{"access_token":"t","expires_in":' + "7" * 400 + "}")
    assert token.expires_in_seconds is None
    assert token2.expires_in_seconds is None   # TTL-unknown, not corrupted
