"""Sync response models -- compatibility facade over :mod:`mpesa.responses`.

Mirrors go/responses.go. The canonical implementations live in
:mod:`mpesa.responses` (STKPushResponse, STKQueryResponse,
ConversationResponse/B2CResponse, C2BAckResponse, QRCodeResponse,
OAuthToken) with lenient ``from_json`` decoding: dict/bytes/str input,
1_048_576-char cap, loud missing-key errors naming EVERY absent wire
key, hostile values coerced, only ValueError ever raised.

This module exists so import paths named after the Go file keep working;
it intentionally contains NO duplicated logic. See docs/apis/<endpoint>.md
per class in :mod:`mpesa.responses`.

Giant JSON integers are handled canonically: json.loads uses
parse_int=safe_json_int, and |int| > 2**53 is nulled before coercion.
"""

from .responses import (
    B2CResponse,
    C2BAckResponse,
    ConversationResponse,
    OAuthToken,
    QRCodeResponse,
    STKPushResponse,
    STKQueryResponse,
)

__all__ = ["STKPushResponse", "STKQueryResponse", "ConversationResponse",
           "B2CResponse", "C2BAckResponse", "QRCodeResponse", "OAuthToken"]
