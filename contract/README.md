# Contract fixtures

The shared wire contract for the M-Pesa Daraja SDK, in one place.

`README.md:8` promises "identical wire behaviour, identical test vectors"
across Go, Python and TypeScript. This directory is where that promise is
ENFORCED: every file below is read by all three test suites
(`go/contract_test.go`, `python/tests/test_contract.py`,
`typescript/test/contract.test.ts`), and CI fails if any engine disagrees.

The corpus is deliberately small and deliberately SHARED. Each engine
hand-writes its own payloads, and that is exactly how the engines drifted:
the Python engine dropped numeric error-envelope members (so its 401 retry
never fired) and never grew the 2**53 balance gate Go and TypeScript
already had. A fixture the three engines read cannot drift the same way
twice — the second engine to disagree fails the build.

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
| `id` | Unique, kebab-case. Used as the sub-test name in all three engines. |
| `kind` | `stk_callback` \| `balance_segment` \| `error_envelope`. |
| `statusCode` | For `error_envelope`: the HTTP status the harness FEEDS the engine. An INPUT, not an expectation — the harness never asserts on it, because asserting that the engine echoed back the status it was given can never fail. |
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
case never asserts a value it does not care about.

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

Duplicate metadata names resolve FIRST-WINS in all three engines (Go
`MetadataMap`, Python `metadata()`, TypeScript `MetadataMap`), so a
duplicate-key fixture expects the FIRST value.

## Adding a case

1. Add the JSON file here.
2. Add a row to each engine's dispatch table if it needs a new `kind`.
3. Run all three suites. A case that passes in one engine and fails in
   another is a **drift bug**, not a bad fixture — fix the engine.
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
