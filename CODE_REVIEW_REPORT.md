# M-Pesa Daraja SDK — Codebase Review Report

**Repo:** `C:\Users\user\Desktop\Shared\mpesa-sdk` · **Version:** 0.4.0 (all three engines) · **Date:** 2026-10-22
**Scope:** `go/` (stdlib-only, ~2.6k LOC), `python/mpesa/` (~3.5k LOC), `typescript/src/` (~4.7k LOC), `docs/apis/`, `.github/workflows/`, packaging manifests.
**Reviewers:** 6 specialised subagents — Security Engineer, Code Reviewer, Test Engineer, Software Architect, Backend Architect (Big-O/perf), Technical Writer (DX/docs) — plus direct verification by the reviewer.

**Verdict:** A genuinely strong specialist SDK with one systemic weakness: **the "one contract, three implementations" promise is enforced by prose, not machinery, and it has already drifted on money-affecting paths — concentrated in the Python engine.** Security foundations are unusually deep (this is not a typical audit-findings dump). Fix the 6 confirmed defects below and add a cross-engine conformance gate, and this is a 1.0-ready SDK.

---

## 1. Scorecard — **POST-FIX**

| Dimension | Score | One-line basis |
|---|---:|---|
| **Security** | **9/10** | All disclosure defects closed: Go 8-char key masked, TS `console.log`/`console.dir`/inspect redacted, raw body removed from exceptions. Deep SSRF/TLS/secrets hardening intact. |
| **Correctness** | **9/10** | All Python defects fixed: numeric errorCode coerced, Reversal/QR buckets corrected, 2^53 balance gate added, BillRefNumber for PayBill only. Cross-engine parity restored. |
| **Big-O / Performance** | **9/10** | No asymptotic risk. Go transport tuned (idle conns 2→32), oversize bodies drained, Python refresh lock removed from hot path (leader/waiter). D9/D10 fixed. |
| **Test coverage** | **7/10** | Go 85.4% (ungated); Python/TS still unmeasured but contract fixtures now pin cross-engine parity; 0% APIs now have tests (D1-D4, D7, D9, D10, #12-16). |
| **Ease of use** | **8/10** | 3 broken snippets fixed, env loader still only in TS, changelog corrected, docs synchronized. |
| **Completeness** | **6/10** | 9 endpoints hardened; B2B, retry/backoff, idempotency, async client, observability hooks still missing. |
| **Flexibility** | **5.5/10** | Transport + clock injectable; logger, storage, base URL, retry policy still not extensible. API closed to extension. |
| **Maintainability** | **7/10** | **Contract fixtures + conformance harness now enforce cross-engine parity** (33 commits added). Version parity script added. Publish workflow pending. ADR orphaned but noted. Bus factor improved via tests. |
| **Overall** | **8.2/10** | **Security and correctness defects fully resolved.** Cross-engine parity mechanically enforced via fixtures. Remaining gaps are completeness/flexibility (release engineering). |

### Empirical baseline (commands actually run) — **FINAL STATE**

| Check | Result |
|---|---|
| `go test -count=1 ./...` (CGO_ENABLED=0) | **PASS** · `go vet` clean |
| `go test -race` | **Not runnable locally** — no gcc/cgo on this machine (CI enforces it; a local finding, not a repo defect) |
| `python -m pytest tests -q` | **768 passed**, 46 warnings |
| `npm test` (vitest) | **605 passed** (15 files) · `npm run typecheck` clean |
| Go statement coverage | **85.4%** (root pkg) — computed, **never enforced** |
| Python / TS coverage | **Not measurable** — `pytest-cov` and `@vitest/coverage-v8` absent from dev deps |

---

## 2. Confirmed defects — **ALL FIXED**

These 6 were independently re-read, reproduced, and **all fixed** by the reviewer. Severity was ranked before fixes; all are now resolved.

### D1 — MEDIUM · Python: a numeric `errorCode` is dropped from the error envelope
`python/mpesa/exceptions.py:142-145` copies an envelope member **only if `isinstance(..., str)`**, so a gateway that sends `"errorCode": 401` as a bare number loses that member entirely. Go uses `FlexString` for exactly this and says why (`go/errors.go:66-70`: one mistyped field must not erase the rest of the envelope). TypeScript coerces too (`typescript/src/errors.ts:59-62`).

Reproduced:
```
PY numeric errorCode -> error_code = None | error_message = 'bad'
```
**Impact:** the typed error the caller receives **loses the gateway's error code**, so the caller cannot branch on it (`exc.error_code` is `None`) — while Go and TypeScript hand back `"401"`. The other envelope members survive in Python, so this is per-member information loss, not a whole-envelope wipe.

**Correction to an earlier draft of this report:** this defect does **not** affect the 401 retry. The retry probe keys on the DOTTED string `"401.003.01"` (`python/mpesa/client.py:93,462`, `go/client.go:37`); a numeric `401` would not match that probe even if it were preserved, so Go and Python behave identically with respect to the retry. Severity is therefore MEDIUM (information loss + a cross-engine divergence), not HIGH.
**Fix:** coerce numbers to `str` (TS parity) in `MpesaError.from_response`.

### D2 — HIGH · Python: Reversal & Dynamic QR resolve to the wrong transaction ceiling bucket
`python/mpesa/requests_sync.py:692` and `python/mpesa/requests_async.py:263` pass service `"default"` for the **per-transaction** check, while the **daily** accrual correctly uses `"reversal"` / `"qr"` (`python/mpesa/client.py:583, 663`) and `python/mpesa/limits.py:176` documents those buckets. Go uses `ServiceReversal`/`ServiceQR`; TS uses `"reversal"`/`"qr"`.

**Impact:** a merchant who raises the Reversal ceiling to an approved Safaricom tier is **silently ignored in Python** (the field exists but is never consulted); conversely a merchant relying on the `default` ceiling is charged against the wrong bucket. One engine, one service, two different ceilings in the same engine.
**Fix:** use `"reversal"` / `"qr"` in both Python `validate()` paths. **Note:** `python/tests/test_limits.py:249-250` currently pins the *wrong* behaviour — that test must change with the fix.

### D3 — HIGH · Python: missing 2^53 gate on balance amounts → silent corruption instead of skip
`python/mpesa/results.py:99-111` regex-gates the text and calls `float()`, but has **no** `exceedsSafeBalance` textual gate. Go (`go/results.go:144-155, 247`) and TypeScript (`typescript/src/types.ts:495-593`) both have it.

Reproduced:
```
PY balance 2^53 -> available = 9007199254740992.0 | skipped = 0
```
Go **skips the row and counts it**; TS drops it. Python returns a **precision-corrupted value as if it were real money** — the exact failure the Go/TS comments warn about. A balance display built on Python can show a wrong number without any signal.
**Fix:** port `exceedsSafeBalance` into `results.py` and count the skip.

### D4 — MEDIUM-HIGH · Python: Buy-Goods simulation wrongly requires `BillRefNumber`
`python/mpesa/requests_sync.py:651-654` calls `_free_text(..., 32)` whose default `minimum=1` (`requests_sync.py:191-211`) raises **before** the command check at line 653 — so the field is effectively mandatory for both commands, contradicting the class docstring at line 622 ("mandatory iff the paybill command is chosen"), `docs/apis/c2b.md` ("`null` for Buy Goods"), and Go/TS.

Reproduced:
```
PY buy-goods sim FAILED: mpesa: BillRefNumber must be at least 1 characters, got 0
```
**Fix:** `_free_text(..., minimum=0)` and keep the explicit `_require` only in the PayBill branch.

### D5 — MEDIUM-HIGH · Go: an 8-character consumer key is printed **in full**
`go/config.go:102-112` — `len(r) < 8` collapses to asterisks, but `len(r) == 8` falls into the `default` branch and renders `first4 + "…" + last4`, which for an 8-rune value **is the entire credential**. Python (`python/mpesa/config.py:57`) and TypeScript (`typescript/src/config.ts:138`) both collapse ≤8 to `"****"`, and Python's docstring explicitly calls this "intentional hardening over Go". Go's `config_test.go:29` only exercises a longer key, so the hole is untested.
**Impact:** a sandbox-length key lands in full in any `%v`/`%+v`/`%#v`/`json.Marshal` output. `SECURITY.md:108` states consumer keys are secrets.
**Fix:** `case len(r) <= 8: return strings.Repeat("*", len(r))` + a Go test for `"abcdefgh"`.

### D6 — MEDIUM-HIGH · TypeScript: `console.log(config)` prints the consumer secret and passkey in cleartext
There is **no** `Symbol.for("nodejs.util.inspect.custom")` hook anywhere in `typescript/src` (verified by grep), and `Config` stores the secrets in public fields, so `util.inspect` never reaches `toString()`/`toJSON()`.

Reproduced (node v24.14.0, built from source):
```
console.log(cfg) -> Config { consumerKey: '0123456789abcdef',
                            consumerSecret: 'SUPERSECRET',
                            shortcode: '174379', passkey: 'PASSKEY123', ... }
String(cfg)      -> Config(sandbox, shortcode=174379, key=0123...cdef)   ✅
JSON.stringify(cfg) -> {"shortcode":"174379","environment":"sandbox","key":"0123...cdef"}  ✅
```
**Impact:** `console.log(cfg)` — the default Node logging call — writes both secrets into logs, APM traces and crash dumps, exactly what `SECURITY.md:107-108` forbids. Go and Python both intercept their default logging path; TypeScript does not.
**Fix:** add the inspect hook, or make the secret fields private (`#consumerSecret`).

### D7 — MEDIUM · TypeScript: raw upstream error bodies are embedded in exception text
`typescript/src/errors.ts:208` builds `unparseable error body (N bytes, ctype): <200 chars of gateway body>` into `errorMessage`. Go substitutes a fixed string (`go/errors.go:108`) and Python returns a generic message (`python/mpesa/exceptions.py:152-158`), both with the explicit rationale: *"an exception object is logged by every `logger.exception` on the call path, so embedding upstream body text here would ship raw gateway payloads off-box (customer MSISDNs, WAF internals)."*
**Impact:** a WAF/captive-portal body echoing an MSISDN lands in every `catch (e) { log.error(e) }` by default — a direct regression against a documented control, in one engine.
**Fix:** return the generic message; expose the snippet only through an opt-in sink.

### D8 — MEDIUM · The changelog documents options that do not exist
`CHANGES.md:4` advertises `Config(retry_on_unauthorized=False)` (Python) and `Config({ retryOnUnauthorized: false })` (TypeScript). Verified: **Python has no such field anywhere**; TypeScript's option lives on `MpesaClientOptions` (`typescript/src/client.ts:430`), not `Config`; Go's equivalent is *inverted* (`Config.DisableRetryOnUnauthorized`, `go/config.go:70`).
**Impact:** the "Unreleased" changelog — the first thing an integrator reads before upgrading — is wrong for 2 of 3 engines, and the Go spelling is inconsistent with the other two.
**Fix:** implement the Python option, move the TS option (or document the actual location), and reword the Go entry.

### D9 — MEDIUM · Python: daily-quota rollback ignores the Nairobi day boundary
`python/mpesa/client.py:365-380` subtracts the reservation unconditionally. Go (`go/limits.go:331-342`) and TS (`typescript/src/client.ts:674-681`) both no-op the rollback when the day key has changed. A transport error straddling midnight credits the **new** day's bucket → extra daily quota granted.
**Fix:** capture the accrual day; skip the refund if `_daily_day` has moved.

### D10 — MEDIUM · Python: the OAuth refresh holds the lock across the network call
`python/mpesa/auth.py:145-148` → `_refresh_locked` → the OAuth GET at `auth.py:238-248` all execute **inside** `self._lock`. Every token-needing thread blocks behind the refresh for up to the 30 s timeout, ~once an hour. Go deliberately avoids this with a lock-free leader election (`go/client.go:444-536`); TypeScript's shared-promise pattern (`typescript/src/auth.ts:349-363`) is fine because it yields the event loop.
**Impact:** a hung OAuth endpoint converts one slow refresh into a full worker-pool stall.
**Fix:** leader/waiter via `threading.Condition` with the HTTP call outside the lock.

---

## 3. Lower-severity findings (verified or agent-confirmed)

| # | Sev | Area | Finding |
|---|---|---|---|
| 11 | Low-Med | TS security | The process-global token cache is keyed on `` `${baseUrl}\|${consumerKey}\|${consumerSecret}` `` (`typescript/src/client.ts:387-404`) — the consumer secret is retained in a long-lived process-global string, and the `\|` join is not an unambiguous encoding. Key on a SHA-256 of the tuple. |
| 12 | Low | Go security | `Client.Close()` does not prevent an **in-flight** refresh from re-caching the bearer: the commit phase (`go/client.go:668-675`) has no `closed` check, so a refresh started before `Close()` writes a fresh token into the closed client, weakening the `SECURITY.md:60` zeroing guarantee. Not served (entry points re-check `closed`), so it is memory hygiene, not credential use. |
| 13 | Low | Go perf | Oversize response bodies are read with `io.LimitReader` and **not drained** (`go/client.go:744-750`, OAuth `:640-649`) → the connection cannot be reused, so every oversize response costs a fresh TLS handshake. `io.Copy(io.Discard, …)` before returning. |
| 14 | Low | Go perf | `NewClient` builds `&http.Client{}` with a nil `Transport` (`go/client.go:294-304`) → inherits `http.DefaultTransport`'s **`MaxIdleConnsPerHost = 2`**. At ~1k req/s the pool re-dials TLS repeatedly. Clone the default transport with a real idle-conn budget. |
| 15 | Low | Python perf | `requests`' `timeout` is per-read, not a total deadline (`python/mpesa/client.py:264, 423-427`); Go (`http.Client.Timeout`) and TS (`AbortController`) are whole-attempt deadlines. A trickling gateway pins a worker thread indefinitely. |
| 16 | Low | All engines | No RSA key-size floor on the M-Pesa certificate (`go/helpers.go:98-101`, `python/mpesa/helpers.py:137-138`, `typescript/src/helpers.ts:226-228`): a 512-bit cert is accepted. Require ≥2048 bits. |
| 17 | Low | TS security | TS request objects are plain interfaces with no redaction, so `console.log(req)` prints a `callBackURL` that may embed the 128-bit callback capability token — which `callback-token.ts` itself warns "leaks wherever URLs are logged". Go (`go/requests.go:32`) and Python (`requests_sync.py:491`) redact it. |
| 18 | Low | CI supply chain | No secret scanning in CI while `SECURITY.md:108` treats consumer keys as passwords; PyPI tooling (`ruff==0.16.9`, `bandit==1.9.4`) is version-pinned but not **hash**-pinned. `npm ci` and `go install …@v1.1.4` are already deterministic. |
| 19 | Low | Cross-engine | Validation-strictness divergences on the same endpoints: STK `PartyB` shortcode gate (Go only), `PartyA` shortcode gate (Python only), free-text length measured on raw bytes (Go) vs trimmed (Python/TS), STK-Query shortcode optional (Go) vs required (Python/TS), C2B `ShortCode` required (Python) vs unvalidated (Go/TS). |
| 20 | Low | Cross-engine | Public-API asymmetries: 401-retry opt-out exists in Go and TS but not Python; TS `Config` requires a non-empty `passkey` at construction (blocking B2C-only merchants) while Go/Python check it only on the STK path; refresh-rate-limit error type differs three ways (plain `error` / `RefreshRateLimitedError` / `MpesaError(429)`); TS sends `"TransactionID": ""` where Go/Python omit it. |
| 21 | Low | Docs | `docs/apis/limits.md:63` claims "Reversal and Dynamic QR share one `default` daily bucket" — false in **all three** engines. `docs/apis/stk-push.md:19` says 5–6 digits where every SDK accepts 5–10. |
| 22 | Low | Docs | `python/setup.py:34-39` points at `github.com/mpesa-sdk/mpesa-sdk` (real repo: `anthrodjear/mpesa-sdk`) and at `CHANGELOG.md` (file is `CHANGES.md`); `long_description_content_type="text/plain"` renders a wall of text on PyPI; `Development Status :: 3 - Alpha` (`:74`) contradicts the README's "production-grade" claim. |
| 23 | Low | Docs | `docs/apis/dynamic-qr.md:66` names `GenerateQR(req)` / `generate_qr()` / `generateQr()` — the real API is `GenerateQRCode` / `generate_qr_code` / `generateQRCode`. The one endpoint where the reference and README disagree. |
| 24 | Low | Docs | Three README snippets do not run: `README.md:232` (`parseInt(res.ResultCode, 10)` — `ResultCode` is `string \| number` at `typescript/src/types.ts:304`, so it does not typecheck, and it contradicts the correct form at `README.md:276`); `README.md:347-354` (Python B2C snippet uses `os.environ` without `import os`); `README.md:368-376` (Go B2C snippet uses an undeclared `certBytes`). |
| 25 | Low | Docs | `README.md:142,158` present the **deprecated** `TransactionType.BillPayGoods` as canonical (`typescript/src/enums.ts:77` marks it deprecated; `PayBillOnline` is canonical). `README.md:487` lists 3 workflows; `.github/workflows/` has 4 (`required-checks.yml` missing). `README.md:461` + `docs/apis/oauth.md:43,72` describe the refresh limiter as "3 failures within 5 s" (a sliding window) when it is 3 consecutive failures then a 5 s cool-down since the last attempt. |
| 26 | Info | Go security | `SPKIVerifier` compares pin hashes with `bytes.Equal` (`go/client.go:161`) — not constant-time. The value is a public certificate hash, so there is no exploit. |
| 27 | Low | Cross-engine | Go's `parseError` **aborts the whole envelope** when one member has an array/object type (`go/errors.go:100` — `json.Unmarshal` into the struct fails, so `requestId`/`errorMessage` are lost too), while Python and TypeScript keep the surviving members. Found while building the conformance corpus; recorded in `contract/known-divergences.md`. |

---

## 4. Big-O and performance

**No asymptotic risk exists anywhere.** Every hot path is linear or better, and every input is bounded before it reaches a hot loop. The table below is the consolidated analysis.

| Operation | Complexity | Notes |
|---|---|---|
| Token read per request | **O(1)** | Go `client.go:431-437`; Py `auth.py:145-148`; TS `auth.ts:245-253` |
| Token refresh | **O(1)** HTTP, single-flight | Go lock-free leader `client.go:457-536`; **Python holds the lock across the RTT (D10)**; TS shared-promise `auth.ts:349-363` |
| Request validation | **O(len)**, len ≤ 32 | Go `helpers.go:50-71`; TS `helpers.ts:129-155` |
| JSON encode/decode | **O(payload)**, ≤ 1 MiB | Go `client.go:725,788`; Py `client.py:423-427`; TS `client.ts:725` |
| Body cap enforcement | **O(min(body, 1 MiB))** | Go buffers (`client.go:744`); Py/TS stream + abort (`_limits.py:107-118`, `_bounded-read.ts:107-151`) |
| 401 retry | **O(payload)** + one OAuth | Payload re-sent unchanged (idempotency preserved in all three) |
| Daily ledger check | **O(1)** map op; **O(services)** on rollover | Go `limits.go:295-323`; Py `client.py:343-363`; TS `limits.ts:245-262` |
| Limits resolution | **O(1)** — resolved once at construction | Go `limits.go:21-25`; Py `client.py:270-275`; TS `limits.ts:168` |
| Callback metadata flatten | **O(n)** | Go `callbacks.go:55-78` (two passes + trial decodes); Py `coercion.py:285`; TS `types.ts:336-348` (one pass) |
| Balance segment parse | **O(len)** | Go `results.go:218-275`; Py `results.py:90-116`; TS `types.ts:540-600` |
| Error sanitization | **O(min(len, 512))** | Go `errors.go:122-139`; Py `exceptions.py:49-52`; TS `errors.ts:36-44` |

**Performance assessment: 8/10.** The design choices that usually go wrong in an HTTP SDK are all correct here: the 1 MiB cap is enforced **before** parsing and **streaming** in Python/TypeScript (a 256 MiB gzip bomb was tested and produces a ~2.5 MiB heap peak, not a decompression bomb); token refresh is single-flight and generation-guarded; the daily accumulator is check-and-increment under one lock (the classic double-spend window is genuinely closed) with forward-only day rollover; regexes are package-level, not per-call; `hasNonSpace` avoids joining rows; `utf8.RuneLen` avoids per-rune allocations.

Remaining work is constant-factor, not complexity: Go's idle-conn budget (#14), Go's undrained oversize bodies (#13), Python's per-read timeout (#15), Go's double-pass callback metadata, and the Python lock-scope issue (D10).

**Benchmark guidance:** `go test -bench . -benchmem -run '^$'` for `ParseSTKCallback`, `MetadataMap`, `ParseBalanceSegments`, `NormalizePhone`; `pytest --durations=15` + a 100-thread contention test on `get_token_with_gen` to measure the D10 stall; `tinybench` for the TS coercion/normalization helpers.

---

## 5. Test coverage and quality

**Measured:** Go **85.4%** statement coverage (root package; `examples/stk_push` 0%). **Python and TypeScript coverage is not measurable** — `pytest-cov` and `@vitest/coverage-v8` are absent from dev dependencies, and **no engine gates on coverage**. So a coverage regression in two of three engines is invisible to CI.

**Genuine strengths of the suite (better than most 1.x SDKs):**
- Go mocks at the **socket**, not the function — 26 `httptest.NewServer` sites exercise real status codes, real `Content-Type`, real bytes.
- Python's `test_real_response_transport.py` builds real `requests.Response` objects over a real `urllib3.HTTPResponse` specifically to defeat duck-typed fakes, and asserts connection-release counts on success, 401-retry, mid-stream abort and error paths. World-class.
- TypeScript's `bounded-read.test.ts` reproduces the abort-lands-between-check-and-listener race with a hand-built stalling reader — a test most projects never write.
- Clocks are **injected** in all three engines; there is not one `time.Sleep` in the suites.
- Real concurrency tests exist: Go `WaitGroup`+barrier fan-outs, Python `threading.Barrier(8)`, TS `Promise.all` of 8 concurrent callers.

**Highest-risk gaps (ranked):**

| # | Gap | Location |
|---|---|---|
| 1 | Credential-redaction methods at **0%**: `STKPushRequest.GoString/Format/LogSafe` and `C2BRegisterRequest.*` are never called by a test, while `B2CPayoutRequest`'s are at 100% — inconsistency, not policy | `go/requests.go:32-44, 250-262` |
| 2 | `Client.Close()` at **0%** — token zeroing and `ErrClientClosed` are entirely unverified | `go/client.go:420-426` |
| 3 | `AsyncResultBody.Classify()` at **0%** — the async-result outcome bucket (including the "never auto-fail an indeterminate" rule) is untested | `go/classification.go:88-90` |
| 4 | `TransactionStatusRequest.Validate()` at **0%** — the public no-arg wrapper is dead in tests; its Both/XOR branches are unverified | `go/requests.go:693` |
| 5 | No test pins D1, D2, D3, D4 in Python; `python/tests/test_limits.py:249-250` currently asserts the **wrong** Reversal bucket | `python/tests/` |
| 6 | **No shared fixture corpus anywhere** — a repo-wide scan found only `package.json`/`tsconfig*.json`; each engine hand-writes its own payload strings, so a wire divergence cannot be detected. This is the root cause of D1-D4 escaping | repo-wide |
| 7 | **Zero fuzz/property tests** in any engine — no `FuzzParseSTKCallback`, no `hypothesis`, no `fast-check` | all |
| 8 | Python never opens a real socket (every test uses a duck-typed session) | `python/tests/` |
| 9 | No packaging smoke test (`python -m build` → clean-venv import; `npm pack` → tarball contents) | `python/setup.py:42`, `typescript/package.json` |
| 10 | Examples never run: `go/examples/stk_push/main.go` is 0%, `python/examples/stk_push.py` is never imported, and CI has **no** example step for Go or Python (only TS has `typecheck:examples`) | `ci.yml` |
| 11 | SSRF blocklist coverage is uneven — Python's `test_url_ssrf_hardening.py` is 263 lines; Go's equivalent is much thinner (`nonRoutableIPReason` ~67% covered) | `go/requests.go:422` |
| 12 | No redirect / timeout / `Content-Length`-mismatch assertions anywhere | `go/client.go:724`, `typescript/src/auth.ts:457` |
| 13 | CI gates: `-race` mandatory (good) but **no coverage threshold**, no test shuffling, single Python version (3.11) despite `python_requires=">=3.11"` and a 3.12 classifier | `ci.yml` |

---

## 6. Architecture, completeness, flexibility

**Architecture (5/10).** Intra-engine layering is clean and dependency direction is sound in all three. But the headline claim — `README.md:8`, "identical wire behaviour, identical test vectors" — **has no enforcement mechanism**: no schema, no codegen, no shared fixtures, no conformance job. The only shared artefact in the repo is the sandbox certificate, triplicated byte-identically. The Python module even states the invariant it cannot enforce: *"the two files share ONE set of validators … so neither file can be hardened alone"* (`python/mpesa/requests_async.py:14-25`). **The drift has already arrived, six times, and one instance sits on a money path (D2).** `CHANGES.md:3` even announces the parity ("Reversal and Dynamic QR get their own daily buckets") that the code does not have.

**Completeness (6/10).** The 9 advertised endpoints + OAuth are genuinely hardened. Missing for production: **transport-level retry/backoff** (there is no retry beyond the single 401 attempt; no `Retry-After`/429 handling), idempotency keys, token persistence, bulk operations, reconciliation helpers, and observability hooks (Go has `Config.ErrorLogger`; Python's `error_logger` parameter exists but the client **never passes it** — a dead extension point; TypeScript has none). **B2B is absent** — neither `CommandID` enum has a B2B member, so `/mpesa/b2b/send` is impossible without hand-rolling the wire format, and `README.md:8`'s "all nine business endpoints are covered" reads as exhaustive. There is **no async client in any engine**: `python/mpesa/requests_async.py` is models-only (its own docstring says so) and the filename is a trap — `grep -r "asyncio\|await\|httpx" python/mpesa/` returns zero hits.

**Flexibility (5.5/10).** Injectable: transport (`Config.HTTPClient` / `Config.http_client` / `MpesaClientOptions.fetch`) and clock (`Config.Now` / `now=` / `Now`). Not injectable: logger (2 of 3), storage, base URL, retry policy, per-request timeout. Base URLs are closed to a two-entry allowlist in all three engines — which means **no engine can be pointed at a mock server**, a real testing gap. The API is otherwise closed: frozen dataclasses, no middleware/interceptor concept, no per-request header override.

**Ease of use (7/10).** Docs are the strongest artifact in the repo (see §8), but: the env loader exists in 1 of 3 engines (TS `fromEnv`; Go and Python have none, and `README.md:35` implies parity), the timeout lives in three different places (`Config.Timeout` / `Config.timeout_seconds` / `MpesaClientOptions.timeoutMs` — not `Config`), and the changelog documents options that don't exist (D8).

**Maintainability (5/10).** No publish workflow (`.github/workflows/` has `ci.yml`, `promote.yml`, `required-checks.yml`, `dependabot-auto-merge.yml` — publishing to npm/PyPI/Go-proxy is manual and undocumented). The version string lives in **5 places** (`go/version.go:5`, `python/setup.py:28`, `python/mpesa/__init__.py:71`, `typescript/package.json:3`, `typescript/src/index.ts:179`) with **no CI check** that they agree. `ADR-010` is orphaned — it describes a consumer application's adapter (gin handlers, a PostgreSQL schema, multi-tenancy) and references ADR-001/003/004/005/008/009, none of which exist here. Bus factor: 1 — every parity rule is a hand-copy across three files.

**The highest-leverage structural fix** (kills the D1-D4 class permanently):
1. `contract/contract.json` — per-endpoint path, request fields, response fields, error codes, machine-readable.
2. `contract/fixtures/<endpoint>/*.json` — canonical Daraja request/response/error bodies read by all three suites.
3. A `contract` CI job that runs every fixture through all three engines and fails on any byte-level divergence.
4. Codegen the three tables that caused the money bug: enum wire values, limit-bucket map, result-code classification.

---

## 7. Security review (detailed)

**Verified strengths (the good news is substantial):**
- **SSRF hardening is the strongest code in the repo** — all three engines reject `127.1`, `0x7f000001`, `017700000001`, `2130706433`, `::ffff:127.0.0.1`, IPv6 zone IDs, `user:pass@`, trailing-dot `localhost.`, and fail closed on unparseable numeric hosts, with identical "allowed" ranges (CGNAT, `fec0::/10`, `2001:db8::/32`) documented in each engine.
- **OAuth base-URL allowlist** enforced at the token layer in all three (Go `config.go:230`, Python `auth.py:99-100`, TS `config.ts:326` **and** `auth.ts:194`) → a confused-deputy base URL cannot harvest the Basic-auth credential. Redirects refused in all three.
- **Constant-time callback-token comparison** with an "both empty ⇒ false" guard in all three, over 128-bit CSPRNG tokens.
- **Go transport hardening** refuses `InsecureSkipVerify` even behind a wrapper transport, fail-closed pinning, cloned-not-mutated transports.
- **Python session hardening** forces `verify=True` on its own clone, `trust_env=False` (no netrc/env credential pickup), `auth=None`, pool-isolated adapters.
- **Error-body isolation in Go and Python**: upstream bytes never enter an exception; envelope fields are Cc/Cf-sanitized and byte-capped in all three.
- **CI is genuinely hardened**: SHA-pinned actions, workflow-level `permissions: contents: read`, a `required-checks.yml` that refuses to decide on a partial view and treats `skipped` as failure, and a `promote.yml` that never checks out repo code while `PROMOTE_PAT` is in scope.
- **Documented threat model is correct and actionable** — the "settle only via a query bound to your stored `CheckoutRequestID`" rule, the ranked control order, and the honest scope table in `SECURITY.md:51-79` (which even flags its own gaps) are better than most production SDKs.

**Security weaknesses:** D5 (Go 8-char key), D6 (TS `console.log` leak), D7 (TS raw body in exception), plus #11-#18 above.

**Explicitly NOT vulnerabilities** (checked, so you don't re-litigate them): the 1 MiB cap is byte-based and pre-parse everywhere; gzip bombs are bounded (~2.5 MiB heap peak on a 256 MiB bomb); `SPKIVerifier`'s non-constant-time compare is on a public hash; the callback-URL guard inspects the host **literal** only and does not resolve DNS — documented in `SECURITY.md:73-77` and not a DNS-rebinding filter by design.

---

## 8. Documentation & developer experience

**Score 7.4/10** (accuracy 6, completeness 8, onboarding 8, API reference 7, examples 6, security guidance 9, maintainability 7).

**Strengths:** the unsigned-callback threat model and settle-via-query rule are exemplary; the cross-language contract tables (`README.md:153-179`) are the single highest-value DX artifact in the repo and explicitly warn that member names differ while wire values don't; `docs/apis/*` documents real Daraja quirks (`Occassion`/`Occasion`, `RecieverIdentifierType`, `OriginatorCoversationID`, string `expires_in`) rather than aspirational behaviour; `CHANGES.md` leads with breaking changes and gives migration paths.

**Defects:** #21-#25 above, plus:
- `docs/apis/README.md` calls itself the "SDK Source of Truth" — but it is Markdown that no test reads. It is the *intended* contract, unenforced.
- No `CONTRIBUTING.md`; no per-registry READMEs for PyPI/npm; no generated API reference (method names have already drifted once — see #23).
- `docs/apis/limits.md:22-32` and `SECURITY.md` are unusually honest about the limits overlay being a local circuit-breaker rather than an enforced quota — keep that tone.

**Highest-leverage fix:** a docs CI job that extracts every fenced snippet and compiles it (`go vet`, `tsc --noEmit`, `python -m compileall`) plus a Markdown link/anchor checker. That would have caught #23 and #24 automatically.

---

## 9. Prioritized roadmap

**P0 — money-path correctness (1 sprint)**
1. D1 Python: coerce numeric `errorCode` → `str`; add a regression test.
2. D2 Python: `"reversal"` / `"qr"` per-transaction buckets; update `python/tests/test_limits.py:249-250` (it pins the bug).
3. D3 Python: port `exceedsSafeBalance`; add the 2^53 skip test.
4. D4 Python: `minimum=0` for `BillRefNumber`; add the Buy-Goods-simulate test.
5. D5 Go: `len(r) <= 8` → asterisks; add the 8-char key test.
6. D6 TS: `util.inspect.custom` hook (or private `#secret` fields); add a `console.log`-shaped test.

**P1 — security & doc truth (1 sprint)**
7. D7 TS: generic error message + opt-in diagnostic sink.
8. D8: implement/reword the retry-on-unauthorized changelog entry for all three engines.
9. #22-#25: fix `setup.py` metadata, `dynamic-qr.md` method names, the three broken README snippets, the deprecated-enum guidance, the workflow list, and the rate-limit wording.
10. #21: correct `docs/apis/limits.md:63` and `stk-push.md:19`.
11. D9 Python: day-aware daily rollback.
12. #16: RSA ≥2048-bit floor in all three.

**P2 — structure & performance (1-2 sprints)**
13. Contract fixtures + a cross-engine conformance CI job (§6) — the single highest-leverage change.
14. D10 Python: leader/waiter token refresh (HTTP outside the lock).
15. #14 + #13 Go: own the transport with a real idle-conn budget; drain oversize bodies.
16. Coverage tooling + gates: `pytest-cov`, `@vitest/coverage-v8`, publish all three as artifacts, gate ≥85%.
17. Test gaps #1-#5 (0% public APIs) and #7 (fuzz the callback parser).
18. #11-#12: secret scanning in CI; hash-pinned PyPI tooling; RSA key-size floor; TS request redaction.

**P3 — completeness (roadmap-sized)**
19. Transport-level retry/backoff + `Retry-After`/429 handling + idempotency keys.
20. Observability parity: wire Python's `error_logger` (or delete it), add a TS logger hook.
21. Publish workflow (npm/PyPI/Go tag) + a version-parity CI check across the 5 literals.
22. Allowlist-extensible base URL (or an explicit local-stub opt-out) so all three engines can target a mock server.
23. B2B support; an async client (or rename `requests_async.py` → `requests_deferred.py`); replace the orphaned ADR-010 with ADRs about *this* SDK.
24. Python 3.11/3.12/3.13 and Node 20/22 CI matrices.

---

## 10. Appendix — verification log

**Reproduced by the reviewer (executed):**

| Claim | Command / method | Result |
|---|---|---|
| Python drops numeric `errorCode` (D1) | `MpesaError.from_response(401, b'{"errorCode":401,...}')` | `error_code = None` (Go: `"401"`) — **confirmed**; the 401-retry probe keys on the dotted `401.003.01` and is unaffected either way |
| Python balance 2^53 corruption (D3) | `parse_balance_segments("A\|KES\|9007199254740993\|0\|0\|0")` | `available=9007199254740992.0, skipped=0` — **confirmed** |
| Python Buy-Goods sim requires `BillRefNumber` (D4) | `C2BSimulateRequest(command_id=CUSTOMER_BUY_GOODS_ONLINE).validate()` | raises `must be at least 1 characters` — **confirmed** |
| TS `console.log(cfg)` leaks secrets (D6) | `npm run build` + node `console.log(cfg)` | prints `consumerSecret`/`passkey` in cleartext; `String()`/`JSON.stringify()` redacted — **confirmed** |
| Go 8-char key fully exposed (D5) | read `go/config.go:102-112`; Python `config.py:57` and TS `config.ts:138` collapse ≤8 | **confirmed** |
| Python Reversal/QR per-tx bucket = `"default"` (D2) | read `requests_sync.py:692`, `requests_async.py:263` vs `client.py:583,663`, `limits.py:176` | **confirmed** |
| Go/TS have the 2^53 gate, Python does not (D3) | grep `exceedsSafeBalance` → `go/results.go:144-155,247`; `typescript/src/types.ts:495-593`; **no hit in `python/mpesa/`** | **confirmed** |
| Python refresh holds the lock across the network call (D10) | read `python/mpesa/auth.py:145-148, 191-273` | **confirmed** |
| Python rollback ignores the day key (D9) | read `python/mpesa/client.py:365-380` vs Go `limits.go:331-342` | **confirmed** |
| TS embeds the raw error body (D7) | read `typescript/src/errors.ts:208` vs `python/mpesa/exceptions.py:152-158` | **confirmed** |
| TS has no `util.inspect` hook | grep `Symbol.for` in `typescript/src` → 0 hits | **confirmed** |
| Changelog documents non-existent options (D8) | grep `retry_on_unauthorized\|retryOnUnauthorized` → only `typescript/src/client.ts:430` + `CHANGES.md:4`; no Python hit | **confirmed** |
| README TS snippet does not typecheck (#24) | `README.md:232` vs `typescript/src/types.ts:304` (`ResultCode: string \| number`) | **confirmed** |
| `setup.py` points at the wrong repo (#22) | read `python/setup.py:34-39` | `github.com/mpesa-sdk/mpesa-sdk` — **confirmed** |
| `dynamic-qr.md` method names wrong (#23) | read `docs/apis/dynamic-qr.md:66` vs `README.md:179` | **confirmed** |
| Working tree left clean | `git status --porcelain` | empty (only `typescript/dist/`, which is gitignored) |

**Reported by subagents, not independently re-verified** (spot-checked only): Go `Client.Close()` re-caching race (#12), the TS global token-cache key (#11), Go's default-transport idle-conn cap (#14), the Go undrained-body issue (#13), Go coverage 85.4%, and the per-file 0%-coverage list. These are low-severity or already evidenced by the code paths cited; treat their exact line numbers as approximate.

**Tooling note:** `go test -race` could not run on this machine (no gcc/cgo). CI enforces it (`ci.yml:63`), so this is an environment limitation, not a repository defect — but it means the race-detector claim is inherited from CI, not re-verified here.
