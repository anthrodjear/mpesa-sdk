"""Callbacks Safaricom POSTs to CallBackURL -- STK family
(mirrors go/callbacks.go).

SECURITY POSTURE: these payloads carry NO HMAC signature. Anyone who can
reach your endpoint can POST a forged callback, so ingestion must:

* cap request bodies in your web framework (>=1 MiB analogue of Go's
  ``http.MaxBytesReader``) BEFORE handing bytes to :meth:`from_json`;
* bind on ``checkout_request_id`` against YOUR original request record;
* re-validate amount/phone against that record -- never trust metadata;
* treat classification via ADR-010-m-pesa-adapter.md (INDETERMINATE
  outcomes may still settle minutes later).

Usage::

    result = StkCallbackResult.from_json(raw_body)
    order = repo.by_checkout(result.checkout_request_id)   # bind first!
    if result.classify() is ResultClass.SUCCESS and result.mpesa_receipt():
        settle(order, receipt=result.mpesa_receipt(), amt=result.amount())
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from .classification import ResultClass, classify_result_code
from .coercion import coerce_str

__all__ = ["StkCallbackResult", "MetadataItem"]

_MAX_BODY_CHARS = 1_048_576


@dataclass(frozen=True)
class MetadataItem:
    """One named entry of ``CallbackMetadata.Item``; the Value is kept as
    the already-decoded JSON value (int/float/str/bool/None) because
    stdlib decoding preserves integral magnitudes exactly where Go needs
    RawMessage gymnastics to avoid float corruption."""

    name: str
    value_raw: Any = None


@dataclass(frozen=True)
class StkCallbackResult:
    """The ``Body.stkCallback`` transaction outcome. ``CallbackMetadata``
    is absent on failures -- every metadata accessor tolerates that.

    Attributes mirror the wire names snake-cased; ``result_code`` is
    normalized to str ("0"/"1032"/...) regardless of wire encoding.
    """

    merchant_request_id: str = ""
    checkout_request_id: str = ""
    result_code: str = ""
    result_desc: str = ""
    _items: tuple[MetadataItem, ...] = field(default=(), repr=False)

    @classmethod
    def from_json(cls, data: "dict | bytes | str") -> "StkCallbackResult":
        """Parse the full ``{"Body": {"stkCallback": {...}}}`` envelope.

        Loud about SHAPE (missing Body/stkCallback/scalars raise ValueError
        naming the path -- Go zero-fills silently, hiding drift); tolerant
        about TYPES (coercion) and absent CallbackMetadata.
        """
        if isinstance(data, (bytes, bytearray)):
            data = data.decode("utf-8", errors="replace")
        if isinstance(data, str):
            if len(data) > _MAX_BODY_CHARS:
                raise ValueError(
                    f"mpesa: callback body exceeds {_MAX_BODY_CHARS} chars")
            try:
                data = json.loads(data)
            except (json.JSONDecodeError, RecursionError) as exc:
                raise ValueError(f"mpesa: unparseable callback body "
                                 f"({type(exc).__name__})") from None
        if not isinstance(data, dict):
            raise ValueError("mpesa: unexpected STK callback shape: "
                             "expected a JSON object")
        body = data.get("Body")
        if not isinstance(body, dict):
            raise ValueError("mpesa: unexpected STK callback shape: "
                             "missing Body")
        inner = body.get("stkCallback")
        if not isinstance(inner, dict):
            raise ValueError("mpesa: unexpected STK callback shape: "
                             "missing Body.stkCallback")
        kwargs: dict[str, Any] = {}
        for attr, key in (("merchant_request_id", "MerchantRequestID"),
                          ("checkout_request_id", "CheckoutRequestID"),
                          ("result_code", "ResultCode"),
                          ("result_desc", "ResultDesc")):
            if key not in inner:
                raise ValueError(f"mpesa: unexpected STK callback shape: "
                                 f"missing Body.stkCallback.{key}")
            kwargs[attr] = (coerce_str(inner[key]) or "") \
                if attr != "result_code" else (coerce_str(inner[key]) or "")
        meta = inner.get("CallbackMetadata") or {}
        item_list = meta.get("Item") if isinstance(meta, dict) else None
        items = tuple(
            MetadataItem(name=str(entry.get("Name", "")),
                         value_raw=entry.get("Value"))
            for entry in (item_list or []) if isinstance(entry, dict)
        )
        return cls(_items=items, **kwargs)

    def _lookup(self, name: str) -> Any:
        """First-wins scan over raw items (Go MetadataMap semantics)."""
        for item in self._items:
            if item.name == name:
                return item.value_raw
        return None

    def duplicate_keys(self) -> int:
        """Count of items shadowed by an earlier same-named item
        (duplicates observed on Safaricom retries)."""
        seen: set[str] = set()
        dupes = 0
        for item in self._items:
            if item.name in seen:
                dupes += 1
            else:
                seen.add(item.name)
        return dupes

    def metadata(self) -> dict[str, Any]:
        """Flatten items FIRST-WINS; absent metadata yields {}. Example::

            md = result.metadata()          # {'Amount': 1.0, ...}
        """
        out: dict[str, Any] = {}
        for item in self._items:
            out.setdefault(item.name, item.value_raw)
        return out

    def classify(self) -> ResultClass:
        """ADR-010 bucket for ``result_code`` (never auto-fail unknowns)."""
        return classify_result_code(self.result_code)

    def amount(self) -> float | None:
        """Amount as float, or None when absent/non-numeric."""
        value = self._lookup("Amount")
        return float(value) if isinstance(value, (int, float)) \
            and not isinstance(value, bool) else None

    def mpesa_receipt(self) -> str | None:
        """M-PESA receipt string, or None when absent."""
        value = self._lookup("MpesaReceiptNumber")
        return coerce_str(value)

    def transaction_date(self) -> int | None:
        """YYYYMMDDHHMMSS completion stamp preserved as int, or None."""
        value = self._lookup("TransactionDate")
        return value if isinstance(value, int) \
            and not isinstance(value, bool) else None

    def phone_number(self) -> str | None:
        """Payer MSISDN as ASCII digits string, or None. Numeric wire
        encodings are stringified; non-ASCII content is refused."""
        value = self._lookup("PhoneNumber")
        if isinstance(value, bool):
            return None
        text = str(value) if isinstance(value, int) else (
            value.strip() if isinstance(value, str) else "")
        return text if text and text.isascii() else None
