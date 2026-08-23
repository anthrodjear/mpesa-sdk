"""M-Pesa Daraja SDK -- public API surface.

Covers all nine business endpoints of the Safaricom Daraja platform
(STK Push/Query, B2C payout, Transaction Status, Reversal, Account
Balance, C2B register/simulate, Dynamic QR -- contracts in docs/apis/).
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
never auto-fail/auto-refund them; callbacks are UNSIGNED -- bind on
CheckoutRequestID against your own records; secrets/tokens are redacted
from every repr.
"""

from .auth import TokenManager
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
from .exceptions import MpesaError
from .helpers import generate_password, normalize_phone, security_credential
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
from .results import AsyncResult, BalanceSegment, parse_balance_segments
from .responses import (
    B2CResponse,
    C2BAckResponse,
    ConversationResponse,
    OAuthToken,
    QRCodeResponse,
    STKPushResponse,
    STKQueryResponse,
)

__version__ = "0.1.0"

__all__ = [
    "AccountBalanceRequest",
    "AsyncResult",
    "B2CPayoutRequest",
    "B2CResponse",
    "BalanceSegment",
    "C2BAckResponse",
    "C2BRegisterRequest",
    "C2BSimulateRequest",
    "CommandID",
    "Config",
    "ConversationResponse",
    "Environment",
    "MetadataItem",
    "MpesaClient",
    "MpesaError",
    "OAuthToken",
    "ORGANIZATION_SHORTCODE",
    "QRCodeRequest",
    "QRCodeResponse",
    "QRTrxCode",
    "RECEIVER_IDENTIFIER_ORG",
    "ResponseType",
    "ResultClass",
    "STKPushRequest",
    "STKPushResponse",
    "STKQueryRequest",
    "STKQueryResponse",
    "StkCallbackResult",
    "TokenManager",
    "TransactionStatusRequest",
    "TransactionType",
    "classify_result_code",
    "generate_password",
    "normalize_phone",
    "parse_balance_segments",
    "security_credential",
]
