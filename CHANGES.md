# Changes — audit fixes (unreleased)

All three suites pass: Go `go vet` + `go test` ✅ · Python `479 passed` ✅ ·
TypeScript `typecheck` + `403 passed` ✅.

## Second batch (re-review findings)

Security (act on these):

- **Go request `LogSafe()`** (`go/requests.go`): the four credentialed
  requests now expose `LogSafe()` (wire shape with
  `SecurityCredential:"[REDACTED]"`) — `json.Marshal(req)` still emits the
  live credential because the wire needs cleartext, so never log a raw
  request; use `LogSafe()`. `oauthTokenResponse` redacts the bearer
  (length-only). `Config.MarshalJSON` now uses an explicit safe struct
  (no `Now`/`HTTPClient` leak surface).
- **Go transport walk** (`go/client.go`): `InsecureSkipVerify` refusal now
  descends `Unwrap()` wrapper chains (tracing/retry transports); custom
  `RoundTrippers` must preserve verification and expose `Unwrap()`.
- **Python session trust boundary** (`client.py`): the injected-session clone
  deep-copies cookies, clears `auth`, snapshots `proxies`, forces
  `trust_env=False` (+`verify=True` as before) — env/netrc credentials and
  attacker proxies can no longer ride along.
- **`TokenManager` base-URL allowlist** (Python `auth.py`): only the two
  Safaricom hosts accepted; direct `TokenManager` use with any other URL
  raises before any `Basic key:secret` is sent. Prefer `MpesaClient`.
- **TS bounded async entry** (`types.ts`): new `parseAsyncResultJson`
  (1 MiB cap before `JSON.parse`) — never parse uncapped callback bodies.
