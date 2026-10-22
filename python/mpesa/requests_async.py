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
transport: :class:`mpesa.client.MpesaClient` blocks the event loop on the
OAuth lock by design (single-flight refresh, held across the network leg),
so an async transport is out of scope -- and no model here may be used as
an excuse to build one.
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
           "ReversalRequest", "AccountBalanceRequest"]
_B2C_COMMANDS = {CommandID.SALARY_PAYMENT.value, CommandID.BUSINESS_PAYMENT.value,
                 CommandID.PROMOTION_PAYMENT.value}


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
