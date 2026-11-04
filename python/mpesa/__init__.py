"""M-Pesa Daraja SDK -- public API surface.

Covers all twelve business endpoints of the Safaricom Daraja platform
(STK Push/Query, B2B payout, B2C payout, Tax Remittance, Transaction
Status, Reversal, Account Balance, C2B register/simulate, Dynamic QR,
Bill Manager register/query/update/delete -- contracts in docs/apis/).
Quickstart (credentials via env vars, per client.py convention)::

    import os
    from mpesa import Config, Environment, MpesaClient
    from mpesa.requests_sync import STKPushRequest
    from mpesa.enums import TransactionType

    cfg = Config(consumer_key=os.environ["MPESA_CONSUMER_KEY"],
                 consumer_secret=os.environ["MPESA_CONSUMER_SECRET"],
                 shortcode=os.environ["MPESA_SHORTCODE"],
                 passkey=os.environ["MPESA_PASSKEY"],
                 environment=Environment.from_config(
                     os.environ.get("MPESA_ENVIRONMENT")))
    client = MpesaClient(cfg)
    resp = client.stk_push(STKPushRequest(...))

Safety notes: INDETERMINATE results may still settle minutes later --
never auto-fail/auto-refund them; callbacks are UNSIGNED -- settle only
via stk_query bound to YOUR CheckoutRequestID record (binding dedups
duplicate deliveries, it does not authenticate origin); secrets/tokens
are redacted from every repr.
"""

from .auth import TokenManager
from .callback_token import callback_token_equal, new_callback_token
from .callbacks import MetadataItem, StkCallbackResult
from .classification import ResultClass, classify_result_code
from .client import MpesaClient
from .config import Config
from .enums import (
    ORGANIZATION_SHORTCODE,
    RECEIVER_IDENTIFIER_ORG,
    CommandID,
    Environment,
    QRTrxCode,
    ResponseType,
    TransactionType,
)
from .exceptions import InvalidTokenError, MpesaError, RefreshRateLimitedError
from .helpers import generate_password, normalize_phone, security_credential
from .limits import DEFAULT_TRANSACTION_LIMITS, ServiceLimits, TransactionLimits
from .requests_async import (
    AccountBalanceRequest,
    B2BRequest,
    B2CPayoutRequest,
    ReversalRequest,
    TaxRemittanceRequest,
    TransactionStatusRequest,
)
from .requests_sync import (
    BillDeleteRequest,
    BillQueryRequest,
    BillRegisterRequest,
    BillUpdateRequest,
    C2BRegisterRequest,
    C2BSimulateRequest,
    QRCodeRequest,
    STKPushRequest,
    STKQueryRequest,
)
from .responses import (
    B2CResponse,
    BillAckResponse,
    C2BAckResponse,
    ConversationResponse,
    OAuthToken,
    QRCodeResponse,
    STKPushResponse,
    STKQueryResponse,
)
from .results import AsyncResult, BalanceSegment, parse_balance_segments

__version__ = "0.7.1"

__all__ = [
    "AccountBalanceRequest",
    "AsyncResult",
    "B2BRequest",
    "B2CPayoutRequest",
    "B2CResponse",
    "BalanceSegment",
    "BillAckResponse",
    "BillDeleteRequest",
    "BillQueryRequest",
    "BillRegisterRequest",
    "BillUpdateRequest",
    "C2BAckResponse",
    "C2BRegisterRequest",
    "C2BSimulateRequest",
    "CommandID",
    "Config",
    "ConversationResponse",
    "DEFAULT_TRANSACTION_LIMITS",
    "Environment",
    "InvalidTokenError",
    "MetadataItem",
    "MpesaClient",
    "MpesaError",
    "OAuthToken",
    "ORGANIZATION_SHORTCODE",
    "QRCodeRequest",
    "QRCodeResponse",
    "QRTrxCode",
    "RECEIVER_IDENTIFIER_ORG",
    "RefreshRateLimitedError",
    "ResponseType",
    "ResultClass",
    "ReversalRequest",
    "STKPushRequest",
    "STKPushResponse",
    "STKQueryRequest",
    "STKQueryResponse",
    "ServiceLimits",
    "StkCallbackResult",
    "TaxRemittanceRequest",
    "TokenManager",
    "TransactionLimits",
    "TransactionStatusRequest",
    "TransactionType",
    "callback_token_equal",
    "classify_result_code",
    "generate_password",
    "new_callback_token",
    "normalize_phone",
    "parse_balance_segments",
    "security_credential",
]
