"""STK Push example using the M-Pesa Daraja SDK.

Run:

    export MPESA_CONSUMER_KEY=... MPESA_CONSUMER_SECRET=... \\
           MPESA_SHORTCODE=... MPESA_PASSKEY=...
    python stk_push.py
"""
from __future__ import annotations

import os
import sys

from mpesa import (
    Config,
    MpesaClient,
    MpesaError,
    STKPushRequest,
    TransactionType,
)


def main() -> None:
    # 1. Build config from environment variables.
    cfg = Config(
        consumer_key=os.environ["MPESA_CONSUMER_KEY"],
        consumer_secret=os.environ["MPESA_CONSUMER_SECRET"],
        shortcode=os.environ["MPESA_SHORTCODE"],
        passkey=os.environ["MPESA_PASSKEY"],
    )

    # 2. Create a client (shares the underlying requests.Session).
    client = MpesaClient(cfg)

    try:
        # 3. Send the STK Push prompt.
        resp = client.stk_push(STKPushRequest(
            transaction_type=TransactionType.CUSTOMER_PAY_BILL_ONLINE,
            amount=100,
            party_a="254712345678",
            phone_number="254712345678",
            call_back_url="https://example.com/callback",
            account_reference="Order 42",
            transaction_desc="test payment",
        ))

        # 4. Check acceptance (response_code "0" = Daraja accepted the request).
        #    Accepted is NOT paid — settle only via callback or STK Query.
        print(f"MerchantRequestID:  {resp.merchant_request_id}")
        print(f"CheckoutRequestID:  {resp.checkout_request_id}")
        print(f"ResponseCode:       {resp.response_code}")
        print(f"CustomerMessage:    {resp.customer_message}")

        if resp.is_accepted:
            print("\n✓ Push accepted — wait for callback or query with stk_query.")
        else:
            print(f"\n✗ Push rejected (code {resp.response_code}): "
                  f"{resp.response_description}")

    except MpesaError as exc:
        print(f"\n✗ Daraja error: {exc}", file=sys.stderr)
        if exc.error_code:
            print(f"  errorCode:    {exc.error_code}", file=sys.stderr)
        if exc.request_id:
            print(f"  requestId:    {exc.request_id}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
