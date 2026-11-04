"""Async credential request models (B2C/TxStatus/Reversal/Balance),
mirroring go/requests.go. Validate first -- ``to_payload`` refuses
unvalidated models. Wire-key traps: B2C uses ``InitiatorName`` + double-s
``Occassion``; TransactionStatus uses ``Initiator`` + single-s ``Occasion``;
Reversal keeps misspelled ``RecieverIdentifierType`` (default "11").
repr/str NEVER render initiator or SecurityCredential values (GoString
parity); pickle/asdict still carry them -- redact at the log boundary.

PARITY CONTRACT with :mod:`mpesa.requests_sync`: the two files share ONE
set of validators (``_url``, ``_phone``, ``_shortcode``, ``_amount_int``,
``_check_transaction_limit``, ``_free_text``, ``_printable``, ``_require``)
and every rule is applied identically to the same kind of wire field, so
neither file can be hardened alone. Concretely: every identifier gets the
same length/printable cap (TxStatus identifiers match
``ReversalRequest``'s ``_printable(..., 64)``), every free-text field is
trimmed and bounded the same way, every MSISDN field goes through
``_phone`` and every shortcode field through ``_shortcode`` (B2C ``PartyA``
is a shortcode, not an MSISDN -- which is why it is validated as one
rather than normalized as a phone), and every amount-bearing endpoint
resolves its ceiling through the same ``limits`` argument, so the sync
(STK/C2B/QR) and async (B2C/TxStatus/Reversal) paths can never disagree
about a merchant's tier.

TRANSPORT NOTE: this module contains MODELS ONLY. There is no async HTTP
transport: :class:`mpesa.client.MpesaClient` is a blocking client by design
(its OAuth refresh runs a leader/waiter protocol with the network call
outside the lock), so an async transport is out of scope -- and no model
here may be used as an excuse to build one.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .enums import RECEIVER_IDENTIFIER_ORG, CommandID
from .limits import TransactionLimits
from .requests_sync import (
    _amount_int,
    _check_transaction_limit,
    _clean,
    _ensure_validated,
    _enum_value,
    _free_text,
    _phone,
    _printable,
    _require,
    _sentinel,
    _shortcode,
    _url,
)

__all__ = ["B2CPayoutRequest", "TransactionStatusRequest",
           "ReversalRequest", "AccountBalanceRequest", "B2BRequest",
           "TaxRemittanceRequest"]
_B2C_COMMANDS = {CommandID.SALARY_PAYMENT.value, CommandID.BUSINESS_PAYMENT.value,
                 CommandID.PROMOTION_PAYMENT.value}
#: B2B Express Checkout accepts exactly two CommandIDs: paying a paybill
#: (``PartyB`` is a paybill shortcode, ``AccountReference`` its account)
#: or paying a Buy Goods till (``PartyB`` is a till number). Mirrors
#: ``_B2C_COMMANDS`` so the closed set lives beside its sibling, not
#: inside each validator.
_B2B_COMMANDS = {CommandID.BUSINESS_PAY_BILL.value,
                 CommandID.BUSINESS_BUY_GOODS.value}


def _safe(model: Any, *shown: str) -> str:
    """Shared credential-safe renderer used by every async model's repr."""
    body = ", ".join(f"{name}={getattr(model, name)!r}" for name in shown)
    return f"<{type(model).__name__}({body}, credentials=REDACTED)>"


def _secret() -> Any:
    return field(default="", repr=False)


