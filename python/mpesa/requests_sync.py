"""Sync-side request models (STK, C2B, QR) mirroring go/requests.go.

Construct via future ``Client`` methods or :meth:`validate` before
sending -- ``to_payload`` refuses unvalidated models (RuntimeError);
post-validate mutation re-opens the gate (caller discipline). Wire keys
are EXACT (QR keeps ``RefNo``); only None/empty-STRING optionals are
omitted -- numeric zero stays (Go omitempty-on-string parity). Async
credential models live in :mod:`mpesa.requests_async`.

TRANSPORT NOTE: "sync" and "async" name the two FILES (this one carries
the synchronous STK/C2B/QR endpoints, the other the credential-bearing
async-result ones), not two HTTP transports. There is ONE transport --
:class:`mpesa.client.MpesaClient`, which is blocking; the OAuth lock is
held across the network leg, so an async transport would have to be built
around it and is deliberately out of scope. Every validation rule lives
in the shared helpers below so the two files cannot drift: ``_url``
(inet_aton numeric-host normalization + blocklist), ``_phone``,
``_shortcode``, ``_amount_int``, ``_check_transaction_limit``.

LIMITS: amount ceilings live in :mod:`mpesa.limits` (per-merchant, in
``Config``), NOT in this file. ``_amount_int`` guards against absurd
magnitudes only; the tier ceiling is applied by
:func:`_check_transaction_limit` inside each amount-bearing ``validate()``.
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
from .limits import (
    ServiceLimits,
    TransactionLimits,
    _resolve_transaction_limits,
    _resolved_max,
)

__all__ = ["STKPushRequest", "STKQueryRequest", "C2BRegisterRequest",
           "C2BSimulateRequest", "QRCodeRequest"]
# Case-insensitive scheme per RFC 3986 (scheme is case-insensitive):
# "HTTP://…" is a valid http URL, not a shape rejection.
_URL_RE = re.compile(r"https?://[^\s\x00-\x1f]+", re.IGNORECASE)

# Blocked host literals, spelled out range-by-range to stay in step with
# go/requests.go requireURL and typescript/src/client.ts isBlockedIPv4 /
# isBlockedIP. Enumerated deliberately instead of leaning on
# ``ipaddress.is_private``: that predicate also covers CGNAT 100.64/10,
# 198.18/15 and 240/4, which Go and TypeScript both ACCEPT -- reusing it
# would close the gap by opening a reverse cross-language mismatch.
# (network, reason) -- reason is descriptive, not wire-visible.
_BLOCKED_NETWORKS: tuple[tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, str], ...] = (
    (ipaddress.ip_network("0.0.0.0/8"), "reserved"),
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
    ipaddress.ip_address("0.0.0.0"): "unspecified",  # nosec B104  # blocklist: denied, not bound
    ipaddress.ip_address("::"): "unspecified",
    ipaddress.ip_address("::1"): "loopback",
}
#: MAGNITUDE guard -- an anti-absurd-value check with no business meaning.
#: A Python int is unbounded, so ``10**5000`` used to serialize straight
#: into the request body and blow up (or silently corrupt) the gateway.
#: This value is set FAR above any real payment (KES 1e12) so it can never
#: be mistaken for a merchant tier: the business ceiling comes from
#: :data:`mpesa.limits.DEFAULT_TRANSACTION_LIMITS` (or ``Config.limits``),
#: and belongs to the merchant's tier, not to this file.
_MAGNITUDE_GUARD = 10 ** 12
#: Shared shortcode shape (5-10 ASCII digits) -- identical in BOTH request
#: files, so sync C2B/STK and async B2C can never drift on what a shortcode
#: is. Mirrors Config.shortcode's regex.
_SHORTCODE_RE = re.compile(r"[0-9]{5,10}", re.ASCII)
#: QR wire fields are short digit strings: CPI is 5-12 digits
#: (docs/apis/dynamic-qr.md) and Size is a pixel dimension ("300"). One
#: shared ceiling keeps a multi-MB digit run out of the payload.
_QR_FIELD_MAX_CHARS = 12
#: Body of one inet_aton hex octet (ASCII only -- "1e30" is hex, "١٢" is not).
_HEX_PART_RE = re.compile(r"[0-9a-fA-F]+", re.ASCII)


class _NotNumericHost(Exception):
    """Internal: the host is a DNS name, not a numeric literal."""


class _BadNumericHost(ValueError):
    """Internal: numeric-shaped host that no inet_aton rule can parse."""


def _inet_aton_part(part: str) -> int:
    """Value of ONE inet_aton octet: decimal, octal or ``0x``-hex.

    ``ipaddress.ip_address`` understands NONE of the short forms -- it
    raises on ``2852039166``, ``0x7f000001``, ``017700000001`` and
    ``127.1`` -- so the old literal check waved them through as DNS names.
    That is the SSRF bypass: ``http://2852039166/`` reaches 169.254.169.254
    (cloud metadata) behind a validator that only knows dotted quads.

    Raises:
        _NotNumericHost: the part is a plain DNS label (``"example"``) --
            the caller treats the whole host as a name.
        _BadNumericHost: the part is numeric-SHAPED (leading ``0x``, a
            leading ``0`` followed by non-octal digits, or empty) but
            unparseable, so the caller FAILS CLOSED.
    """
    if not part:
        raise _BadNumericHost("empty octet")
    if part[:2] in ("0x", "0X"):
        digits = part[2:]
        if not digits or not _HEX_PART_RE.fullmatch(digits):
            raise _BadNumericHost(f"malformed hex octet {part!r}")
        return int(digits, 16)
    if part[0] == "0" and len(part) > 1:
        # inet_aton rule: a leading zero means octal, so "09" is INVALID
        # (C inet_aton rejects it) rather than decimal 9.
        if any(ch not in "01234567" for ch in part[1:]):
            raise _BadNumericHost(f"malformed octal octet {part!r}")
        return int(part, 8)
    if part.isascii() and part.isdigit():
        return int(part)
    raise _NotNumericHost(part)


def _normalize_numeric_host(host: str) -> ipaddress.IPv4Address:
    """inet_aton normalization of a numeric host (Go/TS parity table).

    1-4 dot-separated parts, each decimal, octal (leading ``0``) or
    ``0x``-hex, with the low-order bytes filled from the right, so
    ``127.1`` -> 127.0.0.1 and ``2852039166`` -> 169.254.169.254.

    Raises:
        _NotNumericHost: some part is a DNS label -- a name, nothing to judge.
        _BadNumericHost: the host is numeric-shaped but unparseable (wrong
            octet count, octet out of range, malformed hex/octal). The
            caller REJECTS: a host whose every label is a number and that
            still does not parse is indistinguishable from an attack
            payload trying to dodge the blocklist.
    """
    parts = host.split(".")
    values: list[int] = []
    for part in parts:
        # _NotNumericHost propagates immediately: one DNS label makes the
        # whole host a name.
        values.append(_inet_aton_part(part))
    if not 1 <= len(values) <= 4:
        raise _BadNumericHost(
            f"expected 1-4 octets, got {len(values)}")
    if any(value > 0xFF for value in values[:-1]):
        raise _BadNumericHost("leading octet above 255")
    low_bits = 32 - 8 * (len(values) - 1)  # last part: 32/24/16/8 bits
    if values[-1] >= 1 << low_bits:
        raise _BadNumericHost("final octet out of range")
    packed = 0
    for value in values[:-1]:
        packed = (packed << 8) | value
    return ipaddress.IPv4Address((packed << low_bits) | values[-1])


def _enum_value(value: Any) -> Any:
    return value.value if isinstance(value, enum.Enum) else value


def _require(field_name: str, value: str) -> None:
    if not (value or "").strip():
        raise ValueError(f"mpesa: {field_name} is required")


def _printable(field_name: str, value: str, cap: int) -> None:
    """Reject non-printable content and over-length free-text identifiers."""
    if not all(ch.isprintable() for ch in value):
        raise ValueError(f"mpesa: {field_name} contains non-printable characters")
    if len(value) > cap:
        raise ValueError(
            f"mpesa: {field_name} exceeds {cap} characters (got {len(value)})")


def _free_text(field_name: str, value: str, cap: int,
               minimum: int = 1) -> str:
    """Trim, forbid control runes, and length-bound a free-text field.

    ONE rule for every free-text field in BOTH request files (remarks,
    AccountReference, TransactionDesc) so the sync and async models cannot
    drift on what a free-text field is -- the historical async models
    trimmed and bounded theirs while the sync models only length-checked.
    Returns the trimmed value so callers normalise in place, as the async
    models already did.
    """
    text = (value or "").strip()
    if not all(ch.isprintable() for ch in text):
        raise ValueError(f"mpesa: {field_name} contains non-printable characters")
    if len(text) > cap:
        raise ValueError(
            f"mpesa: {field_name} exceeds {cap} characters (got {len(text)})")
    if len(text) < minimum:
        raise ValueError(f"mpesa: {field_name} must be at least {minimum} "
                         f"characters, got {len(text)}")
    return text


def _shortcode(field_name: str, value: str) -> str:
    """Canonical 5-10 digit shortcode (Config.shortcode regex parity).

    Keeps the historical ``{field} is required`` message for the empty
    case (several callers match on it) and adds the shape check that
    ``Config`` already applies to its own shortcode field.
    """
    text = (value or "").strip()
    if not text:
        raise ValueError(f"mpesa: {field_name} is required")
    if not _SHORTCODE_RE.fullmatch(text):
        # Length, never the value: an overlong input must not become a
        # multi-megabyte error string that lands in the caller's log.
        raise ValueError(f"mpesa: {field_name} must be 5-10 ASCII digits "
                         f"(got {len(text)} characters)")
    return text


def _ip_literals(host: str) -> list[ipaddress.IPv4Address | ipaddress.IPv6Address]:
    """Every address *host* should be judged as, or ``[]`` if it is a name.

    An IPv6 zone id ("fe80::1%eth0", percent-encoded as ``%25eth0``) is
    stripped first -- :mod:`ipaddress` cannot parse the scoped form. A
    trailing dot (FQDN root form: ``localhost.`` / ``127.0.0.1.``) is
    stripped too, so a host is judged by its VALUE, never by its DNS
    spelling. An IPv4-mapped literal ("::ffff:127.0.0.1") is unwrapped and
    returned AHEAD of its parent so the embedded v4 address is judged on
    its own and reports the accurate reason; Go reaches the same verdict
    through ``IP.To4()`` and TypeScript through its explicit IPv4-tail
    check.

    Numeric hosts are normalized by :func:`_normalize_numeric_host` BEFORE
    any verdict, because ``ipaddress`` rejects every short spelling and the
    old code then treated them as DNS names. A numeric-shaped host that
    cannot be normalized raises -- fail closed, never silently accepted.
    """
    text = host.strip()
    # Zone-id strip is IPv6-only (hosts containing ':'): an IPv4-looking
    # host such as "8.8.8.8%09" must NOT be silently normalized to
    # "8.8.8.8" -- the "%" form is not an IPv6 scoped literal.
    if ":" in text:
        zone = text.find("%")
        if zone != -1:
            text = text[:zone]
    text = text.rstrip(".")
    try:
        ip = ipaddress.ip_address(text)
    except ValueError:
        try:
            return [_normalize_numeric_host(text)]
        except _NotNumericHost:
            return []  # not an IP literal -- a DNS name
        # _BadNumericHost propagates to _url(), which rejects with the
        # field name in the message.
    mapped = getattr(ip, "ipv4_mapped", None)
    return [mapped, ip] if mapped is not None else [ip]


def _non_routable_reason(host: str) -> str | None:
    """Why *host* is an internal address literal, else ``None``.

    Consults :data:`_BLOCKED_EXACT` then :data:`_BLOCKED_NETWORKS` after
    :func:`_ip_literals` normalization. DNS names return ``None``: this
    guards the literal host, it is not a DNS-rebinding filter (a name that
    resolves to 127.0.0.1 still passes, exactly as in Go and TypeScript).

    Raises:
        ValueError: *host* is numeric-shaped but unparseable (fail closed).
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
    loopback/private/link-local/multicast IP literal now fail -- including
    the numeric-IP bypass (``2852039166``, ``0x7f000001``, ``017700000001``,
    ``127.1``), which inet_aton normalization resolves to its dotted quad
    before the blocklist runs. The shape gate runs first so a non-http(s)
    scheme keeps its existing message; ``.port`` is touched inside the try
    so a malformed port is reported as an invalid URL rather than exploding
    at send time.
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
    try:
        reason = _non_routable_reason(host)
    except ValueError as exc:  # numeric-shaped, unparseable: fail closed
        raise ValueError(
            f"mpesa: {field_name} host {host!r} is numeric but not a valid "
            f"IP literal ({exc})") from None
    if reason is not None:
        raise ValueError(
            f"mpesa: {field_name} must not point to an internal or private "
            f"IP address ({reason})")


