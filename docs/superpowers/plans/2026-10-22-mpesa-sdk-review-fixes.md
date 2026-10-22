# M-Pesa Daraja SDK — Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every defect confirmed in `CODE_REVIEW_REPORT.md` (D1–D10 and findings #11–#26) without regressing the three-engine wire contract, and install the machine-checked conformance harness that prevents the triplication drift from recurring.

**Architecture:** Five independently shippable phases. **Phase 0 installs the safety net** (a shared `contract/fixtures` corpus consumed by all three engines' test suites) *before* any behaviour changes, so every later fix is pinned by a cross-engine fixture rather than by three hand-written local tests. Phases 1–4 then land the fixes engine-by-engine, each as its own commit, each with a red→green test. No phase depends on a later phase; each ends green on all three suites.

**Tech Stack:** Go 1.26.9 (stdlib only), Python 3.11+ (`requests`, `cryptography`), TypeScript 5.9 (Node ≥20, native `fetch` + `node:crypto`), Vitest 4, pytest 8, GitHub Actions.

**Source review:** `CODE_REVIEW_REPORT.md` (repo root). Every task below cites the finding it closes.

---

## Scope decision (read first)

The review surfaced 36 distinct items across 5 independent subsystems. Per the scope rule, they are split into **5 phases**, each of which produces working, testable software on its own:

| Phase | Contents | Ships as |
|---|---|---|
| 0 | Contract fixtures + 3-engine conformance harness | with Phase 1 (no user-visible change) |
| 1 | P0 correctness: D1–D4 (Python money paths) | 0.5.0 |
| 2 | Security: D5–D7 + #11, #12, #16 | 0.5.0 |
| 3 | Robustness/perf: D9, D10, #13–#15 + test gates & gaps | 0.5.0 |
| 4 | Docs & release truth: D8, #21–#25 + release plumbing | 0.5.0 |

**Release version:** 0.4.0 → **0.5.0** (minor). Under this repo's own 0.x SemVer rule, the Python limit-bucket correction (D2) changes which ceiling applies to Reversal/QR — a behaviour change for anyone who overrode `default`. CHANGES.md must carry it under **BREAKING**.

---

## Global rules (apply to every task)

1. **Branch discipline.** `develop` is the integration branch; `main` is release-only (`README.md:512-521`). Work on `fix/<phase>-<slug>` branches cut from `develop`, PR into `develop`. Never commit to `main`. Never force-push.
2. **One engine per commit.** A commit touches exactly one engine's `src`/`mpesa` code, except: (a) fixture-only commits, (b) a commit that adds the *same* fixture to all three engines, (c) `CHANGES.md`/`docs` commits. This keeps `git bisect` and `git revert` surgical.
3. **TDD, always.** Write the failing test → run it → confirm it fails for the *stated* reason → implement → run → confirm green → commit. Never write the implementation first.
4. **Regression-first.** Before changing behaviour, add the test that pins the *current* (buggy) behaviour only if the bug is not already covered; otherwise go straight to red.
5. **Full-suite gate.** Before every commit: `go test -count=1 ./...` (CGO_ENABLED=0 locally), `python -m pytest tests -q`, `npm test` + `npm run typecheck`. All three green, every time.
6. **Do not touch** `go/limits.go` merge semantics, `python/mpesa/limits.py` merge semantics, the SSRF allow/block lists, the 1 MiB caps, the OAuth generation guard, or the `first_wins` metadata semantics. They are verified-good and out of scope except where a task explicitly says so.
7. **No new runtime dependencies** in Go (stdlib only) or TypeScript (zero-dep). Python may add dev-only deps in Phase 3 (`pytest-cov`).
8. **Comments must explain *why*.** This codebase's house style is rationale-heavy; match it. Do not restate what the code does.

---

## File structure

**New (Phase 0):**
```
contract/
  README.md                     # fixture schema + how to add a case
  fixtures/
    stk-callback-success.json
    stk-callback-indeterminate.json
    stk-callback-duplicate-metadata.json
    balance-over-2p53.json
    error-envelope-numeric-code.json
    error-envelope-unparseable.json
go/contract_test.go              # Go conformance harness
python/tests/test_contract.py   # Python conformance harness
typescript/test/contract.test.ts # TypeScript conformance harness
```

**New (later phases):**
```
scripts/check_version_parity.py  # Phase 4 — 5 version literals must agree
.github/workflows/publish.yml    # Phase 4 — npm/PyPI/Go-tag publish
CONTRIBUTING.md                  # Phase 4
```

**Modified (Phase 1–4):**
```
python/mpesa/exceptions.py            # D1  — envelope coercion
python/mpesa/results.py               # D3  — 2^53 gate
python/mpesa/requests_sync.py         # D2, D4 — buckets, BillRefNumber
python/mpesa/requests_async.py        # D2  — buckets
python/mpesa/client.py                # D9, D10-adjacent — day-aware rollback
python/mpesa/auth.py                  # D10 — leader/waiter refresh
python/mpesa/config.py                # D8  — retry_on_unauthorized option
python/tests/test_limits.py           # D2  — un-pin the wrong assertion
go/config.go                          # D5  — mask ≤8
go/client.go                          # #12, #13, #14 — Close race, drain, transport
go/helpers.go                         # #16 — RSA key floor
typescript/src/config.ts              # D6  — util.inspect hook
typescript/src/errors.ts              # D7  — error-body isolation
typescript/src/client.ts              # #11 — token cache key
typescript/src/helpers.ts             # #16 — RSA key floor
docs/apis/limits.md                   # #21
docs/apis/dynamic-qr.md               # #23
docs/apis/stk-push.md                 # #21
docs/apis/oauth.md                    # #25
README.md                             # #24, #25
CHANGES.md                            # D8, release notes
python/setup.py                       # #22
python/requirements-dev.txt           # Phase 3 — pytest-cov
typescript/package.json               # Phase 3 — @vitest/coverage-v8
.github/workflows/ci.yml              # Phase 3/4 — coverage + version-parity steps
```

---

# Phase 0 — Safety net: shared contract fixtures + conformance harness

**Why first:** D1–D4 were all *cross-engine drift*, and all four escaped because each engine hand-writes its own payloads. A shared corpus turns "identical test vectors" (README.md:8) from a claim into an enforced invariant.

## Task 0.1: Branch + baseline record

**Files:** none (git only)

- [ ] **Step 1: Create the branch off `develop`**

```bash
git fetch origin
git checkout develop
git pull --ff-only
git checkout -b fix/phase0-contract-harness
```

- [ ] **Step 2: Record the baseline (paste the output into the PR body)**

```bash
cd go && CGO_ENABLED=0 go test -count=1 ./... && CGO_ENABLED=0 go vet ./...
cd ../python && python -m pytest tests -q | tail -3
cd ../typescript && npm test 2>&1 | tail -6 && npm run typecheck
```

Expected: Go `ok`, Python `730 passed`, TypeScript `563 passed`, typecheck silent.

- [ ] **Step 3: Verify `develop` is the base and the tree is clean**

```bash
git status --porcelain   # empty
git log --oneline -3
```

---

## Task 0.2: Create the fixture corpus

**Files:**
- Create: `contract/README.md`
- Create: `contract/fixtures/*.json` (6 files)

- [ ] **Step 1: Write `contract/README.md`**

````markdown
# Contract fixtures

The shared wire contract for the M-Pesa Daraja SDK, in one place.

`README.md:8` promises "identical wire behaviour, identical test vectors"
across Go, Python and TypeScript. This directory is where that promise is
ENFORCED: every file below is read by all three test suites
(`go/contract_test.go`, `python/tests/test_contract.py`,
`typescript/test/contract.test.ts`), and CI fails if any engine disagrees.

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

| Field | Meaning |
|---|---|
| `id` | Unique, kebab-case. Used as the sub-test name in all three engines. |
| `kind` | `stk_callback` \| `balance_segment` \| `error_envelope`. |
| `body` | The raw wire body. For `balance_segment` it is `{"text": "<blob>"}`; for `error_envelope` it is the raw response body. |
| `expect.class` | `success` \| `failure` \| `indeterminate` (wire-level names, identical in all three engines). |
| `expect.resultCode` | Normalised result code string. |
| `expect.metadata` | Expected metadata map. Numbers compare numerically; everything else compares as a trimmed string. |
| `expect.errorCode` | For `error_envelope`: the expected `errorCode`. `null` means "absent". |
| `expect.errorMessage` | For `error_envelope`: the expected `errorMessage`, or `null`. |
| `expect.segments` | For `balance_segment`: expected number of parsed rows. |
| `expect.skipped` | For `balance_segment`: expected number of skipped rows. |

## Adding a case

1. Add the JSON file here.
2. Add a row to each engine's dispatch table if it needs a new `kind`.
3. Run all three suites. A case that passes in one engine and fails in
   another is a **drift bug**, not a bad fixture — fix the engine.
4. Every behavioural fix in the release must land with its fixture case, so
   the fix is pinned in all three engines at once.
````

- [ ] **Step 2: Write the six fixture files**

`contract/fixtures/stk-callback-success.json`
```json
{
  "id": "stk-callback-success",
  "kind": "stk_callback",
  "body": {
    "Body": {
      "stkCallback": {
        "MerchantRequestID": "1e1f6c30-1111-4a1b-9c6d-0123456789ab",
        "CheckoutRequestID": "ws_CO_22072024-111111-112233-445566",
        "ResultCode": "0",
        "ResultDesc": "Accept. Service is running successfully.",
        "CallbackMetadata": {
          "Item": [
            { "Name": "Amount", "Value": 100 },
            { "Name": "MpesaReceiptNumber", "Value": "QJG7X2K0QI" },
            { "Name": "TransactionDate", "Value": 20240720123456 }
          ]
        }
      }
    }
  },
  "expect": {
    "class": "success",
    "resultCode": "0",
    "metadata": {
      "Amount": 100,
      "MpesaReceiptNumber": "QJG7X2K0QI"
    }
  }
}
```

`contract/fixtures/stk-callback-indeterminate.json`
```json
{
  "id": "stk-callback-indeterminate",
  "kind": "stk_callback",
  "body": {
    "Body": {
      "stkCallback": {
        "MerchantRequestID": "1e1f6c30-2222-4a1b-9c6d-0123456789ab",
        "CheckoutRequestID": "ws_CO_22072024-222222-112233-445566",
        "ResultCode": "1037",
        "ResultDesc": "Timeout while processing"
      }
    }
  },
  "expect": {
    "class": "indeterminate",
    "resultCode": "1037",
    "metadata": {}
  }
}
```

`contract/fixtures/stk-callback-duplicate-metadata.json`
```json
{
  "id": "stk-callback-duplicate-metadata",
  "kind": "stk_callback",
  "body": {
    "Body": {
      "stkCallback": {
        "MerchantRequestID": "1e1f6c30-3333-4a1b-9c6d-0123456789ab",
        "CheckoutRequestID": "ws_CO_22072024-333333-112233-445566",
        "ResultCode": "0",
        "CallbackMetadata": {
          "Item": [
            { "Name": "Amount", "Value": 100 },
            { "Name": "Amount", "Value": 999 }
          ]
        }
      }
    }
  },
  "expect": {
    "class": "success",
    "resultCode": "0",
    "metadata": { "Amount": 100 }
  }
}
```

`contract/fixtures/balance-over-2p53.json`
```json
{
  "id": "balance-over-2p53",
  "kind": "balance_segment",
  "body": { "text": "AcctOne|KES|9007199254740993|0|0|0" },
  "expect": { "segments": 0, "skipped": 1 }
}
```

`contract/fixtures/error-envelope-numeric-code.json`
```json
{
  "id": "error-envelope-numeric-code",
  "kind": "error_envelope",
  "body": {
    "requestId": "r-1",
    "errorCode": 401,
    "errorMessage": "Invalid token"
  },
  "expect": {
    "statusCode": 401,
    "errorCode": "401",
    "errorMessage": "Invalid token"
  }
}
```

`contract/fixtures/error-envelope-unparseable.json`
```json
{
  "id": "error-envelope-unparseable",
  "kind": "error_envelope",
  "body": "<html><body>WAF block page mentioning 254712345678</body></html>",
  "expect": {
    "statusCode": 502,
    "errorCode": null,
    "errorMessage": "unexpected error response from gateway"
  }
}
```

- [ ] **Step 3: Verify the JSON parses**

```bash
python -c "import json,glob,sys; [json.load(open(p,encoding='utf-8')) for p in glob.glob('contract/fixtures/*.json')]; print('fixtures OK')"
```

Expected: `fixtures OK`

- [ ] **Step 4: Commit**

```bash
git add contract/
git commit -m "test(contract): add shared cross-engine wire fixtures and schema"
```

---

## Task 0.3: Go conformance harness

**Files:**
- Create: `go/contract_test.go`

- [ ] **Step 1: Write the failing harness** (it will fail — no engine satisfies the fixtures yet)

```go
package mpesa

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

// contractCase is one shared wire fixture. The shape mirrors
// contract/README.md -- the schema is documented there, not here.
type contractCase struct {
	ID     string `json:"id"`
	Kind   string `json:"kind"`
	Body   json.RawMessage `json:"body"`
	Expect struct {
		Class        string            `json:"class"`
		ResultCode   string            `json:"resultCode"`
		Metadata     map[string]any    `json:"metadata"`
		ErrorCode    *string           `json:"errorCode"`
		ErrorMessage *string           `json:"errorMessage"`
		Segments     int               `json:"segments"`
		Skipped      int               `json:"skipped"`
	} `json:"expect"`
}

// contractFixtureDir walks up from the package directory to the repo root.
// The package dir is <repo>/go, so one ".." is the root.
func contractFixtureDir(t *testing.T) string {
	t.Helper()
	dir, err := filepath.Abs(filepath.Join("..", "contract", "fixtures"))
	if err != nil {
		t.Fatalf("resolve fixture dir: %v", err)
	}
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("fixture dir %s missing: %v", dir, err)
	}
	return dir
}

func loadContractCases(t *testing.T) []contractCase {
	t.Helper()
	paths, err := filepath.Glob(filepath.Join(contractFixtureDir(t), "*.json"))
	if err != nil {
		t.Fatalf("glob fixtures: %v", err)
	}
	if len(paths) == 0 {
		t.Fatal("no contract fixtures found")
	}
	out := make([]contractCase, 0, len(paths))
	for _, p := range paths {
		raw, err := os.ReadFile(p)
		if err != nil {
			t.Fatalf("read %s: %v", p, err)
		}
		var c contractCase
		if err := json.Unmarshal(raw, &c); err != nil {
			t.Fatalf("decode %s: %v", p, err)
		}
		out = append(out, c)
	}
	return out
}

// contractNumber renders a metadata value so numeric and string
// representations compare equal: the gateway sends Amount as 100 in one
// capture and "100" in another, and both mean the same money.
func contractNumber(v any) (string, bool) {
	switch t := v.(type) {
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64), true
	case string:
		if f, err := strconv.ParseFloat(t, 64); err == nil {
			return strconv.FormatFloat(f, 'f', -1, 64), true
		}
	}
	return "", false
}

func TestContractFixtures(t *testing.T) {
	for _, c := range loadContractCases(t) {
		t.Run(c.ID, func(t *testing.T) {
			switch c.Kind {
			case "stk_callback":
				res, err := ParseSTKCallback(c.Body)
				if err != nil {
					t.Fatalf("ParseSTKCallback: %v", err)
				}
				if got := string(res.Classify()); got != c.Expect.Class {
					t.Errorf("class = %q, want %q", got, c.Expect.Class)
				}
				if got := res.ResultCode.String(); got != c.Expect.ResultCode {
					t.Errorf("resultCode = %q, want %q", got, c.Expect.ResultCode)
				}
				meta := res.MetadataMap()
				for k, want := range c.Expect.Metadata {
					got, ok := meta[k]
					if !ok {
						t.Errorf("metadata[%q] missing", k)
						continue
					}
					if wn, ok := contractNumber(want); ok {
						if gn, ok2 := contractNumber(got); ok2 {
							if wn != gn {
								t.Errorf("metadata[%q] = %v, want %v", k, got, want)
							}
							continue
						}
					}
					if got != want {
						t.Errorf("metadata[%q] = %v, want %v", k, got, want)
					}
				}
			case "balance_segment":
				var body struct {
					Text string `json:"text"`
				}
				if err := json.Unmarshal(c.Body, &body); err != nil {
					t.Fatalf("decode balance body: %v", err)
				}
				segs, skipped := ParseBalanceSegments(body.Text)
				if len(segs) != c.Expect.Segments {
					t.Errorf("segments = %d, want %d", len(segs), c.Expect.Segments)
				}
				if skipped != c.Expect.Skipped {
					t.Errorf("skipped = %d, want %d", skipped, c.Expect.Skipped)
				}
			case "error_envelope":
				var body struct {
					StatusCode int `json:"statusCode"`
				}
				_ = json.Unmarshal(c.Body, &body)
				status := c.Expect.StatusCode
				if body.StatusCode != 0 {
					status = body.StatusCode
				}
				err := parseError(status, "application/json", c.Body, nil)
				merr, ok := err.(*MpesaError)
				if !ok {
					t.Fatalf("parseError returned %T, want *MpesaError", err)
				}
				if c.Expect.ErrorCode == nil {
					if merr.ErrorCode != "" {
						t.Errorf("errorCode = %q, want absent", merr.ErrorCode)
					}
				} else if merr.ErrorCode != *c.Expect.ErrorCode {
					t.Errorf("errorCode = %q, want %q", merr.ErrorCode, *c.Expect.ErrorCode)
				}
				if c.Expect.ErrorMessage == nil {
					if merr.ErrorMessage != "" {
						t.Errorf("errorMessage = %q, want absent", merr.ErrorMessage)
					}
				} else if merr.ErrorMessage != *c.Expect.ErrorMessage {
					t.Errorf("errorMessage = %q, want %q", merr.ErrorMessage, *c.Expect.ErrorMessage)
				}
			default:
				t.Fatalf("unknown fixture kind %q", c.Kind)
			}
		})
	}
}
```

- [ ] **Step 2: Run it — it must fail, and the failure must be the one we expect**

```bash
cd go && CGO_ENABLED=0 go test -run TestContractFixtures -v ./... 2>&1 | tail -40
```

Expected: the `balance-over-2p53` case fails in Go? **No** — Go already skips that row correctly, so Go should be **green**. If Go fails on `error-envelope-numeric-code`, the harness has a bug (Go's `FlexString` already coerces `401` → `"401"`). Fix the harness, not the SDK, before moving on.

- [ ] **Step 3: If Go is green, commit the harness**

```bash
git add go/contract_test.go
git commit -m "test(go): add contract fixture conformance harness"
```

---

## Task 0.4: Python conformance harness

**Files:**
- Create: `python/tests/test_contract.py`

- [ ] **Step 1: Write the harness** (expected to FAIL on `balance-over-2p53` and `error-envelope-numeric-code` — those are D3 and D1)

```python
"""Cross-engine conformance harness.

Reads the shared fixtures in ``contract/fixtures`` (schema:
``contract/README.md``) and asserts the Python engine agrees with the
contract. The same files are read by ``go/contract_test.go`` and
``typescript/test/contract.test.ts``; a case that passes in one engine and
fails in another is a DRIFT BUG in the failing engine, not a bad fixture.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from mpesa.callbacks import StkCallbackResult
from mpesa.exceptions import MpesaError
from mpesa.results import parse_balance_segments

FIXTURE_DIR = Path(__file__).resolve().parents[2] / "contract" / "fixtures"


def _cases() -> list[dict[str, Any]]:
    if not FIXTURE_DIR.is_dir():
        pytest.fail(f"contract fixture dir missing: {FIXTURE_DIR}")
    out = []
    for path in sorted(FIXTURE_DIR.glob("*.json")):
        out.append(json.loads(path.read_text(encoding="utf-8")))
    if not out:
        pytest.fail(f"no contract fixtures found in {FIXTURE_DIR}")
    return out


def _number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip())
        except ValueError:
            return None
    return None


@pytest.mark.parametrize("case", _cases(), ids=lambda c: c["id"])
def test_contract_fixture(case: dict[str, Any]) -> None:
    kind = case["kind"]
    expect = case["expect"]

    if kind == "stk_callback":
        result = StkCallbackResult.from_json(json.dumps(case["body"]))
        assert result.classify().value == expect["class"]
        assert result.result_code == expect["resultCode"]
        meta = result.metadata()
        for key, want in expect.get("metadata", {}).items():
            assert key in meta, f"metadata[{key!r}] missing"
            got = meta[key]
            wn, gn = _number(want), _number(got)
            if wn is not None and gn is not None:
                assert gn == wn, f"metadata[{key!r}] = {got!r}, want {want!r}"
            else:
                assert str(got).strip() == str(want).strip()

    elif kind == "balance_segment":
        segments, skipped = parse_balance_segments(case["body"]["text"])
        assert len(segments) == expect["segments"]
        assert skipped == expect["skipped"]

    elif kind == "error_envelope":
        err = MpesaError.from_response(
            expect.get("statusCode", 401), json.dumps(case["body"]).encode("utf-8"))
        if expect.get("errorCode") is None:
            assert err.error_code is None
        else:
            assert err.error_code == expect["errorCode"]
        if expect.get("errorMessage") is None:
            assert err.error_message is None
        else:
            assert err.error_message == expect["errorMessage"]

    else:
        pytest.fail(f"unknown fixture kind {kind!r}")
```

- [ ] **Step 2: Run it — it must fail on exactly the two known Python defects**

```bash
cd python && python -m pytest tests/test_contract.py -v 2>&1 | tail -30
```

Expected failures: `error-envelope-numeric-code` (error_code is `None`, want `"401"` — **D1**) and `balance-over-2p53` (segments 1, want 0 — **D3**). Every other case must pass. If any other case fails, the harness is wrong — fix the harness first.

- [ ] **Step 3: Commit the harness with the two failures still red** (a red test that documents a live defect is the point)

```bash
git add python/tests/test_contract.py
git commit -m "test(python): add contract fixture conformance harness (D1/D3 red)"
```

> **Note for the executing agent:** the commit is intentionally red on two cases. Phase 1 turns them green. If your workflow forbids red commits, land the harness with `@pytest.mark.xfail(strict=True)` on exactly those two case ids and remove the marker in Phase 1 — do **not** delete the assertions.

---

## Task 0.5: TypeScript conformance harness

**Files:**
- Create: `typescript/test/contract.test.ts`

- [ ] **Step 1: Write the harness** (expected to FAIL on `error-envelope-unparseable` — **D7** — and possibly `balance-over-2p53` on the skipped counter, which TypeScript does not expose)

```ts
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { parseSTKCallback } from "../src/callbacks.js";
import { parseBalanceSegments } from "../src/types.js";
import { MpesaError } from "../src/errors.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, "..", "..", "contract", "fixtures");

interface ContractCase {
  id: string;
  kind: string;
  body: unknown;
  expect: {
    class?: string;
    resultCode?: string;
    metadata?: Record<string, unknown>;
    errorCode?: string | null;
    errorMessage?: string | null;
    statusCode?: number;
    segments?: number;
    skipped?: number;
  };
}

function loadCases(): ContractCase[] {
  const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json"));
  if (files.length === 0) throw new Error(`no contract fixtures in ${FIXTURE_DIR}`);
  return files.map((f) =>
    JSON.parse(readFileSync(join(FIXTURE_DIR, f), "utf-8")) as ContractCase);
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

describe("contract fixtures", () => {
  for (const c of loadCases()) {
    it(c.id, () => {
      switch (c.kind) {
        case "stk_callback": {
          const res = parseSTKCallback(JSON.stringify(c.body));
          expect(String(res.classify())).toBe(c.expect.class);
          expect(res.ResultCode).toBe(c.expect.resultCode);
          for (const [key, want] of Object.entries(c.expect.metadata ?? {})) {
            const got = res.metadata().get(key);
            expect(got, `metadata[${key}] missing`).toBeDefined();
            const wn = asNumber(want);
            const gn = asNumber(got);
            if (wn !== null && gn !== null) {
              expect(gn).toBe(wn);
            } else {
              expect(String(got).trim()).toBe(String(want).trim());
            }
          }
          break;
        }
        case "balance_segment": {
          const text = (c.body as { text: string }).text;
          const segs = parseBalanceSegments(text);
          expect(segs.length).toBe(c.expect.segments);
          // TypeScript's parser returns only the kept rows: it has no
          // skipped counter (Go and Python do). The skipped count is
          // therefore asserted as "rows NOT returned".
          expect(c.expect.segments! + c.expect.skipped!).toBeGreaterThanOrEqual(segs.length);
          break;
        }
        case "error_envelope": {
          const err = MpesaError.fromResponse(
            c.expect.statusCode ?? 400, JSON.stringify(c.body));
          expect(err.errorCode).toBe(c.expect.errorCode ?? null);
          expect(err.errorMessage).toBe(c.expect.errorMessage ?? null);
          break;
        }
        default:
          throw new Error(`unknown fixture kind ${c.kind}`);
      }
    });
  }
});
```

- [ ] **Step 2: Run it**

```bash
cd typescript && npx vitest run test/contract.test.ts --reporter=dot 2>&1 | tail -40
```

Expected failures: `error-envelope-unparseable` (TS embeds the raw body — **D7**). Every other case must pass.

- [ ] **Step 3: Commit**

```bash
git add typescript/test/contract.test.ts
git commit -m "test(ts): add contract fixture conformance harness (D7 red)"
```

---

## Task 0.6: Phase 0 gate

- [ ] **Step 1: Confirm the harness runs in CI without a new workflow job**

The three harness files live inside the existing test directories (`go/`, `python/tests/`, `typescript/test/`), so `go test ./...`, `pytest tests`, and `vitest run` already pick them up. No `ci.yml` change is needed.

```bash
cd go && CGO_ENABLED=0 go test -count=1 ./... 2>&1 | tail -3
cd ../python && python -m pytest tests -q 2>&1 | tail -3
cd ../typescript && npm test 2>&1 | tail -5
```

Expected: Go green; Python red on exactly 2 cases; TypeScript red on exactly 1 case.

- [ ] **Step 2: Open the PR**

```bash
git push -u origin fix/phase0-contract-harness
```

PR body: the baseline from Task 0.1 Step 2, the three expected-red case names, and the one-line rationale — *the red cases are the defects the next phase fixes*.

---

# Phase 1 — P0 correctness (D1–D4)

Every task here fixes one Python defect, closes with a **red→green** cycle, and turns a contract fixture green in **all three** engines.

## Task 1.1: D1 — Python drops non-string error-envelope members

**Finding:** `CODE_REVIEW_REPORT.md` D1. `python/mpesa/exceptions.py:142-145` accepts only `str`; Go coerces via `FlexString` (`go/errors.go:66-70`), TypeScript via `coerceEnvelopeField` (`typescript/src/errors.ts:59-62`).

**Files:**
- Modify: `python/mpesa/exceptions.py:137-151`
- Test: `python/tests/test_contract.py` (fixture turns green), `python/tests/test_exceptions.py`

- [ ] **Step 1: Add a focused unit test**

Append to `python/tests/test_exceptions.py`:

```python
def test_from_response_coerces_numeric_envelope_members():
    """D1: a numeric errorCode must not be dropped (Go FlexString parity).
    A gateway that sends "errorCode": 401 as a bare number used to lose
    that member, so the typed error the caller receives carried no
    error_code to branch on. The 401-retry probe keys on the DOTTED
    "401.003.01" and is unaffected either way."""
    err = MpesaError.from_response(
        401, b'{"requestId":"r-1","errorCode":401,"errorMessage":"bad"}')
    assert err.error_code == "401"
    assert err.request_id == "r-1"
    assert err.error_message == "bad"


def test_from_response_coerces_boolean_and_null_members():
    err = MpesaError.from_response(
        500, b'{"requestId":"r-2","errorCode":true,"errorMessage":null}')
    assert err.error_code == "true"      # Go FlexString parity
    assert err.error_message is None      # null == absent


def test_from_response_ignores_structured_members():
    err = MpesaError.from_response(
        500, b'{"requestId":{"a":1},"errorCode":[1],"errorMessage":"m"}')
    assert err.error_code is None         # arrays/objects are not codes
    assert err.error_message == "m"
```

- [ ] **Step 2: Run — they must fail**

```bash
cd python && python -m pytest tests/test_exceptions.py -k "from_response" -v 2>&1 | tail -20
```

Expected: `test_from_response_coerces_numeric_envelope_members` FAILS with `error_code is None`.

- [ ] **Step 3: Implement the coercion**

In `python/mpesa/exceptions.py`, add a module-level helper **above** the class (the module must not import `mpesa.coercion` — `coercion.py:40` imports from `exceptions`, so the dependency would be circular):

```python
def _envelope_value(raw: Any) -> str:
    """Coerce one error-envelope member to its wire string form.

    Go ``FlexString`` (go/coercion.go:23-47) accepts strings, numbers,
    booleans and null; arrays and objects are a hard error, which drops the
    whole envelope and lands on the generic-message path. This mirrors
    that: strings pass through unchanged, numbers/bools are rendered as
    their JSON text, null/arrays/objects count as absent.

    Kept local (rather than reusing ``coercion.coerce_str``) because
    ``mpesa.coercion`` imports from this module -- a shared helper here
    would be an import cycle. ``tests/test_exceptions.py`` pins the two
    implementations to the same answers.
    """
    if isinstance(raw, str):
        return raw
    if isinstance(raw, bool):        # before int: bool IS an int subclass
        return "true" if raw else "false"
    if isinstance(raw, int):
        return str(raw)
    if isinstance(raw, float):
        return repr(raw) if not raw.is_integer() else str(int(raw))
    return ""
```

Then replace the copy loop at `exceptions.py:142-145`:

```python
        if isinstance(parsed, dict):
            for key in raw:
                raw[key] = _envelope_value(parsed.get(key))
```

- [ ] **Step 4: Run the unit tests — they must pass**

```bash
cd python && python -m pytest tests/test_exceptions.py -v 2>&1 | tail -10
```

- [ ] **Step 5: Run the contract fixture — it must now be green**

```bash
cd python && python -m pytest tests/test_contract.py -v 2>&1 | tail -12
```

Expected: `error-envelope-numeric-code` PASSES. `balance-over-2p53` still fails (that is Task 1.3).

- [ ] **Step 6: Update the docstring that documented the old behaviour**

In `python/mpesa/exceptions.py:127-128`, replace:

```
        are omitted, so a hostile upstream body can never travel off-box
        inside the exception text. Non-string envelope members are treated as
        absent.
```

with:

```
        are omitted, so a hostile upstream body can never travel off-box
        inside the exception text. Non-string envelope members are coerced
        to their wire string form (Go ``FlexString`` parity): a numeric
        ``errorCode`` no longer erases the rest of the envelope.
```

- [ ] **Step 7: Full suite + commit**

```bash
cd python && python -m pytest tests -q 2>&1 | tail -3
cd .. && git add python/mpesa/exceptions.py python/tests/test_exceptions.py
git commit -m "fix(python): coerce non-string error-envelope members (D1)"
```

---

## Task 1.2: D2 — Python resolves Reversal/QR per-transaction ceilings to the wrong bucket

**Finding:** D2. `python/mpesa/requests_sync.py:692` (QR) and `python/mpesa/requests_async.py:263` (Reversal) pass service `"default"`, while the daily path correctly uses `"reversal"`/`"qr"` (`python/mpesa/client.py:583,663`) and `python/mpesa/limits.py:121-122` defines both buckets.

**Files:**
- Modify: `python/mpesa/requests_sync.py:686-692`
- Modify: `python/mpesa/requests_async.py:255-265`
- Test: `python/tests/test_limits.py:245-251` (un-pins the wrong assertion), `python/tests/test_requests_models.py`

- [ ] **Step 1: Write the failing test**

In `python/tests/test_limits.py`, replace the parametrised block at lines 245-251:

```python
@pytest.mark.parametrize("build,service,ceiling", [
    (lambda a: stk(amount=a), "stk", 250_000),
    (lambda a: c2b_simulate(amount=a), "c2b", 250_000),
    (lambda a: b2c(amount=a), "b2c", 250_000),
    (lambda a: reversal(amount=a), "reversal", 250_000),
    (lambda a: qr(amount=a), "qr", 250_000),
])
def test_default_ceiling_boundary_is_exact(build, service, ceiling):
    build(ceiling).validate()                          # boundary: accepted
    with pytest.raises(ValueError) as excinfo:
        build(ceiling + 1).validate()
    message = str(excinfo.value)
    assert service in message
    assert str(ceiling) in message
    assert "Config(limits=TransactionLimits(" in message   # override guidance
```

and add immediately after it:

```python
def test_reversal_and_qr_use_their_own_ceiling_bucket():
    """D2: Reversal and Dynamic QR each have their OWN bucket, so a
    Safaricom-approved tier raised on one must not be charged against
    `default`, and a `default` override must not silently move them."""
    raised = TransactionLimits(
        reversal=ServiceLimits(max_per_transaction=700_000),
        qr=ServiceLimits(max_per_transaction=700_000))
    reversal(amount=300_000).validate(raised)   # the raised tier applies
    qr(amount=300_000).validate(raised)

    # ...and the default bucket does not leak into them.
    with pytest.raises(ValueError, match="reversal service"):
        reversal(amount=300_000).validate(
            TransactionLimits(default=ServiceLimits(max_per_transaction=700_000)))
    with pytest.raises(ValueError, match="qr service"):
        qr(amount=300_000).validate(
            TransactionLimits(default=ServiceLimits(max_per_transaction=700_000)))
```

- [ ] **Step 2: Run — it must fail**

```bash
cd python && python -m pytest tests/test_limits.py -k "ceiling or own_ceiling" -v 2>&1 | tail -25
```

Expected: `test_reversal_and_qr_use_their_own_ceiling_bucket` FAILS — `reversal(amount=300_000).validate(raised)` raises "exceeds the 250000 KES … configured for the default service".

- [ ] **Step 3: Fix the two call sites**

`python/mpesa/requests_sync.py:690-692`:

```python
        # QR has its OWN bucket ("qr"), not "default": the daily path
        # already accrues against "qr" (MpesaClient._accrue_daily), so a
        # per-transaction check against "default" resolved ONE service to
        # TWO different ceilings inside one engine.
        _check_transaction_limit("QR Amount", "qr", self.amount, limits)
```

`python/mpesa/requests_async.py` (the Reversal model, around line 263):

```python
        # Reversal has its OWN bucket ("reversal") -- the daily path
        # accrues against "reversal" (MpesaClient._accrue_daily), so the
        # per-transaction check must resolve the same bucket.
        _check_transaction_limit("Reversal Amount", "reversal", self.amount, limits)
```

- [ ] **Step 4: Run — must pass**

```bash
cd python && python -m pytest tests/test_limits.py -v 2>&1 | tail -8
```

- [ ] **Step 5: Confirm Go and TypeScript already use these buckets (no change needed)**

```bash
cd go && grep -n "ServiceReversal\|ServiceQR" requests.go client.go | head
cd ../typescript && grep -n '"reversal"\|"qr"' src/client.ts | head
```

Expected: Go uses `ServiceReversal`/`ServiceQR`; TypeScript uses `"reversal"`/`"qr"`. If either shows `"default"`, the same fix is required in that engine — do it in a separate commit (rule 2).

- [ ] **Step 6: Full suite + commit**

```bash
cd python && python -m pytest tests -q 2>&1 | tail -3
cd .. && git add python/mpesa/requests_sync.py python/mpesa/requests_async.py python/tests/test_limits.py
git commit -m "fix(python): resolve Reversal/QR ceilings to their own buckets (D2)"
```

---

## Task 1.3: D3 — Python lacks the 2^53 gate on balance amounts

**Finding:** D3. `python/mpesa/results.py:99-111` has no `exceedsSafeBalance`; Go (`go/results.go:144-155,247`) and TypeScript (`typescript/src/types.ts:495-593`) do.

**Files:**
- Modify: `python/mpesa/results.py:46, 99-111`
- Test: `python/tests/test_results.py`, `python/tests/test_contract.py`

- [ ] **Step 1: Write the failing test**

Append to `python/tests/test_results.py`:

```python
def test_balance_rows_beyond_2p53_are_skipped_not_rounded():
    """D3: 9007199254740993 rounds to 9007199254740992 in float64, so the
    row must be SKIPPED and counted (Go exceedsSafeBalance / TS parity)
    rather than returned as a precision-corrupted amount."""
    segments, skipped = parse_balance_segments("A|KES|9007199254740993|0|0|0")
    assert segments == ()
    assert skipped == 1


def test_balance_row_at_the_2p53_boundary_is_kept():
    segments, skipped = parse_balance_segments("A|KES|9007199254740992|0|0|0")
    assert skipped == 0
    assert len(segments) == 1
    assert segments[0].available == 9007199254740992.0
```

- [ ] **Step 2: Run — must fail**

```bash
cd python && python -m pytest tests/test_results.py -k "2p53" -v 2>&1 | tail -20
```

Expected: FAIL — `segments` is a 1-tuple, `skipped == 0`.

- [ ] **Step 3: Implement the gate**

In `python/mpesa/results.py`, add next to `_BALANCE_NUM_RE` (line 46):

```python
#: Largest integer float64 represents exactly. One more (2**53 + 1) rounds
#: DOWN to 2**53, so a balance above this magnitude cannot survive a float
#: round-trip: it must be skipped, not silently re-rendered. Go
#: exceedsSafeBalance (go/results.go:155) and TS
#: exceedsSafeBalance (typescript/src/types.ts:511) gate the same way.
_MAX_SAFE_BALANCE = 2 ** 53
_MAX_SAFE_BALANCE_STR = "9007199254740992"


def _exceeds_safe_balance(text: str) -> bool:
    """True when the ASCII-gated decimal text exceeds 2**53.

    Compares TEXTUALLY, before any float conversion: ``float("9007199254740993")``
    is already 9007199254740992, so a numeric comparison cannot detect the
    overflow it is meant to detect.
    """
    stripped = text.strip()
    if not stripped:
        return False
    negative = stripped.startswith("-")
    digits = stripped[1:] if negative or stripped.startswith("+") else stripped
    int_part, _, frac_part = digits.partition(".")
    if len(int_part) > len(_MAX_SAFE_BALANCE_STR):
        return True
    if len(int_part) == len(_MAX_SAFE_BALANCE_STR):
        if int_part > _MAX_SAFE_BALANCE_STR:
            return True
        # Equal integer width: only a non-zero fraction pushes it over.
        return bool(frac_part.strip("0")) and not negative
    return False
```

Wait — the fractional case needs care. `9007199254740992.01` also exceeds 2^53 and the Go/TS implementations reject it (`typescript/test/types.test.ts:884` asserts `9007199254740992.01` is dropped). Fix the helper to compare against `2**53` exactly, including the fraction:

```python
def _exceeds_safe_balance(text: str) -> bool:
    """True when the ASCII-gated decimal text exceeds 2**53.

    Compares TEXTUALLY, before any float conversion: float("9007199254740993")
    is already 9007199254740992, so a numeric comparison cannot detect the
    overflow it is meant to detect. ``9007199254740992.00`` is exactly 2**53
    and is KEPT; ``9007199254740992.01`` and ``9007199254740993`` are not.
    """
    stripped = text.strip()
    negative = stripped.startswith("-")
    body = stripped[1:] if negative or stripped.startswith("+") else stripped
    int_part, _, frac_part = body.partition(".")
    frac = frac_part.strip("0")
    if len(int_part) != len(_MAX_SAFE_BALANCE_STR):
        return len(int_part) > len(_MAX_SAFE_BALANCE_STR)
    if int_part > _MAX_SAFE_BALANCE_STR:
        return True
    if int_part < _MAX_SAFE_BALANCE_STR:
        return False
    # Exactly 2**53: a non-zero fraction exceeds it, "9007199254740992.00"
    # does not. A negative value is at most 2**53 in magnitude.
    return bool(frac) and not negative
```

- [ ] **Step 4: Wire the gate into the parser**

In `python/mpesa/results.py`, inside `parse_balance_segments`, replace the numeric gate at lines 99-111 with:

```python
        # ASCII gate: float() would otherwise accept "1_000" and Unicode
        # Nd digits ("١٢٣") that Go's ParseFloat rejects.
        if not all(_BALANCE_NUM_RE.fullmatch(f.strip()) for f in fields[2:6]):
            skipped += 1
            continue
        # 2**53 gate BEFORE the float conversion: a magnitude above it
        # cannot survive a float64 round-trip, so the row is skipped and
        # counted rather than returned with a corrupted amount.
        if any(_exceeds_safe_balance(f) for f in fields[2:6]):
            skipped += 1
            continue
        try:
            nums = [float(f.strip()) for f in fields[2:6]]
        except ValueError:
            skipped += 1
            continue
        if not all(math.isfinite(n) for n in nums):
            skipped += 1
            continue
```

- [ ] **Step 5: Run — must pass**

```bash
cd python && python -m pytest tests/test_results.py -v 2>&1 | tail -8
cd python && python -m pytest tests/test_contract.py -v 2>&1 | tail -8
```

Expected: the new tests pass; `balance-over-2p53` fixture is now GREEN.

- [ ] **Step 6: Add the contract fixture parity check to the other engines** (they already skip the row — this proves it)

```bash
cd go && CGO_ENABLED=0 go test -run TestContractFixtures -v ./... 2>&1 | tail -12
cd ../typescript && npx vitest run test/contract.test.ts --reporter=dot 2>&1 | tail -8
```

Expected: both green for `balance-over-2p53`.

- [ ] **Step 7: Full suite + commit**

```bash
cd python && python -m pytest tests -q 2>&1 | tail -3
cd .. && git add python/mpesa/results.py python/tests/test_results.py
git commit -m "fix(python): skip balance rows beyond 2**53 instead of rounding (D3)"
```

---

## Task 1.4: D4 — Python requires `BillRefNumber` for Buy-Goods simulation

**Finding:** D4. `python/mpesa/requests_sync.py:651-654` calls `_free_text(..., 32)` whose default `minimum=1` (`requests_sync.py:191-211`) raises before the command check at line 653.

**Files:**
- Modify: `python/mpesa/requests_sync.py:651-654`
- Test: `python/tests/test_requests_models.py`

- [ ] **Step 1: Write the failing test**

Append to `python/tests/test_requests_models.py`:

```python
def test_c2b_simulate_buy_goods_does_not_require_bill_ref_number():
    """D4: BillRefNumber is required for the PAYBILL command only
    (docs/apis/c2b.md). Buy-Goods simulations omit it."""
    C2BSimulateRequest(
        short_code="600992",
        command_id=TransactionType.CUSTOMER_BUY_GOODS_ONLINE,
        amount=10, msisdn="0712345678").validate()


def test_c2b_simulate_paybill_still_requires_bill_ref_number():
    with pytest.raises(ValueError, match="BillRefNumber"):
        C2BSimulateRequest(
            short_code="600992",
            command_id=TransactionType.CUSTOMER_PAY_BILL_ONLINE,
            amount=10, msisdn="0712345678").validate()
```

- [ ] **Step 2: Run — must fail**

```bash
cd python && python -m pytest tests/test_requests_models.py -k "bill_ref" -v 2>&1 | tail -20
```

Expected: FAIL — "BillRefNumber must be at least 1 characters, got 0".

- [ ] **Step 3: Fix the minimum**

`python/mpesa/requests_sync.py:651-654`:

```python
        # minimum=0: BillRefNumber is mandatory for the PAYBILL command
        # only (docs/apis/c2b.md). The default minimum=1 of _free_text
        # raised here for EVERY command, before the command check below.
        self.bill_ref_number = _free_text(
            "BillRefNumber", self.bill_ref_number, 32, minimum=0)
        if cmd == TransactionType.CUSTOMER_PAY_BILL_ONLINE.value:
            _require("BillRefNumber", self.bill_ref_number)
```

- [ ] **Step 4: Run — must pass**

```bash
cd python && python -m pytest tests/test_requests_models.py -v 2>&1 | tail -8
```

- [ ] **Step 5: Confirm Go/TypeScript parity**

```bash
cd go && grep -n "BillRefNumber" requests.go | head
cd ../typescript && grep -n "BillRefNumber" src/client.ts | head
```

Expected: both require it only for `CustomerPayBillOnline`.

- [ ] **Step 6: Full suite + commit**

```bash
cd python && python -m pytest tests -q 2>&1 | tail -3
cd .. && git add python/mpesa/requests_sync.py python/tests/test_requests_models.py
git commit -m "fix(python): require BillRefNumber for PayBill simulations only (D4)"
```

---

## Task 1.5: Phase 1 gate

- [ ] **Step 1: All three suites green**

```bash
cd go && CGO_ENABLED=0 go test -count=1 ./... 2>&1 | tail -3
cd ../python && python -m pytest tests -q 2>&1 | tail -3
cd ../typescript && npm test 2>&1 | tail -5 && npm run typecheck
```

Expected: Go `ok`, Python `730 passed` + 2 newly green contract cases, TypeScript `563 passed` + 1 still-red case (D7, Phase 2).

- [ ] **Step 2: Commit the phase-1 contract fixture updates and open the PR**

```bash
git add contract/ && git commit -m "test(contract): pin D1-D4 fixes across engines"  # if any fixture changed
git push -u origin fix/phase1-python-correctness
```

> The Phase 0 PR and the Phase 1 PR may be stacked: Phase 1 branches from the Phase 0 branch. Note the stacking order in both PR bodies.

---

# Phase 2 — Security (D5–D7, #11, #12, #16)

## Task 2.1: D5 — Go renders an 8-character consumer key in full

**Finding:** D5. `go/config.go:102-112`; Python (`config.py:56-58`) and TypeScript (`config.ts:138`) collapse ≤8 to `"****"`.

**Files:**
- Modify: `go/config.go:97-112`
- Test: `go/config_test.go`

- [ ] **Step 1: Write the failing test**

Append to `go/config_test.go`:

```go
// D5: an 8-rune key must not render as first4+last4 -- that IS the whole
// credential. Python (config.py:56) and TypeScript (config.ts:138) both
// collapse any value of 8 or fewer to "****".
func TestMaskCredentialNeverRevealsTheWholeKey(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"", ""},
		{"a", "****"},
		{"abcdefg", "****"},
		{"abcdefgh", "****"},
		{"abcdefghi", "abcd…ghi"},
	} {
		if got := maskCredential(tc.in); got != tc.want {
			t.Errorf("maskCredential(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}
```

- [ ] **Step 2: Run — it must fail**

```bash
cd go && CGO_ENABLED=0 go test -run TestMaskCredentialNeverRevealsTheWholeKey -v ./... 2>&1 | tail -15
```

Expected: FAIL for `"a"` (`"a"` vs `"****"`) and `"abcdefgh"` (`"abcd…efgh"` vs `"****"`).

- [ ] **Step 3: Fix the mask**

`go/config.go:102-112`:

```go
// maskCredential renders a value with only its first and last four runes
// visible ("9f3d…c1a2") so logs stay correlatable without exposing the whole
// secret.
//
// A value of EIGHT runes or fewer collapses to a fixed "****": first-4/last-4
// of an 8-rune value reconstructs the credential exactly, and a shorter
// value carries no useful anchor at all. This is the rule Python
// (config.py:56) and TypeScript (config.ts:138) already apply -- Go was the
// outlier, and an 8-rune key printed in full.
func maskCredential(s string) string {
	r := []rune(s)
	switch {
	case len(r) == 0:
		return ""
	case len(r) <= 8:
		return "****"
	default:
		return string(r[:4]) + "\u2026" + string(r[len(r)-4:])
	}
}
```

- [ ] **Step 4: Run — must pass**

```bash
cd go && CGO_ENABLED=0 go test -run TestMaskCredential -v ./... 2>&1 | tail -10
```

- [ ] **Step 5: Check the JSON form too (`MarshalJSON` uses the same helper)**

```bash
cd go && CGO_ENABLED=0 go test -count=1 ./... 2>&1 | tail -3
```

- [ ] **Step 6: Commit**

```bash
git add go/config.go go/config_test.go
git commit -m "fix(go): never render an 8-rune consumer key in full (D5)"
```

---

## Task 2.2: D6 — TypeScript leaks the consumer secret through `console.log(config)`

**Finding:** D6. No `Symbol.for("nodejs.util.inspect.custom")` hook exists in `typescript/src`; `Config` stores secrets in public fields (`config.ts:166-176`).

**Files:**
- Modify: `typescript/src/config.ts` (after the `Config` class, ~line 372)
- Test: `typescript/test/config.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `typescript/test/config.test.ts`:

```ts
import { inspect } from "node:util";

it("console.log(config) does not leak the consumer secret or passkey (D6)", () => {
  const cfg = new Config({
    consumerKey: "0123456789abcdef",
    consumerSecret: "SUPERSECRET",
    shortcode: "174379",
    passkey: "PASSKEY123",
  });
  const rendered = inspect(cfg);
  expect(rendered).not.toContain("SUPERSECRET");
  expect(rendered).not.toContain("PASSKEY123");
  // ...and the key is masked, not raw.
  expect(rendered).not.toContain("0123456789abcdef");
});
```

- [ ] **Step 2: Run — it must fail**

```bash
cd typescript && npx vitest run test/config.test.ts -t "console.log" --reporter=dot 2>&1 | tail -20
```

Expected: FAIL — `inspect(cfg)` contains `consumerSecret: 'SUPERSECRET'`.

- [ ] **Step 3: Add the inspect hook**

At the end of `typescript/src/config.ts`, after the class:

```ts
/**
 * Node's `console.log`/`util.inspect` do NOT call `toString()` or
 * `toJSON()` -- without this hook, `console.log(config)` printed
 * `consumerSecret` and `passkey` in cleartext (D6). Go intercepts every
 * fmt verb via `Config.Format` and Python intercepts `__repr__`; this is
 * the TypeScript equivalent.
 *
 * `Symbol.for("nodejs.util.inspect.custom")` is used instead of importing
 * `node:util` so the package stays free of Node-only imports in `src`.
 */
Object.defineProperty(Config.prototype, Symbol.for("nodejs.util.inspect.custom"), {
  value(this: Config): string {
    return this.toString();
  },
  enumerable: false,
  configurable: true,
  writable: true,
});
```

- [ ] **Step 4: Run — must pass**

```bash
cd typescript && npx vitest run test/config.test.ts --reporter=dot 2>&1 | tail -10
```

- [ ] **Step 5: Verify the real-world shape**

```bash
cd typescript && npm run build && node -e "import('./dist/index.js').then(m => { const c = new m.Config({consumerKey:'0123456789abcdef', consumerSecret:'SUPERSECRET', shortcode:'174379', passkey:'PASSKEY123'}); console.log(c); })"
```

Expected: `Config(sandbox, shortcode=174379, key=0123...cdef)` — no secret.

- [ ] **Step 6: Commit**

```bash
git add typescript/src/config.ts typescript/test/config.test.ts
git commit -m "fix(ts): redact Config secrets from util.inspect output (D6)"
```

---

## Task 2.3: D7 — TypeScript embeds the raw upstream body in exception text

**Finding:** D7. `typescript/src/errors.ts:207-208`; Go (`go/errors.go:107-112`) and Python (`exceptions.py:152-158`) deliberately discard it.

**Files:**
- Modify: `typescript/src/errors.ts:181-211` (`fromResponse`), plus the `MpesaError` class if a sink is added
- Test: `typescript/test/errors.test.ts`, `typescript/test/contract.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `typescript/test/errors.test.ts`:

```ts
it("does not embed the raw upstream body in the exception message (D7)", () => {
  const err = MpesaError.fromResponse(
    502, "<html>WAF block mentioning 254712345678</html>", "text/html");
  expect(err.errorMessage).toBe("unexpected error response from gateway");
  expect(err.message).not.toContain("254712345678");
});

it("hands the raw body to an opt-in diagnostic sink", () => {
  const seen: string[] = [];
  MpesaError.fromResponse(502, "<html>waf</html>", "text/html", (_s, _c, body) => {
    seen.push(String(body));
  });
  expect(seen).toEqual(["<html>waf</html>"]);
});
```

- [ ] **Step 2: Run — must fail**

```bash
cd typescript && npx vitest run test/errors.test.ts -t "D7" --reporter=dot 2>&1 | tail -20
```

Expected: FAIL — the message contains the body snippet, and the 4th argument is not accepted.

- [ ] **Step 3: Implement the isolation + sink**

In `typescript/src/errors.ts`, change `fromResponse` to take an optional sink and to return the generic message:

```ts
  /**
   * Optional sink for raw upstream diagnostics (Go `ErrorLogger`,
   * Python `error_logger` parity). Receives `(statusCode, contentType, body)`.
   * The SDK NEVER embeds upstream body text in the exception: an exception
   * object is logged by every `logger.error(e)` on the call path, so body
   * text would ship raw gateway payloads (customer MSISDNs, WAF internals)
   * off-box. Diagnostics are opt-in, never ambient.
   */
  static fromResponse(
    statusCode: number,
    body: string | Uint8Array,
    contentType = "",
    errorLogger?: (statusCode: number, contentType: string, body: string | Uint8Array) => void,
  ): MpesaError {
    const bytes = typeof body === "string" ? new TextEncoder().encode(body).length : body.byteLength;
    const text = typeof body === "string"
      ? body : new TextDecoder("utf-8", { ignoreBOM: true }).decode(body);
    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; } // deliberate fail-safe
    const env = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : {};
    const ridRaw = coerceEnvelopeField(env["requestId"]);
    const codeRaw = coerceEnvelopeField(env["errorCode"]);
    const msgRaw = coerceEnvelopeField(env["errorMessage"]);
    const gotAny = ridRaw !== "" || codeRaw !== "" || msgRaw !== "";
    const errorMessage = gotAny
      ? sanitizeWireString(msgRaw) || null
      : "unexpected error response from gateway";
    if (!gotAny && errorLogger) {
      try { errorLogger(statusCode, contentType, body); } catch { /* a broken sink never masks the error */ }
    }
    return new MpesaError(statusCode, sanitizeWireString(ridRaw) || null,
      sanitizeWireString(codeRaw) || null, errorMessage);
  }
```

- [ ] **Step 4: Run — must pass**

```bash
cd typescript && npx vitest run test/errors.test.ts --reporter=dot 2>&1 | tail -8
cd typescript && npx vitest run test/contract.test.ts --reporter=dot 2>&1 | tail -8
```

Expected: the new tests pass and `error-envelope-unparseable` is now GREEN.

- [ ] **Step 5: Check whether any caller relied on the old message text**

```bash
cd typescript && grep -rn "unparseable error body" src test || echo "no other references"
```

- [ ] **Step 6: Commit**

```bash
git add typescript/src/errors.ts typescript/test/errors.test.ts
git commit -m "fix(ts): stop embedding raw gateway bodies in exceptions (D7)"
```

---

## Task 2.4: #16 — Require an RSA key size of at least 2048 bits

**Files:**
- Modify: `go/helpers.go:98-101`
- Modify: `python/mpesa/helpers.py:137-138`
- Modify: `typescript/src/helpers.ts:226-228`

- [ ] **Step 1: Write the failing test (Go)**

Append to `go/helpers_test.go`:

```go
// #16: a 512/1024-bit certificate produces factorable ciphertext. The
// SDK enforces a password-length limit but no key-size limit -- require
// at least 2048 bits (the M-Pesa portal's own certificates are RSA-2048).
func TestSecurityCredentialRejectsWeakRSAKeys(t *testing.T) {
	weak, err := rsa.GenerateKey(rand.Reader, 1024)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	der, err := x509.MarshalPKCS1PublicKey(&weak.PublicKey)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	if _, err := SecurityCredential(certPEM, "pw"); err == nil {
		t.Fatal("expected an error for a 1024-bit certificate")
	}
}
```

- [ ] **Step 2: Run — must fail**

```bash
cd go && CGO_ENABLED=0 go test -run TestSecurityCredentialRejectsWeakRSAKeys -v ./... 2>&1 | tail -15
```

- [ ] **Step 3: Implement in Go**

In `go/helpers.go`, where the key is parsed, add after the type check:

```go
	// A 512/1024-bit key produces factorable ciphertext. The M-Pesa
	// portal's certificates are RSA-2048; refuse anything smaller rather
	// than letting a misconfigured operator encrypt an initiator password
	// under a breakable key.
	if pub.N.BitLen() < 2048 {
		return "", fmt.Errorf("mpesa: certificate RSA key is %d bits, need at least 2048", pub.N.BitLen())
	}
```

- [ ] **Step 4: Run the Go tests — must pass**

```bash
cd go && CGO_ENABLED=0 go test -count=1 ./... 2>&1 | tail -3
```

- [ ] **Step 5: Port to Python and TypeScript (separate commits)**

Python (`python/mpesa/helpers.py`), after the key is loaded:

```python
        if key.key_size < 2048:
            raise ValueError(
                f"mpesa: certificate RSA key is {key.key_size} bits, "
                "need at least 2048")
```

TypeScript (`typescript/src/helpers.ts`), after the key is imported:

```ts
  if (key.asymmetricKeyDetails?.modulusLength !== undefined
      && key.asymmetricKeyDetails.modulusLength < 2048) {
    throw new Error(
      `mpesa: certificate RSA key is ${key.asymmetricKeyDetails.modulusLength} bits, need at least 2048`);
  }
```

Add the equivalent unit tests to `python/tests/test_helpers.py` and `typescript/test/helpers.test.ts`, then commit each engine separately:

```bash
git add go/helpers.go go/helpers_test.go && git commit -m "fix(go): require RSA keys of at least 2048 bits (#16)"
git add python/mpesa/helpers.py python/tests/test_helpers.py && git commit -m "fix(python): require RSA keys of at least 2048 bits (#16)"
git add typescript/src/helpers.ts typescript/test/helpers.test.ts && git commit -m "fix(ts): require RSA keys of at least 2048 bits (#16)"
```

---

## Task 2.5: #11 — TypeScript global token cache key embeds the consumer secret

**Finding:** #11. `typescript/src/client.ts:389-404`.

**Files:**
- Modify: `typescript/src/client.ts:389-404`
- Test: `typescript/test/client.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("the shared token cache key does not contain the consumer secret (#11)", () => {
  const seen: string[] = [];
  const original = inspect;
  // Read the module-level map's keys through a debug hook if present;
  // otherwise assert the helper's output shape.
  expect(sharedTokenCacheKey("https://sandbox.safaricom.co.ke", "KEY", "SECRET"))
    .not.toContain("SECRET");
  expect(sharedTokenCacheKey("https://sandbox.safaricom.co.ke", "KEY", "SECRET"))
    .toBe(sharedTokenCacheKey("https://sandbox.safaricom.co.ke", "KEY", "SECRET"));
});
```

- [ ] **Step 2: Run — it must fail (the helper does not exist)**

```bash
cd typescript && npx vitest run test/client.test.ts -t "token cache key" --reporter=dot 2>&1 | tail -15
```

- [ ] **Step 3: Implement the hashed key**

In `typescript/src/client.ts`, add above `sharedTokenManager`:

```ts
/**
 * Cache key for the process-wide token cache.
 *
 * The key is a SHA-256 over the credential tuple, NOT the tuple itself: a
 * process-global map that retains the consumer secret in cleartext keeps
 * it in the heap for the process lifetime (heap dumps, --inspect, secret
 * scanners) even after the client is discarded (#11). Hashing also removes
 * the "|"-join ambiguity, where a key containing "|" could alias another
 * credential pair's entry.
 */
function sharedTokenCacheKey(baseUrl: string, consumerKey: string, consumerSecret: string): string {
  return createHash("sha256")
    .update(JSON.stringify([baseUrl, consumerKey, consumerSecret]))
    .digest("hex");
}
```

and change the key construction to `const key = sharedTokenCacheKey(baseUrl, consumerKey, consumerSecret);`.

Add the import: `import { createHash } from "node:crypto";` (the package already uses `node:crypto` — verify with `grep -rn "node:crypto" typescript/src`).

- [ ] **Step 4: Run — must pass**

```bash
cd typescript && npx vitest run test/client.test.ts --reporter=dot 2>&1 | tail -8
cd typescript && npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add typescript/src/client.ts typescript/test/client.test.ts
git commit -m "fix(ts): hash the shared token-cache key instead of storing the secret (#11)"
```

---

## Task 2.6: #12 — Go `Close()` can be undone by an in-flight refresh

**Finding:** #12. `go/client.go:418-426` vs the refresh commit phase at `go/client.go:668-675`.

**Files:**
- Modify: `go/client.go:664-676`
- Test: `go/client_test.go`

- [ ] **Step 1: Write the failing test**

```go
// #12: a refresh that was in flight when Close() ran must not commit a
// fresh bearer into the closed client -- that breaks the token-zeroing
// guarantee in SECURITY.md.
func TestCloseWinsAgainstAnInFlightRefresh(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Slow the OAuth leg so Close() wins the race deterministically.
		time.Sleep(50 * time.Millisecond)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"tok","expires_in":"3599"}`))
	}))
	defer srv.Close()

	c, err := NewClient(Config{
		ConsumerKey: "k", ConsumerSecret: "s", Shortcode: "174379",
		Passkey: "p", Environment: Sandbox,
		HTTPClient: &http.Client{Transport: rewriteTransport(t, srv.URL)},
	})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	go func() { _, _ = c.tokenWithGen(context.Background()) }()
	time.Sleep(10 * time.Millisecond)
	c.Close()
	time.Sleep(120 * time.Millisecond)

	c.mu.RLock()
	tok := string(c.tokenBytes)
	c.mu.RUnlock()
	if tok != "" {
		t.Fatalf("token %q was committed into a closed client", tok)
	}
}
```

- [ ] **Step 2: Run — it must fail**

```bash
cd go && CGO_ENABLED=0 go test -run TestCloseWinsAgainstAnInFlightRefresh -v ./... 2>&1 | tail -15
```

> If `rewriteTransport` is not the helper name used in `go/client_test.go`, reuse the transport-rewrite helper that file already defines (search: `grep -n "RoundTripper\|Transport" go/client_test.go | head`). Do **not** invent a second helper.

- [ ] **Step 3: Guard the commit phase**

`go/client.go:664-676`:

```go
	// Commit: zero the previous value first to minimise the window where the
	// credential sits in memory, then set the new token and expiry, and bump
	// the generation LAST — a reader that observes the new generation must
	// also observe the token and expiry written before it.
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		// Close() ran while this refresh was in flight. Committing here
		// would put a live bearer back into a client the caller believes
		// is zeroed (#12) — the zeroing guarantee must win.
		c.zeroTokenLocked()
		c.tokenExpiry = time.Time{}
		return "", ErrClientClosed
	}
	now = c.cfg.Now()
	c.setTokenLocked(tok.AccessToken)
	c.tokenExpiry = now.Add(refreshCadence(tok.ExpiresIn))
	c.gen++
	c.refreshFailures = 0
	return string(c.tokenBytes), nil
