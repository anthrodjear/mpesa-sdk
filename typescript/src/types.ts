/**
 * SDK wire types — request payloads, response envelopes, callback shapes,
 * and async-result structures. Mirrors Go (go/*.go) and Python
 * (python/mpesa/*.py) reference implementations.
 *
 * **Naming rules**:
 * - Request properties use camelCase (TypeScript convention).
 * - Response/callback properties use PascalCase (matching JSON wire keys).
 * - All intentional misspellings are preserved and annotated.
 *
 * **`exactOptionalPropertyTypes`**: When constructing objects with optional
 * fields, use conditional spread to avoid assigning `undefined`:
 * ```ts
 * { ...base, ...(occasion !== undefined && { occasion }) }
 * ```
 *
 * @packageDocumentation
 */

// ─── Section 1: Enums (import + re-export) ───────────────────────────────────
import {
  TransactionType,
  CommandID,
  ResponseType,
  QRTrxCode,
} from "./enums.js";
export { TransactionType, CommandID, ResponseType, QRTrxCode };

// ─── Section 2: Request interfaces ───────────────────────────────────────────

/** STK Push (Lipa Na M-Pesa Online) request body. */
export interface STKPushRequest {
  /**
   * Client-injected — defaults to config shortcode when empty.
   * Callers typically omit this.
   */
  readonly businessShortCode?: string | undefined;
  readonly transactionType: TransactionType;
  readonly amount: number;
  readonly partyA: string;
  /** Defaults to `businessShortCode` when empty. */
  readonly partyB?: string | undefined;
  readonly phoneNumber: string;
  readonly callBackURL: string;
  readonly accountReference: string;
  readonly transactionDesc: string;
}

/** STK Push query status request body. */
export interface STKQueryRequest {
  /**
   * Client-injected — defaults to config shortcode when empty; when set,
   * the injected Password binds to THIS shortcode.
   * Callers typically omit this.
   */
  readonly businessShortCode?: string | undefined;
  readonly checkoutRequestID: string;
}

/** B2C (Business to Customer) payout request body. */
export interface B2CRequest {
  /**
   * Auto-generated when empty — 16 lowercase hex chars (≤20 per Daraja
   * constraint). Serves as the idempotency key for retries.
   */
  readonly originatorConversationID?: string | undefined;
  readonly initiatorName: string;
  readonly securityCredential: string;
  readonly commandID: CommandID;
  readonly amount: number;
  /** Defaults to config shortcode when empty. */
  readonly partyA?: string | undefined;
  readonly partyB: string;
  readonly remarks: string;
  readonly queueTimeOutURL: string;
  readonly resultURL: string;
  readonly occasion?: string | undefined;
}

/**
 * Common fields shared by both XOR variants of {@link TransactionStatusRequest}.
 * `commandID` and `identifierType` are client-defaulted when omitted.
 */
interface TransactionStatusBase {
  readonly initiator: string;
  readonly securityCredential: string;
  readonly commandID?: CommandID | undefined;
  readonly partyA: string;
  readonly identifierType?: string | undefined;
  readonly resultURL: string;
  readonly queueTimeOutURL: string;
  readonly remarks: string;
  readonly occasion?: string | undefined;
}

/**
 * Transaction status query request body — receipt XOR conversation ID,
 * enforced at TYPE level: exactly one of `transactionID` /
 * `originalConversationID` must be present. Passing both (or neither) is a
 * compile error; the runtime check remains as defense for JS callers.
 */
export type TransactionStatusRequest = TransactionStatusBase &
  (
    | { readonly transactionID: string; readonly originalConversationID?: never }
    | { readonly transactionID?: never; readonly originalConversationID: string }
  );

/** Account balance query request body. */
export interface AccountBalanceRequest {
  readonly initiator: string;
  readonly securityCredential: string;
  /** Defaults to AccountBalance when omitted. */
  readonly commandID?: CommandID | undefined;
  readonly partyA: string;
  readonly identifierType?: string | undefined;
  readonly remarks: string;
  readonly queueTimeOutURL: string;
  readonly resultURL: string;
}

