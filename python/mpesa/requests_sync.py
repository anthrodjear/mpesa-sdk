"""Sync-side request models (STK, C2B, QR) mirroring go/requests.go.

Construct via future ``Client`` methods or :meth:`validate` before
sending -- ``to_payload`` refuses unvalidated models (RuntimeError);
post-validate mutation re-opens the gate (caller discipline). Wire keys
are EXACT (QR keeps ``RefNo``); only None/empty-STRING optionals are
omitted -- numeric zero stays (Go omitempty-on-string parity). Async
credential models live in :mod:`mpesa.requests_async`.
"""

from __future__ import annotations

import dataclasses
import enum
import ipaddress
import re
import urllib.parse
from dataclasses import dataclass
from typing import Any

from .enums import CommandID, QRTrxCode, ResponseType, TransactionType
from .helpers import normalize_phone

__all__ = ["STKPushRequest", "STKQueryRequest", "C2BRegisterRequest",
           "C2BSimulateRequest", "QRCodeRequest"]
_URL_RE = re.compile(r"https?://[^\s\x00-\x1f]+")

# Blocked host literals, spelled out range-by-range to stay in step with
# go/requests.go requireURL and typescript/src/client.ts isBlockedIPv4 /
# isBlockedIP. Enumerated deliberately instead of leaning on
# ``ipaddress.is_private``: that predicate also covers CGNAT 100.64/10,
# 198.18/15 and 240/4, which Go and TypeScript both ACCEPT -- reusing it
# would close the gap by opening a reverse cross-language mismatch.
# (network, reason) -- reason is descriptive, not wire-visible.
_BLOCKED_NETWORKS: tuple[tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, str], ...] = (
    (ipaddress.ip_network("127.0.0.0/8"), "loopback"),
    (ipaddress.ip_network("10.0.0.0/8"), "private"),
    (ipaddress.ip_network("172.16.0.0/12"), "private"),
    (ipaddress.ip_network("192.168.0.0/16"), "private"),
    (ipaddress.ip_network("169.254.0.0/16"), "link-local"),  # cloud metadata
    (ipaddress.ip_network("224.0.0.0/4"), "multicast"),
    (ipaddress.ip_network("fe80::/10"), "link-local"),
    (ipaddress.ip_network("fc00::/7"), "unique-local"),
    (ipaddress.ip_network("ff00::/8"), "multicast"),
)
# "Unspecified" is an exact address, not a range, in Go and TypeScript too.
_BLOCKED_EXACT: dict[ipaddress.IPv4Address | ipaddress.IPv6Address, str] = {
    ipaddress.ip_address("0.0.0.0"): "unspecified",
    ipaddress.ip_address("::"): "unspecified",
    ipaddress.ip_address("::1"): "loopback",
}


def _enum_value(value: Any) -> Any:
    return value.value if isinstance(value, enum.Enum) else value


def _require(field_name: str, value: str) -> None:
    if not (value or "").strip():
        raise ValueError(f"mpesa: {field_name} is required")


def _max_len(field_name: str, value: str, limit: int) -> None:
    if len(value) > limit:
        raise ValueError(f"mpesa: {field_name} exceeds {limit} characters (got {len(value)})")


def _printable(field_name: str, value: str, cap: int) -> None:
    """Reject non-printable content and over-length free-text identifiers."""
    if not all(ch.isprintable() for ch in value):
        raise ValueError(f"mpesa: {field_name} contains non-printable characters")
    if len(value) > cap:
        raise ValueError(
            f"mpesa: {field_name} exceeds {cap} characters (got {len(value)})")


def _ip_literals(host: str) -> list[ipaddress.IPv4Address | ipaddress.IPv6Address]:
    """Every address *host* should be judged as, or ``[]`` if it is a name.

    An IPv6 zone id ("fe80::1%eth0", percent-encoded as ``%25eth0``) is
    stripped first -- :mod:`ipaddress` cannot parse the scoped form. An
    IPv4-mapped literal ("::ffff:127.0.0.1") is unwrapped and returned
    AHEAD of its parent so the embedded v4 address is judged on its own and
    reports the accurate reason; Go reaches the same verdict through
    ``IP.To4()`` and TypeScript through its explicit IPv4-tail check.
    """
    text = host.strip()
    zone = text.find("%")
    if zone != -1:
        text = text[:zone]
    try:
        ip = ipaddress.ip_address(text)
    except ValueError:
        return []  # not an IP literal -- a DNS name
    mapped = getattr(ip, "ipv4_mapped", None)
    return [mapped, ip] if mapped is not None else [ip]


