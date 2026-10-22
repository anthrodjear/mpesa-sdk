/**
 * MpesaClient — concurrency-safe Daraja transport with generation-guarded
 * token caching, redirect refusal and typed error surfacing. TS mirror of
 * go/client.go and python/mpesa/client.py.
 *
 * **Value semantics**: endpoint methods apply injected defaults to an
 * internal copy — the caller's request object is never mutated.
 *
 * **Retry-once auth**: On HTTP 401 carrying errorCode `401.003.01`
 * (invalid/expired token) the client force-refreshes the token once under
 * the generation guard and retries the business call exactly once.
 *
 * **Response cap**: All response bodies are bounded to 1 MiB
 * (`maxResponseLen`) — oversized payloads are rejected with a typed error
 * before any parsing attempt.
 *
 * @example
 * ```ts
 * import { MpesaClient, Config } from "@mpesa-sdk/core";
 *
 * const client = MpesaClient.fromConfig(new Config({
 *   consumerKey: process.env.MPESA_CONSUMER_KEY!,
 *   consumerSecret: process.env.MPESA_CONSUMER_SECRET!,
 *   shortcode: process.env.MPESA_SHORTCODE!,
 *   passkey: process.env.MPESA_PASSKEY!,
 * }));
 *
 * const resp = await client.stkPush({
 *   transactionType: TransactionType.BillPayGoods,
 *   amount: 100,
 *   partyA: "254722000000",
 *   phoneNumber: "254722111111",
 *   callBackURL: "https://mydomain.com/callback",
 *   accountReference: "Order123",
 *   transactionDesc: "Payment",
 * });
 * ```
 * @see docs/apis/ for endpoint documentation
 * @packageDocumentation
 */

import { createHash } from "node:crypto";

import { Config, ConfigError, Environment } from "./config.js";
import {
  MpesaError,
  decodeJsonObject,
  tryDecodeJsonObject,
  type ErrorLogger,
} from "./errors.js";
import {
  checkDailyLimit,
  enforcePerTransactionLimit,
  nairobiDayKey,
  type LimitService,
  type TransactionLimits,
} from "./limits.js";
import {
  generatePassword,
  normalizePhone,
  newOriginatorID,
} from "./helpers.js";
import { TokenManager } from "./auth.js";
import { readBodyBounded, bodyTooLargeError } from "./_bounded-read.js";
import type {
  STKPushRequest,
  STKQueryRequest,
  B2CRequest,
  TransactionStatusRequest,
  AccountBalanceRequest,
  ReversalRequest,
  C2BRegisterRequest,
  C2BSimulateRequest,
  DynamicQRRequest,
  STKPushResponse,
  STKQueryResponse,
  ConversationResponse,
  C2BAckResponse,
  QRCodeResponse,
} from "./types.js";
import { CommandID, TransactionType, QRTrxCode } from "./enums.js";

// ─── Endpoint paths ───────────────────────────────────────────────────────────

/** STK Push (Lipa Na M-Pesa Online) request path. */
const STK_PUSH_PATH = "/mpesa/stkpush/v1/processrequest";

/** STK Push query status path. */
const STK_QUERY_PATH = "/mpesa/stkpushquery/v1/query";

/** B2C (Business to Customer) payout path. */
const B2C_PATH = "/mpesa/b2c/v3/paymentrequest";

/** C2B URL registration path. */
const C2B_REGISTER_PATH = "/mpesa/c2b/v2/registerurl";

/** C2B payment simulation path (sandbox only). */
const C2B_SIMULATE_PATH = "/mpesa/c2b/v2/simulate";

/** Transaction status query path. */
const TX_STATUS_PATH = "/mpesa/transactionstatus/v1/query";

/** Transaction reversal path. */
const REVERSAL_PATH = "/mpesa/reversal/v1/request";

/** Account balance query path. */
const ACCOUNT_BALANCE_PATH = "/mpesa/accountbalance/v1/query";

/** Dynamic QR code generation path. */
const QR_CODE_PATH = "/mpesa/qrcode/v1/generate";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Daraja invalid-token error code — triggers retry-once. */
const ERR_CODE_INVALID_TOKEN = "401.003.01";

/** Max response body size (1 MiB, parity: go `maxResponseLen`). */
const MAX_RESPONSE_LEN = 1 << 20;

/** Default request timeout (30s). */
const DEFAULT_TIMEOUT_MS = 30_000;

// ─── B2C command whitelist ────────────────────────────────────────────────────

/** Commands accepted by the B2C endpoint (docs/apis/b2c.md). */
const B2C_COMMANDS = new Set<string>([
  CommandID.SalaryPayment.value,
  CommandID.BusinessPayment.value,
  CommandID.PromotionPayment.value,
]);

// ─── Dynamic QR TrxCode whitelist ─────────────────────────────────────────────

/** TrxCode values accepted by the QR endpoint (docs/apis/dynamic-qr.md). */
const QR_TRX_CODES = new Set<string>(QRTrxCode.ALL.map((c) => c.value));

// ─── Validation helpers ───────────────────────────────────────────────────────

function requireNonEmpty(field: string, value: string): void {
  if (value.trim().length === 0) {
    throw new Error(`mpesa: ${field} is required`);
  }
}

/**
 * Printable-character gate (Python `str.isprintable` parity): every code
 * point must be printable, where "printable" excludes Unicode Other
 * (`C*`) and Separator (`Z*`) categories EXCEPT the ASCII space (0x20) —
 * exactly CPython's `isprintable` definition. Used for identifier fields
 * where a control character could forge log lines or confuse the gateway.
 */
function isPrintableUnicode(value: string): boolean {
  for (const ch of value) {
    if (/\p{C}/u.test(ch)) return false;
    if (ch !== " " && /\p{Z}/u.test(ch)) return false;
  }
  return true;
}

/** Printable, length-capped identifier (Python `_printable` parity). */
function requirePrintableMaxLen(field: string, value: string, max: number): void {
  if (!isPrintableUnicode(value)) {
    throw new Error(`mpesa: ${field} contains non-printable characters`);
  }
  if ([...value].length > max) {
    throw new Error(
      `mpesa: ${field} exceeds ${max} characters (got ${[...value].length})`,
    );
  }
}

/**
 * `inet_aton`-style dotted/numeric IPv4 literal parser (decimal, octal,
 * hex and short-hand forms). Returns the address as a 32-bit unsigned
 * integer, or null when `host` is not a numeric literal at all.
 *
 * Accepted spellings (glibc/Berkeley `inet_aton` semantics):
 * - full dotted quad: `127.0.0.1`
 * - short-hand: `127.1` → 127.0.0.1 (the trailing part fills the
 *   REMAINING bytes, so it may exceed 255)
 * - bare 32-bit number: `2130706433`
 * - octal (leading zero REQUIRED — `0177` is 127, but `177` is decimal
 *   177, never 0o177; this is inet_aton's rule, and omitting it would
 *   reject public addresses like `177.1.1.1` as loopback)
 * - hex (`0x` prefix): `0x7f000001`
 *
 * Rationale: the dotted-quad blocklist regex misses every one of these
 * numeric forms — all four spellings resolve to 127.0.0.1/10.0.0.1 and
 * must be rejected identically.
 */