@dataclass
class B2CPayoutRequest:
    """B2C payout to a customer MSISDN (docs/apis/b2c.md); amount must be
    within [10, 250000] KES; PartyB normalized in place. Usage::

        req = B2CPayoutRequest(initiator_name="testapi", security_credential=cred,
                               command_id=CommandID.BUSINESS_PAYMENT, amount=10,
                               party_a="600992", party_b="+254705912645",
                               remarks="payout", result_url="https://x.com/r",
                               queue_time_out_url="https://x.com/t")
        req.validate(); payload = req.to_payload()
    """

    originator_conversation_id: str = ""
    initiator_name: str = _secret()
    security_credential: str = _secret()
    command_id: CommandID | str | None = None
    amount: int = 0
    party_a: str = ""
    party_b: str = ""
    remarks: str = ""
    queue_time_out_url: str = ""
    result_url: str = ""
    occassion: str = ""
    _validated: bool = _sentinel()

    def __repr__(self) -> str:
        return _safe(self, "party_a", "amount")

    def validate(self, limits: "TransactionLimits | None" = None) -> None:
        """Constraint parity with Go Validate(); normalizes PartyB.

        Daraja contract on OriginatorConversationID: REQUIRED at validate
        time and strictly shorter than 20 chars (``len <= 19``; overlong
        values are rejected by the gateway). The client auto-fills an
        empty value via :func:`~mpesa.helpers.new_originator_id` BEFORE
        calling this, so direct ``validate()`` on a model with an empty
        id fails while the client path always sends a fresh 16-char key.

        ``limits`` supplies the B2C tier ceiling (see :mod:`mpesa.limits`);
        the minimum stays the documented 10 KES and only the maximum moves.
        """
        if not (self.originator_conversation_id or "").strip():
            raise ValueError("mpesa: OriginatorConversationID is required")
        _printable("OriginatorConversationID",
                   self.originator_conversation_id, 19)
        _require("InitiatorName", self.initiator_name)
        _require("SecurityCredential", self.security_credential)
        cmd = _enum_value(self.command_id)
        if cmd not in _B2C_COMMANDS:
            raise ValueError(f"mpesa: B2C CommandID {cmd!r} not in "
                             "{SalaryPayment, BusinessPayment, PromotionPayment}")
        amount = _amount_int("B2C Amount", self.amount)
        if amount < 10:
            raise ValueError(f"mpesa: B2C Amount {amount} below the 10 KES "
                             f"minimum for a B2C payout")
        _check_transaction_limit("B2C Amount", "b2c", amount, limits)
        self.party_a = _shortcode("PartyA", self.party_a)
        self.party_b = _phone("PartyB", self.party_b)
        self.remarks = _free_text("B2C Remarks", self.remarks, 100, minimum=2)
        _url("QueueTimeOutURL", self.queue_time_out_url)
        _url("ResultURL", self.result_url)
        self._validated = True

    def to_payload(self) -> dict[str, Any]:
        """Double-s ``Occassion`` and ``InitiatorName`` -- official spellings."""
        _ensure_validated(self)
        return _clean({
            "OriginatorConversationID": self.originator_conversation_id,
            "InitiatorName": self.initiator_name,
            "SecurityCredential": self.security_credential,
            "CommandID": _enum_value(self.command_id),
            "Amount": self.amount, "PartyA": self.party_a, "PartyB": self.party_b,
            "Remarks": self.remarks, "QueueTimeOutURL": self.queue_time_out_url,
            "ResultURL": self.result_url, "Occassion": self.occassion,
        })


