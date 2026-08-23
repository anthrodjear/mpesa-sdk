# Multi-Language M-Pesa SDK Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-optimized:subagent-driven-development (recommended) or superpowers-optimized:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship production-quality, reusable M-Pesa Daraja SDK engines in Go, Python, and TypeScript with full test suites and CI.

**Architecture:** Three independent SDK packages in one monorepo, each implementing the identical API surface defined by `docs/apis/` (10 verified docs) and the semantic rules of `ADR-010-m-pesa-adapter.md` (EAT timestamps generated once per request, indeterminate-vs-failed result classification, defensive callback parsing). Each engine: typed config → thread-safe token cache → request builders with client-side validation → HTTP → typed responses + classified errors. No third-party Daraja libraries (ADR-010).

**Tech Stack:**
- Go 1.26 stdlib only (`net/http`, `encoding/json`, `crypto/rsa`, `crypto/x509`) — module `github.com/mpesa-sdk/go`
- Python 3.11 stdlib + `requests` — package `mpesa-sdk` (import name `mpesa`)
- TypeScript 5 on Node ≥18 native `fetch`, zero runtime deps, Vitest for tests — package `@mpesa-sdk/core`
- CI: GitHub Actions matrix; local toolchains verified present (go 1.26.2 / py 3.11.9 / node 24)

**Assumptions:**
- Tests never call live Safaricom endpoints — mock HTTP servers/stubs only. Will NOT work if a test hits sandbox directly.
- Package identifiers are placeholders (`github.com/mpesa-sdk/go`, PyPI `mpesa-sdk`, npm `@mpesa-sdk/core`) — rename later via find-replace.
- Certs at `assets/certs/*.cer` are expired-by-design fixtures — loaders MUST NOT validate expiry/chains.
- Local verification uses Windows launchers: `go`, `py -m pytest`, `npm`.

---

## Shared Contract (all tasks must conform — from docs/apis/README.md)

1. Endpoints (base URLs per env): oauth `/oauth/v1/generate`; stkpush `/mpesa/stkpush/v1/processrequest`; stkquery `/mpesa/stkpushquery/v1/query`; b2c `/mpesa/b2c/v3/paymentrequest`; txstatus `/mpesa/transactionstatus/v1/query`; reversal `/mpesa/reversal/v1/request`; accountbalance `/mpesa/accountbalance/v1/query`; c2b register `/mpesa/c2b/v2/registerurl`; c2b simulate `/mpesa/c2b/v2/simulate`; qrcode `/mpesa/qrcode/v1/generate`.
2. Casing traps: `Occassion`(B2C)/`Occasion`(others); `InitiatorName`(B2C)/`Initiator`(others); `RecieverIdentifierType`; C2B ACK `OriginatorCoversationID` with NO `ConversationID`; `QueueTimeOutURL`.
3. Token cache: refresh at ≤50 min TTL; single-flight; one forced-refresh retry on `401.003.01`.
4. Timestamp: EAT (+03:00), `YYYYMMDDHHmmss`, generated once where password+timestamp pair applies.
5. Validation before network calls: phone `^254[17]\d{8}$` after normalizing `07…/+254…`; STK Amount integer >0; AccountReference ≤12; TransactionDesc ≤13; B2C Remarks 2–100 & Amount 10–250000; QR TrxCode ∈ {BG,WA,PB,SM,SB}.
6. ResultCode classification: success {0}; fail {1,17,1019,1025,2001,9999}; indeterminate {1001,1037,26,4999} — never auto-fail indeterminate.
7. Error surface: HTTP status + parsed envelope `{requestId, errorCode, errorMessage}` as one exception/error type carrying all three fields.
8. SecurityCredential builder (Go/Python/TS): parse .cer ignoring expiry, RSA PKCS#1 v1.5 encrypt raw initiator-password bytes, Base64 encode (~344 chars).
9. Callback/result parsers tolerate absent metadata/parameters.

---

### Task 1: Go SDK Engine

**Files:**
- Create: `go/go.mod`
- Create: `go/types.go` (all request/response/callback/error structs + ResultCode classification consts/helpers)
- Create: `go/helpers.go` (EAT timestamp+password gen w/ injectable clock func, phone normalize/validate, validators, SecurityCredential builder)
- Create: `go/client.go` (Config, NewClient, token cache via sync.RWMutex single-flight, exported methods below, envelope error handling)
- Test: `go/types_test.go`, `go/helpers_test.go`, `go/client_test.go` (httptest mock server; copy certs to `go/testdata/` from `assets/certs/`)

