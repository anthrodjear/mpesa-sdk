# M-Pesa Daraja SDK

[![Go](https://img.shields.io/badge/Go-1.22+-00ADD8?logo=go&logoColor=white)](https://pkg.go.dev/github.com/anthrodjear/mpesa-sdk/go)
[![Python](https://img.shields.io/badge/Python-3.11+-3776AB?logo=python&logoColor=white)](https://pypi.org/project/mpesa-sdk/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9+-3178C6?logo=typescript&logoColor=white)](https://www.npmjs.com/package/@mpesa-sdk/core)
[![CI](https://github.com/anthrodjear/mpesa-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/anthrodjear/mpesa-sdk/actions/workflows/ci.yml)

A production-grade SDK for the Safaricom **M-Pesa Daraja API** in three languages — Go, Python, and TypeScript — sharing one contract: identical wire behaviour, identical test vectors, and identical safety rules. All nine business endpoints are covered (STK Push, STK Query, B2C payouts, C2B register/simulate, Transaction Status, Reversal, Account Balance, Dynamic QR) plus OAuth token lifecycle management.

## Requirements & installation

| Language   | Version  | Install                        | Import                                  | Runtime deps                          |
|------------|----------|--------------------------------|-----------------------------------------|---------------------------------------|
| Go         | 1.22+    | `go get github.com/anthrodjear/mpesa-sdk/go` | `import mpesa "github.com/anthrodjear/mpesa-sdk/go"` | none (stdlib only)                    |
| Python     | 3.11+    | `pip install mpesa-sdk`        | `import mpesa`                           | `requests`, `cryptography`            |
| TypeScript | Node ≥20 | `npm install @mpesa-sdk/core`  | `from "@mpesa-sdk/core"`                 | none (native `fetch` + `node:crypto`) |

## Getting credentials

1. Create an app at [developer.safaricom.co.ke](https://developer.safaricom.co.ke) and select the products you need (Lipa na M-Pesa Online, B2C, …).
2. Copy the app's **Consumer Key** and **Consumer Secret** — they authenticate every OAuth token request.
3. Sandbox passkeys are **public test values**, published on the portal's *Test Credentials* page.
4. Export the four values as environment variables (table below).
5. Production additionally requires live credentials, HTTPS callback URLs and gateway IP whitelisting — follow the [go-live checklist](docs/apis/getting-started.md#going-live-checklist).
6. Initiator-based APIs (B2C et al.) need the per-environment certificate — sandbox ≠ production (`assets/certs/`).

## Configuration

| Variable               | Purpose                                              | Notes                                    |
|------------------------|------------------------------------------------------|------------------------------------------|
| `MPESA_CONSUMER_KEY`   | OAuth basic-auth username                             | from your Daraja app                      |
| `MPESA_CONSUMER_SECRET`| OAuth basic-auth password                             | secret — never log                        |
| `MPESA_SHORTCODE`      | Default business shortcode                            | injected into requests when you omit it   |
| `MPESA_PASSKEY`        | STK Push/Query password derivation                    | secret — never log                        |
| `MPESA_ENVIRONMENT`    | `sandbox` (default) · `production` / `prod` (Python)  | honored by Python `Environment.from_config`; in Go set `Config.Environment` yourself. TypeScript: `MPESA_ENVIRONMENT` accepts exactly `"sandbox"` or `"production"` — any other value throws a `ConfigError`; when unset it defaults to sandbox |

```dotenv
# .env.example
MPESA_CONSUMER_KEY=your-consumer-key
MPESA_CONSUMER_SECRET=your-consumer-secret
MPESA_SHORTCODE=174379
MPESA_PASSKEY=your-passkey
MPESA_ENVIRONMENT=sandbox
```

Credentials never leak through text rendering: `repr()`/`log_safe()` (Python), `GoString`/`Format` (Go), and `toString()`/`toJSON()`/`logSafe()` (TypeScript) all redact secrets. Log configs freely — but only via those accessors. TypeScript additionally ships `MpesaClient.fromEnv()`, wired straight from these variables; Go has no env loader by design — fill `Config` yourself.

## Quick start

Every snippet below is complete enough to run (fill the env vars first). Accepted ≠ paid: `ResponseCode "0"` means Daraja queued the prompt; settlement arrives via callback or query.

### Go

```go
package main

import (
	"context"
	"log"
	"os"

	mpesa "github.com/anthrodjear/mpesa-sdk/go"
)

func main() {
	c := mpesa.NewClient(mpesa.Config{
		ConsumerKey: os.Getenv("MPESA_CONSUMER_KEY"), ConsumerSecret: os.Getenv("MPESA_CONSUMER_SECRET"),
		Shortcode: os.Getenv("MPESA_SHORTCODE"), Passkey: os.Getenv("MPESA_PASSKEY"),
	}) // Environment zero value = mpesa.Sandbox
	resp, err := c.STKPush(context.Background(), mpesa.STKPushRequest{
		TransactionType: mpesa.TransactionTypePayBillOnline, Amount: 100,
		PartyA: "254712345678", PhoneNumber: "254712345678",
		CallBackURL:      "https://example.com/stk/callback",
		AccountReference: "Order42", TransactionDesc: "test",
	})
	if err != nil {
		log.Fatal(err)
	}
	log.Println(resp.ResponseCode, resp.CheckoutRequestID, resp.CustomerMessage)
}
```

### Python

```python
import os

from mpesa import Config, Environment, MpesaClient, STKPushRequest, TransactionType

cfg = Config(
    consumer_key=os.environ["MPESA_CONSUMER_KEY"],
    consumer_secret=os.environ["MPESA_CONSUMER_SECRET"],
    shortcode=os.environ["MPESA_SHORTCODE"],
    passkey=os.environ["MPESA_PASSKEY"],
    environment=Environment.SANDBOX,  # default; Environment.PRODUCTION when live
)
client = MpesaClient(cfg)

resp = client.stk_push(STKPushRequest(
    transaction_type=TransactionType.CUSTOMER_PAY_BILL_ONLINE,
    amount=100,
    party_a="254712345678",
    phone_number="254712345678",
    call_back_url="https://example.com/stk/callback",
    account_reference="Order42",  # max 12 chars
    transaction_desc="test",      # max 13 chars
))
print(resp.response_code, resp.checkout_request_id, resp.customer_message)
```

### TypeScript

> ⚠️ Enum member names differ across languages: TypeScript uses `TransactionType.BillPayGoods` (wire value `"CustomerPayBillOnline"`), Python `CUSTOMER_PAY_BILL_ONLINE`, Go `TransactionTypePayBillOnline`.

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
  transactionType: TransactionType.BillPayGoods, // wire: "CustomerPayBillOnline"
  amount: 100,
  partyA: "254712345678",
  phoneNumber: "254712345678",
  callBackURL: "https://example.com/stk/callback",
  accountReference: "Order42", // max 12 chars
  transactionDesc: "test",     // max 13 chars
});
console.log(resp.ResponseCode, resp.CheckoutRequestID, resp.CustomerMessage);
```

### API surface at a glance

| Endpoint              | Go                 | Python                | TypeScript          |
|-----------------------|--------------------|-----------------------|---------------------|
| STK Push              | `STKPush`          | `stk_push`            | `stkPush`           |
| STK Query             | `STKQuery`         | `stk_query`           | `stkQuery`          |
| B2C payout            | `B2CPayout`        | `b2c_payout`          | `b2cPayout`         |
| C2B Register URL      | `C2BRegisterURL`   | `c2b_register_url`    | `c2bRegisterURL`    |
| C2B Simulate          | `C2BSimulate`      | `c2b_simulate`        | `c2bSimulate`       |
| Transaction Status    | `TransactionStatus`| `transaction_status`  | `transactionStatus` |
| Reversal              | `Reversal`         | `reversal`            | `reversal`          |
| Account Balance       | `AccountBalance`   | `account_balance`     | `accountBalance`    |
| Dynamic QR            | `GenerateQRCode`   | `generate_qr_code`    | `generateQRCode`    |

## Core concepts

### Sync vs async endpoints

The STK Push lifecycle in one line: **push → customer sees prompt on their phone → PIN entry settles it → outcome POSTed to your `CallBackURL`** (or polled). The sync/async split for everything else:

| Call                                  | You get immediately            | Final outcome delivered via                        |
|---------------------------------------|--------------------------------|----------------------------------------------------|
| STK Push                              | acceptance ack (`CheckoutRequestID`) | callback POSTed to `CallBackURL` (fallback: poll `stk_query`) |
| STK Query                             | the outcome itself             | — (fully synchronous)                              |
| C2B Register / C2B Simulate           | registration/payment ack       | real payments later hit confirmation/validation URLs |
| OAuth, Dynamic QR                     | the answer itself              | — (fully synchronous)                              |
| B2C, Transaction Status, Reversal, Account Balance | queue ack (`ConversationID`) | `Result` envelope POSTed to `ResultURL`; timeout notice to `QueueTimeOutURL` |

### Result classification: SUCCESS / FAILURE / INDETERMINATE

The golden rule: **never auto-fail an INDETERMINATE outcome.** Debits have been observed landing minutes after timeout-style codes (1037, 1001…); marking such a payment failed risks refunding an order that was actually paid. Success is only ever code `0`; failure is limited to documented terminal codes; everything else is indeterminate — keep querying ([STK Query](docs/apis/stk-query.md)) until a terminal code arrives:

```go
cls := mpesa.ClassifyResultCode("1037") // → mpesa.ResultClassIndeterminate
```

```python
classify_result_code("1037") is ResultClass.INDETERMINATE
```

```ts
classifyResultCode("1037") === ResultClass.INCONCLUSIVE // member name; serializes as "indeterminate"
```

## Usage guides

### Receiving payment callbacks (STK Push results)

Daraja POSTs the push outcome to your `CallBackURL`. Callbacks are **unsigned** — there is no signature to verify, so rank your controls: settle **only** via a query bound to your stored `CheckoutRequestID` (a forged body parses fine and never survives the round-trip); gate the endpoint with URL tokens (`new_callback_token()` / Go `NewCallbackToken()` / TS `newCallbackToken()`); bind on `CheckoutRequestID` for **dedup only — it authenticates nothing against forgery**; IP allowlists are defense-in-depth. Full threat model: [SECURITY.md](SECURITY.md). Settle-first in each language:

```python
resp = client.stk_query(STKQueryRequest(checkout_request_id=crid))
if resp.result_code == "0":
    settle(order)   # settled by query, never by the bare hit
```

```go
res, err := c.STKQuery(ctx, mpesa.STKQueryRequest{CheckoutRequestID: crid})
if err == nil && res.Classify() == mpesa.ResultClassSuccess {
    settle(order) // settled by query, never by the bare hit
}
```

```ts
const res = await client.stkQuery({ checkoutRequestID: crid });
if (parseInt(res.ResultCode, 10) === 0) settle(order); // by query, never the bare hit
```

Python has the most convenient parser:

```python
from mpesa import ResultClass, STKQueryRequest, StkCallbackResult
from flask import Flask, request

app = Flask(__name__)
orders = {}  # checkout_request_id → your original order record

@app.post("/stk/callback")
def stk_callback():
    result = StkCallbackResult.from_json(request.get_data())  # raw body bytes

    order = orders.get(result.checkout_request_id)            # dedup FIRST (not authentication)
    if order is None:
        return "", 200                                        # unknown: ACK, ignore

    if result.classify() is ResultClass.SUCCESS:              # callback = hint only…
        resp = client.stk_query(STKQueryRequest(              # …settle via the query round-trip
            checkout_request_id=result.checkout_request_id))
        if resp.result_code == "0":
            settle(order, receipt=result.mpesa_receipt(), amount=result.amount())
    else:
        mark_pending_reconcile(order)   # failure/indeterminate → stk_query decides, never refund here

    return "", 200                                            # ACK immediately
```

(`client`, `settle`, `mark_pending_reconcile` are your functions.) Typed metadata helpers: `amount()`, `mpesa_receipt()`, `phone_number()`, `transaction_date()`, plus `metadata()` for the raw first-wins map — Go exposes `STKCallbackResult.MetadataMap()`, TypeScript `new MetadataMap(items)` with `.get(key)`. Go also offers `mpesa.ParseSTKCallback(body)` accepting the full envelope or a bare result object, and `STKQueryResponse.Classify()` mirroring Python's `resp.classify()`. Cap request bodies at your framework level too; `from_json` refuses bodies over 1 MiB characters regardless. Callbacks late or missing? Poll synchronously: `stk_query(STKQueryRequest(checkout_request_id=…))` returns the outcome directly (`resp.result_code`, string-normalized) — back off between polls (+30s/+60s/+120s), classify each result, and only settle on terminal codes.

### Async results (B2C / Transaction Status / Reversal / Account Balance)

The sync reply is only a **queue ack**. The verdict arrives later as a `{"Result": {…}}` envelope on your `ResultURL`; `QueueTimeOutURL` gets a timeout *notice* (not a failure receipt — treat it as indeterminate and reconcile). Parse it with `AsyncResult.Parameters()` / `parse_balance_segments` equivalents:

```python
result = AsyncResult.from_json(raw_body)
if result.classify() is ResultClass.SUCCESS:
    receipt = result.transaction_receipt()      # typed accessor
params = result.parameters()                    # flat key→value map
segments, skipped = parse_balance_segments(params["AccountBalance"])
for seg in segments:
    print(seg.account_name, seg.currency, seg.available, seg.raw)
print(f"{skipped} malformed rows skipped")       # skipped + counted, never fatal
```

```go
var r mpesa.AsyncResult
json.Unmarshal(body, &r)
params := r.Result.Parameters()                  // map[string]string
receipt := params["TransactionReceipt"]
segs, skipped := mpesa.ParseBalanceSegments(params["AccountBalance"])
cls := r.Result.Classify()
```

TypeScript has no envelope parser class — `JSON.parse` the body yourself, then run the `AccountBalance` blob through `parseBalanceSegments(text)`.

Bind on `OriginatorConversationID` (echoed back in the result) before acting — these pushes are unsigned like everything else.

Per-endpoint specifics on the async result:

| Endpoint             | Result parameters worth reading                                   | Gotcha                                        |
|----------------------|-------------------------------------------------------------------|-----------------------------------------------|
| B2C                  | `TransactionReceipt`, `TransactionAmount`, `B2C*AvailableFunds`    | cannot be reversed via the Reversal API        |
| Transaction Status   | `TransactionStatus`, `ResultType`                                 | query key: receipt **XOR** original conversation ID |
| Reversal             | status + receipt echo                                             | C2B transactions only                          |
| Account Balance      | `AccountBalance` segment blob (see parser above), `BOCompletedTime`| charges account can run negative               |

### B2C prerequisites: InitiatorName + SecurityCredential

B2C, Transaction Status, Reversal and Account Balance require an API-operator **initiator** (created in the M-PESA portal) whose plaintext password is encrypted with the M-Pesa X.509 certificate (RSA PKCS#1 v1.5 — deliberately not OAEP — then base64). Cert validity dates are ignored by design; official certs ship long-expired. Use the matching environment's cert (`assets/certs/SandboxCertificate.cer` vs `ProductionCertificate.cer`).

| Language   | Helper signature                                                        |
|------------|--------------------------------------------------------------------------|
| Go         | `mpesa.SecurityCredential(certPEMorDER []byte, initiatorPassword string)` |
| Python     | `security_credential(cert_pem_or_der: bytes, initiator_password: str)`    |
| TypeScript | `securityCredential(initiatorPassword: string, certificatePem)` — **password first!** |

```python
from pathlib import Path
from mpesa import security_credential

cert = Path("assets/certs/SandboxCertificate.cer").read_bytes()   # PEM or DER
cred = security_credential(cert, os.environ["MPESA_INITIATOR_PASSWORD"])
ack = client.b2c_payout(B2CPayoutRequest(
    initiator_name=os.environ["MPESA_INITIATOR_NAME"],
    security_credential=cred,
    command_id=CommandID.BUSINESS_PAYMENT,
    amount=100,                     # KES 10–250000
    party_b="+254705912645",        # recipient MSISDN (party_a ← cfg.shortcode)
    remarks="payout order 42",      # 2–100 chars
    queue_time_out_url="https://example.com/mpesa/timeout",
    result_url="https://example.com/mpesa/result",
))
# ack is the queue ticket only — the verdict lands on result_url.
```

Same flow in Go:

```go
cred, err := mpesa.SecurityCredential(certBytes, os.Getenv("MPESA_INITIATOR_PASSWORD"))
ack, err := client.B2CPayout(ctx, mpesa.B2CPayoutRequest{
	InitiatorName: os.Getenv("MPESA_INITIATOR_NAME"), SecurityCredential: cred,
	CommandID: mpesa.CommandBusinessPayment, Amount: 100,
	PartyB: "+254705912645", Remarks: "payout order 42",
	QueueTimeOutURL: "https://example.com/mpesa/timeout",
	ResultURL:       "https://example.com/mpesa/result",
}) // PartyA ← cfg.Shortcode; OriginatorConversationID auto-generated when empty
```

### C2B: register URLs, then simulate a payment

Register your confirmation/validation endpoints once (production registration is effectively one-shot), then fake inbound payments in sandbox:

```python
client.c2b_register_url(C2BRegisterRequest(
    response_type=ResponseType.COMPLETED,   # accept payment if validation is unreachable
    validation_url="https://example.com/c2b/validation",
    confirmation_url="https://example.com/c2b/confirmation",
))
client.c2b_simulate(C2BSimulateRequest(
    command_id=CommandID.C2B_PAYBILL_ONLINE,
    amount=10,
    msisdn="254712345678",
    bill_ref_number="acct-42",              # required for the paybill direction
))
```

Sandbox only — simulation fails against production. Details: [docs/apis/c2b.md](docs/apis/c2b.md).

### Dynamic QR

Fully synchronous; returns a base64 QR payload. Valid `TrxCode`s: `BG` buy-goods, `WA` withdraw-at-agent, `PB` paybill, `SM` send-money, `SB` send-to-business.

```python
qr = client.generate_qr_code(QRCodeRequest(
    merchant_name="TEST SUPERMARKET",
    ref_no="Invoice 042",
    amount=1500,
    trx_code=QRTrxCode.PAYBILL,   # BG | WA | PB | SM | SB
    cpi="174379",                 # 5–12 digits
    size="300",
))
render(qr.qr_code)                # base64 image payload
```

### Error handling

Every non-2xx Daraja response raises/returns one typed error carrying four diagnostic fields — `status_code`, `error_code`, `error_message`, `request_id` (naming per language below). Fields are sanitized, so hostile gateway output can't inject control characters into your logs.

```python
try:
    client.stk_push(req)
except MpesaError as exc:   # exc.status_code / exc.error_code /
    log.warning(exc)        # exc.error_message / exc.request_id
    raise                   # str(exc): "mpesa: HTTP 500 <msg> [500.001.1001] requestId=..."
```

```go
resp, err := client.STKPush(ctx, req)
var merr *mpesa.Error       // merr.StatusCode / merr.ErrorCode /
if errors.As(err, &merr) {  // merr.ErrorMessage / merr.RequestID
    log.Print(merr)
}
```

```ts
try { await client.stkPush(req); }
catch (err) {
  if (err instanceof MpesaError) log(err.statusCode, err.errorCode, err.errorMessage, err.requestId);
  else throw err;
}
```

`401.003.01` (invalid/expired token) is handled **transparently**: the client force-refreshes its cached token under a generation guard and retries the business call exactly once. You never see the mid-flight 401 — only a final failure if the retry also fails. See [docs/apis/oauth.md](docs/apis/oauth.md).

## Security model

- **Callbacks and async results are unsigned** — anyone who can reach your endpoint can forge a payload. Harden with unguessable URL tokens, `CheckoutRequestID`/`OriginatorConversationID` binding, field validation, and the [gateway IP whitelist](docs/apis/getting-started.md#callback-source-ip-whitelist).
- **Secrets are redacted in every text form** of `Config` and credential-bearing requests — but `pickle`/`asdict`/raw struct copies still carry them; redact at the log boundary.
- **Tokens live in memory only**, generation-guarded against cross-replica invalidation; nothing touches disk.
- **Transport is hardened**: TLS verification forced on injected sessions (Python), redirects refused (all engines), response sizes capped.

## Behavior guarantees

| Guarantee            | Detail                                                                                     |
|----------------------|--------------------------------------------------------------------------------------------|
| Default timeout      | 30 s per request; values ≤ 0 are clamped back to 30 s in all three engines                   |
| Response cap         | Bodies larger than **1 MiB** are rejected before any parsing                                 |
| Redirect refusal     | 307/308-style redirects are never followed (they would replay bodies at an arbitrary host)   |
| Token caching        | Cached bearer refreshed eagerly and single-flight; a generation guard resolves `401.003.01` across replicas without stampedes, and the failed call is retried once with the fresh token — transparently |
| Concurrency          | Go `Client` is safe to share across goroutines; Python `TokenManager` is lock-synchronized; TypeScript dedups refreshes via a shared in-flight promise |
| Value semantics      | Request objects are copied, never mutated — injected defaults stay local to the call          |
| Secret hygiene       | `Config`/request reprs redact `consumerSecret`, `passkey`, `securityCredential`, tokens      |

## Wire-format quirks — handled by the SDK

Listed so log inspection doesn't panic you; the SDKs emit/accept these verbatim:

- **`Occassion`** — double-s on B2C; single-s **`Occasion`** on Transaction Status; STK Push sends neither.
- **`RecieverIdentifierType`** — Reversal's misspelled wire key, defaulted to `"11"` (organization shortcode).
- **`OriginatorCoversationID`** — the C2B register ack misspells it (missing 's'); parsed as-is.
- **`expires_in`** — OAuth TTL arrives as the string `"3599"`, coerced internally (`FlexInt64` / `expires_in_seconds`).

## Project layout

```
.
├── go/                     # Go engine (module github.com/anthrodjear/mpesa-sdk/go) — examples/stk_push/, testdata/
├── python/                 # PyPI mpesa-sdk — mpesa/ package, examples/, tests/
├── typescript/             # npm @mpesa-sdk/core — src/, examples/, test/
├── docs/apis/              # per-endpoint reference — source of truth for wire contracts
├── assets/certs/           # SandboxCertificate.cer · ProductionCertificate.cer
├── .github/workflows/      # ci.yml — vet + test matrix for all three engines
├── ADR-010-m-pesa-adapter.md
└── LICENSE
```

## Development & testing

| Engine     | Commands                                                              |
|------------|-----------------------------------------------------------------------|
| Go         | `cd go && go vet ./... && go test -v -count=1 ./...`                   |
| Python     | `cd python && pip install -e ".[dev]" && python -m pytest tests -v`    |
| TypeScript | `cd typescript && npm ci && npm run typecheck && npm test`             |

CI (GitHub Actions) runs all three suites in parallel on every push and pull request to `main` — Go vet + tests on Go 1.22, pytest on Python 3.11, and typecheck (including examples) + vitest on Node 20. See [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

## Documentation index

- [getting-started.md](docs/apis/getting-started.md) — environments, SecurityCredential recipe, callback URLs & IP whitelist, go-live checklist
- [stk-push.md](docs/apis/stk-push.md) — prompt fields, two-clock bug, ResultCode catalog · [stk-query.md](docs/apis/stk-query.md) — polling semantics
- [b2c.md](docs/apis/b2c.md) — payout flow, initiator rules, async Result shape · [c2b.md](docs/apis/c2b.md) — registration + simulation
- [transaction-status.md](docs/apis/transaction-status.md) · [reversal.md](docs/apis/reversal.md) — receipt/conversation queries · C2B-only reversal
- [account-balance.md](docs/apis/account-balance.md) — balance blob parsing · [dynamic-qr.md](docs/apis/dynamic-qr.md) — TrxCode matrix
- [oauth.md](docs/apis/oauth.md) — token TTL, invalidation-on-refresh, generation guard

## FAQ

**`expires_in` looks like `"3599"` — is that broken?**
No. Daraja sends the OAuth TTL as a string; the SDKs coerce it internally (Go `FlexInt64`, Python `expires_in_seconds`, TS documents `expiresIn: string`). Parse leniently if you call OAuth yourself.

**Why is my callback unsigned?**
Safaricom sends no HMAC on any callback. Protect the endpoint yourself: unguessable URL paths, CheckoutRequestID binding, amount/phone validation, gateway IP allowlisting, immediate `200` ACKs.

**Can I run without callbacks?**
For synchronous endpoints yes. STK Push can be settled by polling `stk_query` instead. The async APIs require a reachable `ResultURL` — a missed push (503 ⇒ discarded, no redelivery) must be reconciled via Transaction Status queries.

**How do I test B2C in sandbox?**
Create the test initiator in the Daraja portal, encrypt its password with `SandboxCertificate.cer` via the credential helper above, keep amounts within KES 10–250 000, and tunnel `ResultURL`/`QueueTimeOutURL` to a public host.

**Why did I get INDETERMINATE instead of a clean failure?**
Because the truth is genuinely unknown: timeout-class codes can still settle minutes later, and auto-failing risks refunding money that actually moved. Persist the record and keep querying until a terminal code arrives.

## License

MIT — see [LICENSE](LICENSE).