/**
 * Transaction reversal request body.
 * @warning `recieverIdentifierType` is a deliberate misspelling matching the
 * Daraja wire key `"RecieverIdentifierType"`. Do not "fix" to
 * `receiverIdentifierType`.
 */
export interface ReversalRequest {
  readonly initiator: string;
  readonly securityCredential: string;
  /** Defaults to TransactionReversal when omitted. */
  readonly commandID?: CommandID | undefined;
  readonly transactionID: string;
  readonly amount: number;
  readonly receiverParty: string;
  readonly recieverIdentifierType?: string | undefined;
  readonly resultURL: string;
  readonly queueTimeOutURL: string;
  readonly remarks: string;
}

/** C2B URL registration request body. */
export interface C2BRegisterRequest {
  readonly shortCode?: string | undefined;
  readonly responseType: ResponseType;
  readonly confirmationURL: string;
  readonly validationURL: string;
}

/** C2B payment simulation request body (test environment). */
export interface C2BSimulateRequest {
  readonly shortCode: string;
  readonly commandID: CommandID;
  readonly amount: number;
  readonly msisdn: string;
  /**
   * Required for `CustomerPayBillOnline` simulations; omit (or pass
   * `undefined`) for `CustomerBuyGoodsOnline`.
   */
  readonly billRefNumber?: string | undefined;
}

/**
 * Dynamic QR code generation request body.
 * Field names match the QR Spec — do not rename to camelCase.
 */
export interface DynamicQRRequest {
  readonly merchantName: string;
  readonly refNo: string;
  readonly amount: number;
  readonly trxCode: QRTrxCode;
  readonly cpi: string;
  readonly size: string;
}

// ─── Section 3: Response interfaces ──────────────────────────────────────────

/** STK Push synchronous response from Daraja. */
export interface STKPushResponse {
  readonly MerchantRequestID: string;
  readonly CheckoutRequestID: string;
  readonly ResponseCode: string;
  readonly ResponseDescription: string;
  readonly CustomerMessage: string;
}

/** STK Push query response envelope. */
export interface STKQueryResponse {
  readonly ResponseCode: string;
  readonly ResponseDescription: string;
  readonly MerchantRequestID: string;
  readonly CheckoutRequestID: string;
  /**
   * @warning Wire sends both `"1032"` (string) and `1032` (number) for this
   * field depending on the gateway version. Always `parseInt()` before
   * numeric comparison — never `===` against a number literal.
   */
  readonly ResultCode: string;
  readonly ResultDesc: string;
}

/** Conversation-based response (B2C, Reversal, Transaction Status). */
export interface ConversationResponse {
  readonly OriginatorConversationID: string;
  readonly ConversationID: string;
  readonly ResponseCode: string;
  readonly ResponseDescription: string;
}

/**
 * C2B URL registration acknowledgement.
 * @warning `OriginatorCoversationID` is a deliberate misspelling matching the
 * Daraja wire key `"OriginatorCoversationID"`. Do not "fix" to
 * `OriginatorConversationID`.
 */
export interface C2BAckResponse {
  /**
   * @warning Misspelled wire key — `"OriginatorCoversationID"` (missing the
   * second 's' in Conversation). Preserved for wire compatibility.
   */
  readonly OriginatorCoversationID: string;
  readonly ResponseCode: string;
  readonly ResponseDescription: string;
}

/** QR code generation response. */
export interface QRCodeResponse {
  readonly ResponseCode: string;
  readonly RequestID: string;
  readonly ResponseDescription: string;
  readonly QRCode: string;
}

/**
 * OAuth access token from Daraja.
 *
 * @warning `expiresIn` arrives as a **string** (`"3599"`) from the wire,
 * NOT a number. Parse with `parseInt()` before using numerically.
 * Both Go and Python document this same trap.
 */
