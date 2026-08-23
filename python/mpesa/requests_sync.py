"""Sync-side request models (STK, C2B, QR) mirroring go/requests.go.

Construct via future ``Client`` methods, or call :meth:`validate` before
sending -- never hand-marshal an unvalidated model. ``to_payload`` emits
Safaricom's EXACT wire keys (traps included: QR uses ``RefNo``, never
``RefNumber``); ``None``/empty optionals are omitted (omitempty parity).
Async credential models live in :mod:`mpesa.requests_async`.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass
from typing import Any

from .enums import CommandID, QRTrxCode, ResponseType, TransactionType
from .helpers import normalize_phone

__all__ = [
    "STKPushRequest",
    "STKQueryRequest",
    "C2BRegisterRequest",
    "C2BSimulateRequest",
    "QRCodeRequest",
]


def _enum_value(value: Any) -> Any:
    return value.value if isinstance(value, enum.Enum) else value


def _require(field: str, value: str) -> None:
    if not (value or "").strip():
        raise ValueError(f"mpesa: {field} is required")


def _max_len(field: str, value: str, limit: int) -> None:
    if len(value) > limit:
        raise ValueError(f"mpesa: {field} exceeds {limit} characters (got {len(value)})")


def _url(field: str, value: str) -> None:
    _require(field, value)
    if not value.startswith(("http://", "https://")):
        raise ValueError(f"mpesa: {field} must be an absolute http(s) URL")


def _phone(field: str, raw: str) -> str:
    try:
        return normalize_phone(raw)
    except ValueError as exc:
        raise ValueError(f"mpesa: invalid {field}: {exc}") from None


def _amount_int(field: str, amount: Any) -> int:
    if isinstance(amount, bool) or not isinstance(amount, int):
        raise ValueError(f"mpesa: {field} must be a whole number")
    return amount


def _clean(value: str | None) -> dict[str, str]:
    """omitempty helper: drop None/empty optionals from a payload."""
    return {k: v for k, v in value.items() if v}


@dataclass
class STKPushRequest:
    """Lipa na M-Pesa Online prompt (docs/apis/stk-push.md).

    No Password/Timestamp fields: the client injects both from ONE EAT
    instant (two-clock bug). Usage::

        req = STKPushRequest(business_short_code="174379",
                             transaction_type=TransactionType.CUSTOMER_PAY_BILL_ONLINE,
                             amount=1, party_a="0722000000", party_b="174379",
                             phone_number="0722000000",
                             call_back_url="https://mydomain.com/path",
                             account_reference="Order001",
                             transaction_desc="payment")
        req.validate()
    """

    business_short_code: str = ""
    transaction_type: TransactionType | str | None = None
    amount: int = 0
    party_a: str = ""
    party_b: str = ""
    phone_number: str = ""
    call_back_url: str = ""
    account_reference: str = ""
    transaction_desc: str = ""

    def validate(self) -> None:
        """Check every documented constraint; TransactionType has NO default."""
        _require("BusinessShortCode", self.business_short_code)
        tt = _enum_value(self.transaction_type)
        if tt is None:
            raise ValueError(
                "mpesa: TransactionType is required "
                "(CustomerPayBillOnline | CustomerBuyGoodsOnline)"
            )
        if tt not in (TransactionType.CUSTOMER_PAY_BILL_ONLINE.value,
                      TransactionType.CUSTOMER_BUY_GOODS_ONLINE.value):
            raise ValueError(f"mpesa: TransactionType {tt!r} not in "
                             "{CustomerPayBillOnline, CustomerBuyGoodsOnline}")
        amount = _amount_int("Amount", self.amount)
        if amount <= 0:
            raise ValueError(f"mpesa: Amount must be a positive whole number, got {amount}")
        self.party_a = _phone("PartyA", self.party_a)
        self.phone_number = _phone("PhoneNumber", self.phone_number)
        _url("CallBackURL", self.call_back_url)
        _require("AccountReference", self.account_reference)
        _max_len("AccountReference", self.account_reference, 12)
        _require("TransactionDesc", self.transaction_desc)
        _max_len("TransactionDesc", self.transaction_desc, 13)

    def to_payload(self) -> dict[str, Any]:
        """Wire-exact body; Password/Timestamp deliberately absent."""
        return _clean({
            "BusinessShortCode": self.business_short_code,
            "TransactionType": _enum_value(self.transaction_type) or "",
            "Amount": self.amount,
            "PartyA": self.party_a,
            "PartyB": self.party_b,
            "PhoneNumber": self.phone_number,
            "CallBackURL": self.call_back_url,
            "AccountReference": self.account_reference,
            "TransactionDesc": self.transaction_desc,
        })


@dataclass
class STKQueryRequest:
    """STK Push outcome query (docs/apis/stk-query.md). Password/Timestamp
    are client-injected; ``business_short_code`` defaults to config when
    empty but may be overridden (the password then binds to it)."""

    business_short_code: str = ""
    checkout_request_id: str = ""

    def validate(self) -> None:
        _require("CheckoutRequestID", self.checkout_request_id)

    def to_payload(self) -> dict[str, Any]:
        return _clean({
            "BusinessShortCode": self.business_short_code,
            "CheckoutRequestID": self.checkout_request_id,
        })


@dataclass
class C2BRegisterRequest:
    """Register validation/confirmation callbacks, v2 (docs/apis/c2b.md)."""

    short_code: str = ""
    response_type: ResponseType | str | None = None
    confirmation_url: str = ""
    validation_url: str = ""

    def validate(self) -> None:
        rt = _enum_value(self.response_type)
        if rt not in (ResponseType.COMPLETED.value, ResponseType.CANCELLED.value):
            raise ValueError(f"mpesa: ResponseType {rt!r} must be Completed or Cancelled")
        _url("ConfirmationURL", self.confirmation_url)
        _url("ValidationURL", self.validation_url)

    def to_payload(self) -> dict[str, Any]:
        return _clean({
            "ShortCode": self.short_code,
            "ResponseType": _enum_value(self.response_type) or "",
            "ConfirmationURL": self.confirmation_url,
            "ValidationURL": self.validation_url,
        })


@dataclass
class C2BSimulateRequest:
    """Fake inbound payment -- SANDBOX ONLY (docs/apis/c2b.md).
    BillRefNumber is mandatory iff the paybill command is chosen."""

    short_code: str = ""
    command_id: CommandID | str | None = None
    amount: int = 0
    msisdn: str = ""
    bill_ref_number: str = ""

    def validate(self) -> None:
        cmd = _enum_value(self.command_id)
        if cmd not in (TransactionType.CUSTOMER_PAY_BILL_ONLINE.value,
                       TransactionType.CUSTOMER_BUY_GOODS_ONLINE.value):
            raise ValueError(f"mpesa: simulate CommandID {cmd!r} not in "
                             "{CustomerPayBillOnline, CustomerBuyGoodsOnline}")
        amount = _amount_int("simulate Amount", self.amount)
        if amount <= 0:
            raise ValueError(f"mpesa: simulate Amount must be positive, got {amount}")
        self.msisdn = _phone("Msisdn", self.msisdn)
        if (cmd == TransactionType.CUSTOMER_PAY_BILL_ONLINE.value
                and not self.bill_ref_number.strip()):
            raise ValueError("mpesa: BillRefNumber is required for "
                             "CustomerPayBillOnline simulation")

    def to_payload(self) -> dict[str, Any]:
        return _clean({
            "ShortCode": self.short_code,
            "CommandID": _enum_value(self.command_id) or "",
            "Amount": self.amount,
            "Msisdn": self.msisdn,
            "BillRefNumber": self.bill_ref_number,
        })


@dataclass
class QRCodeRequest:
    """Dynamic M-PESA QR generation (docs/apis/dynamic-qr.md).
    ``RefNo`` stays un-aliased -- Safaricom never spells it RefNumber."""

    merchant_name: str = ""
    ref_no: str = ""
    amount: int = 0
    trx_code: QRTrxCode | str | None = None
    cpi: str = ""
    size: str = ""

    def validate(self) -> None:
        _require("MerchantName", self.merchant_name)
        _require("RefNo", self.ref_no)
        amount = _amount_int("QR Amount", self.amount)
        if amount <= 0:
            raise ValueError(f"mpesa: QR Amount must be positive, got {amount}")
        try:
            self.trx_code = QRTrxCode(_enum_value(self.trx_code))
        except ValueError:
            raise ValueError(
                f"mpesa: TrxCode {_enum_value(self.trx_code)!r} not in {{BG, WA, PB, SM, SB}}"
            ) from None
        cpi = self.cpi.strip()
        if not (5 <= len(cpi) <= 12) or not cpi.isdigit() or not cpi.isascii():
            raise ValueError(f"mpesa: CPI {cpi!r} must be 5-12 digits")
        size = self.size.strip()
        if not size.isdigit() or int(size) <= 0:
            raise ValueError(f"mpesa: Size {self.size!r} must be a positive integer")
        self.cpi, self.size = cpi, size

    def to_payload(self) -> dict[str, Any]:
        return {
            "MerchantName": self.merchant_name,
            "RefNo": self.ref_no,
            "Amount": self.amount,
            "TrxCode": _enum_value(self.trx_code),
            "CPI": self.cpi,
            "Size": self.size,
        }
