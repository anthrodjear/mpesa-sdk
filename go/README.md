# mpesa — M-Pesa Daraja SDK (Go engine)

[![Go](https://img.shields.io/badge/Go-1.26.10+-00ADD8?logo=go)](https://pkg.go.dev/github.com/anthrodjear/mpesa-sdk/go)
[![version](https://img.shields.io/badge/version-0.7.0-blue)](https://pkg.go.dev/github.com/anthrodjear/mpesa-sdk/go)

A dependency-free Go client for the Safaricom **M-Pesa Daraja API** — standard
library only, no third-party imports. Covers all nine business endpoints plus
the OAuth token lifecycle, with the safety rules a payments SDK needs:
single-flight token refresh, 401-retry once, SSRF-hardened callback URLs,
redacted credential rendering, and fail-safe result classification.

This is the Go engine of a three-engine SDK; the wire contract is shared with
the [Python](https://pypi.org/project/mpesa-sdk/) and
[TypeScript](https://www.npmjs.com/package/@mpesa-sdk/core) engines.

## Install

```sh
go get github.com/anthrodjear/mpesa-sdk/go
```

Requires Go 1.26.10+ (the `go` directive in `go.mod` enforces it).

## Quick start

```go
package main

import (
	"context"
	"log"
	"os"

	mpesa "github.com/anthrodjear/mpesa-sdk/go"
)

func main() {
	client, err := mpesa.NewClient(mpesa.Config{
		ConsumerKey:    os.Getenv("MPESA_CONSUMER_KEY"),
		ConsumerSecret: os.Getenv("MPESA_CONSUMER_SECRET"),
		Shortcode:      os.Getenv("MPESA_SHORTCODE"),
		Passkey:        os.Getenv("MPESA_PASSKEY"),
		// Environment zero value is mpesa.Sandbox; mpesa.Production when live.
	})
	if err != nil {
		log.Fatal(err)
	}
	defer client.Close()

	resp, err := client.STKPush(context.Background(), mpesa.STKPushRequest{
		TransactionType:  mpesa.TransactionTypePayBillOnline,
		Amount:           100,
		PartyA:           "254712345678",
		PhoneNumber:      "254712345678",
		CallBackURL:      "https://example.com/stk/callback",
		AccountReference: "Order42",
		TransactionDesc:  "test",
	})
	if err != nil {
		log.Fatal(err)
	}
	log.Println(resp.ResponseCode, resp.CheckoutRequestID, resp.CustomerMessage)
}
```

Accepted ≠ paid: `ResponseCode "0"` means Daraja queued the prompt. The
verdict arrives on your `CallBackURL` — or poll `STKQuery`. See
[stk-push.md](https://github.com/anthrodjear/mpesa-sdk/blob/main/docs/apis/stk-push.md).

## Endpoints

| Call | Wire endpoint |
|---|---|
| `STKPush` | `/mpesa/stkpush/v1/processrequest` |
| `STKQuery` | `/mpesa/stkpushquery/v1/query` |
| `B2CPayout` | `/mpesa/b2c/v3/paymentrequest` |
| `C2BRegisterURL` | `/mpesa/c2b/v2/registerurl` |
| `C2BSimulate` | `/mpesa/c2b/v2/simulate` |
| `TransactionStatus` | `/mpesa/transactionstatus/v1/query` |
| `Reversal` | `/mpesa/reversal/v1/request` |
| `AccountBalance` | `/mpesa/accountbalance/v1/query` |
| `GenerateQRCode` | `/mpesa/qrcode/v1/generate` |

OAuth (`/oauth/v1/generate`) is handled internally: the client caches the
bearer, refreshes eagerly on an `expires_in`-derived cadence (TTL − 60 s,
clamped to `[60s, 50min]`) under a single-flight leader, and retries a call
exactly once after a forced refresh on `401.003.01`. Opt out with
`Config.DisableRetryOnUnauthorized`.

## What the SDK handles for you

- **Callbacks are unsigned** — settle only via `STKQuery` bound to your stored
  `CheckoutRequestID`; gate endpoints with `NewCallbackToken()` /
  `CallbackTokenEqual()`; bind on the ID for dedup, never as authentication.
- **SSRF-hardened URLs** — `CallBackURL`/`ResultURL`/`QueueTimeOutURL` reject
  loopback, private, link-local, multicast and unusual IPv6 literals,
  `user:pass@` credentials, and every `inet_aton` alias (`0x7f000001`,
  `017700000001`, `2130706433`, `127.1`) before dispatch.
- **Fail-safe classification** — only result code `0` is success; unknown or
  timeout-class codes (1001, 1037, …) are indeterminate, never auto-failed.
- **Transport hardening** — TLS verification enforced (an injected transport
  with `InsecureSkipVerify` is refused at construction), redirects never
  followed, response bodies capped at 1 MiB, opt-in SPKI certificate pinning.
- **Configurable transaction limits** — per-transaction and opt-in per-day
  ceilings, resolved once at construction; a nil field inherits the Safaricom
  baseline, `mpesa.Limit(0)` is the explicit "unlimited".
- **Credential hygiene** — `Config`, `Client`, `oauthTokenResponse` and every
  credential-bearing type (including the STK Query dispatch payload) render
  redacted under `%v`/`%+v`/`%#v` via `GoString`/`Format`; `Close()` zeroes the
  cached bearer.

## Testing

Transport and clock are injectable (`Config.HTTPClient`, `Config.Now`), and
the base URL is a two-entry allowlist by design — so point your tests at a
mock through the injected `*http.Client` rather than a custom base URL. See
[testing.md](https://github.com/anthrodjear/mpesa-sdk/blob/main/docs/testing.md).

Run the suite:

```sh
cd go && go vet ./... && go test -race -v -count=1 ./...
```

## Documentation

Per-endpoint wire contracts are the source of truth:
[docs/apis/](https://github.com/anthrodjear/mpesa-sdk/tree/main/docs/apis) ·
full package docs on
[pkg.go.dev](https://pkg.go.dev/github.com/anthrodjear/mpesa-sdk/go).

## License

MIT — see [LICENSE](https://github.com/anthrodjear/mpesa-sdk/blob/main/LICENSE).
