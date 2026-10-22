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
