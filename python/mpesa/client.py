"""Concurrency-safe Daraja transport (mirrors go/client.go).

Create one :class:`MpesaClient` per environment and share it -- the
OAuth cache inside :class:`mpesa.auth.TokenManager` is guarded and
generation-aware. Every outbound call refuses redirects ALWAYS (Daraja
never legitimately redirects; following 307/308 would replay request
bodies against an arbitrary Location host), caps reads at 1 MiB, and
retries exactly once on ``401.003.01`` under the generation guard.

Example::

    cfg = Config(consumer_key=..., consumer_secret=..., shortcode="174379",
                 passkey="...", environment=Environment.SANDBOX)
    client = MpesaClient(cfg)
    resp = client.stk_push(STKPushRequest(...))
"""

from __future__ import annotations

import copy
from datetime import datetime, timezone
from typing import Any

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
_MAX_RESPONSE_CHARS = 1_048_576


class _OAuthOnlySession:
    """Thin read-only view over the client session that injects
    ``allow_redirects=False`` into TokenManager's OAuth GETs (the token
    manager itself stays transport-agnostic)."""

    def __init__(self, session: Any) -> None:
        self._session = session

    def get(self, url: str, **kwargs: Any) -> Any:
        kwargs["allow_redirects"] = False
        return self._session.get(url, **kwargs)


