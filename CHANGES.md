# Changes — audit fixes (unreleased)

All three suites pass: Go `go vet` + `go test` ✅ · Python `425 passed` ✅ ·
TypeScript `typecheck` + `353 passed` ✅.

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