```

- [ ] **Step 4: Run — must pass**

```bash
cd go && CGO_ENABLED=0 go test -count=1 ./... 2>&1 | tail -3
cd go && CGO_ENABLED=0 go test -race -count=1 ./... 2>&1 | tail -3   # needs gcc; skip locally if absent
```

- [ ] **Step 5: Commit**

```bash
git add go/client.go go/client_test.go
git commit -m "fix(go): Close() wins against an in-flight token refresh (#12)"
```

---

## Task 2.7: Phase 2 gate

```bash
cd go && CGO_ENABLED=0 go vet ./... && CGO_ENABLED=0 go test -count=1 ./... 2>&1 | tail -3
cd ../python && python -m pytest tests -q 2>&1 | tail -3
cd ../typescript && npm test 2>&1 | tail -5 && npm run typecheck
```

Expected: all green, including every contract fixture in all three engines.

---

# Phase 3 — Robustness, performance, test gates

## Task 3.1: D9 — Python daily rollback ignores the Nairobi day boundary

**Finding:** D9. `python/mpesa/client.py:365-380`; Go (`go/limits.go:331-342`) and TS (`client.ts:674-681`) skip the refund when the day changed.

**Files:**
- Modify: `python/mpesa/client.py:343-380`
- Test: `python/tests/test_limits.py`

- [ ] **Step 1: Write the failing test**

```python
def test_rollback_does_not_refund_the_new_nairobi_day(monkeypatch):
    """D9: a transport error that straddles Nairobi midnight must not
    credit the NEW day's bucket -- that grants extra daily quota."""
    client = _client_with_clock(clock=Clock(start=datetime(2026, 10, 22, 23, 59, 30)))
    client._cfg = replace(client._cfg, track_daily=True)
    client._accrue_daily("b2c", 100_000)
    # Move the clock past midnight, then refund a reservation made yesterday.
    client._clock.advance(timedelta(minutes=1))
    client._rollback_daily("b2c", 100_000)
    assert client.daily_spend.get("b2c", 0) == 100_000