def _phone(field_name: str, raw: str) -> str:
    try:
        return normalize_phone(raw)
    except ValueError as exc:
        raise ValueError(f"mpesa: invalid {field_name}: {exc}") from None


def _service_limits(service: str, limits: "TransactionLimits | None"
                    ) -> "ServiceLimits":
    """Resolved per-service bounds: caller overrides merged on defaults.

    Service names are the :class:`~mpesa.limits.TransactionLimits` field
    names; anything else (including a mis-spelled one) resolves to
    ``default`` rather than to unlimited, so a new endpoint inherits the
    documented baseline the moment it opts into limiting.

    Always goes through
    :func:`mpesa.limits._resolve_transaction_limits`, so a PARTIAL config
    keeps the Safaricom default for every field the caller left UNSET --
    overriding one service therefore cannot silently disable another's
    ceiling. The function is idempotent, which is what lets the client
    resolve once and pass the result back in.
    """
    resolved = _resolve_transaction_limits(limits)
    bounds = getattr(resolved, service, None)
    if isinstance(bounds, ServiceLimits):
        return bounds
    # Unknown service name: ``default``, already merged against the
    # baseline, rather than unlimited.
    return resolved.default


def _require_ceiling(field_name: str, service: str, amount: int,
                     ceiling: int | None) -> None:
    """Reject *amount* above *ceiling*, naming service and override path.

    The message carries the SERVICE, the configured ceiling and how to
    raise it, because the overwhelmingly likely cause is a merchant tier
    the SDK defaults do not know about -- an error that says only
    "too much money" makes the operator hunt the wrong bug. The value is
    never stringified verbatim from a hostile input: magnitudes are
    bounded before this runs.
    """
    if ceiling is None or amount <= ceiling:
        return
    raise ValueError(
        f"mpesa: {field_name} {amount} exceeds the {ceiling} KES "
        f"per-transaction ceiling configured for the {service} service; "
        f"override it with Config(limits=TransactionLimits({service}="
        f"ServiceLimits(max_per_transaction=<KES>))) -- leave a field "
        f"unset (None) to keep the Safaricom default for it, or set it to "
        f"0 to disable that ceiling entirely")


