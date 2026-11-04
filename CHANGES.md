# Changes — 0.7.1 (2026-11-04)

A **patch** release: no API or wire change — the only functional edits are
the version literals themselves. It exists so the **Go module's published
documentation** is correct at the tagged version: `go/v0.7.0` was cut before
the Go README's badge and endpoint table were updated, so that tag ships an
overview still reading 0.6.0 and listing only the original nine endpoints
(the generated package docs at v0.7.0 were already correct). Tags are
immutable once `sum.golang.org` records their hash, so this patch ships the
correction rather than re-pointing the old tag.

- `go/README.md`: version badge 0.6.0 → 0.7.1, the endpoint table gains the
  six new calls (`B2BPayment`, `TaxRemittance`,
  `BillRegister`/`BillQuery`/`BillUpdate`/`BillDelete`), and the intro
  counts the twelve families / fifteen calls.
- All six version literals + `package-lock.json` move together
  (the CI parity step enforces it, lockfile included).
- `@mpesa-sdk/core@0.7.1` is published to npm alongside this tag;
  `go get github.com/anthrodjear/mpesa-sdk/go@v0.7.1` resolves the corrected
  module.

---

# Changes — 0.7.0 (2026-11-03)

All three engines ship `0.7.0` together. A **minor** bump: new endpoints and
one new public type per family. Existing APIs are unchanged — `Config`,
`Config.Limits` and every existing method behave exactly as they did in
0.6.0 — so `^0.6.0` / `~=0.6.0` ranges will **not** auto-upgrade into it; pin
`0.7.0` explicitly.

## Features — three new endpoint families

- **B2B Express Checkout** — `POST /mpesa/b2b/v3/paymentrequest`
  (`B2BPayment` / `b2b_payment` / `b2bPayment`). `CommandID`
  `BusinessPayBill` · `BusinessBuyGoods`; the wire key is **`Initiator`**,
  not B2C's `InitiatorName`. [b2b.md](docs/apis/b2b.md)
- **Tax Remittance** — `POST /mpesa/b2b/v1/remittax`
  (`TaxRemittance` / `tax_remittance` / `taxRemittance`). `CommandID`
  `TaxRemittance` (a non-`TaxRemittance` value is rejected client-side in
  all three engines) plus `TaxPeriod`, `TaxObligation`, `TaxPayerPIN`.
  [tax-remittance.md](docs/apis/tax-remittance.md)
- **Bill Manager** — `POST /mpesa/billmanager/v1/{register,query,update,delete}`
  (`BillRegister`/`BillQuery`/`BillUpdate`/`BillDelete` and the snake/camel
  equivalents). No initiator or credential; `ShortCode` defaults to the
  configured shortcode; `billUpdate` is a partial update — Go spells "unset"
  `Amount: 0`, Python `amount=None`, TypeScript omits the key (TS rejects
  `amount: 0`). [bill-manager.md](docs/apis/bill-manager.md)

