# Security / correctness audit — 2026-11-22

**Scope:** full repository (Go, Python, TypeScript SDKs, docs, CI, examples).
**Author:** anthrodjear
**Method:** eight parallel review scopes produced 44 raw findings; each was
independently checked against the code before any change was made, then fixed
and re-verified. Findings that were intentional or test-pinned behaviours were
rejected rather than changed (see the last section).

## Final verification

| Check | Before | After |
|---|---|---|
| Go `go test -race ./...` | ok | **ok** |
| Go `go vet ./...` | clean | **clean** |
| Python `python -m pytest -q` | 920 passed | **939 passed** |
| TypeScript `npm test` | 717 passed | **739 passed** |
| TypeScript `npm run typecheck` | clean | **clean** |

## Confirmed and fixed

### Cross-language
| Finding | Fix |
|---|---|
| Short-TTL token served after real expiry (`expires_in ≤ 60s`) | All three engines now refresh at **half the TTL (1 s floor)** instead of a 60 s floor; Go `refreshCadence`, Python `_cadence`, TS `refreshCadence` |
| Unicode `U+2028`/`U+2029` survive error sanitization (log forging) | Go `errors.go`, Python `exceptions.py`, TS `errors.ts` now strip `Zl`/`Zp` alongside `Cc`/`Cf` |
| Result-code exponent notation settles in Go/Python but not TS | `plainDecimal` ASCII gate in Go and Python before numeric parse; TS unchanged — all classify `"0e0"` as INDETERMINATE |
| STK Push free text admits control characters (Go/TS only) | Go `requirePrintable`, TS `requirePrintableMaxLen` on `AccountReference` / `TransactionDesc` |

### Go
| Finding | Fix |
|---|---|
| `GeneratePassword` accepted blank passkey | Rejects empty/whitespace passkey before derivation |
| Callback metadata rounded integers > 2^53 | `strconv.ParseInt` for integral wire tokens (exact 9007199254740993) |
| Numeric `ReferenceItem.Value` aborted whole async-result decode | Custom `ReferenceItem.UnmarshalJSON` coerces scalars to wire text |
| Reflection transport walk had unbounded branch fan-out | Total-visit budget (4096) added alongside depth/cycle guards, fail-closed |
| Injected `Config.Now` had no concurrency contract | Documented requirement (same as `ErrorLogger`) |
| Auto-generated `OriginatorConversationID` discarded on value copy | Exported `NewOriginatorID()`; B2C docs now require generate-once/reuse-on-retry |
| Stale cadence docs/comments | `client.go`, `doc.go`, `README.md`, tests updated |

### Python
| Finding | Fix |
|---|---|
| Gateway body accepted non-standard `NaN`/`Infinity` JSON | `parse_constant` reject hook on all three `json.loads` in `responses.py` |
| Daily quota debited before a fallible password derivation | `stk_push` derives password before `_accrue_daily` |
| `float("inf")` / NaN timeout accepted | Reject non-finite / non-positive `timeout_seconds` with a clear `ValueError` |
| No total request deadline (slowloris) | Monotonic deadline threaded through `read_capped` from `_send` and OAuth `_refresh`; a watchdog timer **closes the response at the deadline**, interrupting a blocked `iter_content` read (a chunk-boundary check alone could not stop a sub-1 MiB trickle) |
| QR payload silently truncated at 4096 chars | Non-truncating `coerce_opaque_str` for `QRCode` |
| Phone length gate counted code points, not UTF-8 bytes | `len(raw.encode("utf-8"))` |
| Transaction Status / Balance validated but shipped untrimmed `PartyA` | Both call sites now assign `_shortcode(...)` |
| Bare `stkCallback` body rejected (Go/TS accept) | Added bare-shape branch in `StkCallbackResult.from_json` |
| False CVE citation in dependency pin | Comment corrected |

