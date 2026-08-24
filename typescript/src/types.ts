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
 * { ...base, ...(occassion !== undefined && { occassion }) }
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
  readonly businessShortCode: string;
  readonly password: string;
  readonly timestamp: string;
  readonly transactionType: TransactionType;
  readonly amount: number;
  readonly partyA: string;
  readonly partyB: string;
  readonly phoneNumber: string;
  readonly callBackURL: string;
  readonly accountReference: string;
  readonly transactionDesc: string;
  /**
   * @warning Intentional double-s misspelling matches the Daraja wire key
   * `"Occassion"`. Do not "fix" to `occasion`.
   */
  readonly occassion?: string;
}

/** STK Push query status request body. */
export interface STKQueryRequest {
  readonly businessShortCode: string;
  readonly password: string;
  readonly timestamp: string;
  readonly checkoutRequestID: string;
}

/** B2C (Business to Customer) payout request body. */
export interface B2CRequest {
  readonly initiatorName: string;
  readonly securityCredential: string;
  readonly commandID: CommandID;
  readonly amount: number;
  readonly partyA: string;
  readonly partyB: string;
  readonly remarks: string;
  readonly queueTimeOutURL: string;
  readonly occasion?: string;
}

/** Transaction status query request body. */
export interface TransactionStatusRequest {
  readonly initiator: string;
  readonly securityCredential: string;
  readonly commandID: CommandID;
  readonly transactionID: string;
  readonly partyA: string;
  readonly identifierType?: string;
  readonly remarks?: string;
  readonly occassion?: string;
}

/** Account balance query request body. */
export interface AccountBalanceRequest {
  readonly initiator: string;
  readonly securityCredential: string;
  readonly commandID: CommandID;
  readonly partyA: string;
  readonly identifierType?: string;
  readonly remarks?: string;
  readonly queueTimeOutURL: string;
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
  readonly commandID: CommandID;
  readonly transactionID: string;
  readonly receiverParty: string;
  readonly recieverIdentifierType?: string;
  readonly receiverIdentifierType?: string;
  readonly remarks: string;
  readonly queueTimeOutURL?: string;
  readonly occasion?: string;
}

/** C2B URL registration request body. */
export interface C2BRegisterRequest {
  readonly shortCode: string;
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
  readonly billRefNumber: string;
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
  readonly ResultCode: number;
  readonly ResultDesc: string;
  readonly OriginatorConversationID: string;
  readonly ConversationID: string;
  /** Unparsed JSON payload for advanced callers. */
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
    // Length guard above ensures indices 0–5 exist; noUncheckedIndexedAccess
    // cannot infer this from .length, so we access explicitly.
    const accountName = fields[0]!.trim();
    const currency = fields[1]!.trim();
    const available = parseFloat(fields[2]!);
    const uncleared = parseFloat(fields[3]!);
    const reserved = parseFloat(fields[4]!);
    const min = parseFloat(fields[5]!);
    if (Number.isFinite(available)) {
      segments.push({ accountName, currency, available, uncleared, reserved, min });
    }
  }
  return segments;
}