- **TS RSA gate** (`helpers.ts`): non-RSA certs rejected, passwords over
  245 UTF-8 bytes rejected (RSA-2048 PKCS#1 v1.5 limit), never echoed.
- **Config colon/ASCII everywhere**: Python + TS `Config` now reject `:`
  in the key and non-ASCII credentials at construction (Go parity).

Behavior / parity (known changes):

- **Python `generate_qr_code` no longer mutates the caller** (`client.py`):
  copies before validating like the other 8 endpoints.
- **Python `mpesa/_limits.py`**: single `MAX_BODY_BYTES` + `check_body_size`
  + shared `read_capped` streaming reader; amount/phone lookups are O(1)
  dict gets (was O(k·n) re-scans).
- **TS `stkQuery` coerces numeric `ResultCode`** (`client.ts`, `types.ts`):
  `string | number` normalized via `String()`.
- **TS `transactionStatus` `""` gets defaults** (`client.ts`): `??` → `||`
  (Go/Py parity).
- **TS `Config.shortcode` optional** (`config.ts`): defaults to `""`.
- **TS `MetadataMap.duplicateKeys()`** added; `set()` deprecated;
  dead `OAUTH_PATH`/`requirePositive` deleted (`parseIntSafe` kept —
  public API); `ALL` memoized frozen statics; `MpesaEnum` frozen;
  sanitizer is now `/[\p{Cc}\p{Cf}]/u`; non-breaking aliases
  (`PayBillOnline`, `BuyGoodsOnline`, `TransactionReversal`,
  `B2CPayoutRequest`, `QRCodeRequest`).
- **Go classification quote order** (`classification.go`): `' "0" '`
  now succeeds (spaces→quotes→spaces).
- **Go `FlexInt64` accepts integral floats** (`coercion.go`): `3599.0`
  works like Python/TS.
- **Go balance parser hardened** (`results.go`): ASCII gate + NaN/Inf +
  `>2⁵³` rejection (Python parity).
- **`OriginatorConversationID` length enforced** (all three): non-blank,
  max 19 chars (contract `<20`); client auto-fill unaffected.
- **README fixes**: Go snippet handles the `NewClient` error return;
  enum table corrected (`TransactionTypeBuyGoodsOnline` /
  `CUSTOMER_BUY_GOODS_ONLINE` / `BuyGoodsOnline`; `QRTrxPaybill`);
  body cap worded as UTF-8 bytes.

Deferred (need design first): C2B validation/confirmation parsers,
STK poll helper, TS `parseSTKCallback`, `{segments, skipped}` return
change, `client.ts`/`types.ts` module splits.

## Security fixes (act on these)

- **Go `Config` JSON redaction** (`go/config.go`): added `MarshalJSON` —
  `json.Marshal(cfg)` now emits `"[REDACTED]"` for `ConsumerSecret`/`Passkey`.
  Previously only `fmt` verbs were redacted, so any structured log that
  JSON-encoded a `Config` shipped live secrets. Log via `Config` itself
  (never a shadow struct); raw struct copies still carry secrets.
- **Go refuses `InsecureSkipVerify` transports** (`go/client.go`): `NewClient`
  returns an error if the injected `*http.Transport` has
  `TLSClientConfig.InsecureSkipVerify=true` (fail-closed, Python `verify=True`
  parity). A test-only insecure transport can no longer silently reach
  production and MITM OAuth/callback traffic.
- **Go rejects `:` in `ConsumerKey`** (`go/config.go` `Validate`): the key is
  the OAuth Basic-auth username (`key:secret`); a colon splits credentials
  ambiguously at the gateway/proxy. Python/TS already gated this.
- **Python ingestion cap now measured in bytes** (`callbacks.py`,
  `results.py`, `responses.py`): `str` bodies are measured as UTF-8 bytes, not
  chars — 1M CJK chars (~3 MiB) can no longer bypass the 1 MiB bound
  (Go/TS byte parity).
- **TypeScript `securityCredential` arg guard** (`helpers.ts`): fail-fast
  `TypeError` when the first arg is not a string (catches the
  Go/Python `(cert, password)` vs TS `(password, cert)` order trap).
  Order is unchanged (`password` first); Go/Python keep `(cert, password)`.

## Behavior / parity fixes (known changes)

- **Go `AsyncResultBody.Parameters()` is now first-wins** (`go/results.go`):
  duplicate `Key` entries keep the FIRST value (was: last wins), matching
  `MetadataMap()`, Python and TypeScript. Duplicate-key payloads now resolve
  identically across SDKs.
- **Python shared `coerce_amount` + `first_wins`** (`coercion.py`): the two
  verbatim `amount()` implementations (callbacks/results) are now one helper;
  no behavior change, prevents future drift. `_ensure_validated` deduplicated
  (`requests_async.py` imports it from `requests_sync`).
- **TypeScript amounts must be whole numbers** (`client.ts`): new
  `requirePositiveInt` (`isInteger`-gated) on STK/B2C/Reversal/C2B-sim/QR
  amounts. Floats like `10.5` are now rejected (Go/Python + `stk-push.md`
  already required whole numbers).
- **TypeScript `parseAsyncResult` coerces numerics** (`types.ts`):
  numeric `ResultCode`/`ResultDesc` are `String()`-coerced instead of throwing
  (Go `FlexString` parity); `StkCallbackResult.ResultCode` is now
  `string | number` — normalize with `String()` before comparing.
- **TypeScript `ResponseType.Completed`/`Cancelled`** (`enums.ts`): wire-correct
  members added (Go/Py parity); `Success`/`Fail` kept as `@deprecated`
  aliases. `c2bRegisterURL` accepts all four and maps to the wire values.
- **TypeScript `C2BSimulateRequest.shortCode` optional** (`types.ts`,
  `client.ts`): cfg-shortcode default injected (Go/Py parity).
- **TypeScript `Config` allows empty shortcode** (`config.ts`): validated only
  when non-empty (Go/Py parity) for per-request shortcode flows.
- **TypeScript `isNumericString` widened to `{1,19}`** (`coercion.ts`):
  Go int64 / Python 19-digit parity; still route through `safeJsonInt` for the
  ±2⁵³ guard.
- **TypeScript balance parser hardened** (`types.ts`): ASCII digit gate before
  `parseFloat` (rejects `1_000`, `0x10`, Unicode digits — Python parity) and
  new `BalanceSegment.raw` field. Return stays `BalanceSegment[]`;
  a `{segments, skipped}` return is a planned breaking change (Go/Py already
  return the count).

## Docs

- Inline docs expanded everywhere touched: OWASP/PKCS#1 v1.5 rationale
  (OAEP recommended generally, v1.5 Daraja-mandated), 245-byte credential
  limit, EAT single-clock rule, unsigned-callback posture, wire-misspelling
  preservation (`Occassion`, `RecieverIdentifierType`,
  `OriginatorCoversationID`).
- **`.gitignore`**: added agent/skill/memory patterns (`.agents/`, `agents/`,
  `.skills/`, `skills/`, `.claude/`, `.opencode/`, `opencode.json*`,
  `.cursor/`, `MEMORY.md`, `memory/`, `state.md`, `context-snapshot.json`,
  `*.skill`) so assistant workspaces never get pushed to GitHub.
