"""Synchronous acknowledgement payloads (mirrors go/responses.go).

Every model here is the INSTANT reply of an endpoint -- none confirms
money moved (settle via callbacks/classification). Build via
``Model.from_json(raw)`` (dict, JSON str or raw bytes); decoding is
lenient about TYPES (Safaricom flips str/int encodings) but loud about
SHAPE (missing wire key raises ValueError naming it -- never KeyError).
See docs/apis/<endpoint>.md per class.

Divergences from go/responses.go, deliberate and documented:
* ``OAuthToken`` is PUBLIC here (Go keeps its token struct unexported);
  field renamed ``expires_in`` -> ``expires_in_seconds`` (unit explicit).
* Missing wire keys RAISE here; Go zero-fills silently, hiding gateway
  contract drift -- ours surfaces it.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, ClassVar, TypeVar

from .coercion import coerce_int, coerce_str, safe_json_int

__all__ = ["STKPushResponse", "STKQueryResponse", "ConversationResponse",
           "B2CResponse", "C2BAckResponse", "QRCodeResponse", "OAuthToken"]

_R = TypeVar("_R", bound="_Response")

_MAX_BODY_CHARS = 1_048_576


@dataclass(frozen=True)
class _Response:
    """Shared fail-safe decoder; subclasses declare ``_WIRE``/``_COERCE``."""

    _WIRE: ClassVar[dict[str, str]] = {}
    _COERCE: ClassVar[dict[str, Any]] = {}

    @classmethod
    def from_json(cls: type[_R], data: "dict | bytes | str") -> _R:
        if isinstance(data, (bytes, bytearray)):
            data = data.decode("utf-8", errors="replace")
        if isinstance(data, str):
            if len(data) > _MAX_BODY_CHARS:
                raise ValueError(
                    f"mpesa: {cls.__name__} response exceeds "
                    f"{_MAX_BODY_CHARS} bytes")
            try:
                data = json.loads(data, parse_int=safe_json_int)
            except json.JSONDecodeError as exc:
                raise ValueError(f"mpesa: unparseable {cls.__name__} body "
                                 f"({exc.msg} at position {exc.pos})") from None
            except RecursionError:
                raise ValueError(
                    f"mpesa: unparseable {cls.__name__} body "
                    "(RecursionError)") from None
        if not isinstance(data, dict):
            raise ValueError(
                f"mpesa: unexpected {cls.__name__} response shape: "
                "expected a JSON object")
        kwargs: dict[str, Any] = {}
        missing = [key for attr, key in cls._WIRE.items() if key not in data]
        if missing:
            raise ValueError(
                f"mpesa: unexpected {cls.__name__} response shape: "
                f"missing {', '.join(missing)}")
        for attr, key in cls._WIRE.items():
            value = data[key]
            if isinstance(value, int) and not isinstance(value, bool) \
                    and abs(value) > 2 ** 53:
                value = None  # unbounded magnitude -> explicit absence
            kwargs[attr] = cls._COERCE[attr](value) if attr in cls._COERCE \
                else (coerce_str(value) or "")
        return cls(**kwargs)


@dataclass(frozen=True)
class STKPushResponse(_Response):
    """Sync ack of POST /mpesa/stkpush/v1/processrequest.

    ACCEPTED IS NOT PAID: ``response_code == "0"`` only means Safaricom
    took the request -- settle exclusively via callback or STK Query;
    persist ``checkout_request_id`` as the dedup/join key.
    Example::

        resp = STKPushResponse.from_json(body)
        if resp.is_accepted:
            order.attach(checkout_request_id=resp.checkout_request_id)

    See docs/apis/stk-push.md. Wire keys: MerchantRequestID,
    CheckoutRequestID, ResponseCode, ResponseDescription, CustomerMessage.
    """

    merchant_request_id: str = ""
    checkout_request_id: str = ""
    response_code: str = ""
    response_description: str = ""
    customer_message: str = ""

    _WIRE = {
        "merchant_request_id": "MerchantRequestID",
        "checkout_request_id": "CheckoutRequestID",
        "response_code": "ResponseCode",
        "response_description": "ResponseDescription",
        "customer_message": "CustomerMessage",
    }

    @property
    def is_accepted(self) -> bool:
        """True iff ResponseCode "0" -- acceptance, NEVER payment."""
        return self.response_code == "0"


@dataclass(frozen=True)
class STKQueryResponse(_Response):
    """Reply of POST /mpesa/stkpushquery/v1/query (docs/apis/stk-query.md):
    carries ack AND outcome; ``result_code`` is normalized to str
    because captures flip between "1032" and 1032.

    Example::

        resp = STKQueryResponse.from_json(raw)
        classify_result_code(resp.result_code)  # -> ResultClass.FAILURE
    """

    response_code: str = ""
    response_description: str = ""
    merchant_request_id: str = ""
    checkout_request_id: str = ""
    result_code: str = ""
    result_desc: str = ""

    _WIRE = {
        "response_code": "ResponseCode",
        "response_description": "ResponseDescription",
        "merchant_request_id": "MerchantRequestID",
        "checkout_request_id": "CheckoutRequestID",
        "result_code": "ResultCode",
        "result_desc": "ResultDesc",
    }
    _COERCE = {"result_code": lambda v: coerce_str(v) or ""}


@dataclass(frozen=True)
class ConversationResponse(_Response):
    """Shared sync ACK of the async APIs -- B2C/TxStatus/Reversal/Balance
    (docs/apis/b2c.md et al.). Usage::

        ack = ConversationResponse.from_json(raw)
        enqueue_poll(ack.originator_conversation_id)
    """

    originator_conversation_id: str = ""
    conversation_id: str = ""
    response_code: str = ""
    response_description: str = ""

    _WIRE = {
        "originator_conversation_id": "OriginatorConversationID",
        "conversation_id": "ConversationID",
        "response_code": "ResponseCode",
        "response_description": "ResponseDescription",
    }


B2CResponse = ConversationResponse
"""Alias: B2C payouts return this exact ACK shape (go type parity).