@dataclass
class TransactionStatusRequest:
    """Query by receipt XOR original conversation ID
    (docs/apis/transaction-status.md); whitespace-only identifiers count
    as unset and are stored stripped. Usage::

        req = TransactionStatusRequest(initiator="testapi",
                                       security_credential=cred,
                                       transaction_id="NLJ7RT61SV",
                                       party_a="600992", remarks="status check",
                                       result_url="https://x.com/r",
                                       queue_time_out_url="https://x.com/t")
        req.validate()
    """

    initiator: str = _secret()
    security_credential: str = _secret()
    command_id: CommandID | str | None = None
    transaction_id: str = ""
    original_conversation_id: str = ""
    party_a: str = ""
    identifier_type: str = ""
    result_url: str = ""
    queue_time_out_url: str = ""
    remarks: str = ""
    occasion: str = ""  # single-s on this endpoint!
    _validated: bool = _sentinel()

    def __repr__(self) -> str:
        return _safe(self, "transaction_id", "original_conversation_id")

    def validate(self, limits: "TransactionLimits | None" = None) -> None:
        self.transaction_id = self.transaction_id.strip()
        self.original_conversation_id = self.original_conversation_id.strip()
        if not self.transaction_id and not self.original_conversation_id:
            raise ValueError("mpesa: exactly one of TransactionID or "
                             "OriginalConversationID is required")
        if self.transaction_id and self.original_conversation_id:
            raise ValueError("mpesa: exactly one of TransactionID or "
                             "OriginalConversationID must be set, got both")
        # Identifier parity with ReversalRequest (and STKQueryRequest's
        # CheckoutRequestID): both identifiers get the SAME length +
        # printable-ASCII cap, so an overlong receipt cannot be smuggled
        # through the one model that was missing the check.
        if self.transaction_id:
            _printable("TransactionID", self.transaction_id, 64)
        if self.original_conversation_id:
            _printable("OriginalConversationID",
                       self.original_conversation_id, 64)
        cmd = _enum_value(self.command_id)
        if cmd and cmd != CommandID.TX_STATUS_QUERY.value:
            raise ValueError(
                "mpesa: TransactionStatus CommandID must be TransactionStatusQuery")
        _require("Initiator", self.initiator)
        _require("SecurityCredential", self.security_credential)
        _shortcode("PartyA", self.party_a)
        if self.identifier_type:
            _printable("IdentifierType", self.identifier_type, 12)
        self.remarks = _free_text("Remarks", self.remarks, 100)
        _url("ResultURL", self.result_url)
        _url("QueueTimeOutURL", self.queue_time_out_url)
        self._validated = True

    def to_payload(self) -> dict[str, Any]:
        _ensure_validated(self)
        return _clean({
            "Initiator": self.initiator,
            "SecurityCredential": self.security_credential,
            "CommandID": _enum_value(self.command_id),
            "TransactionID": self.transaction_id,
            "OriginalConversationID": self.original_conversation_id,
            "PartyA": self.party_a, "IdentifierType": self.identifier_type,
            "ResultURL": self.result_url,
            "QueueTimeOutURL": self.queue_time_out_url, "Occasion": self.occasion,
        })


@dataclass
class ReversalRequest:
    """Reverse a recent C2B transaction (docs/apis/reversal.md); wire key
    stays misspelled ``RecieverIdentifierType``, payload-defaulted to "11".

    Example::

        req = ReversalRequest(initiator="testapi", security_credential=cred,
                              transaction_id="NLJ7RT61SV", amount=10,
                              receiver_party="600992", remarks="duplicate charge",
                               result_url="https://x.com/r",
                               queue_time_out_url="https://x.com/t")
        req.validate()
    """

    initiator: str = _secret()
    security_credential: str = _secret()
    command_id: CommandID | str | None = None
    transaction_id: str = ""
    amount: int = 0
    receiver_party: str = ""
    receiver_identifier_type: str | None = None
    result_url: str = ""
    queue_time_out_url: str = ""
    remarks: str = ""
    _validated: bool = _sentinel()

    def __repr__(self) -> str:
        return _safe(self, "transaction_id", "amount")

    def validate(self, limits: "TransactionLimits | None" = None) -> None:
        cmd = _enum_value(self.command_id)
        if cmd and cmd != CommandID.REVERSAL.value:
            raise ValueError("mpesa: Reversal CommandID must be TransactionReversal")
        _require("Initiator", self.initiator)
        _require("SecurityCredential", self.security_credential)
        _printable("TransactionID", self.transaction_id, 64)
        _require("TransactionID", self.transaction_id)
        _amount_int("Reversal Amount", self.amount)
        # Reversal spends its OWN tier bucket (mpesa.limits) for BOTH
        # bounds -- the per-transaction check and the daily accrual -- so
        # one service never resolves to two different ceilings inside one
        # engine. Resolving it to ``default`` instead made a raised
        # Reversal tier honoured on one bound and ignored on the other.
        _check_transaction_limit(
            "Reversal Amount", "reversal", self.amount, limits)
        _require("ReceiverParty", self.receiver_party)
        if self.receiver_identifier_type is not None:
            _printable("ReceiverIdentifierType", self.receiver_identifier_type, 12)
        self.remarks = _free_text(
            "Reversal Remarks", self.remarks, 100, minimum=2)
        _url("ResultURL", self.result_url)
        _url("QueueTimeOutURL", self.queue_time_out_url)
        self._validated = True

    def to_payload(self) -> dict[str, Any]:
        _ensure_validated(self)
        return {
            "Initiator": self.initiator,
            "SecurityCredential": self.security_credential,
            "CommandID": _enum_value(self.command_id),
            "TransactionID": self.transaction_id,
            "Amount": self.amount, "ReceiverParty": self.receiver_party,
            "RecieverIdentifierType":
                self.receiver_identifier_type or RECEIVER_IDENTIFIER_ORG,
            "ResultURL": self.result_url,
            "QueueTimeOutURL": self.queue_time_out_url,
            "Remarks": self.remarks,
        }


