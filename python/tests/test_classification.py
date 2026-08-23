"""Tests for mpesa.classification -- full doc catalogs as CI drift guards.

Tables are transcribed from docs/apis/stk-push.md, b2c.md and
account-balance.md; if a doc catalog changes without this file changing,
these tests fail (and vice versa).
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mpesa.classification import ResultClass, classify_result_code  # noqa: E402

STK_SUCCESS = [0]
STK_FAILURE = [1, 17, 1019, 1025, 1032, 2001, 9999]          # stk-push.md catalog
B2C_FAILURE = [2, 3, 4, 8, 11, 21, 2006, 2028, 2040, 8006]   # b2c.md callback
AB_FAILURE = [15, 22]                                        # account-balance.md
INDETERMINATE_KNOWN = [1001, 1037, 26, 4999]                 # never auto-fail set


@pytest.mark.parametrize("raw", STK_SUCCESS + ["0", "0.0", 0.0])
def test_success_shapes(raw):
    assert classify_result_code(raw) is ResultClass.SUCCESS


@pytest.mark.parametrize("raw", STK_FAILURE)
def test_stk_failure_catalog(raw):
    assert classify_result_code(raw) is ResultClass.FAILURE


@pytest.mark.parametrize("raw", B2C_FAILURE)
def test_b2c_failure_catalog(raw):
    assert classify_result_code(raw) is ResultClass.FAILURE


@pytest.mark.parametrize("raw", AB_FAILURE)
def test_account_balance_failure_catalog(raw):
    assert classify_result_code(raw) is ResultClass.FAILURE


@pytest.mark.parametrize("raw", INDETERMINATE_KNOWN)
def test_known_indeterminate_codes(raw):
    # Debits can land minutes late: these must NEVER bucket as FAILURE.
    assert classify_result_code(raw) is ResultClass.INDETERMINATE


@pytest.mark.parametrize(
    "raw",
    [
        None,
        "",
        "   ",
        "abc",
        "SFC_IC0003",
        "C2B00011",
        1.5,
        "1.5",
        {},
        ["1032"],
        123456,     # plausible but undocumented numeric
        -5,
    ],
)
def test_garbage_is_indeterminate_never_failure(raw):
    assert classify_result_code(raw) is ResultClass.INDETERMINATE


@pytest.mark.parametrize("raw,want", [("1032", "FAILURE"), ("'2001'", "INDETERMINATE")])
def test_string_wire_variants(raw, want):
    # Only DOUBLE-quote wrapping is stripped (Go strings.Trim parity);
    # single quotes make it garbage -> INDETERMINATE.
    assert classify_result_code(raw).name == want


def test_union_covers_all_documented_groups():
    from mpesa.classification import _FAILURE_CODES

    assert _FAILURE_CODES == frozenset(STK_FAILURE + B2C_FAILURE + AB_FAILURE)


@pytest.mark.parametrize("raw", ["\u0660", "\u0662", "\u0661\u0660\u0663\u0662"])
def test_unicode_digit_forgery_blocked(raw):
    # float() accepts Unicode Nd digits ("٠"->0.0); Go ParseFloat doesn't --
    # non-ASCII text can never classify.
    assert classify_result_code(raw) is ResultClass.INDETERMINATE


@pytest.mark.parametrize("raw", [True, False])
def test_booleans_never_classify(raw):
    assert classify_result_code(raw) is ResultClass.INDETERMINATE


def test_adversarial_boundaries():
    assert classify_result_code("1e30") is ResultClass.INDETERMINATE
    assert classify_result_code(1e30) is ResultClass.INDETERMINATE
    assert classify_result_code(float("nan")) is ResultClass.INDETERMINATE
    assert classify_result_code("+0") is ResultClass.SUCCESS
    assert classify_result_code("-0") is ResultClass.SUCCESS
    # Doubled quotes survive coercion.py's single-pair strip but Go's
    # strings.Trim cutset cuts all of them -> 0. Explicit Trim parity.
    assert classify_result_code('""0""') is ResultClass.SUCCESS
