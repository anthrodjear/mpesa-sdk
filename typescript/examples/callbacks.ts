/**
 * Callback parsing example using the M-Pesa Daraja SDK: raw STK callbacks via
 * parseSTKCallback, async Result envelopes via parseAsyncResultBody.
 *
 * Run:
 *
 *   export MPESA_CONSUMER_KEY=... MPESA_CONSUMER_SECRET=... MPESA_SHORTCODE=... \
 *          MPESA_PASSKEY=...
 *   npx tsx examples/callbacks.ts
 */
import {
  Config,
  MpesaClient,
  MpesaError,
  ResultClass,
  parseAsyncResultBody,
  parseSTKCallback,
} from "@mpesa-sdk/core";
import { requiredEnv } from "./_env.js";

// Illustrative captures. In a real handler, cap the POST body at >= 1 MiB
// BEFORE parsing; both parsers enforce their own 1 MiB cap as well.
const STK_CALLBACK = `{"Body":{"stkCallback":{
  "MerchantRequestID":"29115-34620561-1",
  "CheckoutRequestID":"ws_CO_191220191020363925",
  "ResultCode":0,"ResultDesc":"success",
  "CallbackMetadata":{"Item":[
    {"Name":"Amount","Value":100},
    {"Name":"MpesaReceiptNumber","Value":"NLJ7RT61SV"}
  ]}
}}}`;

const ASYNC_RESULT = `{"Result":{
  "ResultType":0,"ResultCode":0,"ResultDesc":"success",
  "OriginatorConversationID":"a1b2c3d4e5f6a7b8",
  "ConversationID":"AG_20200101_00001abc",
  "TransactionID":"NLJ7RT61SV",
  "ResultParameters":{"ResultParameter":[
    {"Key":"TransactionReceipt","Value":"NLJ7RT61SV"}
  ]}
}}`;

async function main(): Promise<void> {
  const cfg = new Config({
    consumerKey: requiredEnv("MPESA_CONSUMER_KEY"),
    consumerSecret: requiredEnv("MPESA_CONSUMER_SECRET"),
    shortcode: requiredEnv("MPESA_SHORTCODE"),
    passkey: requiredEnv("MPESA_PASSKEY"), // required by stkQuery
  });
  const client = new MpesaClient({ config: cfg, timeoutMs: 15_000 });

  try {
    // 1. STK callback. UNSIGNED; metadata is ADVISORY. Binding on
    //    CheckoutRequestID is a dedup control, not authentication.
    // A bearer-capability URL token is endpoint control only, not authentication
    // — see SECURITY.md callback hierarchy.
    const result = parseSTKCallback(STK_CALLBACK);
    console.log(`CheckoutRequestID: ${result.CheckoutRequestID} code=${result.ResultCode}`);
    console.log(`Advisory metadata: amount=${result.amount()} receipt=${result.mpesaReceiptNumber()}`);
    console.log(`Class: ${result.classify()} duplicates=${result.duplicateKeys()}`);

    // 2. SETTLE ONLY BY QUERY: stkQuery ResultCode "0" bound to YOUR stored
    //    CheckoutRequestID record. A parsed callback is never proof of payment.
    const query = await client.stkQuery({ checkoutRequestID: result.CheckoutRequestID });
    if (String(query.ResultCode) === "0") {
      console.log("✓ Query confirms payment — settle now.");
    } else {
      console.log(`✗ Not settled (${query.ResultCode}): ${query.ResultDesc}`);
    }

    // 3. Async Result (B2C / TxStatus / Reversal / Balance). Also UNSIGNED.
    //    Bind on OriginatorConversationID; settle only on ResultCode "0".
    const asyncResult = parseAsyncResultBody(ASYNC_RESULT);
    console.log(`Async Result: code=${asyncResult.ResultCode} conv=${asyncResult.OriginatorConversationID}`);
    console.log(`  receipt=${asyncResult.transactionReceipt()} class=${asyncResult.classify()}`);
    if (asyncResult.classify() === ResultClass.INCONCLUSIVE) {
      console.log("INDETERMINATE — keep reconciling; never auto-refund.");
    }
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
