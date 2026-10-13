# Transaction limits

Client-side amount ceilings — a cross-cutting control, not an endpoint. Every
amount-carrying request is checked **before any network I/O** against a
per-transaction ceiling. The gateway remains the final authority; the ceiling
only moves validation earlier, closer to your code.

## Service buckets

| Bucket | Covers | Default per-transaction | Default per-day |
|---|---|---|---|
| `stk` | STK Push | 250,000 KES | 500,000 KES |
| `c2b` | C2B Register URL / C2B Simulate | 250,000 KES | 500,000 KES |
| `b2c` | B2C payout | 250,000 KES | 500,000 KES |
| `default` | Reversal, Transaction Status, Dynamic QR, anything unspecialized | 250,000 KES | 500,000 KES |

Per-day ceilings apply **only** when daily tracking is switched on (below).
Defaults follow the published Safaricom caps; B2C details in [b2c.md](b2c.md).

## Semantics: unset vs zero

Limits config is a **partial overlay** on those defaults, resolved once when
the client is built:

- an **unset** field (`nil` in Go, `None` in Python) *inherits* the default;
- an explicit **`0`** (or negative) means **unlimited** — the only value that
  unambiguously disables a ceiling.

A partially-filled config therefore cannot silently disarm a ceiling it never
mentioned, and a merchant on an unlimited tier can still say so.

```go
c, _ := mpesa.NewClient(mpesa.Config{
    // ...
    Limits: &mpesa.TransactionLimits{
        B2C: mpesa.ServiceLimits{MaxPerTransaction: mpesa.Limit(700_000)}, // raise B2C only
    },
})
```

```python
Config(limits=TransactionLimits(b2c=ServiceLimits(max_per_transaction=700_000)))
```

```ts
new Config({ /* ... */ limits: { b2c: { maxPerTransaction: 700_000 } } })
```

Everything left unset keeps its Safaricom default.

## Daily tracking is opt-in and process-local

`Config.TrackDaily` (Go) / `Config(track_daily=True)` (Python) / `trackDaily`
(TypeScript) adds the per-day ceiling — **off by default**. One process cannot
observe the replicas that share its shortcode, so a local accumulator
under-counts the platform-wide total: treat it as a circuit breaker for the
single worst-case process, not as a control. Check-and-increment is atomic in
all three engines, and the day rolls at Africa/Nairobi (UTC+3, no DST)
midnight — the merchant-reporting day. Quota is consumed **on attempt**: a
request rejected before dispatch consumes nothing, one that fails afterwards
was already consumed. Reversal and Dynamic QR share one `default` daily bucket.

## Error shapes

A ceiling violation is refused before dispatch with one typed error per engine;
each message names the exact config path to raise (or `0` to disable):

| Engine | Type | Shape |
|---|---|---|
| Go | `*mpesa.LimitError` | `mpesa: STK Push Amount <n> exceeds configured max <m> KES (set Config.Limits.STK.MaxPerTransaction, or 0 for unlimited)` |
| Python | `ValueError` | `mpesa: <field> <n> exceeds the <m> KES per-transaction ceiling configured for the <service> service; override it with Config(limits=TransactionLimits(…))` |
| TypeScript | `MpesaError` (HTTP 400) | `STK Push amount <n> exceeds the configured per-transaction limit of <m> KES (raise limits.stk.maxPerTransaction in Config; 0 = unlimited)` |

## Behavior change vs earlier releases

Earlier releases enforced ceilings only at the gateway. These SDK versions
refuse above-ceiling amounts **locally**, so a flow that previously failed (or
succeeded) at the gateway may now fail in the client with the errors above. To
restore the old pass-through, set that service's ceiling to `0` (unlimited).
