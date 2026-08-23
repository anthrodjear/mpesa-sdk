# ADR-010: M-Pesa Payment Adapter (Safaricom Daraja)

## Status

**Proposed** — 2026-08-23

## Context

ADR-009 established a plugin-based `PaymentProcessor` abstraction for multi-gateway support. M-Pesa dominates Kenya's payment landscape — 35M+ active users, ~97% mobile money market share. Any POS targeting the Kenyan market must support M-Pesa as a primary payment method.

The Daraja API provides STK Push (Lipa na M-Pesa Online) for server-initiated push-to-pay: the POS sends a payment prompt to the customer's phone, the customer enters their PIN, and funds settle immediately. Unlike card-based flows, there is no separate authorization/capture split — payment settles on customer PIN entry.

M-Pesa callbacks carry **no HMAC signature** (unlike Stripe/Square). This creates a security gap that must be addressed through alternative hardening.

## Decision

Implement a **thin internal Daraja client** (`net/http` + typed structs) behind the `PaymentProcessor` interface defined in ADR-009. No third-party Go SDKs adopted (all dormant, unofficial, or use unsafe globals).

The adapter lives **in-process** (not a go-plugin subprocess) because:
- M-Pesa callbacks must route to a Gin endpoint in the main process
- OAuth token cache benefits from sharing a single process-wide `sync.RWMutex`
- No card data involved — PCI scope is irrelevant (no P2PE needed)

If a future card adapter requires PCI scope isolation, it should use go-plugin per ADR-009.

## Implementation Details

### PaymentProcessor Interface Mapping

M-Pesa's push-to-pay model maps imperfectly to ADR-009's card-centric interface. Mapping:

| ADR-009 Method | M-Pesa Mapping | Notes |
|---|---|---|
| `Authorize` | STK Push initiation | Funds settle on PIN entry; no separate capture |
| `Capture` | Implicit | Returns "not supported" — M-Pesa settles immediately |
| `Void` | Customer cancellation / timeout | Returns "not supported" — cannot cancel a prompt already sent |
| `Refund` | B2C payout or Reversal API | Async; settles in minutes to hours |
| `GetBalance` | Daraja Balance API | Query merchant M-Pesa balance |
| `SupportsOffline` | `false` | M-Pesa is online-only |
| `Capabilities` | `["mobile_money"]` | New capability constant |

### Daraja Client

```go
// Client wraps Safaricom Daraja API endpoints.
type Client struct {
    baseURL    string
    shortcode  string
    passkey    string
    consumerKey    string
    consumerSecret string

    mu      sync.RWMutex  // guards token
    token   string
    tokenExpiry time.Time

    http    *http.Client  // Timeout: 12s
}

// OAuth token cached with singleflight refresh.
func (c *Client) Token(ctx context.Context) (string, error)

// STKPush initiates a push-to-pay prompt.
func (c *Client) STKPush(ctx context.Context, req STKPushRequest) (*STKPushResponse, error)

// STKQuery checks the status of an STK Push (fallback for missed callbacks).
func (c *Client) STKQuery(ctx context.Context, req STKQueryRequest) (*STKQueryResponse, error)

// B2CPayout sends a refund directly to customer's M-Pesa.
func (c *Client) B2CPayout(ctx context.Context, req B2CPayoutRequest) (*B2CPayoutResponse, error)
```

Password generation: `Base64(shortcode + passkey + timestamp)` — timestamp in EAT (UTC+3), `YYYYMMDDHHmmss`, generated **once** and reused in both Password and request body. The "two-clock bug" (generating separate timestamps) causes intermittent `500.001.1001` errors.

### Payment State Machine

```
CREATED ──push sent──▶ INITIATED ──callback/query──▶ COMPLETED
    │                      │                            │
    │                      ├──customer cancelled──▶ CANCELLED
    │                      ├──wrong PIN / insuffic.──▶ FAILED
    │                      ├──PIN timeout (60s)──▶ EXPIRED
    │                      └──no response + backoff exhausted──▶ INDETERMINATE
    │                                                              │
    └──────────────────── terminal state ─────────────────────────┘
```

