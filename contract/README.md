# Contract fixtures

The shared wire contract for the M-Pesa Daraja SDK, in one place.

The repository README promises "identical wire behaviour, identical test
vectors" across Go, Python and TypeScript. This directory is where that
promise is ENFORCED: every file below is read by all three test suites
(`go/contract_test.go`, `python/tests/test_contract.py`,
`typescript/test/contract.test.ts`), and CI fails if any engine disagrees.

The corpus is deliberately small and deliberately SHARED. Each engine
hand-writes its own payloads, and that is exactly how the engines drifted:
the Python engine DROPPED a numeric error-envelope member, so the typed
error a caller received lost the gateway's error code (`error_code` was
`None` instead of `"401"`) while the envelope's other members survived.
(The 401 retry probe is NOT affected: it keys on the DOTTED code
`401.003.01`, which a numeric member would never have matched anyway, so
Go and Python behave identically there.) The Python engine also never grew
the 2**53 balance gate Go and TypeScript already had. A fixture the three
engines read cannot drift the same way twice — the second engine to
disagree fails the build.

Engine behaviour the corpus CANNOT express is tracked separately in
[`known-divergences.md`](known-divergences.md).

## Schema

```json
{
  "id": "stk-callback-success",
  "kind": "stk_callback",
  "body": { "Body": { "stkCallback": { "ResultCode": "0" } } },
  "expect": {
    "class": "success",
    "resultCode": "0",
    "metadata": { "Amount": 100 }
  }
}
```

### Top-level fields

| Field | Meaning |
|---|---|
| `id` | Unique, kebab-case. Used as the sub-test name in all three engines. A duplicate id is a hard failure in all three harnesses: two identically named sub-tests would mean one of them is not the case the author meant. |
| `kind` | `stk_callback` \| `balance_segment` \| `error_envelope`. |
| `statusCode` | For `error_envelope`: the HTTP status the harness FEEDS the engine. An INPUT, not an expectation — the harness never asserts on it, because asserting that the engine echoed back the status it was given can never fail. `0` is not a real HTTP status and is rejected by all three harnesses. |
| `body` | The raw wire body — see "The raw-body rule" below. For `balance_segment` it is `{"text": "<blob>"}`; for `error_envelope` it is the raw response body. |

### Expectation fields (`expect`)

| Field | Meaning |
|---|---|
| `expect.class` | `success` \| `failure` \| `indeterminate` (wire-level names, identical in all three engines). |
| `expect.resultCode` | Normalised result code string. |
| `expect.metadata` | Expected metadata map. Numbers compare numerically; everything else compares as a trimmed string. |
| `expect.errorCode` | For `error_envelope`: the expected `errorCode`. `null` means "absent". |
| `expect.errorMessage` | For `error_envelope`: the expected `errorMessage`, or `null`. |
| `expect.segments` | For `balance_segment`: expected number of parsed rows. |
| `expect.skipped` | For `balance_segment`: expected number of skipped rows. |

Only the fields the `kind` uses are asserted; the others are ignored, so a
case never asserts a value it does not care about. Every field a kind
REQUIRES is presence-checked: a fixture that forgets one is a BROKEN
fixture, and all three harnesses fail loudly on it (naming the fixture and
the missing field) rather than decoding it into a zero that would let the
case pass while asserting nothing.

## The raw-body rule

`body` is what the engine SEES on the wire, and its JSON type carries that
distinction:

- a JSON **string** body IS the raw body text — the engines receive those
  bytes verbatim. This is how a WAF page, an HTML error page or any other
  non-JSON gateway output enters the corpus.
- a JSON **object** body is the raw JSON document — the engines receive the
  serialised object.

The three harnesses implement this identically: Go takes the raw JSON bytes
of the fixture file, Python re-serialises the decoded object (or encodes the
string), TypeScript uses `JSON.stringify`. A body that is quoted JSON is a
DIFFERENT wire body from the same JSON unquoted, and the corpus must be able
to express both.

## The content-type rule

The content type the transport would have reported is derived from that SAME
raw text, by the same rule in all three harnesses: **skip the leading ASCII
whitespace — space, tab, CR, LF, and nothing else — then look at the first
byte.** `{` or `[` means `application/json`; anything else (a WAF page, an
HTML error page, a bare scalar) means `text/html`.

The leading set is ASCII-only on purpose. Unicode whitespace (NBSP) and a
UTF-8 BOM are NOT whitespace here: the rule describes the ASCII framing of
an HTTP body, and a body that starts with a BOM is a DIFFERENT wire body.
All three harnesses skip exactly this set, so the three engines receive
identical inputs for the same fixture.

The fixture's JSON type must not decide the content type either — a `body`
that is the string `"42"` IS the raw wire text `42`, which is not JSON —
because the three engines must receive identical inputs for the same
fixture.

## Class names

`expect.class` uses the wire-level names, which are identical in all three
engines:

| Wire value | Go | Python | TypeScript |
|---|---|---|---|
| `success` | `ResultClassSuccess` (a `ResultClass`, itself a `string` type) | `ResultClass.SUCCESS.value` | `ResultClass.SUCCESS` |
| `failure` | `ResultClassFailure` | `ResultClass.FAILURE.value` | `ResultClass.FAILURE` |
| `indeterminate` | `ResultClassIndeterminate` | `ResultClass.INDETERMINATE.value` | `ResultClass.INCONCLUSIVE` |

