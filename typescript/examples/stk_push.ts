/**
 * STK Push example using the M-Pesa Daraja SDK.
 *
 * Run:
 *
 *   export MPESA_CONSUMER_KEY=... MPESA_CONSUMER_SECRET=... \
 *          MPESA_SHORTCODE=... MPESA_PASSKEY=...
 *   npx tsx stk_push.ts
 */
import {
  Config,
  MpesaClient,
  MpesaError,
  TransactionType,
} from "@mpesa-sdk/core";
import { requiredEnv } from "./_env.js";

async function main(): Promise<void> {
  // 1. Build config from environment variables. requiredEnv() names the
  //    missing variable in its error instead of passing undefined to Config.
  const cfg = new Config({
    consumerKey:    requiredEnv("MPESA_CONSUMER_KEY"),
    consumerSecret: requiredEnv("MPESA_CONSUMER_SECRET"),
    shortcode:      requiredEnv("MPESA_SHORTCODE"),
    passkey:        requiredEnv("MPESA_PASSKEY"),
  });

  // 2. Create a concurrency-safe client (share across calls).
  //    TS keeps its only timeout knob on the client options, not on Config.
  const client = new MpesaClient({ config: cfg, timeoutMs: 15_000 });

  try {
    // 3. Send the STK Push prompt.
    const resp = await client.stkPush({
      transactionType: TransactionType.PayBillOnline,
      amount: 100,
      partyA: "254712345678",
      phoneNumber: "254712345678",
      callBackURL: "https://example.com/callback",
      accountReference: "Order 42",
      transactionDesc: "test payment",
    });

    // 4. Check acceptance (ResponseCode "0" = Daraja accepted the request).
    //    Accepted is NOT paid — settle only via callback or STK Query.
    console.log(`MerchantRequestID:  ${resp.MerchantRequestID}`);
    console.log(`CheckoutRequestID:  ${resp.CheckoutRequestID}`);
    console.log(`ResponseCode:       ${resp.ResponseCode}`);
    console.log(`CustomerMessage:    ${resp.CustomerMessage}`);

    if (resp.ResponseCode === "0") {
      console.log("\n✓ Push accepted — wait for callback or query with stkQuery.");
    } else {
      console.log(
        `\n✗ Push rejected (code ${resp.ResponseCode}): ${resp.ResponseDescription}`,
      );
    }
  } catch (err) {
    if (err instanceof MpesaError) {
      console.error(`\n✗ Daraja error: ${err.message}`);
      if (err.errorCode) console.error(`  errorCode:    ${err.errorCode}`);
      if (err.requestId) console.error(`  requestId:    ${err.requestId}`);
    } else {
      console.error(`\n✗ Unexpected error: ${err}`);
    }
    process.exit(1);
  }
}

main();
