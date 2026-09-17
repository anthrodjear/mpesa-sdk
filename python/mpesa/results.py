"""Async ``Result`` envelopes POSTed to ``ResultURL`` -- the FINAL verdicts
of B2C, Transaction Status, Reversal and Account Balance
(mirrors go/results.go).

Reminder: the earlier ``ConversationResponse`` was merely the queue ACK;
this envelope carries the actual outcome. Like every Safaricom push it
is UNSIGNED -- bind on ``originator_conversation_id`` against your own
records before acting, cap ingestion body size at the framework level,
and classify per ADR-010 (INDETERMINATE may still be retried via query).

Usage::

    result = AsyncResult.from_json(raw_body)
    if result.classify() is ResultClass.SUCCESS:
        receipt = result.transaction_receipt()
        funds = result.amount()
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from typing import Any

from .classification import ResultClass, classify_result_code
from .coercion import coerce_amount, coerce_int, coerce_str, first_wins, safe_json_int

__all__ = ["AsyncResult", "Parameter", "ReferenceItem", "BalanceSegment",
           "parse_balance_segments"]

# Ingestion cap in BYTES (Go maxResponseLen / TS MAX_RESPONSE_LEN parity).
# str bodies are measured as UTF-8 bytes: 1M CJK chars ~= 3 MiB and must
# not bypass the bound. See _check_body_size().
_MAX_BODY_BYTES = 1_048_576
_BALANCE_NUM_RE = re.compile(r"[+-]?[0-9]{1,18}(\.[0-9]{1,6})?", re.ASCII)


def _check_body_size(data: "bytes | bytearray | str") -> None:
    """Reject bodies over the ingestion cap, measured in UTF-8 bytes.

    bytes input is measured directly; str input is measured as
    ``len(data.encode("utf-8"))`` so multi-byte payloads cannot smuggle
    up to 4x the intended bound past a char-count check.
    """
    size = len(data) if isinstance(data, (bytes, bytearray)) else \
        len(data.encode("utf-8"))
    if size > _MAX_BODY_BYTES:
        raise ValueError(
            f"mpesa: result body exceeds {_MAX_BODY_BYTES} bytes")


@dataclass(frozen=True)
class Parameter:
    """One async-result Key/Value pair; Value kept as decoded JSON."""

    key: str
    value_raw: Any = None


@dataclass(frozen=True)
class ReferenceItem:
    """One echoed key/value entry of optional ``ReferenceData``."""

    key: str
    value: str = ""


@dataclass(frozen=True)
class BalanceSegment:
    """One parsed Account Balance account row. Floats are DISPLAY-ONLY
    conveniences -- ``raw`` preserves the authoritative source verbatim."""

    account_name: str = ""
    currency: str = ""
    available: float = 0.0
    uncleared: float = 0.0
    reserved: float = 0.0
    min_amount: float = 0.0
    raw: str = ""


def parse_balance_segments(
        text: str) -> "tuple[tuple[BalanceSegment, ...], int]":
    """Split the balance blob (segments joined by '&', fields by '|').

    Tolerates trailing separators and unknown extra fields; MALFORMED
    ROWS ARE SKIPPED AND COUNTED, never fatal (docs/apis/account-balance.md).

    Example::

        segments, skipped = parse_balance_segments(result_text)
    """
    segments: list[BalanceSegment] = []
    skipped = 0
    for seg in text.split("&"):
        fields = seg.split("|")
        if not "".join(fields).strip():
            continue  # blank gap between separators: ignored, not counted
        if len(fields) < 6:
            skipped += 1
            continue
        # ASCII gate: float() would otherwise accept "1_000" and Unicode
        # Nd digits ("١٢٣") that Go's ParseFloat rejects.
        if not all(_BALANCE_NUM_RE.fullmatch(f.strip()) for f in fields[2:6]):
            skipped += 1
            continue
        try:
            nums = [float(f.strip()) for f in fields[2:6]]
        except ValueError:
            skipped += 1
            continue
        if not all(math.isfinite(n) for n in nums):
            skipped += 1
            continue
        segments.append(BalanceSegment(
            account_name=fields[0].strip(), currency=fields[1].strip(),
            available=nums[0], uncleared=nums[1], reserved=nums[2],
            min_amount=nums[3], raw=seg))
    return tuple(segments), skipped


@dataclass(frozen=True)
class AsyncResult:
    """The shared async-result envelope. ``result_code`` normalized to
    str; parameters/reference sections tolerate absence."""

    result_type: int | None = None
    result_code: str = ""
    result_desc: str = ""
    originator_conversation_id: str = ""
    conversation_id: str = ""
    transaction_id: str = ""
    _parameters: tuple[Parameter, ...] = field(default=(), repr=False)
    _reference_items: tuple[ReferenceItem, ...] = field(default=(), repr=False)

    @classmethod
    def from_json(cls, data: "dict | bytes | str") -> "AsyncResult":
        """Parse ``{"Result": {...}}`` loudly about SHAPE (dotted-path
        errors naming every missing scalar), tolerant about TYPES.
        Bodies over 1 MiB (UTF-8 bytes) are rejected before parsing."""
        if isinstance(data, (bytes, bytearray, str)):
            _check_body_size(data)
        if isinstance(data, (bytes, bytearray)):
            data = data.decode("utf-8", errors="replace")
        if isinstance(data, str):
            try:
                data = json.loads(data, parse_int=safe_json_int)
            except (ValueError, RecursionError) as exc:
                raise ValueError(
                    f"mpesa: unparseable result body "
                    f"({type(exc).__name__})") from None
        if not isinstance(data, dict):
            raise ValueError("mpesa: unexpected AsyncResult shape: "
                             "missing or malformed Result")
        inner = data.get("Result")
        if not isinstance(inner, dict):
            raise ValueError("mpesa: unexpected AsyncResult shape: "
                             "missing or malformed Result")
        wire = (("result_type", "ResultType"), ("result_code", "ResultCode"),
                ("result_desc", "ResultDesc"),
                ("originator_conversation_id", "OriginatorConversationID"),
                ("conversation_id", "ConversationID"),
                ("transaction_id", "TransactionID"))
        missing = [key for _, key in wire if key not in inner]
        if missing:
            raise ValueError(f"mpesa: unexpected AsyncResult shape: "
                             f"missing {', '.join(missing)}")
        kwargs = {attr: (coerce_int(inner[key]) if attr == "result_type"
                         else coerce_str(inner[key]) or "")
                  for attr, key in wire}
        params = inner.get("ResultParameters") or {}
        plist = params.get("ResultParameter") if isinstance(params, dict) else None
        items = tuple(Parameter(key=str(p.get("Key", "")),
                                value_raw=p.get("Value"))
                      for p in (plist or []) if isinstance(p, dict))
        ref = inner.get("ReferenceData") or {}
        rlist = ref.get("ReferenceItem") if isinstance(ref, dict) else None
        if isinstance(rlist, dict):  # single-object shape (b2c.md sample)
            rlist = [rlist]
        refs = tuple(ReferenceItem(key=str(r.get("Key", "")),
                                   value=coerce_str(r.get("Value")) or "")
                     for r in (rlist or []) if isinstance(r, dict))
        return cls(_parameters=items, _reference_items=refs, **kwargs)

    def parameters(self) -> dict[str, Any]:
        """Flatten Key/Value pairs FIRST-WINS; absent section yields {}."""
        return first_wins([(p.key, p.value_raw) for p in self._parameters])

    def reference_items(self) -> tuple[ReferenceItem, ...]:
        """Echoed ReferenceItem entries (single-object shapes merged)."""
        return self._reference_items

    def classify(self) -> ResultClass:
        """ADR-010 bucket for ``result_code`` (never auto-fail unknowns)."""
        return classify_result_code(self.result_code)

    def _param(self, name: str) -> Any:
        for parameter in self._parameters:
            if parameter.key == name:
                return parameter.value_raw
        return None

    def transaction_receipt(self) -> str | None:
        """TransactionReceipt string, or None when absent."""
        return coerce_str(self._param("TransactionReceipt"))

    def transaction_status(self) -> str | None:
        """TransactionStatus string (status APIs), or None when absent."""
        return coerce_str(self._param("TransactionStatus"))

    def amount(self) -> float | None:
        """TransactionAmount as float via shared :func:`coerce_amount`;
        bools, >2**53 ints, non-finite floats and non-decimal strings
        yield None (hostile-int guards)."""
        return coerce_amount(self._param("TransactionAmount"))
