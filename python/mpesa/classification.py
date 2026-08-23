"""Fail-safe bucketing of Daraja result codes (mirrors go/classification.go).

Safety-critical per ADR-010-m-pesa-adapter.md state machine: success is
ONLY wire ``ResultCode 0``; failure is limited to documented terminal
codes across the STK Push (docs/apis/stk-push.md), B2C (b2c.md) and
Account Balance (account-balance.md) catalogs; EVERYTHING else --
unknown numerics like 1001/1037/4999/26, non-numerics like
``"SFC_IC0003"``, or absent values -- is INDETERMINATE.

INDETERMINATE exists because debits have been observed landing minutes
after a timeout-style code: auto-failing on it risks charging a customer
whose money actually moved. Never auto-refund and never auto-retry an
INDETERMINATE outcome -- keep querying (stk-query.md) until a terminal
code arrives.
"""

from __future__ import annotations

import enum
from typing import Any

from .coercion import coerce_int

__all__ = ["ResultClass", "classify_result_code"]


class ResultClass(enum.Enum):
    """Retry-safety bucket for a Daraja result code."""

    SUCCESS = "success"
    """Wire ResultCode 0 -- settled successfully, metadata present."""
    FAILURE = "failure"
    """Known terminal failure across all API catalogs; safe to surface as failed."""
    INDETERMINATE = "indeterminate"
    """Unknown/non-terminal/non-numeric: money MAY have moved. Never
    auto-fail, never auto-refund, never auto-retry -- keep querying."""


# STK Push terminal failures -- docs/apis/stk-push.md ResultCode Catalog.
_STK_FAILURE = frozenset({1, 17, 1019, 1025, 1032, 2001, 9999})
# Async B2C Result callback failures -- docs/apis/b2c.md.
_B2C_FAILURE = frozenset({2, 3, 4, 8, 11, 21, 2006, 2028, 2040, 8006})
# Account Balance async Result failures -- docs/apis/account-balance.md.
_ACCOUNT_BALANCE_FAILURE = frozenset({15, 22})

#: Union of every documented terminal-failure code (Go parity: 17/21 shared).
_FAILURE_CODES = _STK_FAILURE | _B2C_FAILURE | _ACCOUNT_BALANCE_FAILURE


def _coerce_code(raw: Any) -> int | None:
    """Go ``parseResultCode`` mirror: strict int, then lenient float fallback."""
    code = coerce_int(raw)
    if code is not None:
        return code
    if isinstance(raw, str):
        text = raw.strip().strip('"')
        try:
            value = float(text)
        except ValueError:
            return None
        # Lenient fallback: integral floats only ("0.0" -> 0); non-integral
        # or out-of-int64-range values are not result codes.
        if value.is_integer() and -(2**63) <= value <= 2**63 - 1:
            return int(value)
    return None


def classify_result_code(raw: Any) -> ResultClass:
    """Map any raw result-code shape to its :class:`ResultClass` bucket.

    Accepts every observed wire variant: ``"0"``, ``0``, ``"0.0"``,
    ``0.0`` -- strict ints first, then integral-float strings (Go parity).
    Non-integral floats (``1.5``) and garbage land in INDETERMINATE --
    never silently treated as zero/success.

    Example::

        cls = classify_result_code(callback["Body"]["stkCallback"]["ResultCode"])
        if cls is ResultClass.SUCCESS:
            mark_paid(order)
        elif cls is ResultClass.INDETERMINATE:
            schedule_reconciliation_query(order)  # NOT a refund
    """
    code = _coerce_code(raw)
    if code == 0:
        return ResultClass.SUCCESS
    if code in _FAILURE_CODES:
        return ResultClass.FAILURE
    return ResultClass.INDETERMINATE