@dataclass
class AccountBalanceRequest:
    """Organization balance query (docs/apis/account-balance.md); the async
    Result callback carries the segment string parsed elsewhere. Usage::

        req = AccountBalanceRequest(initiator="testapi",
                                    security_credential=cred, party_a="600992",
                                    identifier_type="4", remarks="balance check",
                                    queue_time_out_url="https://x.com/t",
                                    result_url="https://x.com/r")
        req.validate()
    """

    initiator: str = _secret()
    security_credential: str = _secret()
    command_id: CommandID | str | None = None
    party_a: str = ""
    identifier_type: str = ""
    remarks: str = ""
    queue_time_out_url: str = ""
    result_url: str = ""
    _validated: bool = _sentinel()

    def __repr__(self) -> str:
        return _safe(self, "party_a")

    def validate(self, limits: "TransactionLimits | None" = None) -> None:
        # No amount (a balance query reports one, it never sends one):
        # ``limits`` is accepted only so the client can call
        # validate(limits=...) uniformly across every model.
        cmd = _enum_value(self.command_id)
        if cmd and cmd != CommandID.ACCOUNT_BALANCE.value:
            raise ValueError(
                "mpesa: AccountBalance CommandID must be AccountBalance")
        _require("Initiator", self.initiator)
        _require("SecurityCredential", self.security_credential)
        _shortcode("PartyA", self.party_a)
        if self.identifier_type:
            _printable("IdentifierType", self.identifier_type, 12)
        self.remarks = _free_text("Remarks", self.remarks, 100)
        _url("QueueTimeOutURL", self.queue_time_out_url)
        _url("ResultURL", self.result_url)
        self._validated = True

    def to_payload(self) -> dict[str, Any]:
        _ensure_validated(self)
        return _clean({
            "Initiator": self.initiator,
            "SecurityCredential": self.security_credential,
            "CommandID": _enum_value(self.command_id),
            "PartyA": self.party_a, "IdentifierType": self.identifier_type,
            "Remarks": self.remarks,
            "QueueTimeOutURL": self.queue_time_out_url,
            "ResultURL": self.result_url,
        })