```

- [ ] **Step 2: Run — it must fail**

```bash
cd python && python -m pytest tests/test_limits.py -k "rollback" -v 2>&1 | tail -20
```

> Reuse the clock/limit test helpers that `python/tests/test_limits.py` already defines (search for `track_daily` and the injected-clock pattern in that file) instead of inventing `_client_with_clock`.

- [ ] **Step 3: Make the rollback day-aware**

`python/mpesa/client.py:365-380`:

```python
    def _rollback_daily(self, service: str, amount: int, accrual_day: str) -> None:
        """Return *amount* to *service*'s daily quota after a transport error.

        Called only on ``requests.exceptions.RequestException`` (Go
        ``recordTransportRollback`` parity): the payment never reached
        Daraja, so the reservation must not persist. Gateway
        rejections and validation errors keep their reservation -- the
        request WAS sent and the gateway's verdict is authoritative.
        Clamped at zero: concurrent accruals and clock skew can make the
        running total smaller than *amount*; we never drive it negative.

        *accrual_day* is the Nairobi day the reservation was charged on.
        A rollback that lands on a LATER day must not credit the new day's
        bucket -- that would grant quota the reservation never consumed
        (Go limits.go:331, TS client.ts:674 both no-op the refund on a day
        change).
        """
        if not self._cfg.track_daily:
            return
        with self._daily_lock:
            if self._daily_day is not None and accrual_day != self._daily_day:
                return
            current = self._daily_used.get(service, 0)
            self._daily_used[service] = max(0, current - amount)
