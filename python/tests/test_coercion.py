"""Tests for mpesa.coercion -- mirrors go/coercion_test.go tables."""

import json
import sys
from decimal import Decimal
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


def test_coerce_int_rejects_non_ascii_and_underscore_digits():
    assert coerce_int("1_000") is None            # PEP 515 underscores
    assert coerce_int("\u0661\u0662\u0663") is None  # Arabic-Indic Nd digits


@pytest.mark.parametrize("raw,want", [("+3599", 3599), ("-7", -7), ("+7", 7)])
def test_coerce_int_signed_strings(raw, want):
    assert coerce_int(raw) == want


def test_coerce_int_rejects_overlong_digit_run():
    # >19 digits must fail fast via the length gate (CPU-DoS on py<3.11).
    assert coerce_int("9" * 5000) is None


@pytest.mark.parametrize("raw", [{}, Decimal("1.5"), object()])
def test_coerce_unsupported_types_none_not_raise(raw):
    assert coerce_int(raw) is None
    assert isinstance(coerce_str(raw), (str, type(None)))


def test_coerce_int_float_precision_gate():
    assert coerce_int(1e30) is None                       # far beyond 2^53
    assert coerce_int(float(2) ** 60) is None
    # The literal below rounds to exactly 2**53 before we ever see it --
    # proof that precision loss happens upstream of any int() call.
    assert coerce_int(9007199254740993.0) == 2 ** 53


def test_coerce_str_truncates_at_4096():
    assert len(coerce_str("A" * 5000)) == 4096
    assert len(coerce_str([{"k": "v"}] * 3000)) == 4096   # dumps path capped too


def test_coerce_str_huge_number_still_exact_then_capped():
    assert coerce_str(10 ** 4000) == str(10 ** 4000)      # 4001 chars: under cap
    if sys.version_info >= (3, 11):
        # CPython's 4300-digit conversion guard fires before our cap applies.
        assert coerce_str(10 ** 5000) is None
    else:
        # Older interpreters have no guard: silent truncation at 4096.
        assert coerce_str(10 ** 5000) == "1" + "0" * 4095


def test_coerce_str_deep_nesting_returns_none_not_recursion_error():
    blob: list = [1]
    for _ in range(2000):
        blob = [blob]
    assert coerce_str(blob) is None
