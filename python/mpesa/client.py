"""Concurrency-safe Daraja transport (mirrors go/client.go).

Create one :class:`MpesaClient` per environment and share it -- the
OAuth cache inside :class:`mpesa.auth.TokenManager` is synchronized and
generation-aware; share the Session per requests norms and do not
mutate config or session after first use.

Environment wiring from process env vars fulfils config.py's deferred
pointer::

    import os
    from mpesa.config import Config
    from mpesa.enums import Environment

    cfg = Config(
        consumer_key=os.environ["MPESA_CONSUMER_KEY"],
        consumer_secret=os.environ["MPESA_CONSUMER_SECRET"],
        shortcode=os.environ["MPESA_SHORTCODE"],
        passkey=os.environ["MPESA_PASSKEY"],
        environment=Environment.from_config(os.environ.get("MPESA_ENVIRONMENT")),
    )
    client = MpesaClient(cfg)

Requests are treated as VALUES: endpoint methods apply injected
defaults (shortcode/password/originator/identifiers) to an internal
``dataclasses.replace`` copy -- the caller's object is never mutated.
"""

from __future__ import annotations

import copy
import dataclasses
from datetime import datetime, timezone
from types import TracebackType
from typing import Any, TypeVar

import requests

from .auth import TokenManager
from .config import Config
from .enums import CommandID
from .exceptions import MpesaError
from .helpers import generate_password, new_originator_id
from .requests_async import (
    AccountBalanceRequest,
    B2CPayoutRequest,
    ReversalRequest,
    TransactionStatusRequest,
)
from .requests_sync import (
    C2BRegisterRequest,
    C2BSimulateRequest,
    QRCodeRequest,
    STKPushRequest,
    STKQueryRequest,
)
from .responses import (
    B2CResponse,
    C2BAckResponse,
    ConversationResponse,
    QRCodeResponse,
    STKPushResponse,
    STKQueryResponse,
)

__all__ = ["MpesaClient"]

STK_PUSH_PATH = "/mpesa/stkpush/v1/processrequest"
STK_QUERY_PATH = "/mpesa/stkpushquery/v1/query"
B2C_PATH = "/mpesa/b2c/v3/paymentrequest"
C2B_REGISTER_PATH = "/mpesa/c2b/v2/registerurl"
C2B_SIMULATE_PATH = "/mpesa/c2b/v2/simulate"
TX_STATUS_PATH = "/mpesa/transactionstatus/v1/query"
REVERSAL_PATH = "/mpesa/reversal/v1/request"
ACCOUNT_BALANCE_PATH = "/mpesa/accountbalance/v1/query"
QR_CODE_PATH = "/mpesa/qrcode/v1/generate"

_ERR_INVALID_TOKEN = "401.003.01"
_MAX_RESPONSE_BYTES = 1_048_576

_ModelT = TypeVar("_ModelT")


class _OAuthOnlySession:
    """Thin read-only view over the client session that injects
    ``allow_redirects=False`` into TokenManager's OAuth GETs."""

    def __init__(self, session: Any) -> None:
        self._session = session

    def get(self, url: str, **kwargs: Any) -> Any:
        kwargs["allow_redirects"] = False
        return self._session.get(url, **kwargs)