TypeScript's MEMBER name is `INCONCLUSIVE` but its VALUE is
`"indeterminate"`, matching Go and Python: the three engines serialise the
same wire string even though the TypeScript spelling differs.

## Comparing metadata

`expect.metadata` is compared KEY BY KEY, and only the keys the fixture
lists are checked — an engine that invents an extra key is not failed by
this corpus.

The VALUE comparison is type-tolerant on purpose. Safaricom encodes the same
metadata differently from one capture to the next (`"Amount": 100` in one,
`"Amount": "100"` in the next), and a harness that compared the JSON types
would fail a correct engine. So: when BOTH sides are numeric they are
compared NUMERICALLY; otherwise they are compared as trimmed strings.

A value counts as numeric when it is a JSON number, or when it is a STRING
whose trimmed text matches the plain-decimal grammar:

```
^-?\d+(\.\d+)?$
```

— optional sign, digits, optional fractional part. The grammar is
deliberately plain-decimal-only: Go's `strconv.ParseFloat` also accepts
`"Inf"`, `"NaN"` and `"0x1p-2"`, Python's `float()` also accepts `"inf"` and
`"nan"`, and TypeScript's `Number()` also accepts `"0x10"` and `"1e3"`.
Three permissive parsers would classify the same metadata text three
different ways, so all three harnesses apply THIS grammar instead, and
everything it rejects compares as a string.

Booleans, objects and null are OUT OF SCOPE for metadata comparison: they
compare as strings, and the three engines render them differently (Go
prints `map[...]`, Python prints `{'a': 1}`, TypeScript prints
`[object Object]`), so no shared expectation could hold for all three. A
fixture must not use them.

Duplicate metadata names resolve FIRST-WINS in all three engines (Go
`MetadataMap`, Python `metadata()`, TypeScript `MetadataMap`), so a
duplicate-key fixture expects the FIRST value.

## The corpus

| Fixture id | Kind | What it pins | State |
|---|---|---|---|
| `stk-callback-success` | `stk_callback` | Success class; an **integer** `ResultCode` (the documented STK Push encoding, `docs/apis/stk-push.md`); the metadata map, including `TransactionDate` | green everywhere |
| `stk-callback-indeterminate` | `stk_callback` | An unknown code stays INDETERMINATE — never auto-failed, never auto-refunded | green everywhere |
| `stk-callback-duplicate-metadata` | `stk_callback` | Duplicate metadata names resolve FIRST-WINS | green everywhere |
| `stk-callback-amount-as-string` | `stk_callback` | A numeric metadata STRING is the same money as the number ("100" vs 100) | green everywhere |
| `stk-callback-amount-not-plain-decimal` | `stk_callback` | The metadata value stays the string `"1e3"` — a value the plain-decimal grammar rejects — and matches the expectation textually | green everywhere |
| `balance-over-2p53` | `balance_segment` | A balance beyond 2**53 is SKIPPED and counted, never returned rounded | **red in Python (D3)** |
| `error-envelope-numeric-code` | `error_envelope` | A numeric `errorCode` is coerced to its wire string form | **red in Python (D1)** |
| `error-envelope-unparseable` | `error_envelope` | A non-JSON body yields the generic message and NO error code | **red in TypeScript (D7)** |

## Expected red state

The corpus is RED in two engines until the corresponding defects are fixed,
and that redness is the point: it is the visible proof that the defect is
still there.

| Case | Red in | Defect |
|---|---|---|
| `error-envelope-numeric-code` | Python | D1 — a numeric envelope member is dropped, so the typed error loses the gateway's error code |
| `balance-over-2p53` | Python | D3 — no 2**53 gate, so an unrepresentable balance is returned rounded |
| `error-envelope-unparseable` | TypeScript | D7 — the raw upstream body is embedded in the exception text |

Those cases are NOT marked `xfail` and NOT skipped: they must keep failing
loudly, so the moment the fix lands the case turns green and the change is
visible in the diff. **The branch carrying them is therefore EXPECTED TO
FAIL CI until the fixes land.**

Everything else in the corpus is green in all three engines.

## Adding a case

1. Add the JSON file here.
2. Add a row to each engine's dispatch table if it needs a new `kind`.
3. Run all three suites. A case that passes in one engine and fails in
   another is either an engine drift bug or a wrong expectation — decide
   which by checking the Daraja wire contract (`docs/apis/`), then fix
   whichever is wrong.
4. Every behavioural fix in the release must land with its fixture case, so
   the fix is pinned in all three engines at once.

Point 4 is the whole point of this directory. A defect fixed in one engine
without a fixture is a defect the other two engines are still free to
reintroduce; a defect fixed WITH a fixture cannot be.

### Authoring notes

- `stk_callback` bodies must carry all four wire scalars —
  `MerchantRequestID`, `CheckoutRequestID`, `ResultCode`, `ResultDesc` —
  because the Python and TypeScript parsers reject a callback that is
  missing any of them (Go tolerates an absent `ResultDesc`, so a body
  without one would make the corpus engine-dependent — see
  [`known-divergences.md`](known-divergences.md)).
- `balance_segment` bodies are `{"text": "<blob>"}`; the blob is the
  `|`-separated row text the Account Balance result carries, with rows
  joined by `&`.
- TypeScript's `parseBalanceSegments` returns ONLY the kept rows — it has
  no skipped counter (Go and Python do) — so `expect.skipped` is asserted
  by Go and Python alone.
- Fixture ids must be unique: all three harnesses fail loudly on a
  duplicate.
