/**
 * Transaction Status / Reversal / Account Balance / Dynamic QR example.
 * First three are async (ACK only); QR is synchronous.
 *
 * Run:
 *
 *   export MPESA_CONSUMER_KEY=... MPESA_CONSUMER_SECRET=... MPESA_SHORTCODE=... \
 *          MPESA_INITIATOR_NAME=... MPESA_INITIATOR_PASSWORD=... \
 *          MPESA_CERT_PATH=/path/to/mpesa_public_cert.cer
 *   npx tsx examples/queries_and_admin.ts
 */
import { readFileSync } from "node:fs";
import {
  Config, MpesaClient, MpesaError, QRTrxCode,
  type ConversationResponse, securityCredential,
} from "@mpesa-sdk/core";
import { requiredEnv } from "./_env.js";

function report(name: string, ack: ConversationResponse): void {
  // ACK = QUEUED, not settled; the verdict arrives at ResultURL.
  console.log(`${name} ACK: code=${ack.ResponseCode} conv=${ack.ConversationID}`);
}

async function main(): Promise<void> {
  const cfg = new Config({
    consumerKey: requiredEnv("MPESA_CONSUMER_KEY"),
    consumerSecret: requiredEnv("MPESA_CONSUMER_SECRET"),
    shortcode: requiredEnv("MPESA_SHORTCODE"),
  });
  const client = new MpesaClient({ config: cfg, timeoutMs: 15_000 });

  try {
    // Cert MUST match the configured environment (Sandbox vs Production;
    // wrong cert ⇒ Daraja error 2001) — see docs/apis/getting-started.md.
    // TS sets Production via Config({ environment: Environment.PRODUCTION }).
    const cert = readFileSync(requiredEnv("MPESA_CERT_PATH"));
    const cred = securityCredential(cert, requiredEnv("MPESA_INITIATOR_PASSWORD"));
    const initiator = requiredEnv("MPESA_INITIATOR_NAME");
    const shortcode = requiredEnv("MPESA_SHORTCODE");
    const resultURL = "https://example.com/ops/result";
    const queueTimeOutURL = "https://example.com/ops/timeout";

    // 1. Transaction Status — exactly one of transactionID /
    //    originalConversationID (a TYPE-level XOR contract).
    report("TransactionStatus", await client.transactionStatus({
      initiator, securityCredential: cred, transactionID: "NLJ7RT61SV",
      partyA: shortcode, remarks: "status check", resultURL, queueTimeOutURL,
    }));

    // 2. Reversal — C2B ONLY; reverse B2C payouts in the M-PESA portal.
    report("Reversal", await client.reversal({
      initiator, securityCredential: cred, transactionID: "NLJ7RT61SV",
      amount: 100, receiverParty: shortcode, remarks: "duplicate charge",
      resultURL, queueTimeOutURL,
    }));

    // 3. Account Balance — parse the blob with parseBalanceSegments.
    report("AccountBalance", await client.accountBalance({
      initiator, securityCredential: cred, partyA: shortcode,
      remarks: "balance check", resultURL, queueTimeOutURL,
    }));

    // 4. Dynamic QR — synchronous; QRCode is an opaque payload.
    const qr = await client.generateQRCode({
      merchantName: "Test Merchant", refNo: "ORDER-42", amount: 100,
      trxCode: QRTrxCode.BuyGoods, cpi: "600123", size: "300",
    });
    console.log(`QR request=${qr.RequestID} response=${qr.ResponseCode} payload_len=${qr.QRCode.length}`);
    console.log("\n✓ Status/Reversal/Balance are async — settle only from the Result envelope.");
  } catch (err) {
    if (err instanceof MpesaError) {
      console.error(`\n✗ Daraja error: ${err.message}`);
    } else {
      console.error(`\n✗ Unexpected error: ${err instanceof Error ? err.message : "unknown error"}`);
    }
    process.exit(1);
  }
}

main();