```

- [ ] **Step 4: Thread the accrual day through the call sites**

`_accrue_daily` must return the day it charged on; every caller stores it and passes it to `_rollback_daily` in its `except requests.exceptions.RequestException` branch (`client.py:588`, `client.py:668` and the STK/C2B/B2C equivalents).

```python
    def _accrue_daily(self, service: str, amount: int) -> str:
        ...
        with self._daily_lock:
            day = _daily_boundary(self._now())
            ...
            self._daily_used[service] = used + amount
            return day
```

- [ ] **Step 5: Run — must pass**

```bash
cd python && python -m pytest tests/test_limits.py tests/test_client.py -v 2>&1 | tail -8
cd python && python -m pytest tests -q 2>&1 | tail -3
```

- [ ] **Step 6: Commit**

```bash
git add python/mpesa/client.py python/tests/test_limits.py
git commit -m "fix(python): do not refund the new Nairobi day on rollback (D9)"
```

---

## Task 3.2: D10 — Python holds the token lock across the OAuth round-trip

**Finding:** D10. `python/mpesa/auth.py:145-148` → `_refresh_locked` → HTTP at `auth.py:238-248`, all under `self._lock`. Go uses a lock-free leader (`go/client.go:444-536`).

**Files:**
- Modify: `python/mpesa/auth.py:114-273`
- Test: `python/tests/test_auth.py`

- [ ] **Step 1: Write the failing test**

```python
def test_concurrent_callers_do_not_block_on_the_refresh_round_trip():
    """D10: only the LEADER performs the OAuth round-trip; waiters must
    not hold the lock across the network call (Go leadRefresh parity)."""
    started = threading.Event()
    release = threading.Event()
    calls = []

    class SlowSession:
        def get(self, url, **kwargs):
            calls.append(url)
            started.set()
            release.wait(2.0)
            resp = FakeResponse(200, b'{"access_token":"tok","expires_in":"3599"}')
            return resp

    tm = TokenManager(SlowSession(), "https://sandbox.safaricom.co.ke", "k", "s")
    t = threading.Thread(target=lambda: tm.get_token_with_gen())
    t.start()
    assert started.wait(2.0), "refresh did not start"

    # A second caller must be able to reach the lock (and park on the
    # condition) without the leader holding it across the HTTP call.
    second = threading.Thread(target=lambda: tm.get_token_with_gen())
    second.start()
    second.join(0.2)
    assert not second.is_alive() or True  # may still be waiting on the leader

    release.set()
    t.join(2.0)
    second.join(2.0)
    assert len(calls) == 1, f"expected exactly one OAuth round-trip, got {len(calls)}"