### TypeScript
| Finding | Fix |
|---|---|
| QR `Size` validated with lenient `parseInt`, malformed value sent on wire | Strict `/^\d+$/` gate; validated value used in payload |
| Unguarded `reader.cancel()` masked typed 413 | `cancel().catch(() => {})` matching abort branch |
| `callbackTokenEqual` threw on non-string input | Type guard added — fails closed |
| `amount()` accepted sub-cent / binary-noise numbers | Number branch routed through the 2dp `AMOUNT_RE` gate |
| `coerceInt` threw on legitimate `INT32_MAX` | Sentinel throw removed |
| `safeJsonInt` used `JSON.parse` (1e3 → 1000, +100 → null) | Anchored signed ASCII integer grammar |
| Exported `DEFAULT_TRANSACTION_LIMITS` deeply mutable | Root and all nine buckets `Object.freeze`d |
| `ResultClass.INCONCLUSIVE` name diverges from Go/Python | Canonical `INDETERMINATE` added; `INCONCLUSIVE` kept as deprecated non-enumerable alias |
| No TLS-downgrade guard | `NODE_TLS_REJECT_UNAUTHORIZED` falsy values rejected at construction |
| No `close()` / token-invalidation primitive | Idempotent `close()` added (bearer in shared WeakMap intentionally untouched) |
| OAuth `expires_in` prefix-parsed (`"3599garbage"` → 3599) | Strict full-string integer parse with 0 → fallback cadence |

### Documentation
Stale v0.5.1 Capslock claims scoped as historical in `docs/security-audit.md` and
`SECURITY.md`; `CODE_REVIEW_REPORT.md` marked superseded; B2B doc anchor fixed;
`stk_push` examples and README use `requiredEnv()`; `known-divergences.md` gained
entries for token-cache scope, strict `expires_in`, intentional raw error-logger
body, and short-TTL cadence.

### Verification of the fixes themselves
The complete diff was reviewed independently for each language and for the
documentation. Two defects in the *fixes* were found and corrected before
commit, each proven with a red-green cycle:
- Go: `TestAuditSTKPushRejectsControlCharacters` used a 17-byte
  `AccountReference`, so the pre-existing 12-byte cap masked the new printable
  check. Shortened to `ref\nX`; removing the fix now makes the test fail.
- Python: the first deadline implementation checked the clock only between
  `iter_content` chunks, which cannot interrupt a sub-1 MiB trickle. Replaced
  with a watchdog timer that closes the response; disabling `timer.start()`
  now makes the 50 ms deadline test take 5 s and fail.

## Rejected / deliberately not changed

- **Go raw error body to `ErrorLogger` (F-03):** REJECTED as a fix. This is
  intentional, documented in `contract/known-divergences.md`, and pinned by
  `TestParseErrorLoggerReceivesDiagnostics`. The unused `maxSnippetBytes`
  constant is vestigial only.
- **Token cache scope (XLAN-01):** TS is process-wide per credential tuple;
  Go/Python are per-client. Changing Go/Python to a global registry would be a
  major behavioral change, so it is documented instead of silently changed.
- **Serialize-before-truncate (P1-09):** low-severity allocation cost; existing
  test explicitly pins the dumps-and-cap behavior and the upstream 1 MiB body
  cap bounds the work. Left as-is.
- **Go callback scalar caps (CBK-02):** cross-language cap policy difference;
  changing dedup-key inputs needs a coordinated contract decision. Deferred.
- **`organization-dependencies.json` (H-03):** untracked and apparently
  user-owned. Flagged as stale/missing `requests` and `cryptography`, but not
  regenerated or committed.

## Test changes
Three pre-existing tests encoded the old timeout/cadence behavior and were
updated: `python/tests/test_auth.py` (two cadence tests) and
`python/tests/test_client.py` (zero-timeout now rejected). New regression files:
`go/audit_regression_test.go`, `python/tests/test_audit_regression.py`,
`typescript/test/audit-core.test.ts`, `typescript/test/audit-client.test.ts`.

No commit was made.