class MpesaClient:
    """Daraja API engine bound to one :class:`~mpesa.config.Config`.

    Trust boundary: an injected ``http_client`` is shallow-cloned --
    headers are snapshot-copied and adapters remounted -- so later
    mutations of the caller's objects stay invisible here; do not mutate
    them after first use either. The clone is forced ``verify=True``
    per the config.py contract. Concurrency: TokenManager is fully
    synchronized; share one Session per requests norms.
    """

    def __init__(self, config: Config) -> None:
        self._cfg = config
        self._base_url = config.environment.base_url.rstrip("/")
        source = config.http_client
        self._session = (copy.copy(source) if source is not None
                         else requests.Session())
        self._session.headers = dict(source.headers) if source is not None \
            else {}
        for prefix, adapter in dict(
                source.adapters if source is not None else {}).items():
            self._session.mount(prefix, adapter)
        self._session.verify = True  # forced on OUR clone only
        # Timeout clamp: non-positive values fall back to Go's 30s default.
        self._timeout = (config.timeout_seconds
                         if config.timeout_seconds > 0 else 30.0)
        self._tokens = TokenManager(
            _OAuthOnlySession(self._session), base_url=self._base_url,
            consumer_key=config.consumer_key,
            consumer_secret=config.consumer_secret,
            now=config.now, timeout=self._timeout)

    def __repr__(self) -> str:
        """Credential-safe rendering (never secrets/token)."""
        return (f"MpesaClient(environment={self._cfg.environment.name}, "
                f"timeout_seconds={self._timeout!r})")

    def close(self) -> None:
        """Release the underlying session's connection pool."""
        closer = getattr(self._session, "close", None)
        if callable(closer):
            closer()

    def __enter__(self) -> "MpesaClient":
        return self

    def __exit__(self, exc_type: type[BaseException] | None,
                 exc: BaseException | None,
                 tb: TracebackType | None) -> None:
        self.close()

    # ---- transport --------------------------------------------------------

    def _now(self) -> datetime:
        return (self._cfg.now or (lambda: datetime.now(timezone.utc)))()

    def _send(self, token: str, method: str, path: str,
              json_body: Any, params: Any) -> tuple[int, str, bytes]:
        """Authenticated round-trip returning ``(status_code,
        content_type, body)``.

        True streaming cap: reads at most _MAX_RESPONSE_BYTES+1 via
        iter_content (Go LimitReader parity). Plain values are returned
        instead of the Response because ``Response.content`` is a
        getter-only property -- writing it raises AttributeError on
        every real request (duck-typed fakes allowed attribute writes
        and masked the crash historically). The connection is released
        in ``finally``, so aborts mid-read never leak sockets.
        """
        response = self._session.request(
            method, self._base_url + path, json=json_body, params=params,
            timeout=self._timeout, allow_redirects=False, stream=True,
            headers={"Authorization": f"Bearer {token}",
                     "Content-Type": "application/json"})
        try:
            chunks: list[bytes] = []
            total = 0
            for chunk in response.iter_content(_MAX_RESPONSE_BYTES + 1):
                chunks.append(chunk)
                total += len(chunk)
                if total > _MAX_RESPONSE_BYTES:
                    raise ValueError(f"mpesa: {path} response exceeds "
                                     f"{_MAX_RESPONSE_BYTES} bytes")
            body = b"".join(chunks)
        finally:
            response.close()
        content_type = response.headers.get("content-type", "")
        return response.status_code, content_type, body

    def _post_model(self, path: str, payload: dict[str, Any],
                    model: type[_ModelT]) -> _ModelT:
        """Authenticated POST -> parsed sync-response model, consuming the
        ``(status_code, content_type, body)`` tuple from :meth:`_send`,
        with the documented retry-once on 401.003.01. Every size cap is
        enforced inside :meth:`_send` (the tuple body can never exceed
        the accumulation bound), so the 401 probe and final parse are
        size-capped by construction."""
        token, gen = self._tokens.get_token_with_gen()
        status_code, content_type, body = self._send(
            token, "POST", path, payload, None)
        if status_code == 401:
            probe = MpesaError.from_response(401, body, content_type)
            if probe.error_code == _ERR_INVALID_TOKEN:
                fresh = self._tokens.refresh_after_invalid_token(gen)
                status_code, content_type, body = self._send(
                    fresh, "POST", path, payload, None)
        if not 200 <= status_code <= 299:
            raise MpesaError.from_response(status_code, body, content_type)
        return model.from_json(body)

    # ---- endpoints --------------------------------------------------------

    def stk_push(self, req: STKPushRequest) -> STKPushResponse:
        """Send a payment prompt (docs/apis/stk-push.md); Password and
        Timestamp derive from ONE shared EAT instant bound to the
        shortcode ACTUALLY sent.

        Example::

            resp = client.stk_push(STKPushRequest(...))
        """
        req = dataclasses.replace(req)
        if not req.business_short_code:
            req.business_short_code = self._cfg.shortcode
        if not req.party_b:
            req.party_b = req.business_short_code
        req.validate()
        password, timestamp = generate_password(
            req.business_short_code, self._cfg.passkey, self._now())
        payload = {**req.to_payload(), "Password": password,
                   "Timestamp": timestamp}
        return self._post_model(STK_PUSH_PATH, payload, STKPushResponse)

    def stk_query(self, req: STKQueryRequest) -> STKQueryResponse:
        """Check a push outcome when callbacks are late
        (docs/apis/stk-query.md); Password binds to the EFFECTIVE
        shortcode either way.

        Example::

            resp = client.stk_query(STKQueryRequest(
                checkout_request_id="ws_CO_191220191020363925"))
        """
        effective = req.business_short_code or self._cfg.shortcode
        req = dataclasses.replace(req)
        req.validate()
        # Hand-built flat payload mirrors go/client.go stkQueryPayload:
        # BusinessShortCode participates in password derivation.
        password, timestamp = generate_password(
            effective, self._cfg.passkey, self._now())
        payload = {"BusinessShortCode": effective, "Password": password,
                   "Timestamp": timestamp,
                   "CheckoutRequestID": req.checkout_request_id}
        return self._post_model(STK_QUERY_PATH, payload, STKQueryResponse)

    def b2c_payout(self, req: B2CPayoutRequest) -> B2CResponse:
        """Async payout (docs/apis/b2c.md); OriginatorConversationID <-
        new_originator_id() and PartyA <- cfg.shortcode when empty.

        Example::

            ack = client.b2c_payout(B2CPayoutRequest(...))
        """
        req = dataclasses.replace(req)
        if not req.originator_conversation_id:
            req.originator_conversation_id = new_originator_id()
        if not req.party_a:
            req.party_a = self._cfg.shortcode
        req.validate()
        return self._post_model(B2C_PATH, req.to_payload(), B2CResponse)

    def transaction_status(
            self, req: TransactionStatusRequest) -> ConversationResponse:
        """Query by receipt XOR conversation ID
        (docs/apis/transaction-status.md); CommandID <- TX_STATUS_QUERY,
        IdentifierType <- "4" when unset.

        Example::

            ack = client.transaction_status(TransactionStatusRequest(...))
        """
        req = dataclasses.replace(req)
        if not req.command_id:
            req.command_id = CommandID.TX_STATUS_QUERY
        if not req.identifier_type:
            req.identifier_type = "4"
        req.validate()
        return self._post_model(TX_STATUS_PATH, req.to_payload(),
                                ConversationResponse)

    def reversal(self, req: ReversalRequest) -> ConversationResponse:
        """Reverse a recent C2B transaction -- C2B ONLY
        (docs/apis/reversal.md); CommandID <- REVERSAL when unset.

        Example::

            ack = client.reversal(ReversalRequest(...))
        """
        req = dataclasses.replace(req)
        if not req.command_id:
            req.command_id = CommandID.REVERSAL
        req.validate()
        return self._post_model(REVERSAL_PATH, req.to_payload(),
                                ConversationResponse)

    def account_balance(
            self, req: AccountBalanceRequest) -> ConversationResponse:
        """Query organization balances (docs/apis/account-balance.md);
        CommandID <- ACCOUNT_BALANCE, IdentifierType <- "4" when unset.

        Example::

            ack = client.account_balance(AccountBalanceRequest(...))
        """
        req = dataclasses.replace(req)
        if not req.command_id:
            req.command_id = CommandID.ACCOUNT_BALANCE
        if not req.identifier_type:
            req.identifier_type = "4"
        req.validate()
        return self._post_model(ACCOUNT_BALANCE_PATH, req.to_payload(),
                                ConversationResponse)

    def c2b_register_url(self, req: C2BRegisterRequest) -> C2BAckResponse:
        """Register validation/confirmation URLs, v2 -- effectively
        one-shot in production (docs/apis/c2b.md); ShortCode <- cfg.

        Example::

            ack = client.c2b_register_url(C2BRegisterRequest(...))
        """
        req = dataclasses.replace(req)
        if not req.short_code:
            req.short_code = self._cfg.shortcode
        req.validate()
        return self._post_model(C2B_REGISTER_PATH, req.to_payload(),
                                C2BAckResponse)

    def c2b_simulate(self, req: C2BSimulateRequest) -> C2BAckResponse:
        """Fake an inbound payment -- SANDBOX ONLY (docs/apis/c2b.md);
        ShortCode <- cfg.shortcode when empty.

        Example::

            ack = client.c2b_simulate(C2BSimulateRequest(...))
        """
        req = dataclasses.replace(req)
        if not req.short_code:
            req.short_code = self._cfg.shortcode
        req.validate()
        return self._post_model(C2B_SIMULATE_PATH, req.to_payload(),
                                C2BAckResponse)

    def generate_qr_code(self, req: QRCodeRequest) -> QRCodeResponse:
        """Create a dynamic QR payload, fully synchronous
        (docs/apis/dynamic-qr.md).

        Example::

            qr = client.generate_qr_code(QRCodeRequest(...))
        """
        req.validate()
        return self._post_model(QR_CODE_PATH, req.to_payload(),
                                QRCodeResponse)
