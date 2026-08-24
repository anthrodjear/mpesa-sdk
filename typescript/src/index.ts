/**
 * @mpesa-sdk/core — TypeScript client for Safaricom's Daraja M-Pesa API.
 *
 * Nine endpoints covered:
 * {@link MpesaClient.stkPush | STK Push},
 * {@link MpesaClient.stkQuery | STK Query},
 * {@link MpesaClient.b2c | B2C},
 * {@link MpesaClient.c2bRegister | C2B Register},
 * {@link MpesaClient.c2bSimulate | C2B Simulate},
 * {@link MpesaClient.transactionStatus | Transaction Status},
 * {@link MpesaClient.reversal | Reversal},
 * {@link MpesaClient.accountBalance | Account Balance},
 * {@link MpesaClient.generateQRCode | Dynamic QR}.
 *
 * Quick-start:
 * ```ts
 * import { Config, MpesaClient } from "@mpesa-sdk/core";
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
 *   transactionType: TransactionType.CustomerPayBillOnline,
 *   partyA: "+254712345678",
 *   callBackURL: "https://example.com/callback",
 * });
 * ```
 *
 * ## Safety notes
 *
 * - **Indeterminate results never auto-fail.** When Daraja returns a
 *   timeout, `ResultClass.Undetermined`, or a callback status that is
 *   neither success nor failure, the SDK surfaces the raw result
 *   verbatim — callers must reconcile externally.
 * - **Callbacks are unsigned.** The SDK does not validate callback
 *   signatures; protect your callback endpoints with HMAC verification
 *   and IP allowlisting.
 * - **Secrets are redacted in representations.** {@link Config.toString},
 *   {@link Config.toJSON}, and {@link Config.logSafe} mask consumer
 *   keys, secrets, and passkeys. Never log the raw {@link Config} object.
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
export { MetadataMap, parseBalanceSegments } from "./types.js";

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
  BalanceSegment,
} from "./types.js";

// ── Version ─────────────────────────────────────────────────────────────
/** SDK version — kept in sync with package.json. */
export const VERSION = "0.1.0";
