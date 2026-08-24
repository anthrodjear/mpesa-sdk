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

import { Config, Environment } from "./config.js";
import { MpesaError } from "./errors.js";
import {
  generatePassword,
  normalizePhone,
  newOriginatorID,
} from "./helpers.js";
import { TokenManager } from "./auth.js";
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

/** OAuth endpoint path (docs/apis/oauth.md). */
const OAUTH_PATH = "/oauth/v1/generate?grant_type=client_credentials";

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

function requireURL(field: string, value: string): void {
  requireNonEmpty(field, value);
  if (!value.startsWith("http://") && !value.startsWith("https://")) {
    throw new Error(`mpesa: ${field} must be an absolute http(s) URL`);
  }
}

function requirePositive(field: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`mpesa: ${field} must be positive, got ${value}`);
  }
}

function requireMinMax(field: string, value: number, min: number, max: number): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`mpesa: ${field} must be between ${min} and ${max}, got ${value}`);
  }
}

function requireLengthRange(field: string, value: string, min: number, max: number): void {
  const n = value.trim().length;
  if (n < min || n > max) {
    throw new Error(`mpesa: ${field} must be ${min}-${max} characters, got ${n}`);
  }
}

/**
 * Bounded response-body reader (parity: go `io.ReadAll(io.LimitReader(
 * resp.Body, maxResponseLen+1))`). Accumulates stream chunks and aborts the
 * moment the running byte total exceeds `maxBytes` — an oversized body is
 * never fully materialized, even when no honest Content-Length header is
 * present. The Content-Length precheck at call sites remains the first,
 * cheapest guard; this loop is the second.
 */
async function readBodyBounded(
  body: ReadableStream<Uint8Array> | null,
  label: string,
  maxBytes: number,
): Promise<string> {
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new Error(`mpesa: ${label} response exceeds ${maxBytes} bytes`);
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(merged);
}

// ─── MpesaClient ──────────────────────────────────────────────────────────────

/**
 * Options for constructing a {@link MpesaClient}.
 *
 * @property config      - Validated configuration with credentials.
 * @property timeoutMs   - Per-request timeout in milliseconds (default 30s).
 * @property now         - Injectable clock for testing (default `Date.now`).
 */
export interface MpesaClientOptions {
  readonly config: Config;
  readonly timeoutMs?: number;
  readonly now?: () => number;
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
  /** Token manager with generation-guarded caching. */
  private readonly _tokens: TokenManager;