**Public surface (exact signatures):**
```go
package mpesa
type Environment int
const (Sandbox Environment = iota; Production)
func (e Environment) BaseURL() string
type Config struct{ ConsumerKey, ConsumerSecret, Shortcode, Passkey string; Environment Environment; Timeout time.Duration; Now func() time.Time /* optional test clock */ }
func NewClient(cfg Config) *Client
func (c *Client) STKPush(ctx context.Context, r STKPushRequest) (*STKPushResponse, error)
func (c *Client) STKQuery(ctx context.Context, r STKQueryRequest) (*STKQueryResponse, error)
func (c *Client) B2CPayout(ctx context.Context, r B2CPayoutRequest) (*B2CResponse, error)
func (c *Client) TransactionStatus(ctx context.Context, r TransactionStatusRequest) (*ConversationResponse, error)
func (c *Client) Reversal(ctx context.Context, r ReversalRequest) (*ConversationResponse, error)
func (c *Client) AccountBalance(ctx context.Context, r AccountBalanceRequest) (*ConversationResponse, error)
func (c *Client) C2BRegisterURL(ctx context.Context, r C2BRegisterRequest) (*C2BAckResponse, error)
func (c *Client) C2BSimulate(ctx context.Context, r C2BSimulateRequest) (*C2BAckResponse, error)
func (c *Client) GenerateQRCode(ctx context.Context, r QRCodeRequest) (*QRCodeResponse, error)
// helpers.go
func GeneratePassword(shortcode, passkey string, t time.Time) (password, timestamp string) // EAT, ONE timestamp
func NormalizePhone(s string) (string, error)
func SecurityCredential(certPathOrPEM, initiatorPassword []byte or string signature your choice) (string, error)
func ClassifyResultCode(code string) ResultClass // ResultClassSuccess|ResultClassFailure|ResultClassIndeterminate
type Error struct{ StatusCode int; RequestID, ErrorCode, ErrorMessage string }
func (e *Error) Error() string
```
Structs use exact JSON tags incl. traps: `Occassion`, `RecieverIdentifierType:"11"` default, C2B ack tag `OriginatorCoversationID`. STKPushRequest carries no Password/Timestamp fields (client injects). Callback types: `STKCallback{Body struct{ StkCallback StkCallbackBody }}` with metadata `Item []MetadataItem{Name string; Value json.RawMessage}` + `MetadataMap() map[string]any`.

**Does NOT cover:** callback HTTP server wiring (consumer-side; ADR-010 app concern); poller loop.

