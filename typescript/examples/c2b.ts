/**
 * C2B example using the M-Pesa Daraja SDK: register URLs, then simulate a
 * PayBill payment in the sandbox.
 *
 * Run:
 *
 *   export MPESA_CONSUMER_KEY=... MPESA_CONSUMER_SECRET=... MPESA_SHORTCODE=...
 *   npx tsx examples/c2b.ts
 */
import {
  CommandID,
  Config,
  MpesaClient,
  MpesaError,
  ResponseType,
  logSafeRequest,
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
    // 1. Register validation/confirmation URLs. Production registration is
    //    effectively one-shot. Callback URLs may embed a capability token;
    //    logSafeRequest redacts them — never log the raw request.
    const regReq = {
      responseType: ResponseType.Completed,
      confirmationURL: "https://example.com/c2b/confirm",
      validationURL: "https://example.com/c2b/validate",
    };
    console.log("register (redacted):", logSafeRequest(regReq));
    const regAck = await client.c2bRegisterURL(regReq);
    console.log(`registered: code=${regAck.ResponseCode} ${regAck.ResponseDescription}`);

    // 2. SANDBOX ONLY: simulate an inbound PayBill payment. PayBill REQUIRES
    //    billRefNumber (the account being paid). Note the ACK's misspelled
    //    wire key: OriginatorCoversationID (no second 's').
    const ack = await client.c2bSimulate({
      commandID: CommandID.PayBill,
      amount: 100,
      msisdn: "254712345678",
      billRefNumber: "ACCOUNT-42",
    });
    console.log(`simulated: id=${ack.OriginatorCoversationID} code=${ack.ResponseCode}`);

    // Buy Goods (till) differences: use CommandID.PayGoods and OMIT
    // billRefNumber — a till has no account reference:
    //
    //   await client.c2bSimulate({
    //     commandID: CommandID.PayGoods, amount: 100, msisdn: "254712345678",
    //   });
    // The ACK is NOT settlement: settle from the CONFIRMATION callback,
    // which is unsigned — cap its body and gate the endpoint.
    console.log("\n✓ ACK only — settle from the confirmation callback, never this ACK.");
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