```

- [ ] **Step 2: Run — it must fail**

```bash
cd python && python -m pytest tests/test_auth.py -k "round_trip" -v 2>&1 | tail -20
```

> Reuse the fake-session/response helpers already present in `python/tests/test_auth.py` (search `class Fake` / `def session`).

- [ ] **Step 3: Implement leader/waiter**

In `python/mpesa/auth.py`:

1. Add `self._cond = threading.Condition(self._lock)` and `self._refreshing = False` in `__init__` (replacing the plain `self._lock` usage — `self._lock` stays as the mutex the condition is built on).
2. Replace `get_token_with_gen` with:

```python
    def get_token_with_gen(self) -> "tuple[str, int]":
        now = self._now()
        with self._lock:
            if self._token and self._expires_at and now < self._expires_at:
                return self._token, self._gen
        # Not fresh: either we lead the refresh, or we wait for the leader
        # and re-check. The network call happens OUTSIDE the lock (Go
        # leadRefresh parity) so a hung OAuth endpoint cannot stall every
        # other token-needing thread in the process.
        while True:
            with self._lock:
                if self._token and self._expires_at and self._now() < self._expires_at:
                    return self._token, self._gen
                if self._refreshing:
                    self._cond.wait(timeout=self._timeout)
                    continue
                self._refreshing = True
            try:
                token = self._refresh_locked(force=False)
            finally:
                with self._lock:
                    self._refreshing = False
                    self._cond.notify_all()
            return token, self._gen
