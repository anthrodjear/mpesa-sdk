# Known divergences

Engine behaviour the shared corpus in [`fixtures/`](fixtures/) CANNOT
express. A shared fixture carries ONE expectation for one body, so a body
the three engines treat DIFFERENTLY has no engine-independent expectation to
assert — and a fixture that weakened its expectation until it asserted
nothing would be worse than no fixture at all.

Each item below is therefore tracked here instead, and pinned by
engine-specific tests OUTSIDE the shared corpus.

## Validation strictness: shortcode/identifier shape enforcement is not uniform

**The divergence.** The same wire field is shape-checked in a different
subset of engines:

| Field | Shape enforced by | Rule |
|---|---|---|
| STK Push `BusinessShortCode` | Go, Python, TypeScript (0.5.1 patch: TS `stkPush` gained the check) | 5–10 ASCII digits |
| STK Push `PartyB` | Go, TypeScript — **not Python** (`STKPushRequest.validate()` never calls `_shortcode` for `party_b`) | 5–10 ASCII digits |
| STK Query `BusinessShortCode` | Go, Python, TypeScript | 5–10 digits; Go's model layer treats an EMPTY value as optional, Python's and TS's `validate()` require it (both clients inject the config shortcode first, so the difference is invisible on the client path and visible only to a direct `validate()` call) |
| B2C `PartyA` | Python only | 5–10 ASCII digits (Go/TS: non-empty only) |
| C2B Register/Simulate `ShortCode` | Python only | 5–10 ASCII digits (Go/TS: injected, unchecked) |
| TxStatus/Reversal identifier length caps | Python only | ≤ 64 printable chars, identifier types ≤ 12 |
| QR `Size` digit-length cap | Python only | ≤ 12 ASCII digits (Go/TS: numeric parse only) |
| URL port bounds | Go, Python, TypeScript | `0 < port ≤ 65535` (TS rejects `0` since the B2 review fix; `> 65535` via `new URL`) |

Consequence: an over-long or malformed value that is a *local* error in the
strict engine is a **gateway `500.001.1001` / `500.002.1001` rejection** in
the lenient ones. Nothing here is a correctness bug in any single engine —
each engine is self-consistent — but identical integration code fails at a
different layer depending on the language chosen.

**Why it is not a fixture.** A corpus fixture asserts one outcome per body;
this is a per-engine *policy* difference, not a wire value.

**What would close it.** Pick one rule per field and enforce it everywhere
(the Python shape is the strictest and the natural candidate), then express
it as an ordinary request-rejection fixture. Until then the divergences are
pinned by each engine's own validation tests.

## Typed error surface: transport/timeout/throttle paths are not typed

**The divergence.** The documented contract — *one typed error carrying
`status_code`/`error_code`/`error_message`/`request_id`* — holds for every
non-2xx gateway response in all three engines. It does NOT hold for:

- **Transport failures / timeouts** — Go wraps (`fmt.Errorf(... %w)`,
  `go/client.go` `post`), Python lets `requests.exceptions.RequestException`
  propagate untouched, TypeScript throws a plain `Error`. None is an
  `MpesaError`/`*MpesaError`/`MpesaError` subclass, so `errors.As` /
  `except MpesaError` / `instanceof MpesaError` cannot classify a
  `context.DeadlineExceeded` or a `Timeout` as an SDK error.
- **OAuth decode failure** — Go: bare `fmt.Errorf`; Python: `ValueError`;
  TypeScript: typed `MpesaDecodeError` (TS is the only typed one).
- **Refresh-rate-limited** — Go: bare `fmt.Errorf`; Python: typed
  `RefreshRateLimitedError` but without the four envelope fields;
  TypeScript: `MpesaError(429)` with the envelope fields null.
- **Oversize response** — Go: `*OversizeError` (typed but not `MpesaError`,
  and carries only `Path`); Python/TS: `MpesaError(413)` with the full shape.

**Why it is not a fixture.** These are *exception types on client-internal
paths*, not gateway wire values; the corpus asserts the error a caller
receives for a response body.

**What would close it.** Give every failure mode one carrier per engine —
either a typed SDK error with the four fields (null where meaningless) or a
documented exception-type contract in `docs/apis/` stating exactly which
type each path raises so callers can write one catch clause per engine.

## STK callback without `ResultDesc`

