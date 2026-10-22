# Known divergences

Engine behaviour the shared corpus in [`fixtures/`](fixtures/) CANNOT
express. A shared fixture carries ONE expectation for one body, so a body
the three engines treat DIFFERENTLY has no engine-independent expectation to
assert — and a fixture that weakened its expectation until it asserted
nothing would be worse than no fixture at all.

Each item below is therefore tracked here instead, and pinned by
engine-specific tests OUTSIDE the shared corpus.

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

- **Go** — `go/client.go`: `Config.ErrorLogger` is passed on BOTH legs. The
  business leg (`post`, `go/client.go:881`) and the OAuth leg (`refresh`,
  `go/client.go:738`) both hand it to `parseError`, so a non-envelope OAuth
  failure reaches the sink.
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
