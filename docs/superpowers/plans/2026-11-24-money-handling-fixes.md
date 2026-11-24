# Money Handling Fixes Implementation Plan

**Goal:** Close the High/Medium money-handling findings from the 2026-11-24 review in all three SDK engines without changing the Daraja wire contract.

**Architecture:** Each language keeps its existing representation (whole-KES `int64` / `int` / `number` outbound, `Decimal` inbound in Python). Fixes are additive: a strict amount accessor + verification helper in each engine, stricter request-side integer gates, and saturation in the daily ledger. Parsing/wire behaviour stays byte-for-byte compatible; ambiguous metadata is refused by the *verification* helper rather than by `parse()`.

**Tech Stack:** Go 1.26 (stdlib only), Python 3.11+ (`decimal`), TypeScript 5.9 (Node >=20, vitest).

## Global Constraints

- **No wire-format changes** — `Amount` remains a whole-KES integer on every outbound request. Existing fixtures must still pass unchanged.
- **No breaking public API changes** — new methods are additive; existing `amount()` accessors keep their names/signatures (they gain stricter rejection).
- **Cross-engine parity** — the same input must be accepted/rejected by all three engines.
- **TDD** — every production change has a test that was observed failing first (test-driven-development skill).
- **No edits to** `contract/fixtures/*`, `typescript/dist/*`, or root `README.md` (the coordinator owns docs).
- **Full suites must pass** per engine: `go test ./...` in `go/`, `pytest -q` in `python/`, `npm test` + `npm run typecheck` in `typescript/`.

## Findings (todo source)

| ID | Severity | Finding | Status |
|----|----------|---------|--------|
| M1 | High | TS `requirePositiveInt` uses `Number.isInteger`, admits `2**53` / `1e21`; serialises to exponent notation | [x] fixed — `Number.isSafeInteger` + `MAX_AMOUNT` + canonical payload gate |
| M2 | High | No SDK-level callback amount → original-request verification; examples settle on unsigned callback amount | [x] fixed — `verify_amount` / `AmountMatches` / `amountMatches` on callbacks and async results |
| M3 | High | Go has no safe amount accessor; `MetadataMap()` returns mixed `int64`/`float64`/`string`, integral values >int64 degrade to corrupted `float64` | [x] fixed — strict `Amount()` / `AmountMatches()`; `MetadataMap()` unchanged |
| M4 | High | Python `Decimal` input bypasses shape gate and is silently rounded with context default `ROUND_HALF_EVEN` (`1.005 → 1.00`) | [x] fixed — Decimal routed through the same 2dp ASCII shape gate |
| M5 | Medium | All three decode helpers accept negative money | [x] fixed — zero/negative rejected in all three engines |
| M6 | Medium | Duplicate Amount metadata is first-wins; only an advisory counter | [x] fixed — all verification helpers refuse `duplicateKeys() > 0`; parsing stays first-wins for wire parity |
| M7 | Medium | Daily ceiling is advisory/per-process; timeout rollback under-counts real spend | [x] documented (behaviour change deferred) |
| M8 | Medium | Generated idempotency keys not returned → retry-after-timeout can double-pay | [ ] deferred — API design decision |
| M9 | Low | Ledger arithmetic lacks saturation / over-rollback can zero a bucket | [x] fixed in Go and TS; Python's arbitrary-precision ledger was already safe |
| M10 | Low | No Money/Currency type; balances are floats in Go/Python | [ ] deferred — breaking redesign |

Re-review (2026-11-24) nits closed — see the Verification results section below.

## Task 1: Go — strict amount accessor + ledger saturation

**Files:**
- Modify: `go/callbacks.go` (add `Amount()` / `AmountMatches()` on `STKCallbackResult`; keep `MetadataMap()` unchanged; documented exponent-form behavior + pin test)
- Modify: `go/limits.go` (saturating consume + clamped rollback)
- Modify: `go/money_hardening_test.go` (new)
- Modify: `go/examples/callbacks/main.go` (use the accessor)

- [x] **Step 1:** Write failing tests covering accepted/rejected shapes, `AmountMatches` true/false, duplicate rejection, exponent-form pin, saturation, and clamped rollback.
- [x] **Step 2:** Run `cd go; go test ./...`; verified the failures were the missing method / negative amounts / ledger wrap, not typos.
- [x] **Step 3:** Implemented the accessors and ledger saturation in `go/callbacks.go` / `go/limits.go`.
- [x] **Step 4:** Full suite → `ok github.com/anthrodjear/mpesa-sdk/go`.

## Task 2: Python — Decimal shape gate + non-positive rejection + verification

