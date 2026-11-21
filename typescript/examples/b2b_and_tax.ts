/**
 * B2B Express Checkout + Tax Remittance example using the M-Pesa SDK.
 * Both are async: this queues them; the callbacks example parses the Result.
 *
 * Run:
 *
 *   export MPESA_CONSUMER_KEY=... MPESA_CONSUMER_SECRET=... MPESA_SHORTCODE=... \
 *          MPESA_INITIATOR_NAME=... MPESA_INITIATOR_PASSWORD=... \
 *          MPESA_CERT_PATH=/path/to/mpesa_public_cert.cer MPESA_TAX_PIN=...
 *   npx tsx examples/b2b_and_tax.ts
 */
import { readFileSync } from "node:fs";
import {
  CommandID,
  Config,
  MpesaClient,
  MpesaError,
  logSafeRequest,
  securityCredential,
} from "@mpesa-sdk/core";
import { requiredEnv } from "./_env.js";

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

    // 1. B2B Express Checkout. BOTH parties are organization shortcodes,
    //    never MSISDNs. Identifier types and originatorConversationID are
    //    client-injected; CommandID is BusinessPayBill/BusinessBuyGoods.
    const b2bReq = {
      initiator,
      securityCredential: cred,
      commandID: CommandID.BusinessPayBill,
      amount: 1000,
      partyA: shortcode,
      partyB: "600123",
      accountReference: "INV-001",
      remarks: "services",
      queueTimeOutURL: "https://example.com/b2b/timeout",
      resultURL: "https://example.com/b2b/result",
    };
    // Masks securityCredential and the callback URLs. Never log the raw req.
    console.log("B2B request (redacted):", logSafeRequest(b2bReq));
    const ack = await client.b2bPayment(b2bReq);
    console.log(`B2B queued: conv=${ack.ConversationID} code=${ack.ResponseCode}`);

    // 2. Tax Remittance — the B2B core plus three tax fields, with CommandID
    //    pinned to TaxRemittance. taxPayerPIN is a secret: logSafeRequest
    //    masks it alongside securityCredential and all callback URLs.
    const taxReq = {
      initiator,
      securityCredential: cred,
      commandID: CommandID.TaxRemittance,
      amount: 5000,
      partyA: shortcode,
      partyB: "572700", // KRA paybill
      accountReference: "TAX-2024-Q3",
      remarks: "VAT Q3 2024",
      queueTimeOutURL: "https://example.com/tax/timeout",
      resultURL: "https://example.com/tax/result",
      taxPeriod: "2024Q3",
      taxObligation: "VAT",
      taxPayerPIN: requiredEnv("MPESA_TAX_PIN"),
    };
    console.log("Tax request (redacted):", logSafeRequest(taxReq));
    const taxAck = await client.taxRemittance(taxReq);
    console.log(`Tax queued: conv=${taxAck.ConversationID} code=${taxAck.ResponseCode}`);

    // Both ACKs mean QUEUED, not completed. Settle ONLY from the async Result
    // with ResultCode "0" bound to your OriginatorConversationID record —
    // callbacks are UNSIGNED, so gate the endpoint.
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
