"""B2B Express Checkout + Tax Remittance example using the M-Pesa SDK.

Both calls are async: this file queues them and shows credential-safe
rendering; the callbacks example parses the resulting async Result.

Run:

    export MPESA_CONSUMER_KEY=... MPESA_CONSUMER_SECRET=... MPESA_SHORTCODE=... \
           MPESA_INITIATOR_NAME=... MPESA_INITIATOR_PASSWORD=... \
           MPESA_CERT_PATH=/path/to/mpesa_public_cert.cer MPESA_TAX_PIN=...
    # optional: MPESA_ENVIRONMENT=sandbox|production
    python examples/b2b_and_tax.py
"""
from __future__ import annotations

import os
import sys

from mpesa import (
    B2BRequest, CommandID, Config, Environment, MpesaClient, MpesaError,
    TaxRemittanceRequest, security_credential,
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
        # Cert must match the environment (Sandbox vs Production); a wrong
        # cert yields Daraja error 2001. See docs/apis/getting-started.md.
        with open(os.environ["MPESA_CERT_PATH"], "rb") as fh:
            cert = fh.read()
        cred = security_credential(cert, os.environ["MPESA_INITIATOR_PASSWORD"])
        initiator = os.environ["MPESA_INITIATOR_NAME"]
        shortcode = os.environ["MPESA_SHORTCODE"]

        # 1. B2B Express Checkout. BOTH parties are organization shortcodes,
        #    never MSISDNs. Identifier types and the OriginatorConversationID
        #    are client-injected; CommandID is BusinessPayBill/BusinessBuyGoods.
        b2b_req = B2BRequest(
            initiator=initiator,
            security_credential=cred,
            command_id=CommandID.BUSINESS_PAY_BILL,
            amount=1000,
            party_a=shortcode,
            party_b="600123",
            account_reference="INV-001",
            remarks="services",
            queue_time_out_url="https://example.com/b2b/timeout",
            result_url="https://example.com/b2b/result",
        )
        print(f"B2B request (repr redacted): {b2b_req!r}")
        ack = client.b2b_payment(b2b_req)
        print(f"B2B queued: conv={ack.conversation_id} code={ack.response_code}")

        # 2. Tax Remittance — the B2B core plus three tax fields, with
        #    CommandID pinned to TAX_REMITTANCE. tax_payer_pin is a SECRET and
        #    is absent from every repr (field-level repr=False).
        tax_req = TaxRemittanceRequest(
            initiator=initiator,
            security_credential=cred,
            command_id=CommandID.TAX_REMITTANCE,
            amount=5000,
            party_a=shortcode,
            party_b="572700",  # KRA paybill
            account_reference="TAX-2024-Q3",
            remarks="VAT Q3 2024",
            queue_time_out_url="https://example.com/tax/timeout",
            result_url="https://example.com/tax/result",
            tax_period="2024Q3",
            tax_obligation="VAT",
            tax_payer_pin=os.environ["MPESA_TAX_PIN"],
        )
        print(f"Tax request (repr redacted): {tax_req!r}")
        tax_ack = client.tax_remittance(tax_req)
        print(f"Tax queued: conv={tax_ack.conversation_id} code={tax_ack.response_code}")

        # Both ACKs mean QUEUED, not completed. Settle ONLY from the async
        # Result with result_code == "0" bound to your
        # originator_conversation_id record. Callbacks are unsigned.

    except (MpesaError, ValueError, OSError, KeyError) as exc:
        print(f"\n✗ B2B/Tax failed: {exc}", file=sys.stderr)
        sys.exit(1)
    finally:
        client.close()


if __name__ == "__main__":
    main()
