"""Transaction Status / Reversal / Account Balance / Dynamic QR example.
The first three are async (ACK only); the QR call is fully synchronous.

Run:

    export MPESA_CONSUMER_KEY=... MPESA_CONSUMER_SECRET=... MPESA_SHORTCODE=... \
           MPESA_INITIATOR_NAME=... MPESA_INITIATOR_PASSWORD=... \
           MPESA_CERT_PATH=/path/to/mpesa_public_cert.cer
    # optional: MPESA_ENVIRONMENT=sandbox|production
    python examples/queries_and_admin.py
"""
from __future__ import annotations

import os
import sys

from mpesa import (
    AccountBalanceRequest, Config, ConversationResponse, Environment,
    MpesaClient, MpesaError, QRCodeRequest, QRTrxCode, ReversalRequest,
    TransactionStatusRequest, security_credential,
)


def report(name: str, ack: ConversationResponse) -> None:
    # ACK = QUEUED, not settled; the verdict arrives at ResultURL.
    print(f"{name} ACK: code={ack.response_code} conv={ack.conversation_id}")


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
    shortcode, result_url = os.environ["MPESA_SHORTCODE"], "https://example.com/ops/result"
    timeout_url = "https://example.com/ops/timeout"

    try:
        # Cert must match the environment (Sandbox vs Production); a wrong
        # cert yields Daraja error 2001. See docs/apis/getting-started.md.
        with open(os.environ["MPESA_CERT_PATH"], "rb") as fh:
            cert = fh.read()
        cred = security_credential(cert, os.environ["MPESA_INITIATOR_PASSWORD"])
        initiator = os.environ["MPESA_INITIATOR_NAME"]

        # 1. Transaction Status — EXACTLY ONE of transaction_id /
        #    original_conversation_id (CommandID/IdentifierType are defaulted).
        report("TransactionStatus", client.transaction_status(TransactionStatusRequest(
            initiator=initiator, security_credential=cred, transaction_id="NLJ7RT61SV",
            party_a=shortcode, remarks="status check", result_url=result_url,
            queue_time_out_url=timeout_url,
        )))

        # 2. Reversal — C2B ONLY; reverse B2C payouts in the M-PESA portal.
        report("Reversal", client.reversal(ReversalRequest(
            initiator=initiator, security_credential=cred, transaction_id="NLJ7RT61SV",
            amount=100, receiver_party=shortcode, remarks="duplicate charge",
            result_url=result_url, queue_time_out_url=timeout_url,
        )))

        # 3. Account Balance — parse the blob with mpesa.parse_balance_segments.
        report("AccountBalance", client.account_balance(AccountBalanceRequest(
            initiator=initiator, security_credential=cred, party_a=shortcode,
            remarks="balance check", queue_time_out_url=timeout_url, result_url=result_url,
        )))

        # 4. Dynamic QR — synchronous; QR code is an opaque payload.
        qr = client.generate_qr_code(QRCodeRequest(
            merchant_name="Test Merchant", ref_no="ORDER-42", amount=100,
            trx_code=QRTrxCode.BUY_GOODS, cpi="600123", size="300",
        ))
        print(f"QR request={qr.request_id} response={qr.response_code} payload_len={len(qr.qr_code)}")
        print("\n✓ Status/Reversal/Balance are async — settle only from the Result envelope.")

    except (MpesaError, ValueError, OSError, KeyError) as exc:
        print(f"\n✗ queries/admin example failed: {exc}", file=sys.stderr)
        sys.exit(1)
    finally:
        client.close()


if __name__ == "__main__":
    main()