**The divergence.** A callback body that omits `ResultDesc`:

- **Go** — `go/callbacks.go`: `STKCallbackResult.ResultDesc` is a plain
  string field, so an absent key leaves it empty and `ParseSTKCallback`
  returns the callback.
- **Python** — `python/mpesa/callbacks.py`: `StkCallbackResult.from_json`
  lists `ResultDesc` among the required wire scalars and raises
  `ValueError("mpesa: unexpected STK callback shape: missing ResultDesc")`.
- **TypeScript** — `typescript/src/callbacks.ts`: `REQUIRED_SCALAR_KEYS`
  includes `ResultDesc`, so `StkCallback.parse` throws
  `MpesaDecodeError` naming the missing key.

**Why it is not a fixture.** The body has three outcomes — parses, raises,
raises — and the corpus asserts a single expected class, result code and
metadata map. Asserting "two engines raise" is an engine-specific claim,
not a wire contract.

**What would close it.** Align the three engines on one shape rule — either
Go requires `ResultDesc` too, or Python and TypeScript tolerate its
absence — and express the agreed behaviour as an ordinary fixture. Until
then the only executable pin is an engine-specific test outside the shared
corpus (`go/callbacks_test.go`, `python/tests/test_callbacks.py`,
`typescript/test/callbacks.test.ts`), and that pin must be kept in step
with this list.

## Error envelope with a non-scalar member

**The divergence.** An error body whose `errorCode` (or `requestId`, or
`errorMessage`) is a JSON ARRAY or OBJECT:

- **Go** — `go/errors.go`: `parseError` decodes the body into the
  `errorEnvelope` struct, and `FlexString.UnmarshalJSON` rejects an array
  or an object as a HARD error. The `json.Unmarshal` therefore fails for
  the WHOLE body, so every member is lost — the `requestId` and the
  `errorMessage` are dropped along with the offending `errorCode` — and
  the caller sees the generic "unexpected error response from gateway".
- **Python** — `python/mpesa/exceptions.py`: `from_response` coerces each
  member to its wire string form (strings pass through, numbers and
  booleans are rendered as their JSON text), so a non-scalar member counts
  as absent and the OTHER members survive.
- **TypeScript** — `typescript/src/errors.ts`: `coerceEnvelopeField` turns
  anything that is not a string or a number into `""`, so a non-scalar
  member counts as absent and the OTHER members survive.

On the ARRAY/OBJECT member this entry is about, Python and TypeScript
agree. A BOOLEAN member is no longer a divergence between them — see
"Error envelope with a boolean member — CLOSED" below.

**Why it is not a fixture.** The body has two different outcomes — Go loses
the whole envelope, Python and TypeScript keep the survivors — and the
corpus asserts ONE expected error code and error message for a body.
Asserting "Go loses the requestId too" is an engine-specific claim, not a
wire contract.

**What would close it.** Align the three engines on one envelope rule —
either Go decodes the members independently (decoding each envelope
member on its own, so one mistyped member cannot erase the others) or
Python and TypeScript abort the whole envelope as Go does — and express
the agreed behaviour as an ordinary fixture.

The Go side is pinned by `go/errors_test.go`
(`TestParseErrorArrayFieldFallsBackToGeneric`), which asserts that an
array `errorCode` costs the caller the whole envelope. The Python side is
pinned by `python/tests/test_exceptions.py`
(`test_non_scalar_envelope_member_counts_as_absent_while_others_survive`),
which asserts that an array or object member counts as absent while the
other members survive. The TypeScript side of the same body IS pinned too —
`typescript/test/errors.test.ts`
(`still counts an ARRAY or OBJECT member as absent while the others survive`)
asserts exactly that. (An earlier revision of this entry claimed that file
did not cover the body; it does.)

## Error envelope with a boolean member — CLOSED

**Status: CLOSED.** All three engines now render a boolean envelope member
as its JSON text, so this body has ONE outcome across the SDKs. The entry
stays here because the executable pin is still an engine-specific test
rather than a corpus fixture (see the last paragraph).

An error body whose `errorCode` (or `requestId`, or `errorMessage`) is a
JSON BOOLEAN:

- **Go** — `go/coercion.go`: `FlexString.UnmarshalJSON` falls through the
  string and number branches to the raw text, so `true` is rendered as the
  wire text `"true"` and the envelope survives.
