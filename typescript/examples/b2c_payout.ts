/**
 * B2C payout example using the M-Pesa Daraja SDK.
 *
 * Run:
 *
 *   export MPESA_CONSUMER_KEY=... MPESA_CONSUMER_SECRET=... MPESA_SHORTCODE=... \
 *          MPESA_INITIATOR_NAME=... MPESA_INITIATOR_PASSWORD=... \
 *          MPESA_CERT_PATH=/path/to/mpesa_public_cert.cer
 *   npx tsx examples/b2c_payout.ts
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
  // 1. Config from environment (sandbox by default).
  const cfg = new Config({
    consumerKey: requiredEnv("MPESA_CONSUMER_KEY"),
    consumerSecret: requiredEnv("MPESA_CONSUMER_SECRET"),
    shortcode: requiredEnv("MPESA_SHORTCODE"),
  });
  // TS keeps its timeout knob on the client, not on Config.
  const client = new MpesaClient({ config: cfg, timeoutMs: 15_000 });

  try {
    // 2. B2C needs a SecurityCredential: the initiator password encrypted
    //    with Daraja's PUBLIC certificate (cert first, password second).
    //    Never log the password or the resulting credential.
    // Cert MUST match the configured environment (Sandbox vs Production;
    // wrong cert ⇒ Daraja error 2001) — see docs/apis/getting-started.md.
    // TS sets Production via Config({ environment: Environment.PRODUCTION }).
    const cert = readFileSync(requiredEnv("MPESA_CERT_PATH"));
    const cred = securityCredential(cert, requiredEnv("MPESA_INITIATOR_PASSWORD"));

    // partyA and originatorConversationID are client-injected when omitted.
    const req = {
      initiatorName: requiredEnv("MPESA_INITIATOR_NAME"),
      securityCredential: cred,
      commandID: CommandID.BusinessPayment,
      amount: 100,
      partyB: "254712345678",
      remarks: "payout",
      queueTimeOutURL: "https://example.com/b2c/timeout",
      resultURL: "https://example.com/b2c/result",
    };
    // logSafeRequest masks securityCredential and BOTH callback URLs.
    console.log("request (redacted):", logSafeRequest(req));

    const ack = await client.b2cPayout(req);
    console.log(`OriginatorConversationID: ${ack.OriginatorConversationID}`);
    console.log(`ConversationID:           ${ack.ConversationID}`);
    console.log(`ResponseCode:             ${ack.ResponseCode}`);

    // 3. ACK = QUEUED, not PAID. Daraja POSTs an async Result envelope to
    //    resultURL. SETTLE ONLY from parseAsyncResultBody with ResultCode "0"
    //    bound to YOUR OriginatorConversationID record — callbacks unsigned.
    console.log("\n✓ Payout queued — settle ONLY from the async Result envelope.");
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
