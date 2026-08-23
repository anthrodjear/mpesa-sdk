"""Tests for mpesa.coercion -- mirrors go/coercion_test.go tables."""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mpesa.coercion import coerce_int, coerce_str  # noqa: E402


@pytest.mark.parametrize(
    "raw,want",
    [
        ("3599", "3599"),
        ("  padded  ", "padded"),
        (True, "true"),
        (False, "false"),
        (3599, "3599"),
        (3599.0, "3599"),   # integral float loses ".0" junk
        (0.0, "0"),
        (1.5, "1.5"),
        (None, None),
        ("", ""),
        ({}, "{}"),
        ([1, "a"], '[1,"a"]'),
    ],
)
def test_coerce_str_table(raw, want):
    assert coerce_str(raw) == want


def test_coerce_str_round_trips_through_json():
    payload = {"ResponseCode": coerce_str(0), "ResultCode": coerce_str("1032")}
    encoded = json.loads(json.dumps(payload))
    assert encoded == {"ResponseCode": "0", "ResultCode": "1032"}
    assert coerce_str(encoded["ResultCode"]) == "1032"


@pytest.mark.parametrize(
    "raw,want",
    [
        ("3599", 3599),
        ('"3599"', 3599),      # single quote-pair stripped
        (" 3599 ", 3599),
        ('" 3599 "', 3599),
        (3599, 3599),
        (3599.0, 3599),
        (0.0, 0),
        (-7, -7),
        ('""3599""', None),    # doubled quoting -> malformed
        (1.5, None),
        ("12x", None),
        ("", None),
        ("   ", None),
        ('""', None),
        (None, None),
        (True, None),
        ("0.0", None),         # strict int() rejects decimal strings
    ],
)
def test_coerce_int_table(raw, want):
    assert coerce_int(raw) == want


def test_coerce_int_ttl_unknown_semantics():
    # Official capture: expires_in as string; elsewhere bare number.
    assert coerce_int(json.loads('{"expires_in": "3599"}')["expires_in"]) == 3599
    assert coerce_int(json.loads('{"expires_in": 3600}')["expires_in"]) == 3600
