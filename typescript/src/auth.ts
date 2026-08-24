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
 * passes `fetchedAt + (expiresIn - 60s)`, clamped to [1s, 50min].
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

import { MpesaError } from "./errors.js";
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

// ─── Refresh cadence ──────────────────────────────────────────────────────────

/**
 * Eager refresh window: TTL minus 60s safety, clamped to [1s, 50min].
 * Unknown/zero TTLs fall back to the legacy 50-minute cadence.
 *
 * Go calls this `refreshCadence`; Python inlines the same formula.
 *
 * @param expiresInSec - Raw wire value from `expires_in` (string or number).
 * @returns Cadence in milliseconds.
 */
function refreshCadence(expiresInSec: number): number {
  const MIN = 1_000;
  const MAX = 50 * 60_000;
  const SAFETY = 60_000;
  if (expiresInSec <= 0) return MAX;
  const ms = expiresInSec * 1000 - SAFETY;
  return Math.max(MIN, Math.min(MAX, ms));
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

  /** Cached bearer token (null until first fetch). */
  private _token: string | null = null;
  /** Wall-clock expiry of the cached token (ms epoch). */
  private _expiresAt: number = 0;
  /** Generation counter — bumped on every successful refresh. */
  private _generation: number = 0;
  /** In-flight refresh promise for single-flight dedup. */
  private _refreshPromise: Promise<string> | null = null;

  /**
   * Build a TokenManager.
   *
   * @throws {Error} When credentials are missing or malformed.
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

    this._baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this._consumerKey = key;
    this._consumerSecret = secret;
    this._timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs! > 0
      ? opts.timeoutMs!
      : DEFAULT_TIMEOUT_MS;
    this._now = opts.now ?? (() => Date.now());
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
      // Our token was current — force refresh
      this._token = null;
      return this._doRefresh();
    }
    // Peer already refreshed — adopt if still fresh
    if (this._token !== null && this._now() < this._expiresAt) {
      return this._token;
    }
    // Peer token expired too — refresh
    return this._doRefresh();
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
   * Promise — a natural JS dedup without explicit locks.
   */
  private _doRefresh(): Promise<string> {
    if (this._refreshPromise !== null) {
      return this._refreshPromise;
    }
    this._refreshPromise = this._refresh()
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
   */
  private async _refresh(): Promise<string> {
    const url = `${this._baseUrl}${OAUTH_PATH}`;
    const auth = Buffer.from(
      `${this._consumerKey}:${this._consumerSecret}`,
      "utf-8",
    ).toString("base64");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this._timeoutMs);

    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "GET",
        redirect: "error",
        headers: {
          Authorization: `Basic ${auth}`,
        },
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`mpesa: oauth request: ${msg}`);
    } finally {
      clearTimeout(timer);
    }

    const contentType = resp.headers.get("content-type") ?? "";
    const text = await resp.text();
    const bodyBytes = new TextEncoder().encode(text);

    if (bodyBytes.byteLength > MAX_BODY_BYTES) {
      throw new Error(
        `mpesa: ${OAUTH_PATH} response exceeds ${MAX_BODY_BYTES} bytes`,
      );
    }

    if (resp.status < 200 || resp.status > 299) {
      throw MpesaError.fromResponse(resp.status, text, contentType);
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error("mpesa: decode oauth response");
    }

    const accessToken =
      typeof parsed["access_token"] === "string"
        ? parsed["access_token"]
        : "";
    if (!accessToken) {
      throw new Error("mpesa: oauth response missing access_token");
    }

    // Wire type is string ("3599"), not number — Safaricom quirk
    const expiresInRaw = parsed["expires_in"];
    const expiresInSec =
      typeof expiresInRaw === "number"
        ? expiresInRaw
        : typeof expiresInRaw === "string"
          ? parseInt(expiresInRaw, 10)
          : 0;

    const now = this._now();
    this._token = accessToken;
    this._expiresAt = now + refreshCadence(expiresInSec);
    this._generation++;

    return this._token;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