| Status | Trigger | Terminal? | Retryable? |
|---|---|---|---|
| `CREATED` | Row written pre-push (holds client idempotency key) | no | n/a |
| `INITIATED` | Daraja acked, `CheckoutRequestID` stored | no | — |
| `COMPLETED` | `ResultCode=0` via callback or verified query | yes | no |
| `CANCELLED` | ResultCode `1032` — customer cancelled | yes-failure | new intent ok |
| `FAILED` | ResultCode `1` (insufficient), `2001` (wrong PIN), `1019` (expired) | yes-failure | new intent ok |
| `EXPIRED` | ResultCode `1037` (timeout) or own deadline passed | soft | resolve via query first |
| `INDETERMINATE` | Query inconclusive past cutoff | no | **block retries** |

**Critical**: codes `1037` and `1001` are **indeterminate, not failed** — debits have been observed landing minutes later on congested days. Marking them FAILED risks refunding paid orders.

### CAS State Transitions

```sql
UPDATE mpesa_transactions
SET status = 'COMPLETED', mpesa_receipt = $1, amount_confirmed = $2
WHERE id = $3
  AND status IN ('CREATED', 'INITIATED', 'EXPIRED')
RETURNING id;
```

Single writer wins among racing callbacks/pollers. `NULL` return = duplicate → skip.

### Callback Handler

```go
// POST /api/v1/mpesa/callback/{token}
func (h *MpesaHandler) HandleCallback(c *gin.Context) {
    // 1. Validate unguessable path token (constant-time compare)
    // 2. Parse body → persist raw JSONB
    // 3. Lookup by CheckoutRequestID — unknown ID → log orphan, ack 200, STOP
    // 4. Validate: Amount matches request, PhoneNumber matches PartyA
    // 5. CAS state transition (one writer wins)
    // 6. Write outbox event (payment.settled) in same PG transaction
    // 7. ACK 200 IMMEDIATELY: {"ResultCode":0,"ResultDesc":"Accepted"}
    //    Do NOT do business logic here — Safaricom may stop delivering
}
```

### Poller (Fallback)

```go
// Background goroutine: polls pending transactions when callbacks are late.
// SELECT ... FOR UPDATE SKIP LOCKED
//   FROM mpesa_transactions
//   WHERE status IN ('CREATED', 'INITIATED', 'EXPIRED')
//     AND next_query_at <= now()
//   LIMIT 200
//
// Backoff: +30s → +60s → +120s, cutoff ~10min.
// Only settle known-terminal codes; transient errors = keep waiting.
```

### Idempotency & Deduplication

- `client_tx_uuid` UNIQUE — terminal idempotency across retries/sync
- `checkout_request_id` UNIQUE — Daraja's dedup key
- `(shortcode, mpesa_receipt)` partial UNIQUE — prevents double-credit on receipt
- Raw payloads stored as JSONB — ≥6 months for reconciliation

### Schema

```sql
CREATE TABLE mpesa_transactions (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          UUID NOT NULL,
    sale_id            UUID,
    client_tx_uuid     UUID NOT NULL UNIQUE,
    shortcode          TEXT NOT NULL,
    status             TEXT NOT NULL CHECK (status IN (
        'CREATED','INITIATED','COMPLETED','CANCELLED',
        'FAILED','EXPIRED','INDETERMINATE')),
    amount_requested   INT NOT NULL,
    amount_confirmed   INT,
    phone              TEXT NOT NULL,
    merchant_request_id TEXT,
    checkout_request_id TEXT UNIQUE,
    mpesa_receipt      TEXT,
    result_code        INT,
    result_desc        TEXT,
    raw_request        JSONB NOT NULL,
    raw_callback       JSONB,
    initiated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    next_query_at      TIMESTAMPTZ,
    query_attempts     INT NOT NULL DEFAULT 0,
    resolved_via       TEXT,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_pending_poll ON mpesa_transactions (next_query_at)
    WHERE status IN ('CREATED', 'INITIATED', 'EXPIRED');

CREATE UNIQUE INDEX uq_receipt ON mpesa_transactions (shortcode, mpesa_receipt)
    WHERE mpesa_receipt IS NOT NULL;
```