  /**
   * Build a MpesaClient.
   *
   * @throws {Error} When credentials are missing or malformed.
   */
  constructor(opts: MpesaClientOptions) {
    this._config = opts.config;
    this._baseUrl = opts.config.environment.baseUrl.replace(/\/+$/, "");
    this._timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs! > 0
      ? opts.timeoutMs!
      : DEFAULT_TIMEOUT_MS;
    this._now = opts.now ?? (() => Date.now());
    this._tokens = new TokenManager({
      baseUrl: this._baseUrl,
      consumerKey: opts.config.consumerKey,
      consumerSecret: opts.config.consumerSecret,
      timeoutMs: this._timeoutMs,
      now: this._now,
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
   * `MPESA_PASSKEY`, and optionally `MPESA_ENVIRONMENT`.
   *
   * @throws {Error} When required environment variables are missing.
   *
   * @example
   * ```ts
   * const client = MpesaClient.fromEnv();
   * ```
   */
  static fromEnv(): MpesaClient {
    const key = process.env.MPESA_CONSUMER_KEY ?? "";
    const secret = process.env.MPESA_CONSUMER_SECRET ?? "";
    const shortcode = process.env.MPESA_SHORTCODE ?? "";
    const passkey = process.env.MPESA_PASSKEY ?? "";
    const envName = (process.env.MPESA_ENVIRONMENT ?? "sandbox").toLowerCase();
    const environment = envName === "production"
      ? Environment.PRODUCTION
      : Environment.SANDBOX;
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

  // ── Shared POST helper ────────────────────────────────────────────────────

  /**
   * Perform an authenticated business call. On HTTP 401 carrying
   * errorCode `401.003.01` (invalid/expired token) it force-refreshes
   * the token once under the generation guard and retries the business
   * call exactly once before surfacing errors.
   *
   * Response bodies are capped at 1 MiB — oversized payloads are
   * rejected with a typed error before any parsing attempt.
   */
  private async _post<T>(
    path: string,
    payload: unknown,
    out: (body: string) => T,
  ): Promise<T> {
    const [tok, gen] = await this._tokens.getTokenWithGen();
    const attempt = async (token: string): Promise<{ status: number; contentType: string; body: string }> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this._timeoutMs);

      let resp: Response;
      try {
        resp = await fetch(this._baseUrl + path, {
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
        clearTimeout(timer);
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`mpesa: POST ${path}: ${msg}`);
      } finally {
        clearTimeout(timer);
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
          throw new Error(
            `mpesa: ${path} response exceeds ${MAX_RESPONSE_LEN} bytes (Content-Length: ${claimed})`,
          );
        }
      }

      // Second guard: bounded stream read — aborts once the accumulated
      // chunk total passes the cap (never materializes an oversized body).
      const text = await readBodyBounded(resp.body, path, MAX_RESPONSE_LEN);

      return { status: resp.status, contentType: ct, body: text };
    };

    let result = await attempt(tok);

    // Retry-once on 401.003.01 (generation guard)
    if (result.status === 401) {
      let probe: { errorCode?: string };
      try {
        probe = JSON.parse(result.body) as Record<string, unknown>;
      } catch {
        probe = {};
      }
      if ((probe as Record<string, unknown>)["errorCode"] === ERR_CODE_INVALID_TOKEN) {
        const freshTok = await this._tokens.refreshAfterInvalidToken(gen);
        result = await attempt(freshTok);
      }
    }

    if (result.status < 200 || result.status > 299) {
      throw MpesaError.fromResponse(result.status, result.body, result.contentType);
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
    requirePositive("Amount", r.amount);
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

    return this._post(STK_PUSH_PATH, payload, (body) =>
      JSON.parse(body) as STKPushResponse,
    );
  }

  /**
   * Check the outcome of a push; the fallback when callbacks are late.
   * Password binds to the EFFECTIVE shortcode — override or default.
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

    // Validate
    requireNonEmpty("CheckoutRequestID", r.checkoutRequestID);

    // Determine effective shortcode for password derivation
    const effectiveShortcode = r.businessShortCode || this._config.shortcode;

    const { password, timestamp } = generatePassword(
      effectiveShortcode,
      this._config.passkey,
      new Date(this._now()),
    );

    // Hand-built flat payload — BusinessShortCode participates in
    // password derivation alongside the injected fields.
    const payload = {
      BusinessShortCode: effectiveShortcode,
      Password: password,
      Timestamp: timestamp,
      CheckoutRequestID: r.checkoutRequestID,
    };

    return this._post(STK_QUERY_PATH, payload, (body) =>
      JSON.parse(body) as STKQueryResponse,
    );
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
    if (!B2C_COMMANDS.has(r.commandID.value)) {
      throw new Error(
        `mpesa: B2C CommandID ${JSON.stringify(r.commandID.value)} not in {SalaryPayment, BusinessPayment, PromotionPayment}`,
      );
    }
    requireMinMax("Amount", r.amount, 10, 250_000);
    requireNonEmpty("PartyA", r.partyA);
    r.partyB = normalizePhone(r.partyB);
    requireLengthRange("Remarks", r.remarks, 2, 100);
    requireURL("QueueTimeOutURL", r.queueTimeOutURL);
    requireURL("ResultURL", r.resultURL);

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
    if (r.occasion !== undefined) {
      payload["Occassion"] = r.occasion;
    }

    return this._post(B2C_PATH, payload, (body) =>
      JSON.parse(body) as ConversationResponse,
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
    // Value copy
    const r = { ...req };

    // Inject defaults
    if (!r.commandID) r.commandID = CommandID.TransactionStatusQuery;
    if (!r.identifierType) r.identifierType = "4";

    // Validate — exactly one of TransactionID or OriginalConversationID
    if (!r.transactionID && !r.originalConversationID) {
      throw new Error("mpesa: exactly one of TransactionID or OriginalConversationID is required");
    }
    if (r.transactionID && r.originalConversationID) {
      throw new Error("mpesa: exactly one of TransactionID or OriginalConversationID must be set, got both");
    }
    if (r.commandID.value !== CommandID.TransactionStatusQuery.value) {
      throw new Error("mpesa: TransactionStatus CommandID must be TransactionStatusQuery");
    }
    requireNonEmpty("Initiator", r.initiator);
    requireNonEmpty("SecurityCredential", r.securityCredential);
    requireNonEmpty("PartyA", r.partyA);
    requireLengthRange("Remarks", r.remarks ?? "", 1, 100);
    requireURL("ResultURL", r.resultURL);
    requireURL("QueueTimeOutURL", r.queueTimeOutURL);

    // Build payload — only include optional fields when defined
    const payload: Record<string, unknown> = {
      Initiator: r.initiator,
      SecurityCredential: r.securityCredential,
      CommandID: r.commandID,
      PartyA: r.partyA,
      IdentifierType: r.identifierType,
      ResultURL: r.resultURL,
      QueueTimeOutURL: r.queueTimeOutURL,
      Remarks: r.remarks ?? "",
    };
    if (r.transactionID !== undefined) {
      payload["TransactionID"] = r.transactionID;
    }
    if (r.originalConversationID !== undefined) {
      payload["OriginalConversationID"] = r.originalConversationID;
    }
    if (r.occasion !== undefined) {
      payload["Occasion"] = r.occasion;
    }

    return this._post(TX_STATUS_PATH, payload, (body) =>
      JSON.parse(body) as ConversationResponse,
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
    requirePositive("Amount", r.amount);
    requireNonEmpty("ReceiverParty", r.receiverParty);
    requireLengthRange("Remarks", r.remarks, 2, 100);
    requireURL("ResultURL", r.resultURL);
    requireURL("QueueTimeOutURL", r.queueTimeOutURL);

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

    return this._post(REVERSAL_PATH, payload, (body) =>
      JSON.parse(body) as ConversationResponse,
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
    requireLengthRange("Remarks", r.remarks ?? "", 1, 100);
    requireURL("QueueTimeOutURL", r.queueTimeOutURL);
    requireURL("ResultURL", r.resultURL);

    // Build payload — only include optional fields when defined
    const payload: Record<string, unknown> = {
      Initiator: r.initiator,
      SecurityCredential: r.securityCredential,
      CommandID: r.commandID,
      PartyA: r.partyA,
      IdentifierType: r.identifierType,
      Remarks: r.remarks ?? "",
      QueueTimeOutURL: r.queueTimeOutURL,
      ResultURL: r.resultURL,
    };

    return this._post(ACCOUNT_BALANCE_PATH, payload, (body) =>
      JSON.parse(body) as ConversationResponse,
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
   *   responseType: ResponseType.Success,
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

    // Validate
    if (
      r.responseType.value !== "Success" &&
      r.responseType.value !== "Fail"
    ) {
      throw new Error(
        `mpesa: ResponseType ${JSON.stringify(r.responseType.value)} must be Success or Fail`,
      );
    }
    requireURL("ConfirmationURL", r.confirmationURL);
    requireURL("ValidationURL", r.validationURL);

    // Build payload — C2B uses "Completed"/"Cancelled" wire values
    const payload: Record<string, unknown> = {
      ShortCode: r.shortCode,
      ResponseType: r.responseType.value === "Success" ? "Completed" : "Cancelled",
      ConfirmationURL: r.confirmationURL,
      ValidationURL: r.validationURL,
    };

    return this._post(C2B_REGISTER_PATH, payload, (body) =>
      JSON.parse(body) as C2BAckResponse,
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
    requirePositive("Amount", r.amount);
    r.msisdn = normalizePhone(r.msisdn);
    if (r.commandID.value === TransactionType.BillPayGoods.value && !r.billRefNumber?.trim()) {
      throw new Error("mpesa: BillRefNumber is required for CustomerPayBillOnline simulation");
    }

    // Build payload
    const payload: Record<string, unknown> = {
      ShortCode: r.shortCode,
      CommandID: r.commandID,
      Amount: r.amount,
      Msisdn: r.msisdn,
    };
    if (r.billRefNumber !== undefined) {
      payload["BillRefNumber"] = r.billRefNumber;
    }

    return this._post(C2B_SIMULATE_PATH, payload, (body) =>
      JSON.parse(body) as C2BAckResponse,
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
    requirePositive("Amount", r.amount);
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

    // Build payload
    const payload: Record<string, unknown> = {
      MerchantName: r.merchantName,
      RefNo: r.refNo,
      Amount: r.amount,
      TrxCode: r.trxCode,
      CPI: r.cpi,
      Size: r.size,
    };

    return this._post(QR_CODE_PATH, payload, (body) =>
      JSON.parse(body) as QRCodeResponse,
    );
  }
}

// ─── Factory functions ────────────────────────────────────────────────────────

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
