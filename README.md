# M-Pesa Daraja SDK

[![Go](https://img.shields.io/badge/Go-1.22+-00ADD8?logo=go&logoColor=white)](https://pkg.go.dev/github.com/mpesa-sdk/go)
[![Python](https://img.shields.io/badge/Python-3.11+-3776AB?logo=python&logoColor=white)](https://pypi.org/project/mpesa-sdk/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9+-3178C6?logo=typescript&logoColor=white)](https://www.npmjs.com/package/@mpesa-sdk/core)
[![CI](https://github.com/mpesa-sdk/mpesa-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/mpesa-sdk/mpesa-sdk/actions/workflows/ci.yml)

Production-grade, triple-language SDK for the Safaricom M-Pesa Daraja API.
One API contract, three native implementations — Go, Python, and TypeScript — sharing identical wire behaviour, test vectors, and safety guarantees.

## Languages

| Language | Package | Install | Module |
|----------|---------|---------|--------|
| **Go** | `github.com/mpesa-sdk/go` | `go get github.com/mpesa-sdk/go` | `mpesa` |
| **Python** | `mpesa-sdk` | `pip install mpesa-sdk` | `mpesa` |
| **TypeScript** | `@mpesa-sdk/core` | `npm install @mpesa-sdk/core` | `@mpesa-sdk/core` |

## Quick Start

### Go

```go
cfg := mpesa.Config{
    ConsumerKey:    os.Getenv("MPESA_CONSUMER_KEY"),
    ConsumerSecret: os.Getenv("MPESA_CONSUMER_SECRET"),
    Shortcode:      os.Getenv("MPESA_SHORTCODE"),
    Passkey:        os.Getenv("MPESA_PASSKEY"),
    Environment:    mpesa.Sandbox,
}
c := mpesa.NewClient(cfg)
resp, err := c.STKPush(ctx, mpesa.STKPushRequest{
    TransactionType: mpesa.TransactionTypePayBillOnline,
    Amount:          100,
    PartyA:          "254712345678",
    PhoneNumber:     "254712345678",
    CallBackURL:     "https://example.com/callback",
    AccountReference: "Order 42",
    TransactionDesc:  "test payment",
})
```

### Python

```python
from mpesa import Config, MpesaClient, STKPushRequest, TransactionType

cfg = Config(
    consumer_key=os.environ["MPESA_CONSUMER_KEY"],
    consumer_secret=os.environ["MPESA_CONSUMER_SECRET"],
    shortcode=os.environ["MPESA_SHORTCODE"],
    passkey=os.environ["MPESA_PASSKEY"],
)
client = MpesaClient(cfg)
resp = client.stk_push(STKPushRequest(
    transaction_type=TransactionType.CUSTOMER_PAY_BILL_ONLINE,
    amount=100,
    party_a="254712345678",
    phone_number="254712345678",
    call_back_url="https://example.com/callback",
    account_reference="Order 42",
    transaction_desc="test payment",
))
```

### TypeScript

```ts
import { Config, MpesaClient, TransactionType } from "@mpesa-sdk/core";

const cfg = new Config({
    consumerKey:    process.env.MPESA_CONSUMER_KEY!,
    consumerSecret: process.env.MPESA_CONSUMER_SECRET!,
    shortcode:      process.env.MPESA_SHORTCODE!,
    passkey:        process.env.MPESA_PASSKEY!,
});
const client = new MpesaClient({ config: cfg });
const resp = await client.stkPush({
    transactionType: TransactionType.BillPayGoods,
    amount: 100,
    partyA: "254712345678",
    phoneNumber: "254712345678",
    callBackURL: "https://example.com/callback",
    accountReference: "Order 42",
    transactionDesc: "test payment",
});
```

## API Coverage

All nine Daraja endpoints are fully implemented in every language:

| Endpoint | Go | Python | TypeScript |
|----------|:--:|:------:|:----------:|
| STK Push (Lipa Na M-Pesa Online) | ✓ | ✓ | ✓ |
| STK Query | ✓ | ✓ | ✓ |
| B2C Payment (v3) | ✓ | ✓ | ✓ |
| C2B Register URL | ✓ | ✓ | ✓ |
| C2B Simulate | ✓ | ✓ | ✓ |
| Transaction Status Query | ✓ | ✓ | ✓ |
| Reversal Request | ✓ | ✓ | ✓ |
| Account Balance Query | ✓ | ✓ | ✓ |
| Dynamic QR Code Generation | ✓ | ✓ | ✓ |

## Development

### Go

```bash
cd go
go vet ./...
go test -v -count=1 ./...
```

### Python

```bash
cd python
pip install -e ".[dev]"
python -m pytest tests -v
```

### TypeScript

```bash
cd typescript
npm ci
npm run typecheck
npm test
```

### CI

GitHub Actions runs all three test suites in parallel on every push and pull request to `main`. See [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

## Security

### Unsigned callbacks

The SDK does **not** validate inbound callback signatures. Protect your callback endpoints with:

- **HMAC verification** using a shared secret
- **IP allowlisting** for Safaricom's callback IP ranges
- **Replay protection** via `CheckoutRequestID` deduplication

### Credential handling

- `Config` objects mask secrets in `toString()` / `repr()` / `toJSON()` output
- Never log raw `Config` instances — use `log_safe()` (Python), `GoString()` (Go), or `toJSON()` (TypeScript)
- Tokens are cached in memory with generation-guarded refresh — no secrets touch disk

### Indeterminate results

When Daraja returns a timeout, an unknown `ResultCode`, or a callback status that is neither success nor failure, the SDK surfaces the raw result verbatim. **Never auto-fail or auto-retry** indeterminate results — reconcile them externally against your transaction records.

## Documentation

Full API documentation lives in [`docs/apis/`](docs/apis/):

- [Getting Started](docs/apis/getting-started.md) — authentication, credentials, IP whitelisting
- [STK Push](docs/apis/stk-push.md) — payment prompts, result codes, two-clock bug
- [B2C](docs/apis/b2c.md) — business-to-customer payments
- [C2B](docs/apis/c2b.md) — customer-to-business (register + simulate)
- [Transaction Status](docs/apis/transaction-status.md) — query by receipt or conversation ID
- [Reversal](docs/apis/reversal.md) — reverse completed transactions
- [Account Balance](docs/apis/account-balance.md) — query organization balance
- [Dynamic QR](docs/apis/dynamic-qr.md) — generate QR codes for M-Pesa payments
- [OAuth](docs/apis/oauth.md) — token lifecycle and invalidation semantics

## License

MIT