### Reconciliation

Nightly EOD job matches `mpesa_transactions` against Safaricom's daily statement. Four counts:
- **Settled** (both sides match) — expect ~99%+
- **Statement-only** (money moved, you missed it) — investigate before close
- **Ledger-only** (false success) — flag
- **Mismatched** (partial refunds, unmodeled fees) — human review

Any non-zero drift = incident. Alert as time series.

### Multi-Tenancy

- `mpesa_transactions.tenant_id` on every row (ADR-008)
- Shortcode configured per tenant in `tenant_config` (separate Paybill/Till per business)
- Callback URL includes tenant-aware path token
- RLS policies added in a dedicated migration

## Consequences

### Positive

- **Full control**: No SDK maintenance risk; no abandoned dependency
- **ADR-009 aligned**: Maps to existing `PaymentProcessor` interface; adapter added without core changes
- **Security hardening**: URL token + CheckoutRequestID binding + field validation compensates for unsigned callbacks
- **Offline integration**: Outbox event (`payment.settled`) propagates to terminals via delta sync
- **Reconciliation built-in**: Raw payloads + EOD job ensure financial integrity

### Negative

- **~400-600 lines of client code** to maintain (Daraja is simple REST; worth the control)
- **No offline capability**: M-Pesa is online-only — cash remains the only fully offline payment method
- **Callback delivery unreliable**: ~2-5% of callbacks may be delayed or dropped; poller adds complexity
- **B2C refund latency**: Refunds settle within minutes but can take up to 24 hours; status not instantly confirmable

### Risks

- **Paybill/Till KYC lead time**: Safaricom requires business registration documents for production shortcode. Mitigation: start KYC during development; sandbox for integration testing.
- **Daraja portal changes**: Safaricom periodically modifies endpoints and rate limits without notice. Mitigation: pin API version in base URL; alert on unexpected 4xx/5xx spikes.
- **Callback delivery gaps**: Up to 5% delayed/dropped. Mitigation: poller fallback; nightly reconciliation catches any remaining drift.
- **Phone format drift**: Customers provide numbers in various formats. Mitigation: normalize to `^254[17]\d{8}$` at adapter boundary; reject invalid formats early.

## Alternatives Considered

| Approach | Control | Maintenance | Offline | Verdict |
|----------|---------|-------------|---------|---------|
| **Thin internal client** | Full | ~400-600 LOC | No | **Chosen** — full control, no SDK risk |
| **Third-party Go SDKs** | Medium | Dormant/unmaintained | No | Rejected — all carry disqualifier |
| **Paystack/Flutterwave aggregator** | Low | Vendor-managed | No | Deferred — adds 1-2% fees, needed only if cards/multi-country |
| **hashicorp/go-plugin** | High | Process overhead | No | Rejected — no PCI need (no card data); callback routing requires in-process |

## Related ADRs

- ADR-009: Payment Gateway Abstraction (interface this adapter implements)
- ADR-008: Multi-Tenancy Strategy (tenant_id, RLS, shortcode-per-tenant)
- ADR-005: PCI DSS Compliance (phone hashing, secrets in keyring)
- ADR-004: Sync Engine Design (outbox event for payment.settled, delta sync)
- ADR-001: Offline-First Architecture (M-Pesa online-only, cash fallback)
- ADR-003: Offline Payment Queuing (fallback to cash when offline)