def _non_routable_reason(host: str) -> str | None:
    """Why *host* is an internal address literal, else ``None``.

    Consults :data:`_BLOCKED_EXACT` then :data:`_BLOCKED_NETWORKS`. DNS
    names return ``None``: this guards the literal host, it is not a
    DNS-rebinding filter (a name that resolves to 127.0.0.1 still passes,
    exactly as in Go and TypeScript).
    """
    for ip in _ip_literals(host):
        reason = _BLOCKED_EXACT.get(ip)
        if reason is not None:
            return reason
        for network, why in _BLOCKED_NETWORKS:
            if ip in network:  # cross-family membership is False, not an error
                return why
    return None


def _url(field_name: str, value: str) -> None:
    """Absolute, publicly routable http(s) URL.

    Closes the SSRF gap where this validator accepted only a shape check:
    an embedded ``user:pass@`` authority, a bare ``localhost`` and any
    loopback/private/link-local/multicast IP literal now fail, matching
    go/requests.go and typescript/src/client.ts. The shape gate runs first
    so a non-http(s) scheme keeps its existing message; ``.port`` is
    touched inside the try so a malformed port is reported as an invalid
    URL rather than exploding at send time.
    """
    if not _URL_RE.fullmatch(value):
        raise ValueError(f"mpesa: {field_name} must be an absolute http(s) URL "
                         "without whitespace/control characters")
    try:
        parsed = urllib.parse.urlsplit(value)
        port = parsed.port  # ValueError on a non-numeric port
    except ValueError:
        raise ValueError(f"mpesa: {field_name} is not a valid URL") from None
    if parsed.scheme.lower() not in ("http", "https"):
        raise ValueError(f"mpesa: {field_name} must use the http or https "
                         f"scheme, got {parsed.scheme!r}")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError(
            f"mpesa: {field_name} must not contain embedded credentials")
    if not parsed.netloc:
        raise ValueError(f"mpesa: {field_name} must have a non-empty host")
    host = (parsed.hostname or "").strip()
    if not host or not (port is None or 0 < port <= 65535):
        raise ValueError(f"mpesa: {field_name} must have a valid host")
    if host.rstrip(".").lower() == "localhost":
        raise ValueError(f"mpesa: {field_name} must not point to localhost")
    reason = _non_routable_reason(host)
    if reason is not None:
        raise ValueError(
            f"mpesa: {field_name} must not point to an internal or private "
            f"IP address ({reason})")


def _phone(field_name: str, raw: str) -> str:
    try:
        return normalize_phone(raw)
    except ValueError as exc:
        raise ValueError(f"mpesa: invalid {field_name}: {exc}") from None


def _amount_int(field_name: str, amount: Any) -> int:
    if isinstance(amount, bool) or not isinstance(amount, int):
        raise ValueError(f"mpesa: {field_name} must be a whole number")
    return amount


def _clean(payload: dict[str, Any]) -> dict[str, Any]:
    """omitempty parity: drop None and empty strings ONLY -- ints stay."""
    return {k: v for k, v in payload.items()
            if not (v is None or (isinstance(v, str) and not v))}


def _sentinel() -> Any:
    return dataclasses.field(default=False, init=False, repr=False, compare=False)


def _ensure_validated(model: Any) -> None:
    if not model._validated:
        raise RuntimeError("mpesa: call validate() before to_payload()")