function parseNumericIPv4(host: string): number | null {
  if (/^0[xX][0-9a-fA-F]+$/.test(host)) {
    const v = Number.parseInt(host.slice(2), 16);
    return Number.isFinite(v) && v >= 0 && v <= 0xffffffff ? v >>> 0 : null;
  }
  const parts = host.split(".");
  if (parts.length === 0 || parts.length > 4) return null;
  let addr = 0;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i] ?? "";
    let v: number;
    if (/^0[xX][0-9a-fA-F]+$/.test(part)) v = Number.parseInt(part.slice(2), 16);
    else if (/^0[0-7]+$/.test(part)) v = Number.parseInt(part, 8);
    else if (/^\d+$/.test(part)) v = Number.parseInt(part, 10);
    else return null;
    if (!Number.isFinite(v) || v < 0 || v > 255) return null;
    addr = (addr << 8) | v;
  }
  const last = parts[parts.length - 1] ?? "";
  let lastV: number;
  if (/^0[xX][0-9a-fA-F]+$/.test(last)) lastV = Number.parseInt(last.slice(2), 16);
  else if (/^0[0-7]+$/.test(last)) lastV = Number.parseInt(last, 8);
  else if (/^\d+$/.test(last)) lastV = Number.parseInt(last, 10);
  else return null;
  const bytesForLast = 4 - (parts.length - 1);
  const maxLast = Math.pow(256, bytesForLast) - 1;
  if (!Number.isFinite(lastV) || lastV < 0 || lastV > maxLast) return null;
  return (addr * Math.pow(256, bytesForLast) + lastV) >>> 0;
}

/** Is this host spelled like a numeric (dotted/numeric) IPv4 literal? */
function looksNumericIPv4(host: string): boolean {
  return /^(\d+)(\.\d+){0,3}$/.test(host) || /^0[xX][0-9a-fA-F]+$/.test(host);
}

function isBlockedIPv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const octets = m.slice(1).map(Number);
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b, c, d] = octets;
  if (a === undefined || b === undefined || c === undefined || d === undefined) return false;
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  if (a === 0) return true; // 0.0.0.0/8 this-network (whole range, not just 0.0.0.0)
  if (a >= 224 && a <= 239) return true; // 224.0.0.0/4 multicast
  return false;
}

function isBlockedIP(host: string): boolean {
  let h = host.toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  const pct = h.indexOf("%");
  if (pct !== -1) h = h.slice(0, pct); // strip IPv6 zone id (fe80::1%eth0)
  if (h === "::" || h === "::1") return true; // unspecified / loopback
  if (h.includes(":")) {
    // Any ":" means an IP literal (DNS names never contain ":").
    // Embedded IPv4 tail (e.g. ::ffff:127.0.0.1) — check the tail.
    const tail = h.slice(h.lastIndexOf(":") + 1);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(tail) && isBlockedIPv4(tail)) return true;
    // First hextet numeric checks for ULA / link-local / multicast.
    const firstGroup = h.split(":").find((g) => g.length > 0) ?? "";
    const v = Number.parseInt(firstGroup, 16);
    if (Number.isInteger(v)) {
      if ((v & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
      if ((v & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
      if ((v & 0xff00) === 0xff00) return true; // ff00::/8 multicast
    } else if (h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80") || h.startsWith("ff")) {
      return true; // conservative fallback for non-standard forms
    }
    return false;
  }
  return isBlockedIPv4(h);
}

function requireURL(field: string, value: string): void {
  requireNonEmpty(field, value);
  if (/\s/.test(value)) {
    throw new Error(`mpesa: ${field} must not contain whitespace`);
  }
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new Error(`mpesa: ${field} is not a valid URL`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(
      `mpesa: ${field} must use http or https scheme, got ${JSON.stringify(u.protocol.slice(0, -1))}`,
    );
  }
  // Reject embedded credentials — mirrors Go `u.User != nil` (any "@" in authority).
  const schemeEnd = value.indexOf("://");
  const authority = (schemeEnd !== -1 ? value.slice(schemeEnd + 3) : value).split(/[/?#]/, 1)[0] ?? "";
  if (authority.includes("@") || u.username !== "" || u.password !== "") {
    throw new Error(`mpesa: ${field} must not contain embedded credentials`);
  }
  const rawHost = u.hostname;
  if (!rawHost) {
    throw new Error(`mpesa: ${field} must have a non-empty host`);
  }
  let host = rawHost.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  const zoneIdx = host.indexOf("%");
  if (zoneIdx !== -1) host = host.slice(0, zoneIdx);
  if (host === "") {
    throw new Error(`mpesa: ${field} must have a valid host`);
  }
  if (host === "localhost" || host === "localhost." || host.replace(/\.+$/, "") === "localhost") {
    throw new Error(`mpesa: ${field} must not point to localhost`);
  }
  // Numeric-host normalization (inet_aton parity with the Go/Python fixes):
  // the dotted-quad regex above misses `2852039166`, `0x7f000001`,
  // `2130706433`, `017700000001` and `127.1` — all resolve to blocked
  // addresses. A numeric-looking host that FAILS to parse is REJECTED
  // (fail closed: an unparseable numeric literal is either hostile or
  // misconfigured, and either way it must never reach the gateway).
  if (looksNumericIPv4(host)) {
    const numeric = parseNumericIPv4(host);
    if (numeric === null) {
      throw new Error(`mpesa: ${field} is not a valid IPv4 literal`);
    }
    const octets = [
      (numeric >>> 24) & 0xff,
      (numeric >>> 16) & 0xff,
      (numeric >>> 8) & 0xff,
      numeric & 0xff,
    ].join(".");
    if (isBlockedIPv4(octets)) {
      throw new Error(`mpesa: ${field} must not point to an internal or private IP address`);
    }
  }
  if (isBlockedIP(host)) {
    throw new Error(`mpesa: ${field} must not point to an internal or private IP address`);
  }
}

/**
 * Require a positive whole number amount (OWASP Input Validation:
 * allowlist positive integers; Daraja amounts are whole shillings —
 * Go/Python + docs/apis/stk-push.md require ints, never decimals).
 * Uses `Number.isInteger` + `Number.isFinite` + `> 0` per TypeScript
 * numeric-guard conventions.
 */
function requirePositiveInt(field: string, value: number): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`mpesa: ${field} must be a positive whole number, got ${value}`);
  }
}

/**
 * Lower-bound-only amount gate (B2C's MINIMUM is a gateway contract, its
 * MAXIMUM is configurable): the historical `requireMinMax(..., 10,
 * 250_000)` hardcoded a ceiling Safaricom raised per-merchant, so only the
 * minimum stays here; the maximum now flows from {@link Config.limits}
 * via {@link MpesaClient._enforceLimits}.
 *
 * @throws {Error} When `value` is not a whole number ≥ `min`.
 */
function requireMinInt(field: string, value: number, min: number): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min) {
    throw new Error(`mpesa: ${field} must be a whole number of at least ${min}, got ${value}`);
  }
}

function requireLengthRange(field: string, value: string, min: number, max: number): void {
  const n = value.trim().length;
  if (n < min || n > max) {
    throw new Error(`mpesa: ${field} must be ${min}-${max} characters, got ${n}`);
  }
}

/**
 * Bounded response-body reader lives in `./_bounded-read.js` (shared with
 * auth.ts — single implementation, tree-shake friendly).
 */

// ─── MpesaClient ──────────────────────────────────────────────────────────────

// ─── Shared token-cache registry ─────────────────────────────────────────────

