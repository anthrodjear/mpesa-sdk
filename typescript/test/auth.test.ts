/**
 * Tests for src/auth.ts — OAuth TokenManager with generation-guarded
 * refresh, single-flight, peer adoption, and credential redaction.
 *
 * Mirrors go/client_test.go and python/mpesa/auth.py test patterns
 * with exact parity on concurrency and generation-guard semantics.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TokenManager, getAccessToken } from "../src/auth.js";
import { ConfigError } from "../src/config.js";
import { MpesaError } from "../src/errors.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const BASE_URL = "https://sandbox.safaricom.co.ke";
const CONSUMER_KEY = "test-key";
const CONSUMER_SECRET = "test-secret";

const VALID_TOKEN_RESPONSE = {
  access_token: "tok-abc123",
  expires_in: "3599",
  token_type: "Bearer",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonResponseFactory(body: unknown, status = 200): () => Response {
  return () => jsonResponse(body, status);
}

function errorResponse(
  status: number,
  envelope: Record<string, unknown>,
): Response {
  return new Response(JSON.stringify(envelope), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

let fetchMock: ReturnType<typeof vi.fn>;
let nowMs: number;

beforeEach(() => {
  nowMs = Date.now();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeManager(opts?: {
  key?: string;
  secret?: string;
  baseUrl?: string;
  timeoutMs?: number;
}): TokenManager {
  return new TokenManager({
    baseUrl: opts?.baseUrl ?? BASE_URL,
    consumerKey: opts?.key ?? CONSUMER_KEY,
    consumerSecret: opts?.secret ?? CONSUMER_SECRET,
    timeoutMs: opts?.timeoutMs ?? 5000,
    now: () => nowMs,
  });
}

// ---------------------------------------------------------------------------
// Construction & validation
// ---------------------------------------------------------------------------

describe("TokenManager construction", () => {
  it("creates with valid credentials", () => {
    const tm = makeManager();
    expect(tm.toString()).toContain("gen=0");
    expect(tm.toString()).toContain("cached=false");
  });

  it("rejects empty consumer key", () => {
    expect(() => makeManager({ key: "" })).toThrow(
      "mpesa: Config.ConsumerKey and Config.ConsumerSecret are required",
    );
  });

  it("rejects empty consumer secret", () => {
    expect(() => makeManager({ secret: "" })).toThrow(
      "mpesa: Config.ConsumerKey and Config.ConsumerSecret are required",
    );
  });

  it("rejects colon in consumer key", () => {
    expect(() => makeManager({ key: "key:secret" })).toThrow(
      "mpesa: consumer_key must not contain ':'",
    );
  });

  it("rejects non-ASCII consumer key", () => {
    expect(() => makeManager({ key: "k\u00e9y" })).toThrow(
      "mpesa: credentials must be ASCII",
    );
  });

  it("rejects non-ASCII consumer secret", () => {
    expect(() => makeManager({ secret: "s\u00e9cret" })).toThrow(
      "mpesa: credentials must be ASCII",
    );
  });

  it("strips trailing slashes from baseUrl", () => {
    const tm = makeManager({ baseUrl: "https://sandbox.safaricom.co.ke///" });
    // Internal baseUrl should be trimmed — verified indirectly by fetch URL
    fetchMock.mockResolvedValue(jsonResponse(VALID_TOKEN_RESPONSE));
    void tm.getToken();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
      expect.anything(),
    );
  });

  it("rejects untrusted baseUrl hosts", () => {
    const untrustedHosts = [
      "https://evil.example.com",
      "https://sandbox.safaricom.co.ke.evil.com",
      "http://sandbox.safaricom.co.ke",
      "https://sandbox.safaricom.co.ke.evil.com/",
      "",
    ];
    for (const baseUrl of untrustedHosts) {
      expect(() => makeManager({ baseUrl })).toThrow(ConfigError);
      expect(() => makeManager({ baseUrl })).toThrow(/untrusted/);
    }
  });
});

// ---------------------------------------------------------------------------
// Token fetching & caching
// ---------------------------------------------------------------------------

describe("TokenManager.getToken", () => {
  it("fetches token on first call", async () => {
    fetchMock.mockResolvedValue(jsonResponse(VALID_TOKEN_RESPONSE));
    const tm = makeManager();

    const token = await tm.getToken();
    expect(token).toBe("tok-abc123");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caches token across sequential calls", async () => {
    fetchMock.mockResolvedValue(jsonResponse(VALID_TOKEN_RESPONSE));
    const tm = makeManager();

    await tm.getToken();
    await tm.getToken();
    await tm.getToken();

    // Only one OAuth fetch — token is cached
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns correct generation after fetch", async () => {
    fetchMock.mockResolvedValue(jsonResponse(VALID_TOKEN_RESPONSE));
    const tm = makeManager();

    expect(tm.generation).toBe(0);

    await tm.getToken();
    expect(tm.generation).toBe(1);
  });

  it("sends Basic auth header with correct encoding", async () => {
    fetchMock.mockResolvedValue(jsonResponse(VALID_TOKEN_RESPONSE));
    const tm = makeManager();

    await tm.getToken();

    const [, init] = fetchMock.mock.calls[0]!;
    const headers = init.headers as Record<string, string>;
    const expectedAuth =
      "Basic " +
      Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString("base64");
    expect(headers["Authorization"]).toBe(expectedAuth);
  });

  it("calls the correct OAuth path", async () => {
    fetchMock.mockResolvedValue(jsonResponse(VALID_TOKEN_RESPONSE));
    const tm = makeManager();

    await tm.getToken();

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      `${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    );
  });

  it("uses GET method", async () => {
    fetchMock.mockResolvedValue(jsonResponse(VALID_TOKEN_RESPONSE));
    const tm = makeManager();

    await tm.getToken();

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.method).toBe("GET");
  });

  it("passes redirect:\"error\" to prevent Basic auth leak on 3xx", async () => {
    fetchMock.mockResolvedValue(jsonResponse(VALID_TOKEN_RESPONSE));
    const tm = makeManager();

    await tm.getToken();

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.redirect).toBe("error");
  });

  it("wires AbortController.signal to fetch", async () => {
    fetchMock.mockResolvedValue(jsonResponse(VALID_TOKEN_RESPONSE));
    const tm = makeManager();

    await tm.getToken();

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

// ---------------------------------------------------------------------------
// getTokenWithGen — paired snapshot
// ---------------------------------------------------------------------------

describe("TokenManager.getTokenWithGen", () => {
  it("returns [token, generation] pair", async () => {
    fetchMock.mockResolvedValue(jsonResponse(VALID_TOKEN_RESPONSE));
    const tm = makeManager();

    const [token, gen] = await tm.getTokenWithGen();
    expect(token).toBe("tok-abc123");
    expect(gen).toBe(1);
  });

  it("returns same gen on cached hit", async () => {
    fetchMock.mockResolvedValue(jsonResponse(VALID_TOKEN_RESPONSE));
    const tm = makeManager();

    await tm.getTokenWithGen();
    const [token, gen] = await tm.getTokenWithGen();

    expect(token).toBe("tok-abc123");
    expect(gen).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Expiry detection & refresh cadence
// ---------------------------------------------------------------------------

describe("TokenManager expiry", () => {
  it("refreshes after cadence expires", async () => {
    fetchMock.mockImplementation(jsonResponseFactory(VALID_TOKEN_RESPONSE));
    const tm = makeManager();

    await tm.getToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Advance past TTL-60s cadence: 3599 - 60 = 3539 seconds
    nowMs += 3540 * 1000;

    await tm.getToken();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT refresh within cadence window", async () => {
    fetchMock.mockImplementation(jsonResponseFactory(VALID_TOKEN_RESPONSE));
    const tm = makeManager();

    await tm.getToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Advance 59 seconds — within the 60s safety margin
    nowMs += 59_000;

    await tm.getToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("handles numeric expires_in (Safaricom variant)", async () => {
    fetchMock.mockImplementation(
      jsonResponseFactory({ ...VALID_TOKEN_RESPONSE, expires_in: 120 }),
    );
    const tm = makeManager();

    await tm.getToken();

    // TTL=120, cadence = 120-60 = 60s
    nowMs += 59_000;
    await tm.getToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    nowMs += 2_000; // now at 61s
    await tm.getToken();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("clamps short TTL cadence to minimum 60 seconds", async () => {
    // TTL=30 → cadence = max(60s, 30-60) = 60s floor (Go/Python parity).
    fetchMock.mockImplementation(
      jsonResponseFactory({ ...VALID_TOKEN_RESPONSE, expires_in: "30" }),
    );
    const tm = makeManager();

    await tm.getToken();
    nowMs += 2_000; // 2s < 60s floor → still cached
    await tm.getToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    nowMs += 60_000; // past the floor
    await tm.getToken();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("clamps long TTL cadence to maximum 50 minutes", async () => {
    // TTL=7200 (2h) → cadence = min(50min, 7200-60) = 50min
    fetchMock.mockImplementation(
      jsonResponseFactory({ ...VALID_TOKEN_RESPONSE, expires_in: "7200" }),
    );
    const tm = makeManager();

    await tm.getToken();
    // At 49 minutes — still within 50min cap
    nowMs += 49 * 60_000;
    await tm.getToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // At 51 minutes — past cap
    nowMs += 2 * 60_000;
    await tm.getToken();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats zero/missing expires_in as legacy 50-minute cadence", async () => {
    fetchMock.mockImplementation(
      jsonResponseFactory({ ...VALID_TOKEN_RESPONSE, expires_in: undefined }),
    );
    const tm = makeManager();

    await tm.getToken();
    // Within 50min
    nowMs += 49 * 60_000;
    await tm.getToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Past 50min
    nowMs += 2 * 60_000;
    await tm.getToken();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Single-flight (concurrent callers share one fetch)
// ---------------------------------------------------------------------------

describe("TokenManager single-flight", () => {
  it("concurrent getToken calls produce exactly one OAuth fetch", async () => {
    let resolveFetch!: (v: Response) => void;
    fetchMock.mockImplementation(
      () => new Promise<Response>((r) => { resolveFetch = r; }),
    );
    const tm = makeManager();

    // Fire 8 concurrent callers — all should share the same in-flight promise
    const p1 = tm.getToken();
    const p2 = tm.getToken();
    const p3 = tm.getToken();
    const p4 = tm.getToken();
    const p5 = tm.getToken();
    const p6 = tm.getToken();
    const p7 = tm.getToken();
    const p8 = tm.getToken();

    // Resolve the single fetch
    resolveFetch(jsonResponse(VALID_TOKEN_RESPONSE));

    const results = await Promise.all([p1, p2, p3, p4, p5, p6, p7, p8]);

    // All 8 got the same token
    for (const tok of results) {
      expect(tok).toBe("tok-abc123");
    }
    // Exactly ONE fetch
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Peer adoption (refreshAfterInvalidToken)
// ---------------------------------------------------------------------------

describe("TokenManager peer adoption", () => {
  it("leader refreshes when gen matches", async () => {
    let callCount = 0;
    fetchMock.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return jsonResponse(VALID_TOKEN_RESPONSE);
      return jsonResponse({ ...VALID_TOKEN_RESPONSE, access_token: "tok-v2" });
    });
    const tm = makeManager();

    const [, gen] = await tm.getTokenWithGen();
    expect(gen).toBe(1);

    // Force-refresh: our gen matches → leader path
    const fresh = await tm.refreshAfterInvalidToken(gen);
    expect(fresh).toBe("tok-v2");
    expect(tm.generation).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("follower adopts peer token when gen differs and still fresh", async () => {
    fetchMock.mockResolvedValue(jsonResponse(VALID_TOKEN_RESPONSE));
    const tm = makeManager();

    const [, gen] = await tm.getTokenWithGen();

    // Simulate peer refresh: bump generation without us knowing
    // (in real code, another TokenManager instance does this;
    // here we directly bump to simulate)
    (tm as unknown as { _generation: number })._generation = 99;

    // gen=1 but _generation=99 → follower path
    const adopted = await tm.refreshAfterInvalidToken(gen);
    expect(adopted).toBe("tok-abc123");
    // No additional fetch — adopted peer's token
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follower refreshes when peer token expired", async () => {
    let callCount = 0;
    fetchMock.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return jsonResponse(VALID_TOKEN_RESPONSE);
      return jsonResponse({ ...VALID_TOKEN_RESPONSE, access_token: "tok-refreshed" });
    });
    const tm = makeManager();

    const [, gen] = await tm.getTokenWithGen();

    // Simulate peer refresh + token expiry
    (tm as unknown as { _generation: number })._generation = 99;
    nowMs += 3600 * 1000; // TTL passed

    const fresh = await tm.refreshAfterInvalidToken(gen);
    expect(fresh).toBe("tok-refreshed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("forced refresh during a rate-limited in-flight non-forced refresh performs its own attempt", async () => {
    // Arm the refresh gate: 3 consecutive fetch failures (threshold 3,
    // frozen clock keeps every attempt inside the 5s window).
    let calls = 0;
    fetchMock.mockImplementation(() => {
      calls++;
      if (calls <= 3) return Promise.reject(new Error("boom"));
      return Promise.resolve(
        jsonResponse({ ...VALID_TOKEN_RESPONSE, access_token: "tok-forced" }),
      );
    });
    const tm = makeManager();

    await expect(tm.getToken()).rejects.toThrow("boom");
    await expect(tm.getToken()).rejects.toThrow("boom");
    await expect(tm.getToken()).rejects.toThrow("boom");
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // The next non-forced refresh is rate-limited — keep its rejection
    // in flight while a 401-triggered forced refresh arrives. The forced
    // refresh must NOT inherit the 429; it chains a fresh attempt that
    // bypasses the gate and mints its own token.
    const gated = tm.getToken();
    const forced = tm.refreshAfterInvalidToken(tm.generation);

    let gatedErr: unknown;
    await gated.then(
      () => { throw new Error("gated refresh should have rejected"); },
      (err: unknown) => { gatedErr = err; },
    );
    expect(gatedErr).toBeInstanceOf(MpesaError);
    expect((gatedErr as MpesaError).statusCode).toBe(429);

    await expect(forced).resolves.toBe("tok-forced");
    // 3 failed attempts + exactly one forced attempt — the forced refresh
    // performed its own fetch instead of joining the gated promise.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("forced refresh failures advance the rate-limit clock", async () => {
    // Go/Python parity: EVERY attempt — including 401-triggered forced
    // ones — advances the 3-failures-in-5s clock. Without this, three
    // consecutive forced failures leave the clock stale and the next
    // non-forced refresh escapes the guard entirely (crash loop).
    let calls = 0;
    fetchMock.mockImplementation(() => {
      calls++;
      if (calls === 1) return Promise.resolve(jsonResponse(VALID_TOKEN_RESPONSE));
      return Promise.reject(new Error("boom"));
    });
    const tm = makeManager();

    // Seed the cache (a successful non-forced refresh starts the clock).
    await tm.getToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Token TTL long past; the frozen clock keeps the three consecutive
    // forced failures inside the 5s window.
    nowMs += 3600 * 1000;
    const gen = tm.generation;
    await expect(tm.refreshAfterInvalidToken(gen)).rejects.toThrow("boom");
    await expect(tm.refreshAfterInvalidToken(gen)).rejects.toThrow("boom");
    await expect(tm.refreshAfterInvalidToken(gen)).rejects.toThrow("boom");
    expect(fetchMock).toHaveBeenCalledTimes(4);

    // The next non-forced refresh is gated: the forced attempts moved
    // the clock, so the guard fires — and does so before any fetch.
    await expect(tm.getToken()).rejects.toThrow("refresh rate limited");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("a slow attempt arms the 3-failure gate from its FAILURE instant (not its start)", async () => {
    // Each attempt spans 6s: the failure lands 6s after the attempt START.
    // The window must re-stamp at the failure instant (Go
    // recordRefreshFailure) — with an attempt-start-only stamp, attempt 3's
    // stamp is already 6s stale when it fails, the guard sees
    // now - last >= 5s, and the next refresh escapes the gate entirely
    // (crash loop against a dead OAuth endpoint).
    let calls = 0;
    fetchMock.mockImplementation(() => {
      calls++;
      // Attempt starts now; the clock advances 6s mid-flight (slow
      // timeout) before the network error lands.
      nowMs += 6_000;
      return Promise.reject(new Error("boom"));
    });
    const tm = makeManager();

    await expect(tm.getToken()).rejects.toThrow("boom");
    await expect(tm.getToken()).rejects.toThrow("boom");
    await expect(tm.getToken()).rejects.toThrow("boom");
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // 3 consecutive failures, the last one 0s ago → gated before any fetch.
    await expect(tm.getToken()).rejects.toThrow("refresh rate limited");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("forced refresh during a successful in-flight non-forced refresh adopts its token", async () => {
    let resolveInFlight!: (v: Response) => void;
    fetchMock.mockImplementation(
      () => new Promise<Response>((r) => { resolveInFlight = r; }),
    );
    const tm = makeManager();

    // Non-forced refresh goes in flight (mint #1 pending).
    const inFlight = tm.getToken();
    // 401-triggered forced refresh arrives while mint #1 is in flight: it
    // must ADOPT the in-flight token on success — a second mint would
    // invalidate the token mint #1 just produced (Daraja invalidates all
    // outstanding tokens on every mint).
    const forced = tm.refreshAfterInvalidToken(tm.generation);

    resolveInFlight(jsonResponse(VALID_TOKEN_RESPONSE));

    await expect(inFlight).resolves.toBe("tok-abc123");
    await expect(forced).resolves.toBe("tok-abc123");
    // Adopted, not re-minted: exactly ONE fetch.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an OAuth response with oversize Content-Length as typed MpesaError (HTTP 413)", async () => {
    fetchMock.mockResolvedValue(
      new Response("tiny", {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(2 * 1024 * 1024),
        },
      }),
    );
    const tm = makeManager();

    let caught: unknown;
    try {
      await tm.getToken();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MpesaError);
    expect((caught as MpesaError).statusCode).toBe(413);
    expect((caught as Error).message).toContain("exceeds");
  });
});

// ---------------------------------------------------------------------------
// HTTP error handling
// ---------------------------------------------------------------------------

describe("TokenManager HTTP errors", () => {
  it("throws MpesaError on non-2xx response", async () => {
    fetchMock.mockImplementation(jsonResponseFactory(
      { requestId: "req-1", errorCode: "401.003.01", errorMessage: "Invalid access token" },
      401,
    ));
    const tm = makeManager();

    await expect(tm.getToken()).rejects.toThrow(MpesaError);
    try {
      await tm.getToken();
    } catch (e) {
      expect(e).toBeInstanceOf(MpesaError);
      const err = e as MpesaError;
      expect(err.statusCode).toBe(401);
      expect(err.errorCode).toBe("401.003.01");
      expect(err.errorMessage).toBe("Invalid access token");
      expect(err.requestId).toBe("req-1");
    }
  });

  it("throws on missing access_token in response", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ expires_in: "3599", token_type: "Bearer" }),
    );
    const tm = makeManager();

    await expect(tm.getToken()).rejects.toThrow(
      "mpesa: oauth response missing access_token",
    );
  });

  it("throws on empty access_token in response", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ access_token: "", expires_in: "3599" }),
    );
    const tm = makeManager();

    await expect(tm.getToken()).rejects.toThrow(
      "mpesa: oauth response missing access_token",
    );
  });

  it("throws on unparseable JSON response", async () => {
    fetchMock.mockImplementation(() =>
      new Response("<html>Server Error</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );
    const tm = makeManager();

    await expect(tm.getToken()).rejects.toThrow("mpesa: decode oauth response");
  });

  it("throws on network error", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const tm = makeManager();

    await expect(tm.getToken()).rejects.toThrow("mpesa: oauth request");
  });

  it("throws on abort (timeout)", async () => {
    fetchMock.mockImplementation(
      () => new Promise<Response>((_, reject) => {
        setTimeout(() => reject(new DOMException("The operation was aborted.", "AbortError")), 10);
      }),
    );
    const tm = makeManager({ timeoutMs: 1 });

    await expect(tm.getToken()).rejects.toThrow("mpesa: oauth request");
  });

  it("non-retryable 401 (not 401.003.01) surfaces error without refresh", async () => {
    fetchMock.mockImplementation(jsonResponseFactory(
      { requestId: "r-1", errorCode: "401.001.01", errorMessage: "Invalid credentials" },
      401,
    ));
    const tm = makeManager();

    await expect(tm.getToken()).rejects.toThrow(MpesaError);
    // Only one fetch — no refresh attempted for non-401.003.01 codes
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retry exhaustion: 401.003.01 twice surfaces typed error, no infinite loop", async () => {
    fetchMock.mockImplementation(jsonResponseFactory(
      { requestId: "r-2", errorCode: "401.003.01", errorMessage: "Token revoked" },
      401,
    ));
    const tm = makeManager();

    await expect(tm.getToken()).rejects.toThrow(MpesaError);
    // Single-flight: only one fetch per getToken() call — no infinite loop
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Config error prevents network I/O
// ---------------------------------------------------------------------------

describe("TokenManager zero-config", () => {
  it("fails before network call with actionable error", () => {
    // Error is thrown in constructor — no network I/O possible
    expect(() => makeManager({ key: "", secret: "" })).toThrow(
      "mpesa: Config.ConsumerKey and Config.ConsumerSecret are required",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Token redaction (toString / toJSON)
// ---------------------------------------------------------------------------

describe("TokenManager redaction", () => {
  it("toString never exposes bearer value", async () => {
    fetchMock.mockResolvedValue(jsonResponse(VALID_TOKEN_RESPONSE));
    const tm = makeManager();

    await tm.getToken();
    const str = tm.toString();
    expect(str).not.toContain("tok-abc123");
    expect(str).toContain("gen=1");
    expect(str).toContain("cached=true");
  });

  it("toJSON never exposes bearer value", async () => {
    fetchMock.mockResolvedValue(jsonResponse(VALID_TOKEN_RESPONSE));
    const tm = makeManager();

    await tm.getToken();
    const json = tm.toJSON();
    expect(json).toEqual({ generation: 1, cached: true });
    expect(JSON.stringify(json)).not.toContain("tok-abc123");
  });

  it("JSON.stringify calls toJSON (safe for structured logging)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(VALID_TOKEN_RESPONSE));
    const tm = makeManager();

    await tm.getToken();
    const logged = JSON.parse(JSON.stringify(tm)) as Record<string, unknown>;
    expect(logged["generation"]).toBe(1);
    expect(logged["cached"]).toBe(true);
    expect(logged["token"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getAccessToken convenience helper
// ---------------------------------------------------------------------------

describe("getAccessToken", () => {
  it("returns token from a one-shot fetch", async () => {
    fetchMock.mockResolvedValue(jsonResponse(VALID_TOKEN_RESPONSE));

    const token = await getAccessToken(BASE_URL, CONSUMER_KEY, CONSUMER_SECRET);
    expect(token).toBe("tok-abc123");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws on invalid credentials", async () => {
    await expect(
      getAccessToken(BASE_URL, "", CONSUMER_SECRET),
    ).rejects.toThrow(
      "mpesa: Config.ConsumerKey and Config.ConsumerSecret are required",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects untrusted baseUrl hosts without network", async () => {
    const untrustedHosts = [
      "https://evil.example.com",
      "https://sandbox.safaricom.co.ke.evil.com",
      "http://sandbox.safaricom.co.ke",
      "https://sandbox.safaricom.co.ke.evil.com/",
      "",
    ];
    for (const baseUrl of untrustedHosts) {
      await expect(
        getAccessToken(baseUrl, CONSUMER_KEY, CONSUMER_SECRET),
      ).rejects.toThrow(ConfigError);
      await expect(
        getAccessToken(baseUrl, CONSUMER_KEY, CONSUMER_SECRET),
      ).rejects.toThrow(/untrusted/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// NaN / garbage expires_in — the cached-token invariant
//
// A non-finite expires_in used to produce `_expiresAt = now + NaN`. Since
// `now < NaN` is false, the freshness fast path NEVER hit and every call
// re-minted a token — and Daraja invalidates all outstanding tokens on
// each mint, so that self-amplified into a 401.003.01 storm. The invariant
// under test: a garbage TTL behaves EXACTLY like the documented missing
// TTL fallback (50-minute cadence), i.e. the token is still cached.
// ---------------------------------------------------------------------------

describe("TokenManager NaN/garbage expires_in", () => {
  /** Raw JSON text responses — `1e999` only decodes to Infinity via literal text. */
  function rawTextResponse(text: string, status = 200): Response {
    return new Response(text, {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  const cases: Array<[string, string]> = [
    ["non-numeric string 'abc'", '{"access_token":"tok-abc123","expires_in":"abc","token_type":"Bearer"}'],
    ["empty string", '{"access_token":"tok-abc123","expires_in":"","token_type":"Bearer"}'],
    ["negative '-1'", '{"access_token":"tok-abc123","expires_in":"-1","token_type":"Bearer"}'],
    ["number literal 1e999 (Infinity)", '{"access_token":"tok-abc123","expires_in":1e999,"token_type":"Bearer"}'],
    ["number beyond 2^53 (9007199254740993)", '{"access_token":"tok-abc123","expires_in":9007199254740993,"token_type":"Bearer"}'],
    ["missing field", '{"access_token":"tok-abc123","token_type":"Bearer"}'],
    ["zero", '{"access_token":"tok-abc123","expires_in":0,"token_type":"Bearer"}'],
  ];

  for (const [name, body] of cases) {
    it(`treats ${name} as the 50-minute fallback cadence (token stays cached)`, async () => {
      fetchMock.mockImplementation(() => rawTextResponse(body));
      const tm = makeManager();

      await tm.getToken();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // The decisive invariant: the token is STILL cached after 49 minutes —
      // `_expiresAt` must be a finite number, not NaN.
      nowMs += 49 * 60_000;
      await tm.getToken();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Past the fallback cadence the re-mint happens exactly once.
      nowMs += 2 * 60_000;
      await tm.getToken();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  }

  it("garbage expires_in never triggers a re-mint storm", async () => {
    fetchMock.mockImplementation(() =>
      rawTextResponse('{"access_token":"tok-abc123","expires_in":"abc","token_type":"Bearer"}'),
    );
    const tm = makeManager();

    await tm.getToken();
    // Hammer the cache: NaN expiry would re-mint on EVERY call.
    for (let i = 0; i < 25; i++) {
      nowMs += 60_000;
      await tm.getToken();
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Concurrent refresh on an EXPIRED token — exactly one OAuth fetch
// ---------------------------------------------------------------------------

describe("TokenManager concurrent refresh (single-flight)", () => {
  it("8 callers on an expired token produce exactly ONE refresh fetch", async () => {
    let callCount = 0;
    let resolveSecond!: (v: Response) => void;
    fetchMock.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(jsonResponse(VALID_TOKEN_RESPONSE));
      }
      return new Promise<Response>((r) => { resolveSecond = r; });
    });
    const tm = makeManager();

    await tm.getToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Expire the cached token, then fire 8 concurrent callers.
    nowMs += 3600 * 1000;
    const callers = Array.from({ length: 8 }, () => tm.getToken());

    resolveSecond(jsonResponse({ ...VALID_TOKEN_RESPONSE, access_token: "tok-v2" }));

    const results = await Promise.all(callers);
    for (const tok of results) {
      expect(tok).toBe("tok-v2");
    }
    expect(fetchMock).toHaveBeenCalledTimes(2); // initial + exactly one refresh
  });
});