Usage::

    ack = B2CResponse.from_json(raw)
See docs/apis/b2c.md for the full payout flow.
"""


@dataclass(frozen=True)
class C2BAckResponse(_Response):
    """ACK of C2B URL registration (docs/apis/c2b.md).

    WIRE TRAPS, both loud: Safaricom MISSPELLS the key as
    ``OriginatorCoversationID`` (single 's' in Coversation -- we accept
    ONLY their spelling so typos fail fast), and there is NO
    ``ConversationID`` field at all.

    Example::

        ack = C2BAckResponse.from_json(raw); assert ack.response_code == "0"
    """

    originator_conversation_id: str = ""
    response_code: str = ""
    response_description: str = ""

    _WIRE = {
        "originator_conversation_id": "OriginatorCoversationID",  # sic!
        "response_code": "ResponseCode",
        "response_description": "ResponseDescription",
    }


@dataclass(frozen=True)
class QRCodeResponse(_Response):
    """Dynamic-QR generation reply (docs/apis/dynamic-qr.md).

    DO NOT treat ``response_code`` as status: on this endpoint it is an
    OPAQUE alphanumeric tracking string (e.g. "AG_20191219_000043f...")
    preserved verbatim here. Usage::

        qr = QRCodeResponse.from_json(raw)
        render(qr.qr_code)
    """

    response_code: str = ""
    request_id: str = ""
    response_description: str = ""
    qr_code: str = ""

    _WIRE = {
        "response_code": "ResponseCode",
        "request_id": "RequestID",
        "response_description": "ResponseDescription",
        "qr_code": "QRCode",
    }


@dataclass(frozen=True)
class OAuthToken(_Response):
    """Payload of GET /oauth/v1/generate (docs/apis/oauth.md);
    ``expires_in_seconds`` coerces the observed "3599"/3599 shapes --
    None means TTL unknown, so refresh defensively. Usage::

        token = OAuthToken.from_json(raw)
        cache(token.access_token, ttl=token.expires_in_seconds)
    """

    access_token: str = ""
    expires_in_seconds: int | None = None

    _WIRE = {"access_token": "access_token", "expires_in_seconds": "expires_in"}
    _COERCE = {"access_token": str, "expires_in_seconds": coerce_int}

    def __repr__(self) -> str:
        """Credential-safe: token length only, never the value."""
        token = f"<redacted {len(self.access_token)}ch>"
        return (f"OAuthToken(access_token={token}, "
                f"expires_in_seconds={self.expires_in_seconds!r})")