/**
 * Process-wide {@link TokenManager} registry keyed by a DIGEST of the
 * credential tuple (see {@link sharedTokenCacheKey}).
 *
 * Rationale: a fresh TokenManager per client instance means every
 * `fromEnv()` call performs its own OAuth round-trip, and because Daraja
 * INVALIDATES all outstanding tokens on each mint, sibling instances
 * cycle-invalidate each other into 401.003.01 storms. Sharing one cache
 * per credential set collapses that to a single process-wide single-flight
 * refresh.
 *
 * Scope discipline: ONLY clients constructed with pure defaults (no
 * injected `fetch`/`now`/`timeoutMs`) share, so an injected dependency can
 * never leak across instances or outlive its test. The map is bounded
 * (oldest entry evicted past {@link SHARED_TOKEN_CACHE_MAX}) so repeated
 * credential rotation cannot grow it without limit — the cache holds no
 * secret material beyond what the caller already passes in.
 */
const SHARED_TOKEN_CACHE_MAX = 8;
const sharedTokenManagers = new Map<string, TokenManager>();

/**
 * Cache key for the process-wide {@link TokenManager} registry: a SHA-256
 * digest of the credential tuple.
 *
 * The registry is a module-level `Map` that lives for the PROCESS
 * lifetime, so a key holding the consumer secret in cleartext would keep
 * that secret in the heap (heap dumps, `--inspect`, secret scanners) long
 * after the client was discarded. A digest is deterministic — the same
 * credentials must map to the same cache entry — and reveals nothing about
 * the secret.
 *
 * The tuple is LENGTH-PREFIXED rather than joined with a separator: with a
 * `|` join, ("a|b", "c") and ("a", "b|c") produced the same key, so two
 * different credential sets could share one cache entry.
 *
 * INTERNAL — not public API: exported from this module for the test suite
 * only. The package barrel (`src/index.ts`) does not re-export it, so it is
 * not part of the published `@mpesa-sdk/core` surface and may change or
 * disappear without a major-version bump.
 *
 * @param baseUrl - The client's API base URL.
 * @param consumerKey - The OAuth consumer key.
 * @param consumerSecret - The OAuth consumer secret (hashed, never stored).
 * @returns The hex SHA-256 digest of the tuple.
 */
export function sharedTokenCacheKey(
  baseUrl: string,
  consumerKey: string,
  consumerSecret: string,
): string {
  const material = `${baseUrl.length}:${baseUrl}` +
    `${consumerKey.length}:${consumerKey}` +
    `${consumerSecret.length}:${consumerSecret}`;
  return createHash("sha256").update(material, "utf8").digest("hex");
}

function sharedTokenManager(
  baseUrl: string,
  consumerKey: string,
  consumerSecret: string,
): TokenManager {
  const key = sharedTokenCacheKey(baseUrl, consumerKey, consumerSecret);
  const existing = sharedTokenManagers.get(key);
  if (existing !== undefined) return existing;
  const manager = new TokenManager({ baseUrl, consumerKey, consumerSecret });
  if (sharedTokenManagers.size >= SHARED_TOKEN_CACHE_MAX) {
    const oldest = sharedTokenManagers.keys().next();
    if (!oldest.done) sharedTokenManagers.delete(oldest.value);
  }
  sharedTokenManagers.set(key, manager);
  return manager;
}

/**
 * Options for constructing a {@link MpesaClient}.
 *
 * @property config      - Validated configuration with credentials.
 * @property timeoutMs   - Per-request timeout in milliseconds (default 30s).
 * @property now         - Injectable clock for testing (default `Date.now`).
 * @property fetch       - Injectable fetch for proxies, tracing, or custom
 *   transports. TRANSPORT BOUNDARY: a custom `fetch` MUST honor
 *   `RequestInit.redirect` — the client passes `redirect: "error"` on every
 *   business POST and OAuth GET (Node undici default is `follow`, and
 *   cross-origin redirects strip `Authorization` while same-origin 307/308s
 *   would replay the Bearer token to the redirect target). A wrapper that
 *   drops or overrides `redirect` re-opens credential replay on 307/308.
 * @property retryOnUnauthorized - Retry-once on HTTP 401 carrying
 *   `401.003.01` (force-refresh + one re-attempt). Default `true`; set
 *   `false` to surface the 401 immediately with NO second fetch and NO
 *   forced token refresh (callers that mint their own credentials per
 *   request, or that must not invalidate sibling tokens, opt out).
 * @property errorLogger - OPT-IN diagnostic sink for the RAW body of a
 *   non-2xx response whose body is NOT a Daraja error envelope (a WAF page,
 *   an HTML error page, a truncated body). The exception text itself stays
 *   generic — "unexpected error response from gateway" — because an
 *   exception object is logged by every logger on the call path and must
 *   never carry a raw gateway payload (customer MSISDNs, WAF internals)
   *   off-box. A sink that THROWS (synchronously) or whose returned PROMISE
   *   REJECTS is swallowed: it can never mask the gateway error.
   *
   *   Sink parity is NOT uniform across the three engines — the real matrix:
   *   - **Go** — `Config.ErrorLogger` (go/errors.go) is passed on BOTH legs:
   *     the business leg (`go/client.go` `post`) and the OAuth leg
   *     (`go/client.go` `refresh`), so a non-envelope OAuth failure also
   *     reaches the sink.
   *   - **Python** — there is NO client-level sink at all: only
   *     `MpesaError.from_response(..., error_logger=...)` accepts one
   *     (python/mpesa/exceptions.py), and `MpesaClient` never wires it.
   *   - **TypeScript** — the OAuth leg is minted by `TokenManager`
   *     (src/auth.ts), which has no sink, so ONLY the business leg reaches
   *     this option.
   */
export interface MpesaClientOptions {
  readonly config: Config;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly fetch?: typeof globalThis.fetch;
  readonly retryOnUnauthorized?: boolean;
  readonly errorLogger?: ErrorLogger;
}

/**
 * Concurrency-safe Daraja API engine. Create one per environment and
 * share it; the OAuth token cache is guarded internally.
 *
 * Token refresh holds the write lock across the OAuth round-trip — a
 * deliberate ~once-per-refresh-window stall traded for strict
 * single-flight, because requesting a token invalidates every previously
 * issued one.
 *
 * @example
 * ```ts
 * const client = MpesaClient.fromConfig(cfg);
 * const resp = await client.stkPush({ ... });
 * ```
 */
export class MpesaClient {
  /** Immutable configuration. */
  private readonly _config: Config;
  /** Base URL for all API requests. */
  private readonly _baseUrl: string;
  /** Per-request timeout in milliseconds. */
  private readonly _timeoutMs: number;
  /** Injectable clock for testing. */
  private readonly _now: () => number;
  /** Injectable fetch for proxies, tracing, or custom transports. */
  private readonly _fetch: typeof globalThis.fetch;
  /** Whether a 401.003.01 triggers the retry-once + forced refresh. */
  private readonly _retryOnUnauthorized: boolean;
  /** Opt-in diagnostic sink for raw non-envelope error bodies (never secrets). */
  private readonly _errorLogger: ErrorLogger | undefined;
  /** Token manager with generation-guarded caching. */
  private readonly _tokens: TokenManager;
  /**
   * Effective per-service transaction limits (normalized merge of
   * `config.limits` over {@link DEFAULT_TRANSACTION_LIMITS}).
   */
  private readonly _limits: TransactionLimits;
  /** Daily accumulation opt-in (mirrors `config.trackDaily`). */
  private readonly _trackDaily: boolean;
  /**
   * Per-service whole-KES accumulated for the CURRENT Africa/Nairobi day.
   * Only mutated when `_trackDaily` is on; reset wholesale at the day
   * rollover. JS single-threading makes the synchronous
   * check-then-increment in {@link MpesaClient._enforceLimits} atomic with
   * respect to concurrent async callers — each caller's gate runs to
   * completion before any other caller's continuation can interleave.
   */
  private readonly _dailyUsed = new Map<LimitService, number>();
  /** Current Nairobi day key (`YYYY-MM-DD`); `""` until first tracked call. */
  private _dailyDay = "";