def _check_transaction_limit(field_name: str, service: str, amount: int,
                             limits: "TransactionLimits | None" = None) -> None:
    """Per-transaction ceiling for *service* (mirrors the daily twin).

    Called from every amount-bearing ``validate()`` BEFORE the model can
    reach a transport, so an over-tier payment fails in-process instead of
    costing an OAuth token and a round-trip. ``limits=None`` means the
    documented defaults, never "unchecked".
    """
    _require_ceiling(field_name, service, amount,
                     _resolved_max(
                         _service_limits(service, limits)
                         .max_per_transaction))


def _amount_int(field_name: str, amount: Any) -> int:
    """Strict positive integer amount, bounded by the MAGNITUDE guard.

    Bools are refused up front (``bool`` is an ``int`` subclass, and
    ``True`` used to serialize as ``1``), floats are refused (money on
    these endpoints is whole-number KES), and the magnitude is capped at
    :data:`_MAGNITUDE_GUARD` -- a Python int is unbounded, so ``10**5000``
    otherwise serialized straight into the request body.

    The BUSINESS ceiling is NOT here: it is per-merchant and arrives from
    :data:`~mpesa.limits.DEFAULT_TRANSACTION_LIMITS` (or ``Config.limits``)
    via :func:`_check_transaction_limit`. Conflating the two is what
    previously capped a freshly-upgraded B2C merchant at the figure
    documented for a brand-new one.
    """
    if isinstance(amount, bool) or not isinstance(amount, int):
        raise ValueError(f"mpesa: {field_name} must be a whole number")
    if amount <= 0:
        raise ValueError(
            f"mpesa: {field_name} must be a positive whole number, got {amount}")
    if amount > _MAGNITUDE_GUARD:
        # Approximate digit count, NEVER str(amount): converting a 5000-digit
        # int trips CPython's 4300-digit guard and would turn this clean
        # rejection into an unreadable crash.
        digits = abs(amount).bit_length() * 30103 // 100000
        raise ValueError(f"mpesa: {field_name} exceeds the magnitude ceiling "
                         f"of {_MAGNITUDE_GUARD} KES (got ~{digits} digits) -- "
                         f"not a merchant tier; the configured tier ceiling "
                         f"is enforced separately")
    return amount


