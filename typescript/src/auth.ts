/**
 * OAuth token caching with generation-guarded refresh — TS mirror of
 * go/client.go (token cache + generation guard) and python/mpesa/auth.py
 * (TokenManager class). Daraja invalidates ALL outstanding tokens when any
 * app mints a new one (TTL ~3600s), so this manager caches one bearer per
 * process, refreshes eagerly before expiry, and resolves 401.003.01 through
 * a generation counter so concurrent callers never stampede the OAuth
 * endpoint across replicas.
 *
 * The documented pairing primitive for 401 recovery is
 * {@link TokenManager.getTokenWithGen}.
 *
 * **Single-flight**: The first stale caller performs the OAuth round-trip;
 * concurrent stale callers await the same Promise (TS natural dedup —
 * no explicit lock needed like Python's threading.Lock).
 *
 * **Wall-clock freshness**: Tokens are refreshed when the wall clock
 * passes `fetchedAt + (expiresIn - 60s)`, clamped to [60s, 50min].
 * This avoids both the late-refresh stampede and the early-refresh waste.
 *
 * @example
 * ```ts
 * const tm = new TokenManager({
 *   baseUrl: "https://sandbox.safaricom.co.ke",
 *   consumerKey: process.env.MPESA_CONSUMER_KEY!,
 *   consumerSecret: process.env.MPESA_CONSUMER_SECRET!,
 * });
 * const token = await tm.getToken(); // cached or fresh
 * ```
 * @see {@link getAccessToken} for a one-shot convenience wrapper.
 * @packageDocumentation
 */

import { MpesaDecodeError, MpesaError, decodeJsonObject } from "./errors.js";
import { ConfigError, TRUSTED_BASE_URLS } from "./config.js";
import { readBodyBounded, bodyTooLargeError } from "./_bounded-read.js";
import type { OAuthToken } from "./types.js";

// ─── Constants ────────────────────────────────────────────────────────────────

/** OAuth endpoint path (docs/apis/oauth.md). */
const OAUTH_PATH = "/oauth/v1/generate?grant_type=client_credentials";

/** Credential validation error prefix. */
const CREDENTIALS_MSG =
  "mpesa: Config.ConsumerKey and Config.ConsumerSecret are required before calling any endpoint";

/** Max response body size (1 MiB, parity: go `_MAX_BODY_BYTES`). */
const MAX_BODY_BYTES = 1 << 20;

/** Default OAuth request timeout (30s). */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Consecutive-failure threshold before throttling (Go `refreshFailures >= 3` parity). */
const REFRESH_FAILURE_THRESHOLD = 3;

/** Minimum time between OAuth refresh attempts after failures (Go `refreshRateLimit = 5s` parity). */
const REFRESH_RATE_LIMIT_MS = 5_000;

/**
 * Bounded response-body reader lives in `./_bounded-read.js` (shared with
 * client.ts — single implementation, tree-shake friendly).
 */

// ─── Refresh cadence ──────────────────────────────────────────────────────────

/**
 * Eager refresh window: TTL minus 60s safety, clamped to [60s, 50min].
 * Unknown/zero TTLs fall back to the legacy 50-minute cadence.
 *
 * NaN-safe by construction: a non-finite `expiresInSec` (garbage string,
 * `1e999` → Infinity) MUST map to the 50-minute fallback, because
 * `Math.max(MIN, Math.min(MAX, NaN))` is NaN and `now + NaN` is NaN —
 * `now < NaN` is false, so the freshness fast path would NEVER cache and
 * every call would re-mint (each mint invalidates prior tokens → 401.003.01
 * storm).
 *
 * Go calls this `refreshCadence`; Python inlines the same formula.
 *
 * @param expiresInSec - Raw wire value from `expires_in` (string or number).
 * @returns Cadence in milliseconds.
 */
function refreshCadence(expiresInSec: number): number {
  // 60s floor (cross-SDK decision): a sub-minute cadence re-mints far
  // more often than Daraja's token invalidation semantics justify.
  const MIN = 60_000;
  const MAX = 50 * 60_000;
  const SAFETY = 60_000;
  if (!Number.isFinite(expiresInSec) || expiresInSec <= 0) return MAX;
  const ms = expiresInSec * 1000 - SAFETY;
  return Math.max(MIN, Math.min(MAX, ms));
}