class MpesaClient:
    """Daraja API engine bound to one :class:`~mpesa.config.Config`.

    The injected ``http_client`` (if any) is SHALLOW-cloned -- headers
    and adapters are copied, the caller's object is never mutated -- and
    the clone is forced to ``verify=True`` per the config.py contract.
    Credentials are not required until the first call surfaces them via
    the token manager (go/client.go K4 parity).
    """

    def __init__(self, config: Config) -> None:
        self._cfg = config
        self._base_url = config.environment.base_url.rstrip("/")
        source = config.http_client
        self._session = (copy.copy(source) if source is not None
                         else requests.Session())
        self._session.verify = True  # forced on OUR clone only
        self._tokens = TokenManager(
            _OAuthOnlySession(self._session), base_url=self._base_url,
            consumer_key=config.consumer_key,
            consumer_secret=config.consumer_secret,
            now=config.now, timeout=config.timeout_seconds)

    def __repr__(self) -> str:
        """Credential-safe rendering (never secrets/token)."""
        return (f"MpesaClient(environment={self._cfg.environment.name}, "
                f"timeout_seconds={self._cfg.timeout_seconds!r})")

    # ---- transport --------------------------------------------------------

    def _now(self) -> datetime:
        return (self._cfg.now or (lambda: datetime.now(timezone.utc)))()

    def _send(self, token: str, method: str, path: str,
              json_body: Any, params: Any) -> requests.Response:
        return self._session.request(
            method, self._base_url + path, json=json_body, params=params,
            timeout=self._cfg.timeout_seconds, allow_redirects=False,
            headers={"Authorization": f"Bearer {token}",
                     "Content-Type": "application/json"})

    def _post_model(self, path: str, payload: dict, model: type):
        """Authenticated POST -> parsed sync-response model, with the
        documented retry-once on 401.003.01."""
        token, gen = self._tokens.get_token_with_gen()
        response = self._send(token, "POST", path, payload, None)
        if response.status_code == 401:
            probe = MpesaError.from_response(401, response.content)
            if probe.error_code == _ERR_INVALID_TOKEN:
                fresh = self._tokens.refresh_after_invalid_token(gen)
                response = self._send(fresh, "POST", path, payload, None)
        self._guard(response, path)
        return model.from_json(response.content)

    @staticmethod
    def _guard(response: requests.Response, path: str) -> None:
        if len(response.content) > _MAX_RESPONSE_CHARS:
            raise ValueError(
                f"mpesa: {path} response exceeds {_MAX_RESPONSE_CHARS} bytes")
        if not 200 <= response.status_code <= 299:
            raise MpesaError.from_response(
                response.status_code, response.content)

    # ---- endpoints --------------------------------------------------------

    def stk_push(self, req: STKPushRequest) -> STKPushResponse:
        """Send a payment prompt (docs/apis/stk-push.md). Password and
        Timestamp derive from ONE shared EAT instant and bind to the
        shortcode ACTUALLY sent. Injected defaults: BusinessShortCode and
        PartyB <- cfg.shortcode when empty.

        Example::

            resp = client.stk_push(STKPushRequest(
                transaction_type=TransactionType.CUSTOMER_PAY_BILL_ONLINE,
                amount=1, party_a="0722000000", phone_number="0722000000",
                call_back_url="https://x.com/cb",
                account_reference="Order001", transaction_desc="pay"))
        """
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
        req.validate()
        password, timestamp = generate_password(
            effective, self._cfg.passkey, self._now())
        payload = {"BusinessShortCode": effective, "Password": password,
                   "Timestamp": timestamp,
                   "CheckoutRequestID": req.checkout_request_id}
        return self._post_model(STK_QUERY_PATH, payload, STKQueryResponse)

    def b2c_payout(self, req: B2CPayoutRequest) -> B2CResponse:
        """Async payout to a customer MSISDN (docs/apis/b2c.md). Injected:
        OriginatorConversationID <- new_originator_id() when empty;
        PartyA <- cfg.shortcode when empty.

        Example::

            ack = client.b2c_payout(B2CPayoutRequest(
                initiator_name="testapi", security_credential=cred,
                command_id=CommandID.BUSINESS_PAYMENT, amount=10,
                party_b="+254705912645", remarks="payout",
                queue_time_out_url=u1, result_url=u2))
        """
        if not req.originator_conversation_id:
            req.originator_conversation_id = new_originator_id()
        if not req.party_a:
            req.party_a = self._cfg.shortcode
        req.validate()
        return self._post_model(B2C_PATH, req.to_payload(), B2CResponse)

    def transaction_status(
            self, req: TransactionStatusRequest) -> ConversationResponse:
        """Query by receipt XOR conversation ID
        (docs/apis/transaction-status.md). Defaults: CommandID <-
        TX_STATUS_QUERY, IdentifierType <- "4".

        Example::

            ack = client.transaction_status(TransactionStatusRequest(
                initiator="testapi", security_credential=cred,
                transaction_id="NLJ7RT61SV", party_a="600992",
                remarks="status", result_url=u1, queue_time_out_url=u2))
        """
        if req.command_id is None:
            req.command_id = CommandID.TX_STATUS_QUERY
        if not req.identifier_type:
            req.identifier_type = "4"
        req.validate()
        return self._post_model(TX_STATUS_PATH, req.to_payload(),
                                ConversationResponse)

    def reversal(self, req: ReversalRequest) -> ConversationResponse:
        """Reverse a recent C2B transaction (docs/apis/reversal.md);
        C2B ONLY -- B2C payouts cannot be reversed here. Defaults:
        CommandID <- REVERSAL, receiver_identifier_type handled at
        payload time ("11").

        Example::

            ack = client.reversal(ReversalRequest(
                initiator="testapi", security_credential=cred,
                transaction_id="NLJ7RT61SV", amount=10,
                receiver_party="600992", remarks="duplicate charge",
                result_url=u1, queue_time_out_url=u2))
        """
        if req.command_id is None:
            req.command_id = CommandID.REVERSAL
        req.validate()
        return self._post_model(REVERSAL_PATH, req.to_payload(),
                                ConversationResponse)

    def account_balance(
            self, req: AccountBalanceRequest) -> ConversationResponse:
        """Query organization balances (docs/apis/account-balance.md).
        Defaults: CommandID <- ACCOUNT_BALANCE, IdentifierType <- "4".

        Example::

            ack = client.account_balance(AccountBalanceRequest(
                initiator="testapi", security_credential=cred,
                party_a="600992", remarks="balance check",
                result_url=u1, queue_time_out_url=u2))
        """
        if req.command_id is None:
            req.command_id = CommandID.ACCOUNT_BALANCE
        if not req.identifier_type:
            req.identifier_type = "4"
        req.validate()
        return self._post_model(ACCOUNT_BALANCE_PATH, req.to_payload(),
                                ConversationResponse)

    def c2b_register_url(self, req: C2BRegisterRequest) -> C2BAckResponse:
        """Register validation/confirmation URLs, v2 (docs/apis/c2b.md);
        production registration is effectively one-shot. ShortCode <-
        cfg.shortcode when empty.

        Example::

            ack = client.c2b_register_url(C2BRegisterRequest(
                response_type=ResponseType.COMPLETED,
                confirmation_url="https://a.com/confirm",
                validation_url="https://a.com/validate"))
        """
        if not req.short_code:
            req.short_code = self._cfg.shortcode
        req.validate()
        return self._post_model(C2B_REGISTER_PATH, req.to_payload(),
                                C2BAckResponse)

    def c2b_simulate(self, req: C2BSimulateRequest) -> C2BAckResponse:
        """Fake an inbound payment -- SANDBOX ONLY (docs/apis/c2b.md).
        ShortCode <- cfg.shortcode when empty.

        Example::

            ack = client.c2b_simulate(C2BSimulateRequest(
                command_id=CommandID.C2B_PAYBILL_ONLINE, amount=10,
                msisdn="0712345678", bill_ref_number="acct-1"))
        """
        if not req.short_code:
            req.short_code = self._cfg.shortcode
        req.validate()
        return self._post_model(C2B_SIMULATE_PATH, req.to_payload(),
                                C2BAckResponse)

    def generate_qr_code(self, req: QRCodeRequest) -> QRCodeResponse:
        """Create a dynamic QR image payload, fully synchronous
        (docs/apis/dynamic-qr.md).

        Example::

            qr = client.generate_qr_code(QRCodeRequest(
                merchant_name="TEST SUPERMARKET", ref_no="Invoice Test",
                amount=1, trx_code=QRTrxCode.BUY_GOODS,
                cpi="174379", size="300"))
        """
        req.validate()
        return self._post_model(QR_CODE_PATH, req.to_payload(),
                                QRCodeResponse)
