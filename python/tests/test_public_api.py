"""Tests for the mpesa public API surface (python/mpesa/__init__.py)."""

import importlib
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import mpesa  # noqa: E402


def test_every_all_name_importable_and_not_none():
    for name in mpesa.__all__:
        obj = getattr(mpesa, name)
        assert obj is not None, name


def test_all_is_sorted():
    assert mpesa.__all__ == sorted(mpesa.__all__)


def test_identity_with_source_modules():
    assert mpesa.MpesaClient is importlib.import_module("mpesa.client").MpesaClient
    assert mpesa.Config is importlib.import_module("mpesa.config").Config
    assert mpesa.TokenManager is importlib.import_module("mpesa.auth").TokenManager
    assert mpesa.MpesaError is importlib.import_module("mpesa.exceptions").MpesaError
    enums = importlib.import_module("mpesa.enums")
    for name in ("TransactionType", "CommandID", "ResponseType", "QRTrxCode",
                 "Environment"):
        assert getattr(mpesa, name) is getattr(enums, name)
    responses = importlib.import_module("mpesa.responses")
    for name in ("STKPushResponse", "STKQueryResponse",
                 "ConversationResponse", "B2CResponse", "C2BAckResponse",
                 "QRCodeResponse", "OAuthToken"):
        assert getattr(mpesa, name) is getattr(responses, name)
    requests_sync = importlib.import_module("mpesa.requests_sync")
    for name in ("STKPushRequest", "STKQueryRequest",
                 "C2BRegisterRequest", "C2BSimulateRequest", "QRCodeRequest"):
        assert getattr(mpesa, name) is getattr(requests_sync, name)
    requests_async = importlib.import_module("mpesa.requests_async")
    for name in ("B2CPayoutRequest", "TransactionStatusRequest",
                 "ReversalRequest", "AccountBalanceRequest"):
        assert getattr(mpesa, name) is getattr(requests_async, name)
    callbacks = importlib.import_module("mpesa.callbacks")
    assert mpesa.StkCallbackResult is callbacks.StkCallbackResult
    assert mpesa.MetadataItem is callbacks.MetadataItem
    results = importlib.import_module("mpesa.results")
    assert mpesa.AsyncResult is results.AsyncResult
    assert mpesa.BalanceSegment is results.BalanceSegment
    assert mpesa.parse_balance_segments is results.parse_balance_segments
    classification = importlib.import_module("mpesa.classification")
    assert mpesa.ResultClass is classification.ResultClass
    helpers = importlib.import_module("mpesa.helpers")
    for name in ("generate_password", "normalize_phone",
                 "security_credential"):
        assert getattr(mpesa, name) is getattr(helpers, name)
    assert mpesa.ORGANIZATION_SHORTCODE == enums.ORGANIZATION_SHORTCODE


def test_environment_from_config_reachable_via_class():
    # Usage note: Environment.from_config resolves MPESA_ENVIRONMENT keys.
    from mpesa.enums import Environment

    assert Environment.from_config("sandbox") is Environment.SANDBOX


def test_version_matches_setup_py():
    setup_text = Path(__file__).resolve().parents[1].joinpath(
        "setup.py").read_text(encoding="utf-8")
    match = re.search(r'version="([^"]+)"', setup_text)
    assert match and mpesa.__version__ == match.group(1)


def test_docstring_orients_new_developer():
    doc = (mpesa.__doc__ or "")
    for symbol in ("MpesaClient", "Config", "Environment.from_config",
                   "stk_push", "INDETERMINATE", "UNSIGNED", "redacted"):
        assert symbol in doc, symbol
