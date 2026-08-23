"""Wire-safe enumerations and identifier constants for the Daraja API.

Mirrors go/enums.go. Every enum here replaces a bare wire string that
Safaricom matches exactly (case-sensitive). Typo-bugs these prevent::

    "customerpaybillonline"   # wrong case        -> silent gateway rejection
    "CustomerPayBillOnlne"    # dropped letter    -> silent gateway rejection
    "Cancelled"/"CANCELLED"   # wrong casing      -> C2B registration failure

Design decisions:
* ``TransactionType``, ``CommandID``, ``ResponseType`` and ``QRTrxCode``
  subclass ``(str, Enum)`` so ``json.dumps({"TransactionType": TT.X})``
  emits the exact wire string directly; ``Environment`` deliberately does
  NOT mix in ``str`` (base URLs flow through Client config only).
"""

from __future__ import annotations

import enum

__all__ = [
    "Environment",
    "TransactionType",
    "CommandID",
    "ResponseType",
    "QRTrxCode",
    "ORGANIZATION_SHORTCODE",
    "RECEIVER_IDENTIFIER_ORG",
]


class Environment(enum.Enum):
    """Selects the Daraja deployment a Client talks to.

    ``SANDBOX`` is the zero-config default, mirroring go/enums.go where
    the zero value is Sandbox -- callers who forget the knob get the
    harmless environment, never production.
    """

    SANDBOX = "https://sandbox.safaricom.co.ke"
    PRODUCTION = "https://api.safaricom.co.ke"

    @property
    def base_url(self) -> str:
        """Platform root URL for this environment."""
        return self.value

    @classmethod
    def from_config(cls, raw: object) -> "Environment":
        """Resolve config input to an Environment member via a fixed whitelist.

        Accepts ``None`` (zero-config default: SANDBOX, mirroring go/enums.go's
        zero value), or a string key of ``sandbox`` / ``production`` / ``prod``
        compared after ``strip().lower()``. URLs and anything unknown raise --
        base URLs are never fuzzy-matched back to members.
        """
        if raw is None:
            return cls.SANDBOX
        if not isinstance(raw, str):
            raise ValueError(f"unknown environment: {raw!r}")
        key = raw.strip().lower()
        if key == "sandbox":
            return cls.SANDBOX
        if key in ("production", "prod"):
            return cls.PRODUCTION
        raise ValueError(f"unknown environment: {raw!r}")


class _WireEnum(str, enum.Enum):
    """Base for all wire-value enums: renders as its wire string, coerces strictly.

    ``__str__``/``__format__`` return the raw value so f-strings, logging and
    format specs never emit ``"Class.MEMBER"`` bytes on Python 3.11+.

    Pass members directly where possible; when a raw string arrives from
    outside (env vars, HTTP input) use :meth:`coerce`. Never test membership
    with ``raw in EnumClass`` -- it matches member *names* rather than values
    and has shifted meaning across Python versions.
    """

    def __str__(self) -> str:
        """The exact gateway string."""
        return self.value

    def __format__(self, format_spec: str) -> str:
        """Format the underlying wire value per *format_spec*."""
        return self.value.__format__(format_spec)

    @classmethod
    def coerce(cls, raw: object) -> "_WireEnum":
        """Exact-match lookup of *raw* -- never trimmed, case-folded or fuzzy."""
        try:
            return cls(raw)  # type: ignore[return-value]
        except ValueError:
            raise ValueError(f"invalid {cls.__name__}: {raw!r}") from None


class TransactionType(_WireEnum):
    """STK Push ``TransactionType`` -- REQUIRED, no default (Go review K1).

    The caller must pick explicitly because the choice must match the
    receiving merchant type or the prompt fails at authorization time.
    """

    CUSTOMER_PAY_BILL_ONLINE = "CustomerPayBillOnline"
    """Paybill accounts (shortcode + account number)."""
    CUSTOMER_BUY_GOODS_ONLINE = "CustomerBuyGoodsOnline"
    """Buy Goods tills (till number, no account reference)."""


class CommandID(_WireEnum):
    """``CommandID`` strings shared by B2C, Transaction Status, Reversal,
    Account Balance and C2B Simulate -- each endpoint accepts a subset."""

    SALARY_PAYMENT = "SalaryPayment"
    """B2C. Recipient must already be M-Pesa registered; unregistered
    numbers fail (unlike BusinessPayment's voucher fallback)."""
    BUSINESS_PAYMENT = "BusinessPayment"
    """B2C. Works for registered and unregistered recipients --
    unregistered users redeem via an agent voucher code."""
    PROMOTION_PAYMENT = "PromotionPayment"
    """B2C. Promotional payouts; registered recipients; pair with Occasion."""
    TX_STATUS_QUERY = "TransactionStatusQuery"
    """Transaction Status. Only valid CommandID for that endpoint."""
    REVERSAL = "TransactionReversal"
    """Reversal. Only valid CommandID for that endpoint."""
    ACCOUNT_BALANCE = "AccountBalance"
    """Account Balance. Only valid CommandID for that endpoint."""
    C2B_PAYBILL_ONLINE = "CustomerPayBillOnline"
    """C2B Simulate. Paybill direction; identical wire spelling to
    :attr:`TransactionType.CUSTOMER_PAY_BILL_ONLINE`, different endpoint."""
    C2B_BUY_GOODS_ONLINE = "CustomerBuyGoodsOnline"
    """C2B Simulate. Buy-goods/till direction; same spelling caveat."""


class ResponseType(_WireEnum):
    """C2B URL-registration fallback behaviour when ValidationURL is
    unreachable. Wire values are sentence-case -- NOT SCREAMING_CASE."""

    COMPLETED = "Completed"
    """Accept the payment even though validation never answered."""
    CANCELLED = "Cancelled"
    """Reject the payment when validation is unreachable."""


class QRTrxCode(_WireEnum):
    """Dynamic QR transaction types (wire codes BG/WA/PB/SM/SB)."""

    BUY_GOODS = "BG"
    """Pay a merchant on Buy Goods (till)."""
    WITHDRAW_AT_AGENT_TILL = "WA"
    """Withdraw cash at an agent till."""
    PAYBILL = "PB"
    """Pay a paybill/business number."""
    SEND_MONEY = "SM"
    """Send money to a mobile MSISDN (P2P)."""
    SEND_TO_BUSINESS = "SB"
    """Send to business -- CPI supplied in MSISDN format."""


#: IdentifierType ``"4"`` (organization shortcode) for Transaction Status
#: and Account Balance requests.
ORGANIZATION_SHORTCODE = "4"

#: IdentifierType ``"11"`` (organization shortcode) for Reversal's
#: ``RecieverIdentifierType`` -- Safaricom's wire field misspells
#: "Receiver"; SDK models must emit the misspelling verbatim.
RECEIVER_IDENTIFIER_ORG = "11"