- **Python** — `python/mpesa/exceptions.py`: `_envelope_value` renders a
  boolean as its JSON text (`"true"` / `"false"`), which is the same
  rendering Go produces.
- **TypeScript** — `typescript/src/errors.ts`: `coerceEnvelopeField` renders
  a boolean as its JSON text (`"true"` / `"false"`), the same rendering Go
  and Python produce.

**History.** The divergence was INTRODUCED by the D1 fix. Before it,
Python dropped a boolean member too, so Python and TypeScript agreed;
Python then moved to Go's rendering and the two engines disagreed. The
TypeScript D7 fix closed it by giving `coerceEnvelopeField` the boolean
branch — a boolean is a value the gateway SENT, not an absent member, and
dropping it could lose the `requestId` the 401 retry probe keys on.

**The pins.** Go's side is pinned by `go/coercion_test.go`
(`TestFlexStringBranches` covers `true`; `false` is covered by the `kept`
list in `TestFlexStringRejectsArraysAndObjects`), Python's by
`python/tests/test_exceptions.py`
(`test_boolean_envelope_member_becomes_its_json_text`), and TypeScript's by
`typescript/test/errors.test.ts`
(`renders a BOOLEAN envelope member as its JSON text (go/py parity)`).

**Why it is still not a fixture.** Now that the three engines agree, the
body COULD be expressed as an ordinary corpus fixture — that fixture is
not added in this phase (the shared corpus is frozen here), so the
executable pin remains the engine-specific test above.

## Error envelope with a non-finite number member

**The divergence.** An error body whose `errorCode` (or `requestId`, or
`errorMessage`) is the non-standard JSON literal `NaN`, `Infinity` or
`-Infinity`:

- **Go** — `go/errors.go`: `encoding/json` rejects `NaN`/`Infinity`
  outright (they are not JSON), so the `json.Unmarshal` of the WHOLE body
  fails and every member is lost — the `requestId` and the
  `errorMessage` are dropped along with the offending `errorCode` — and
  the caller sees the generic "unexpected error response from gateway".
- **Python** — `python/mpesa/exceptions.py`: Python's `json` decoder
  ACCEPTS the bare `NaN`/`Infinity` literals, so the body parses;
  `_envelope_value` then treats a non-finite member as ABSENT (the same
  defence in depth `mpesa.results` applies to balance floats) and the
  OTHER members survive.
- **TypeScript** — `typescript/src/errors.ts`: `JSON.parse` rejects
  `NaN`/`Infinity` outright, so the whole body fails to parse and every
  member is lost.

**Why it is not a fixture.** The body has two different outcomes — Go and
TypeScript lose the whole envelope, Python keeps the survivors — and the
corpus asserts ONE expected error code and error message for a body.
Asserting "Go loses the requestId too" is an engine-specific claim, not
a wire contract. The corpus loader cannot even carry such a body: the
fixture is not valid JSON, so Python's lenient decoder accepts it while
Go's and TypeScript's reject the FILE itself.

**What would close it.** Align the three decoders on one rule — either
Python rejects the non-standard literals (a strict `parse_constant` hook)
so all three engines lose the whole envelope, or Go and TypeScript accept
them member-wise so all three keep the survivors — and express the
agreed behaviour as an ordinary fixture.

The Python side is pinned by `python/tests/test_exceptions.py`
(`test_non_finite_float_member_counts_as_absent`), which asserts that a
`NaN`/`Infinity` member counts as absent while the other members survive.
Go and TypeScript lose the whole envelope by construction (their decoders
reject the literal before any member is read), so they need no
engine-specific pin for it.

## Error-log sink: the OAuth leg reaches it in Go only

**The divergence.** The opt-in diagnostic sink that receives the RAW body of
a non-2xx response whose body is NOT a Daraja error envelope (a WAF page, an
HTML error page, a truncated body) is wired differently by the three engines,
and the difference is observable on the OAuth leg:

- **Go** — `Client.post` and `Client.refresh`: `Config.ErrorLogger` is passed
  on BOTH legs; both hand it to `parseError`, so a non-envelope OAuth failure
  reaches the sink. (Symbol names instead of line numbers — line numbers have
  drifted with consecutive fixes.)
