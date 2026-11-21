"""B2C payout example using the M-Pesa Daraja SDK.

Run:

    export MPESA_CONSUMER_KEY=... MPESA_CONSUMER_SECRET=... MPESA_SHORTCODE=... \
           MPESA_INITIATOR_NAME=... MPESA_INITIATOR_PASSWORD=... \
           MPESA_CERT_PATH=/path/to/mpesa_public_cert.cer
    # optional: MPESA_ENVIRONMENT=sandbox|production
    python examples/b2c_payout.py
"""
from __future__ import annotations

import os
import sys

from mpesa import (
    B2CPayoutRequest,
    CommandID,
    Config,
    Environment,
    MpesaClient,
    MpesaError,
    security_credential,
)


def main() -> None:
    # 1. Config from environment (sandbox default; MPESA_ENVIRONMENT opts in).
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
        # 2. B2C needs a SecurityCredential: the initiator password encrypted
        #    with Daraja's PUBLIC certificate. Never print either value.
        #    Cert must match the environment (Sandbox vs Production); a wrong
        #    cert yields Daraja error 2001. See docs/apis/getting-started.md.
        with open(os.environ["MPESA_CERT_PATH"], "rb") as fh:
            cert = fh.read()
        cred = security_credential(cert, os.environ["MPESA_INITIATOR_PASSWORD"])

        # OriginatorConversationID and PartyA are injected by the client.
        req = B2CPayoutRequest(
            initiator_name=os.environ["MPESA_INITIATOR_NAME"],
            security_credential=cred,
            command_id=CommandID.BUSINESS_PAYMENT,
            amount=100,  # B2C minimum is 10 KES
            party_b="254712345678",
            remarks="payout",
            result_url="https://example.com/b2c/result",
            queue_time_out_url="https://example.com/b2c/timeout",
        )
        # repr is credential-safe (credential and callback URLs redacted).
        print(f"request (repr redacted): {req!r}")

        ack = client.b2c_payout(req)
        print(f"OriginatorConversationID: {ack.originator_conversation_id}")
        print(f"ConversationID:           {ack.conversation_id}")
        print(f"ResponseCode:             {ack.response_code}")

        # 3. The ACK means QUEUED, not PAID. Daraja POSTs an async Result
        #    envelope to result_url. SETTLE ONLY after AsyncResult.from_json
        #    with result_code == "0" bound to YOUR originator_conversation_id
        #    record — callbacks are unsigned and a forged body parses fine.
        print("\n✓ Payout queued — settle ONLY from the async Result envelope.")

    except (MpesaError, ValueError, OSError, KeyError) as exc:
        print(f"\n✗ B2C payout failed: {exc}", file=sys.stderr)
        sys.exit(1)
    finally:
        client.close()


if __name__ == "__main__":
    main()