export interface OAuthToken {
  readonly accessToken: string;
  /** Wire type is string (`"3599"`), not number — Safaricom quirk. */
  readonly expiresIn: string;
  readonly tokenType: string;
}

// ─── Section 4: Callback types ───────────────────────────────────────────────

/** A single key-value metadata item within an STK callback. */
export interface MetadataItem {
  readonly Name: string;
  readonly Value: unknown;
}

/**
 * Callback result payload from STK Push async callback.
 *
 * @property ResultCode - `0` = success; anything else = failure.
 * @property CallbackMetadata - Present only on success.
 */
export interface StkCallbackResult {
  readonly MerchantRequestID: string;
  readonly CheckoutRequestID: string;
  readonly ResultCode: number;
  readonly ResultDesc: string;
  readonly CallbackMetadata?: {
    readonly Item: readonly MetadataItem[];
  };
}

// ─── MetadataMap helper ──────────────────────────────────────────────────────

/**
 * Map-like wrapper over `MetadataItem[]` with **first-wins** semantics.
 *
 * If the callback contains duplicate keys (malformed or gateway retries),
 * the first occurrence wins — subsequent values are silently dropped.
 * Use {@link MetadataMap.get} for O(n) lookup; for bulk access, iterate
 * with {@link MetadataMap.entries}.
 */
export class MetadataMap {
  private readonly items: MetadataItem[];
  private readonly index: Map<string, unknown>;

  constructor(items: readonly MetadataItem[]) {
    this.items = [...items];
    this.index = new Map();
    for (const item of items) {
      if (!this.index.has(item.Name)) {
        this.index.set(item.Name, item.Value);
      }
    }
  }

  /** Get a value by key. Returns `undefined` if not present. */
  get(key: string): unknown {
    return this.index.get(key);
  }

  /**
   * Set a key-value pair. **No-op** if the key already exists
   * (first-wins semantics).
   *
   * @security PII warning — values may contain MSISDN, receipt numbers, or
   * account references. Never log raw MetadataMap contents in production;
   * redact or hash before writing to structured logs.
   */
  set(key: string, value: unknown): void {
    if (!this.index.has(key)) {
      this.index.set(key, value);
      this.items.push({ Name: key, Value: value });
    }
  }

  /** Check whether a key exists. */
  has(key: string): boolean {
    return this.index.has(key);
  }

  /** Iterate all key-value pairs in insertion order. */
  entries(): IterableIterator<[string, unknown]> {
    return this.index.entries();
  }

  /** Number of metadata items. */
  get size(): number {
    return this.index.size;
  }
}

// ─── Section 5: Async result types ───────────────────────────────────────────

/**
 * Simplified async result — the callback contains a lot of nested JSON but
 * callers rarely need every field. This captures the essential envelope.
 *
 * For full payload inspection, use `AsyncResult.raw` and parse yourself.
 */
export interface AsyncResult {
  readonly ResultType: number;
  readonly ResultCode: string;
  readonly ResultDesc: string;
  readonly OriginatorConversationID: string;
  readonly ConversationID: string;
  /** M-Pesa receipt number when present. */
  readonly TransactionReceipt?: string;
readonly B2CUtilityAccountAvailableFunds?: string;
  readonly B2CUtilityAccountPaidFunds?: string;
  readonly B2CWorkingAccountAvailableFunds?: string;
  readonly B2CWorkingAccountPaidFunds?: string;
  readonly B2CUtilityAccountTransferredFunds?: string;
  readonly B2CWorkingAccountTransferredFunds?: string;
  readonly B2CFlag?: string;
  readonly TransactionStatus?: string;
  readonly Occassion?: string;
}

/** A single balance segment from AccountBalance callback text. */
export interface BalanceSegment {
  readonly accountName: string;
  readonly currency: string;
  readonly available: number;
  readonly uncleared: number;
  readonly reserved: number;
  readonly min: number;
}

