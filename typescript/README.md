# @mpesa-sdk/core

[![npm](https://img.shields.io/npm/v/@mpesa-sdk/core)](https://www.npmjs.com/package/@mpesa-sdk/core)
[![license](https://img.shields.io/npm/l/@mpesa-sdk/core)](./LICENSE)

Zero-dependency TypeScript SDK for the Safaricom **M-Pesa Daraja API** —
Node ≥ 20 native `fetch` + `node:crypto`, no runtime dependencies. The
TypeScript engine of a three-engine SDK (Go, Python, TypeScript) that share
one wire contract.

## Install

```sh
npm install @mpesa-sdk/core
```

## Quick start

```ts
import { Config, MpesaClient, TransactionType } from "@mpesa-sdk/core";

const client = new MpesaClient({
  config: new Config({
    consumerKey:    process.env.MPESA_CONSUMER_KEY!,
    consumerSecret: process.env.MPESA_CONSUMER_SECRET!,
    shortcode:      process.env.MPESA_SHORTCODE!,
    passkey:        process.env.MPESA_PASSKEY!,
    // environment: Environment.PRODUCTION, // sandbox is the default
  }),
});

const resp = await client.stkPush({
  transactionType: TransactionType.PayBillOnline, // wire: "CustomerPayBillOnline"
  amount: 100,
  partyA: "254712345678",
  phoneNumber: "254712345678",
  callBackURL: "https://example.com/stk/callback",
  accountReference: "Order42", // max 12 chars
  transactionDesc: "test",     // max 13 chars
});
console.log(resp.ResponseCode, resp.CheckoutRequestID, resp.CustomerMessage);
```

Accepted **≠** paid: `ResponseCode "0"` means Daraja queued the prompt. The
verdict arrives on your callback URL — settle only via `stkQuery` bound to
the `CheckoutRequestID` you stored when you fired the push.

## Endpoints

`stkPush` · `stkQuery` · `b2cPayout` · `c2bRegisterURL` · `c2bSimulate` ·
`transactionStatus` · `reversal` · `accountBalance` · `generateQRCode` ·
`b2bPayment` · `taxRemittance` · `billRegister` · `billQuery` ·
`billUpdate` · `billDelete` — plus OAuth token lifecycle management
(transparent refresh, retry-once on `401.003.01`), callback parsers
(`parseSTKCallback`, `parseAsyncResultBody`), `logSafeRequest` for
redacted logging, and configurable transaction limits.

## Documentation

Per-endpoint wire contracts, security model and the cross-engine contract
tables: [the repository docs](https://github.com/anthrodjear/mpesa-sdk/blob/main/README.md).
Each new session also carries `MpesaClient.fromEnv()` for env-var wiring.

## License

MIT — see [LICENSE](./LICENSE).
