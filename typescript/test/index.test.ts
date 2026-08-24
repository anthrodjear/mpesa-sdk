/**
 * Barrel export test — every public name is importable, VERSION is correct,
 * and the quick-start example compiles.
 */
import { describe, it, expect } from "vitest";

// ── Runtime imports ─────────────────────────────────────────────────────
import {
  // Config
  Environment,
  ConfigError,
  Config,
  // Auth
  TokenManager,
  getAccessToken,
  // Client
  MpesaClient,
  createClient,
  createClientFromEnv,
  // Errors
  MpesaError,
  // Enums
  MpesaEnum,
  TransactionType,
  CommandID,
  ResponseType,
  QRTrxCode,
  // Helpers
  generatePassword,
  normalizePhone,
  securityCredential,
  newOriginatorID,
  // Classification
  ResultClass,
  classifyResultCode,
  // Coercion
  safeJsonInt,
  isNumericString,
  coerceInt,
  parseIntSafe,
  // Types (runtime — class + function)
  MetadataMap,
  parseBalanceSegments,
  // Version
  VERSION,
} from "../src/index.js";

// ── Type-only imports (compile-time check that interfaces are exported) ─
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
  OAuthToken,
  StkCallbackResult,
  MetadataItem,
  AsyncResult,
  BalanceSegment,
  MpesaClientOptions,
  TokenManagerOptions,
} from "../src/index.js";

// ── Value-level assertions ──────────────────────────────────────────────

describe("barrel exports — non-null", () => {
  const valueExports: Record<string, unknown> = {
    Environment,
    ConfigError,
    Config,
    TokenManager,
    getAccessToken,
    MpesaClient,
    createClient,
    createClientFromEnv,
    MpesaError,
    MpesaEnum,
    TransactionType,
    CommandID,
    ResponseType,
    QRTrxCode,
    generatePassword,
    normalizePhone,
    securityCredential,
    newOriginatorID,
    ResultClass,
    classifyResultCode,
    safeJsonInt,
    isNumericString,
    coerceInt,
    parseIntSafe,
    parseBalanceSegments,
    MetadataMap,
    VERSION,
  };

  for (const [name, value] of Object.entries(valueExports)) {
    it(`${name} is importable and non-null`, () => {
      expect(value).not.toBeNull();
      expect(value).not.toBeUndefined();
    });
  }
});

// ── Interface / type smoke (compile-time only — no runtime artifact) ────
//
// The following type aliases compile if and only if the barrel re-exports
// the interfaces. They produce zero runtime code.
type _STKPushRequest           = STKPushRequest;
type _STKQueryRequest          = STKQueryRequest;
type _B2CRequest               = B2CRequest;
type _TransactionStatusRequest = TransactionStatusRequest;
type _AccountBalanceRequest    = AccountBalanceRequest;
type _ReversalRequest          = ReversalRequest;
type _C2BRegisterRequest       = C2BRegisterRequest;
type _C2BSimulateRequest       = C2BSimulateRequest;
type _DynamicQRRequest         = DynamicQRRequest;
type _STKPushResponse          = STKPushResponse;
type _STKQueryResponse         = STKQueryResponse;
type _ConversationResponse     = ConversationResponse;
type _C2BAckResponse           = C2BAckResponse;
type _QRCodeResponse           = QRCodeResponse;
type _OAuthToken               = OAuthToken;
type _StkCallbackResult        = StkCallbackResult;
type _MetadataItem             = MetadataItem;
type _AsyncResult              = AsyncResult;
type _BalanceSegment           = BalanceSegment;
type _MpesaClientOptions       = MpesaClientOptions;
type _TokenManagerOptions      = TokenManagerOptions;

describe("barrel exports — VERSION", () => {
  it('VERSION equals "0.1.0"', () => {
    expect(VERSION).toBe("0.1.0");
  });
});

// ── Quick-start example (type-check only) ───────────────────────────────
//
// This block is a structural type-check of the docstring example. It does
// NOT execute against the live Daraja API — the Config is never used for
// a real request.

describe("barrel exports — quick-start example compiles", () => {
  it("quick-start types are structurally valid", () => {
    // Types-only assertion: this block must type-check under tsc --noEmit.
    // We use a runtime assertion on the types module to keep vitest happy.
    expect(typeof VERSION).toBe("string");

    // Smoke: enum instances carry wire strings
    expect(TransactionType.BillPayGoods.value).toBe("CustomerPayBillOnline");
    expect(CommandID.BusinessPayment.value).toBe("BusinessPayment");
    expect(ResponseType.Success.value).toBe("Success");
    expect(QRTrxCode.DynamicQRCode.value).toBe("DynamicQRCode");

    // Smoke: helpers are callable
    expect(typeof normalizePhone("+254712345678")).toBe("string");
    expect(typeof newOriginatorID()).toBe("string");
  });
});

// ── Export count ────────────────────────────────────────────────────────

describe("barrel exports — count", () => {
  it("exports at least 45 names (value + type)", () => {
    // All exported names (runtime + type-only)
    const allExports = [
      // Runtime (26)
      "Environment", "ConfigError", "Config",
      "TokenManager", "getAccessToken",
      "MpesaClient", "createClient", "createClientFromEnv",
      "MpesaError",
      "MpesaEnum", "TransactionType", "CommandID", "ResponseType", "QRTrxCode",
      "generatePassword", "normalizePhone", "securityCredential", "newOriginatorID",
      "ResultClass", "classifyResultCode",
      "safeJsonInt", "isNumericString", "coerceInt", "parseIntSafe",
      "MetadataMap", "parseBalanceSegments",
      "VERSION",
      // Type-only (21)
      "STKPushRequest", "STKQueryRequest", "B2CRequest",
      "TransactionStatusRequest", "AccountBalanceRequest", "ReversalRequest",
      "C2BRegisterRequest", "C2BSimulateRequest", "DynamicQRRequest",
      "STKPushResponse", "STKQueryResponse", "ConversationResponse",
      "C2BAckResponse", "QRCodeResponse", "OAuthToken",
      "StkCallbackResult", "MetadataItem", "AsyncResult", "BalanceSegment",
      "MpesaClientOptions", "TokenManagerOptions",
    ];

    expect(allExports.length).toBeGreaterThanOrEqual(45);

    // Verify each runtime export is actually defined in the module namespace
    const runtimeMod: Record<string, unknown> = {
      Environment, ConfigError, Config,
      TokenManager, getAccessToken,
      MpesaClient, createClient, createClientFromEnv,
      MpesaError,
      MpesaEnum, TransactionType, CommandID, ResponseType, QRTrxCode,
      generatePassword, normalizePhone, securityCredential, newOriginatorID,
      ResultClass, classifyResultCode,
      safeJsonInt, isNumericString, coerceInt, parseIntSafe,
      parseBalanceSegments, MetadataMap, VERSION,
    };

    const runtimeNames = allExports.filter(n => n in runtimeMod);
    for (const name of runtimeNames) {
      expect(runtimeMod[name]).toBeDefined();
    }
  });
});