/**
 * Parse the pipe-delimited AccountBalance callback text into structured
 * segments. Malformed or incomplete rows are silently skipped.
 *
 * @param text - Raw callback text (e.g.
 *   `"Available Account Balance|KES|1234.56|0.00|0.00|0.00"`).
 * @returns Array of parsed balance segments (may be empty).
 *
 * @example
 * ```ts
 * const segments = parseBalanceSegments(
 *   "Available Account Balance|KES|1234.56|0.00|0.00|0.00&" +
 *   "Float Balance|KES|5000.00|0.00|0.00|0.00"
 * );
 * // segments[0].accountName === "Available Account Balance"
 * // segments[0].available === 1234.56
 * ```
 */
export function parseBalanceSegments(text: string): BalanceSegment[] {
  const segments: BalanceSegment[] = [];
  const parts = text.split("&");
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const fields = trimmed.split("|");
    if (fields.length < 6) continue;
    const accountName = fields[0];
    const currency = fields[1];
    const availStr = fields[2];
    const unclearedStr = fields[3];
    const reservedStr = fields[4];
    const minStr = fields[5];
    if (
      accountName === undefined || currency === undefined ||
      availStr === undefined || unclearedStr === undefined ||
      reservedStr === undefined || minStr === undefined
    ) continue;
    const available = parseFloat(availStr);
    const uncleared = parseFloat(unclearedStr);
    const reserved = parseFloat(reservedStr);
    const min = parseFloat(minStr);
    if (
      Number.isFinite(available) && Number.isFinite(uncleared) &&
      Number.isFinite(reserved) && Number.isFinite(min)
    ) {
      segments.push({
        accountName: accountName.trim(),
        currency: currency.trim(),
        available,
        uncleared,
        reserved,
        min,
      });
    }
  }
  return segments;
}

// ─── Section 6: isAccepted() and parseAsyncResult() ─────────────────────────

/**
 * Returns `true` when the synchronous response was accepted by Daraja
 * (`ResponseCode === "0"`).
 */
export function isAccepted(res: { ResponseCode: string }): boolean {
  return res.ResponseCode === "0";
}

/**
 * Parsed envelope from a B2C / reversal / transaction-status async result
 * callback. Only the fields common to all async result envelopes are
 * captured here — use {@link AsyncResult} for the full B2C-specific payload.
 */
export interface AsyncResultEnvelope {
  readonly ResultCode: string;
  readonly ResultDesc: string;
  readonly MerchantRequestID?: string;
  readonly CheckoutRequestID?: string;
}

/**
 * Parse and validate the raw async result callback body.
 *
 * Accepts either:
 * - **Flat**: `{ ResultCode, ResultDesc, ... }`
 * - **Wrapped** (Daraja wire shape): `{ "Result": { ResultCode, ResultDesc, ... } }`
 *
 * `ResultCode` is always `string` for cross-language parity (Go uses
 * `FlexString`, Python normalizes to `str`).
 *
 * @throws {TypeError} If the body is not an object or is missing required
 *   fields (`ResultCode`, `ResultDesc`).
 */
export function parseAsyncResult(body: unknown): AsyncResultEnvelope {
  if (typeof body !== "object" || body === null) {
    throw new TypeError("mpesa: invalid async result envelope");
  }
  const outer = body as Record<string, unknown>;
  const inner: Record<string, unknown> =
    typeof outer.Result === "object" && outer.Result !== null
      ? (outer.Result as Record<string, unknown>)
      : outer;
  if (
    typeof inner.ResultCode !== "string" ||
    typeof inner.ResultDesc !== "string"
  ) {
    throw new TypeError("mpesa: invalid async result envelope");
  }
  return {
    ResultCode: inner.ResultCode,
    ResultDesc: inner.ResultDesc,
    ...(typeof inner.MerchantRequestID === "string" && { MerchantRequestID: inner.MerchantRequestID }),
    ...(typeof inner.CheckoutRequestID === "string" && { CheckoutRequestID: inner.CheckoutRequestID }),
  };
}
