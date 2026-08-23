"""Wire-safe enumerations and identifier constants for the Daraja API.

Mirrors go/enums.go. Every enum here replaces a bare wire string that
Safaricom matches exactly (case-sensitive). Typo-bugs these prevent::

    "customerpaybillonline"   # wrong case        -> silent gateway rejection
    "CustomerPayBillOnlne"    # dropped letter    -> silent gateway rejection
    "Cancelled"/"CANCELLED"   # wrong casing      -> C2B registration failure

Design decisions:
* ``TransactionType``, ``CommandID``, ``ResponseType`` and ``QRTrxCode``
  subclass ``(str, Enum)`` so ``json.dumps({"TransactionType": TT.X})``
  emits the exact wire string directly -- call sites never sprinkle
  ``.value`` and can also compare members against raw strings safely.
* ``Environment`` deliberately does NOT mix in ``str``: its members hold
  full base URLs, which should flow only through ``Client`` config, not
  leak into payloads via implicit string coercion.
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


class TransactionType(str, enum.Enum):
    """STK Push ``TransactionType`` -- REQUIRED, no default (Go review K1).

    The caller must pick explicitly because the choice must match the
    receiving merchant type or the prompt fails at authorization time.
    """

    CUSTOMER_PAY_BILL_ONLINE = "CustomerPayBillOnline"
    """Paybill accounts (shortcode + account number)."""
    CUSTOMER_BUY_GOODS_ONLINE = "CustomerBuyGoodsOnline"
    """Buy Goods tills (till number, no account reference)."""


class CommandID(str, enum.Enum):
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


class ResponseType(str, enum.Enum):
    """C2B URL-registration fallback behaviour when ValidationURL is
    unreachable. Wire values are sentence-case -- NOT SCREAMING_CASE."""

    COMPLETED = "Completed"
    """Accept the payment even though validation never answered."""
    CANCELLED = "Cancelled"
    """Reject the payment when validation is unreachable."""


class QRTrxCode(str, enum.Enum):
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