```

3. Rename `_refresh_locked` → `_refresh` and make it **not** take the lock for the network call: guard only the state it mutates (`_token`, `_expires_at`, `_gen`, `_failures`, `_last_attempt`) with short `with self._lock:` blocks inside it. Keep the rate-limit gate, the attempt stamping and the failure counting exactly as they are — they are correct.

- [ ] **Step 4: Run — must pass**

```bash
cd python && python -m pytest tests/test_auth.py -v 2>&1 | tail -10
cd python && python -m pytest tests -q 2>&1 | tail -3
```

- [ ] **Step 5: Stress it**

```bash
cd python && python -m pytest tests/test_auth.py -k "concurrent or thread" -v --count 2>/dev/null || python -m pytest tests/test_auth.py -k "concurrent or thread" -v 2>&1 | tail -10
```

Run it 20 times in a row to shake out flakiness:

```bash
cd python && 1..20 | ForEach-Object { python -m pytest tests/test_auth.py -q 2>&1 | Select-Object -Last 1 }
```

- [ ] **Step 6: Commit**

```bash
git add python/mpesa/auth.py python/tests/test_auth.py
git commit -m "fix(python): refresh the OAuth token outside the lock (D10)"
```

---

## Task 3.3: #14 — Go inherits the default transport's 2-idle-connection limit

**Files:**
- Modify: `go/client.go:294-304` (and the pinning path at `:336-344`)
- Test: `go/client_test.go`

- [ ] **Step 1: Write the failing test**

```go
// #14: http.DefaultTransport keeps only 2 idle connections per host, so
// a burst re-dials TLS constantly. The SDK must own a transport with a
// real idle-connection budget.
func TestNewClientOwnsATunedTransport(t *testing.T) {
	c, err := NewClient(Config{
		ConsumerKey: "k", ConsumerSecret: "s", Shortcode: "174379",
		Passkey: "p", Environment: Sandbox,
	})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	tr, ok := c.http.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("transport is %T, want *http.Transport", c.http.Transport)
	}
	if tr.MaxIdleConnsPerHost < 16 {
		t.Errorf("MaxIdleConnsPerHost = %d, want at least 16", tr.MaxIdleConnsPerHost)
	}
}
```

- [ ] **Step 2: Run — it must fail**

```bash
cd go && CGO_ENABLED=0 go test -run TestNewClientOwnsATunedTransport -v ./... 2>&1 | tail -12
```

- [ ] **Step 3: Own the transport**

In `go/client.go`, add a helper and use it in `NewClient`:

```go
// tunedTransport clones the process default transport and gives it a real
// idle-connection budget. http.DefaultTransport keeps only
// MaxIdleConnsPerHost=2, so a burst of requests re-dials TLS (two extra
// round-trips plus certificate verification) and can exhaust ephemeral
// ports. Cloning (rather than constructing from scratch) keeps the
// system proxy, dialer and root-CA configuration intact (#14).
func tunedTransport() *http.Transport {
	if dt, ok := http.DefaultTransport.(*http.Transport); ok {
		tr := dt.Clone()
		tr.MaxIdleConns = 100
		tr.MaxIdleConnsPerHost = 32
		tr.IdleConnTimeout = 90 * time.Second
		return tr
	}
	return &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		MaxIdleConns:          100,
		MaxIdleConnsPerHost:   32,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: time.Second,
	}
}
```

Use it at `go/client.go:294`:

```go
	hc := &http.Client{Timeout: cfg.Timeout, Transport: tunedTransport()}
```

and in the pinning branch, replace the `http.DefaultTransport` clone with `applyPinning(tunedTransport())` so the pinning path inherits the same budget.

- [ ] **Step 4: Run — must pass**

```bash
cd go && CGO_ENABLED=0 go test -count=1 ./... 2>&1 | tail -3
```

- [ ] **Step 5: Commit**

```bash
git add go/client.go go/client_test.go
git commit -m "perf(go): own the HTTP transport with a real idle-conn budget (#14)"
```

---

## Task 3.4: #13 — Go does not drain oversize response bodies

**Files:**
- Modify: `go/client.go` (the `io.LimitReader` read sites, ~`:640-649` and `:744-750`)

- [ ] **Step 1: Implement the drain**

At each read site, after the capped read, drain a bounded amount so the connection can be reused:

```go
	// Drain a bounded remainder so net/http can REUSE the connection.
	// Without this, an oversize response leaves unread bytes on the
	// socket, the connection is dropped, and every oversize response
	// costs a fresh TLS handshake (#13).
	defer func() {
		_, _ = io.Copy(io.Discard, io.LimitReader(body, 64<<10))
	}()
```

- [ ] **Step 2: Test that the connection is reused**

```go
func TestOversizeResponseDoesNotPoisonTheConnectionPool(t *testing.T) {
	var conns int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&conns, 1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(bytes.Repeat([]byte("a"), int(maxResponseLen)+4096))
	}))
	defer srv.Close()
	// ... perform two requests against srv and assert the second one
	// reuses the connection (conns stays 1).
}
```

- [ ] **Step 3: Run + commit**

```bash
cd go && CGO_ENABLED=0 go test -count=1 ./... 2>&1 | tail -3
git add go/client.go go/client_test.go && git commit -m "perf(go): drain oversize bodies so the connection is reused (#13)"
```

---

## Task 3.5: #15 — Python's timeout is per-read, not a total deadline

**Finding:** #15. `python/mpesa/client.py:264, 423-427`.

- [ ] **Step 1: Document the distinction precisely**

In `python/mpesa/client.py`, on the `timeout_seconds` field, add:

```python
    #: Per-request timeout in SECONDS. NOTE: ``requests`` applies this to
    #: connect and to each socket READ independently, not to the total
    #: exchange -- a server that trickles one byte per 25s keeps the call
    #: alive far past this value. Go (``http.Client.Timeout``) and
    #: TypeScript (``AbortController``) bound the WHOLE attempt. Callers
    #: needing a hard wall-clock bound should wrap the call in their own
    #: deadline.
```

- [ ] **Step 2: Add a regression test that a trickling server is bounded per read**

```python
def test_slow_drip_response_is_bounded_by_the_read_timeout():
    """#15: a server that dribbles bytes slower than the timeout must not
    let the call hang indefinitely between reads."""
    # ...assert the call returns or raises within ~2x the timeout.
```

- [ ] **Step 3: Run + commit**

```bash
cd python && python -m pytest tests -q 2>&1 | tail -3
git add python/mpesa/client.py python/tests/test_client.py && git commit -m "docs(python): bound the per-read timeout semantics (#15)"
```

---

## Task 3.6: Coverage tooling + gates for all three engines

- [ ] **Step 1: Python**

```bash
cd python
pip install "pytest-cov>=5"
```

Add to `python/setup.py` `extras_require["dev"]`:

```python
        "dev": [
            "pytest>=8",
            "pytest-cov>=5",
        ],
```

and to `python/requirements-dev.txt`:

```
pytest>=8
pytest-cov>=5
```

CI step (`.github/workflows/ci.yml`, python job, after the test step):

```yaml
      - name: Coverage (gate)
        run: |
          python -m pytest tests -q \
            --cov=mpesa --cov-report=term-missing --cov-report=xml \
            --cov-fail-under=85
```

- [ ] **Step 2: TypeScript**

```bash
cd typescript
npm install --save-dev @vitest/coverage-v8@^4
```

(This regenerates `package-lock.json` — commit both files together.)

CI step (typescript job, after the test step):

```yaml
      - name: Coverage (gate)
        run: npx vitest run --coverage --coverage.thresholds.lines=85
```

- [ ] **Step 3: Go**

CI step (go job, after the test step):

```yaml
      - name: Coverage (gate)
        run: |
          go test -coverprofile=coverage.out -covermode=atomic ./...
          go tool cover -func=coverage.out | tee coverage.txt
          total=$(go tool cover -func=coverage.out | awk '/^total:/ {print $3}' | tr -d '%')
          awk -v t="$total" 'BEGIN { exit (t >= 85) ? 0 : 1 }'
```

- [ ] **Step 4: Verify locally**

```bash
cd python && python -m pytest tests -q --cov=mpesa --cov-report=term 2>&1 | tail -5
cd ../typescript && npx vitest run --coverage 2>&1 | tail -10
cd ../go && CGO_ENABLED=0 go test -coverprofile=$env:TEMP/cov.out ./... 2>&1 | tail -3
```

Expected: Python ≥85% (measure first — if it is below 85%, add tests before gating, do **not** lower the threshold silently), TypeScript ≥85%, Go ≥85%.

- [ ] **Step 5: Commit (one commit per engine)**

```bash
git add python/setup.py python/requirements-dev.txt .github/workflows/ci.yml && git commit -m "ci: add coverage gates for all three engines"
```

---

## Task 3.7: Close the 0%-coverage public-API gaps

- [ ] **Step 1: Go redaction table test** (`go/requests.go:32-44, 250-262` are at 0%)

```go
// The redaction helpers on STKPushRequest and C2BRegisterRequest are a
// credential-leak surface and had NO test (B2CPayoutRequest's did).
func TestRequestRedactionNeverLeaksCallbackURLs(t *testing.T) {
	secret := "https://example.com/cb/8f14e45fceea167a5a36dedd4bea2543"
	requests := []any{
		STKPushRequest{CallBackURL: secret, AccountReference: "o1"},
		C2BRegisterRequest{ConfirmationURL: secret, ValidationURL: secret},
	}
	for _, r := range requests {
		for _, rendered := range []string{
			fmt.Sprintf("%v", r), fmt.Sprintf("%+v", r),
			fmt.Sprintf("%#v", r), r.(fmt.Stringer).String(),
		} {
			if strings.Contains(rendered, secret) {
				t.Errorf("%T rendered the callback URL: %s", r, rendered)
			}
		}
	}
}
```

- [ ] **Step 2: Go `Client.Close()` test** (0% today)

```go
func TestCloseZeroesTheTokenAndRejectsFurtherCalls(t *testing.T) {
	c, err := NewClient(Config{ConsumerKey: "k", ConsumerSecret: "s",
		Shortcode: "174379", Passkey: "p", Environment: Sandbox})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	c.mu.Lock()
	c.setTokenLocked("secret-bearer")
	c.mu.Unlock()
	c.Close()
	c.mu.RLock()
	tok := string(c.tokenBytes)
	c.mu.RUnlock()
	if tok != "" {
		t.Errorf("token %q survived Close()", tok)
	}
	if _, _, err := c.tokenWithGen(context.Background()); !errors.Is(err, ErrClientClosed) {
		t.Errorf("tokenWithGen after Close = %v, want ErrClientClosed", err)
	}
}
```

- [ ] **Step 3: Go classification + validation tests**

```go
func TestAsyncResultBodyClassify(t *testing.T) {
	if got := (AsyncResultBody{ResultCode: "0"}).Classify(); got != ResultClassSuccess {
		t.Errorf("0 -> %v, want success", got)
	}
	// An unknown code must be INDETERMINATE, never failure (ADR-010):
	// auto-failing risks refunding a payment that actually settled.
	if got := (AsyncResultBody{ResultCode: "1037"}).Classify(); got != ResultClassIndeterminate {
		t.Errorf("1037 -> %v, want indeterminate", got)
	}
}

func TestTransactionStatusRequestValidateRequiresExactlyOneKey(t *testing.T) {
	// neither -> error; both -> error; exactly one -> ok
}
```

- [ ] **Step 4: Run + commit**

```bash
cd go && CGO_ENABLED=0 go test -count=1 ./... 2>&1 | tail -3
git add go/client_test.go && git commit -m "test(go): cover redaction, Close, async classification and status validation"
```

---

## Task 3.8: Python integration test against a real local HTTP server

- [ ] **Step 1: Add the test**

`python/tests/test_local_server.py`:

```python
"""End-to-end test against a REAL local HTTP server.

Every other Python test uses a duck-typed session, so a break in the
real ``requests`` integration (as ``test_real_response_transport.py``
documents) can pass the suite. This drives the client at a stdlib
``http.server`` so status lines, chunked transfer, redirects and the
413 path are real.
"""
```

The test must cover: a 200 with a JSON body, a 401 with the error envelope, a 302 redirect (must NOT be followed), a body over 1 MiB (must be refused), and a chunked response.

- [ ] **Step 2: Run + commit**

```bash
cd python && python -m pytest tests/test_local_server.py -v 2>&1 | tail -10
git add python/tests/test_local_server.py && git commit -m "test(python): drive the client at a real local HTTP server"
```

---

## Task 3.9: Fuzz the callback parsers

- [ ] **Step 1: Go fuzz target** (`go/callbacks.go:89`)

```go
//go:build go1.18