def _clean(payload: dict[str, Any]) -> dict[str, Any]:
    """omitempty parity: drop None and empty strings ONLY -- ints stay."""
    return {k: v for k, v in payload.items()
            if not (v is None or (isinstance(v, str) and not v))}


def _sentinel() -> Any:
    return dataclasses.field(default=False, init=False, repr=False, compare=False)


def _safe(model: Any, *shown: str) -> str:
    """Shared credential-safe renderer used by every sync model's repr.

    Mirrors ``mpesa.requests_async._safe``: shows only the whitelisted
    fields and marks everything else REDACTED, so a repr never leaks
    callback URLs (which can embed signed tokens) into logs or tracebacks.
    """
    body = ", ".join(f"{name}={getattr(model, name)!r}" for name in shown)
    return f"<{type(model).__name__}({body}, credentials=REDACTED)>"


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

    def __repr__(self) -> str:
        return _safe(self, "business_short_code", "amount",
                     "account_reference")

    def validate(self, limits: "TransactionLimits | None" = None) -> None:
        """Every documented constraint; TransactionType has NO default.

        ``limits`` is the per-merchant tier (``None`` keeps
        :data:`~mpesa.limits.DEFAULT_TRANSACTION_LIMITS`); the
        per-transaction ceiling is applied here so an over-tier payment
        fails in-process, before any transport call.
        """
        self.business_short_code = _shortcode(
            "BusinessShortCode", self.business_short_code)
        tt = _enum_value(self.transaction_type)
        if tt is None or tt == "":
            raise ValueError("mpesa: TransactionType is required "
                             "(CustomerPayBillOnline | CustomerBuyGoodsOnline)")
        allowed = (TransactionType.CUSTOMER_PAY_BILL_ONLINE.value,
                   TransactionType.CUSTOMER_BUY_GOODS_ONLINE.value)
        if tt not in allowed:
            raise ValueError(f"mpesa: TransactionType {tt!r} not in "
                             "{CustomerPayBillOnline, CustomerBuyGoodsOnline}")
        # _amount_int enforces positivity, whole-numberness and the
        # MAGNITUDE guard; the tier ceiling comes from limits via
        # _check_transaction_limit, which names service and override path.
        _amount_int("Amount", self.amount)
        _check_transaction_limit("Amount", "stk", self.amount, limits)
        self.party_a = _phone("PartyA", self.party_a)
        self.phone_number = _phone("PhoneNumber", self.phone_number)
        _url("CallBackURL", self.call_back_url)
        if not self.account_reference.strip():
            raise ValueError("mpesa: AccountReference is required")
        self.account_reference = _free_text(
            "AccountReference", self.account_reference, 12)
        if not self.transaction_desc.strip():
            raise ValueError("mpesa: TransactionDesc is required")
        self.transaction_desc = _free_text(
            "TransactionDesc", self.transaction_desc, 13)
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

    def validate(self, limits: "TransactionLimits | None" = None) -> None:
        # No amount to bound: the parameter exists so the client can call
        # validate(limits=...) uniformly across every model (see the
        # PARITY CONTRACT in requests_async.py).
        self.business_short_code = _shortcode(
            "BusinessShortCode", self.business_short_code)
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

    def __repr__(self) -> str:
        return _safe(self, "short_code")

    def validate(self, limits: "TransactionLimits | None" = None) -> None:
        # URL registration carries no amount; ``limits`` is accepted for a
        # uniform client-side call only (see requests_async PARITY CONTRACT).
        rt = _enum_value(self.response_type)
        if rt not in (ResponseType.COMPLETED.value, ResponseType.CANCELLED.value):
            raise ValueError(
                f"mpesa: ResponseType {rt!r} must be Completed or Cancelled")
        self.short_code = _shortcode("ShortCode", self.short_code)
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

    def validate(self, limits: "TransactionLimits | None" = None) -> None:
        cmd = _enum_value(self.command_id)
        allowed = (TransactionType.CUSTOMER_PAY_BILL_ONLINE.value,
                   TransactionType.CUSTOMER_BUY_GOODS_ONLINE.value)
        if cmd not in allowed:
            raise ValueError(f"mpesa: simulate CommandID {cmd!r} not in "
                             "{CustomerPayBillOnline, CustomerBuyGoodsOnline}")
        self.short_code = _shortcode("ShortCode", self.short_code)
        _amount_int("simulate Amount", self.amount)
        _check_transaction_limit("simulate Amount", "c2b", self.amount, limits)
        self.msisdn = _phone("Msisdn", self.msisdn)
        self.bill_ref_number = _free_text(
            "BillRefNumber", self.bill_ref_number, 32)
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

    def validate(self, limits: "TransactionLimits | None" = None) -> None:
        _require("MerchantName", self.merchant_name)
        _require("RefNo", self.ref_no)
        _amount_int("QR Amount", self.amount)
        # QR has no dedicated tier entry: it inherits ``default`` (same as
        # Reversal and TransactionStatus) per mpesa.limits.
        _check_transaction_limit("QR Amount", "default", self.amount, limits)
        try:
            self.trx_code = QRTrxCode(_enum_value(self.trx_code))
        except ValueError:
            raise ValueError(f"mpesa: TrxCode {_enum_value(self.trx_code)!r} "
                             "not in {BG, WA, PB, SM, SB}") from None
        cpi = self.cpi.strip()
        # Length, never the value: an overlong input must not become a
        # multi-megabyte error string that lands in the caller's log.
        if not (5 <= len(cpi) <= _QR_FIELD_MAX_CHARS) or not cpi.isdigit() \
                or not cpi.isascii():
            raise ValueError(f"mpesa: CPI must be 5-12 ASCII digits "
                             f"(got {len(cpi)} characters)")
        size = self.size.strip()
        # Length-capped exactly like the CPI bound above: without a cap a
        # multi-MB digit string passed every existing gate and serialized
        # verbatim into the payload (Size is a pixel dimension, "300").
        if (not (size.isascii() and size.isdigit())
                or len(size) > _QR_FIELD_MAX_CHARS or int(size) <= 0):
            raise ValueError(f"mpesa: Size must be a positive integer of at "
                             f"most {_QR_FIELD_MAX_CHARS} digits (got "
                             f"{len(size)} characters)")
        self.cpi, self.size = cpi, size
        self._validated = True

    def to_payload(self) -> dict[str, Any]:
        _ensure_validated(self)
        return {"MerchantName": self.merchant_name, "RefNo": self.ref_no,
                "Amount": self.amount, "TrxCode": _enum_value(self.trx_code),
                "CPI": self.cpi, "Size": self.size}