  /**
   * Build a MpesaClient.
   *
   * @throws {Error} When credentials are missing or malformed.
   */
  constructor(opts: MpesaClientOptions) {
    this._config = opts.config;
    this._baseUrl = opts.config.environment.baseUrl.replace(/\/+$/, "");
    this._timeoutMs = Number.isFinite(opts.timeoutMs) && (opts.timeoutMs ?? 0) > 0
      ? opts.timeoutMs!
      : DEFAULT_TIMEOUT_MS;
    this._now = opts.now ?? (() => Date.now());
    this._fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this._retryOnUnauthorized = opts.retryOnUnauthorized ?? true;
    this._errorLogger = opts.errorLogger;
    this._limits = opts.config.limits;
    this._trackDaily = opts.config.trackDaily;
    // Pure-default clients share one process-wide TokenManager per
    // credential set (Daraja invalidates prior tokens on every mint, so
    // per-instance caches self-amplify into 401.003.01 storms). Clients
    // with ANY injected dependency (fetch/now/timeoutMs) keep a private
    // manager so the injection stays instance-scoped.
    this._tokens =
      opts.fetch === undefined &&
      opts.now === undefined &&
      opts.timeoutMs === undefined
        ? sharedTokenManager(this._baseUrl, opts.config.consumerKey, opts.config.consumerSecret)
        : new TokenManager({
            baseUrl: this._baseUrl,
            consumerKey: opts.config.consumerKey,
            consumerSecret: opts.config.consumerSecret,
            timeoutMs: this._timeoutMs,
            now: this._now,
            fetch: this._fetch,
          });
  }

  /**
   * Create a MpesaClient from a validated Config.
   *
   * @example
   * ```ts
   * const client = MpesaClient.fromConfig(new Config({
   *   consumerKey: "key", consumerSecret: "secret",
   *   shortcode: "174379", passkey: "pk",
   * }));
   * ```
   */
  static fromConfig(config: Config): MpesaClient {
    return new MpesaClient({ config });
  }

  /**
   * Create a MpesaClient from environment variables. Reads
   * `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, `MPESA_SHORTCODE`,
   * `MPESA_PASSKEY`, and optionally `MPESA_ENVIRONMENT` (accepted values:
   * exactly `"sandbox"` or `"production"`; unset defaults to sandbox).
   *
   * **Token cache is process-wide**: default-constructed clients (this
   * factory included) share one {@link TokenManager} per credential set.
   * Daraja invalidates ALL outstanding tokens whenever any client mints a
   * new one, so a per-instance cache would make sibling clients
   * cycle-invalidate each other into 401.003.01 storms — one OAuth
   * round-trip per process is the correct behavior. Inject a custom
   * `fetch`/`now`/`timeoutMs` to opt a client into a private cache.
   *
   * @param env - Optional environment shorthand: `"sandbox"` (default) or
   *   `"prod"`. When provided, overrides `MPESA_ENVIRONMENT`.
   *
   * @throws {ConfigError} When `MPESA_ENVIRONMENT` is set to an unrecognised
   *   value and `env` is not provided.
   * @throws {Error} When required environment variables are missing or invalid.
   *
   * @example
   * ```ts
   * const client = MpesaClient.fromEnv();       // sandbox (default)
   * const prod = MpesaClient.fromEnv("prod");   // production
   * ```
   */
  static fromEnv(env?: "sandbox" | "prod"): MpesaClient {
    const key = process.env.MPESA_CONSUMER_KEY ?? "";
    const secret = process.env.MPESA_CONSUMER_SECRET ?? "";
    const shortcode = process.env.MPESA_SHORTCODE ?? "";
    const passkey = process.env.MPESA_PASSKEY ?? "";

    let environment: Environment;
    if (env === "prod") {
      environment = Environment.PRODUCTION;
    } else if (env === "sandbox") {
      environment = Environment.SANDBOX;
    } else {
      // No explicit param — fall back to MPESA_ENVIRONMENT env var.
      const envName = process.env.MPESA_ENVIRONMENT;
      if (envName === undefined) {
        environment = Environment.SANDBOX;
      } else if (envName === "sandbox") {
        environment = Environment.SANDBOX;
      } else if (envName === "production") {
        environment = Environment.PRODUCTION;
      } else {
        throw new ConfigError(
          `mpesa: MPESA_ENVIRONMENT must be "sandbox" or "production", got ${JSON.stringify(envName)}`,
        );
      }
    }

    return new MpesaClient({
      config: new Config({ consumerKey: key, consumerSecret: secret, shortcode, passkey, environment }),
    });
  }

  // ── Token access ──────────────────────────────────────────────────────────

  /**
   * Cached bearer token, refreshing single-flight when stale.
   *
   * @example
   * ```ts
   * const token = await client.token();
   * ```
   */
  async token(): Promise<string> {
    return this._tokens.getToken();
  }

  /**
   * Redacted object for structured logging (never secrets).
   *
   * @example
   * ```ts
   * logger.info(client.toJSON());
   * // { environment: "sandbox", timeout: 30000 }
   * ```
   */
  toJSON(): { environment: string; timeout: number } {
    return {
      environment: this._config.environment.name,
      timeout: this._timeoutMs,
    };
  }

  /**
   * Credential-safe string rendering.
   *
   * @example
   * ```ts
   * console.log(client.toString());
   * // MpesaClient(sandbox, timeout=30000)
   * ```
   */
  toString(): string {
    return `MpesaClient(${this._config.environment.name}, timeout=${this._timeoutMs})`;
  }

  // ── Transaction limits ───────────────────────────────────────────────────

  /**
   * Fail-fast limits gate, called synchronously as the LAST step before
   * dispatch (so a request rejected by an earlier validator never consumes
   * quota): per-transaction ceiling first, then — only when
   * `trackDaily` is on — the Nairobi-day check-and-increment.
   *
   * The check+increment is a synchronous block with no `await`, which
   * makes it atomic for concurrent async callers: one caller's gate cannot
   * interleave with another's, so each in-flight request is counted
   * exactly once.
   *
   * @param service - Service bucket the amount is spent under
   *   (`stk`/`c2b`/`b2c`/`reversal`/`qr`/`default`).
   * @param amount - Whole-KES amount about to be dispatched.
   * @returns A rollback thunk: refunds the daily accrual when the
   *   TRANSPORT fails (fetch throws/aborts — the request may never have
   *   reached the gateway). Gateway rejections (`MpesaError`) keep the
   *   reservation — a request that left the process was an attempt.
   *   The thunk no-ops if the Nairobi day rolled over since accrual.
   * @throws {MpesaError} 400 when a configured ceiling is exceeded (the
   *   request is never sent).
   */
  private _enforceLimits(service: LimitService, amount: number): () => void {
    enforcePerTransactionLimit(service, amount, this._limits);
    if (!this._trackDaily) return () => {};
    const day = nairobiDayKey(this._now());
    // Forward-only day compare: a backward clock step (NTP correction,
    // VM restore) must never WIPE accumulated budget — only crossing into
    // a NEWER Nairobi day resets. (`""` before the first tracked call
    // sorts below every real day key, so the first call still resets.)
    if (day > this._dailyDay) {
      this._dailyUsed.clear();
      this._dailyDay = day;
    }
    const used = this._dailyUsed.get(service) ?? 0;
    checkDailyLimit(service, amount, this._limits, used);
    this._dailyUsed.set(service, used + amount);
    return () => {
      if (this._dailyDay !== day) return; // day rolled — nothing to credit back
      const current = this._dailyUsed.get(service);
      if (current === undefined) return;
      const next = current - amount;
      if (next > 0) this._dailyUsed.set(service, next);
      else this._dailyUsed.delete(service);
    };
  }