@dataclass
class STKPushRequest:
    """Lipa na M-Pesa Online prompt (docs/apis/stk-push.md); normalizes
    MSISDNs in place. No Password/Timestamp fields -- the client injects
    both from ONE EAT instant (two-clock bug). Usage::

        req = STKPushRequest(business_short_code="174379",
                             transaction_type=TransactionType.CUSTOMER_PAY_BILL_ONLINE,
                             amount=1, party_a="0722000000", party_b="174379",
                             phone_number="0722000000", call_back_url=CB_URL,
                             account_reference="Order001", transaction_desc="pay")
        req.validate(); payload = req.to_payload()
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
    _validated: bool = _sentinel()

    def validate(self) -> None:
        """Every documented constraint; TransactionType has NO default."""
        _require("BusinessShortCode", self.business_short_code)
        tt = _enum_value(self.transaction_type)
        if tt is None or tt == "":
            raise ValueError("mpesa: TransactionType is required "
                             "(CustomerPayBillOnline | CustomerBuyGoodsOnline)")
        allowed = (TransactionType.CUSTOMER_PAY_BILL_ONLINE.value,
                   TransactionType.CUSTOMER_BUY_GOODS_ONLINE.value)
        if tt not in allowed:
            raise ValueError(f"mpesa: TransactionType {tt!r} not in "
                             "{CustomerPayBillOnline, CustomerBuyGoodsOnline}")
        amount = _amount_int("Amount", self.amount)
        if amount <= 0:
            raise ValueError(
                f"mpesa: Amount must be a positive whole number, got {amount}")
        self.party_a = _phone("PartyA", self.party_a)
        self.phone_number = _phone("PhoneNumber", self.phone_number)
        _url("CallBackURL", self.call_back_url)
        _require("AccountReference", self.account_reference)
        _max_len("AccountReference", self.account_reference, 12)
        _require("TransactionDesc", self.transaction_desc)
        _max_len("TransactionDesc", self.transaction_desc, 13)
        self._validated = True

    def to_payload(self) -> dict[str, Any]:
        """Wire-exact body; Password/Timestamp deliberately absent."""
        _ensure_validated(self)
        return _clean({
            "BusinessShortCode": self.business_short_code,
            "TransactionType": _enum_value(self.transaction_type),
            "Amount": self.amount, "PartyA": self.party_a, "PartyB": self.party_b,
            "PhoneNumber": self.phone_number, "CallBackURL": self.call_back_url,
            "AccountReference": self.account_reference,
            "TransactionDesc": self.transaction_desc,
        })


@dataclass
class STKQueryRequest:
    """STK Push outcome query (docs/apis/stk-query.md); Password/Timestamp
    are client-injected and bind to ``business_short_code`` when overridden.

    Example::

        req = STKQueryRequest(business_short_code="174379",
                              checkout_request_id="ws_CO_191220191020363925")
        req.validate(); payload = req.to_payload()
    """

    business_short_code: str = ""
    checkout_request_id: str = ""
    _validated: bool = _sentinel()

    def validate(self) -> None:
        _require("CheckoutRequestID", self.checkout_request_id)
        _printable("CheckoutRequestID", self.checkout_request_id, 64)
        self._validated = True

    def to_payload(self) -> dict[str, Any]:
        _ensure_validated(self)
        return _clean({"BusinessShortCode": self.business_short_code,
                       "CheckoutRequestID": self.checkout_request_id})


@dataclass
class C2BRegisterRequest:
    """Register validation/confirmation callbacks, v2 (docs/apis/c2b.md).

    Example::

        req = C2BRegisterRequest(short_code="600992",
                                 response_type=ResponseType.COMPLETED,
                                 confirmation_url="https://a.com/confirm",
                                 validation_url="https://a.com/validate")
        req.validate()
    """

    short_code: str = ""
    response_type: ResponseType | str | None = None
    confirmation_url: str = ""
    validation_url: str = ""
    _validated: bool = _sentinel()

    def validate(self) -> None:
        rt = _enum_value(self.response_type)
        if rt not in (ResponseType.COMPLETED.value, ResponseType.CANCELLED.value):
            raise ValueError(
                f"mpesa: ResponseType {rt!r} must be Completed or Cancelled")
        _url("ConfirmationURL", self.confirmation_url)
        _url("ValidationURL", self.validation_url)
        self._validated = True

    def to_payload(self) -> dict[str, Any]:
        _ensure_validated(self)
        return _clean({"ShortCode": self.short_code,
                       "ResponseType": _enum_value(self.response_type),
                       "ConfirmationURL": self.confirmation_url,
                       "ValidationURL": self.validation_url})


@dataclass
class C2BSimulateRequest:
    """Fake inbound payment -- SANDBOX ONLY (docs/apis/c2b.md);
    BillRefNumber mandatory iff the paybill command is chosen.

    Example::

        req = C2BSimulateRequest(short_code="600992",
                                 command_id=CommandID.C2B_PAYBILL_ONLINE,
                                 amount=10, msisdn="0712345678",
                                 bill_ref_number="acct-1")
        req.validate()
    """

    short_code: str = ""
    command_id: CommandID | str | None = None
    amount: int = 0
    msisdn: str = ""
    bill_ref_number: str = ""
    _validated: bool = _sentinel()

    def validate(self) -> None:
        cmd = _enum_value(self.command_id)
        allowed = (TransactionType.CUSTOMER_PAY_BILL_ONLINE.value,
                   TransactionType.CUSTOMER_BUY_GOODS_ONLINE.value)
        if cmd not in allowed:
            raise ValueError(f"mpesa: simulate CommandID {cmd!r} not in "
                             "{CustomerPayBillOnline, CustomerBuyGoodsOnline}")
        amount = _amount_int("simulate Amount", self.amount)
        if amount <= 0:
            raise ValueError(f"mpesa: simulate Amount must be positive, got {amount}")
        self.msisdn = _phone("Msisdn", self.msisdn)
        _printable("BillRefNumber", self.bill_ref_number, 32)
        if cmd == TransactionType.CUSTOMER_PAY_BILL_ONLINE.value:
            _require("BillRefNumber", self.bill_ref_number)
        self._validated = True

    def to_payload(self) -> dict[str, Any]:
        _ensure_validated(self)
        return _clean({"ShortCode": self.short_code,
                       "CommandID": _enum_value(self.command_id),
                       "Amount": self.amount, "Msisdn": self.msisdn,
                       "BillRefNumber": self.bill_ref_number})


@dataclass
class QRCodeRequest:
    """Dynamic M-PESA QR generation (docs/apis/dynamic-qr.md); ``RefNo``
    stays un-aliased and Size accepts ASCII digits only.

    Example::

        req = QRCodeRequest(merchant_name="TEST SUPERMARKET",
                            ref_no="Invoice Test", amount=1,
                            trx_code=QRTrxCode.BUY_GOODS, cpi="174379", size="300")
        req.validate()
    """

    merchant_name: str = ""
    ref_no: str = ""
    amount: int = 0
    trx_code: QRTrxCode | str | None = None
    cpi: str = ""
    size: str = ""
    _validated: bool = _sentinel()

    def validate(self) -> None:
        _require("MerchantName", self.merchant_name)
        _require("RefNo", self.ref_no)
        amount = _amount_int("QR Amount", self.amount)
        if amount <= 0:
            raise ValueError(f"mpesa: QR Amount must be positive, got {amount}")
        try:
            self.trx_code = QRTrxCode(_enum_value(self.trx_code))
        except ValueError:
            raise ValueError(f"mpesa: TrxCode {_enum_value(self.trx_code)!r} "
                             "not in {BG, WA, PB, SM, SB}") from None
        cpi = self.cpi.strip()
        if not (5 <= len(cpi) <= 12) or not cpi.isdigit() or not cpi.isascii():
            raise ValueError(f"mpesa: CPI {cpi!r} must be 5-12 digits")
        size = self.size.strip()
        if not (size.isascii() and size.isdigit()) or int(size) <= 0:
            raise ValueError(f"mpesa: Size {self.size!r} must be a positive integer")
        self.cpi, self.size = cpi, size
        self._validated = True

    def to_payload(self) -> dict[str, Any]:
        _ensure_validated(self)
        return {"MerchantName": self.merchant_name, "RefNo": self.ref_no,
                "Amount": self.amount, "TrxCode": _enum_value(self.trx_code),
                "CPI": self.cpi, "Size": self.size}
