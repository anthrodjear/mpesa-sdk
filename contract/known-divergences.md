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

Today only the Go side is pinned: `go/errors_test.go`
(`TestParseErrorArrayFieldFallsBackToGeneric`) asserts that an array
`errorCode` costs the caller the whole envelope. The Python and
TypeScript sides of the same body have no pin yet, and the files that
would carry one (`python/tests/test_exceptions.py`,
`typescript/test/errors.test.ts`) are outside the scope of the contract
harness. Add them when the divergence is next touched.