/**
 * Normalize the wire `expires_in` to a usable seconds value.
 *
 * Daraja sends a string (`"3599"`), a number (`120`), or garbage. Every
 * non-finite outcome — non-numeric strings (`parseInt` → NaN),
 * `1e999` (JSON → Infinity), ±Infinity — becomes 0, which
 * {@link refreshCadence} already maps to the documented 50-minute fallback.
 * The same 0 covers a MISSING field (documented fallback, keep it).
 *
 * @param raw - Raw `expires_in` value from the decoded OAuth body.
 * @returns Finite seconds, or 0 for absent/unusable values.
 */
function normalizeExpiresIn(raw: unknown): number {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : 0;
  if (typeof raw === "string") {
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

// ─── TokenManager ─────────────────────────────────────────────────────────────

/**
 * Options for constructing a {@link TokenManager}.
 *
 * @property baseUrl - API base URL (e.g. `"https://sandbox.safaricom.co.ke"`).
 * @property consumerKey - OAuth consumer key (non-empty, ASCII, no colon).
 * @property consumerSecret - OAuth consumer secret (non-empty, ASCII).
 * @property timeoutMs - Per-request timeout in milliseconds (default 30s).
 * @property now - Injectable clock for testing (default `Date.now`).
 */
export interface TokenManagerOptions {
  readonly baseUrl: string;
  readonly consumerKey: string;
  readonly consumerSecret: string;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Concurrency-safe bearer cache for one Daraja environment.
 *
 * Create one per environment and share it; the token cache is guarded
 * internally. Holds the write lock across the OAuth round-trip — a
 * deliberate ~once-per-refresh-window stall traded for strict
 * single-flight, because requesting a token invalidates every
 * previously issued one.
 *
 * @example
 * ```ts
 * const tm = new TokenManager({
 *   baseUrl: "https://sandbox.safaricom.co.ke",
 *   consumerKey: "key", consumerSecret: "secret",
 * });
 * const token = await tm.getToken();
 * ```
 */
export class TokenManager {
  private readonly _baseUrl: string;
  private readonly _consumerKey: string;
  private readonly _consumerSecret: string;
  private readonly _timeoutMs: number;
  private readonly _now: () => number;
  private readonly _fetch: typeof globalThis.fetch;

  /** Cached bearer token (null until first fetch). */
  private _token: string | null = null;
  /** Wall-clock expiry of the cached token (ms epoch). */
  private _expiresAt: number = 0;
  /** Generation counter — bumped on every successful refresh. */
  private _generation: number = 0;
  /** In-flight refresh promise for single-flight dedup. */
  private _refreshPromise: Promise<string> | null = null;
  /** Consecutive refresh failures; reset on success (Go `refreshFailures` parity). */
  private _failures: number = 0;
  /** Wall-clock ms of last non-forced refresh attempt (Go `lastRefreshAttempt` parity; 0 = never). */
  private _lastAttemptMs: number = 0;

  /**
   * Build a TokenManager.
   *
   * @throws {Error} When credentials are missing or malformed.
   * @throws {ConfigError} When baseUrl is not in the trusted allowlist.
   */
  constructor(opts: TokenManagerOptions) {
    const key = opts.consumerKey;
    const secret = opts.consumerSecret;

    if (!key || !secret) {
      throw new Error(CREDENTIALS_MSG);
    }
    if (key.includes(":")) {
      throw new Error("mpesa: consumer_key must not contain ':'");
    }
    if (!isAscii(key) || !isAscii(secret)) {
      throw new Error("mpesa: credentials must be ASCII");
    }

    const normalizedBaseUrl = opts.baseUrl.replace(/\/+$/, "");
    if (!TRUSTED_BASE_URLS.has(normalizedBaseUrl)) {
      throw new ConfigError(
        `mpesa: refusing untrusted base_url ${JSON.stringify(normalizedBaseUrl)} ` +
        `(want https://sandbox.safaricom.co.ke or https://api.safaricom.co.ke)`,
      );
    }

    this._baseUrl = normalizedBaseUrl;
    this._consumerKey = key;
    this._consumerSecret = secret;
    this._timeoutMs = Number.isFinite(opts.timeoutMs) && (opts.timeoutMs ?? 0) > 0
      ? opts.timeoutMs!
      : DEFAULT_TIMEOUT_MS;
    this._now = opts.now ?? (() => Date.now());
    this._fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Valid cached bearer, refreshing single-flight when stale.
   *
   * @example
   * ```ts
   * const token = await tm.getToken();
   * fetch(url, { headers: { Authorization: `Bearer ${token}` } });
   * ```
   */
  async getToken(): Promise<string> {
    const [token] = await this.getTokenWithGen();
    return token;
  }

  /**
   * Return `[token, gen]` from ONE coherent snapshot. The generation
   * counter lets callers detect a concurrent refresh later (401.003.01
   * recovery).
   *
   * Fast path snapshots under the lock and returns immediately when
   * fresh WITHOUT performing any state mutation (double-checked
   * pattern); stale callers re-acquire for the single-flight refresh,
   * whose recheck keeps concurrent refetches at exactly one.
   *
   * @example
   * ```ts
   * const [token, gen] = await tm.getTokenWithGen();
   * // ... on 401.003.01:
   * const fresh = await tm.refreshAfterInvalidToken(gen);
   * ```
   */
  async getTokenWithGen(): Promise<[string, number]> {
    // Fast path: fresh token — no mutation needed
    if (this._token !== null && this._now() < this._expiresAt) {
      return [this._token, this._generation];
    }
    // Stale: single-flight refresh
    const token = await this._doRefresh();
    return [token, this._generation];
  }

  /**
   * Resolve a 401.003.01 under the generation guard.
   *
   * If OUR view was current when it failed (`_generation` unchanged),
   * we clear the token and lead the hard refresh — a
   * Daraja-invalidated but clock-fresh token must never stay servable.
   * Otherwise a peer already refreshed and we adopt its token, but
   * ONLY while it is still wall-clock fresh (intentional deviation from
   * go/client.go: Go trusts the peer unconditionally; an expired adopt
   * would hand back a dead bearer).
   *
   * @param myGen - The generation from the paired snapshot that failed.
   * @returns Fresh bearer token.
   *
   * @example
   * ```ts
   * const [token, gen] = await tm.getTokenWithGen();
   * // ... business call returns 401.003.01 ...
   * const fresh = await tm.refreshAfterInvalidToken(gen);
   * ```
   */
  async refreshAfterInvalidToken(myGen: number): Promise<string> {
    if (this._generation === myGen) {
      // Our token was current — force refresh (bypasses rate limit, Go force=true parity)
      this._token = null;
      return this._doRefresh(true);
    }
    // Peer already refreshed — adopt if still fresh
    if (this._token !== null && this._now() < this._expiresAt) {
      return this._token;
    }
    // Peer token expired too — force refresh (bypasses rate limit)
    return this._doRefresh(true);
  }

  /**
   * Current generation counter (test/introspection seam).
   *
   * @example
   * ```ts
   * console.log(tm.generation); // 0 before first fetch, 1 after
   * ```
   */
  get generation(): number {
    return this._generation;
  }

  /**
   * Credential-safe: never renders the bearer value.
   *
   * @example
   * ```ts
   * console.log(tm.toString());
   * // TokenManager(gen=1, cached=true)
   * ```
   */
  toString(): string {
    return `TokenManager(gen=${this._generation}, cached=${this._token !== null})`;
  }

  /**
   * Redacted object for structured logging.
   *
   * @example
   * ```ts
   * logger.info(tm.toJSON());
   * // { generation: 1, cached: true }
   * ```
   */
  toJSON(): { generation: number; cached: boolean } {
    return { generation: this._generation, cached: this._token !== null };
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /**
   * Single-flight refresh. Concurrent stale callers share the same
   * Promise — a natural JS dedup without explicit locks — EXCEPT a
   * forced (401-triggered) refresh, which must never inherit a
   * possibly rate-limited non-forced promise.
   *
   * Adopt-on-success: when a forced refresh finds an in-flight refresh
   * that SUCCEEDS, it adopts the token that refresh just minted — the
   * mint is fresh and valid, and a second mint would invalidate the token
   * the in-flight refresh produced (Daraja invalidates ALL outstanding
   * tokens on every mint, so a chained re-mint hands every holder of the
   * first token a 401.003.01 and can cascade into re-mint churn). Only
   * when the in-flight refresh FAILS does the forced caller perform its
   * own attempt (bypassing the rate-limit gate) — so a forced refresh
   * never inherits a rate-limited non-forced 429.
   *
   * @param force - When true, bypasses the refresh rate limit (401-triggered
   *   refreshes, Go `force=true` parity).
   */
  private _doRefresh(force = false): Promise<string> {
    const inFlight = this._refreshPromise;
    if (inFlight !== null) {
      if (!force) return inFlight;
      return inFlight.then(
        (token) => token,
        () => this._doRefresh(true),
      );
    }
    this._refreshPromise = this._refresh(force)
      .finally(() => {
        this._refreshPromise = null;
      });
    return this._refreshPromise;
  }

  /**
   * Hard OAuth round-trip against
   * `{base}/oauth/v1/generate?grant_type=client_credentials`
   * (docs/apis/oauth.md). Holds the "lock" across the network call —
   * callers stall ~once per refresh window; that is the deliberate
   * single-flight tradeoff (see go/client.go).
   *
   * Rate-limit parity with `go/client.go refreshLocked`: non-forced
   * refreshes are throttled after 3 consecutive failures inside 5s;
   * 401-triggered refreshes (`force=true`) bypass the guard entirely
   * but still advance its clock.
   */
  private async _refresh(force = false): Promise<string> {
    const now = this._now();
    // Rate limit: only apply to non-forced refreshes after consecutive failures.
    if (!force) {
      if (
        this._failures >= REFRESH_FAILURE_THRESHOLD &&
        this._lastAttemptMs !== 0 &&
        now - this._lastAttemptMs < REFRESH_RATE_LIMIT_MS
      ) {
        const agoMs = now - this._lastAttemptMs;
        // Typed (MpesaError, HTTP 429) instead of a bare Error so callers
        // catching the SDK taxonomy see rate limiting like any other
        // failure mode. renderMessage prepends the canonical "mpesa: ".
        throw new MpesaError(429, null, null,
          `refresh rate limited after ${this._failures} consecutive failures ` +
          `(last attempt ${agoMs}ms ago, need ${REFRESH_RATE_LIMIT_MS}ms)`);
      }
    }
    // The clock advances on EVERY attempt — forced (401-triggered)
    // refreshes bypass the guard above but must still move the window,
    // or an all-forced crash loop leaves the clock stale and the guard
    // never fires for the next non-forced attempt (Go/Python parity:
    // go/client.go, python/mpesa/auth.py). A refused attempt throws
    // above and never reaches this line, so it never extends the window.
    this._lastAttemptMs = now;

    try {
      const token = await this._fetchToken();
      this._failures = 0;
      return token;
    } catch (err) {
      this._failures++;
      // Re-stamp the window at the FAILURE instant (Go
      // `recordRefreshFailure` parity, go/client.go): a slow failing
      // attempt must not age the attempt-start stamp past the 5s
      // window, or the 3-failure gate would never trip against a slow
      // endpoint. A refused/gated attempt throws above and never
      // reaches this line ("refused is not an attempt").
      this._lastAttemptMs = this._now();
      throw err;
    }
  }

  /**
   * Raw OAuth fetch + parse. Split from {@link TokenManager._refresh} so the
   * rate-limit guard stays verbatim-portable from Go while the network logic
   * is untouched.
   */
  private async _fetchToken(): Promise<string> {
    const url = `${this._baseUrl}${OAUTH_PATH}`;
    const auth = Buffer.from(
      `${this._consumerKey}:${this._consumerSecret}`,
      "utf-8",
    ).toString("base64");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this._timeoutMs);

    // One clear, on EVERY exit path: the timeout must cover the BODY read
    // too (a server that trickles the body after the headers would
    // otherwise leave this promise pending forever), and it must be
    // released when the fetch itself fails so no timer outlives the call.
    try {
      let resp: Response;
      try {
        resp = await this._fetch(url, {
          method: "GET",
          redirect: "error",
          headers: {
            Authorization: `Basic ${auth}`,
          },
          signal: controller.signal,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`mpesa: oauth request: ${msg}`);
      }

      // First guard: honest Content-Length over the cap → cancel without
      // consuming the body.
      const contentLength = resp.headers.get("content-length");
      if (contentLength !== null) {
        const claimed = parseInt(contentLength, 10);
        if (Number.isFinite(claimed) && claimed > MAX_BODY_BYTES) {
          resp.body?.cancel();
          throw bodyTooLargeError(OAUTH_PATH, MAX_BODY_BYTES, claimed);
        }
      }

      const contentType = resp.headers.get("content-type") ?? "";

      // Second guard: bounded stream read — aborts once the accumulated chunk
      // total passes the cap even when Content-Length is absent or dishonest.
      // Abort-aware: a mid-body stall rejects with the typed timeout error.
      const text = await readBodyBounded(resp.body, OAUTH_PATH, MAX_BODY_BYTES, controller.signal);

      if (resp.status < 200 || resp.status > 299) {
        throw MpesaError.fromResponse(resp.status, text, contentType);
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = decodeJsonObject<Record<string, unknown>>(text, "oauth");
      } catch (err) {
        // Keep the historic, actionable wording while upgrading the type.
        throw err instanceof MpesaDecodeError
          ? new MpesaDecodeError("mpesa: decode oauth response", resp.status)
          : err;
      }

      const accessToken =
        typeof parsed["access_token"] === "string"
          ? parsed["access_token"]
          : "";
      if (!accessToken) {
        throw new Error("mpesa: oauth response missing access_token");
      }

      // Wire type is string ("3599"), not number — Safaricom quirk.
      // Non-finite/garbage TTLs normalize to 0 → 50-minute fallback cadence.
      const expiresInSec = normalizeExpiresIn(parsed["expires_in"]);

      const now = this._now();
      this._token = accessToken;
      this._expiresAt = now + refreshCadence(expiresInSec);
      this._generation++;

      return this._token;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * `util.inspect` hook — the TypeScript equivalent of Python's
 * `TokenManager.__repr__` (python/mpesa/auth.py) and Go's `Client.Format`
 * (go/client.go).
 *
 * `util.inspect` does NOT consult `toString()`/`toJSON()`: left to its own
 * devices it walks the own enumerable properties and prints
 * `_consumerKey` and `_consumerSecret` in cleartext — which is exactly
 * what `console.log(tm)` does. SECURITY.md forbids cleartext credentials
 * in logs, so the hook routes `inspect` (and therefore `console.log`)
 * through the credential-safe {@link TokenManager.toString} form.
 *
 * Installed with `Symbol.for("nodejs.util.inspect.custom")` rather than an
 * import of `node:util`, so this module keeps no Node-only import. The
 * hook is NOT writable: a redaction hook must not be replaceable at
 * runtime.
 */
Object.defineProperty(TokenManager.prototype, Symbol.for("nodejs.util.inspect.custom"), {
  value(this: TokenManager): string { return this.toString(); },
  enumerable: false, configurable: true, writable: false,
});

/** Is every byte of `s` in the ASCII range? */
function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0x7f) return false;
  }
  return true;
}

// ─── Convenience ──────────────────────────────────────────────────────────────

/**
 * One-shot OAuth token fetch — creates a throwaway {@link TokenManager},
 * fetches the token, and returns it. Use for scripts, CLI tools, or any
 * context where caching is unnecessary.
 *
 * @param baseUrl    - API base URL.
 * @param key        - OAuth consumer key.
 * @param secret     - OAuth consumer secret.
 * @param timeoutMs  - Per-request timeout (default 30s).
 * @returns The bearer token string.
 *
 * @example
 * ```ts
 * const token = await getAccessToken(
 *   "https://sandbox.safaricom.co.ke",
 *   process.env.MPESA_CONSUMER_KEY!,
 *   process.env.MPESA_CONSUMER_SECRET!,
 * );
 * ```
 */
export async function getAccessToken(
  baseUrl: string,
  key: string,
  secret: string,
  timeoutMs?: number,
): Promise<string> {
  const tm = new TokenManager({
    baseUrl,
    consumerKey: key,
    consumerSecret: secret,
    ...(timeoutMs !== undefined && { timeoutMs }),
  });
  return tm.getToken();
}