Steps:
- [ ] Copy certs: `New-Item -ItemType Directory -Force go\testdata; Copy-Item assets\certs\*.cer go\testdata\`
- [ ] Write failing helper tests first (timestamp format/EAT correctness incl. UTC→EAT offset case, password base64 golden value for shortcode 174379 + known passkey + fixed clock 2021-06-28T09:24:08Z→EAT, phone normalization table, validation rejections, SecurityCredential length==344 using testdata cert, classify table)
- [ ] `cd go && go test ./...` → FAIL (types undefined)
- [ ] Implement types.go, helpers.go, client.go minimal-complete per contract above; mock-server tests: token cached across two calls (count OAuth hits == 1), 401 retry-once path, each endpoint posts to correct path w/ bearer header, error envelope parsed into *Error
- [ ] `go build ./... ; go vet ./... ; go test ./...` → PASS
- [ ] Commit: `feat(go): Daraja SDK engine with full endpoint coverage`

### Task 2: Python SDK Engine

**Files:**
- Create: `python/mpesa/__init__.py` (exports MpesaClient, Environment, helpers, exceptions, version)
- Create: `python/mpesa/client.py` (dataclasses for all requests/responses incl. exact-casing field aliases; MpesaClient with threading.Lock token cache; requests.Session; methods mirroring Go surface: stk_push, stk_query, b2c_payout, transaction_status, reversal, account_balance, c2b_register_url, c2b_simulate, generate_qr_code; MpesaError(status_code, request_id, error_code, error_message))
- Create: `python/mpesa/helpers.py` ("Python specific runtime verification": normalize_phone, validate_amount_int, validate lengths/enums, generate_password(clock-injectable), security_credential via cryptography? NO — stdlib-only: implement RSA PKCS#1 v1.5 encrypt manually is unsafe ⇒ use `requests` only dep plus `cryptography` for RSA; document decision)
- Test: `python/tests/test_helpers.py`, `python/tests/test_client.py` (unittest + local http.server-based mock Daraja; cert copied to `python/tests/fixtures/`)
- Create: `python/setup.py` (name="mpesa-sdk", packages=["mpesa"], install_requires=["requests","cryptography"], python_requires=">=3.9")
- Create: `python/requirements-dev.txt` (pytest)

**Decisions locked:** import name `mpesa`; snake_case methods; dataclasses with `by_alias=True`-style serialization helper `_to_payload()` mapping pythonic attrs → exact Daraja JSON keys (incl. trap keys); EAT via `timezone(timedelta(hours=3))`.

Steps:
- [ ] Copy cert fixture into `python/tests/fixtures/`
- [ ] Failing tests: password golden vector (same as Go), phone table, XOR rule TransactionID/OriginalConversationID raises ValueError, Occassion alias assertion on serialized b2c payload, RecieverIdentifierType default "11", token cache single fetch, 401 retry once, each method URL+payload assertions, security_credential output length 344
- [ ] `py -m pytest python/tests -q` → FAIL
- [ ] Implement client.py/helpers.py minimal-complete
- [ ] `py -m pytest python/tests -q` → PASS
- [ ] Commit: `feat(python): Daraja SDK engine with full endpoint coverage`

### Task 3: TypeScript SDK Engine

**Files:**
- Create: `typescript/package.json` (name "@mpesa-sdk/core", type module, scripts: build=tsc, test=vitest run; devDeps: typescript, vitest, @types/node; engines node >=18)
- Create: `typescript/tsconfig.json` (strict, target ES2022, module NodeNext, declaration, outDir dist)
- Create: `typescript/src/types.ts` (interfaces for every req/resp/callback incl. exact-casing members: occassion?, recieverIdentifierType?: "11", OriginatorCoversationID ack, MetadataItem)
- Create: `typescript/src/errors.ts` (class MpesaError extends Error {statusCode, requestId, errorCode, errorMessage})
- Create: `typescript/src/helpers.ts` (generatePassword(shortcode, passkey, now?) EAT once, normalizePhone, validators, classifyResultCode, securityCredential via node:crypto publicEncrypt RSA_PKCS1_PADDING reading cert file)
- Create: `typescript/src/client.ts` (MpesaClient class, promise-memoized token cache w/ 50min TTL, fetch wrapper, methods matching Go names camelCase: stkPush, stkQuery, b2cPayout, transactionStatus, reversal, accountBalance, c2bRegisterUrl, c2bSimulate, generateQrCode)
- Create: `typescript/src/index.ts` (barrel export)
- Test: `typescript/test/*.test.ts` (vitest; stub globalThis.fetch; cert fixture under `typescript/test/fixtures/`)

Steps:
- [ ] Copy cert fixture into `typescript/test/fixtures/`
- [ ] Failing tests: same golden vectors as Go/Python (shared spec!), occassion key casing snapshot of serialized body, token memoization (fetch call count), 401 retry once, error envelope mapping, securityCredential 344 chars
- [ ] `cd typescript && npm install && npm test` → FAIL
- [ ] Implement src/* minimal-complete
- [ ] `npm run build && npm test` → PASS
- [ ] Commit: `feat(ts): Daraja SDK engine with full endpoint coverage`

### Task 4: CI Workflows

**Files:** Create `.github/workflows/ci.yml`

Jobs (paths-filtered, run on push/PR to main):
- `go`: setup-go 1.26 → `gofmt -l` empty check → `go vet ./...` → `go test ./... -race` (workdir go/)
- `python`: setup-python 3.11 → pip install -r python/requirements-dev.txt → `py`-equivalent `python -m pytest python/tests -q` (CI uses linux `python`)
- `node`: setup-node 20 → npm ci → npm run build → npm test (workdir typescript/)

- [ ] YAML lint sanity: `Get-Content .github\workflows\ci.yml | Out-Null` + commit
- [ ] Commit: `ci: matrix pipelines for go/python/node`

### Task 5: Root README + Examples

**Files:** Create `README.md`, `examples/go-example/main.go`, `examples/python-example/example.py`, `examples/ts-example/example.ts`

README sections: badges placeholders · what it covers (link docs/apis/) · install per language · 15-line STK Push quickstart ×3 languages (sandbox creds from docs/apis/stk-push.md) · callback handling warning box (no HMAC; ADR-010 hardening; link getting-started.md IP whitelist) · env var convention `MPESA_CONSUMER_KEY/SECRET/SHORTCODE/PASSKEY/ENVIRONMENT`.

Examples compile/lint but are unauthenticated snippets guarded behind main()/comment.

- [ ] Commit: `docs: monorepo README + runnable examples`

### Task 6: Cross-Language Review

**Files:** Modify any engine files found faulty.

Dispatch Code Reviewer subagent with checklist = "Cross-Cutting Casing Traps" table + shared behaviors 1–9 + ADR-010 indeterminate rules; verify all three engines' serialization snapshots contain identical JSON keys per endpoint (diff the golden payloads).

- [ ] All findings fixed or filed
- [ ] Commit: `fix: cross-language review findings`

## Verification (final gate)

```
cd go && go build ./... && go vet ./... && go test ./...
py -m pytest python/tests -q
cd typescript && npm ci && npm run build && npm test
```
All green = done.