All six endpoints return the standard ACK envelope; Bill Manager adds
`BillAckResponse` with an optional `BillRefNumber` (absence is tolerated;
only Python's decoder enforces the four required keys).

## Security

- **PII and secret redaction**: `TaxPayerPIN` is treated as a secret and
  `PayerName`/`PayerNumber` as PII — masked in every rendered form (Go
  `GoString`/`Format`/`LogSafe`, Python `repr`, TypeScript `logSafeRequest` /
  `JSON.stringify`), while `BillRefNumber` stays visible as an identifier.
- **Spend controls**: dedicated `b2b` / `tax` / `bill` limit buckets (250,000
  per transaction / 500,000 per day by default) for BOTH the
  per-transaction ceiling and the daily ledger; `Default` overrides do not
  reach them; the reservation is refunded only when the request provably
  never reached the gateway — the same rule as every existing endpoint.
- Validation, SSRF-hardened URL checking, typed errors, the 1 MiB caps and
  the 401-retry-once path are the existing shared machinery — the new
  endpoints route through it rather than reimplementing any of it.

## Behavior notes

- Bill Manager's optional fields: a whitespace-only `PayerNumber`/
  `PayerName` is dropped from the wire (all three engines).
- Identifier types (`SenderIdentifierType`/`ReceiverIdentifierType`) default
  to `"4"` and are length-capped at 12 when supplied.
- `ExpiryDate` is shape-checked (≤ 10 chars); the gateway owns the date
  format. `TaxObligation` is free text, not an enum.

## Publishing

- **`@mpesa-sdk/core@0.7.0` published to npm** — the tarball ships the
  package README + LICENSE and the standard manifest metadata (keywords,
  author, repository, bugs, `publishConfig.access: "public"`); the
  `prepublishOnly` gate (build + full test suite) runs on every publish.
- The Go engine is tagged `go/v0.7.0`, in the subdirectory-module convention
  used by the earlier releases, so
  `go get github.com/anthrodjear/mpesa-sdk/go@v0.7.0` resolves through the
  module proxy and pkg.go.dev.

---

# Changes — 0.6.0 (2026-11-02)

All three engines ship `0.6.0` together. A **minor** bump, per the 0.x rule
0.4.0 already stated: under SemVer 0.x breaking changes increment the minor
version, so existing `^0.5.1` / `~=0.5.1` ranges will **not** auto-upgrade
into it — pin `0.6.0` explicitly. Two TypeScript public APIs changed their
observable behaviour, and one Go security fix changed when a daily
reservation is refunded; everything else is a bug fix toward the documented
contract.

## BREAKING

- **TypeScript `coerceAmount` accepts at most TWO fraction digits**
  (`coercion.ts`): `"10.123"` used to return `10.123` and now returns
  `null`, matching Python's `coerce_amount` (pinned there since 0.5.0). The
  3–6dp acceptance was a cross-engine drift that let the same wire body
  settle in one engine and be dropped in the other; `amount()` accessors on
  STK callbacks and async `Result` envelopes now report `null` for sub-cent
  values instead of a silently wrong number. This helper had no TypeScript
  test coverage at all before this release — it has some now.
- **TypeScript `Config` no longer requires a non-empty `passkey` at
  construction** (`config.ts`): a B2C-only merchant — who never calls STK
  Push/Query — can build a client without one. The requirement moved to
  where the passkey is actually used: `stkPush`/`stkQuery` throw
  `mpesa: Config.passkey is required for STK Push/Query (it is bound into
  the request Password)` before any network I/O. Go and Python already
  behaved this way, so this closes the "one contract" gap. Code that caught
  the construction-time `ConfigError` for a missing passkey must now handle
  the STK-path error (or set the passkey).

## Behavior changes

- **TypeScript `stkPush` validates `BusinessShortCode`/`PartyB` shape**
  (5–10 ASCII digits) before any network I/O — `stkQuery`, Go and Python
  already did, so a malformed shortcode used to reach the gateway and fail
  there as `500.001.1001`.
- **SSRF outcomes (TypeScript)**: trailing-dot hosts
  (`https://127.0.0.1../cb`) are rejected like every other engine;
  signed/malformed numeric hosts (`-1`, `+1`, `0xzz`) fail closed instead
  of being handed to the resolver as DNS names; and **IPv4-mapped IPv6
  hosts with a public tail (`https://[::ffff:8.8.8.8]/cb`) are now
  accepted** — the old first-hextet classifier refused every mapped host.
  Go/Python parity restored, and `SECURITY.md`'s "identical blocked set"
  claim is now true.
- **Go callback/result URLs with an out-of-range port** (`:99999`, `:0`,
  `:-1`) are rejected at validation instead of failing at dial time
  (Python parity).
- **Python `retry_on_unauthorized`** — added on `Config`, defaulting to
  `true`; `Config(retry_on_unauthorized=False)` surfaces the first
  `401.003.01` without the forced refresh and retry. Go spells it
  `Config.DisableRetryOnUnauthorized` (inverted) and TypeScript
  `MpesaClientOptions.retryOnUnauthorized`. The 0.5.0 changelog documented
  this option prematurely — it exists as of this release.
- **Python refuses a whitespace-only passkey**, matching Go
  (`strings.TrimSpace`) and TypeScript (`.trim()`).

## Security

- **TypeScript SSRF bypass closed**: appending one trailing DNS-root label
  to a numeric callback host (`http://127.0.0.1../cb`) bypassed both the
  numeric-literal normalization and the blocklist and reached `fetch` —
  confirmed pre-fix. The dot-strip now runs before every host guard,
  matching Go/Python ordering.
- **Go `stkQueryPayload` renders redacted**: it was the one
  credential-carrying type without `GoString`/`Format` hooks, so a
  `%v`/`%+v`/`%#v` render of the dispatched payload exposed the `Password`
  — base64(shortcode + passkey + timestamp), from which the long-lived
  `Config.Passkey` is directly recoverable.
- **Go daily-ledger rollback no longer refunds requests the gateway
  answered**: the classifier was "roll back unless the error is
  `*MpesaError`", so an oversize 2xx body and an undecodable 2xx both handed
  the reservation back — real day-spend could exceed `MaxPerDay` without
  bound. The rollback now fires only on the new `ErrNotDispatched`
  sentinel (a request that provably never got a gateway answer), which is
  Python's `RequestException` rule and fails closed for every future error
  type.
- **TypeScript `logSafeRequest(req)`**: request objects are plain
  interfaces, so `JSON.stringify(req)` used to print the live
  `securityCredential`; the new helper masks it and drops callback-token
  query strings (Go `LogSafe()` / Python redacting `repr()` parity).

## Docs

- README uses the canonical TypeScript enum names (`PayBillOnline`, not the
  deprecated `BillPayGoods` the SDK itself marks `@deprecated`); the enum
  cross-reference gains `ResponseType` and C2B `CommandID` rows, including
  the `c2bRegisterURL` trap that rejects TS's deprecated `Success`/`Fail`
  aliases.
- New **docs/testing.md**: the base URL is a two-entry allowlist by design,
  so the transport/clock injection seams (`Config.HTTPClient`/`Now`,
  `Config.http_client`/`now`, `MpesaClientOptions.fetch`/`.now`) are now
  documented as the mock-testing recipe.
- A "Choosing the environment" section replaces the overloaded
  `MPESA_ENVIRONMENT` table cell (the one knob whose accepted values differ
  per engine); the timeout placement note moves out of the config preamble;
  README snippets compile again (missing `import os`, undeclared
  `certBytes`, a `parseInt(res.ResultCode, 10)` type error).
- `contract/known-divergences.md` records the validation-strictness and
  typed-error divergences that shared fixtures cannot express;
  `docs/apis/oauth.md` no longer documents SDK methods that do not exist.

## CI

- The `python` job now checks that the five version literals
  (`go/version.go`, `python/setup.py`, `python/mpesa/__init__.py`,
  `typescript/package.json`, `typescript/src/index.ts`) agree, so one
  engine can no longer ship a stale version silently.

---

# Changes — 0.5.1 (2026-10-22)

- **Go 1.26.10** — updated toolchain (fixes CVE GO-2026-6809 in crypto/x509); CI updated.
- **npm audit vulnerabilities fixed** — 18 packages updated, 0 vulnerabilities remaining.
- **TypeScript example fixed** — uses `TransactionType.PayBillOnline` (replaces deprecated `BillPayGoods`).
- **Staticcheck fix** — `fmt.Sprint` → `fmt.Sprintf` in Go test to satisfy QF1010.
- **Go toolchain** — updated to 1.26.10 in CI (was 1.26.9).

# Changes — 0.5.0 (2026-10-22)

- **Reversal and Dynamic QR get their own limit buckets** (`reversal`, `qr`) instead of sharing `default` — for BOTH the per-transaction ceiling and the per-day bucket. Only affects users who had overridden `default` limits — their Reversal/QR now inherit the Safaricom defaults unless explicitly configured.
- **A numeric `errorCode` survives** — a gateway that sends `"errorCode": 401` as a number now yields `error_code == "401"` instead of `None`, and the generic "unexpected error response from gateway" message no longer replaces the envelope.
- **Balance rows beyond ±2⁵³ are skipped and counted** — an amount that cannot survive a float64 round-trip is dropped from the balance instead of being returned rounded, and the skipped count says how many were dropped.
- **`BillRefNumber` is required for PayBill simulations only** — a C2B simulate request for `CustomerPayBillOnline` must carry it; `CustomerBuyGoodsOnline` is unaffected (the key is omitted, not null).
- **`retryOnUnauthorized` (Go) / `retry_on_unauthorized` (Python) / `retryOnUnauthorized` (TypeScript) option added** — defaults to `true`; set to `false` to surface the first `401.003.01` without the automatic single retry. Go: `Config.DisableRetryOnUnauthorized` (inverse spelling); Python: `Config(retry_on_unauthorized=False)`; TS: `new MpesaClient({ ..., retryOnUnauthorized: false })` (`MpesaClientOptions`).
- **Daily budget refunded on transport error only** — a failed network request (timeout, connection error) no longer consumes the daily ceiling; gateway errors (4xx/5xx) still consume it. Mirrors the "attempt was made" principle. Doc: `docs/apis/limits.md:59-61`.
- **Refresh cadence floor raised to 60 seconds** across all three engines (was ~1 s) — a hostile/buggy gateway `expires_in` can no longer drive a sub-second OAuth storm.
- **Forward-only day rollover** — a backward clock step across Nairobi midnight can no longer silently reset the daily accumulator (fail-open → fail-closed).
- **Oversize responses are typed errors** — Go now returns a typed error with HTTP 413 semantics (matching TypeScript's `MpesaError(413)` and Python's `MpesaError(413)`); Go consumers can use `errors.As` to detect it.
- **STKQuery validates `BusinessShortCode` client-side** — parity with Python (was Go-only omission).
- **`MpesaClientOptions.errorLogger` option added (TypeScript)** — an opt-in sink for the RAW body of a non-2xx response whose body is NOT a Daraja error envelope (a WAF page, an HTML error page, a truncated body). It is called as `(statusCode, contentType, body)` and only on the non-envelope branch, so it is the single place upstream bytes can surface. A sink that throws synchronously, or whose returned promise rejects, is swallowed — it can never mask the gateway error the caller has to handle. The OAuth leg is minted by `TokenManager` and does NOT reach it (Go's OAuth leg DOES; Python has no client-level sink at all).
- **A non-envelope error body no longer rides along in the exception (TypeScript)** — **CHANGED**: `MpesaError.errorMessage` for a body that is not a Daraja error envelope is now the generic `unexpected error response from gateway` (the Go/Python wording), where it previously interpolated up to 200 characters of the upstream body. **Log parsers that matched on the old body text must be updated** — take the raw bytes from the new `errorLogger` option instead. The reason: an exception object is logged by every logger on the call path, so embedding upstream text shipped raw gateway payloads (customer MSISDNs, WAF internals) off-box.
- **A boolean error-envelope member is coerced to its JSON text (TypeScript)** — `{"errorCode": true}` now yields `errorCode === "true"` instead of `null`, matching Go `FlexString` and Python `_envelope_value`. A boolean is a value the gateway SENT — dropping it as if it were absent could lose the `requestId` the 401 retry probe keys on.
- **Certificates with an RSA key below 2048 bits are refused (all three engines)** — `securityCredential` (TypeScript), `SecurityCredential` (Go) and `security_credential` (Python) now ERROR on such a certificate, where they previously encrypted with it. The official M-Pesa certificates ship 2048-bit keys, so only a misconfigured or tampered certificate is affected; the error names the size actually found.
- **An 8-rune consumer key renders as `****` in Go (CHANGED log output)** — the first-4/last-4 mask used to render an 8-rune key as `abcd…efgh`, which was the WHOLE key (4 + 4 == 8) — the anchor handed back the secret it existed to hide. Go now collapses it to the fixed `****`, matching TypeScript. Do not scrape the consumer key out of logs.

# Changes — 0.4.0 (2026-10-13)

All three engines ship `0.4.0` together. This is a **minor** bump, per the
0.x rule `0.3.0` already stated: under SemVer 0.x, breaking changes increment
the minor version, so existing `^0.3.0` / `~=0.3.0` ranges will **not**
auto-upgrade into it — pin `0.4.0` explicitly. The headline is
**configurable transaction limits**: all three engines now refuse an amount
above a configured ceiling *client-side*, where before the gateway was the
only enforcer.

## BREAKING

- **Go minimum toolchain raised to 1.26.9** (`go/go.mod`,
  `.github/workflows/ci.yml`): the `go` directive and both `setup-go` pins move
  from `1.26.8` to `1.26.9` — the 1.26.9 patch fixes nine reachable
  standard-library CVEs the SDK calls into (GO-2026-6603/6605/6607/6608/6610/
  6611/6612/6613/6617 in `net/http`, `net/textproto`, `crypto/tls`), which is
  what fails the `govulncheck` gate on a 1.26.8 build. Consumers on an older
  patch must upgrade their Go install (or let `GOTOOLCHAIN=auto` fetch 1.26.9)
  before `go get` will resolve. A full patch floor, not `1.26`, on purpose —
  the 0.3.0 toolchain note explains why. No SDK API changed.

- **Amount ceilings are now enforced client-side.** The gateway used to be the
  only enforcer; each engine now refuses an amount above a per-service ceiling
  *before any network I/O* (default 250,000 KES per transaction for every
  bucket — STK Push, C2B, B2C, and the `default` bucket that also covers
  Reversal, Transaction Status and Dynamic QR). A flow that used to fail at the
  gateway now fails locally with a typed error naming the config path to raise;
  set the service ceiling to `0` (unlimited) to restore the old pass-through.
  Per-day ceilings apply only when daily tracking is switched on (off by
  default). Reference: `docs/apis/limits.md`.
- **B2C defaults to the published Safaricom caps** (250,000 per transaction,
  500,000 per day). A paybill on a Safaricom-approved higher tier must raise
  `b2c` explicitly instead of relying on the old in-flight 500k default.
- **A 401-triggered forced refresh now advances the OAuth rate-limit clock**
  (all three engines): a crash-loop of forced failures can no longer leave the
  window stale, so the next unforced refresh can now be refused with
  `refresh rate limited` where previously it never was.
- **`repr()`/`log_safe()` of Python `Config` masks the consumer key**
  (first-4/last-4), as Go and TypeScript already did — do not scrape it from
  logs.
- **Smaller break-shaped changes**: TypeScript oversize-response errors are now
  typed `MpesaError` (HTTP 413) and render `mpesa: HTTP 413 …`; TypeScript
  `Config.limits` is deep-frozen at construction (later mutation is a silent
  no-op); Python now validates `STKQueryRequest.business_short_code`
  client-side, rejects a naive `Config.now` under daily tracking, and rejects a
  non-numeric `timeout_seconds` with `ValueError` instead of `TypeError`; Go
  rejects an empty STK passkey client-side; callback URLs with an uppercase
  scheme (`HTTP://…`) are now accepted by the Python validator.

## Features

- **Configurable per-service transaction limits (all three engines)**
  (`go/limits.go`, `python/mpesa/limits.py`, `typescript/src/limits.ts`): every
  amount-carrying request is gated on a per-transaction ceiling and — only when
  daily tracking is switched on — a per-day ceiling, per service bucket: STK
  Push, C2B, B2C, and a `default` bucket that also covers Reversal, Transaction
  Status and Dynamic QR. Configuration is a **partial overlay** on the Safaricom
  baseline, resolved once when the client is built: a field left unset
  *inherits* the default, while an explicit `0` (`Limit(0)` in Go,
  `ServiceLimits(max_per_transaction=0)` in Python, `maxPerTransaction: 0` in
  TypeScript) means **unlimited**. A partially-filled config therefore cannot
  silently disarm a ceiling it never mentioned, and a merchant on an unlimited
  tier can still say so. Go reads `Config.Limits` (merged in `NewClient`),
  Python `Config(limits=...)`, TypeScript the `limits` option on `Config`. The
  per-transaction check runs before any network I/O, and a rejection is one
  typed error per engine (`*LimitError` / `ValueError` / `MpesaError` 400) that
  names the exact config path to raise, e.g. `Config.Limits.STK.MaxPerTransaction`.
- **Opt-in daily accumulation (all three engines)**: `Config.TrackDaily` (Go),
  `Config(track_daily=True)` (Python), `trackDaily` (TypeScript) — **off by
  default**. One process cannot observe the replicas that share its shortcode, so
  a local accumulator under-counts the platform-wide cap: treat it as a circuit
  breaker for the single worst-case process, not as a control. Check and
  increment are atomic in all three (Go's ledger mutex, Python's daily lock,
  TypeScript's synchronous gate), and the day rolls at Africa/Nairobi (UTC+3, no
  DST) midnight — the day Daraja's merchant reporting uses. A request rejected
  before dispatch consumes no quota; an amount that passes is consumed on
  attempt.
- **B2C default now the published Safaricom caps (all three engines)**
  (`docs/apis/b2c.md`): B2C defaults to 250,000 KES per transaction and 500,000
  KES per day, replacing the old hardcoded `[10, 250000]` per-transaction
  literal; the documented 10 KES minimum is unchanged. A merchant on a
  Safaricom-approved higher tier raises the ceiling explicitly through the
  config override above instead of waiting for an SDK release. The gateway stays
  the final authority — an amount above your tier still fails there with
  `ResultCode 3`.
- **TypeScript STK callback parser shipped** (`typescript/src/callbacks.ts`):
  `parseSTKCallback(raw)` accepts the full `{"Body":{"stkCallback":{…}}}`
  envelope **or** a bare `stkCallback` result object, measures the raw body in
  UTF-8 bytes and refuses anything over 1 MiB *before* `JSON.parse`, and raises a
  typed `MpesaDecodeError` (never a bare `SyntaxError`/`TypeError`) on a
  malformed shape. It returns a `StkCallback` with first-wins `metadata()`,
  `amount()`, `mpesaReceiptNumber()`, `transactionDate()`, `phoneNumber()`,
  `duplicateKeys()` and `classify()` — Go `ParseSTKCallback` / Python
  `StkCallbackResult.from_json` parity. This closes the entry the 0.2.0
  changelog left under "Deferred (need design first)".

## Security

- **OAuth refresh rate-limit clock hardened (all three engines)**
  (`go/client.go`, `python/mpesa/auth.py`, `typescript/src/auth.ts`): a
  401-triggered **forced** refresh still bypasses the guard, but it now also
  advances the attempt clock, so a crash-loop of forced failures can no longer
  leave the clock stale and let the next unforced refresh slip through the
  3-in-5s gate. A *refused* refresh is not an attempt, so it leaves both the
  clock and the failure counter untouched.
- **Forced-refresh bypass made safe (TypeScript)** (`typescript/src/auth.ts`):
  adoption is success-only — a forced refresh that finds an in-flight *unforced*
  refresh runs its own attempt rather than inheriting a rate-limited rejection,
  and that rejection is a typed `MpesaError` (HTTP 429) rather than a bare
  `Error`. The clock parity above now holds here too: a forced attempt advances
  the window like any other.
- **Go single-flight waiters honour their own context** (`go/client.go`): a
  caller blocked on another goroutine's in-flight refresh now selects on
  `ctx.Done()`, so a hung OAuth endpoint can no longer pin a waiter past its own
  deadline. The leader keeps refreshing; only the waiter returns.
- **Consumer keys masked in every rendered form (all three engines)**
  (`go/config.go`, `python/mpesa/config.py`, `typescript/src/config.ts`):
  `consumerKey` now renders first-4/last-4 in `GoString`/`Format`/`MarshalJSON`,
  in `repr()`/`log_safe()` and in `toString()`/`toJSON()`/`logSafe()`, while
  `consumerSecret` and `passkey` stay omitted. A consumer key authenticates
  every token request, so it is a secret rather than an identifier — see
  [SECURITY.md](SECURITY.md).
- **TLS verification posture made loud (Python)** (`python/mpesa/auth.py`): a
  `TokenManager` handed a session whose `verify` is falsy now warns
  (`UserWarning`) before any OAuth traffic. It never mutates `session.verify`
  itself — `MpesaClient` clones the injected session and forces `verify=True` on
  its own clone, so the guarantee stays client-side.
- **Callback URL validator edges (Python)** (`python/mpesa/requests_sync.py`):
  the scheme match is case-insensitive, and the zone-id strip is IPv6-only, so
  an IPv4 literal carrying a `%` suffix is no longer silently rewritten into a
  bare address ahead of the SSRF check.
- **Callback-token comparison is type-strict (Python)**
  (`python/mpesa/callback_token.py`): `callback_token_equal` returns `False` for
  any non-string operand instead of comparing across types.
- **Python wheels now ship the PEP 561 marker** (`python/mpesa/py.typed`,
  `MANIFEST.in`, `python/setup.py`): the `mpesa` package carries inline type
  annotations, and without the marker mypy/pyright resolve every import to
  `Any`. Installed consumers now get real checking against the SDK's types
  (sdist verified to include `mpesa/py.typed`).

# Changes — 0.3.0 (2026-10-01)

All three engines ship `0.3.0` together. This is a **minor** bump on purpose: under
SemVer 0.x, breaking changes increment the minor version. Publishing the breaking
changes below as `0.2.1` would have let existing `^0.2.0` / `~=0.2.0` consumers
auto-upgrade into an incompatible release — pin `0.3.0` explicitly.

## BREAKING

- **Go minimum toolchain raised to 1.26.8** (`go/go.mod`): the `go` directive moves
  from `1.22` to `1.26.8`, so consumers on an older patch must upgrade their Go
  install (or let `GOTOOLCHAIN=auto` fetch 1.26.8) before `go get` will resolve.
  No SDK API changed. The floor is a full patch version, not `1.26`, on purpose:
  the advisories that forced this bump are stdlib CVEs fixed *within* the 1.26
  line (`net/url` GO-2026-6218 and `crypto/tls` GO-2026-6090 are both fixed in
  1.26.6), so a `go 1.26` floor would still admit toolchains that carry them. See
  the Security entry below.
- **TypeScript `securityCredential` arg order swapped to `(certificatePem, initiatorPassword)` for Go/Python parity** (`helpers.ts`): swap your two call-site args. The old `(password, cert)` order now throws a fail-fast `TypeError`.
- **Go `Error` renamed to `MpesaError`**: update `var merr *mpesa.Error` to `*mpesa.MpesaError`. A deprecated `Error` type alias is kept for compatibility.

## Security

- **govulncheck now scans the toolchain we actually ship** (`.github/workflows/ci.yml`,
  `go/go.mod`): the `security` job built on Go 1.22 but scanned with `go-version:
  stable`, and govulncheck matches standard-library CVEs against the Go version
  that compiled the packages. Scanning the shipped line with a scanner built for a
  different release reported **zero** findings while that same code reached **28**
  reachable stdlib vulnerabilities under Go 1.22.12 — including
  `crypto/tls` handshake DoS, `crypto/x509` chain-building work, `encoding/asn1`
  recursion depth, `net/url` quadratic parse, and `net/http` request smuggling.
  The `security` job now uses one pinned `setup-go` (1.26.8) shared with the `go`
  job, `GOTOOLCHAIN: local` so the scanner can never silently fetch a different
  toolchain, and `go/go.mod` raises the floor so the guarantee holds for consumers
  too. No application code was reachable only through the old release, so this is
  a toolchain-floor change rather than a patch to the SDK.
- **`rsa.EncryptPKCS1v15` deprecation acknowledged, not "fixed"** (`go/helpers.go`):
  Go 1.26 marks the function deprecated as general crypto hygiene. Daraja
  specifies the initiator password as RSA/ECB/PKCS1Padding over the certificate's
  public key, so switching to OAEP would emit ciphertext Safaricom cannot decrypt.
  The call keeps PKCS#1 v1.5 with a scoped `//nolint:staticcheck` and an inline
  rationale; this is a wire-format constraint, not an oversight.

- **TLS SPKI certificate pinning, opt-in (Go)** (`go/client.go`, `go/config.go`):
  `PinSPKI(host, sha256SPKI)` registers an expected SubjectPublicKeyInfo hash;
  `Config.TLSPinningEnabled` installs a `VerifyPeerCertificate` callback that
  rejects any mismatch. Off by default — opt in per host you pin. Pinning is
  skipped while the chain fails ordinary verification, so it is additive to
  (never a replacement for) normal TLS validation. **Go only** in this release.
- **Token memory zeroing + explicit `Close()` (Go only)**: `go/client.go` is the
  only engine that erases token bytes. `setToken()` zeroes the previous buffer
  before replacement, and `Client.Close()` zeroes the cached bearer and clears
  its expiry. **Python's `MpesaClient.close()` releases the connection pool
  only** — it calls `self._session.close()` and performs no token erasure, so
  `TokenManager._token` is left intact. **TypeScript has neither**: no
  `close()` and no zeroing primitive. Consumers who need token erasure on
  shutdown should scope the client to a short-lived process or container.
- **Trusted base-URL allowlist (all three engines)** (`go/config.go`,
  `python/mpesa/auth.py`, `typescript/src/config.ts`, `typescript/src/auth.ts`):
  TypeScript enforces it in **both** files — `config.ts` at `Config`
  construction, `auth.ts` in the `TokenManager` constructor — so a
  hand-built `TokenManager` cannot bypass it. The OAuth leg
  sends `Basic key:secret` to `Environment.BaseURL()`, so a non-allowlisted base
  URL is now rejected at construction — before any credential leaves the process
  — rather than at request time. Only the two Safaricom hosts are accepted.
- **OAuth refresh rate limiting (all three engines)** (`go/client.go`,
  `python/mpesa/auth.py`, `typescript/src/auth.ts`): after 3 consecutive
  refresh failures a client refuses further OAuth attempts for a 5s window,
  breaking a crash-loop that would otherwise hammer the token endpoint. A
  401-triggered forced refresh still bypasses the limit. Documented for users
  in [docs/apis/oauth.md](docs/apis/oauth.md).
- **SSRF-hardened callback URL validation (all three engines)** (`go/requests.go`,
  `python/mpesa/requests_sync.py`, `typescript/src/client.ts`): `CallBackURL`
  (and every other SDK-supplied URL) rejects embedded `user:pass@` credentials,
  a bare `localhost`, and loopback/private/link-local/multicast/unique-local/
  unspecified IP literals — including IPv6 forms and `::ffff:`-embedded IPv4
  tails. Python reached full parity in this release: `requests_sync.py` gained
  `_BLOCKED_NETWORKS`/`_BLOCKED_EXACT`, `_ip_literals()` and
  `_non_routable_reason()`, enforced from `_url()` on both the sync and async
  credential paths, and `python/tests/test_url_ssrf_hardening.py` (293 lines,
  13 tests) pins the behaviour against the Go and TypeScript validators. Like
  the other two engines, this guards the host **literal** only — a DNS name
  that resolves to a private address still passes, so it is not a DNS-rebinding
  filter.
- **Generic error messages (all three engines)** (`go/errors.go`,
  `python/mpesa/exceptions.py`, `typescript/src/errors.ts`): non-2xx responses
  surface a generic caller-facing message; content-type, body snippets and
  response size stay in diagnostics instead of leaking into the returned error.
  Python and TypeScript additionally sanitize every wire-derived error field
  (Unicode Cc/Cf control runes stripped, length-capped) so a hostile gateway
  cannot inject control sequences into logs.

## CI

- Go tests now run under the **race detector** (`go test -race -count=1 ./...`).
- A dedicated **security** job runs `govulncheck ./...` (Go), `bandit -r mpesa/ -ll`
  (Python) and `npm audit --audit-level=high` (TypeScript). It is a **hard gate**:
  the job-level `continue-on-error` is gone, so a real finding fails the workflow,
  and a 10-minute timeout on the job is itself a failure rather than a silent pass.
- `develop` is promoted to `main` only on a green CI run (`promote.yml` opens the
  PR with auto-merge once the CI `workflow_run` concludes `success`), so the
  `go`, `python`, `typescript` and `security` jobs gate what lands on `main`. A
  fifth `required` job, running only on `pull_request`, is the check the `main`
  ruleset actually requires; it fails unless all four of those jobs concluded
  `success`, so a push run can no longer satisfy a `main` merge.

# Changes — 0.2.0 (2026-09-17)

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
STK poll helper, `{segments, skipped}` return change,
`client.ts`/`types.ts` module splits.

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
