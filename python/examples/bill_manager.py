"""Bill Manager example: register → query → update → delete.

All four calls are synchronous and authenticated by the bearer token alone —
there is NO initiator or SecurityCredential on this API family.

Run:

    export MPESA_CONSUMER_KEY=... MPESA_CONSUMER_SECRET=... MPESA_SHORTCODE=...
    # optional: MPESA_ENVIRONMENT=sandbox|production
    python examples/bill_manager.py
"""
from __future__ import annotations

import os
import sys

from mpesa import (
    BillDeleteRequest,
    BillQueryRequest,
    BillRegisterRequest,
    BillUpdateRequest,
    Config,
    Environment,
    MpesaClient,
    MpesaError,
)


def main() -> None:
    try:
        cfg = Config(
            consumer_key=os.environ["MPESA_CONSUMER_KEY"],
            consumer_secret=os.environ["MPESA_CONSUMER_SECRET"],
            shortcode=os.environ["MPESA_SHORTCODE"],
            environment=Environment.from_config(os.environ.get("MPESA_ENVIRONMENT")),
            timeout_seconds=30.0,
        )
        client = MpesaClient(cfg)
    except KeyError as exc:
        print(f"\n✗ missing env var {exc} — check MPESA_* configuration", file=sys.stderr)
        sys.exit(1)
    shortcode = os.environ["MPESA_SHORTCODE"]
    ref = "INV-001"  # business reference, safe to log (not a secret)

    try:
        # 1. Register. Callback URLs may embed a capability token; request
        #    reprs redact them plus any payer PII.
        reg_req = BillRegisterRequest(
            short_code=shortcode,
            bill_ref_number=ref,
            bill_name="Invoice 001",
            amount=100,
            expiry_date="2030-12-31",
            call_back_url="https://example.com/bills/callback",
        )
        print(f"register (repr redacted): {reg_req!r}")
        ack = client.bill_register(reg_req)
        print(f"registered: code={ack.response_code}")

        # 2. Query. bill_ref_number on the ACK is optional — identify the bill
        #    by the reference YOU sent, not by the echo.
        ack = client.bill_query(BillQueryRequest(
            short_code=shortcode, bill_ref_number=ref,
        ))
        print(f"queried: code={ack.response_code}")

        # 3. Update. An omitted amount means "leave the amount alone" — a
        #    partial update moves no money.
        ack = client.bill_update(BillUpdateRequest(
            short_code=shortcode, bill_ref_number=ref, amount=150,
        ))
        print(f"updated: code={ack.response_code}")

        # 4. Delete.
        ack = client.bill_delete(BillDeleteRequest(
            short_code=shortcode, bill_ref_number=ref,
        ))
        print(f"deleted: code={ack.response_code}")

        # response_code "0" means the OPERATION was accepted, never that
        # money moved. Settlement is exclusively via the OperationResult
        # callback (unsigned — gate it and reconcile externally).

    except (MpesaError, ValueError, KeyError) as exc:
        print(f"\n✗ Bill Manager failed: {exc}", file=sys.stderr)
        sys.exit(1)
    finally:
        client.close()


if __name__ == "__main__":
    main()
