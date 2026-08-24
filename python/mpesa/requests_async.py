"""Async credential request models (B2C/TxStatus/Reversal/Balance),
mirroring go/requests.go. Validate first -- ``to_payload`` refuses
unvalidated models. Wire-key traps: B2C uses ``InitiatorName`` + double-s
``Occassion``; TransactionStatus uses ``Initiator`` + single-s ``Occasion``;
Reversal keeps misspelled ``RecieverIdentifierType`` (default "11").
repr/str NEVER render initiator or SecurityCredential values (GoString
parity); pickle/asdict still carry them -- redact at the log boundary.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .enums import RECEIVER_IDENTIFIER_ORG, CommandID
from .requests_sync import (_amount_int, _clean, _enum_value, _phone,
                            _printable, _require, _sentinel, _url)

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


def _ensure_validated(model: Any) -> None:
    if not model._validated:
        raise RuntimeError("mpesa: call validate() before to_payload()")


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

    def validate(self) -> None:
        """Constraint parity with Go Validate(); normalizes PartyB."""
        if self.originator_conversation_id:
            _printable("OriginatorConversationID",
                       self.originator_conversation_id, 32)
        _require("InitiatorName", self.initiator_name)
        _require("SecurityCredential", self.security_credential)
        cmd = _enum_value(self.command_id)
        if cmd not in _B2C_COMMANDS:
            raise ValueError(f"mpesa: B2C CommandID {cmd!r} not in "
                             "{SalaryPayment, BusinessPayment, PromotionPayment}")
        amount = _amount_int("B2C Amount", self.amount)
        if not 10 <= amount <= 250_000:
            raise ValueError(f"mpesa: B2C Amount {amount} outside [10,250000] KES")
        _require("PartyA", self.party_a)
        self.party_b = _phone("PartyB", self.party_b)
        n = len(self.remarks.strip())
        if not 2 <= n <= 100:
            raise ValueError(f"mpesa: B2C Remarks must be 2-100 characters, got {n}")
        self.remarks = self.remarks.strip()
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

    def validate(self) -> None:
        self.transaction_id = self.transaction_id.strip()
        self.original_conversation_id = self.original_conversation_id.strip()
        if not self.transaction_id and not self.original_conversation_id:
            raise ValueError("mpesa: exactly one of TransactionID or "
                             "OriginalConversationID is required")
        if self.transaction_id and self.original_conversation_id:
            raise ValueError("mpesa: exactly one of TransactionID or "
                             "OriginalConversationID must be set, got both")
        cmd = _enum_value(self.command_id)
        if cmd and cmd != CommandID.TX_STATUS_QUERY.value:
            raise ValueError(
                "mpesa: TransactionStatus CommandID must be TransactionStatusQuery")
        _require("Initiator", self.initiator)
        _require("SecurityCredential", self.security_credential)
        _require("PartyA", self.party_a)
        if self.identifier_type:
            _printable("IdentifierType", self.identifier_type, 12)
        n = len(self.remarks.strip())
        if not 1 <= n <= 100:
            raise ValueError(f"mpesa: Remarks must be 1-100 characters, got {n}")
        self.remarks = self.remarks.strip()
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

    def validate(self) -> None:
        cmd = _enum_value(self.command_id)
        if cmd and cmd != CommandID.REVERSAL.value:
            raise ValueError("mpesa: Reversal CommandID must be TransactionReversal")
        _require("Initiator", self.initiator)
        _require("SecurityCredential", self.security_credential)
        _printable("TransactionID", self.transaction_id, 64)
        _require("TransactionID", self.transaction_id)
        amount = _amount_int("Reversal Amount", self.amount)
        if amount <= 0:
            raise ValueError(f"mpesa: Reversal Amount must be positive, got {amount}")
        _require("ReceiverParty", self.receiver_party)
        if self.receiver_identifier_type is not None:
            _printable("ReceiverIdentifierType", self.receiver_identifier_type, 12)
        n = len(self.remarks.strip())
        if not 2 <= n <= 100:
            raise ValueError(
                f"mpesa: Reversal Remarks must be 2-100 characters, got {n}")
        self.remarks = self.remarks.strip()
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

    def validate(self) -> None:
        cmd = _enum_value(self.command_id)
        if cmd and cmd != CommandID.ACCOUNT_BALANCE.value:
            raise ValueError(
                "mpesa: AccountBalance CommandID must be AccountBalance")
        _require("Initiator", self.initiator)
        _require("SecurityCredential", self.security_credential)
        _require("PartyA", self.party_a)
        if self.identifier_type:
            _printable("IdentifierType", self.identifier_type, 12)
        n = len(self.remarks.strip())
        if not 1 <= n <= 100:
            raise ValueError(f"mpesa: Remarks must be 1-100 characters, got {n}")
        self.remarks = self.remarks.strip()
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
