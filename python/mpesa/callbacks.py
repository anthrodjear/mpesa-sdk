"""Callbacks Safaricom POSTs to CallBackURL -- STK family
(mirrors go/callbacks.go).

SECURITY POSTURE: these payloads carry NO HMAC signature -- anyone who
can reach your endpoint can forge one. Ingestion must: cap request
bodies in the web framework (chars; >=1 MiB analogue of Go's
``http.MaxBytesReader``) before :meth:`from_json`; bind on
``checkout_request_id`` against YOUR original request record; treat all
metadata values as ADVISORY ONLY (a forged first item is
indistinguishable from genuine -- confirm via STK Query before any
irreversible fulfillment); classify per ADR-010-m-pesa-adapter.md
(INDETERMINATE outcomes may still settle minutes later).

Go-divergence footnote: stdlib ``json.loads`` ACCEPTS NaN/Infinity
literals Go's encoder rejects; typed helpers refuse them by gate.

Usage::

    result = StkCallbackResult.from_json(raw_body)
    order = repo.by_checkout(result.checkout_request_id)   # bind first!
    if result.classify() is ResultClass.SUCCESS and result.mpesa_receipt():
        settle(order, receipt=result.mpesa_receipt(), amt=result.amount())
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from typing import Any

from .classification import ResultClass, classify_result_code
from .coercion import coerce_int, coerce_str

__all__ = ["StkCallbackResult", "MetadataItem"]

_MAX_BODY_CHARS = 1_048_576  # characters, mirroring the framework body cap
_AMOUNT_RE = re.compile(r"[+-]?[0-9]{1,12}(\.[0-9]{1,6})?", re.ASCII)


def _item_name(entry: dict[str, Any]) -> str:
    """Name extraction surviving hostile values (unnameable -> "")."""
    value = entry.get("Name", "")
    if value is None or isinstance(value, str):
        return value if isinstance(value, str) else ""
    try:
        return str(value)
    except (ValueError, TypeError):
        return ""


def _safe_json_int(digits: str) -> Any:
    """parse_int hook: >19-digit JSON integers decode as explicit absence
    instead of tripping CPython's digit guard and killing the callback."""
    return int(digits) if len(digits) <= 19 else None


@dataclass(frozen=True)
class MetadataItem:
    """One ``CallbackMetadata.Item`` entry; Value kept as the decoded
    JSON value (int/float/str/bool/None)."""

    name: str
    value_raw: Any = None


@dataclass(frozen=True)
class StkCallbackResult:
    """The ``Body.stkCallback`` outcome; metadata accessors tolerate its
    absence on failures. ``result_code`` normalized to str."""

    merchant_request_id: str = ""
    checkout_request_id: str = ""
    result_code: str = ""
    result_desc: str = ""
    _items: tuple[MetadataItem, ...] = field(default=(), repr=False)

    @classmethod
    def from_json(cls, data: "dict | bytes | str") -> "StkCallbackResult":
        """Parse the full envelope. Loud about SHAPE (missing keys raise
        ValueError naming them), tolerant about TYPES and about absent
        CallbackMetadata."""
        if isinstance(data, (bytes, bytearray)):
            data = data.decode("utf-8", errors="replace")
        if isinstance(data, str):
            if len(data) > _MAX_BODY_CHARS:
                raise ValueError(
                    f"mpesa: callback body exceeds {_MAX_BODY_CHARS} chars")
            try:
                data = json.loads(data, parse_int=_safe_json_int)
            except (ValueError, RecursionError) as exc:
                raise ValueError(
                    f"mpesa: unparseable callback body "
                    f"({type(exc).__name__})") from None
        if not isinstance(data, dict):
            raise ValueError("mpesa: unexpected STK callback shape: "
                             "missing or malformed Body")
        body = data.get("Body")
        inner = body.get("stkCallback") if isinstance(body, dict) else None
        if not isinstance(inner, dict):
            raise ValueError("mpesa: unexpected STK callback shape: "
                             "missing or malformed Body.stkCallback")
        wire_keys = (("merchant_request_id", "MerchantRequestID"),
                     ("checkout_request_id", "CheckoutRequestID"),
                     ("result_code", "ResultCode"),
                     ("result_desc", "ResultDesc"))
        missing = [key for _, key in wire_keys if key not in inner]
        if missing:
            raise ValueError(f"mpesa: unexpected STK callback shape: "
                             f"missing {', '.join(missing)}")
        meta = inner.get("CallbackMetadata") or {}
        item_list = meta.get("Item") if isinstance(meta, dict) else None
        items = tuple(MetadataItem(name=_item_name(e),
                                   value_raw=e.get("Value"))
                      for e in (item_list or []) if isinstance(e, dict))
        return cls(_items=items,
                   **{attr: coerce_str(inner[key]) or ""
                      for attr, key in wire_keys})

    def items(self) -> tuple[MetadataItem, ...]:
        """Raw metadata items, duplicates included, order preserved."""
        return self._items

    def duplicate_keys(self) -> int:
        """Count of items shadowed by an earlier same-named item."""
        seen: set[str] = set()
        return sum(1 for item in self._items
                   if item.name in seen or seen.add(item.name))

    def metadata(self) -> dict[str, Any]:
        """Flatten items FIRST-WINS; absent metadata yields {}. Example::

            md = result.metadata()   # {'Amount': 1.0, ...}
        """
        out: dict[str, Any] = {}
        for item in self._items:
            out.setdefault(item.name, item.value_raw)
        return out

    def classify(self) -> ResultClass:
        """ADR-010 bucket for ``result_code`` (never auto-fail unknowns)."""
        return classify_result_code(self.result_code)

    def amount(self) -> float | None:
        """Amount as float; bools, >2**53 ints (precision), non-finite
        floats and non-decimal strings all yield None."""
        value = self._lookup("Amount")
        if isinstance(value, bool):
            return None
        if isinstance(value, int):
            return float(value) if abs(value) <= 2 ** 53 else None
        if isinstance(value, float):
            return value if math.isfinite(value) else None
        if isinstance(value, str):
            text = value.strip()
            if not _AMOUNT_RE.fullmatch(text):
                return None
            try:
                return float(text)
            except (ValueError, OverflowError):
                return None
        return None

    def mpesa_receipt(self) -> str | None:
        """M-PESA receipt string, or None when absent."""
        value = self._lookup("MpesaReceiptNumber")
        return coerce_str(value)

    def transaction_date(self) -> int | None:
        """YYYYMMDDHHMMSS stamp as int; string-encoded accepted via
        strict coercion; bools rejected."""
        value = self._lookup("TransactionDate")
        if isinstance(value, bool):
            return None
        if isinstance(value, int):
            return value
        return coerce_int(value) if isinstance(value, str) else None

    def phone_number(self) -> str | None:
        """Payer MSISDN as ASCII-digit string; numeric encodings are
        stringified, hostile magnitudes decode to None via the parse_int
        hook, non-digit/non-ASCII refused."""
        value = self._lookup("PhoneNumber")
        if isinstance(value, bool):
            return None
        text = value.strip() if isinstance(value, str) else (
            str(value) if isinstance(value, int) else "")
        return text if text.isascii() and text.isdigit() else None

    def _lookup(self, name: str) -> Any:
        """First raw item value under *name*, else None."""
        for item in self._items:
            if item.name == name:
                return item.value_raw
        return None