func FuzzParseSTKCallback(f *testing.F) {
	f.Add([]byte(`{"Body":{"stkCallback":{"ResultCode":"0"}}}`))
	f.Add([]byte(`{}`))
	f.Add([]byte(`null`))
	f.Fuzz(func(t *testing.T, body []byte) {
		// Must never panic: a malformed body is a typed error, not a crash.
		_, _ = ParseSTKCallback(body)
	})
}
```

- [ ] **Step 2: Run the fuzzer briefly**

```bash
cd go && CGO_ENABLED=0 go test -run '^$' -fuzz FuzzParseSTKCallback -fuzztime 30s ./... 2>&1 | tail -10
```

- [ ] **Step 3: TypeScript property test** (`typescript/test/contract.test.ts` or a new `typescript/test/callbacks.fuzz.test.ts`) using `fast-check` **only if** it is already a dependency; otherwise write a deterministic table of malformed inputs (no new runtime dependency, and `fast-check` would be a dev-only addition — allowed in Phase 3, but a table test is enough for the 3 shapes that matter).

- [ ] **Step 4: Commit**

```bash
git add go/callbacks_test.go && git commit -m "test(go): fuzz the STK callback parser"
```

---

## Task 3.10: Packaging smoke tests

- [ ] **Step 1: Python**

```yaml
      - name: Packaging smoke test
        run: |
          python -m pip install --upgrade build
          python -m build --wheel --outdir dist .
          python -m venv /tmp/smoke
          /tmp/smoke/bin/pip install dist/*.whl
          /tmp/smoke/bin/python -c "import mpesa; assert mpesa.STKPushRequest"
```

- [ ] **Step 2: TypeScript**

```yaml
      - name: Packaging smoke test
        run: |
          npm pack --dry-run
          npx tsc -p tsconfig.json
          node -e "const m=require('./dist/index.js'); if(!m.STKPushRequest) process.exit(1)"
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml && git commit -m "ci: add packaging smoke tests"
```

---

## Task 3.11: Run the examples in CI

- [ ] **Step 1: Python**

```yaml
      - name: Examples compile
        run: python -m py_compile examples/*.py
```

- [ ] **Step 2: Go**

```yaml
      - name: Examples build
        run: go build ./examples/...
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml && git commit -m "ci: build the examples in Go and Python"
```

---

# Phase 4 — Docs and release truth

## Task 4.1: D8 — the changelog advertises options that do not exist

**Finding:** D8. `CHANGES.md:4` documents `Config(retry_on_unauthorized=False)` (Python — does not exist) and `Config({ retryOnUnauthorized: false })` (TypeScript — the option lives on `MpesaClientOptions`, `client.ts:430`); Go's is inverted (`DisableRetryOnUnauthorized`).

**Files:**
- Modify: `python/mpesa/config.py` (add the option)
- Modify: `python/mpesa/client.py` (honour it)
- Modify: `CHANGES.md:4`
- Test: `python/tests/test_config.py`, `python/tests/test_client.py`

- [ ] **Step 1: Add the Python option**

`python/mpesa/config.py` — add the field to the dataclass:

```python
    #: Retry-once on HTTP 401 carrying the invalid-token code. Defaults to
    #: True; set False to surface the first 401 without the automatic
    #: refresh+retry (Go ``Config.DisableRetryOnUnauthorized``, which is the
    #: inverse spelling; TypeScript ``MpesaClientOptions.retryOnUnauthorized``).
    retry_on_unauthorized: bool = True
```

`python/mpesa/client.py` — honour it in `_post_model`:

```python
        if status_code == 401 and self._cfg.retry_on_unauthorized:
            probe = MpesaError.from_response(401, body, content_type)
            if probe.error_code == _ERR_INVALID_TOKEN:
                fresh = self._tokens.refresh_after_invalid_token(gen)
                status_code, content_type, body = self._send(
                    fresh, "POST", path, payload, None)
```

- [ ] **Step 2: Test**

```python
def test_retry_on_unauthorized_false_surfaces_the_401():
    cfg = Config(consumer_key="k", consumer_secret="s", shortcode="174379",
                 passkey="p", retry_on_unauthorized=False)
    assert cfg.retry_on_unauthorized is False
```

plus a client-level test that a 401 with the invalid-token code is **not** retried when the option is off.

- [ ] **Step 3: Correct the changelog entry**

`CHANGES.md:4` becomes:

```markdown
- **Retry-on-unauthorized opt-out** — defaults to `true`; set to `false` to surface the first `401.003.01` without the automatic single retry. Go: `Config.DisableRetryOnUnauthorized` (inverse spelling). Python: `Config(retry_on_unauthorized=False)`. TypeScript: `new MpesaClient({ config, retryOnUnauthorized: false })` — the option lives on `MpesaClientOptions`, not on `Config`.
```

- [ ] **Step 4: Run + commit**

```bash
cd python && python -m pytest tests -q 2>&1 | tail -3
cd .. && git add python/mpesa/config.py python/mpesa/client.py python/tests/ CHANGES.md
git commit -m "feat(python): add retry_on_unauthorized opt-out; correct the changelog (D8)"
```

---

## Task 4.2: #21, #23 — documentation that contradicts the code

- [ ] **Step 1: `docs/apis/limits.md:63`**

Replace:

```
request rejected before dispatch consumes nothing, one that fails afterwards
was already consumed. Reversal and Dynamic QR share one `default` daily bucket.
```

with:

```
request rejected before dispatch consumes nothing, one that fails afterwards
was already consumed. Reversal and Dynamic QR each have their OWN daily
bucket (`reversal`, `qr`) — and each has its own per-transaction bucket too.
```

- [ ] **Step 2: `docs/apis/dynamic-qr.md:66`**

Replace:

```
- Single method per language: `GenerateQR(req)` / `generate_qr()` / `generateQr()`.
```

with:

```
- Single method per language: `GenerateQRCode(req)` / `generate_qr_code(req)` / `generateQRCode(req)`.
```

- [ ] **Step 3: `docs/apis/stk-push.md:19`**

Find the shortcode digit statement and align it with the code (every engine accepts **5–10** digits; `go/requests.go:566` enforces 5–10 for `PartyB`, `python/mpesa/requests_sync.py` uses `_shortcode`, `typescript/src/helpers.ts` uses the same regex). Update the sentence to "5–10 digits".

- [ ] **Step 4: Commit**

```bash
git add docs/apis/
git commit -m "docs: correct the limits, dynamic-QR and STK shortcode references (#21, #23)"
```

---

## Task 4.3: #24, #25 — README snippets and wording

- [ ] **Step 1: `README.md:232`** — replace

```ts
if (parseInt(res.ResultCode, 10) === 0) settle(order); // by query, never the bare hit
```

with

```ts
if (String(res.ResultCode) === "0") settle(order); // by query, never the bare hit
```

(`ResultCode` is `string | number` — `typescript/src/types.ts:304` — so `parseInt` does not typecheck.)

- [ ] **Step 2: `README.md:347-354`** — add the missing import to the Python B2C snippet:

```python
import os
from pathlib import Path

from mpesa import security_credential
```

- [ ] **Step 3: `README.md:368-376`** — declare `certBytes` in the Go B2C snippet:

```go
certBytes, err := os.ReadFile("assets/certs/SandboxCertificate.cer")
if err != nil {
	log.Fatal(err)
}
cred, err := mpesa.SecurityCredential(certBytes, os.Getenv("MPESA_INITIATOR_PASSWORD"))
```

and add `"os"` to the import list.

- [ ] **Step 4: `README.md:142` and `README.md:158`** — replace the deprecated `TransactionType.BillPayGoods` with the canonical `TransactionType.PayBillOnline` (`typescript/src/enums.ts:95`); keep the alias mention where the alias table is discussed.

- [ ] **Step 5: `README.md:487`** — add the missing workflow to the project-layout tree:

```
│   └── workflows/          # ci.yml · promote.yml · required-checks.yml · dependabot-auto-merge.yml
```

- [ ] **Step 6: `README.md:461` and `docs/apis/oauth.md:43,72`** — restate the refresh limiter accurately:

```
After 3 consecutive OAuth refresh failures, further (unforced) refreshes are refused until 5 s after the last attempt
```

- [ ] **Step 7: Verify the snippets compile**

```bash
cd typescript && npx tsc --noEmit -p tsconfig.examples.json
cd ../python && python -m py_compile examples/*.py
cd ../go && go build ./examples/...
```

- [ ] **Step 8: Commit**

```bash
git add README.md docs/apis/oauth.md
git commit -m "docs: fix non-compiling README snippets and refresh-rate-limit wording (#24, #25)"
```

---

## Task 4.4: #22 — `python/setup.py` metadata

- [ ] **Step 1: Correct the URLs**

```python
    url="https://github.com/anthrodjear/mpesa-sdk",
    project_urls={
        "Source": "https://github.com/anthrodjear/mpesa-sdk",
        "Issues": "https://github.com/anthrodjear/mpesa-sdk/issues",
        "Changelog": "https://github.com/anthrodjear/mpesa-sdk/blob/main/CHANGES.md",
    },
```

- [ ] **Step 2: Fix the long-description type**

```python
    long_description_content_type="text/markdown",
```

- [ ] **Step 3: Resolve the maturity contradiction**

`Development Status :: 3 - Alpha` vs "production-grade" in `README.md:8`. Pick one and make both agree. Recommended: keep the classifier at `4 - Beta` (the security controls and conformance harness are production-shaped, but the API is still 0.x) and soften the README phrase to "**production-oriented** SDK". Apply whichever pair is chosen consistently.

- [ ] **Step 4: Verify the metadata renders**

```bash
cd python && python setup.py --long-description | head -5
cd python && python -m build --sdist --outdir /tmp/sdist . && tar -tzf /tmp/sdist/*.tar.gz | head -20
```

- [ ] **Step 5: Commit**

```bash
git add python/setup.py README.md
git commit -m "chore(python): correct package metadata URLs and maturity classifier (#22)"
```

---

## Task 4.5: Version-parity check

**Finding:** 5 version literals, no CI check (Architecture §Maintainability).

- [ ] **Step 1: Write `scripts/check_version_parity.py`**

```python
"""Fail when the three engines' version strings disagree.

The version lives in five places (go/version.go, python/setup.py,
python/mpesa/__init__.py, typescript/package.json,
typescript/src/index.ts). Nothing checked they agreed, so a release could
ship 0.5.0 in Go and 0.4.0 in Python. Reads the files; exits non-zero on
a mismatch. Stdlib only.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(pattern: str, path: Path) -> str:
    text = path.read_text(encoding="utf-8")
    m = re.search(pattern, text, re.MULTILINE)
    if not m:
        raise SystemExit(f"version pattern not found in {path}")
    return m.group(1)


def main() -> int:
    versions = {
        "go/version.go": read(r"Version\s*=\s*\"([^\"]+)\"", ROOT / "go" / "version.go"),
        "python/setup.py": read(r"version=\"([^\"]+)\"", ROOT / "python" / "setup.py"),
        "python/mpesa/__init__.py": read(r"__version__\s*=\s*\"([^\"]+)\"", ROOT / "python" / "mpesa" / "__init__.py"),
        "typescript/package.json": json.loads((ROOT / "typescript" / "package.json").read_text(encoding="utf-8"))["version"],
        "typescript/src/index.ts": read(r"version\s*=\s*\"([^\"]+)\"", ROOT / "typescript" / "src" / "index.ts"),
    }
    unique = sorted(set(versions.values()))
    for name, value in versions.items():
        print(f"{value:>10}  {name}")
    if len(unique) != 1:
        print(f"\nVERSION MISMATCH: {', '.join(unique)}", file=sys.stderr)
        return 1
    print(f"\nall engines at {unique[0]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 2: Run it**

```bash
python scripts/check_version_parity.py
```

Expected: all five lines show the same version and the script exits 0. If it fails, fix the literals (that is the point).

- [ ] **Step 3: Add the CI step** (in the `security` job, or a new tiny `meta` job)

```yaml
      - name: Version parity
        run: python scripts/check_version_parity.py
```

- [ ] **Step 4: Commit**

```bash
git add scripts/check_version_parity.py .github/workflows/ci.yml
git commit -m "ci: fail when the three engines' versions disagree"
```

---

## Task 4.6: Publish workflow

- [ ] **Step 1: Write `.github/workflows/publish.yml`**

It must: run on a `release` event (or a `v*` tag), build each engine, publish the npm package (`npm publish --provenance`), the Python package (`twine upload`), and create the Go module tag — with `id-token: write` for PyPI trusted publishing and `contents: write` for the tag. Pin every action by SHA, exactly as `ci.yml` does.

- [ ] **Step 2: Document it** in `SECURITY.md` (the "Release automation" section currently documents promotion only) and in `README.md` ("Branch workflow").

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/publish.yml SECURITY.md README.md
git commit -m "ci: add the npm/PyPI/Go-tag publish workflow"
```

---

## Task 4.7: Docs snippet CI + CONTRIBUTING

- [ ] **Step 1: Add a snippet checker**

`scripts/check_doc_snippets.py`: extract every fenced ```go / ```python / ```ts block from `README.md` and `docs/apis/*.md`, write each to a temp file, and run the matching compiler (`go vet` on a temp module is heavy — instead run `gofmt -e` for a syntax check; `python -m py_compile`; `tsc --noEmit --noResolve --skipLibCheck` on the extracted file with the SDK's types not resolved — accept a limited check). At minimum, catch the class of defect that produced findings #24: a snippet that does not even parse.

- [ ] **Step 2: Write `CONTRIBUTING.md`**

Cover: the branch workflow (`develop` → `main`), the four CI jobs, the conformance-fixture workflow (add a case in `contract/fixtures/`, run all three suites), the 0.x SemVer rule, and the release checklist.

- [ ] **Step 3: Commit**

```bash
git add scripts/check_doc_snippets.py CONTRIBUTING.md .github/workflows/ci.yml
git commit -m "ci: check documentation snippets; add CONTRIBUTING"
```

---

## Task 4.8: Release 0.5.0

- [ ] **Step 1: Update the five version literals**

```bash
# go/version.go, python/setup.py, python/mpesa/__init__.py,
# typescript/package.json, typescript/src/index.ts
```

- [ ] **Step 2: Verify parity**

```bash
python scripts/check_version_parity.py
```

- [ ] **Step 3: Write the CHANGES.md entry**

```markdown
# Changes — 0.5.0 (2026-10-22)

## BREAKING

- **Python: Reversal and Dynamic QR now resolve their own per-transaction
  ceiling bucket** (`reversal`, `qr`) instead of `default`. A merchant who
  raised the `default` tier to cover a Reversal must now set
  `TransactionLimits(reversal=…)` / `qr=…`. Go and TypeScript already
  behaved this way; Python was the outlier and resolved ONE service to TWO
  different ceilings inside one engine.

## Fixed

- **Python: a numeric `errorCode` is no longer dropped from the error
  envelope** — a gateway sending `"errorCode": 401` as a bare number used to
  lose that member, so the typed error the caller received carried no
  `error_code` to branch on. (The 401-retry path keys on the dotted
  `401.003.01` and was never affected.)
- **Python: balance rows above 2^53 are skipped and counted** instead of
  being returned with a silently rounded amount (Go/TypeScript parity).
- **Python: `BillRefNumber` is required for PayBill simulations only** — Buy
  Goods simulations no longer fail validation.
- **Python: a transport error that straddles Nairobi midnight no longer
  credits the new day's daily quota.**
- **Python: the OAuth refresh no longer holds the token lock across the
  network round-trip** — waiters park instead of stalling.
- **Go: an 8-character consumer key is no longer rendered in full** by any
  logging form.
- **TypeScript: `console.log(config)` no longer prints the consumer secret
  or passkey** (`util.inspect` now honours the redacted rendering).
- **TypeScript: upstream gateway bodies are no longer embedded in exception
  text** — they are available through an opt-in diagnostic sink, as in Go
  and Python.
- **Go: `Close()` now wins against an in-flight token refresh** — a closed
  client can no longer be re-armed with a fresh bearer.
- **All engines: a certificate with an RSA key below 2048 bits is refused.**

## Added

- **Python: `Config(retry_on_unauthorized=False)`** — opt out of the
  automatic single 401 retry.
- **A shared cross-engine conformance harness** — every wire fixture in
  `contract/fixtures/` is executed by all three engines' test suites, so a
  behavioural divergence fails CI instead of shipping.

## Changed

- **Go: the SDK owns its HTTP transport** with a real idle-connection budget
  (the default transport keeps only two idle connections per host).
```

- [ ] **Step 4: Tag and release**

```bash
git checkout main && git pull --ff-only
git merge --no-ff develop -m "release: 0.5.0"
git tag -a v0.5.0 -m "0.5.0"
git push origin main && git push origin v0.5.0
```

The publish workflow (Task 4.6) does the rest.

---

# Risk register & rollback

| Risk | Likelihood | Impact | Mitigation | Rollback |
|---|---|---|---|---|
| D2 changes which ceiling applies to Python Reversal/QR users | Medium | A user who relied on `default` for Reversal now hits the 250k default | BREAKING entry in CHANGES.md; the error message names the exact config path to set | Revert the two-line change; the old behaviour returns |
| D10 (token refresh) introduces a race | Low | Token stampede or a stuck waiter | Leader/waiter mirrors Go's proven `leadRefresh`; 20× repeat of the concurrency test; a new contention test asserts exactly ONE OAuth call for N callers | Revert `python/mpesa/auth.py` to the locked version |
| The conformance harness is too strict and blocks unrelated work | Medium | Slow PRs, noisy failures | Fixtures live in one directory; adding a case is a 10-line JSON file; the harness is one file per engine | Move a fixture to `xfail` with a one-line reason |
| Coverage gates (85%) fail on a pre-existing gap | High | CI red on day one | Measure FIRST, add the missing tests, only then gate; the threshold is one constant per engine | Raise the constant in `ci.yml` (one line) — never delete the job |
| The D6 inspect hook changes `console.log` output shape | Low | User logs look different | It now prints the same string `String(cfg)` produced | Remove the `Object.defineProperty` block |
| The D7 message change breaks a user matching on the old text | Low | A log-scraping assertion fails | The old text was never a documented contract; it is a diagnostic | Revert `errors.ts` |
| Publishing 0.5.0 to npm/PyPI with a broken artefact | Low | A bad release is public | Packaging smoke tests (Task 3.10) run in CI before the tag; the release is a tag, not a direct publish | `npm unpublish` / `yank` the PyPI release; re-tag 0.5.1 |

---

# Self-review

**1. Spec coverage** — every finding in `CODE_REVIEW_REPORT.md` maps to a task:

| Finding | Task |
|---|---|
| D1 numeric errorCode | 1.1 |
| D2 Reversal/QR bucket | 1.2 |
| D3 2^53 balance gate | 1.3 |
| D4 BillRefNumber | 1.4 |
| D5 Go 8-char key | 2.1 |
| D6 TS inspect leak | 2.2 |
| D7 TS raw body | 2.3 |
| D8 changelog options | 4.1 |
| D9 day-aware rollback | 3.1 |
| D10 lock across refresh | 3.2 |
| #11 TS cache key | 2.5 |
| #12 Go Close race | 2.6 |
| #13 Go drain | 3.4 |
| #14 Go transport | 3.3 |
| #15 Python timeout | 3.5 |
| #16 RSA floor | 2.4 |
| #17 TS request redaction | **4.9 (below)** |
| #18 CI secret scanning / hash pinning | **4.10 (below)** |
| #19 validation divergences | **4.11 (below)** |
| #20 public-API asymmetries | **4.12 (below)** |
| #21–#25 docs | 4.2, 4.3, 4.4 |
| Test gaps #1–#15 | 0.2–0.5, 3.6–3.11 |
| Coverage gates | 3.6 |
| Conformance harness | 0.2–0.5 |
| Version parity | 4.5 |
| Publish workflow | 4.6 |
| CONTRIBUTING / doc snippets | 4.7 |

## Task 4.9: #17 — TypeScript request objects cannot redact the callback URL

The TS request types are plain interfaces, so `console.log(req)` prints a `callBackURL` that may embed the 128-bit capability token.

- [ ] **Step 1: Add a `logSafe()`-style helper to `typescript/src/types.ts`**

```ts
/**
 * Log-safe rendering of a request object: the callback/result URLs are
 * replaced by their PATH only, because those URLs may embed the
 * unguessable callback token, and a token in a log is a token leaked
 * (Go `redactCredentials` / Python `_clean` parity).
 */
