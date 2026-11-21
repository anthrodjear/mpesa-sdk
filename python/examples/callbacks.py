"""Callback parsing example using the M-Pesa Daraja SDK: STK callbacks via
StkCallbackResult.from_json, async Result envelopes via AsyncResult.from_json.

Run:

    export MPESA_CONSUMER_KEY=... MPESA_CONSUMER_SECRET=... MPESA_SHORTCODE=... \
           MPESA_PASSKEY=...
    # optional: MPESA_ENVIRONMENT=sandbox|production
    python examples/callbacks.py
"""
from __future__ import annotations

import os
import sys

from mpesa import (
    AsyncResult,
    Config,
    Environment,
    MpesaClient,
    MpesaError,
    ResultClass,
    STKQueryRequest,
    StkCallbackResult,
)

# Illustrative captures. In a real handler, cap the POST body in your web
# framework (>= 1 MiB) BEFORE calling from_json.
STK_CALLBACK = """{"Body":{"stkCallback":{
  "MerchantRequestID":"29115-34620561-1",
  "CheckoutRequestID":"ws_CO_191220191020363925",
  "ResultCode":0,"ResultDesc":"success",
  "CallbackMetadata":{"Item":[
    {"Name":"Amount","Value":100},
    {"Name":"MpesaReceiptNumber","Value":"NLJ7RT61SV"}]}}}}"""

ASYNC_RESULT = """{"Result":{
  "ResultType":0,"ResultCode":0,"ResultDesc":"success",
  "OriginatorConversationID":"a1b2c3d4e5f6a7b8",
  "ConversationID":"AG_20200101_00001abc","TransactionID":"NLJ7RT61SV",
  "ResultParameters":{"ResultParameter":[
    {"Key":"TransactionReceipt","Value":"NLJ7RT61SV"}]}}}"""


def main() -> None:
    try:
        cfg = Config(
            consumer_key=os.environ["MPESA_CONSUMER_KEY"],
            consumer_secret=os.environ["MPESA_CONSUMER_SECRET"],
            shortcode=os.environ["MPESA_SHORTCODE"],
            passkey=os.environ["MPESA_PASSKEY"],  # required by stk_query
            environment=Environment.from_config(os.environ.get("MPESA_ENVIRONMENT")),
            timeout_seconds=30.0,
        )
        client = MpesaClient(cfg)
    except KeyError as exc:
        print(f"\n✗ missing env var {exc} — check MPESA_* configuration", file=sys.stderr)
        sys.exit(1)

    try:
        # 1. STK callback. UNSIGNED; metadata is ADVISORY. Binding on
        #    checkout_request_id is a dedup control, not authentication.
        result = StkCallbackResult.from_json(STK_CALLBACK)
        print(f"CheckoutRequestID: {result.checkout_request_id} code={result.result_code}")
        print(f"Advisory metadata: amount={result.amount()} receipt={result.mpesa_receipt()}")
        print(f"Class: {result.classify().name} duplicates={result.duplicate_keys()}")

        # 2. SETTLE ONLY BY QUERY: stk_query result_code "0" bound to YOUR
        #    stored checkout_request_id record. Never settle on a callback.
        query = client.stk_query(STKQueryRequest(
            checkout_request_id=result.checkout_request_id,
        ))
        if query.result_code == "0":
            print("✓ Query confirms payment — settle now.")
        else:
            print(f"✗ Not settled ({query.result_code}): {query.result_desc}")

        # 3. Async Result (B2C / TxStatus / Reversal / Balance). Also UNSIGNED.
        #    Bind on originator_conversation_id; settle only on "0".
        async_result = AsyncResult.from_json(ASYNC_RESULT)
        print(f"Async Result: code={async_result.result_code} "
              f"conv={async_result.originator_conversation_id} "
              f"receipt={async_result.transaction_receipt()} "
              f"class={async_result.classify().name}")
        if async_result.classify() is ResultClass.INDETERMINATE:
            print("INDETERMINATE — keep reconciling; never auto-refund.")

    except (MpesaError, ValueError, KeyError) as exc:
        print(f"\n✗ callback example failed: {exc}", file=sys.stderr)
        sys.exit(1)
    finally:
        client.close()


if __name__ == "__main__":
    main()
