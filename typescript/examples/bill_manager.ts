/**
 * Bill Manager example: register → query → update → delete.
 * All four calls are synchronous and authenticated by the bearer token alone
 * — there is NO initiator or SecurityCredential on this API family.
 *
 * Run:
 *
 *   export MPESA_CONSUMER_KEY=... MPESA_CONSUMER_SECRET=... MPESA_SHORTCODE=...
 *   npx tsx examples/bill_manager.ts
 */
import {
  Config,
  MpesaClient,
  MpesaError,
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
  const shortcode = requiredEnv("MPESA_SHORTCODE");
  const billRefNumber = "INV-001"; // business reference, safe to log

  try {
    // 1. Register. A callback URL may embed a capability token; payerNumber
    //    / payerName are PII. logSafeRequest masks all of them.
    const regReq = {
      shortCode: shortcode,
      billRefNumber,
      billName: "Invoice 001",
      amount: 100,
      expiryDate: "2030-12-31",
      callBackURL: "https://example.com/bills/callback",
    };
    console.log("register (redacted):", logSafeRequest(regReq));
    const regAck = await client.billRegister(regReq);
    console.log(`registered: code=${regAck.ResponseCode}`);

    // 2. Query. BillRefNumber on the ACK is optional — identify the bill by
    //    the reference YOU sent, not by the echo.
    const qAck = await client.billQuery({ shortCode: shortcode, billRefNumber });
    console.log(`queried: code=${qAck.ResponseCode}`);

    // 3. Update. An omitted amount means "leave the amount alone" — a
    //    partial update moves no money. (With exactOptionalPropertyTypes,
    //    omit the key entirely rather than passing `undefined`.)
    const uAck = await client.billUpdate({
      shortCode: shortcode, billRefNumber, amount: 150,
    });
    console.log(`updated: code=${uAck.ResponseCode}`);

    // 4. Delete.
    const dAck = await client.billDelete({ shortCode: shortcode, billRefNumber });
    console.log(`deleted: code=${dAck.ResponseCode}`);

    // ResponseCode "0" means the OPERATION was accepted, never that money
    // moved. Settlement is exclusively via the OperationResult callback
    // (unsigned — gate it and reconcile externally).
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