- **Python** — there is NO client-level sink at all. The only parameter is
  `MpesaError.from_response(..., error_logger=...)`
  (`python/mpesa/exceptions.py:171`), and `python/mpesa/client.py` never
  wires one — so no Python client reaches a sink, on either leg.
- **TypeScript** — `MpesaClientOptions.errorLogger`
  (`typescript/src/client.ts`) is wired into the business leg only
  (`MpesaClient._post`). The OAuth leg is minted by `TokenManager`
  (`typescript/src/auth.ts`), which has no sink, so a non-envelope OAuth
  failure never reaches it.

**Why it is not a fixture.** The sink is a caller-supplied callback, not a
wire value: the shared corpus asserts the error a caller receives, and
cannot assert "this callback was invoked with these bytes, on that leg".
The divergence is invisible to the corpus because the sink never changes the
error the caller gets — it is a diagnostic side channel only.

**What would close it.** Wire the sink onto the OAuth leg in TypeScript (and
onto a client-level option in Python), or drop it from the OAuth leg in Go,
and pin the agreed behaviour with an engine-specific test in each engine.

The Go side is pinned by `go/errors_test.go`
(`TestParseErrorLoggerReceivesDiagnostics`) and the TypeScript side by
`typescript/test/errors.test.ts` (`hands the raw body to the opt-in sink with
status and content type`). Python has no client-level sink to pin, so it has
no engine-specific test for this.

## Daily reservation on the 401-refresh transport failure

**Status: CLOSED — all three engines now refund.** The divergence it recorded
is gone: Go (`notDispatchedError` wrapping on the OAuth leg) and Python
(`RequestException` from `refresh_after_invalid_token`) refunded on a
401-refresh-leg transport failure, and TypeScript now matches — the `_post`
catch on the 401 retry fires `onTransportError` when the forced refresh fails
at transport (`typescript/src/client.ts`; pinned by
`typescript/test/limits.test.ts:860`, "REFUNDS the accrual when the
401-refresh leg transport-fails"). Both rule choices fail toward a
*conservative* local quota (one keeps more spend room, the other less); no
money-path corruption either way.

**The divergence, for the record.** All three engines refund the daily
reservation when the **cold-start** OAuth leg fails with a transport error
(no business request was sent). On the 401-retry path, the first business
attempt already received a gateway answer (the 401), so the engines differed
when the **forced refresh** then failed at the transport layer: TypeScript
kept the reservation — the documented rule was "refund only when no gateway
answer was received in this call" — while Go and Python refunded, classifying
the failure by its type, not by whether the call already saw a gateway answer.

**Why it is not a fixture.** A shared wire fixture cannot express a transport
failure inside the OAuth leg of a retry.

**What would close it.** Align the rule (Go/Python error-type classification) —
done via the M1 review finding (`typescript/src/client.ts` `_post`).

## Rate-limit attempt clock and free-text length units

- **Attempt clock:** Go advances `lastRefreshAttempt` only on refresh failure,
  Python and TypeScript stamp at attempt start and again on failure. During a
  slow/hung OAuth attempt the 3-failures/5 s gate measures from a different
  instant; all settle to the failure instant once the attempt completes.
- **Free-text cap units:** Go measures with `len(v)` (bytes), Python with
  `len(text)` (characters), TypeScript with `[...value].length` (code points).
  A 64-character multibyte `PayerName` is accepted by Python/TS and rejected
  by Go (stricter, not exploitable). Error-envelope caps likewise differ:
  512 bytes (Go) vs 512 characters (Python/TS). The **URL cap (8192)** is
  deliberately UTF-8 **bytes in all three** (`len(v)` /
  `len(value.encode("utf-8"))` / `Buffer.byteLength(value,"utf8")`) so the
  parser-work bound is identical; phone-error messages report length only
  with the engine's own unit wording (`bytes` Go, `characters` Py/TS).
- **Masked consumer-key rendering shape:** Go renders empty → `""`, ≤8 runes →
  `"****"`, 9+ → `first4…last4` (U+2026); Python keeps a same-length `"*"` run
  for 1–7 characters (documented as a deliberate Python-only shape); TypeScript
  uses ASCII `first4...last4`. Log-only cosmetic difference — the raw key is
  never emitted by any engine's redaction helpers.

Neither divergence changes a wire value or a gateway-visible outcome.