**Files:**
- Modify: `python/mpesa/coercion.py`
- Modify: `python/mpesa/callbacks.py` (`StkCallbackResult.amount`, add `verify_amount`)
- Modify: `python/mpesa/results.py` (`AsyncResult.verify_amount`)
- Modify: `python/mpesa/client.py` (rollback day check + non-positive guard)
- Modify: `python/examples/callbacks.py`
- Modify: tests: `python/tests/test_coercion.py`, `test_callbacks.py`, `test_limits.py`

- [x] **Step 1:** Write failing tests first (RED: sub-cent Decimal, negative amounts, `verify_amount`, rollback day).
- [x] **Step 2:** Run `pytest -q tests/`; observed 31 expected RED failures.
- [x] **Step 3:** Implement fixes (Decimal through shape gate, `verify_amount`, rollback day guard).
- [x] **Step 4:** Full suite → **986 passed**.

## Task 3: TypeScript — safe-integer requests + strict verification + ledger saturation

**Files:**
- Modify: `typescript/src/client.ts`, `coercion.ts`, `callbacks.ts`, `types.ts`, `limits.ts`, `config.ts`
- Modify: `typescript/test/money-hardening.test.ts`, `test/coercion.test.ts`, `test/limits.test.ts`

- [x] **Step 1:** Write failing tests first (RED: unsafe amounts reaching limits, missing `amountMatches`, fractional ceilings, sub-ULP ledger overspend).
- [x] **Step 2:** Run `npm test` → 23 expected RED failures.
- [x] **Step 3:** Implement (safe-integer gates + `MAX_AMOUNT`, `assertCanonicalAmountPayload`, `amountMatches` on `StkCallback`/`ParsedAsyncResult`, saturating ledger, `isValidCeiling`).
- [x] **Step 4:** Full suite → **769 passed (19 files)**; `npm run typecheck` and `npm run typecheck:examples` clean.

## Task 4: Documentation + todo status (coordinator)

**Files:** `README.md`, `SECURITY.md`, `docs/apis/stk-push.md`, `go/README.md`, `typescript/README.md`

- [x] **Step 1:** Update settlement guidance to show the verified helper and stress: callback amount is never authoritative.
- [x] **Step 2:** Document M7/M8/M10 limitations explicitly (advisory local budget; deferred M8 needs an API design decision; single-currency KES API — already documented).
- [x] **Step 3:** Re-run all three suites; record results; tick the table.

## Re-review (2026-11-24) nits

| Engine | Finding | Status |
|--------|---------|--------|
| Go | Nit-1: exponent-form integral tokens (`Value: 1e3`) accepted by `Amount()` — documented behavior, pinned | [x] documented `go/callbacks.go:136-148` + pinned `TestSTKCallbackAmountAcceptsExponentFormIntegralTokens` (`go/money_hardening_test.go:108`) |
| Python | Nit-3: `_rollback_daily` had no non-positive guard (unreachable today) | [x] guard added (`python/mpesa/client.py:443-451`), pin added (`test_limits.py:929`) |
| TypeScript | Nit (P2): `amountMatches(expected)` now requires safe-integer positive expected | [x] added (`typescript/src/callbacks.ts:283`, `typescript/src/types.ts:1138`) + pins (`typescript/test/money-hardening.test.ts:196-203`) |

## Deferred (with rationale)

- **M8 idempotency keys**: requires exposing/accepting `OriginatorConversationID` in the public API of all three engines — a design decision beyond a safe patch. Until then, docs instruct callers to set and persist their own key (`docs/apis/b2c.md:20`).
- **M10 Money/Currency type**: breaking change across every request/response struct; defer to a major version. Keep integer whole-KES + documented currency invariant for now.
- **M7 timeout rollback**: narrowing refunds to "provably never dispatched" needs a reconciliation workflow (STK Query before refund); changing it silently would strand legitimate quota. Kept as documented advisory behaviour (`docs/apis/limits.md:53`).
- **Shared daily ledger**: infrastructure dependency (Redis/DB) not appropriate for a zero-dep SDK core; document as operator responsibility.

## Verification results (2026-11-24)

| Engine | Command | Result |
|--------|---------|--------|
| Go | `go test ./...` | `ok github.com/anthrodjear/mpesa-sdk/go` (all packages) |
| Go | `go test ./ -count=1` | ok |
| Python | `python -m pytest -q` | **986 passed**, 87 warnings in 4.88s |
| Python | `python -m ruff check mpesa tests` / `examples` | All checks passed |
| TypeScript | `npm test` | **769 passed (769)**, 19 files |
| TypeScript | `npm run typecheck` / `typecheck:examples` | exit 0 |

Re-review evidence: fresh review subagents for Go, Python, TypeScript, and security found no new High/Medium issues after the fixes (see the REVIEW section in the session notes).
