/**
 * Tests for src/auth.ts — OAuth TokenManager with generation-guarded
 * refresh, single-flight, peer adoption, and credential redaction.
 *
 * Mirrors go/client_test.go and python/mpesa/auth.py test patterns
 * with exact parity on concurrency and generation-guard semantics.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TokenManager, getAccessToken } from "../src/auth.js";
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
    const tm = makeManager({ baseUrl: "https://example.com///" });
    // Internal baseUrl should be trimmed — verified indirectly by fetch URL
    fetchMock.mockResolvedValue(jsonResponse(VALID_TOKEN_RESPONSE));
    void tm.getToken();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/oauth/v1/generate?grant_type=client_credentials",
      expect.anything(),
    );
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

  it("clamps short TTL cadence to minimum 1 second", async () => {
    // TTL=30 → cadence = max(1s, 30-60) = 1s
    fetchMock.mockImplementation(
      jsonResponseFactory({ ...VALID_TOKEN_RESPONSE, expires_in: "30" }),
    );
    const tm = makeManager();

    await tm.getToken();
    nowMs += 2_000; // 2 seconds > 1s cadence
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
});
