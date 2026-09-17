"""Callbacks Safaricom POSTs to CallBackURL -- STK family
(mirrors go/callbacks.go).

SECURITY POSTURE: these payloads carry NO HMAC signature -- anyone who
can reach your endpoint can forge one. Ranked controls: settle ONLY via
STK Query (ResultCode == "0") bound to YOUR original request record --
a body that parses is never proof of payment; cap request bodies in the
web framework (chars; >=1 MiB analogue of Go's ``http.MaxBytesReader``)
before :meth:`from_json`; gate the endpoint with callback_token.py's
URL tokens; binding on ``checkout_request_id`` is a DEDUP/IDEMPOTENCY
control, NOT origin authentication (a forged body carries whatever IDs
its author likes); treat all metadata values as ADVISORY ONLY (a forged
first item is indistinguishable from genuine); classify per
ADR-010-m-pesa-adapter.md (INDETERMINATE outcomes may still settle
minutes later).

Go-divergence footnote: stdlib ``json.loads`` ACCEPTS NaN/Infinity
literals Go's encoder rejects; typed helpers refuse them by gate.

Usage::

    result = StkCallbackResult.from_json(raw_body)
    order = repo.by_checkout(result.checkout_request_id)   # dedup FIRST
    if order is None:
        return                                             # unknown: ACK, ignore
    if result.classify() is ResultClass.SUCCESS:           # HINT only --
        resp = client.stk_query(STKQueryRequest(           # settle via the query
            checkout_request_id=result.checkout_request_id))
        if resp.result_code == "0":
            settle(order, receipt=result.mpesa_receipt(), amount=result.amount())
    else:
        mark_pending_reconcile(order)   # stk_query decides; never refund on a hit
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from .classification import ResultClass, classify_result_code
from .coercion import coerce_amount, coerce_int, coerce_str, first_wins, safe_json_int
from ._limits import MAX_BODY_BYTES as _MAX_BODY_BYTES
from ._limits import check_body_size as _check_body_size

__all__ = ["StkCallbackResult", "MetadataItem"]
# NOTE (limits centralisation): _MAX_BODY_BYTES / _check_body_size are
# re-exported from mpesa._limits (the single source of truth) so existing
# ``from mpesa.callbacks import _MAX_BODY_BYTES`` imports keep working.
# Callers should pass label="callback body" to preserve this module's
# historic error text ("mpesa: callback body exceeds ...").


def _item_name(entry: dict[str, Any]) -> str:
    """Name extraction surviving hostile values (unnameable -> "")."""
    value = entry.get("Name", "")
    if value is None or isinstance(value, str):
        return value if isinstance(value, str) else ""
    try:
        return str(value)
    except (ValueError, TypeError):
        return ""


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
        CallbackMetadata. Bodies over 1 MiB (UTF-8 bytes) are rejected
        before parsing."""
        if isinstance(data, (bytes, bytearray, str)):
            _check_body_size(data, "callback body")
        if isinstance(data, (bytes, bytearray)):
            data = data.decode("utf-8", errors="replace")
        if isinstance(data, str):
            try:
                data = json.loads(data, parse_int=safe_json_int)
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
        return first_wins([(i.name, i.value_raw) for i in self._items])

    def classify(self) -> ResultClass:
        """ADR-010 bucket for ``result_code`` (never auto-fail unknowns)."""
        return classify_result_code(self.result_code)

    def amount(self) -> float | None:
        """Amount as float via shared :func:`coerce_amount`; bools,
        >2**53 ints (precision), non-finite floats and non-decimal
        strings all yield None.

        First-wins lookup: the metadata dict is built once via
        :meth:`metadata` (single O(n) ``first_wins`` pass) and the value
        is an O(1) dict get -- no per-key linear scan.
        """
        return coerce_amount(self.metadata().get("Amount"))

    def mpesa_receipt(self) -> str | None:
        """M-PESA receipt string, or None when absent.

        First-wins O(1) dict get over :meth:`metadata` (see :meth:`amount`).
        """
        return coerce_str(self.metadata().get("MpesaReceiptNumber"))

    def transaction_date(self) -> int | None:
        """YYYYMMDDHHMMSS stamp as int; string-encoded accepted via
        strict coercion; bools rejected.

        First-wins O(1) dict get over :meth:`metadata` (see :meth:`amount`).
        """
        value = self.metadata().get("TransactionDate")
        if isinstance(value, bool):
            return None
        if isinstance(value, int):
            return value
        return coerce_int(value) if isinstance(value, str) else None

    def phone_number(self) -> str | None:
        """Payer MSISDN as ASCII-digit string; numeric encodings are
        stringified, hostile magnitudes decode to None via the parse_int
        hook, non-digit/non-ASCII refused.

        First-wins O(1) dict get over :meth:`metadata` (see :meth:`amount`).
        """
        value = self.metadata().get("PhoneNumber")
        if isinstance(value, bool):
            return None
        text = value.strip() if isinstance(value, str) else (
            str(value) if isinstance(value, int) else "")
        return text if text.isascii() and text.isdigit() else None