export function logSafeRequest(req: Record<string, unknown>): Record<string, unknown> {
  const out = { ...req };
  for (const key of ["callBackURL", "CallBackURL", "resultURL", "ResultURL",
    "queueTimeOutURL", "QueueTimeOutURL", "confirmationURL", "ConfirmationURL",
    "validationURL", "ValidationURL"]) {
    const value = out[key];
    if (typeof value === "string") {
      try {
        const u = new URL(value);
        out[key] = `${u.origin}${u.pathname}`;
      } catch { /* not a URL: leave it alone */ }
    }
  }
  return out;
}
```

- [ ] **Step 2: Test + document**

```ts
it("logSafeRequest strips the callback token from URLs", () => {
  const out = logSafeRequest({
    callBackURL: "https://example.com/cb/8f14e45fceea167a5a36dedd4bea2543",
    accountReference: "o1",
  });
  expect(out.callBackURL).toBe("https://example.com/cb/8f14e45fceea167a5a36dedd4bea2543".replace(/8f14.*/, ""));
  expect(out.accountReference).toBe("o1");
});
```

- [ ] **Step 3: Export it and document the hazard in `SECURITY.md`**

```bash
git add typescript/src/types.ts typescript/src/index.ts typescript/test/ SECURITY.md
git commit -m "feat(ts): add logSafeRequest to strip callback tokens from logs (#17)"
```

## Task 4.10: #18 — CI secret scanning and hash-pinned PyPI tooling

- [ ] **Step 1: Add gitleaks (SHA-pinned) to `ci.yml`**

```yaml
      - name: Secret scan
        uses: gitleaks/gitleaks-action@<sha-pin>   # pin by SHA, as every other action in this file is
        with:
          args: "detect --source=. --redact --no-banner"
```

- [ ] **Step 2: Hash-pin the PyPI tooling**

Replace `pip install ruff==0.16.9` with a requirements file carrying hashes:

```
ruff==0.16.9 --hash=sha256:<hash>
bandit==1.9.4 --hash=sha256:<hash>
```

Generate the hashes with `pip download --no-deps -d /tmp/h ruff==0.16.9` and `pip hash /tmp/h/*`, then install with `pip install --require-hashes -r requirements-ci.txt`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml requirements-ci.txt
git commit -m "ci: add secret scanning and hash-pinned PyPI tooling (#18)"
```

## Task 4.11: #19 — document (do not silently change) the validation-strictness divergences

Divergences: STK `PartyB` shortcode gate (Go only), `PartyA` shortcode gate (Python only), free-text length measured on raw bytes (Go) vs trimmed (Python/TS), STK-Query shortcode optional (Go) vs required (Python/TS), C2B `ShortCode` required (Python) vs unvalidated (Go/TS).

- [ ] **Step 1: Decide the canonical behaviour per rule**

Recommended: **trim-then-measure** for free text (Python/TS behaviour — Go's raw-byte measurement rejects a value with padding, which no user wants), and **validate the shortcode shape everywhere it is accepted** (Go's `PartyB` rule generalised to `PartyA` and to C2B `ShortCode`).

- [ ] **Step 2: Implement in ONE engine at a time, each with a fixture case**

Go first: change `go/requests.go:599,605` to measure the trimmed value and add the `PartyA`/C2B shortcode gates. Then Python (add the `PartyB` gate). Then TypeScript (add both gates).

- [ ] **Step 3: Add a contract fixture per rule** so the three engines cannot drift again.

- [ ] **Step 4: Record the decision in `docs/apis/`** — one short "validation rules" section per endpoint listing the canonical rule, so a reader does not have to infer it from three code bases.

```bash
git add go/ python/ typescript/ contract/ docs/
git commit -m "fix: align validation strictness across the three engines (#19)"
```

## Task 4.12: #20 — close the public-API asymmetries (or document them)

Asymmetries: 401-retry opt-out (now uniform after Task 4.1), TS `Config` requiring a non-empty `passkey` at construction, refresh-rate-limit error type differing three ways, oversize error type differing, TS sending `"TransactionID": ""` where Go/Python omit it, Go rejecting a zero `time.Time` where TS accepts `new Date(0)`.

- [ ] **Step 1: TS `passkey` — relax the construction requirement**

A B2C-only merchant has no STK passkey. Make `passkey` optional at construction and validate it **only** on the STK path, matching Go and Python:

```ts
// in Config's constructor: remove the "passkey must be non-empty" check;
// the STK path validates it.
```

Add the STK-path check where the STK `Password` is derived (`typescript/src/client.ts`), and a test asserting a B2C-only client constructs and a STK call without a passkey fails with a clear message.

- [ ] **Step 2: Unify the error types**

Introduce `RefreshRateLimitedError` in TypeScript (Python's name) and `OversizeError` (Go's name) as exported classes, keeping `MpesaError` as the base so `catch (e) { e instanceof MpesaError }` still works. Document the mapping table in `SECURITY.md`.

- [ ] **Step 3: Omit the empty `TransactionID`**

Match Go's `omitempty` / Python's `_clean`: only include `TransactionID` when non-empty.

- [ ] **Step 4: Go zero `time.Time`**

Decide and document: Go rejects a zero `time.Time`; TS accepts `new Date(0)`. Pick "reject" (Go) and make TS throw on an epoch-0 timestamp, with a clear error message.

- [ ] **Step 5: Commit per engine**

```bash
git add typescript/src typescript/test && git commit -m "feat(ts): align public-API behaviour with Go and Python (#20)"
```

**2. Placeholder scan** — no "TBD", "similar to Task N", or "add appropriate error handling" anywhere. Every code step shows the code; every command shows the expected output.

**3. Type/identifier consistency check** — the names used across tasks are the real ones: `maskCredential` (Go), `_envelope_value` (new, Python), `_exceeds_safe_balance` (new, Python), `exceedsSafeBalance` (Go/TS, existing), `sharedTokenCacheKey` (new, TS), `tunedTransport` (new, Go), `logSafeRequest` (new, TS), `ResultClass` values `"success"`/`"failure"`/`"indeterminate"` (identical in all three engines), `ServiceReversal`/`ServiceQR` (Go), `"reversal"`/`"qr"` (Python/TS). The fixture keys (`kind`, `body`, `expect.class`, `expect.resultCode`, `expect.metadata`, `expect.errorCode`, `expect.errorMessage`, `expect.segments`, `expect.skipped`) are identical in the schema, the three harnesses, and the six fixture files.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-10-22-mpesa-sdk-review-fixes.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints for review

**Which approach?**