@dataclass
class B2BRequest:
    """B2B Express Checkout, business-to-business payment
    (docs/apis/b2b.md) -- ``POST /mpesa/b2b/v3/paymentrequest``.

    Wire keys are contractual: ``Initiator`` (NOT B2C's
    ``InitiatorName``), ``CommandID`` restricted to
    ``BusinessPayBill``/``BusinessBuyGoods``, and BOTH parties are
    SHORTCODES (a business sends a business payment, never an MSISDN)
    bounded by ``_shortcode`` exactly as ``TransactionStatusRequest``'s
    ``PartyA`` is. ``OriginatorConversationID`` and both identifier types
    are OPTIONAL here: the client injects ``"4"`` for the identifier
    types and a fresh 16-hex id (see
    :func:`~mpesa.helpers.new_originator_id`) BEFORE ``validate()``, so
    the model -- like :class:`B2CPayoutRequest` -- still refuses an empty
    id on the direct-``validate()`` path.

    Usage::

        req = B2BRequest(initiator="testapi", security_credential=cred,
                         command_id=CommandID.BUSINESS_PAY_BILL, amount=1000,
                         party_a="600000", party_b="600123",
                         account_reference="INV-001", remarks="services",
                         queue_time_out_url="https://x.com/t",
                         result_url="https://x.com/r")
        req.validate(); payload = req.to_payload()
    """

    originator_conversation_id: str = ""
    initiator: str = _secret()
    security_credential: str = _secret()
    command_id: CommandID | str | None = None
    sender_identifier_type: str = ""
    receiver_identifier_type: str = ""
    amount: int = 0
    party_a: str = ""
    party_b: str = ""
    account_reference: str = ""
    remarks: str = ""
    queue_time_out_url: str = ""
    result_url: str = ""
    _validated: bool = _sentinel()

    def __repr__(self) -> str:
        return _safe(self, "party_a", "amount")

    def validate(self, limits: "TransactionLimits | None" = None) -> None:
        """Constraint parity with the Go Validate(); ``limits`` supplies
        the ``b2b`` tier ceiling (see :mod:`mpesa.limits`).
        """
        # Client-injected before this runs (see the class docstring), so
        # the empty case is the direct-validate() misuse path.
        _require("OriginatorConversationID", self.originator_conversation_id)
        _printable("OriginatorConversationID",
                   self.originator_conversation_id, 19)
        _require("Initiator", self.initiator)
        _require("SecurityCredential", self.security_credential)
        cmd = _enum_value(self.command_id)
        if cmd not in _B2B_COMMANDS:
            raise ValueError(f"mpesa: B2B CommandID {cmd!r} not in "
                             "{BusinessPayBill, BusinessBuyGoods}")
        amount = _amount_int("B2B Amount", self.amount)
        # "b2b" is the endpoint's OWN bucket for BOTH bounds -- the same
        # containment rule ReversalRequest applies to "reversal" (see the
        # comment there).
        _check_transaction_limit("B2B Amount", "b2b", amount, limits)
        self.party_a = _shortcode("PartyA", self.party_a)
        self.party_b = _shortcode("PartyB", self.party_b)
        _require("AccountReference", self.account_reference)
        self.account_reference = _free_text(
            "AccountReference", self.account_reference, 64)
        _require("Remarks", self.remarks)
        self.remarks = _free_text("B2B Remarks", self.remarks, 100)
        # Client-injected defaults: only length/printable-guarded here so
        # a caller-supplied type is not silently normalised away.
        if self.sender_identifier_type:
            _printable("SenderIdentifierType", self.sender_identifier_type, 12)
        else:
            self.sender_identifier_type = "4"
        if self.receiver_identifier_type:
            _printable("ReceiverIdentifierType",
                       self.receiver_identifier_type, 12)
        else:
            self.receiver_identifier_type = "4"
        _url("QueueTimeOutURL", self.queue_time_out_url)
        _url("ResultURL", self.result_url)
        self._validated = True

    def to_payload(self) -> dict[str, Any]:
        """``Initiator`` (not ``InitiatorName``) -- B2B's own wire key."""
        _ensure_validated(self)
        return _clean({
            "OriginatorConversationID": self.originator_conversation_id,
            "Initiator": self.initiator,
            "SecurityCredential": self.security_credential,
            "CommandID": _enum_value(self.command_id),
            "SenderIdentifierType": self.sender_identifier_type,
            "ReceiverIdentifierType": self.receiver_identifier_type,
            "Amount": self.amount, "PartyA": self.party_a,
            "PartyB": self.party_b,
            "AccountReference": self.account_reference,
            "Remarks": self.remarks,
            "QueueTimeOutURL": self.queue_time_out_url,
            "ResultURL": self.result_url,
        })