  // ── Shared POST helper ────────────────────────────────────────────────────

  /**
   * Perform an authenticated business call. On HTTP 401 carrying
   * errorCode `401.003.01` (invalid/expired token) it force-refreshes
   * the token once under the generation guard and retries the business
   * call exactly once before surfacing errors (unless
   * `retryOnUnauthorized: false` was configured).
   *
   * Response bodies are capped at 1 MiB — oversized payloads are
   * rejected with a typed error before any parsing attempt.
   *
   * @param opts.onTransportError - Refund hook invoked ONLY when the
   *   fetch itself throws (transport failure) — never for gateway
   *   responses, including 413 oversize and non-2xx `MpesaError`.
   */
  private async _post<T>(
    path: string,
    payload: unknown,
    out: (body: string) => T,
    opts?: { onTransportError?: () => void },
  ): Promise<T> {
    const [tok, gen] = await this._tokens.getTokenWithGen();
    const attempt = async (token: string): Promise<{ status: number; contentType: string; body: string }> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this._timeoutMs);

      // One clear, on EVERY exit path: the timeout must cover the BODY read
      // too (a server that trickles the body after the headers would
      // otherwise leave this promise pending forever), and it must be
      // released when the fetch itself fails so no timer outlives the call.
      try {
        let resp: Response;
        try {
          resp = await this._fetch(this._baseUrl + path, {
            method: "POST",
            redirect: "error",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${token}`,
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
          });
        } catch (err) {
          // Transport-level failure: the request may never have reached
          // the gateway, so the daily accrual taken at the gate is
          // refunded (transport-only rollback — gateway responses below
          // keep the reservation).
          opts?.onTransportError?.();
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`mpesa: POST ${path}: ${msg}`);
        }

        const ct = resp.headers.get("content-type") ?? "";

        // First guard: if Content-Length is present and exceeds the cap,
        // cancel immediately without consuming the body (decompression bomb
        // mitigation). The bounded reader below stays as the second guard for
        // missing/dishonest Content-Length headers.
        const contentLength = resp.headers.get("content-length");
        if (contentLength !== null) {
          const claimed = parseInt(contentLength, 10);
          if (Number.isFinite(claimed) && claimed > MAX_RESPONSE_LEN) {
            resp.body?.cancel();
            throw bodyTooLargeError(path, MAX_RESPONSE_LEN, claimed);
          }
        }

        // Second guard: bounded stream read — aborts once the accumulated
        // chunk total passes the cap (never materializes an oversized body).
        // Abort-aware: a mid-body stall rejects with the typed timeout error.
        const text = await readBodyBounded(resp.body, path, MAX_RESPONSE_LEN, controller.signal);

        return { status: resp.status, contentType: ct, body: text };
      } finally {
        clearTimeout(timer);
      }
    };

    let result = await attempt(tok);

    // Retry-once on 401.003.01 (generation guard). The probe decodes
    // leniently: `JSON.parse("null")` succeeds but a `TypeError` on the
    // property read would escape the typed error contract, so a
    // non-object body simply means "no envelope, do not retry".
    if (result.status === 401 && this._retryOnUnauthorized) {
      const probe = tryDecodeJsonObject(result.body);
      if (probe?.["errorCode"] === ERR_CODE_INVALID_TOKEN) {
        const freshTok = await this._tokens.refreshAfterInvalidToken(gen);
        result = await attempt(freshTok);
      }
    }

    if (result.status < 200 || result.status > 299) {
      // The raw body reaches the caller ONLY through the opt-in sink — the
      // exception text stays generic (D7 / go `parseError` parity).
      throw MpesaError.fromResponse(
        result.status, result.body, result.contentType, this._errorLogger,
      );
    }

    return out(result.body);
  }

  // ── Endpoints ─────────────────────────────────────────────────────────────

  /**
   * Send a payment prompt to the customer's phone (Lipa Na M-Pesa
   * Online). Password and Timestamp derive from ONE shared EAT instant
   * bound to the shortcode ACTUALLY sent.
   *
   * Injected defaults: `businessShortCode` ← config shortcode, `partyB`
   * ← `businessShortCode` when empty. `transactionType` has NO default
   * and must be set explicitly.
   *
   * @throws {Error} On validation failure (before any network I/O).
   *
   * @example
   * ```ts
   * const resp = await client.stkPush({
   *   transactionType: TransactionType.BillPayGoods,
   *   amount: 100, partyA: "254722000000",
   *   phoneNumber: "254722111111",
   *   callBackURL: "https://mydomain.com/callback",
   *   accountReference: "Order123", transactionDesc: "Payment",
   * });
   * ```
   */
  async stkPush(req: STKPushRequest): Promise<STKPushResponse> {
    // Value copy — caller's object is never mutated
    const r = { ...req };

    // Inject defaults
    if (!r.businessShortCode) r.businessShortCode = this._config.shortcode;
    if (!r.partyB) r.partyB = r.businessShortCode;

    // Validate
    requireNonEmpty("BusinessShortCode", r.businessShortCode);
    if (!r.transactionType) {
      throw new Error("mpesa: TransactionType is required (CustomerPayBillOnline | CustomerBuyGoodsOnline)");
    }
    if (
      r.transactionType.value !== TransactionType.BillPayGoods.value &&
      r.transactionType.value !== TransactionType.BillPayGoodsGoods.value
    ) {
      throw new Error(
        `mpesa: TransactionType ${JSON.stringify(r.transactionType.value)} not in {CustomerPayBillOnline, CustomerBuyGoodsOnline}`,
      );
    }
    requirePositiveInt("Amount", r.amount);
    r.partyA = normalizePhone(r.partyA);
    r.phoneNumber = normalizePhone(r.phoneNumber);
    requireURL("CallBackURL", r.callBackURL);
    requireNonEmpty("AccountReference", r.accountReference);
    requireLengthRange("AccountReference", r.accountReference, 1, 12);
    requireNonEmpty("TransactionDesc", r.transactionDesc);
    requireLengthRange("TransactionDesc", r.transactionDesc, 1, 13);

    // Password binds to the ACTUAL shortcode sent — divergent values
    // cause 500.001.1001 credential mismatches.
    const { password, timestamp } = generatePassword(
      r.businessShortCode,
      this._config.passkey,
      new Date(this._now()),
    );

    // Configurable limits gate — fail fast before any network I/O
    // (per-transaction always; daily only when trackDaily is on).
    const rollbackDaily = this._enforceLimits("stk", r.amount);

    // Build payload with injected Password/Timestamp.
    // NOTE: no Occassion here — Go/Py never send it on STK Push; the
    // double-s `Occassion` wire key belongs to B2C only (docs/apis/b2c.md).
    const payload: Record<string, unknown> = {
      BusinessShortCode: r.businessShortCode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: r.transactionType,
      Amount: r.amount,
      PartyA: r.partyA,
      PartyB: r.partyB,
      PhoneNumber: r.phoneNumber,
      CallBackURL: r.callBackURL,
      AccountReference: r.accountReference,
      TransactionDesc: r.transactionDesc,
    };

    return this._post(
      STK_PUSH_PATH,
      payload,
      (body) => decodeJsonObject<STKPushResponse>(body, STK_PUSH_PATH),
      { onTransportError: rollbackDaily },
    );
  }

  /**
   * Check the outcome of a push; the fallback when callbacks are late.
   * Password binds to the EFFECTIVE shortcode — override or default.
   *
   * `ResultCode` is normalized to `string` via `String()` before returning
   * (same pattern as `parseAsyncResult` — the gateway emits both `0` and
   * `"0"` depending on gateway version; Go `FlexString` / Python
   * `str`-normalization parity). Compare with `String(...) === "0"` semantics
   * in mind — never `===` a raw wire value against a single-type literal.
   *
   * @throws {Error} On validation failure (before any network I/O).
   *
   * @example
   * ```ts
   * const resp = await client.stkQuery({
   *   checkoutRequestID: "ws_CO_191220191020363925",
   * });
   * ```
   */
  async stkQuery(req: STKQueryRequest): Promise<STKQueryResponse> {
    // Value copy
    const r = { ...req };

    // Validate — documented contract: non-empty (Go
    // requireNonEmpty) AND <= 64 printable characters (Python
    // `_printable`); the stricter rule wins so control characters and
    // overlong ids fail before the gateway sees them.
    requireNonEmpty("CheckoutRequestID", r.checkoutRequestID);
    requirePrintableMaxLen("CheckoutRequestID", r.checkoutRequestID, 64);

    // Determine effective shortcode for password derivation
    // (request value, else config). Python `_shortcode` parity
    // (python/mpesa/requests_sync.py): the EFFECTIVE value must be 5–10
    // ASCII digits — an empty/garbage shortcode fails HERE as a local
    // error, never as a gateway 500. Trim first (Python strips before
    // validating); the trimmed value is what reaches the wire.
    const effectiveShortcode = (r.businessShortCode || this._config.shortcode).trim();
    if (!/^\d{5,10}$/.test(effectiveShortcode)) {
      throw effectiveShortcode === ""
        ? new Error("mpesa: BusinessShortCode is required")
        : new Error(
            `mpesa: BusinessShortCode must be 5-10 ASCII digits (got ${effectiveShortcode.length} characters)`,
          );
    }

    const { password, timestamp } = generatePassword(
      effectiveShortcode,
      this._config.passkey,
      new Date(this._now()),
    );

    // Hand-built flat payload — BusinessShortCode participates in
    // password derivation alongside the injected fields (always
    // non-empty here: the `_shortcode` gate above already rejected "").
    const payload: Record<string, unknown> = {
      Password: password,
      Timestamp: timestamp,
      CheckoutRequestID: r.checkoutRequestID,
      BusinessShortCode: effectiveShortcode,
    };

    return this._post(STK_QUERY_PATH, payload, (body) => {
      const parsed = decodeJsonObject<STKQueryResponse>(body, STK_QUERY_PATH);
      // Normalize the string|number wire trap to string (parseAsyncResult
      // pattern) so callers always observe `ResultCode: string`.
      return { ...parsed, ResultCode: String(parsed.ResultCode ?? "") };
    });
  }

  /**
   * Pay a registered shortcode out to a customer MSISDN (async).
   * Injected defaults: `originatorConversationID` ← auto-generated
   * (16 lowercase hex chars, ≤20 per Daraja constraint), `partyA` ←
   * config shortcode when empty.
   *
   * SecurityCredential must come from {@link securityCredential}.
   *
   * @throws {Error} On validation failure (before any network I/O).
   *
   * @example
   * ```ts
   * const ack = await client.b2cPayout({
   *   initiatorName: "testapi",
   *   securityCredential: cred,
   *   commandID: CommandID.BusinessPayment,
   *   amount: 100, partyA: "600992",
   *   partyB: "254705912645",
   *   remarks: "refund order 42",
   *   queueTimeOutURL: "https://mydomain.com/timeout",
   *   resultURL: "https://mydomain.com/result",
   * });
   * ```
   */
  async b2cPayout(req: B2CRequest): Promise<ConversationResponse> {
    // Value copy
    const r = { ...req };

    // Inject defaults
    if (!r.originatorConversationID) {
      r.originatorConversationID = newOriginatorID();
    }
    if (!r.partyA) r.partyA = this._config.shortcode;

    // Validate
    requireNonEmpty("InitiatorName", r.initiatorName);
    requireNonEmpty("SecurityCredential", r.securityCredential);
    // OriginatorConversationID is the async idempotency key. Contract:
    // 1..19 chars (Go requireMaxLen 19 / Python `_printable(..., 19)`
    // parity) — overlong ids are rejected by the gateway with
    // 500.002.1001, so fail fast here instead.
    requireLengthRange("OriginatorConversationID", r.originatorConversationID, 1, 19);
    if (!B2C_COMMANDS.has(r.commandID.value)) {
      throw new Error(
        `mpesa: B2C CommandID ${JSON.stringify(r.commandID.value)} not in {SalaryPayment, BusinessPayment, PromotionPayment}`,
      );
    }
    requirePositiveInt("Amount", r.amount);
    // Minimum stays a gateway contract (10 KES); the maximum now comes
    // from Config.limits.b2c (standard Safaricom default 250_000 per
    // transaction / 500_000 per day; approved-tier merchants raise via
    // Config limits).
    requireMinInt("B2C Amount", r.amount, 10);
    requireNonEmpty("PartyA", r.partyA);
    r.partyB = normalizePhone(r.partyB);
    requireLengthRange("Remarks", r.remarks, 2, 100);
    requireURL("QueueTimeOutURL", r.queueTimeOutURL);
    requireURL("ResultURL", r.resultURL);

    // Configurable limits gate — fail fast before any network I/O
    // (per-transaction always; daily only when trackDaily is on).
    const rollbackDaily = this._enforceLimits("b2c", r.amount);

    // Build payload — only include Occassion when defined
    const payload: Record<string, unknown> = {
      OriginatorConversationID: r.originatorConversationID,
      InitiatorName: r.initiatorName,
      SecurityCredential: r.securityCredential,
      CommandID: r.commandID,
      Amount: r.amount,
      PartyA: r.partyA,
      PartyB: r.partyB,
      Remarks: r.remarks,
      QueueTimeOutURL: r.queueTimeOutURL,
      ResultURL: r.resultURL,
    };
    if (r.occasion) {
      payload["Occassion"] = r.occasion;
    }

    return this._post(
      B2C_PATH,
      payload,
      (body) => decodeJsonObject<ConversationResponse>(body, B2C_PATH),
      { onTransportError: rollbackDaily },
    );
  }

  /**
   * Query any transaction by receipt XOR conversation ID. Injected
   * defaults: `commandID` ← TransactionStatusQuery, `identifierType`
   * ← "4" (organization shortcode).
   *
   * @throws {Error} On validation failure (before any network I/O).
   *
   * @example
   * ```ts
   * const ack = await client.transactionStatus({
   *   initiator: "testapi",
   *   securityCredential: "cred",
   *   transactionID: "NLJ7RT61SV",
   *   partyA: "600992",
   *   remarks: "reconcile",
   *   resultURL: "https://mydomain.com/result",
   *   queueTimeOutURL: "https://mydomain.com/timeout",
   * });
   * ```
   */
  async transactionStatus(req: TransactionStatusRequest): Promise<ConversationResponse> {
    // Value copy (spread of the XOR union stays non-mutating)
    const r = { ...req };

    // Injected defaults via locals — never mutate the caller's view.
    // Falsy checks (not `??`): Go/Python default on EMPTY (`== ""`), so an
    // explicit `""` must fall back to TransactionStatusQuery/"4" — same as
    // accountBalance/reversal in this file, which already use falsy checks.
    const commandID = r.commandID || CommandID.TransactionStatusQuery;
    const identifierType = r.identifierType || "4";

    // Validate — exactly one of TransactionID or OriginalConversationID
    // (ALSO enforced at the type level; these checks guard JS callers)
    if (!r.transactionID && !r.originalConversationID) {
      throw new Error("mpesa: exactly one of TransactionID or OriginalConversationID is required");
    }
    if (r.transactionID && r.originalConversationID) {
      throw new Error("mpesa: exactly one of TransactionID or OriginalConversationID must be set, got both");
    }
    if (commandID.value !== CommandID.TransactionStatusQuery.value) {
      throw new Error("mpesa: TransactionStatus CommandID must be TransactionStatusQuery");
    }
    requireNonEmpty("Initiator", r.initiator);
    requireNonEmpty("SecurityCredential", r.securityCredential);
    requireNonEmpty("PartyA", r.partyA);
    requireLengthRange("Remarks", r.remarks, 1, 100);
    requireURL("ResultURL", r.resultURL);
    requireURL("QueueTimeOutURL", r.queueTimeOutURL);

    // No limits gate: the TransactionStatus wire contract carries NO
    // amount, so there is nothing to spend under the `default` bucket.

    // Build payload — only include optional fields when defined
    const payload: Record<string, unknown> = {
      Initiator: r.initiator,
      SecurityCredential: r.securityCredential,
      CommandID: commandID,
      PartyA: r.partyA,
      IdentifierType: identifierType,
      ResultURL: r.resultURL,
      QueueTimeOutURL: r.queueTimeOutURL,
      Remarks: r.remarks,
    };
    if (r.transactionID !== undefined) {
      payload["TransactionID"] = r.transactionID;
    }
    if (r.originalConversationID !== undefined) {
      payload["OriginalConversationID"] = r.originalConversationID;
    }
    if (r.occasion) {
      payload["Occasion"] = r.occasion;
    }

    return this._post(TX_STATUS_PATH, payload, (body) =>
      decodeJsonObject<ConversationResponse>(body, TX_STATUS_PATH),
    );
  }

  /**
   * Reverse a recent C2B transaction — C2B ONLY: B2C payouts cannot be
   * reversed through this API. Injected defaults: `commandID` ←
   * ReverseTransaction, `recieverIdentifierType` ← "11" (wire key
   * stays Safaricom's misspelled `RecieverIdentifierType`).
   *
   * @throws {Error} On validation failure (before any network I/O).
   *
   * @example
   * ```ts
   * const ack = await client.reversal({
   *   initiator: "testapi",
   *   securityCredential: "cred",
   *   transactionID: "NLJ7RT61SV",
   *   amount: 100,
   *   receiverParty: "600992",
   *   remarks: "wrong deposit",
   *   resultURL: "https://mydomain.com/result",
   *   queueTimeOutURL: "https://mydomain.com/timeout",
   * });
   * ```
   */
  async reversal(req: ReversalRequest): Promise<ConversationResponse> {
    // Value copy
    const r = { ...req };

    // Inject defaults
    if (!r.commandID) r.commandID = CommandID.ReverseTransaction;
    if (!r.recieverIdentifierType) r.recieverIdentifierType = "11";

    // Validate
    if (r.commandID.value !== CommandID.ReverseTransaction.value) {
      throw new Error("mpesa: Reversal CommandID must be TransactionReversal");
    }
    requireNonEmpty("Initiator", r.initiator);
    requireNonEmpty("SecurityCredential", r.securityCredential);
    requireNonEmpty("TransactionID", r.transactionID);
    requirePositiveInt("Amount", r.amount);
    requireNonEmpty("ReceiverParty", r.receiverParty);
    requireLengthRange("Remarks", r.remarks, 2, 100);
    requireURL("ResultURL", r.resultURL);
    requireURL("QueueTimeOutURL", r.queueTimeOutURL);

    // Configurable limits gate — dedicated `reversal` bucket (split from
    // the shared `default` bucket). Fail fast before any network I/O.
    const rollbackDaily = this._enforceLimits("reversal", r.amount);

    // Build payload — include RecieverIdentifierType (misspelled wire key)
    const payload: Record<string, unknown> = {
      Initiator: r.initiator,
      SecurityCredential: r.securityCredential,
      CommandID: r.commandID,
      TransactionID: r.transactionID,
      Amount: r.amount,
      ReceiverParty: r.receiverParty,
      RecieverIdentifierType: r.recieverIdentifierType,
      ResultURL: r.resultURL,
      QueueTimeOutURL: r.queueTimeOutURL,
      Remarks: r.remarks,
    };

    return this._post(
      REVERSAL_PATH,
      payload,
      (body) => decodeJsonObject<ConversationResponse>(body, REVERSAL_PATH),
      { onTransportError: rollbackDaily },
    );
  }

  /**
   * Query organization shortcode balances (async). Injected defaults:
   * `commandID` ← AccountBalance, `identifierType` ← "4".
   *
   * @throws {Error} On validation failure (before any network I/O).
   *
   * @example
   * ```ts
   * const ack = await client.accountBalance({
   *   initiator: "testapi",
   *   securityCredential: "cred",
   *   partyA: "600992",
   *   remarks: "eod balance",
   *   resultURL: "https://mydomain.com/result",
   *   queueTimeOutURL: "https://mydomain.com/timeout",
   * });
   * ```
   */
  async accountBalance(req: AccountBalanceRequest): Promise<ConversationResponse> {
    // Value copy
    const r = { ...req };

    // Inject defaults
    if (!r.commandID) r.commandID = CommandID.AccountBalance;
    if (!r.identifierType) r.identifierType = "4";

    // Validate
    if (r.commandID.value !== CommandID.AccountBalance.value) {
      throw new Error("mpesa: AccountBalance CommandID must be AccountBalance");
    }
    requireNonEmpty("Initiator", r.initiator);
    requireNonEmpty("SecurityCredential", r.securityCredential);
    requireNonEmpty("PartyA", r.partyA);
    requireLengthRange("Remarks", r.remarks, 1, 100);
    requireURL("QueueTimeOutURL", r.queueTimeOutURL);
    requireURL("ResultURL", r.resultURL);

    // No limits gate: the AccountBalance wire contract carries NO amount,
    // so there is nothing to spend under the `default` bucket.

    // Build payload — only include optional fields when defined
    const payload: Record<string, unknown> = {
      Initiator: r.initiator,
      SecurityCredential: r.securityCredential,
      CommandID: r.commandID,
      PartyA: r.partyA,
      IdentifierType: r.identifierType,
      Remarks: r.remarks,
      QueueTimeOutURL: r.queueTimeOutURL,
      ResultURL: r.resultURL,
    };

    return this._post(ACCOUNT_BALANCE_PATH, payload, (body) =>
      decodeJsonObject<ConversationResponse>(body, ACCOUNT_BALANCE_PATH),
    );
  }

  /**
   * Register validation/confirmation callback URLs (v2). `shortCode`
   * ← config shortcode when empty. Production registration is
   * effectively one-shot.
   *
   * @throws {Error} On validation failure (before any network I/O).
   *
   * @example
   * ```ts
   * const ack = await client.c2bRegisterURL({
   *   responseType: ResponseType.Completed,
   *   confirmationURL: "https://mydomain.com/c2b/confirm",
   *   validationURL: "https://mydomain.com/c2b/validate",
   * });
   * ```
   */
  async c2bRegisterURL(req: C2BRegisterRequest): Promise<C2BAckResponse> {
    // Value copy
    const r = { ...req };

    // Inject default
    if (!r.shortCode) r.shortCode = this._config.shortcode;

    // Validate — ONLY the wire-correct values survive. The deprecated
    // `Success`/`Fail` aliases are hard-rejected (Go
    // `c2bResponseTypes` / Python `rt not in (Completed, Cancelled)`
    // parity): silently remapping them sent a wire value the caller never
    // asked for, so the alias is now a loud local failure instead.
    if (
      r.responseType.value !== "Completed" &&
      r.responseType.value !== "Cancelled"
    ) {
      throw new Error(
        `mpesa: ResponseType ${JSON.stringify(r.responseType.value)} must be Completed or Cancelled`,
      );
    }
    requireURL("ConfirmationURL", r.confirmationURL);
    requireURL("ValidationURL", r.validationURL);

    // Build payload — the validated enum value IS the wire value.
    const payload: Record<string, unknown> = {
      ShortCode: r.shortCode,
      ResponseType: r.responseType.value,
      ConfirmationURL: r.confirmationURL,
      ValidationURL: r.validationURL,
    };

    return this._post(C2B_REGISTER_PATH, payload, (body) =>
      decodeJsonObject<C2BAckResponse>(body, C2B_REGISTER_PATH),
    );
  }

  /**
   * Fake an inbound payment (sandbox only). `shortCode` ← config
   * shortcode when empty.
   *
   * @throws {Error} On validation failure (before any network I/O).
   *
   * @example
   * ```ts
   * const ack = await client.c2bSimulate({
   *   commandID: CommandID.PayBill,
   *   amount: 10, msisdn: "0712345678",
   *   billRefNumber: "account-1",
   * });
   * ```
   */
  async c2bSimulate(req: C2BSimulateRequest): Promise<C2BAckResponse> {
    // Value copy
    const r = { ...req };

    // Inject default
    if (!r.shortCode) r.shortCode = this._config.shortcode;

    // Validate
    if (
      r.commandID.value !== TransactionType.BillPayGoods.value &&
      r.commandID.value !== TransactionType.BillPayGoodsGoods.value
    ) {
      throw new Error(
        `mpesa: simulate CommandID ${JSON.stringify(r.commandID.value)} not in {CustomerPayBillOnline, CustomerBuyGoodsOnline}`,
      );
    }
    requirePositiveInt("Amount", r.amount);
    r.msisdn = normalizePhone(r.msisdn);
    if (r.commandID.value === TransactionType.BillPayGoods.value && !r.billRefNumber?.trim()) {
      throw new Error("mpesa: BillRefNumber is required for CustomerPayBillOnline simulation");
    }

    // Configurable limits gate — fail fast before any network I/O
    // (per-transaction always; daily only when trackDaily is on).
    const rollbackDaily = this._enforceLimits("c2b", r.amount);

    // Build payload
    const payload: Record<string, unknown> = {
      ShortCode: r.shortCode,
      CommandID: r.commandID,
      Amount: r.amount,
      Msisdn: r.msisdn,
    };
    if (r.billRefNumber) {
      payload["BillRefNumber"] = r.billRefNumber;
    }

    return this._post(
      C2B_SIMULATE_PATH,
      payload,
      (body) => decodeJsonObject<C2BAckResponse>(body, C2B_SIMULATE_PATH),
      { onTransportError: rollbackDaily },
    );
  }

  /**
   * Create a dynamic M-PESA QR image payload (fully synchronous).
   *
   * @throws {Error} On validation failure (before any network I/O).
   *
   * @example
   * ```ts
   * const qr = await client.generateQRCode({
   *   merchantName: "TEST SUPERMARKET",
   *   refNo: "Invoice Test",
   *   amount: 1, trxCode: QRTrxCode.BuyGoods, // wire "BG"
   *   cpi: "174379", size: "300",
   * });
   * ```
   */
  async generateQRCode(req: DynamicQRRequest): Promise<QRCodeResponse> {
    // Value copy
    const r = { ...req };

    // Validate
    requireNonEmpty("MerchantName", r.merchantName);
    requireNonEmpty("RefNo", r.refNo);
    requirePositiveInt("Amount", r.amount);
    if (!QR_TRX_CODES.has(r.trxCode.value)) {
      throw new Error(
        `mpesa: TrxCode ${JSON.stringify(r.trxCode.value)} not in {BG, WA, PB, SM, SB}`,
      );
    }
    const cpi = r.cpi.trim();
    if (cpi.length < 5 || cpi.length > 12) {
      throw new Error(`mpesa: CPI ${JSON.stringify(cpi)} must be 5-12 digits`);
    }
    if (!/^\d+$/.test(cpi)) {
      throw new Error(`mpesa: CPI ${JSON.stringify(cpi)} must be digits only`);
    }
    const size = r.size.trim();
    const sizeNum = parseInt(size, 10);
    if (!Number.isFinite(sizeNum) || sizeNum <= 0) {
      throw new Error(`mpesa: Size ${JSON.stringify(size)} must be a positive integer`);
    }
    r.cpi = cpi;
    r.size = size;

    // Configurable limits gate — dedicated `qr` bucket (split from the
    // shared `default` bucket). Fail fast before any network I/O.
    const rollbackDaily = this._enforceLimits("qr", r.amount);

    // Build payload
    const payload: Record<string, unknown> = {
      MerchantName: r.merchantName,
      RefNo: r.refNo,
      Amount: r.amount,
      TrxCode: r.trxCode,
      CPI: r.cpi,
      Size: r.size,
    };

    return this._post(
      QR_CODE_PATH,
      payload,
      (body) => decodeJsonObject<QRCodeResponse>(body, QR_CODE_PATH),
      { onTransportError: rollbackDaily },
    );
  }
}

// ─── Factory functions ────────────────────────────────────────────────────────

/**
 * `util.inspect` hook — the TypeScript equivalent of Python's
 * `MpesaClient.__repr__` (python/mpesa/client.py) and Go's
 * `Client.Format` (go/client.go).
 *
 * `util.inspect` does NOT consult `toString()`/`toJSON()`: left to its own
 * devices it walks the own enumerable properties, so it printed the
 * nested `_tokens` TokenManager — and with it the consumer key and the
 * consumer secret — in cleartext, which is exactly what `console.log(client)`
 * does. SECURITY.md forbids cleartext credentials in logs, so the hook
 * routes `inspect` (and therefore `console.log`) through the
 * credential-safe {@link MpesaClient.toString} form.
 *
 * Installed with `Symbol.for("nodejs.util.inspect.custom")` rather than an
 * import of `node:util`, so this module keeps no Node-only import. The
 * hook is NOT writable: a redaction hook must not be replaceable at
 * runtime.
 */
Object.defineProperty(MpesaClient.prototype, Symbol.for("nodejs.util.inspect.custom"), {
  value(this: MpesaClient): string { return this.toString(); },
  enumerable: false, configurable: true, writable: false,
});

/**
 * Create a MpesaClient from a validated Config.
 *
 * @example
 * ```ts
 * const client = createClient(new Config({
 *   consumerKey: "key", consumerSecret: "secret",
 *   shortcode: "174379", passkey: "pk",
 * }));
 * ```
 */
export function createClient(config: Config): MpesaClient {
  return MpesaClient.fromConfig(config);
}

/**
 * Create a MpesaClient from environment variables.
 *
 * @example
 * ```ts
 * const client = createClientFromEnv();
 * ```
 */
export function createClientFromEnv(): MpesaClient {
  return MpesaClient.fromEnv();
}
