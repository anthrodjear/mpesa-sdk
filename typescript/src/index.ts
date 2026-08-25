/**
 * @mpesa-sdk/core — TypeScript client for Safaricom's Daraja M-Pesa API.
 *
 * Nine endpoints covered:
 * {@link MpesaClient.stkPush | STK Push},
 * {@link MpesaClient.stkQuery | STK Query},
 * {@link MpesaClient.b2cPayout | B2C},
 * {@link MpesaClient.c2bRegisterURL | C2B Register},
 * {@link MpesaClient.c2bSimulate | C2B Simulate},
 * {@link MpesaClient.transactionStatus | Transaction Status},
 * {@link MpesaClient.reversal | Reversal},
 * {@link MpesaClient.accountBalance | Account Balance},
 * {@link MpesaClient.generateQRCode | Dynamic QR}.
 *
 * Quick-start:
 * ```ts
 * import { Config, MpesaClient, TransactionType } from "@mpesa-sdk/core";
 *
 * const config = new Config({
 *   consumerKey:    process.env.MPESA_CONSUMER_KEY   !,
 *   consumerSecret: process.env.MPESA_CONSUMER_SECRET!,
 *   shortcode:      process.env.MPESA_SHORTCODE      !,
 *   passkey:        process.env.MPESA_PASSKEY        !,
 * });
 * const client = new MpesaClient({
 *   config,
 *   timeoutMs: 15_000,
 * });
 *
 * const stkResp = await client.stkPush({
 *   phoneNumber: "+254712345678",
 *   amount:      100,
 *   accountReference: "Order 42",
 *   transactionDesc:  "test",
 *   transactionType: TransactionType.BillPayGoods, // wire "CustomerPayBillOnline"
 *   partyA: "+254712345678",
 *   callBackURL: "https://example.com/callback",
 * });
 * ```
 *
 * ## Safety notes
 *
 * - **Indeterminate results never auto-fail.** When Daraja returns a
 *   timeout, `ResultClass.INCONCLUSIVE`, or a callback status that is
 *   neither success nor failure, the SDK surfaces the raw result
 *   verbatim — callers must reconcile externally.
 * - **Callbacks are unsigned.** Daraja sends NO signature to verify.
 *   Binding on CheckoutRequestID is a dedup/idempotency control, not origin
 *   authentication — settle only via {@link MpesaClient.stkQuery} bound to
 *   your stored CheckoutRequestID; see the bearer-capability bullet below
 *   for endpoint gating, and reserve IP allowlisting for defense-in-depth.
 * - **Callback URLs are bearer capabilities.** Embed
 *   {@link newCallbackToken} in your CallBackURL path and gate hits with
 *   {@link callbackTokenEqual}; a hit proves URL knowledge only — never
 *   settle from a callback body. Reconcile via {@link MpesaClient.stkQuery}
 *   bound to your CheckoutRequestID, and scrub tokens from access logs/APM.
 * - **Secrets are redacted in representations.** {@link Config.toString},
 *   {@link Config.toJSON}, and {@link Config.logSafe} omit
 *   `consumerSecret` and `passkey` entirely (the `consumerKey` renders in
 *   cleartext, matching Go/Python). Never log the raw {@link Config} object.
 *
 * @packageDocumentation
 */

// ── Config ──────────────────────────────────────────────────────────────
export { Environment, ConfigError, Config } from "./config.js";

// ── Auth ────────────────────────────────────────────────────────────────
export { TokenManager, getAccessToken } from "./auth.js";
export type { TokenManagerOptions } from "./auth.js";

// ── Client ──────────────────────────────────────────────────────────────
export { MpesaClient, createClient, createClientFromEnv } from "./client.js";
export type { MpesaClientOptions } from "./client.js";

// ── Errors ──────────────────────────────────────────────────────────────
export { MpesaError } from "./errors.js";

// ── Enums ───────────────────────────────────────────────────────────────
export {
  MpesaEnum,
  TransactionType,
  CommandID,
  ResponseType,
  QRTrxCode,
} from "./enums.js";

// ── Helpers ─────────────────────────────────────────────────────────────
export {
  generatePassword,
  normalizePhone,
  securityCredential,
  newOriginatorID,
} from "./helpers.js";

// ── Callback tokens ─────────────────────────────────────────────────────
export { callbackTokenEqual, newCallbackToken } from "./callback-token.js";

// ── Classification ──────────────────────────────────────────────────────
export { ResultClass, classifyResultCode } from "./classification.js";

// ── Coercion ────────────────────────────────────────────────────────────
export {
  safeJsonInt,
  isNumericString,
  coerceInt,
  parseIntSafe,
} from "./coercion.js";

// ── Types (request / response interfaces + helpers) ─────────────────────
// Runtime exports (classes, functions)
export { MetadataMap, parseBalanceSegments, isAccepted, parseAsyncResult } from "./types.js";

// Type-only exports (interfaces)
export type {
  // Request types
  STKPushRequest,
  STKQueryRequest,
  B2CRequest,
  TransactionStatusRequest,
  AccountBalanceRequest,
  ReversalRequest,
  C2BRegisterRequest,
  C2BSimulateRequest,
  DynamicQRRequest,
  // Response types
  STKPushResponse,
  STKQueryResponse,
  ConversationResponse,
  C2BAckResponse,
  QRCodeResponse,
  OAuthToken,
  // Callback & metadata helpers
  StkCallbackResult,
  MetadataItem,
  AsyncResult,
  AsyncResultEnvelope,
  BalanceSegment,
} from "./types.js";

// ── Version ─────────────────────────────────────────────────────────────
/** SDK version — kept in sync with package.json. */
export const VERSION = "0.1.0";
