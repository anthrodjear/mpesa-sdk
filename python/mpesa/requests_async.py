"""Async credential request models (B2C/TxStatus/Reversal/Balance),
mirroring go/requests.go. Construct via future ``Client`` methods or
call :meth:`validate` before sending. Wire-key traps live here:
B2C uses ``InitiatorName`` + double-s ``Occassion``; TransactionStatus
uses ``Initiator`` + single-s ``Occasion``; Reversal keeps Safaricom's
misspelled ``RecieverIdentifierType`` (default "11"). All four carry a
SecurityCredential: never repr()/str() them for logs -- redact first.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .enums import RECEIVER_IDENTIFIER_ORG, CommandID
from .requests_sync import (
    _amount_int,
    _clean,
    _enum_value,
    _max_len,
    _phone,
    _require,
    _url,
)

__all__ = [
    "B2CPayoutRequest",
    "TransactionStatusRequest",
    "ReversalRequest",
    "AccountBalanceRequest",
]

_B2C_COMMANDS = {CommandID.SALARY_PAYMENT.value, CommandID.BUSINESS_PAYMENT.value,
                 CommandID.PROMOTION_PAYMENT.value}


@dataclass
class B2CPayoutRequest:
    """B2C payout to a customer MSISDN (docs/apis/b2c.md). Amount must be
    within [10, 250000] KES; PartyB is normalized in place. Usage::

        req = B2CPayoutRequest(initiator_name="testapi",
                               security_credential=cred,
                               command_id=CommandID.BUSINESS_PAYMENT,
                               amount=10, party_a="600992",
                               party_b="+254705912645", remarks="payout",
                               queue_time_out_url="https://x.com/t",
                               result_url="https://x.com/r")
        req.validate()
    """

    originator_conversation_id: str = ""
    initiator_name: str = ""
    security_credential: str = ""
    command_id: CommandID | str | None = None
    amount: int = 0
    party_a: str = ""
    party_b: str = ""
    remarks: str = ""
    queue_time_out_url: str = ""
    result_url: str = ""
    occassion: str = ""

    def validate(self) -> None:
        """Constraint parity with Go Validate(); normalizes PartyB."""
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
        _url("QueueTimeOutURL", self.queue_time_out_url)
        _url("ResultURL", self.result_url)

    def to_payload(self) -> dict[str, Any]:
        """Double-s ``Occassion`` and ``InitiatorName`` -- official spellings."""
        return _clean({
            "OriginatorConversationID": self.originator_conversation_id,
            "InitiatorName": self.initiator_name,
            "SecurityCredential": self.security_credential,
            "CommandID": _enum_value(self.command_id) or "",
            "Amount": self.amount,
            "PartyA": self.party_a,
            "PartyB": self.party_b,
            "Remarks": self.remarks,
            "QueueTimeOutURL": self.queue_time_out_url,
            "ResultURL": self.result_url,
            "Occassion": self.occassion,
        })


@dataclass
class TransactionStatusRequest:
    """Query by receipt XOR original conversation ID (docs/apis/transaction-status.md).
    Exactly one identifier may be set; CommandID defaults client-side."""

    initiator: str = ""
    security_credential: str = ""
    command_id: CommandID | str | None = None
    transaction_id: str = ""
    original_conversation_id: str = ""
    party_a: str = ""
    identifier_type: str = ""
    result_url: str = ""
    queue_time_out_url: str = ""
    remarks: str = ""
    occasion: str = ""  # single-s on this endpoint!

    def validate(self) -> None:
        if not self.transaction_id and not self.original_conversation_id:
            raise ValueError(
                "mpesa: exactly one of TransactionID or OriginalConversationID is required"
            )
        if self.transaction_id and self.original_conversation_id:
            raise ValueError(
                "mpesa: exactly one of TransactionID or OriginalConversationID "
                "must be set, got both"
            )
        cmd = _enum_value(self.command_id)
        if cmd and cmd != CommandID.TX_STATUS_QUERY.value:
            raise ValueError("mpesa: TransactionStatus CommandID must be TransactionStatusQuery")
        _require("Initiator", self.initiator)
        _require("SecurityCredential", self.security_credential)
        _require("PartyA", self.party_a)
        n = len(self.remarks.strip())
        if not 1 <= n <= 100:
            raise ValueError(f"mpesa: Remarks must be 1-100 characters, got {n}")
        _url("ResultURL", self.result_url)
        _url("QueueTimeOutURL", self.queue_time_out_url)

    def to_payload(self) -> dict[str, Any]:
        return _clean({
            "Initiator": self.initiator,
            "SecurityCredential": self.security_credential,
            "CommandID": _enum_value(self.command_id) or "",
            "TransactionID": self.transaction_id,
            "OriginalConversationID": self.original_conversation_id,
            "PartyA": self.party_a,
            "IdentifierType": self.identifier_type,
            "ResultURL": self.result_url,
            "QueueTimeOutURL": self.queue_time_out_url,
            "Occasion": self.occasion,
        })


@dataclass
class ReversalRequest:
    """Reverse a recent C2B transaction (docs/apis/reversal.md).
    Wire key stays misspelled ``RecieverIdentifierType``; payload defaults
    it to ``"11"`` when unset -- explicit overrides are honored verbatim."""

    initiator: str = ""
    security_credential: str = ""
    command_id: CommandID | str | None = None
    transaction_id: str = ""
    amount: int = 0
    receiver_party: str = ""
    receiver_identifier_type: str | None = None
    result_url: str = ""
    queue_time_out_url: str = ""
    remarks: str = ""

    def validate(self) -> None:
        cmd = _enum_value(self.command_id)
        if cmd and cmd != CommandID.REVERSAL.value:
            raise ValueError("mpesa: Reversal CommandID must be TransactionReversal")
        _require("Initiator", self.initiator)
        _require("SecurityCredential", self.security_credential)
        _require("TransactionID", self.transaction_id)
        amount = _amount_int("Reversal Amount", self.amount)
        if amount <= 0:
            raise ValueError(f"mpesa: Reversal Amount must be positive, got {amount}")
        _require("ReceiverParty", self.receiver_party)
        n = len(self.remarks.strip())
        if not 2 <= n <= 100:
            raise ValueError(f"mpesa: Reversal Remarks must be 2-100 characters, got {n}")
        _url("ResultURL", self.result_url)
        _url("QueueTimeOutURL", self.queue_time_out_url)

    def to_payload(self) -> dict[str, Any]:
        return {
            "Initiator": self.initiator,
            "SecurityCredential": self.security_credential,
            "CommandID": _enum_value(self.command_id) or "",
            "TransactionID": self.transaction_id,
            "Amount": self.amount,
            "ReceiverParty": self.receiver_party,
            "RecieverIdentifierType": self.receiver_identifier_type
            or RECEIVER_IDENTIFIER_ORG,
            "ResultURL": self.result_url,
            "QueueTimeOutURL": self.queue_time_out_url,
            "Remarks": self.remarks,
        }


@dataclass
class AccountBalanceRequest:
    """Organization balance query (docs/apis/account-balance.md); async Result
    callback carries the segment string parsed elsewhere."""

    initiator: str = ""
    security_credential: str = ""
    command_id: CommandID | str | None = None
    party_a: str = ""
    identifier_type: str = ""
    remarks: str = ""
    queue_time_out_url: str = ""
    result_url: str = ""

    def validate(self) -> None:
        cmd = _enum_value(self.command_id)
        if cmd and cmd != CommandID.ACCOUNT_BALANCE.value:
            raise ValueError("mpesa: AccountBalance CommandID must be AccountBalance")
        _require("Initiator", self.initiator)
        _require("SecurityCredential", self.security_credential)
        _require("PartyA", self.party_a)
        n = len(self.remarks.strip())
        if not 1 <= n <= 100:
            raise ValueError(f"mpesa: Remarks must be 1-100 characters, got {n}")
        _url("QueueTimeOutURL", self.queue_time_out_url)
        _url("ResultURL", self.result_url)

    def to_payload(self) -> dict[str, Any]:
        return _clean({
            "Initiator": self.initiator,
            "SecurityCredential": self.security_credential,
            "CommandID": _enum_value(self.command_id) or "",
            "PartyA": self.party_a,
            "IdentifierType": self.identifier_type,
            "Remarks": self.remarks,
            "QueueTimeOutURL": self.queue_time_out_url,
            "ResultURL": self.result_url,
        })
