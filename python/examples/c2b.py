"""C2B example using the M-Pesa Daraja SDK: register URLs, simulate PayBill.

Run:

    export MPESA_CONSUMER_KEY=... MPESA_CONSUMER_SECRET=... MPESA_SHORTCODE=...
    # optional: MPESA_ENVIRONMENT=sandbox|production
    python examples/c2b.py
"""
from __future__ import annotations

import os
import sys

from mpesa import (
    C2BRegisterRequest,
    C2BSimulateRequest,
    CommandID,
    Config,
    Environment,
    MpesaClient,
    MpesaError,
    ResponseType,
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

    try:
        # 1. Register validation/confirmation URLs. Production registration is
        #    effectively one-shot. Callback URLs may embed a capability token:
        #    request reprs redact them — never log the raw object.
        reg_req = C2BRegisterRequest(
            response_type=ResponseType.COMPLETED,
            confirmation_url="https://example.com/c2b/confirm",
            validation_url="https://example.com/c2b/validate",
        )
        print(f"register (repr redacted): {reg_req!r}")
        reg_ack = client.c2b_register_url(reg_req)
        print(f"registered: code={reg_ack.response_code} {reg_ack.response_description}")

        # 2. SANDBOX ONLY: simulate an inbound PayBill payment. PayBill
        #    REQUIRES bill_ref_number (the account being paid).
        ack = client.c2b_simulate(C2BSimulateRequest(
            command_id=CommandID.C2B_PAYBILL_ONLINE,
            amount=100,
            msisdn="254712345678",
            bill_ref_number="ACCOUNT-42",
        ))
        # The ACK is NOT settlement: settle from the CONFIRMATION callback.
        # That callback is unsigned — cap its body and gate the endpoint.
        print(f"simulated: id={ack.originator_conversation_id} code={ack.response_code}")

        # Buy Goods (till) differences: use CommandID.C2B_BUY_GOODS_ONLINE and
        # OMIT bill_ref_number — a till has no account reference, e.g.:
        #
        #   client.c2b_simulate(C2BSimulateRequest(
        #       command_id=CommandID.C2B_BUY_GOODS_ONLINE,
        #       amount=100, msisdn="254712345678"))
        print("\n✓ ACK only — settle from the confirmation callback, never this ACK.")

    except (MpesaError, ValueError, KeyError) as exc:
        print(f"\n✗ C2B flow failed: {exc}", file=sys.stderr)
        sys.exit(1)
    finally:
        client.close()


if __name__ == "__main__":
    main()