@dataclass
class TaxRemittanceRequest:
    """Tax remittance to the KRA (docs/apis/tax-remittance.md) --
    ``POST /mpesa/b2b/v1/remittax``. The B2B core (``Initiator``,
    ``SecurityCredential``, two shortcode parties, one amount) plus three
    tax-specific keys, with ``CommandID`` fixed to ``TaxRemittance``.

    ``TaxPayerPIN`` is a SECRET: it is ``repr=False`` at the field level
    AND absent from the whitelist ``_safe`` renders, so neither repr nor
    the default ``dataclasses.__repr__`` exposes it.

    Usage::

        req = TaxRemittanceRequest(initiator="testapi", security_credential=cred,
                                   command_id=CommandID.TAX_REMITTANCE, amount=5000,
                                   party_a="600000", party_b="572700",
                                   account_reference="TAX-2024-Q3",
                                   remarks="VAT Q3 2024",
                                   tax_period="2024Q3", tax_obligation="VAT",
                                   tax_payer_pin="A001234567X",
                                   queue_time_out_url="https://x.com/t",
                                   result_url="https://x.com/r")
        req.validate(); payload = req.to_payload()
    """

    originator_conversation_id: str = ""
    initiator: str = _secret()
    security_credential: str = _secret()
    command_id: CommandID | str | None = None
    sender_identifier_type: str = ""
    receiver_identifier_type: str = ""
    amount: int = 0
    party_a: str = ""
    party_b: str = ""
    account_reference: str = ""
    remarks: str = ""
    queue_time_out_url: str = ""
    result_url: str = ""
    tax_period: str = ""
    tax_obligation: str = ""
    tax_payer_pin: str = _secret()
    _validated: bool = _sentinel()

    def __repr__(self) -> str:
        # tax_period is a period label, not PII; tax_payer_pin is a
        # secret and is deliberately NOT whitelisted here.
        return _safe(self, "party_a", "amount", "tax_period")

    def validate(self, limits: "TransactionLimits | None" = None) -> None:
        """The B2B core with ``CommandID`` pinned and ``limits`` supplying
        the ``tax`` tier ceiling.
        """
        _require("OriginatorConversationID", self.originator_conversation_id)
        _printable("OriginatorConversationID",
                   self.originator_conversation_id, 19)
        _require("Initiator", self.initiator)
        _require("SecurityCredential", self.security_credential)
        cmd = _enum_value(self.command_id)
        if cmd != CommandID.TAX_REMITTANCE.value:
            raise ValueError(f"mpesa: TaxRemittance CommandID {cmd!r} "
                             "must be TaxRemittance")
        amount = _amount_int("Tax Amount", self.amount)
        _check_transaction_limit("Tax Amount", "tax", amount, limits)
        self.party_a = _shortcode("PartyA", self.party_a)
        self.party_b = _shortcode("PartyB", self.party_b)
        _require("AccountReference", self.account_reference)
        self.account_reference = _free_text(
            "AccountReference", self.account_reference, 64)
        _require("Remarks", self.remarks)
        self.remarks = _free_text("Tax Remarks", self.remarks, 100)
        _require("TaxPeriod", self.tax_period)
        self.tax_period = _free_text("TaxPeriod", self.tax_period, 16)
        _require("TaxObligation", self.tax_obligation)
        # Free text, NOT an enum: Safaricom's obligation set (VAT, PAYE,
        # Excise, ...) is not closed here and a bespoke allow-list would
        # reject a valid new obligation.
        self.tax_obligation = _free_text(
            "TaxObligation", self.tax_obligation, 32)
        _require("TaxPayerPIN", self.tax_payer_pin)
        _printable("TaxPayerPIN", self.tax_payer_pin, 64)
        if self.sender_identifier_type:
            _printable("SenderIdentifierType", self.sender_identifier_type, 12)
        else:
            self.sender_identifier_type = "4"
        if self.receiver_identifier_type:
            _printable("ReceiverIdentifierType",
                       self.receiver_identifier_type, 12)
        else:
            self.receiver_identifier_type = "4"
        _url("QueueTimeOutURL", self.queue_time_out_url)
        _url("ResultURL", self.result_url)
        self._validated = True

    def to_payload(self) -> dict[str, Any]:
        """B2B core plus the three tax keys; ``Initiator``, not
        ``InitiatorName``."""
        _ensure_validated(self)
        return _clean({
            "OriginatorConversationID": self.originator_conversation_id,
            "Initiator": self.initiator,
            "SecurityCredential": self.security_credential,
            "CommandID": _enum_value(self.command_id),
            "SenderIdentifierType": self.sender_identifier_type,
            "ReceiverIdentifierType": self.receiver_identifier_type,
            "Amount": self.amount, "PartyA": self.party_a,
            "PartyB": self.party_b,
            "AccountReference": self.account_reference,
            "Remarks": self.remarks,
            "QueueTimeOutURL": self.queue_time_out_url,
            "ResultURL": self.result_url,
            "TaxPeriod": self.tax_period,
            "TaxObligation": self.tax_obligation,
            "TaxPayerPIN": self.tax_payer_pin,
        })
