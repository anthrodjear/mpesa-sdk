# Testing against a mock

The SDK only talks to the two Safaricom hosts. The base-URL allowlist
(`https://sandbox.safaricom.co.ke` / `https://api.safaricom.co.ke`) is a
deliberate security choice: the OAuth leg ships `Basic base64(key:secret)`
to the base URL, so a configurable base URL would let a confused deputy —
or a copied config snippet — point your credentials at an attacker host.
There is **no supported way to repoint the base URL**, and that is not an
oversight.

Instead, every engine exposes a transport/clock injection seam. Use it to
run the SDK against `httptest`, `responses`, or a hand-built fake `fetch`
in your own tests — the SDK code path under test stays identical to
production.

| Engine | Transport seam | Clock seam | Notes |
|--------|---------------|------------|-------|
| Go | `Config.HTTPClient` (`*http.Client`) | `Config.Now` (`func() time.Time`) | Injected transports are cloned, never mutated; one with `InsecureSkipVerify` is refused at construction |
| Python | `Config.http_client` (`requests.Session`) | `Config.now` (`Callable[[], datetime]`) | The client **clones** the injected session and forces `verify=True`, `trust_env=False`, `auth=None` on its own copy — your global session keeps its behavior (telemetry, retry adapters) and can never pick up netrc/env credentials |
| TypeScript | `MpesaClientOptions.fetch` | `MpesaClientOptions.now` | A custom `fetch` must honor `signal` (the body-cap reader races each read against the abort signal) and must not follow redirects (the SDK refuses them) |

## Recipe

```go
srv := httptest.NewServer(handler)
c, _ := mpesa.NewClient(mpesa.Config{HTTPClient: srv.Client() /* … */})
// The allowlist still applies to the OAUTH leg; point your handler at the
// same paths the SDK requests (/oauth/v1/generate, /mpesa/…) and answer
// in-process. `Config.Now` removes every time.Sleep from the suite.
```

```python
session = requests.Session()          # mount a mock adapter, or pass a fake
cfg = Config(..., http_client=session, now=lambda: FROZEN)
```

```ts
const client = new MpesaClient({
  config,
  fetch: myFetchThatSpeaksToTheMock,   // must honor `signal`
  now: () => FROZEN_MS,
});
```

## What still applies under a mock

- **Client-side limits** (per-transaction ceilings) run before any network
  I/O, so they fire against a mock server too.
- **Callback/result URL SSRF rules** are unchanged: a `CallBackURL`
  pointing at loopback/private space is rejected regardless of transport.
- **The 1 MiB response cap** applies to whatever the seam returns, so an
  oversize mock body produces the same typed 413 as a hostile gateway.

If your tests need to exercise a non-Safaricom **base URL**, that is a
deliberate non-goal — inject the transport instead and keep the allowlist
doing its job.
